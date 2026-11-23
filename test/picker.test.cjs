'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const picker = require('../media/picker.js');

test('picker.js exports pure helpers under node', () => {
  for (const key of ['cardName', 'effortLabel', 'filterNorm', 'groupCards', 'groupFusion', 'prefillFusion',
    'defaultVariant', 'pairingTag', 'fusionPairLabel']) {
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

test('groupFusion keeps the pre-suffix prefKey for effort-only BYOK families', () => {
  const { buildCatalog } = require('../src/catalog.cjs');
  const { candidates } = require('../src/picker-api.cjs');
  const config = { providers: [{ id: 'p', name: 'Legacy',
    models: [{ id: 'legacy-model', label: 'Legacy Model', efforts: ['high'] }] }] };
  const leads = candidates(buildCatalog(config), config).leads.filter(c => c.ref.kind === 'byok');
  assert.equal(leads.length, 1, 'a single high-effort route, no null default');
  const cards = picker.groupFusion(leads, new Map());
  const byok = cards.filter(card => card.byok);
  assert.equal(byok.length, 1);
  const card = byok[0];
  assert.equal(card.familyLabel, 'Legacy Model', 'display title drops the effort word');
  const oldKey = 'legacy||model high';
  assert.equal(card.prefKey, picker.cardKey(picker.cardName('Legacy Model High')),
    'prefKey keeps the pre-strip naming basis so stored prefs still resolve');
  assert.equal(card.prefKey, oldKey);
  const prefs = { order: [oldKey], favorites: [oldKey], hidden: [oldKey], aliases: { [oldKey]: '旧别名' } };
  const ranked = picker.arrangeCards([{ prefKey: 'other||', cardKey: 'b:other', byok: true, variants: [] }, card],
    { order: [oldKey], favorites: [], hidden: [], aliases: {} }, true);
  assert.equal(ranked[0].prefKey, oldKey, 'order resolves the old key');
  const arranged = picker.arrangeCards([card], prefs, true);
  assert.equal(arranged[0].favorite, true, 'favorites resolve the old key');
  assert.equal(arranged[0].hidden, false, 'BYOK cards stay exempt from prefs.hidden');
  assert.equal(picker.hidesCard({ prefKey: oldKey, byok: false }, new Set(prefs.hidden)), true,
    'the restored key still hides a non-BYOK card');
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

test('pairingTag flags official native pairs and unofficial mixes', () => {
  const side = { ref: { kind: 'native', uid: 'swe-2-high' }, officialLeads: ['claude-opus-5-5-high'] };
  assert.equal(picker.pairingTag({ kind: 'byok', uid: 'dmp-1' }, side), null, 'BYOK lead → no tag');
  assert.equal(picker.pairingTag(null, side), null, 'no lead → no tag');
  assert.equal(picker.pairingTag({ kind: 'native', uid: 'claude-opus-5-5-high' }, null), null, 'no candidate → no tag');
  assert.equal(picker.pairingTag({ kind: 'native', uid: 'claude-opus-5-5-high' }, side), 'official');
  assert.equal(picker.pairingTag({ kind: 'native', uid: 'gpt-6-1' }, side), 'unofficial',
    'native lead outside officialLeads');
  assert.equal(picker.pairingTag({ kind: 'native', uid: 'claude-opus-5-5-high' },
    { ref: { kind: 'byok', uid: 'dmp-2' } }), 'unofficial', 'native lead + BYOK sidekick');
});

test('fusionPairLabel extracts the concrete pair from official fusion labels', () => {
  assert.equal(picker.fusionPairLabel(
    { familyUid: 'fusion', label: 'Fusion (Claude Opus 5.5 Medium + SWE-2 Medium)' }),
    'Claude Opus 5.5 Medium + SWE-2 Medium');
  assert.equal(picker.fusionPairLabel(
    { familyUid: 'fusion', label: 'Fusion (Claude Opus 5.5 Medium Fast + SWE-2 Medium)' }),
    'Claude Opus 5.5 Medium Fast + SWE-2 Medium', 'Fast stays inside the parentheses');
  assert.equal(picker.fusionPairLabel({ familyUid: 'other', label: 'Fusion (A + B)' }), null,
    'non-fusion family → null');
  assert.equal(picker.fusionPairLabel({ familyUid: 'fusion', label: 'Fusion' }), null,
    'label without parentheses → null');
  assert.equal(picker.fusionPairLabel(null), null);
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

test('prefSets migrates legacy flat prefs into three independent lists', () => {
  const data = { prefs: { order: ['a', 'b'], favorites: ['a'], hidden: ['h'], aliases: { a: 'A' } } };
  const sets = picker.prefSets(data);
  assert.deepEqual(sets.single, { order: ['a', 'b'], favorites: ['a'], hidden: ['h'], aliases: { a: 'A' } });
  assert.deepEqual(sets.lead, { order: ['a', 'b'], favorites: ['a'], hidden: [], aliases: { a: 'A' } },
    'fusion lists seed from single minus hidden');
  assert.deepEqual(sets.sidekick, sets.lead);
  sets.lead.order.push('x'); sets.lead.aliases.b = 'B'; sets.lead.favorites.push('z');
  assert.deepEqual(sets.single.order, ['a', 'b'], 'fusion lists share no arrays with single');
  assert.deepEqual(sets.single.aliases, { a: 'A' });
  assert.deepEqual(sets.sidekick.order, ['a', 'b'], 'the two fusion lists share no arrays either');
  // Stored fusionPrefs win over the seed and keep their own hidden keys.
  const stored = picker.prefSets({ prefs: { order: ['s'] },
    fusionPrefs: { lead: { order: ['l'], hidden: ['lh'] }, sidekick: { favorites: ['f'] } } });
  assert.deepEqual(stored.lead.order, ['l']);
  assert.deepEqual(stored.lead.hidden, ['lh']);
  assert.deepEqual(stored.sidekick.favorites, ['f']);
  assert.deepEqual(picker.prefSets(null).single, { order: [], favorites: [], hidden: [], aliases: {} });
});

test('appendNewKeys appends unseen keys in order and returns the same array otherwise', () => {
  const order = ['a', 'b'];
  assert.deepEqual(picker.appendNewKeys(order, ['b', 'c', 'd']), ['a', 'b', 'c', 'd']);
  assert.equal(picker.appendNewKeys(order, ['b', 'a']), order, 'nothing new → same reference');
  assert.equal(picker.appendNewKeys(order, []), order);
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
  const nativeModel = { modelUid: 'kimi-k3-1-pro-high', label: 'Kimi K3.1 Pro High', familyUid: 'kimi-k3-1-pro', familyLabel: 'Kimi K3.1 Pro',
    familyMetadata: { Effort: { order: 1, name: 'High' } }, displayOption: 'standard-picker' };
  const byokModel = { modelUid: 'dmp-magpie-kimi-k3-1-pro-0123456789abcdef', label: 'Magpie · Kimi K3.1 Pro', displayOption: 'standard-picker' };
  const cards = picker.groupCards([nativeModel, byokModel], null);
  const families = cards.flatMap(card => card.families);
  const byokFamily = families.find(family => family.byok === true);
  const nativeFamily = families.find(family => family.byok === false);
  assert.ok(byokFamily);
  assert.ok(nativeFamily);
  const byokVariant = byokFamily.variants[0];
  const nativeVariant = nativeFamily.variants[0];
  assert.equal(byokVariant.native, false, 'dmp- uid is BYOK before state.byok exists');
  assert.equal(byokVariant.model, undefined, 'BYOK never carries a native model for getCostTag');
  assert.equal(nativeVariant.native, true);
  assert.equal(nativeVariant.model, nativeModel);
  const seen = [];
  const located = { host: { getCostTag(model) {
    seen.push(model?.modelUid);
    return { label: String(model?.modelUid || '').startsWith('dmp-') ? 'API' : '1x' };
  } } };
  const tagFor = variant => variant?.native === true ? picker.costTagFor(located, variant.model) : null;
  assert.equal(tagFor(byokVariant), null, 'first render must not show the native API tripwire on BYOK');
  assert.deepEqual(tagFor(nativeVariant), { label: '1x', tooltip: undefined });
  assert.deepEqual(seen, [nativeModel.modelUid], 'getCostTag is never called with a dmp- model');
});

test('viewMode defaults to cards, honors classic, tolerates garbage input', () => {
  assert.equal(picker.viewMode(undefined), 'cards');
  assert.equal(picker.viewMode(null), 'cards');
  assert.equal(picker.viewMode({}), 'cards');
  assert.equal(picker.viewMode('classic'), 'cards', 'a bare string is not the LS data object');
  assert.equal(picker.viewMode({ view: 'classic' }), 'classic');
  assert.equal(picker.viewMode({ view: 'cards' }), 'cards');
  assert.equal(picker.viewMode({ view: 'weird' }), 'cards');
  assert.equal(picker.viewMode({ view: 0 }), 'cards');
});

test('costTagFor asks the host callback and never guesses', () => {
  const located = model => ({ host: { getCostTag: () => model } });
  assert.deepEqual(picker.costTagFor(located({ label: '2.5x', tooltip: 'Devin Credits：按量' }), { m: 1 }),
    { label: '2.5x', tooltip: 'Devin Credits：按量' });
  assert.deepEqual(picker.costTagFor(located({ label: 'free' }), { m: 1 }), { label: 'free', tooltip: undefined });
  assert.equal(picker.costTagFor(located({ label: '  ' }), { m: 1 }), null, 'blank labels render nothing');
  assert.equal(picker.costTagFor(located(undefined), { m: 1 }), null, 'undefined return → no tag');
  assert.equal(picker.costTagFor(located(null), { m: 1 }), null);
  assert.equal(picker.costTagFor(located('1x'), { m: 1 }), null, 'a non-object return is ignored');
  assert.equal(picker.costTagFor(located({ label: 42 }), { m: 1 }), null, 'non-string labels are ignored');
  assert.equal(picker.costTagFor({ host: { getCostTag: () => { throw new Error('host bug'); } } }, { m: 1 }),
    null, 'a throwing callback stays quiet');
  assert.equal(picker.costTagFor({ host: { getCostTag: 'not-a-fn' } }, { m: 1 }), null, 'non-function → no call');
  assert.equal(picker.costTagFor({ host: {} }, { m: 1 }), null, 'missing callback → no tag');
  assert.equal(picker.costTagFor({ host: { getCostTag: () => ({ label: '1x' }) } }, null),
    null, 'no model → never called');
  assert.equal(picker.costTagFor(null, { m: 1 }), null);
  let calls = 0;
  picker.costTagFor({ host: { getCostTag: () => { calls++; } } }, undefined);
  assert.equal(calls, 0, 'the callback is never invoked without a model');
});

test('groupCards variants keep the native model; BYOK variants carry none', () => {
  const nativeModel = { modelUid: 'native-other', label: 'Other Model', familyUid: 'fam-o',
    provider: 'openai', modelCost: { type: 'credit', multiplier: 2.5 } };
  const cards = picker.groupCards([
    { modelUid: 'dmp-p-model-x-1', label: 'P · Model X' },
    nativeModel,
  ], { byok: { 'dmp-p-model-x-1': { providerId: 'p', providerName: 'P', modelId: 'model-x',
    label: 'P · Model X', effort: null } } });
  const byokVariant = cards.find(card => card.families.some(family => family.byok))
    .families.find(family => family.byok).variants[0];
  const nativeVariant = cards.find(card => card.families.every(family => !family.byok)).families[0].variants[0];
  assert.equal(nativeVariant.native, true);
  assert.equal(nativeVariant.model, nativeModel, 'the visibleModelConfigs entry is passed by reference');
  assert.equal(byokVariant.native, false);
  assert.equal(byokVariant.model, undefined, 'BYOK never reaches the native cost callback');
});

test('groupFusion variants keep native models via the nativeIndex; BYOK stays isolated', () => {
  const nativeModel = { modelUid: 'nat-1', label: 'N One', familyUid: 'fam-n',
    modelCost: { type: 'credit', multiplier: 1 } };
  const cards = picker.groupFusion([
    { ref: { kind: 'byok', uid: 'dmp-p-m-1' }, label: 'Model X', providerName: 'P',
      effort: null, familyKey: 'byok:p:m' },
    { ref: { kind: 'native', uid: 'nat-1' }, label: 'N One', providerName: 'Devin', effort: null, familyKey: 'fam-n' },
  ], new Map([['nat-1', nativeModel]]));
  const nativeCard = cards.find(card => !card.byok);
  const byokCard = cards.find(card => card.byok);
  assert.equal(nativeCard.variants[0].native, true);
  assert.equal(nativeCard.variants[0].model, nativeModel, 'same ref from the nativeIndex');
  assert.equal(byokCard.variants[0].native, false);
  assert.equal(byokCard.variants[0].model, undefined);
});

test('selectedVariant prefers live, then the card state match, then the default', () => {
  const family = { variants: [
    { uid: 'a', effortOrder: 1, toggles: {}, isDefault: true },
    { uid: 'b', effortOrder: 3, toggles: {} },
    { uid: 'c', effortOrder: 5, toggles: { thinking: 1 } },
  ], cells: [{ order: 1 }, { order: 3 }, { order: 5 }], toggles: ['thinking'] };
  assert.equal(picker.selectedVariant(family, { effortOrder: 3, toggles: {} }, family.variants[1]).uid, 'b',
    'the live selection always wins');
  assert.equal(picker.selectedVariant(family, { effortOrder: 5, toggles: { thinking: 1 } }, null).uid, 'c',
    'effort + toggles pick their variant when nothing is live');
  assert.equal(picker.selectedVariant(family, { effortOrder: 2, toggles: {} }, null).uid, 'a',
    'no match falls back to the family default');
  assert.equal(picker.selectedVariant(family, null, null).uid, 'a', 'no state at all still resolves');
});

test('priceInfo renders explicit prices with Chinese labels and a shared denominator', () => {
  const model = { costs: [
    { label: 'Input', value: 2, denominator: '1M tokens' },
    { label: 'Cached Input', value: 0.1, denominator: '1M tokens' },
    { label: 'Output', value: 10, denominator: '1M tokens' },
    { label: 'Effort', text: 'Higher effort consumes more tokens' },
  ] };
  const info = picker.priceInfo(model);
  assert.equal(info.text, '输入 $2 · 缓存输入 $0.1 · 输出 $10 / 1M');
  assert.equal(info.title, '输入：$2 / 1M tokens\n缓存输入：$0.1 / 1M tokens\n输出：$10 / 1M tokens');
  assert.equal(info.items.length, 3, 'the text note is dropped');
});

test('priceInfo drops text/fuzzy/non-finite metrics and returns null without priced entries', () => {
  const info = picker.priceInfo({ costs: [
    { label: 'Note', text: 'dimension note' },
    { label: 'Input', value: 1, denominator: '1M tokens', fuzzy: true },
    { label: 'Input', value: NaN, denominator: '1M tokens' },
    { label: 'Input', denominator: '1M tokens' },
    { value: 9, denominator: '1M tokens' },
    { label: 'Output', value: 3, denominator: '1M tokens' },
  ] });
  assert.equal(info.text, '输出 $3 / 1M');
  assert.equal(picker.priceInfo(null), null);
  assert.equal(picker.priceInfo({}), null);
  assert.equal(picker.priceInfo({ costs: [] }), null);
  assert.equal(picker.priceInfo({ costs: [{ label: 'x', text: 'note' }] }), null);
});

test('priceInfo: unit metrics skip the $ sign, mixed denominators print per item', () => {
  const unit = picker.priceInfo({ costs: [
    { label: 'Requests', value: 0.05, unit: 'per request', denominator: '1K requests' },
  ] });
  assert.equal(unit.text, 'Requests 0.05 / 1K requests');
  const mixed = picker.priceInfo({ costs: [
    { label: 'Input', value: 2, denominator: '1M tokens' },
    { label: 'Output', value: 10, denominator: '1K tokens' },
  ] });
  assert.equal(mixed.text, '输入 $2 / 1M · 输出 $10 / 1K');
  const infoTitle = picker.priceInfo({ costs: [
    { label: 'Input', value: 2, denominator: '1M tokens', info: 'cached reads billed' },
  ] });
  assert.equal(infoTitle.title, '输入：$2 / 1M tokens（cached reads billed）');
});

test('priceInfo: unknown labels pass through, cache-write maps to 缓存写入', () => {
  const info = picker.priceInfo({ costs: [
    { label: 'Batch Input', value: 1, denominator: '1M tokens' },
    { label: 'Cache Write', value: 1.25, denominator: '1M tokens' },
    { label: 'Cache Creation', value: 6, denominator: '1M tokens' },
  ] });
  assert.equal(info.text, 'Batch Input $1 · 缓存写入 $1.25 · 缓存写入 $6 / 1M');
});

test('classic view is wired into the capture listeners and the switch affordances exist', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../media/picker.js'), 'utf8');
  const listeners = source.slice(source.indexOf("['pointerdown', 'mousedown', 'click']"));
  assert.ok(listeners.includes("view === 'classic'"), 'pointer/mouse/click capture bails on classic view');
  assert.ok(listeners.includes('data-dmp-native-switch'), 'capture yields to the switch before the trigger check');
  assert.ok(source.includes('data-dmp-native-switch') && source.includes('经典选择器'), 'both switch entries exist');
  const classicBody = source.slice(source.indexOf('function openClassic'), source.indexOf('function nativeSwitch'));
  assert.ok(classicBody.includes('openChangeFor(trigger'), 'the public onOpenChange is the primary path');
  assert.ok(classicBody.indexOf('openChangeFor(trigger') < classicBody.indexOf('dispatchEvent'),
    'event replay is only the no-callback fallback');
});

test('Enter and Space on the classic switch skip first-card hotkeys', () => {
  const switchBtn = { tagName: 'BUTTON', classList: { contains: name => name === 'dmp-classic' },
    closest: sel => sel === '.dmp-classic' ? switchBtn : null };
  const switchChild = { tagName: 'SPAN', classList: { contains: () => false },
    closest: sel => sel === '.dmp-classic' ? switchBtn : null };
  const card = { tagName: 'DIV', classList: { contains: () => false }, closest: () => null };
  assert.equal(picker.skipsPanelHotkeys(switchBtn), true);
  assert.equal(picker.skipsPanelHotkeys(switchChild), true);
  assert.equal(picker.skipsPanelHotkeys(card), false);
  assert.equal(picker.skipsPanelHotkeys({ tagName: 'INPUT' }), true);
  assert.equal(picker.skipsPanelHotkeys({ tagName: 'TEXTAREA' }), true);
  assert.equal(picker.skipsPanelHotkeys({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(picker.skipsPanelHotkeys(null), false);
  const source = fs.readFileSync(path.resolve(__dirname, '../media/picker.js'), 'utf8');
  const onKey = source.slice(source.indexOf('const onKey = event'), source.indexOf("document.addEventListener('keydown', onKey"));
  assert.ok(onKey.includes('skipsPanelHotkeys'), 'panel key handler consults skipsPanelHotkeys');
  assert.ok(onKey.indexOf('skipsPanelHotkeys') < onKey.indexOf("event.key === 'Enter'"),
    'view switch is skipped before first-card Enter');
  assert.ok(onKey.indexOf('skipsPanelHotkeys') < onKey.indexOf('event.key.length === 1'),
    'view switch is skipped before Space/typeahead steals focus');
  assert.ok(!onKey.includes('onModelSelect'), 'the key handler never selects a model itself');
});

test('verify-classic.py launches default Playwright Chromium with an env override', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../dev/verify-classic.py'), 'utf8');
  assert.ok(source.includes("os.environ.get('DMP_CHROMIUM')"), 'DMP_CHROMIUM overrides the executable');
  assert.ok(source.includes('pw.chromium.launch(**chromium_launch_kwargs())'),
    'launch uses kwargs so a missing Windows path does not crash');
  assert.ok(source.includes('return {}'), 'no override and no Windows cache → default Chromium');
});

test('groupFusion assigns accurate vendor keys instead of hardcoding windsurf/other', () => {
  const cards = picker.groupFusion([
    { ref: { kind: 'native', uid: 'claude-opus-5-5-medium' }, label: 'Claude Opus 5.5 Medium', providerName: 'Devin', familyLabel: 'Claude Opus 5.5', familyKey: 'claude-opus-5-5' },
    { ref: { kind: 'native', uid: 'gpt-5-6-sol-low' }, label: 'GPT-5.6 Sol Low', providerName: 'Devin', familyLabel: 'GPT-5.6 Sol', familyKey: 'gpt-5.6-sol' },
    { ref: { kind: 'native', uid: 'gemini-3-8-flash-low' }, label: 'Gemini 3.8 Flash Low', providerName: 'Devin', familyLabel: 'Gemini 3.8 Flash', familyKey: 'gemini-3-8-flash' },
    { ref: { kind: 'byok', uid: 'dmp-p-glm-1' }, label: 'Relay · GLM-5.3 High', providerName: 'Relay', effort: 'High', familyLabel: 'GLM-5.3', familyKey: 'byok:p:glm-5-3' },
    { ref: { kind: 'native', uid: 'swe-2-high' }, label: 'SWE-2 High', providerName: 'Devin', familyLabel: 'SWE-2', familyKey: 'swe-2' },
  ]);
  const byName = Object.fromEntries(cards.map(c => [c.familyLabel, c.vendor]));
  assert.equal(byName['Claude Opus 5.5'], 'anthropic');
  assert.equal(byName['GPT-5.6 Sol'], 'openai');
  assert.equal(byName['Gemini 3.8 Flash'], 'google');
  assert.equal(byName['GLM-5.3'], 'zai');
  assert.equal(byName['SWE-2'], 'windsurf');
});

test('fusion slot text strips a BYOK effort suffix before appending the compact label', () => {
  const ref = { kind: 'byok', uid: 'dmp-p-reasoner-high' };
  assert.equal(picker.fusionSlotText(
    { familyLabel: 'DeepSeek Reasoner High', label: 'Magpie · DeepSeek Reasoner High', effort: 'high' }, ref),
    'DeepSeek Reasoner H');
  assert.equal(picker.fusionSlotText(
    { familyLabel: 'DeepSeek Reasoner', effort: 'high' }, ref),
    'DeepSeek Reasoner H');
  assert.equal(picker.fusionSlotText(
    { label: 'Magpie · DeepSeek Reasoner High', effort: 'high' }, ref),
    'DeepSeek Reasoner H', 'label fallback also strips High before appending H');
  assert.equal(picker.fusionSlotText(
    { familyLabel: 'Claude Opus 5.5', effort: 'High' }, { kind: 'native', uid: 'claude-opus-5-5-high' }),
    'Opus 5.5 H');
  const source = fs.readFileSync(path.resolve(__dirname, '../media/picker.js'), 'utf8');
  const chip = source.slice(source.indexOf('function slotChip'), source.indexOf('function rerenderGrid'));
  assert.ok(chip.includes('fusionSlotText'), 'slot chips use fusionSlotText');
  assert.ok(!chip.includes('parsed.name'), 'slot chips no longer compose cardName + effort inline');
});

test('clipboardStatus reports success only after writeText resolves', async () => {
  const ok = await picker.clipboardStatus(async uid => { assert.equal(uid, 'dmp-1'); }, 'dmp-1');
  assert.deepEqual(ok, { ok: true, text: '已复制模型 ID：dmp-1' });
  const missing = await picker.clipboardStatus(undefined, 'dmp-1');
  assert.equal(missing.ok, false);
  assert.equal(missing.text, '复制失败');
  const rejected = await picker.clipboardStatus(async () => { throw new Error('denied'); }, 'dmp-1');
  assert.equal(rejected.ok, false);
  const syncThrow = await picker.clipboardStatus(() => { throw new Error('nope'); }, 'dmp-1');
  assert.equal(syncThrow.ok, false);
  const source = fs.readFileSync(path.resolve(__dirname, '../media/picker.js'), 'utf8');
  const action = source.slice(source.indexOf("label: '复制模型 ID'"), source.indexOf("label: '管理供应商"));
  assert.ok(action.includes('clipboardStatus'));
  assert.ok(action.includes('.then'), 'toast waits for clipboardStatus');
  assert.ok(!action.includes("?.catch?.(() => {})"), 'failed writes are no longer swallowed before the toast');
});
