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

test('disabled BYOK models reach cliModels and routes but not the renderer models', () => {
  const config = { providers: [{ id: 'p', name: 'P', models: [
    { id: 'shown', label: 'Shown', efforts: [null] },
    { id: 'hidden', label: 'Hidden', efforts: [null], enabled: false },
  ] }] };
  const catalog = buildCatalog(config, observed());
  const shownUid = Object.keys(catalog.routes).find(uid => catalog.routes[uid].model === 'shown');
  const hiddenUid = Object.keys(catalog.routes).find(uid => catalog.routes[uid].model === 'hidden');
  assert.ok(shownUid && hiddenUid, 'both models produce routes');
  assert.equal(catalog.routes[hiddenUid].enabled, false);
  assert.equal(catalog.routes[shownUid].enabled, true);
  const modelUids = catalog.models.map(model => model.uid);
  assert.ok(modelUids.includes(shownUid) && !modelUids.includes(hiddenUid), 'renderer catalog keeps only enabled');
  const cliUids = catalog.cliModels.map(model => model.uid);
  assert.ok(cliUids.includes(shownUid) && cliUids.includes(hiddenUid), 'CLI catalog keeps everything');
  assert.ok(cliUids.includes('fusion-dmp-a') && cliUids.includes('fusion-dmp-b'));
});

test('CLI rpcs expose disabled uids while renderer rpcs do not', () => {
  const config = { providers: [{ id: 'p', name: 'P', models: [
    { id: 'hidden', label: 'Hidden', efforts: [null], enabled: false },
  ] }] };
  const catalog = buildCatalog(config, observed());
  const hiddenUid = Object.keys(catalog.routes)[0];
  const input = { clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] };
  const cli = augmentCatalog(input, { rpc: '/exa.api_server_pb.ApiServerService/GetCliModelConfigs', format: { json: true }, catalog });
  assert.ok(cli.clientModelConfigs.some(model => model.modelUid === hiddenUid), 'GetCliModelConfigs carries hidden uids');
  for (const method of ['GetUserStatus', 'GetCascadeModelConfigs', 'GetCommandModelConfigs']) {
    const source = method === 'GetUserStatus'
      ? { userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] } } }
      : { clientModelConfigs: [{ modelUid: 'official', label: 'Official' }] };
    const out = augmentCatalog(source, { rpc: '/exa.api_server_pb.ApiServerService/' + method, format: { json: true }, catalog });
    const list = method === 'GetUserStatus' ? out.userStatus.cascadeModelConfigData.clientModelConfigs : out.clientModelConfigs;
    assert.ok(!list.some(model => model.modelUid === hiddenUid), method + ' must not list hidden uids');
  }
  const team = augmentCatalog({ allowedModelUids: ['official'] },
    { rpc: '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings', format: { json: true }, catalog });
  assert.ok(team.allowedModelUids.includes(hiddenUid), 'team allowlist admits hidden uids');
});

test('visibility toggles do not change the CLI signature', () => {
  const { signatureOf } = require('../src/runtime/picker-refresh.cjs');
  const provider = enabled => ({ id: 'p', name: 'P', models: [{ id: 'm1', label: 'M1', efforts: [null], enabled }] });
  const before = signatureOf(buildCatalog({ providers: [provider(true)] }).cliModels);
  const after = signatureOf(buildCatalog({ providers: [provider(false)] }).cliModels);
  assert.equal(before, after, 'a hidden model keeps the same CLI-side uid list');
});

test('unpaired natives join the fusion roles with derived lead harnesses', () => {
  const natives = [
    ...NATIVES,
    { modelUid: 'wild-n', label: 'Wild N', modelInfo: { harnessUids: ['wild-harness'], isModelRouter: false },
      modelFamilyMetadata: { entries: [{ key: 'Effort', value: { order: 2, name: 'Medium' } }] } },
    { modelUid: 'router-n', label: 'Router N', modelInfo: { harnessUids: ['r'], isModelRouter: true } },
    { modelUid: 'disabled-n', label: 'Disabled N', disabled: true, modelInfo: { harnessUids: ['d'], isModelRouter: false } },
  ];
  const roles = discoverOfficialRoles(collectNativeModels({ clientModelConfigs: natives }, { rpc: 'GetCliModelConfigs', format: { json: true } }));
  assert.deepEqual(roles.eligibleNativeLeads.get('wild-n')?.leadHarnessUids, ['fusion', 'wild-harness'],
    'derived lead harness prefixes fusion to the model harnesses');
  assert.equal(roles.eligibleNativeLeads.get('wild-n')?.effortDimension?.name, 'Medium');
  assert.equal(roles.eligibleNativeSidekicks.get('wild-n')?.label, 'Wild N');
  assert.deepEqual(roles.eligibleNativeSidekicks.get('wild-n')?.harnessUids, ['wild-harness']);
  assert.deepEqual(roles.eligibleNativeLeads.get('lead-n')?.leadHarnessUids, ['fusion'],
    'officially paired leads keep their official harness');
  assert.ok(!roles.eligibleNativeLeads.has('router-n'), 'model routers are excluded');
  assert.ok(!roles.eligibleNativeLeads.has('disabled-n'), 'disabled natives are excluded');
  assert.ok(!roles.eligibleNativeLeads.has('fusion-lead-n-sidekick-side-n'), 'fusion uids are excluded');
});

test('a dmp slot with non-official native pair resolves through derived harnesses', () => {
  const natives = [
    ...NATIVES,
    { modelUid: 'wild-lead', label: 'Wild Lead', modelInfo: { harnessUids: ['wl-harness'], isModelRouter: false } },
    { modelUid: 'wild-side', label: 'Wild Side', modelInfo: { harnessUids: ['ws-harness'], isModelRouter: false } },
  ];
  const seen = collectNativeModels({ clientModelConfigs: natives }, { rpc: 'GetCliModelConfigs', format: { json: true } });
  const config = { providers: providers(),
    fusionSlots: { a: { lead: { kind: 'native', uid: 'wild-lead' }, sidekick: { kind: 'native', uid: 'wild-side' } } } };
  const catalog = buildCatalog(config, seen);
  const fusion = catalog.fusions['fusion-dmp-a'];
  assert.ok(fusion, 'non-official pair resolves through the dmp slot');
  assert.equal(fusion.leadNative, true);
  assert.deepEqual(fusion.leadHarnessUids, ['fusion', 'wl-harness']);
  assert.equal(fusion.sidekickNative, true);
  assert.deepEqual(fusion.sidekickHarnessUids, ['ws-harness']);
  const leadHit = resolveAssignment({ modelRouterUid: 'fusion-dmp-a' }, { json: true }, catalog);
  assert.equal(leadHit.assignment.modelUid, 'wild-lead');
  assert.deepEqual(leadHit.assignment.harnessUids, ['fusion', 'wl-harness']);
  const sideHit = resolveAssignment({ modelRouterUid: 'fusion-dmp-a', fusionLeadRouterUid: 'fusion-dmp-a' }, { json: true }, catalog);
  assert.equal(sideHit.assignment.modelUid, 'wild-side');
  assert.deepEqual(sideHit.assignment.harnessUids, ['ws-harness']);
});

test('real proto bytes: every routable native becomes a fusion candidate', () => {
  const entries = JSON.parse(fs.readFileSync(require('path').resolve(__dirname, 'fixtures/real-proto-entries.json'), 'utf8'));
  const list = Buffer.concat(entries.map(b64 => m(1, Buffer.from(b64, 'base64'))));
  const seen = collectNativeModels(list, { rpc: '/x/GetCliModelConfigs' });
  const roles = discoverOfficialRoles(seen);
  const leads = roles.eligibleNativeLeads;
  for (const uid of ['swe-2-flash-medium', 'glm-5-3-high', 'gemini-3-8-flash-medium', 'kimi-k3-1-pro-max',
    'claude-opus-5-5-medium-fast']) {
    assert.ok(leads.has(uid), uid + ' is an eligible lead');
    const harness = leads.get(uid).leadHarnessUids;
    assert.equal(harness[0], 'fusion', uid + ' lead harness is fusion-prefixed');
  }
  assert.deepEqual(leads.get('claude-opus-5-5-medium').leadHarnessUids, ['fusion', 'strawberry-pancake'],
    'the official Opus lead keeps its observed harness');
  for (const uid of ['glm-5-3-high', 'kimi-k3-1-pro-max']) {
    assert.ok(roles.eligibleNativeSidekicks.has(uid), uid + ' is an eligible sidekick');
  }
  assert.ok(!leads.has('adaptive'), 'router natives are excluded');
  assert.ok(![...leads.keys()].some(uid => uid.startsWith('fusion-')), 'fusion uids are excluded');
});
