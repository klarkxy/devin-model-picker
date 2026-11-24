'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const picker = require('../media/picker.js');

function el(tag) {
  const attrs = Object.create(null);
  const children = [];
  const node = {
    tagName: String(tag).toUpperCase(),
    children,
    style: {},
    parentElement: null,
    setAttribute(name, value) { attrs[name] = value == null ? '' : String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    appendChild(child) { children.push(child); child.parentElement = node; return child; },
    addEventListener() {},
    querySelector(sel) {
      const match = item => sel === '[data-label]' && item.hasAttribute('data-label');
      const walk = item => {
        for (const child of item.children || []) {
          if (match(child)) return child;
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(node);
    },
  };
  let text = '';
  Object.defineProperty(node, 'textContent', {
    get() { return children.length ? children.map(child => child.textContent).join('') : text; },
    set(value) { text = String(value); },
  });
  return node;
}

function loadFixture() {
  const sandbox = {
    console,
    Response,
    setTimeout,
    clearTimeout,
    document: {
      getElementById: () => ({ textContent: '' }),
      createElement: tag => el(tag),
      body: { appendChild() {} },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../dev/fixture.js'), 'utf8'), sandbox);
  return sandbox;
}

test('fixture native sidekicks expose officialLeads for official pair tags', () => {
  const { DMP_FIXTURE } = loadFixture();
  const sidekicks = DMP_FIXTURE.state.fusionCandidates.sidekicks;
  const sweHigh = sidekicks.find(item => item.ref.kind === 'native' && item.ref.uid === 'swe-2-high');
  const sweMax = sidekicks.find(item => item.ref.kind === 'native' && item.ref.uid === 'swe-2-max');
  assert.ok(sweHigh, 'swe-2-high is a sidekick candidate');
  assert.deepEqual([...sweHigh.officialLeads], ['claude-opus-5-5-high', 'claude-opus-5-5-medium']);
  assert.equal(picker.pairingTag({ kind: 'native', uid: 'claude-opus-5-5-high' }, sweHigh), 'official');
  assert.equal(picker.pairingTag({ kind: 'native', uid: 'claude-opus-5-5-medium' }, sweHigh), 'official');
  assert.equal(picker.pairingTag({ kind: 'native', uid: 'claude-opus-5-5-high' }, sweMax), 'unofficial',
    'swe-2-max has no official leads');
});

test('fixture official fusion entries carry familyUid fusion so the trigger can show the pair', () => {
  const { DMP_FIXTURE } = loadFixture();
  const pairA = DMP_FIXTURE.visibleModelConfigs.find(item =>
    item.modelUid === 'fusion-claude-opus-5-5-high-sidekick-swe-2-high');
  const pairB = DMP_FIXTURE.visibleModelConfigs.find(item =>
    item.modelUid === 'fusion-claude-opus-5-5-medium-sidekick-swe-2-high');
  assert.equal(pairA.familyUid, 'fusion');
  assert.equal(pairA.familyLabel, 'Fusion');
  assert.equal(picker.fusionPairLabel(pairA), 'Claude Opus 5.5 High + SWE-2 High');
  assert.equal(picker.fusionPairLabel(pairB), 'Claude Opus 5.5 Medium + SWE-2 High');
});

test('fixture onModelSelect updates selectedModels and value so trigger rewrite can run', () => {
  const sandbox = loadFixture();
  const { button, hostProps, pickerProps } = sandbox.DMP_FIBER({
    visibleModelConfigs: sandbox.DMP_FIXTURE.visibleModelConfigs,
  });
  const uid = 'fusion-claude-opus-5-5-high-sidekick-swe-2-high';
  hostProps.onModelSelect({ modelUid: uid });
  assert.deepEqual([...hostProps.selectedModels], [uid]);
  assert.equal(pickerProps.value, uid);
  assert.equal(button.querySelector('[data-label]').textContent, 'Fusion',
    'official fusion routers still render familyLabel; the picker rewrites the pair');
  const located = { root: pickerProps, host: hostProps };
  assert.equal(picker.triggerPairText(located, hostProps), 'Claude Opus 5.5 High + SWE-2 High');

  const uidB = 'fusion-claude-opus-5-5-medium-sidekick-swe-2-high';
  hostProps.onModelSelect({ modelUid: uidB });
  assert.deepEqual([...hostProps.selectedModels], [uidB]);
  assert.equal(pickerProps.value, uidB);
  assert.equal(picker.triggerPairText(located, hostProps), 'Claude Opus 5.5 Medium + SWE-2 High');
});

test('fixture /picker/fusion returns the official router uid for an official pair', async () => {
  const sandbox = loadFixture();
  const res = await sandbox.fetch('http://127.0.0.1:39852/picker/fusion', {
    method: 'POST',
    body: JSON.stringify({
      lead: { kind: 'native', uid: 'claude-opus-5-5-high' },
      sidekick: { kind: 'native', uid: 'swe-2-high' },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.uid, 'fusion-claude-opus-5-5-high-sidekick-swe-2-high');

  const unofficial = await sandbox.fetch('http://127.0.0.1:39852/picker/fusion', {
    method: 'POST',
    body: JSON.stringify({
      lead: { kind: 'native', uid: 'claude-opus-5-5-high' },
      sidekick: { kind: 'native', uid: 'swe-2-max' },
    }),
  });
  const unofficialBody = await unofficial.json();
  assert.match(unofficialBody.uid, /^fusion-dmp-[ab]$/,
    'pairs without an official router still land on a dmp slot');
});
