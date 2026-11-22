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

test('sanitizePrefs normalizes arrays, dedupes, and caps aliases at 40 chars', () => {
  const prefs = picker.sanitizePrefs({
    order: ['a', 'b', 'a', 7, '', 'c'],
    favorites: ['a', 'a'],
    hidden: 'nope',
    aliases: { x: '  Alias  ', y: 42, z: 'q'.repeat(60), empty: '   ' },
  });
  assert.deepEqual(prefs.order, ['a', 'b', 'c']);
  assert.deepEqual(prefs.favorites, ['a']);
  assert.deepEqual(prefs.hidden, []);
  assert.equal(prefs.aliases.x, 'Alias');
  assert.equal(prefs.aliases.z.length, 40);
  assert.ok(!('y' in prefs.aliases) && !('empty' in prefs.aliases));
  assert.deepEqual(picker.sanitizePrefs(null), { order: [], favorites: [], hidden: [], aliases: {} });
  assert.deepEqual(picker.sanitizePrefs('junk'), { order: [], favorites: [], hidden: [], aliases: {} });
});

test('arrangeCards: order ranks first, unknowns keep catalog order, favorites front, hidden out', () => {
  const mk = prefKey => ({ prefKey });
  const cards = [mk('a'), mk('b'), mk('c'), mk('d'), mk('e')];
  const prefs = { order: ['d', 'b'], favorites: ['e'], hidden: ['c'], aliases: {} };
  const out = picker.arrangeCards(cards, prefs, false);
  assert.deepEqual(out.map(c => c.prefKey), ['e', 'd', 'b', 'a'],
    'favorite e front, then ordered d b, then catalog a (c hidden)');
  const withHidden = picker.arrangeCards(cards, prefs, true);
  assert.deepEqual(withHidden.map(c => c.prefKey), ['e', 'd', 'b', 'a', 'c'],
    'hidden card keeps its arranged position when shown');
  assert.equal(withHidden.at(-1).hidden, true);
  assert.equal(out[0].favorite, true);
  // New/unknown cards append in catalog order at the end.
  const grown = picker.arrangeCards([mk('a'), mk('z'), mk('b')], { order: ['b'], favorites: [], hidden: [], aliases: {} }, false);
  assert.deepEqual(grown.map(c => c.prefKey), ['b', 'a', 'z']);
});

test('applyCardDrop covers the three zones', () => {
  const keys = ['a', 'b', 'c', 'd'];
  assert.deepEqual(picker.applyCardDrop(keys, 0, 2, 'before'), ['b', 'a', 'c', 'd']);
  assert.deepEqual(picker.applyCardDrop(keys, 0, 2, 'after'), ['b', 'c', 'a', 'd']);
  assert.deepEqual(picker.applyCardDrop(keys, 0, 2, 'swap'), ['c', 'b', 'a', 'd']);
  assert.deepEqual(picker.applyCardDrop(keys, 3, 0, 'before'), ['d', 'a', 'b', 'c']);
  assert.deepEqual(picker.applyCardDrop(keys, 1, 1, 'before'), keys, 'self drop is a no-op');
  assert.deepEqual(picker.applyCardDrop(keys, 9, 1, 'before'), keys, 'out of range is a no-op');
});

test('dropModeFromRatio maps pointer position to zones', () => {
  assert.equal(picker.dropModeFromRatio(0.1), 'before');
  assert.equal(picker.dropModeFromRatio(0.5), 'swap');
  assert.equal(picker.dropModeFromRatio(0.9), 'after');
});

test('moveCardKey and toggleKey update key lists', () => {
  assert.deepEqual(picker.moveCardKey(['a', 'b', 'c'], 'c', 'first'), ['c', 'a', 'b']);
  assert.deepEqual(picker.moveCardKey(['a', 'b', 'c'], 'a', 'last'), ['b', 'c', 'a']);
  assert.deepEqual(picker.moveCardKey(['a', 'b'], 'z', 'first'), ['a', 'b'], 'absent key unchanged');
  assert.deepEqual(picker.toggleKey(['a', 'b'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(picker.toggleKey(['a', 'b'], 'a'), ['b']);
});

test('mergeSubsetOrder folds a reordered visible subset back into the full order', () => {
  const full = ['a', 'b', 'c', 'd', 'e'];
  const visible = ['b', 'd', 'e'];           // user reorders only these
  assert.deepEqual(picker.mergeSubsetOrder(full, ['e', 'b', 'd']), ['a', 'e', 'c', 'b', 'd']);
});

test('fusion cards expose a canonical prefKey shared with single mode', () => {
  const candidates = [
    { ref: { kind: 'native', uid: 'opus-low' }, label: 'Claude Opus 5.5', providerName: 'Devin',
      familyKey: 'fam-opus', familyLabel: 'Claude Opus 5.5', effort: 'low', effortOrder: 1 },
    { ref: { kind: 'native', uid: 'opus-high' }, label: 'Claude Opus 5.5', providerName: 'Devin',
      familyKey: 'fam-opus', familyLabel: 'Claude Opus 5.5', effort: 'high', effortOrder: 3 },
  ];
  const fusion = picker.groupFusion(candidates, new Map());
  assert.equal(fusion.length, 1);
  assert.equal(fusion[0].prefKey, 'opus|5.5|', 'prefKey = single-mode cardKey');
  assert.notEqual(fusion[0].prefKey, fusion[0].cardKey, 'internal cardKey stays separate');
  // The same model in single mode produces the identical key.
  const single = picker.groupCards([
    { modelUid: 'opus-high', label: 'Claude Opus 5.5 High', familyUid: 'fam-opus',
      familyLabel: 'Claude Opus 5.5', familyMetadata: { Effort: { order: 3, name: 'High' } } },
  ], {});
  assert.equal(single[0].prefKey, fusion[0].prefKey, 'prefs apply across both modes');
});

test('hidden prefs only hide Devin families: a same-named BYOK model keeps the card alive', () => {
  const hidden = new Set(['kimi|3.1|pro']);
  const native = { prefKey: 'kimi|3.1|pro', families: [{ byok: false }] };
  const mixed = { prefKey: 'kimi|3.1|pro', families: [{ byok: false }, { byok: true, providerId: 'magpie' }] };
  const byokOnly = { prefKey: 'kimi|3.1|pro', families: [{ byok: true, providerId: 'magpie' }] };
  assert.equal(picker.hidesCard(native, hidden), true);
  assert.equal(picker.hidesCard(mixed, hidden), false);
  assert.equal(picker.hidesCard(byokOnly, hidden), false);
  // Fusion cards are per provider: only the native one hides.
  assert.equal(picker.hidesCard({ prefKey: 'kimi|3.1|pro', byok: false }, hidden), true);
  assert.equal(picker.hidesCard({ prefKey: 'kimi|3.1|pro', byok: true }, hidden), false);
  const arranged = picker.arrangeCards([{ ...native, cardKey: 'n:kimi' }, { prefKey: 'kimi|3.1|pro', byok: true, cardKey: 'b:kimi' }],
    { order: [], favorites: [], hidden: ['kimi|3.1|pro'], aliases: {} }, false);
  assert.deepEqual(arranged.map(card => card.cardKey), ['b:kimi']);
});

test('single-mode families know they are BYOK from the uid even before /picker/state loads', () => {
  const cards = picker.groupCards([
    { modelUid: 'kimi-k3-1-pro-high', label: 'Kimi K3.1 Pro High', familyUid: 'kimi-k3-1-pro', familyLabel: 'Kimi K3.1 Pro',
      familyMetadata: { Effort: { order: 1, name: 'High' } }, displayOption: 'standard-picker' },
    { modelUid: 'dmp-magpie-kimi-k3-1-pro-0123456789abcdef', label: 'Magpie · Kimi K3.1 Pro', displayOption: 'standard-picker' },
  ], null);
  const families = cards.flatMap(card => card.families);
  assert.ok(families.some(family => family.byok === true));
  assert.ok(families.some(family => family.byok === false));
});
