'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeReleaseWatch, nativeSetSignature, RELEASE_GRACE_MS } = require('../src/runtime/native-models.cjs');

function harness({ graceMs = 1000 } = {}) {
  let clock = 10000;
  const watch = createNativeReleaseWatch({ graceMs, now: () => clock });
  return { watch, advance: ms => { clock += ms; }, at: ms => { clock = ms; } };
}

const entry = (uid, harnesses = ['h']) => ({ uid, label: uid, disabled: false, isModelRouter: false, harnessUids: harnesses });

test('startup population during the grace window only builds the baseline', () => {
  const h = harness();
  assert.deepEqual(h.watch.observe([entry('a'), entry('b')]), []);
  h.advance(999);
  assert.deepEqual(h.watch.observe([entry('c')]), [], 'still inside the grace window');
  h.advance(2);
  assert.deepEqual(h.watch.observe([entry('a'), entry('b'), entry('c')]), [],
    'absorbed uids never fire after the grace window either');
});

test('brand-new harnessed uids after the grace window are reported exactly once', () => {
  const h = harness();
  h.watch.observe([entry('a')]);
  h.advance(1001);
  assert.deepEqual(h.watch.observe([entry('a'), entry('swe-2-1'), entry('swe-2-1-max')]), ['swe-2-1', 'swe-2-1-max']);
  assert.deepEqual(h.watch.observe([entry('a'), entry('swe-2-1'), entry('swe-2-1-max')]), [],
    'a repeated observation does not fire again');
});

test('the first harnessed fill is absorbed whenever it arrives, even after the grace window', () => {
  const h = harness();
  h.watch.observe([]);
  h.advance(5 * 60 * 1000);
  assert.deepEqual(h.watch.observe([entry('cli-1'), entry('cli-2')]), [],
    'the late CLI-side first fill is startup population, not a release');
  assert.deepEqual(h.watch.observe([entry('cli-1'), entry('cli-2'), entry('new-release')]), ['new-release'],
    'only uids arriving after the first fill fire');
});

test('harnessless internal entries never count as a release', () => {
  const h = harness();
  h.watch.observe([entry('a')]);
  h.advance(1001);
  assert.deepEqual(h.watch.observe([entry('swe-check', []), { uid: 'broken' }, null, { harnessUids: ['h'] }]), []);
  assert.deepEqual(h.watch.observe([entry('real', ['swe-1p6'])]), ['real']);
});

test('model-router and disabled entries never count as a release', () => {
  const h = harness();
  h.watch.observe([entry('a')]);
  h.advance(1001);
  const router = { ...entry('swe-2-router'), isModelRouter: true };
  const disabled = { ...entry('swe-9-gated'), disabled: true };
  assert.deepEqual(h.watch.observe([entry('a'), router, disabled]), [],
    'derived routers and gated models need no CLI session refresh');
  assert.deepEqual(h.watch.observe([entry('a'), router, disabled, entry('real')]), ['real']);
});

test('a model released disabled then enabled later does fire on unlock', () => {
  const h = harness();
  h.watch.observe([entry('a')]);
  h.advance(1001);
  assert.deepEqual(h.watch.observe([entry('a'), { ...entry('gated'), disabled: true }]), [],
    'the grayed-out gray release is not a usable release');
  assert.deepEqual(h.watch.observe([entry('a'), { ...entry('gated'), disabled: false }]), ['gated'],
    'unlocking it for this account is the moment a fresh CLI session is actually needed');
});

test('backend-restart regrowth and server re-adds do not fire', () => {
  const h = harness();
  h.watch.observe([entry('a'), entry('b')]);
  h.advance(1001);
  assert.deepEqual(h.watch.observe([]), [], 'the shrunken set is not a release');
  assert.deepEqual(h.watch.observe([entry('a'), entry('b')]), [],
    'regrowth back to the high-water set is not new');
  assert.deepEqual(h.watch.observe([entry('a'), entry('b'), entry('c')]), ['c'],
    'only genuinely new uids fire');
});

test('a release during the grace window is absorbed instead of firing', () => {
  const h = harness();
  h.watch.observe([entry('a')]);
  h.advance(500);
  assert.deepEqual(h.watch.observe([entry('a'), entry('early')]), []);
  h.advance(501);
  assert.deepEqual(h.watch.observe([entry('a'), entry('early')]), [],
    'uids absorbed during grace never fire later');
});

test('the default grace window is exported and positive', () => {
  assert.ok(Number.isSafeInteger(RELEASE_GRACE_MS) && RELEASE_GRACE_MS >= 60000);
  const watch = createNativeReleaseWatch();
  assert.deepEqual(watch.observe([entry('a')]), [], 'default clock starts inside the grace window');
});

test('nativeSetSignature accepts arrays and materializes any iterable such as Map.values()', () => {
  const entries = [entry('a'), { ...entry('b'), label: 'Bee' }];
  assert.equal(nativeSetSignature(entries), nativeSetSignature(new Map(entries.map(e => [e.uid, e])).values()),
    'a Map iterator must produce the same signature as the array');
  assert.notEqual(nativeSetSignature(new Map(entries.map(e => [e.uid, e])).values()), '',
    'an iterator must never collapse to the empty signature');
  const renamed = entries.map(e => e.uid === 'b' ? { ...e, label: 'Renamed' } : e);
  assert.notEqual(nativeSetSignature(entries), nativeSetSignature(renamed), 'label changes move the signature');
  assert.equal(nativeSetSignature(undefined), '');
});
