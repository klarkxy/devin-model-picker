'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { importLegacy, discover } = require('../src/config.cjs');

test('importLegacy assigns the 131072-token output default without reading the real home directory', t => {
  const home = path.join(os.tmpdir(), 'dmp-import-legacy-fixture');
  const reads = [];
  t.mock.method(os, 'homedir', () => home);
  t.mock.method(fs, 'readFileSync', file => {
    reads.push(file);
    return JSON.stringify({ providers: [{ id: 'legacy', name: 'Legacy', baseUrl: 'https://legacy.invalid/v1/', apiKey: 'fixture-secret',
      type: 'openai', models: [{ id: 'legacy-model', name: 'Legacy Model', effortLevels: ['high'] }] }] });
  });
  const imported = importLegacy();
  assert.deepEqual(reads, [path.join(home, '.cwindsurf/providers.json')]);
  assert.equal(imported.providers[0].models[0].maxOutputTokens, 131072);
  assert.equal(imported.providers[0].models[0].contextWindow, 272000);
  assert.ok(!JSON.stringify(imported.providers[0].models[0]).includes('fixture-secret'));
});

test('importLegacy falls back to an empty provider list when the legacy file is unreadable', t => {
  t.mock.method(os, 'homedir', () => path.join(os.tmpdir(), 'dmp-missing-home'));
  t.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
  assert.deepEqual(importLegacy().providers, []);
});

test('discover returns the raw /models items for the caller to merge with models.dev', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.Authorization });
    return { ok: true, json: async () => ({ data: [{ id: 'brand-new', context_length: 1000 }, { id: 'kept-model' }] }) };
  });
  const provider = { id: 'p', name: 'Provider', baseUrl: 'https://provider.invalid/v1/', apiKey: 'fixture-secret',
    models: [{ id: 'kept-model', label: 'Saved' }] };
  const items = await discover(provider);
  assert.deepEqual(items, [{ id: 'brand-new', context_length: 1000 }, { id: 'kept-model' }]);
  assert.deepEqual(requests, [{ url: 'https://provider.invalid/v1/models', authorization: 'Bearer fixture-secret' }]);
  assert.deepEqual(provider.models, [{ id: 'kept-model', label: 'Saved' }], 'discover must not mutate the provider');
});
