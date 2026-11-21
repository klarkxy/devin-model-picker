'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../src/byok-ops.cjs');

const makeConfig = () => ({ providers: [] });
const discoverStub = items => async () => items;

test('saveProvider creates, edits, and keeps the stored key when apiKey is omitted', () => {
  const config = makeConfig();
  const id = ops.saveProvider(config, { name: 'Magpie', baseUrl: 'https://api.example.com/v1',
    apiFormat: 'openai', apiKey: 'sk-secret' });
  assert.equal(config.providers.length, 1);
  assert.equal(config.providers[0].apiKey, 'sk-secret');
  assert.equal(id, config.providers[0].id);
  // Edit without apiKey retains the old key.
  ops.saveProvider(config, { id, name: 'Magpie 2', baseUrl: 'https://api2.example.com/v1', apiFormat: 'openai' });
  assert.equal(config.providers[0].apiKey, 'sk-secret');
  assert.equal(config.providers[0].name, 'Magpie 2');
  assert.equal(config.providers[0].baseUrl, 'https://api2.example.com/v1');
  // Edit with a new key replaces it.
  ops.saveProvider(config, { id, name: 'Magpie 2', baseUrl: 'https://api2.example.com/v1',
    apiFormat: 'openai', apiKey: 'sk-new' });
  assert.equal(config.providers[0].apiKey, 'sk-new');
});

test('validation rejects bad baseUrl, apiFormat, names and keys', () => {
  const config = makeConfig();
  const bad = payload => assert.throws(() => ops.saveProvider(config, payload), ops.SettingsInputError);
  bad({ name: '', baseUrl: 'https://x.com', apiFormat: 'openai' });
  bad({ name: 'X', baseUrl: 'not-a-url', apiFormat: 'openai' });
  bad({ name: 'X', baseUrl: 'https://user:pass@x.com/v1', apiFormat: 'openai' });
  bad({ name: 'X', baseUrl: 'https://x.com/v1?q=1', apiFormat: 'openai' });
  bad({ name: 'X', baseUrl: 'ftp://x.com', apiFormat: 'openai' });
  bad({ name: 'X', baseUrl: 'https://x.com', apiFormat: 'weird' });
  bad({ name: 'X', baseUrl: 'https://x.com', apiFormat: 'openai', apiKey: 'multi\nline' });
  bad({ name: 'bad' + String.fromCharCode(7), baseUrl: 'https://x.com', apiFormat: 'openai' });
  assert.equal(config.providers.length, 0, 'nothing persisted on failure');
});

test('discover + import merge models and the pending signature invalidates on edits', async t => {
  const config = makeConfig();
  const id = ops.saveProvider(config, { name: 'P', baseUrl: 'https://p.example.com', apiFormat: 'openai' });
  const { provider, models } = await ops.discoverModels(config, { id },
    { discover: discoverStub([{ id: 'm1', label: 'Model 1' }, { id: 'm2' }]), index: null });
  const pending = { providerId: provider.id, signature: ops.signature(provider), token: 'tok', models };
  assert.equal(models.length, 2);
  const view = ops.importView(provider, models);
  assert.deepEqual(view.map(item => item.imported), [false, false]);
  // Valid import.
  assert.equal(ops.importModels(config, { id, token: 'tok', ids: ['m1'] }, pending), 1);
  assert.equal(provider.models.length, 1);
  assert.equal(provider.models[0].enabled, true);
  assert.equal(ops.importView(provider, models).find(item => item.id === 'm1').imported, true);
  // Wrong token / edited provider reject.
  assert.throws(() => ops.importModels(config, { id, token: 'other', ids: ['m2'] }, pending), /失效|重新/);
  ops.saveProvider(config, { id, name: 'P', baseUrl: 'https://p2.example.com', apiFormat: 'openai' });
  assert.throws(() => ops.importModels(config, { id, token: 'tok', ids: ['m2'] }, pending), /失效|重新/,
    'baseUrl edit invalidates the pending list');
  // ids must come from the fetched list, no dupes.
  assert.throws(() => ops.importModels(config, { id, token: 'tok', ids: ['m2', 'm2'] },
    { ...pending, signature: ops.signature(provider) }), /选择/);
  assert.throws(() => ops.importModels(config, { id, token: 'tok', ids: ['ghost'] },
    { ...pending, signature: ops.signature(provider) }), /不在|重新/);
});

test('removeModel and deleteProvider update the config', () => {
  const config = makeConfig();
  const id = ops.saveProvider(config, { name: 'P', baseUrl: 'https://p.example.com', apiFormat: 'openai' });
  const provider = config.providers[0];
  provider.models = [{ id: 'm1', enabled: true }, { id: 'm2', enabled: false }];
  ops.removeModel(config, { providerId: id, modelId: 'm1' });
  assert.deepEqual(provider.models.map(model => model.id), ['m2']);
  ops.deleteProvider(config, { id });
  assert.equal(config.providers.length, 0);
  assert.throws(() => ops.deleteProvider(config, { id: 'ghost' }), ops.SettingsInputError);
  assert.throws(() => ops.removeModel(config, { providerId: 'ghost', modelId: 'x' }), ops.SettingsInputError);
});

test('setProviderEnabled / setModelEnabled / setEnabled validate booleans', () => {
  const config = makeConfig();
  const id = ops.saveProvider(config, { name: 'P', baseUrl: 'https://p.example.com', apiFormat: 'openai' });
  config.providers[0].models = [{ id: 'm1', enabled: true }];
  ops.setProviderEnabled(config, { id, enabled: false });
  assert.equal(config.providers[0].enabled, false);
  ops.setModelEnabled(config, { providerId: id, modelId: 'm1', enabled: false });
  assert.equal(config.providers[0].models[0].enabled, false);
  ops.setEnabled(config, { enabled: false });
  assert.equal(config.enabled, false);
  assert.throws(() => ops.setEnabled(config, { enabled: 'yes' }), ops.SettingsInputError);
});

// --- probeProvider -----------------------------------------------------------

const gate = handler => async (url, options = {}) => handler(String(url), options.headers || {}, options.method || 'GET');
const okList = data => ({ status: 200, ok: true, json: async () => ({ data }) });
const notOk = status => ({ status, ok: false, json: async () => ({}) });

test('probeProvider appends /v1 first and detects chat vs responses', async () => {
  const log = [];
  const result = await ops.probeProvider({ baseUrl: 'https://api.deepseek.com', apiKey: 'k',
    fetchImpl: gate((url, headers, method) => {
      log.push({ url, headers, method });
      if (url.endsWith('/v1/models')) return okList([{ id: 'm1' }]);
      if (url.endsWith('/responses')) return notOk(404);
      return notOk(404);
    }) });
  assert.equal(result.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(result.apiFormat, 'openai', 'responses 404 → chat');
  assert.equal(result.name, 'deepseek.com');
  assert.equal(log[0].url, 'https://api.deepseek.com/v1/models', 'v1 probed first');
  assert.equal(log[0].headers.Authorization, 'Bearer k');
});

test('probeProvider keeps an existing /vN path; responses non-404 → openai-responses', async () => {
  const log = [];
  const result = await ops.probeProvider({ baseUrl: 'https://x.com/openai/v2', apiKey: 'k',
    fetchImpl: gate((url, headers, method) => {
      log.push({ url, headers, method });
      if (url.endsWith('/v2/models')) return okList([{ id: 'm' }]);
      if (url.endsWith('/responses')) return notOk(400);
      return notOk(404);
    }) });
  assert.equal(result.baseUrl, 'https://x.com/openai/v2');
  assert.equal(result.apiFormat, 'openai-responses');
  assert.equal(log.length >= 2 && !log.some(e => e.url.includes('/v1/models')), true, 'never tried /v1');
});

test('probeProvider falls back to the bare base when /v1 404s', async () => {
  const log = [];
  const result = await ops.probeProvider({ baseUrl: 'https://y.com/base', apiKey: 'k',
    fetchImpl: gate((url) => {
      log.push(url);
      if (url === 'https://y.com/base/models') return okList([{ id: 'm' }]);
      if (url.endsWith('/responses')) { const e = new Error('nope'); e.name = 'TypeError'; throw e; }
      return notOk(404);
    }) });
  assert.equal(result.baseUrl, 'https://y.com/base');
  assert.equal(result.apiFormat, 'openai', 'responses network error → chat');
  assert.ok(log[0].endsWith('/v1/models') && log.includes('https://y.com/base/models'));
});

test('probeProvider retries 401/403 with Anthropic headers and detects the format', async () => {
  const log = [];
  const result = await ops.probeProvider({ baseUrl: 'https://api.anthropic.com', apiKey: 'k',
    fetchImpl: gate((url, headers) => {
      log.push(headers);
      if (url.endsWith('/models')) {
        if (headers['x-api-key']) return okList([{ id: 'claude-x', type: 'model', display_name: 'Claude X' }]);
        return notOk(401);
      }
      return notOk(404);
    }) });
  assert.equal(result.apiFormat, 'anthropic');
  assert.ok(log.some(h => h['x-api-key'] === 'k'), 'x-api-key retried');
  assert.ok(log.some(h => h['anthropic-version']), 'anthropic-version sent');
});

test('probeProvider flags anthropic-shaped data even when Bearer worked', async () => {
  const result = await ops.probeProvider({ baseUrl: 'https://gw.example.com', apiKey: 'k',
    fetchImpl: gate((url) => url.endsWith('/models')
      ? okList([{ id: 'c', type: 'model', display_name: 'C' }]) : notOk(404)) });
  assert.equal(result.apiFormat, 'anthropic');
});

test('probeProvider error messages: auth, missing list, unreachable, bad input', async () => {
  await assert.rejects(() => ops.probeProvider({ baseUrl: 'https://x.com', apiKey: 'bad',
    fetchImpl: gate(() => notOk(401)) }), /API Key 无效/);
  await assert.rejects(() => ops.probeProvider({ baseUrl: 'https://x.com', apiKey: 'k',
    fetchImpl: gate(() => okList ? ({ status: 200, ok: true, json: async () => ({ not: 'a list' }) }) : null) }),
    /没有返回模型列表/);
  await assert.rejects(() => ops.probeProvider({ baseUrl: 'https://x.com', apiKey: 'k',
    fetchImpl: gate(() => { throw new Error('ECONNREFUSED'); }) }), /无法连接/);
  await assert.rejects(() => ops.probeProvider({ baseUrl: 'bad', apiKey: 'k', fetchImpl: gate(() => notOk(404)) }),
    /地址|http/);
  await assert.rejects(() => ops.probeProvider({ baseUrl: 'https://x.com', apiKey: '  ',
    fetchImpl: gate(() => notOk(404)) }), /API Key/);
});

test('uniqueName dedupes against other providers only', () => {
  const config = { providers: [{ id: 'a', name: 'deepseek.com' }, { id: 'b', name: 'deepseek.com 2' }] };
  assert.equal(ops.uniqueName('deepseek.com', config), 'deepseek.com 3');
  assert.equal(ops.uniqueName('deepseek.com', config, 'a'), 'deepseek.com', 'excluded id frees its name');
  assert.equal(ops.uniqueName('other.com', config), 'other.com');
  assert.equal(ops.hostName('https://api.foo.com/v1'), 'foo.com');
  assert.equal(ops.hostName('https://www.bar.com'), 'bar.com');
});

// --- mergeDiscovered / updateProvider / setModelsEnabled ----------------------

test('mergeDiscovered: new disabled, existing keep flag, missing kept-or-dropped', () => {
  const provider = { name: 'P', models: [
    { id: 'keep-on', enabled: true, label: 'P · keep-on' },
    { id: 'keep-off', enabled: false, label: 'P · keep-off' },
    { id: 'gone-on', enabled: true, label: 'P · gone-on' },
    { id: 'gone-off', enabled: false, label: 'P · gone-off' },
  ] };
  ops.mergeDiscovered(provider, [{ id: 'keep-on' }, { id: 'keep-off' }, { id: 'brand-new' }], null);
  const byId = new Map(provider.models.map(m => [m.id, m]));
  assert.equal(byId.get('keep-on').enabled, true);
  assert.equal(byId.get('keep-off').enabled, false);
  assert.equal(byId.get('brand-new').enabled, false, 'new models default hidden');
  assert.equal(byId.get('gone-on').meta.missing, true, 'enabled missing model kept + flagged');
  assert.equal(byId.has('gone-off'), false, 'disabled missing model dropped');
});

test('updateProvider renames with label rewrite, overrides format, rotates key', () => {
  const config = makeConfig();
  const id = ops.saveProvider(config, { name: 'Old', baseUrl: 'https://p.example.com',
    apiFormat: 'openai', apiKey: 'sk-1' });
  config.providers[0].models = [{ id: 'm', label: 'Old · m' }];
  ops.updateProvider(config, { id, name: 'New', apiFormat: 'anthropic', apiKey: 'sk-2' });
  const p = config.providers[0];
  assert.equal(p.name, 'New');
  assert.equal(p.models[0].label, 'New · m');
  assert.equal(p.apiFormat, 'anthropic');
  assert.equal(p.apiKey, 'sk-2');
  ops.updateProvider(config, { id, apiKey: '' });
  assert.equal(p.apiKey, 'sk-2', 'empty key keeps stored key');
  assert.throws(() => ops.updateProvider(config, { id, apiFormat: 'weird' }), ops.SettingsInputError);
  assert.throws(() => ops.updateProvider(config, { id: 'ghost' }), ops.SettingsInputError);
});

test('setModelsEnabled applies bulk flags and validates input', () => {
  const config = makeConfig();
  const id = ops.saveProvider(config, { name: 'P', baseUrl: 'https://p.example.com', apiFormat: 'openai' });
  config.providers[0].models = [{ id: 'a' }, { id: 'b', enabled: false }, { id: 'c' }];
  assert.equal(ops.setModelsEnabled(config, { providerId: id, modelIds: ['a', 'b'], enabled: true }), 2);
  assert.equal(config.providers[0].models[0].enabled, true);
  assert.equal(config.providers[0].models[1].enabled, true);
  assert.equal(ops.setModelsEnabled(config, { providerId: id, modelIds: ['c', 'ghost'], enabled: false }), 1);
  assert.equal(config.providers[0].models[2].enabled, false);
  assert.throws(() => ops.setModelsEnabled(config, { providerId: id, modelIds: 'x', enabled: true }), ops.SettingsInputError);
  assert.throws(() => ops.setModelsEnabled(config, { providerId: id, modelIds: ['a'], enabled: 'yes' }), ops.SettingsInputError);
});
