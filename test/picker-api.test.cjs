'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startBackend } = require('../src/runtime/backend.cjs');
const { writeConfig } = require('../src/config.cjs');
const API = '/exa.api_server_pb.ApiServerService/';
const ORIGIN = 'vscode-file://vscode-app';

async function fixture(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-picker-'));
  writeConfig(path.join(root, 'config.json'), config);
  const backend = await startBackend({ root, port: 0, log: () => {} });
  t.after(async () => { await backend.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, base: 'http://127.0.0.1:' + backend.port };
}

const providers = () => [{ id: 'p', name: 'P', baseUrl: 'https://p.invalid/v1', apiKey: 'fixture-secret',
  apiFormat: 'openai', models: [
    { id: 'm1', label: 'M1', efforts: [null, 'high'] },
    { id: 'm2', label: 'M2', efforts: [null] },
  ] }];

test('/picker routes require the exact workbench origin; legacy routes reject any origin', async t => {
  const f = await fixture(t, { providers: providers() });
  for (const headers of [{}, { origin: 'https://evil.invalid' }, { origin: 'http://localhost' }]) {
    const res = await fetch(f.base + '/picker/state', { headers });
    assert.equal(res.status, 403, JSON.stringify(headers));
  }
  const ok = await fetch(f.base + '/picker/state', { headers: { origin: ORIGIN } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('vary'), 'Origin');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  for (const headers of [{ origin: ORIGIN }, { origin: 'https://evil.invalid' }]) {
    assert.equal((await fetch(f.base + '/health', { headers })).status, 403, 'legacy routes still 403 on any Origin');
    assert.equal((await fetch(f.base + API + 'GetUserStatus', { method: 'POST', body: 'x', headers })).status, 403);
  }
});

test('OPTIONS preflight is handled and limited to GET/POST + content-type', async t => {
  const f = await fixture(t, { providers: providers() });
  const res = await fetch(f.base + '/picker/state', { method: 'OPTIONS', headers: { origin: ORIGIN } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST');
  assert.equal(res.headers.get('access-control-allow-headers'), 'content-type');
  assert.equal(res.headers.get('access-control-max-age'), '600');
});

test('/picker/state exposes no apiKey or baseUrl anywhere', async t => {
  const f = await fixture(t, { providers: providers() });
  const res = await fetch(f.base + '/picker/state', { headers: { origin: ORIGIN } });
  const body = await res.json();
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('fixture-secret') && !raw.includes('p.invalid'), 'no secrets or URLs');
  assert.ok(!raw.includes('apiKey') && !raw.includes('baseUrl'));
  assert.ok(body.byok && body.fusionSlots && body.fusionCandidates);
  const uid = Object.keys(body.byok)[0];
  assert.equal(body.byok[uid].providerId, 'p');
  assert.equal(body.byok[uid].modelId, 'm1');
  const lead = body.fusionCandidates.leads.find(c => c.ref.kind === 'byok');
  assert.equal(lead.providerName, 'P');
  assert.equal(lead.familyKey, 'byok:p:m1');
});

test('/picker/fusion alternates slots, validates refs and rejects same_model', async t => {
  const f = await fixture(t, { providers: providers() });
  const post = body => fetch(f.base + '/picker/fusion', { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const state = await (await fetch(f.base + '/picker/state', { headers: { origin: ORIGIN } })).json();
  const leads = state.fusionCandidates.leads.filter(c => c.ref.kind === 'byok');
  const sidekicks = state.fusionCandidates.sidekicks.filter(c => c.ref.kind === 'byok');
  const lead = leads.find(c => c.familyKey === 'byok:p:m1').ref;
  const sidekick = sidekicks.find(c => c.familyKey === 'byok:p:m2').ref;
  const first = await (await post({ lead, sidekick })).json();
  assert.equal(first.uid, 'fusion-dmp-a');
  const lead2 = leads.find(c => c.familyKey === 'byok:p:m2').ref;
  const sidekick2 = sidekicks.find(c => c.familyKey === 'byok:p:m1' && c.ref.uid !== lead.uid).ref;
  const second = await (await post({ lead: lead2, sidekick: sidekick2, currentUid: first.uid })).json();
  assert.equal(second.uid, 'fusion-dmp-b', 'alternates to force a real picker change');
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'));
  assert.deepEqual(saved.fusionSlots.b.lead, lead2);
  const bad = await post({ lead: { kind: 'byok', uid: 'dmp-nope' }, sidekick });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'invalid_ref' });
  const variant = sidekicks.find(c => c.familyKey === 'byok:p:m1' && c.ref.uid !== lead.uid).ref;
  for (const pair of [{ lead, sidekick: lead }, { lead, sidekick: variant }]) {
    const res = await post(pair);
    assert.equal(res.status, 400, JSON.stringify(pair));
    assert.deepEqual(await res.json(), { error: 'same_model' });
  }
});

test('/picker/fusion reuses the slot already holding the pair without writing', async t => {
  const f = await fixture(t, { providers: providers() });
  const post = body => fetch(f.base + '/picker/fusion', { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const state = await (await fetch(f.base + '/picker/state', { headers: { origin: ORIGIN } })).json();
  const lead = state.fusionCandidates.leads.find(c => c.familyKey === 'byok:p:m1').ref;
  const sidekick = state.fusionCandidates.sidekicks.find(c => c.familyKey === 'byok:p:m2').ref;
  const first = await (await post({ lead, sidekick })).json();
  assert.equal(first.uid, 'fusion-dmp-a');
  // Posting the exact pair slot a holds returns its uid — even when the
  // current value is the other slot — and leaves config.json untouched.
  const again = await (await post({ lead, sidekick, currentUid: 'fusion-dmp-b' })).json();
  assert.equal(again.uid, 'fusion-dmp-a');
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'));
  assert.deepEqual(saved.fusionSlots, { a: { lead, sidekick } }, 'slot b was never written');
});

test('native+native selection returns the official fusion uid shortcut', async t => {
  const f = await fixture(t, { providers: providers() });
  const natives = { clientModelConfigs: [
    { modelUid: 'lead-n', label: 'Lead N', modelInfo: { harnessUids: ['swe-1p5'], isModelRouter: false } },
    { modelUid: 'side-n', label: 'Side N', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } },
    { modelUid: 'fusion-lead-n-sidekick-side-n', label: 'F', modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [
        { key: 'Lead', value: { order: 1, name: 'Lead N' } },
        { key: 'Effort', value: { order: 2, name: 'High' } },
        { key: 'Sidekick', value: { order: 1, name: 'Side N' } },
      ] } },
  ] };
  const { pickerFusion } = require('../src/picker-api.cjs');
  const { buildCatalog, collectNativeModels } = require('../src/catalog.cjs');
  const observed = collectNativeModels(natives, { rpc: 'GetCliModelConfigs', format: { json: true } });
  const config = { providers: providers() };
  const catalog = buildCatalog(config, observed);
  const wrote = [];
  const context = { catalog, config, configFile: path.join(f.root, 'config.json'),
    writeConfig: (file, value) => { wrote.push(value); writeConfig(file, value); },
    observedNatives: new Map(observed.map(entry => [entry.uid, entry])) };
  const out = await pickerFusion({ lead: { kind: 'native', uid: 'lead-n' },
    sidekick: { kind: 'native', uid: 'side-n' } }, context);
  assert.equal(out.status, 200);
  assert.equal(out.body.uid, 'fusion-lead-n-sidekick-side-n');
  assert.equal(wrote.length, 0, 'official shortcut must not touch config');
});

test('native fusion candidates carry family identity from observed natives', () => {
  const { buildCatalog, collectNativeModels } = require('../src/catalog.cjs');
  const { candidates } = require('../src/picker-api.cjs');
  const natives = { clientModelConfigs: [
    { modelUid: 'lead-n', label: 'Lead N',
      modelInfo: { harnessUids: ['swe-1p5'], isModelRouter: false, modelFamilyUid: 'fam-lead-n' },
      modelFamilyMetadata: { modelFamilyLabel: 'Lead N Fam',
        entries: [{ key: 'Effort', value: { order: 2, name: 'High' } }] } },
    { modelUid: 'side-n', label: 'Side N', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } },
    { modelUid: 'fusion-lead-n-sidekick-side-n', label: 'F', modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [
        { key: 'Lead', value: { order: 1, name: 'Lead N' } },
        { key: 'Effort', value: { order: 2, name: 'High' } },
        { key: 'Sidekick', value: { order: 1, name: 'Side N' } },
      ] } },
  ] };
  const observed = collectNativeModels(natives, { rpc: 'GetCliModelConfigs', format: { json: true } });
  const catalog = buildCatalog({ providers: providers() }, observed);
  const lead = candidates(catalog, { providers: providers() }).leads.find(c => c.ref.uid === 'lead-n');
  assert.equal(lead.familyKey, 'fam-lead-n', 'familyKey is the family uid, not the model uid');
  assert.equal(lead.familyLabel, 'Lead N Fam');
  assert.equal(lead.effortOrder, 2);
});

test('native sidekick candidates expose officialLeads from observed fusion routers', () => {
  const { buildCatalog, collectNativeModels } = require('../src/catalog.cjs');
  const { pickerState } = require('../src/picker-api.cjs');
  const natives = { clientModelConfigs: [
    { modelUid: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 High',
      modelInfo: { harnessUids: ['swe-1p5'], isModelRouter: false } },
    { modelUid: 'swe-2-high', label: 'SWE-2 High',
      modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } },
    { modelUid: 'swe-2-max', label: 'SWE-2 Max',
      modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } },
    { modelUid: 'fusion-claude-opus-5-5-high-sidekick-swe-2-high', label: 'F',
      modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [
        { key: 'Lead', value: { order: 1, name: 'Claude Opus 5.5 High' } },
        { key: 'Effort', value: { order: 2, name: 'High' } },
        { key: 'Sidekick', value: { order: 1, name: 'SWE-2 High' } },
      ] } },
    { modelUid: 'fusion-claude-opus-5-5-high-sidekick-swe-2-max', label: 'F2', disabled: true,
      modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [
        { key: 'Lead', value: { order: 1, name: 'Claude Opus 5.5 High' } },
        { key: 'Effort', value: { order: 2, name: 'High' } },
        { key: 'Sidekick', value: { order: 2, name: 'SWE-2 Max' } },
      ] } },
  ] };
  const observed = collectNativeModels(natives, { rpc: 'GetCliModelConfigs', format: { json: true } });
  const config = { providers: providers() };
  const catalog = buildCatalog(config, observed);
  const observedNatives = new Map(observed.map(entry => [entry.uid, entry]));
  const state = pickerState({ version: 'x', catalog, config, observedNatives });
  const sidekicks = state.fusionCandidates.sidekicks;
  assert.deepEqual(sidekicks.find(c => c.ref.uid === 'swe-2-high').officialLeads,
    ['claude-opus-5-5-high']);
  assert.deepEqual(sidekicks.find(c => c.ref.uid === 'swe-2-max').officialLeads, [],
    'a disabled official router does not count');
  const byokSidekick = sidekicks.find(c => c.ref.kind === 'byok');
  assert.ok(byokSidekick && !('officialLeads' in byokSidekick), 'BYOK candidates carry no field');
  const bare = pickerState({ version: 'x', catalog, config });
  assert.deepEqual(bare.fusionCandidates.sidekicks.find(c => c.ref.uid === 'swe-2-high').officialLeads, [],
    'missing observedNatives behaves as empty');

  // Self-pairing (`leadUid === sidekickUid`) and ambiguous `-sidekick-` substrings must not misclassify.
  const trickyNatives = { clientModelConfigs: [
    { modelUid: 'alpha-sidekick-beta', label: 'Alpha Sidekick Beta',
      modelInfo: { harnessUids: ['swe-1p5', 'swe-1p6'], isModelRouter: false } },
    { modelUid: 'beta', label: 'Beta',
      modelInfo: { harnessUids: ['swe-1p5', 'swe-1p6'], isModelRouter: false } },
    { modelUid: 'fusion-alpha-sidekick-beta-sidekick-alpha-sidekick-beta', label: 'Self',
      modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [
        { key: 'Lead', value: { order: 1, name: 'Alpha Sidekick Beta' } },
        { key: 'Effort', value: { order: 1, name: 'High' } },
        { key: 'Sidekick', value: { order: 1, name: 'Alpha Sidekick Beta' } },
      ] } },
    { modelUid: 'fusion-alpha-sidekick-beta-sidekick-beta', label: 'Valid Tricky',
      modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [
        { key: 'Lead', value: { order: 1, name: 'Alpha Sidekick Beta' } },
        { key: 'Effort', value: { order: 1, name: 'High' } },
        { key: 'Sidekick', value: { order: 2, name: 'Beta' } },
      ] } },
  ] };
  const trickyObs = collectNativeModels(trickyNatives, { rpc: 'GetCliModelConfigs', format: { json: true } });
  const trickyCatalog = buildCatalog(config, trickyObs);
  const trickyMap = new Map(trickyObs.map(entry => [entry.uid, entry]));
  const trickyState = pickerState({ version: 'x', catalog: trickyCatalog, config, observedNatives: trickyMap });
  assert.deepEqual(
    trickyState.fusionCandidates.sidekicks.find(c => c.ref.uid === 'alpha-sidekick-beta').officialLeads,
    [],
    'leadUid === sidekickUid is skipped even if an official-looking router exists',
  );
  assert.deepEqual(
    trickyState.fusionCandidates.sidekicks.find(c => c.ref.uid === 'beta').officialLeads,
    ['alpha-sidekick-beta'],
    'forward lookup handles -sidekick- inside lead UIDs without lastIndexOf ambiguity',
  );
});

test('BYOK fusion candidate familyLabel drops the catalog effort suffix', () => {
  const { buildCatalog } = require('../src/catalog.cjs');
  const { candidates } = require('../src/picker-api.cjs');
  const config = { providers: [{ id: 'p', name: 'Magpie',
    models: [{ id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', efforts: [null, 'high'] }] }] };
  const leads = candidates(buildCatalog(config), config).leads.filter(c => c.ref.kind === 'byok');
  const def = leads.find(c => c.effort == null);
  const high = leads.find(c => c.effort === 'high');
  assert.ok(def && high, 'null and high effort variants both exist');
  assert.equal(def.familyLabel, 'DeepSeek Reasoner');
  assert.equal(high.familyLabel, 'DeepSeek Reasoner', 'series name must not keep "High"');
  assert.match(high.label, /High$/);
});

test('/picker/fusion returns 503 while the extension is disabled', async t => {
  const f = await fixture(t, { enabled: false, providers: providers() });
  const res = await fetch(f.base + '/picker/fusion', { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ lead: { kind: 'native', uid: 'x' }, sidekick: { kind: 'native', uid: 'y' } }) });
  assert.equal(res.status, 503);
});

// --- BYOK provider endpoints -------------------------------------------------

test('/picker/providers lists providers, strips baseUrl userinfo/query, never leaks apiKey', async t => {
  const f = await fixture(t, { providers: [
    { id: 'p1', name: 'Magpie', baseUrl: 'https://user:pass@p.invalid/v1?q=1#frag',
      apiFormat: 'openai', apiKey: 'fixture-secret', models: [{ id: 'm1', label: 'M1' }] },
    { id: 'p2', name: 'NoKey', baseUrl: 'https://clean.invalid', apiFormat: 'anthropic', models: [] },
  ] });
  for (const headers of [{}, { origin: 'https://evil.invalid' }]) {
    assert.equal((await fetch(f.base + '/picker/providers', { headers })).status, 403, JSON.stringify(headers));
  }
  const res = await fetch(f.base + '/picker/providers', { headers: { origin: ORIGIN } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.providers.length, 2);
  const p1 = body.providers[0];
  assert.equal(p1.baseUrl, 'https://p.invalid/v1', 'userinfo/query/hash stripped');
  assert.equal(p1.keyConfigured, true);
  assert.equal(p2key(body), false, 'unconfigured key reported');
  assert.equal(p1.models.length, 1);
  const m1 = p1.models[0];
  assert.equal(m1.id, 'm1');
  assert.equal(m1.label, 'M1');
  assert.equal(m1.enabled, true);
  assert.equal(m1.supportsImages, true);
  assert.equal(m1.missing, false);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('fixture-secret') && !raw.includes('apiKey') && !raw.includes('user:pass'), 'no secrets');
});
function p2key(body) { return body.providers[1].keyConfigured; }

test('/picker/providers/save creates and edits, delete removes, config.json is written', async t => {
  const f = await fixture(t, { providers: [] });
  const post = (path, body) => fetch(f.base + path, { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const created = await (await post('/picker/providers/save',
    { name: 'Magpie', baseUrl: 'https://api.example.com/v1', apiFormat: 'openai', apiKey: 'sk-x' })).json();
  assert.ok(created.id);
  const onDisk = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'));
  assert.equal(onDisk.providers.length, 1);
  assert.equal(onDisk.providers[0].apiKey, 'sk-x', 'key stored in config, never returned');
  // Edit without apiKey keeps the stored key.
  const edited = await post('/picker/providers/save',
    { id: created.id, name: 'Magpie 2', baseUrl: 'https://api2.example.com', apiFormat: 'anthropic' });
  assert.equal(edited.status, 200);
  const onDisk2 = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'));
  assert.equal(onDisk2.providers[0].apiKey, 'sk-x');
  assert.equal(onDisk2.providers[0].apiFormat, 'anthropic');
  // Validation error → 400 + Chinese message.
  const bad = await post('/picker/providers/save', { name: 'X', baseUrl: 'not-a-url', apiFormat: 'openai' });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.error, 'invalid_input');
  assert.match(badBody.message, /地址|无效|填写/);
  // Delete.
  assert.equal((await post('/picker/providers/delete', { id: created.id })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8')).providers.length, 0);
  assert.equal((await post('/picker/providers/delete', { id: 'ghost' })).status, 400);
});

test('/picker/models/remove drops the model from the provider', async t => {
  const f = await fixture(t, { providers: providers() });
  const res = await fetch(f.base + '/picker/models/remove', { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'p', modelId: 'm1' }) });
  assert.equal(res.status, 200);
  const onDisk = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'));
  assert.deepEqual(onDisk.providers[0].models.map(model => model.id), ['m2']);
  const bad = await fetch(f.base + '/picker/models/remove', { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: 'ghost', modelId: 'm1' }) });
  assert.equal(bad.status, 400);
});

// Direct handlePickerRequest with a stubbed discover — no real network.
function fakeRequest(body) {
  return { method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } };
}
function fakeResponse() {
  return { status: 0, body: null, writeHead(status) { this.status = status; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; } };
}

test('discover→import flow: pending token validates and provider edits invalidate it', async t => {
  const { handlePickerRequest } = require('../src/picker-api.cjs');
  const config = { providers: [{ id: 'p1', name: 'P', baseUrl: 'https://p.invalid',
    apiFormat: 'openai', apiKey: 'sk-x', models: [] }] };
  const ctx = { config, configFile: '/dev/null', writeConfig: (file, next) => { Object.assign(config, next); },
    discover: async () => [{ id: 'm1', label: 'Model 1' }, { id: 'm2' }],
    modelsDevIndex: async () => null, pendingDiscovers: new Map() };
  const call = async (path, body) => {
    const res = fakeResponse();
    await handlePickerRequest(fakeRequest(body), res, path, ctx);
    return res;
  };
  const dis = await call('/picker/providers/discover', { id: 'p1' });
  assert.equal(dis.status, 200);
  assert.ok(dis.body.token);
  assert.deepEqual(dis.body.models.map(model => model.id), ['m1', 'm2']);
  assert.ok(dis.body.models.every(model => model.imported === false));
  const imp = await call('/picker/providers/import', { id: 'p1', token: dis.body.token, ids: ['m1'] });
  assert.equal(imp.status, 200);
  assert.deepEqual(config.providers[0].models.map(model => model.id), ['m1']);
  // Editing the provider (baseUrl change) invalidates the pending token.
  const save = await call('/picker/providers/save', { id: 'p1', name: 'P', baseUrl: 'https://p2.invalid', apiFormat: 'openai' });
  assert.equal(save.status, 200);
  const stale = await call('/picker/providers/import', { id: 'p1', token: dis.body.token, ids: ['m2'] });
  assert.equal(stale.status, 400);
  assert.match(stale.body.message, /失效|重新/);
  // Discover upstream failure → 502.
  ctx.discover = async () => { throw new Error('boom'); };
  const failed = await call('/picker/providers/discover', { id: 'p1' });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, 'discover_failed');
  assert.ok(!JSON.stringify(failed.body).includes('sk-x'), 'errors never echo the key');
});

test('/picker/providers/connect probes, stores all models disabled, returns a clean view', async t => {
  const { handlePickerRequest } = require('../src/picker-api.cjs');
  const config = { providers: [{ id: 'old', name: 'gw.example.com', baseUrl: 'https://old.invalid',
    apiFormat: 'openai', apiKey: 'sk-old', models: [] }] };
  const calls = [];
  const ctx = { config, configFile: '/dev/null', writeConfig: (file, next) => { Object.assign(config, next); },
    modelsDevIndex: async () => null,
    discover: async () => [{ id: 'm1' }, { id: 'm2', label: 'M Two' }],
    fetchImpl: async (url, options = {}) => {
      calls.push(String(url));
      if (String(url).endsWith('/models')) return { status: 200, ok: true, json: async () => ({ data: [{ id: 'm1' }] }) };
      return { status: 404, ok: false, json: async () => ({}) };
    } };
  const res = fakeResponse();
  await handlePickerRequest(fakeRequest({ baseUrl: 'https://gw.example.com', apiKey: 'sk-new' }), res, '/picker/providers/connect', ctx);
  assert.equal(res.status, 200);
  const provider = res.body.provider;
  assert.equal(provider.name, 'gw.example.com 2', 'name deduped against existing provider');
  assert.equal(provider.apiFormat, 'openai');
  assert.equal(provider.baseUrl, 'https://gw.example.com/v1', 'probed v1 base stored');
  assert.ok(!('apiKey' in provider));
  assert.ok(calls[0].endsWith('/v1/models'));
  // All fetched models recorded, none enabled.
  assert.deepEqual(provider.models.map(m => [m.id, m.enabled]), [['m1', false], ['m2', false]]);
  const stored = config.providers.at(-1);
  assert.equal(stored.apiKey, 'sk-new', 'key stored in config');
  assert.equal(stored.models.length, 2);
  assert.equal(stored.models[0].enabled, false);
  assert.ok(!JSON.stringify(res.body).includes('sk-new'), 'key never echoed');
});

test('/picker/providers/connect with id re-probes and preserves enabled flags + missing', async t => {
  const { handlePickerRequest } = require('../src/picker-api.cjs');
  const config = { providers: [{ id: 'p1', name: 'P', baseUrl: 'https://p.invalid/v1',
    apiFormat: 'openai', apiKey: 'sk-1', models: [
      { id: 'a', label: 'P · a', enabled: true },
      { id: 'b', label: 'P · b', enabled: false },
      { id: 'gone-on', label: 'P · gone-on', enabled: true },
      { id: 'gone-off', label: 'P · gone-off', enabled: false },
    ] }] };
  const ctx = { config, configFile: '/dev/null', writeConfig: (file, next) => { Object.assign(config, next); },
    modelsDevIndex: async () => null,
    discover: async () => [{ id: 'a' }, { id: 'b' }, { id: 'new-m' }],
    fetchImpl: async (url) => String(url).endsWith('/models')
      ? { status: 200, ok: true, json: async () => ({ data: [] }) }
      : { status: 404, ok: false, json: async () => ({}) } };
  const res = fakeResponse();
  await handlePickerRequest(fakeRequest({ id: 'p1', baseUrl: 'https://p.invalid', apiKey: 'sk-2' }), res, '/picker/providers/connect', ctx);
  assert.equal(res.status, 200);
  const byId = new Map(res.body.provider.models.map(m => [m.id, m]));
  assert.equal(byId.get('a').enabled, true);
  assert.equal(byId.get('b').enabled, false);
  assert.equal(byId.get('new-m').enabled, false);
  assert.equal(byId.get('gone-on').missing, true);
  assert.ok(!byId.has('gone-off'));
  assert.equal(config.providers[0].apiKey, 'sk-2');
  assert.equal(config.providers[0].baseUrl, 'https://p.invalid/v1');
});

test('/picker/providers/refresh merges without probing; update renames; enabled bulk-toggles', async t => {
  const { handlePickerRequest } = require('../src/picker-api.cjs');
  const config = { providers: [{ id: 'p1', name: 'P', baseUrl: 'https://p.invalid/v1',
    apiFormat: 'openai', apiKey: 'sk-1', models: [
      { id: 'a', label: 'P · a', enabled: true }, { id: 'gone', label: 'P · gone', enabled: false }] }] };
  const ctx = { config, configFile: '/dev/null', writeConfig: (file, next) => { Object.assign(config, next); },
    modelsDevIndex: async () => null,
    discover: async () => [{ id: 'a' }, { id: 'fresh' }],
    fetchImpl: async () => { throw new Error('must not fetch'); } };
  const call = async (path, body) => { const res = fakeResponse(); await handlePickerRequest(fakeRequest(body), res, path, ctx); return res; };
  const ref = await call('/picker/providers/refresh', { id: 'p1' });
  assert.equal(ref.status, 200);
  const byId = new Map(ref.body.provider.models.map(m => [m.id, m]));
  assert.equal(byId.get('fresh').enabled, false);
  assert.ok(!byId.has('gone'), 'disabled missing model dropped on refresh');
  const upd = await call('/picker/providers/update', { id: 'p1', name: 'Renamed', apiFormat: 'anthropic' });
  assert.equal(upd.status, 200);
  assert.equal(config.providers[0].name, 'Renamed');
  assert.equal(config.providers[0].apiFormat, 'anthropic');
  assert.equal(config.providers[0].apiKey, 'sk-1');
  const badUpd = await call('/picker/providers/update', { id: 'p1', apiFormat: 'weird' });
  assert.equal(badUpd.status, 400);
  const en = await call('/picker/models/enabled', { providerId: 'p1', modelIds: ['a', 'fresh'], enabled: false });
  assert.equal(en.status, 200);
  assert.equal(en.body.applied, 2);
  assert.equal(config.providers[0].models[0].enabled, false);
  const badEn = await call('/picker/models/enabled', { providerId: 'ghost', modelIds: ['a'], enabled: true });
  assert.equal(badEn.status, 400);
});

test('/picker/providers/connect upstream probe failure → 400 with Chinese message', async t => {
  const { handlePickerRequest } = require('../src/picker-api.cjs');
  const config = { providers: [] };
  const ctx = { config, configFile: '/dev/null', writeConfig: () => {},
    modelsDevIndex: async () => null, discover: async () => [],
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); } };
  const res = fakeResponse();
  await handlePickerRequest(fakeRequest({ baseUrl: 'https://dead.invalid', apiKey: 'k' }), res, '/picker/providers/connect', ctx);
  assert.equal(res.status, 400);
  assert.match(res.body.message, /无法连接/);
  assert.equal(config.providers.length, 0, 'nothing persisted');
});

test('disabled BYOK routes stay routable but leave candidates and picker state', async () => {
  const { candidates, pickerState } = require('../src/picker-api.cjs');
  const { buildCatalog } = require('../src/catalog.cjs');
  const config = { providers: [{ id: 'p', name: 'P', apiFormat: 'openai', baseUrl: 'https://x.invalid', apiKey: 'k',
    models: [{ id: 'on', label: 'On', efforts: [null] }, { id: 'off', label: 'Off', efforts: [null], enabled: false }] }] };
  const catalog = buildCatalog(config, []);
  const lists = candidates(catalog, config);
  const byokUids = lists.leads.filter(item => item.ref.kind === 'byok').map(item => item.ref.uid);
  assert.equal(byokUids.length, 1, 'only the enabled route is a candidate');
  const state = pickerState({ version: 'x', catalog, config });
  assert.equal(Object.keys(state.byok).length, 1, 'picker state hides disabled routes');
  assert.equal(Object.keys(catalog.routes).length, 2, 'routes still carry the disabled model');
});
