'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const picker = require('../media/picker.js');

test('picker.js exports pure helpers under node', () => {
  for (const key of ['cardName', 'effortLabel', 'filterNorm', 'groupCards', 'groupFusion', 'prefillFusion', 'defaultVariant']) {
    assert.equal(typeof picker[key], 'function', key);
  }
});

test('cardName splits name/version/variant per the naming table', () => {
  const table = [
    ['Claude Opus 5.5', ['Opus', '5.5', '']],
    ['GPT-6.1 Terra', ['Terra', '6.1', '']],
    ['Gemini 4 Argon', ['Argon', '4', '']],
    ['Gemini 3.8 Flash', ['Gemini', '3.8', 'Flash']],
    ['DeepSeek V4.1 Flash', ['DeepSeek', '4.1', 'Flash']],
    ['DeepSeek-V4-Pro', ['DeepSeek', '4', 'Pro']],
    ['Kimi K3', ['Kimi', '3', '']],
    ['GLM-5.3', ['GLM', '5.3', '']],
    ['Grok 4.7', ['Grok', '4.7', '']],
    ['SWE-2 Flash', ['SWE', '2', 'Flash']],
    ['Nemotron 3.5 Lightning', ['Nemotron', '3.5', 'Lightning']],
    ['Muse Wonder', ['Muse', '', 'Wonder']],
    ['klarkxy/claude-opus-5-5', ['Opus', '5.5', '']],
    ['deepseek-v4-pro', ['DeepSeek', '4', 'Pro']],
    ['o3-mini', ['o3', '', 'Mini']],
    ['GPT-5.5', ['GPT', '5.5', '']],
  ];
  for (const [label, [name, version, variant]] of table) {
    assert.deepEqual(picker.cardName(label), { name, version, variant }, label);
  }
});

test('effortLabel compacts known effort words only, unknown words unchanged', () => {
  const table = { none: 'Off', off: 'Off', minimal: 'Min', low: 'L', medium: 'M',
    high: 'H', xhigh: 'xH', max: 'Max', ultra: 'U' };
  for (const [input, expected] of Object.entries(table)) assert.equal(picker.effortLabel(input), expected, input);
  assert.equal(picker.effortLabel('Flash'), 'Flash');
  assert.equal(picker.effortLabel('Lightning'), 'Lightning');
  assert.equal(picker.effortLabel('Argon'), 'Argon');
  assert.equal(picker.effortLabel(null), '');
});

test('groupCards filters router/fusion entries, groups by family and merges providers', () => {
  const models = [
    { modelUid: 'dmp-p-claude-a', familyUid: 'dmp-family-magpie-claude', label: 'Magpie · Claude Opus 5.5', provider: undefined },
    { modelUid: 'dmp-p-claude-b', familyUid: 'dmp-family-magpie-claude', label: 'Magpie · Claude Opus 5.5 High', familyMetadata: { Effort: { order: 3, name: 'High' } } },
    { modelUid: 'dmp-r-claude-a', familyUid: 'dmp-family-relay-claude', label: 'Relay · Claude Opus 5.5' },
    { modelUid: 'dmp-r-claude-b', familyUid: 'dmp-family-relay-claude', label: 'Relay · Claude Opus 5.5 Max', familyMetadata: { Effort: { order: 5, name: 'Max' } } },
    { modelUid: 'native-opus', familyUid: 'native-fam-opus', label: 'Claude Opus 5.5', provider: 'anthropic', modelCost: { type: 'free' } },
    { modelUid: 'fusion-official-sidekick-x', label: 'F', displayOption: 'model-router' },
    { modelUid: 'hidden-m', label: 'Hidden', displayOption: 'invisible' },
    { modelUid: 'leady', label: 'Leady', familyMetadata: { Lead: { order: 1, name: 'X' } } },
    { modelUid: 'swe-2-high', familyUid: 'fam-swe2', familyLabel: 'SWE-2', label: 'SWE-2 High', provider: 'windsurf', familyMetadata: { Effort: { order: 3, name: 'High' } } },
    { modelUid: 'swe-2-max', familyUid: 'fam-swe2', familyLabel: 'SWE-2', label: 'SWE-2 Max', provider: 'windsurf', isDefaultModelInFamily: true, familyMetadata: { Effort: { order: 5, name: 'Max' } } },
  ];
  const state = { byok: {
    'dmp-p-claude-a': { providerId: 'p', providerName: 'Magpie', modelId: 'claude-opus-5-5', label: 'Magpie · Claude Opus 5.5', effort: null },
    'dmp-p-claude-b': { providerId: 'p', providerName: 'Magpie', modelId: 'claude-opus-5-5', label: 'Magpie · Claude Opus 5.5 High', effort: 'high' },
    'dmp-r-claude-a': { providerId: 'r', providerName: 'Relay', modelId: 'claude-opus-5-5', label: 'Relay · Claude Opus 5.5', effort: null },
    'dmp-r-claude-b': { providerId: 'r', providerName: 'Relay', modelId: 'claude-opus-5-5', label: 'Relay · Claude Opus 5.5 Max', effort: 'max' },
  } };
  const cards = picker.groupCards(models, state);
  const opus = cards.find(card => card.name === 'Opus');
  assert.ok(opus, 'BYOK and native families with the same cardName merge into one card');
  assert.equal(opus.version, '5.5');
  assert.deepEqual(opus.families.map(family => family.providerName).sort(), ['Devin', 'Magpie', 'Relay'],
    'same modelId across two BYOK providers stays two families');
  const magpie = opus.families.find(family => family.providerName === 'Magpie');
  assert.deepEqual(magpie.cells.map(cell => cell.label), ['H']);
  const relay = opus.families.find(family => family.providerName === 'Relay');
  assert.deepEqual(relay.cells.map(cell => cell.label), ['Max'],
    'each provider keeps its own effort cells');
  assert.equal(picker.defaultVariant(magpie).uid, 'dmp-p-claude-a', 'null-effort BYOK variant is the default');
  assert.equal(picker.defaultVariant(relay).uid, 'dmp-r-claude-a');
  const swe = cards.find(card => card.name === 'SWE');
  const sweFamily = swe.families[0];
  assert.deepEqual(sweFamily.cells.map(cell => cell.label), ['H', 'Max'], 'cells ordered by effort order');
  assert.equal(picker.defaultVariant(sweFamily).uid, 'swe-2-max', 'isDefaultModelInFamily fallback');
  assert.ok(!cards.some(card => card.name === 'Leady' || card.name === 'Hidden'), 'routers/invisible/Lead-dimension entries excluded');
});

test('groupFusion keeps BYOK effort variants in one family card', () => {
  const candidates = [
    { ref: { kind: 'byok', uid: 'dmp-p-x-1' }, label: 'Claude Opus 5.5', providerName: 'Magpie', effort: null, familyKey: 'byok:p:claude-opus-5-5' },
    { ref: { kind: 'byok', uid: 'dmp-p-x-2' }, label: 'Claude Opus 5.5 High', providerName: 'Magpie', effort: 'high', familyKey: 'byok:p:claude-opus-5-5' },
    { ref: { kind: 'native', uid: 'swe-2-high' }, label: 'SWE-2 High', providerName: 'Devin', effort: null, familyKey: 'fam-swe2' },
  ];
  const natives = new Map([['swe-2-high', { modelUid: 'swe-2-high', familyUid: 'fam-swe2', familyLabel: 'SWE-2', familyMetadata: { Effort: { order: 3, name: 'High' } } }]]);
  const cards = picker.groupFusion(candidates, natives);
  const opus = cards.find(card => card.cardKey.includes('byok:p:claude-opus-5-5'));
  assert.equal(opus.variants.length, 2);
  assert.deepEqual(opus.cells.map(cell => cell.label), ['H']);
  const swe = cards.find(card => card.providerName === 'Devin');
  assert.equal(swe.name, 'SWE');
  assert.deepEqual(swe.cells.map(cell => cell.label), ['H'], 'native effort name comes from familyMetadata');
});

test('prefillFusion parses dmp slots and official fusion uids', () => {
  const state = { fusionSlots: { a: { lead: { kind: 'byok', uid: 'dmp-1' }, sidekick: { kind: 'native', uid: 'swe-2-high' } } } };
  const candidates = { leads: [{ ref: { kind: 'native', uid: 'claude-opus-5-5-high' } }],
    sidekicks: [{ ref: { kind: 'native', uid: 'swe-2-high' } }] };
  const slot = picker.prefillFusion('fusion-dmp-a', state, candidates);
  assert.equal(slot.startedInFusion, true);
  assert.deepEqual(slot.lead, { kind: 'byok', uid: 'dmp-1' });
  const official = picker.prefillFusion('fusion-claude-opus-5-5-high-sidekick-swe-2-high', state, candidates);
  assert.deepEqual(official.lead, { kind: 'native', uid: 'claude-opus-5-5-high' });
  assert.deepEqual(official.sidekick, { kind: 'native', uid: 'swe-2-high' });
  const missing = picker.prefillFusion('fusion-missing-sidekick-swe-2-high', state, candidates);
  assert.equal(missing.lead, null);
  assert.deepEqual(missing.sidekick, { kind: 'native', uid: 'swe-2-high' });
  assert.equal(picker.prefillFusion('swe-2-high', state, candidates).startedInFusion, false);
});

test('filterNorm ignores case, dashes, dots and spaces so gpt5 finds GPT-5', () => {
  assert.equal(picker.filterNorm('GPT-5.5'), 'gpt55');
  assert.equal(picker.filterMatch('gpt5', ['GPT-5.5']), true);
  assert.equal(picker.filterMatch('opus', ['Claude Opus 5.5']), true);
  assert.equal(picker.filterMatch('', ['anything']), true);
  assert.equal(picker.filterMatch('zzz', ['Claude Opus 5.5']), false);
});

test('underlyingKey groups BYOK effort variants but keys natives per uid', () => {
  const candidates = { leads: [{ ref: { kind: 'byok', uid: 'dmp-x-1' }, familyKey: 'byok:p:m' }],
    sidekicks: [{ ref: { kind: 'byok', uid: 'dmp-x-2' }, familyKey: 'byok:p:m' }] };
  assert.equal(picker.underlyingKey({ kind: 'byok', uid: 'dmp-x-1' }, candidates),
    picker.underlyingKey({ kind: 'byok', uid: 'dmp-x-2' }, candidates));
  assert.notEqual(picker.underlyingKey({ kind: 'native', uid: 'a' }, candidates),
    picker.underlyingKey({ kind: 'native', uid: 'b' }, candidates));
  const twoProviders = { leads: [{ ref: { kind: 'byok', uid: 'dmp-p-1' }, familyKey: 'byok:p:m' }],
    sidekicks: [{ ref: { kind: 'byok', uid: 'dmp-r-1' }, familyKey: 'byok:r:m' }] };
  assert.notEqual(picker.underlyingKey({ kind: 'byok', uid: 'dmp-p-1' }, twoProviders),
    picker.underlyingKey({ kind: 'byok', uid: 'dmp-r-1' }, twoProviders),
    'same modelId under different providers is NOT the same underlying model');
});

test('groupCards aggregates real Devin families: deduped cells + toggle switches', () => {
  const models = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/real-vmc.json'), 'utf8'));
  const cards = picker.groupCards(models, { byok: {} });
  const familyOf = key => cards.find(card => card.cardKey === key)?.families[0];

  const opus = familyOf('opus|5.5|');
  assert.deepEqual(opus.cells.map(cell => cell.label), ['L', 'M', 'H', 'xH', 'Max'],
    'one cell per effort order, not per Fast variant');
  assert.deepEqual(opus.toggles, ['Fast Mode'],
    'Thinking/1M Context stay hidden because they do not vary');
  assert.equal(opus.familyLabel, 'Claude Opus 5.5');
  assert.equal(picker.matchVariant(opus, 1, { 'Fast Mode': 1 }).uid, 'claude-opus-5-5-medium-fast');
  assert.equal(picker.matchVariant(opus, 1, { 'Fast Mode': 0 }).uid, 'claude-opus-5-5-medium');
  assert.equal(picker.exactVariant(opus, 4, { 'Fast Mode': 1 }).uid, 'claude-opus-5-5-max-fast');
  const noFast = { ...opus, variants: opus.variants.filter(variant => variant.uid !== 'claude-opus-5-5-max-fast') };
  assert.equal(picker.exactVariant(noFast, 4, { 'Fast Mode': 1 }), null,
    'card-level Fast is unavailable when the current effort has no fast variant');

  const sol = familyOf('sol|5.6|');
  assert.deepEqual(sol.cells.map(cell => cell.label), ['Off', 'L', 'M', 'H', 'xH', 'Max']);
  assert.deepEqual(sol.toggles, ['Fast Mode'], 'Prompt Cache Retention never varies');

  const glm = familyOf('glm|5.3|');
  assert.deepEqual(glm.cells.map(cell => cell.label), ['L', 'H', 'Max']);
  assert.deepEqual(glm.toggles, [], '1M Context is 1 on every variant → no toggle');

  const flash = familyOf('swe|2|flash');
  assert.deepEqual(flash.cells.map(cell => cell.label), ['M', 'H', 'Max']);
  assert.deepEqual(flash.toggles, ['Fast Mode'], 'Lightning variants differ only by Fast Mode');

  const adaptive = familyOf('adaptive||');
  assert.deepEqual(adaptive.cells, []);
  assert.deepEqual(adaptive.toggles, []);
});

test('groupFusion groups real native lead candidates per family', () => {
  const candidates = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/real-fusion-candidates.json'), 'utf8'));
  const cards = picker.groupFusion(candidates.leads, new Map());
  const fable = cards.find(card => card.familyLabel === 'Claude Fable 5.2');
  assert.ok(fable, 'Claude Fable 5.2 variants collapse into one card');
  assert.equal(fable.name, 'Fable');
  assert.equal(fable.version, '5.2');
  assert.deepEqual(fable.cells.map(cell => cell.label), ['L', 'M', 'H', 'xH', 'Max'],
    'cells ordered by candidate effortOrder');
  assert.equal(fable.variants.length, 5);
  const astra = cards.find(card => card.familyLabel === 'GPT-6.2 Astra');
  assert.equal(astra.name, 'Astra');
  assert.equal(astra.version, '6.2');
  assert.equal(astra.variant, '', 'no "High Thinking" variant text');
  assert.ok(!cards.some(card => /Thinking/.test(card.variant || '')));
});

test('groupCards treats credit models with tier free as free', () => {
  const card = picker.groupCards([
    { modelUid: 'm-tier', familyUid: 'fam-tier', label: 'Freemodel 1', familyMetadata: {},
      modelCost: { type: 'credit', tier: 'free' } },
    { modelUid: 'm-paid', familyUid: 'fam-paid', label: 'Paidmodel 1', familyMetadata: {},
      modelCost: { type: 'credit', tier: 'paid' } },
  ], {});
  assert.equal(card.find(c => c.name === 'Freemodel').families[0].free, true, 'tier free counts');
  assert.equal(card.find(c => c.name === 'Paidmodel').families[0].free, false);
});

test('groupFusion falls back to visibleModelConfigs when candidates lack family fields', () => {
  const vmc = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/real-vmc.json'), 'utf8'));
  const index = new Map(vmc.map(model => [model.modelUid, model]));
  // Live-backend shape before the whitelist fix: no familyLabel/effortOrder,
  // familyKey is just the uid — one candidate per effort variant.
  const effortOf = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' };
  const candidates = ['claude-opus-5-5-low', 'claude-opus-5-5-medium', 'claude-opus-5-5-high',
    'claude-opus-5-5-xhigh', 'claude-opus-5-5-max', 'claude-opus-5-5-medium-fast']
    .map(uid => { const suffix = uid.split('5-5-')[1];
      return { ref: { kind: 'native', uid }, label: 'Claude Opus 5.5 ' + suffix,
        providerName: 'Devin', effort: effortOf[suffix.replace('-fast', '')], familyKey: uid }; });
  const cards = picker.groupFusion(candidates, index);
  assert.equal(cards.length, 1, 'all efforts collapse into one family card');
  assert.equal(cards[0].familyLabel, 'Claude Opus 5.5');
  assert.equal(cards[0].name, 'Opus');
  assert.deepEqual(cards[0].cells.map(cell => cell.label), ['L', 'M', 'H', 'xH', 'Max']);
  assert.deepEqual(cards[0].toggles, ['Fast Mode']);
});

test('pickFusionSlots prefers the current fusion value, then the saved draft', () => {
  const candidates = {
    leads: [{ ref: { kind: 'native', uid: 'lead-a' } }, { ref: { kind: 'byok', uid: 'lead-b' } }],
    sidekicks: [{ ref: { kind: 'native', uid: 'side-a' } }, { ref: { kind: 'native', uid: 'side-b' } }],
  };
  const state = { fusionSlots: { a: { lead: { kind: 'native', uid: 'lead-a' },
    sidekick: { kind: 'native', uid: 'side-a' } } } };
  const draft = { lead: { kind: 'byok', uid: 'lead-b' }, sidekick: { kind: 'native', uid: 'side-b' } };
  const fromValue = picker.pickFusionSlots('fusion-dmp-a', state, candidates, draft);
  assert.deepEqual(fromValue.lead, { kind: 'native', uid: 'lead-a' }, 'current value wins');
  assert.deepEqual(fromValue.sidekick, { kind: 'native', uid: 'side-a' });
  const fromDraft = picker.pickFusionSlots('claude-opus-5-5-medium', state, candidates, draft);
  assert.deepEqual(fromDraft.lead, { kind: 'byok', uid: 'lead-b' }, 'non-fusion value falls back to draft');
  assert.deepEqual(fromDraft.sidekick, { kind: 'native', uid: 'side-b' });
  const invalid = picker.pickFusionSlots('claude-opus-5-5-medium', state, candidates,
    { lead: { kind: 'native', uid: 'gone' }, sidekick: { kind: 'native', uid: 'side-b' } });
  assert.equal(invalid.lead, null, 'draft refs that are no longer candidates are dropped');
  assert.deepEqual(invalid.sidekick, { kind: 'native', uid: 'side-b' });
});

test('picker.js never uses CSP-forbidden DOM APIs', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../media/picker.js'), 'utf8');
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'document.write']) {
    assert.equal(source.includes(banned), false, banned);
  }
});
