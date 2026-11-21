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
  const second = await (await post({ lead, sidekick, currentUid: first.uid })).json();
  assert.equal(second.uid, 'fusion-dmp-b', 'alternates to force a real picker change');
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'));
  assert.deepEqual(saved.fusionSlots.b.lead, lead);
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

test('/picker/fusion returns 503 while the extension is disabled', async t => {
  const f = await fixture(t, { enabled: false, providers: providers() });
  const res = await fetch(f.base + '/picker/fusion', { method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ lead: { kind: 'native', uid: 'x' }, sidekick: { kind: 'native', uid: 'y' } }) });
  assert.equal(res.status, 503);
});
