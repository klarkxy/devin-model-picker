'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeReleaseWatch, RELEASE_GRACE_MS } = require('../src/runtime/native-models.cjs');

function harness({ graceMs = 1000 } = {}) {
  let clock = 10000;
  const watch = createNativeReleaseWatch({ graceMs, now: () => clock });
  return { watch, advance: ms => { clock += ms; }, at: ms => { clock = ms; } };
}

const entry = (uid, harnesses = ['h']) => ({ uid, label: uid, harnessUids: harnesses });

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

test('harnessless internal entries never count as a release', () => {
  const h = harness();
  h.advance(1001);
  assert.deepEqual(h.watch.observe([entry('swe-check', []), { uid: 'broken' }, null, { harnessUids: ['h'] }]), []);
  assert.deepEqual(h.watch.observe([entry('real', ['swe-1p6'])]), ['real']);
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
