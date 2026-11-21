'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { buildCatalog, resolveAssignment, augmentCatalog, collectNativeModels, ownUid,
  discoverOfficialRoles } = require('../src/catalog.cjs');
const { fields, s, m } = require('../src/protocol/wire.cjs');

const providers = () => [{ id: 'p', name: 'P', models: [{ id: 'm1', label: 'M1', efforts: [null, 'high'] }] }];
const NATIVES = [
  { modelUid: 'lead-n', label: 'Lead N', modelInfo: { harnessUids: ['swe-1p5'], isModelRouter: false } },
  { modelUid: 'side-n', label: 'Side N', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } },
  { modelUid: 'fusion-lead-n-sidekick-side-n', label: 'F', modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
    modelFamilyMetadata: { entries: [
      { key: 'Lead', value: { order: 1, name: 'Lead N' } },
      { key: 'Effort', value: { order: 2, name: 'High' } },
      { key: 'Sidekick', value: { order: 1, name: 'Side N' } },
    ] } },
];
const observed = () => collectNativeModels({ clientModelConfigs: NATIVES }, { rpc: 'GetCliModelConfigs', format: { json: true } });
const byokUid = catalog => Object.keys(catalog.routes).find(uid => catalog.routes[uid].effort === null);

test('dmp- and fusion-dmp- uids are owned; old prefixes are not', () => {
  assert.equal(ownUid('dmp-p-m1-abc'), true);
  assert.equal(ownUid('fusion-dmp-a'), true);
  assert.equal(ownUid('dfbyok-x'), false);
  assert.equal(ownUid('fusion-dfbyok-x'), false);
});

test('fusion-dmp-a and fusion-dmp-b are always emitted even with no slots', () => {
  const catalog = buildCatalog({ providers: providers() });
  const uids = catalog.models.map(model => model.uid);
  assert.ok(uids.includes('fusion-dmp-a') && uids.includes('fusion-dmp-b'));
  assert.equal(Object.keys(catalog.fusions).length, 0, 'unconfigured slots carry no resolution');
  const a = catalog.models.find(model => model.uid === 'fusion-dmp-a');
  assert.equal(a.label, 'BYOK Fusion');
  assert.equal(a.json.modelInfo.isModelRouter, true);
  assert.deepEqual(a.json.modelFamilyMetadata.entries, []);
});

test('a BYOK lead + native sidekick slot resolves via both assignment shapes', () => {
  const config = { providers: providers() };
  const base = buildCatalog(config, observed());
  const lead = byokUid(base);
  config.fusionSlots = { a: { lead: { kind: 'byok', uid: lead }, sidekick: { kind: 'native', uid: 'side-n' } } };
  const catalog = buildCatalog(config, observed());
  assert.ok(catalog.fusions['fusion-dmp-a']);
  assert.equal(catalog.fusions['fusion-dmp-a'].sidekickNative, true);
  assert.deepEqual(catalog.fusions['fusion-dmp-a'].sidekickHarnessUids, ['swe-1p6']);
  // lead assignment (modelRouterUid → harness 'fusion')
  const leadHit = resolveAssignment({ modelRouterUid: 'fusion-dmp-a' }, { json: true }, catalog);
  assert.equal(leadHit.assignment.modelUid, lead);
  assert.deepEqual(leadHit.assignment.harnessUids, ['fusion']);
  // sidekick assignment (fusionLeadRouterUid → native sidekick harnesses)
  const sideHit = resolveAssignment({ modelRouterUid: 'fusion-dmp-a', fusionLeadRouterUid: 'fusion-dmp-a' }, { json: true }, catalog);
  assert.equal(sideHit.assignment.modelUid, 'side-n');
  assert.deepEqual(sideHit.assignment.harnessUids, ['swe-1p6']);
});

test('a native lead + BYOK sidekick slot resolves with observed lead harnesses', () => {
  const config = { providers: providers() };
  const base = buildCatalog(config, observed());
  const sidekick = byokUid(base);
  config.fusionSlots = { b: { lead: { kind: 'native', uid: 'lead-n' }, sidekick: { kind: 'byok', uid: sidekick } } };
  const catalog = buildCatalog(config, observed());
  const fusion = catalog.fusions['fusion-dmp-b'];
  assert.ok(fusion);
  assert.equal(fusion.leadNative, true);
  assert.deepEqual(fusion.leadHarnessUids, ['fusion'], 'native lead runs through the official fusion harness');
  const leadHit = resolveAssignment({ modelRouterUid: 'fusion-dmp-b' }, { json: true }, catalog);
  assert.equal(leadHit.assignment.modelUid, 'lead-n');
  assert.deepEqual(leadHit.assignment.harnessUids, ['fusion']);
  const sideHit = resolveAssignment({ modelRouterUid: 'fusion-dmp-b', fusionLeadRouterUid: 'fusion-dmp-b' }, { json: true }, catalog);
  assert.equal(sideHit.assignment.modelUid, sidekick);
});

test('unresolvable slot refs are omitted from fusions and forwarded upstream', () => {
  const config = { providers: providers(),
    fusionSlots: { a: { lead: { kind: 'byok', uid: 'dmp-gone' }, sidekick: { kind: 'native', uid: 'side-n' } },
      b: { lead: { kind: 'native', uid: 'not-eligible' }, sidekick: { kind: 'native', uid: 'side-n' } } } };
  const catalog = buildCatalog(config, observed());
  assert.deepEqual(Object.keys(catalog.fusions), [], 'both slots fail to resolve');
  assert.equal(resolveAssignment({ modelRouterUid: 'fusion-dmp-a' }, { json: true }, catalog), null);
  // the fusion entries still appear in the picker
  assert.ok(catalog.models.some(model => model.uid === 'fusion-dmp-a'));
});

test('fusions flow through augmentCatalog and the team allowlist like old fusions did', () => {
  const config = { providers: providers() };
  const base = buildCatalog(config, observed());
  const lead = byokUid(base);
  config.fusionSlots = { a: { lead: { kind: 'byok', uid: lead }, sidekick: { kind: 'native', uid: 'side-n' } } };
  const catalog = buildCatalog(config, observed());
  const input = { clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] };
  const out = augmentCatalog(input, { rpc: '/exa.api_server_pb.ApiServerService/GetCliModelConfigs', format: { json: true }, catalog });
  const uids = out.clientModelConfigs.map(model => model.modelUid);
  assert.ok(uids.includes('fusion-dmp-a') && uids.includes('fusion-dmp-b'));
  // the allowlist admits a resolved fusion only when its native sidekick is allowed
  const denied = augmentCatalog({ allowedModelUids: ['official'] },
    { rpc: '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings', format: { json: true }, catalog });
  assert.ok(!denied.allowedModelUids.includes('fusion-dmp-a'));
  const allowed = augmentCatalog({ allowedModelUids: ['official', 'side-n'] },
    { rpc: '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings', format: { json: true }, catalog });
  assert.ok(allowed.allowedModelUids.includes('fusion-dmp-a'));
});

test('protobuf augment emits both fusion entries as model routers', () => {
  const catalog = buildCatalog({ providers: providers() }, observed());
  const a = catalog.models.find(model => model.uid === 'fusion-dmp-a');
  const info = fields(a.raw, 23)[0].value;
  assert.ok(a.raw.length > 0);
  assert.ok(s(22, 'fusion-dmp-a').length > 0 && info.length > 0);
});

test('real proto bytes: absent order/name fields no longer drop fusionMetadata', () => {
  const entries = JSON.parse(fs.readFileSync(require('path').resolve(__dirname, 'fixtures/real-proto-entries.json'), 'utf8'));
  const list = Buffer.concat(entries.map(b64 => m(1, Buffer.from(b64, 'base64'))));
  const seen = collectNativeModels(list, { rpc: '/x/GetCliModelConfigs' });
  const fusionMeta = seen.filter(entry => Array.isArray(entry.fusionMetadata));
  assert.ok(fusionMeta.length > 20, 'real fusion entries keep their family metadata');
  const roles = discoverOfficialRoles(seen);
  assert.ok(roles.eligibleNativeLeads.has('claude-opus-5-5-medium'), 'native leads discovered');
  assert.ok(roles.eligibleNativeSidekicks.has('swe-2-medium'));
  assert.ok(roles.eligibleNativeSidekicks.has('swe-2-high'));
});
