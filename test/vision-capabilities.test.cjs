'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelSupportsImages } = require('../src/model-capabilities.cjs');
const { buildCatalog, resolveAssignment, collectNativeModels } = require('../src/catalog.cjs');
const { parseChat } = require('../src/protocol/chat.cjs');
const { buildRequestBody } = require('../src/protocol/responses.cjs');
const { fields, num } = require('../src/protocol/wire.cjs');

test('imported models advertise image support by default, including stored false overrides on unknown ids', () => {
  for (const id of ['gpt-6-astra', 'cpa/gpt-6-astra', 'gpt-4o', 'unknown-deployment']) {
    assert.equal(modelSupportsImages({ id }), true, id);
  }
  assert.equal(modelSupportsImages({ id: 'unknown-deployment', supportsImages: false }), false, 'explicit false is honored');
  assert.equal(modelSupportsImages({ id: 'unknown-deployment', supportsImages: true }), true);
});

test('plain models and fusion entries advertise images in protobuf and JSON', () => {
  const catalog = buildCatalog({ providers: [{ id: 'load', models: [{ id: 'gpt-6-astra' }] }] });
  for (const model of catalog.models) {
    assert.equal(model.json.supportsImages, true, model.uid);
    assert.equal(model.json.modelInfo.modelFeatures.supportsImages, true, model.uid);
    assert.equal(num(model.raw, 5), 1, model.uid);
    const info = fields(model.raw, 23)[0].value;
    assert.equal(num(fields(info, 6)[0].value, 11), 1, model.uid);
  }
  const disabled = buildCatalog({ providers: [{ id: 'load', models: [{ id: 'gpt-6-astra', supportsImages: false }] }] });
  for (const model of disabled.models.filter(m => m.kind === 'model')) {
    assert.equal(model.json.supportsImages, false, model.uid);
  }
});

test('native JSON image blocks survive both Fusion assignments and both provider protocols', () => {
  const image = { base64Data: Buffer.from('image-fixture-bytes').toString('base64'), mimeType: 'image/png', caption: '' };
  const natives = collectNativeModels({ clientModelConfigs: [
    { modelUid: 'side-n', label: 'Side N', modelInfo: { harnessUids: ['swe-1p6'], isModelRouter: false } },
    { modelUid: 'lead-n', label: 'Lead N', modelInfo: { harnessUids: ['swe-1p5'], isModelRouter: false } },
    { modelUid: 'fusion-lead-n-sidekick-side-n', label: 'F', modelInfo: { harnessUids: ['fusion'], isModelRouter: true },
      modelFamilyMetadata: { entries: [{ key: 'Sidekick', value: { order: 1, name: 'Side N' } }] } },
  ] }, { rpc: 'GetCliModelConfigs', format: { json: true } });
  const base = buildCatalog({ providers: [{ id: 'load', models: [{ id: 'gpt-6-astra' }, { id: 'swe-2-high' }] }] }, natives);
  const lead = Object.values(base.routes).find(r => r.model === 'gpt-6-astra' && r.effort === null).uid;
  const sidekick = Object.values(base.routes).find(r => r.model === 'swe-2-high' && r.effort === null).uid;
  const catalog = buildCatalog({ providers: [{ id: 'load', models: [{ id: 'gpt-6-astra' }, { id: 'swe-2-high' }] }],
    fusionSlots: { a: { lead: { kind: 'byok', uid: lead }, sidekick: { kind: 'byok', uid: sidekick } } } }, natives);
  for (const side of [false, true]) {
    const uid = resolveAssignment({ modelRouterUid: 'fusion-dmp-a', ...(side ? { fusionLeadRouterUid: 'fusion-dmp-a' } : {}) }, { json: true }, catalog).assignment.modelUid;
    const request = parseChat({ modelUid: uid, messages: [{ role: 'user', content: 'Read the image', images: [image] }] });
    for (const apiFormat of ['openai-responses', 'openai']) {
      const body = buildRequestBody(request, catalog.routes[uid], { apiFormat });
      const messages = body.input || body.messages;
      const block = messages.find(m => m.role === 'user').content.find(c => /image/.test(c.type));
      assert.equal(apiFormat === 'openai' ? block.image_url.url : block.image_url, 'data:image/png;base64,' + image.base64Data);
      assert.equal(body.model, side ? 'swe-2-high' : 'gpt-6-astra');
    }
  }
});
