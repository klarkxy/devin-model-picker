'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dev = require('../src/models-dev.cjs');

const entry = (over = {}) => ({ id: 'm', name: 'X', reasoning: true, tool_call: true,
  modalities: { input: ['text', 'image'] }, limit: { context: 200000, output: 64000 }, ...over });

test('normalizeId takes the leaf, lowercases and folds dot/underscore separators', () => {
  assert.equal(dev.normalizeId('Anthropic/Claude_Opus.4_5'), 'claude-opus-4-5');
  assert.equal(dev.normalizeId('openai/gpt-5.1'), 'gpt-5-1');
});

test('buildIndex prefers canonical self-references then first-party order, skips non-chat types', () => {
  const index = dev.buildIndex({
    thirdparty: { id: 'thirdparty', models: { m: { id: 'm', name: 'third', limit: { context: 1 } } } },
    openai: { id: 'openai', models: { m: { id: 'm', name: 'first-party', limit: { context: 2 } } } },
  });
  assert.equal(index.get('m').name, 'first-party');
  const canonical = dev.buildIndex({
    openai: { id: 'openai', models: { m: { id: 'm', name: 'fp', limit: {} } } },
    other: { id: 'other', models: { m: { id: 'm', name: 'canon', limit: {}, canonical_model_id: 'other/m' } } },
  });
  assert.equal(canonical.get('m').name, 'canon');
  const typed = dev.buildIndex({ p: { id: 'p', models: {
    emb: { id: 'emb', type: 'embedding' }, chat: { id: 'chat', type: 'language' } } } });
  assert.equal(typed.has('emb'), false);
  assert.equal(typed.has('chat'), true);
});

test('lookup retries after stripping date suffixes and -latest', () => {
  const index = dev.buildIndex({ p: { id: 'p', models: { 'claude-x': entry({ id: 'claude-x' }) } } });
  assert.equal(dev.lookup(index, 'claude-x-20250101').providerId, 'p');
  assert.equal(dev.lookup(index, 'claude-x-2025-01-01').providerId, 'p');
  assert.equal(dev.lookup(index, 'claude-x-latest').providerId, 'p');
  assert.equal(dev.lookup(index, 'unrelated-20250101'), null);
});

test('mergeMetadata: /models item overrides models.dev which overrides defaults', () => {
  const index = dev.buildIndex({ p: { id: 'p', models: { m: entry({ family: 'fam' }) } } });
  const merged = dev.mergeMetadata('m', {}, index.get('m'));
  assert.equal(merged.label, 'X');
  assert.equal(merged.contextWindow, 200000);
  assert.equal(merged.maxOutputTokens, 64000);
  assert.equal(merged.supportsImages, true);
  assert.equal(merged.meta.family, 'fam');
  assert.equal(merged.meta.source, 'models.dev');
  const v1 = dev.mergeMetadata('m', { display_name: 'Pretty', context_length: 500000, max_output_tokens: 999999999 }, index.get('m'));
  assert.equal(v1.label, 'Pretty');
  assert.equal(v1.contextWindow, 500000);
  assert.equal(v1.maxOutputTokens, 500000, 'output clamped to context');
  assert.equal(v1.meta.source, 'v1');
  const bare = dev.mergeMetadata('never-heard-of-it', null, null);
  assert.equal(bare.contextWindow, 272000);
  assert.equal(bare.maxOutputTokens, 131072);
  assert.equal(bare.supportsImages, true);
  assert.equal(bare.meta.source, 'default');
});

test('efforts derive from reasoning_options effort values; /models arrays win', () => {
  const index = dev.buildIndex({ p: { id: 'p', models: { m: entry({
    reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] }) } } });
  assert.deepEqual(dev.mergeMetadata('m', {}, index.get('m')).efforts, [null, 'low', 'high']);
  const v1 = dev.mergeMetadata('m', { supported_reasoning_efforts: ['minimal', 'bogus!!', 'high'] }, index.get('m'));
  assert.deepEqual(v1.efforts, [null, 'low', 'high'], 'invalid entries invalidate the v1 array, models.dev wins');
  const clean = dev.mergeMetadata('m', { supported_reasoning_efforts: ['minimal', 'high'] }, index.get('m'));
  assert.deepEqual(clean.efforts, [null, 'minimal', 'high']);
});

test('loadIndex caches 24h and falls back to stale cache on fetch failure', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-modelsdev-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'models-dev.json');
  let now = 1000, calls = 0;
  const payload = { p: { id: 'p', models: { m: entry() } } };
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => payload }; };
  const clock = () => now;
  const first = await dev.loadIndex({ file, fetchImpl, now: clock });
  assert.equal(calls, 1); assert.ok(first.index.get('m'));
  const second = await dev.loadIndex({ file, fetchImpl, now: clock });
  assert.equal(calls, 1, 'served from fresh cache');
  now += dev.TTL_MS + 1;
  await dev.loadIndex({ file, fetchImpl, now: clock });
  assert.equal(calls, 2, 'refreshed after TTL');
  now += dev.TTL_MS + 1;
  const failing = async () => { throw new Error('offline'); };
  const stale = await dev.loadIndex({ file, fetchImpl: failing, now: clock });
  assert.equal(stale.stale, true);
  assert.ok(stale.index.get('m'), 'stale cache used when fetch fails');
  const empty = await dev.loadIndex({ file: path.join(root, 'none.json'), fetchImpl: failing, now: clock });
  assert.equal(empty.index, null, 'no cache at all yields no index');
});
