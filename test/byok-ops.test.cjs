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
