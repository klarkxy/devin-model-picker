// Devin Model Picker — renderer-side card picker injected into Devin's
// workbench.html. Replaces the native model menu with a card grid that also
// drives the BYOK Fusion slots through the local backend (127.0.0.1:39852).
// CSP note: require-trusted-types-for 'script' is on — no HTML-string DOM APIs.
// Everything below is vanilla DOM building and <style>.textContent.
(() => {
'use strict';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested under Node; the IIFE early-returns for require()).
// ---------------------------------------------------------------------------

const IDLIKE = label => typeof label === 'string' && !/\s/.test(label) && /[-_/]/.test(label);
const BRANDS = new Set(['claude', 'gpt', 'chatgpt', 'gemini', 'openai', 'anthropic',
  'google', 'meta', 'nvidia', 'xai', 'alibaba', 'moonshot']);
const VARIANT_WORDS = new Set(['flash', 'pro', 'mini', 'max', 'lite', 'lightning',
  'ultra', 'super', 'nano', 'turbo', 'fast', 'plus', 'preview', 'thinking',
  'instruct', 'coder', 'codex', 'air']);
const CASING = { deepseek: 'DeepSeek', openai: 'OpenAI', minimax: 'MiniMax',
  gpt: 'GPT', glm: 'GLM', swe: 'SWE', qwen: 'Qwen', kimi: 'Kimi', grok: 'Grok',
  claude: 'Claude', gemini: 'Gemini' };
const VERSION_NUMERIC = /^v?\d+(?:\.\d+)*$/i;
const VERSION_LETTER = /^[a-z]\d+(?:\.\d+)*$/i;

// cardName('Claude Opus 5.5') → { name: 'Opus', version: '5.5', variant: '' }
function cardName(label) {
  let text = String(label || '').trim();
  if (IDLIKE(text)) {
    const leaf = text.split('/').at(-1);
    const raw = leaf.split(/[-_]/).filter(Boolean);
    const joined = [];
    for (const token of raw) {
      if (/^\d{1,2}$/.test(token) && joined.length && /^\d{1,2}(?:\.\d{1,2})*$/.test(joined.at(-1))) {
        joined[joined.length - 1] += '.' + token;
      } else joined.push(token);
    }
    text = joined.map(token => CASING[token.toLowerCase()]
      || (/^o\d/.test(token) ? token : token.charAt(0).toUpperCase() + token.slice(1))).join(' ');
  }
  const tokens = text.split(/\s+/).flatMap(token => token.split('-')).filter(Boolean);
  const classified = tokens.map(raw => {
    const lower = raw.toLowerCase();
    return { raw, lower, brand: BRANDS.has(lower), variant: VARIANT_WORDS.has(lower) };
  });
  let version = '', versionSeen = false, nameCandidateSeen = false;
  const marked = classified.map(entry => {
    if (!versionSeen) {
      if (VERSION_NUMERIC.test(entry.raw)) {
        versionSeen = true; version = entry.raw.replace(/^v/i, '');
        return { ...entry, isVersion: true };
      }
      if (VERSION_LETTER.test(entry.raw) && nameCandidateSeen) {
        versionSeen = true; version = entry.raw.replace(/^[a-z]/i, '');
        return { ...entry, isVersion: true };
      }
    }
    if (!entry.brand && !entry.variant) nameCandidateSeen = true;
    else if (entry.brand) nameCandidateSeen = true; // a brand may precede a letter-version (e.g. 'K3' after 'Kimi')
    return { ...entry, isVersion: false };
  });
  const hasNameToken = marked.some(entry => !entry.brand && !entry.variant && !entry.isVersion);
  let name = '';
  const variantParts = [];
  for (const entry of marked) {
    if (entry.isVersion) continue;
    if (entry.brand && hasNameToken) continue;
    if (entry.variant) { variantParts.push(entry.raw); continue; }
    if (!name) { name = entry.raw; continue; }
    variantParts.push(entry.raw);
  }
  if (!name) {
    const firstBrand = marked.find(entry => entry.brand);
    name = firstBrand ? firstBrand.raw : (marked[0]?.raw || '');
    if (firstBrand) {
      // The brand promoted to name must not also appear in the variant list.
      let skipped = false;
      for (let index = 0; index < variantParts.length; index++) {
        if (!skipped && variantParts[index] === firstBrand.raw) { variantParts.splice(index, 1); skipped = true; }
      }
    }
  }
  return { name, version, variant: variantParts.join(' ') };
}

const EFFORT_SHORT = { none: 'Off', off: 'Off', minimal: 'Min', low: 'L',
  medium: 'M', high: 'H', xhigh: 'xH', max: 'Max', ultra: 'U' };
// Only known effort words get compact labels; family dimension names like
// Flash/Lightning keep their full word (cells render at 10px).
const effortLabel = effort => effort == null ? '' : (EFFORT_SHORT[String(effort).toLowerCase()] ?? String(effort));

const filterNorm = text => String(text || '').toLowerCase().replace(/[-._\s/]+/g, '');
const filterMatch = (needle, fields) => {
  const norm = filterNorm(needle);
  if (!norm) return true;
  return fields.some(field => filterNorm(field).includes(norm));
};

const cardKey = parts => [parts.name, parts.version, parts.variant].join('|').toLowerCase();

// Base label used for card naming: BYOK entries prefer their catalog label
// minus the "Provider · " prefix; without picker state, everything up to the
// last " · " is stripped. Native entries use familyLabel || label.
function baseLabel(model, byokEntry) {
  if (byokEntry) {
    const label = String(byokEntry.label || '');
    return label.replace(/^.*? · /, '');
  }
  const raw = String(model?.familyLabel || model?.label || '');
  if (String(model?.modelUid || '').startsWith('dmp-') && raw.includes(' · ')) {
    return raw.slice(raw.lastIndexOf(' · ') + 3);
  }
  return raw;
}

const VENDORS = { anthropic: '#d97757', openai: '#10a37f', google: '#4285f4',
  deepseek: '#4d6bfe', xai: '#9ca3af', zai: '#14b8a6', moonshot: '#8b5cf6',
  qwen: '#615ced', minimax: '#f43f5e', nvidia: '#76b900', windsurf: '#22d3ee',
  meta: '#76b900', other: '#6b7280' };
const VENDOR_HINTS = [
  [/claude|anthropic/i, 'anthropic'], [/gpt|openai|chatgpt/i, 'openai'],
  [/gemini|google/i, 'google'], [/deepseek/i, 'deepseek'], [/grok|xai/i, 'xai'],
  [/glm|zai|zhipu/i, 'zai'], [/kimi|moonshot/i, 'moonshot'], [/qwen/i, 'qwen'],
  [/minimax/i, 'minimax'], [/llama|nemotron|meta/i, 'meta'], [/swe|windsurf/i, 'windsurf'],
];
function vendorOf(model, byokEntry) {
  if (!byokEntry && typeof model?.provider === 'string' && VENDORS[model.provider]) return model.provider;
  const hay = [byokEntry?.family, byokEntry?.label, model?.familyLabel, model?.label].filter(Boolean).join(' ');
  for (const [pattern, vendor] of VENDOR_HINTS) if (pattern.test(hay)) return vendor;
  return 'other';
}

// Card subtitle: drop any leading "<Provider> · " so it doesn't duplicate the
// provider chip ('Magpie · Claude Opus 5.5 · Magpie' → 'Claude Opus 5.5 · Magpie').
function stripProvider(label) {
  const raw = String(label || '');
  const index = raw.indexOf(' · ');
  return index >= 0 ? raw.slice(index + 3) : raw;
}

const HIDDEN_DISPLAY = new Set(['model-router', 'invisible', 'arena']);
const EFFORT_ORDER = { none: 0, off: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6, minimal: 7 };
const TOGGLE_LABELS = { 'fast mode': 'Fast', '1m context': '1M', 'thinking': 'Thinking',
  'prompt cache retention': 'Cache', 'speed': 'Speed' };
const toggleLabel = key => TOGGLE_LABELS[key.toLowerCase()] || key;

// Family dims split: the effort dimension is the named one whose key matches
// /effort/i (or the only named dim); unnamed dims are toggle switches.
function dimRoles(dims) {
  const entries = Object.entries(dims || {}).filter(([, v]) => v && typeof v === 'object');
  const named = entries.filter(([, v]) => typeof v.name === 'string' && v.name !== '');
  const effort = named.find(([key]) => /effort/i.test(key)) || (named.length === 1 ? named[0] : null);
  const toggles = entries.filter(([, v]) => !(typeof v.name === 'string' && v.name !== ''));
  return { effort, toggles };
}

// Aggregates a family's variants into { cells: [{order,label}], toggles: [key] }
// — one cell per distinct effort order, one toggle per unnamed dim whose order
// varies across variants.
function aggregateFamily(family) {
  const cells = new Map();
  const seen = new Map();
  for (const variant of family.variants) {
    if (variant.effortOrder != null && !cells.has(variant.effortOrder)) {
      cells.set(variant.effortOrder, { order: variant.effortOrder, label: effortLabel(variant.effort) });
    }
    for (const key of Object.keys(variant.toggles || {})) {
      const rec = seen.get(key) || { zero: false, nonzero: false };
      if ((variant.toggles[key] || 0) === 0) rec.zero = true; else rec.nonzero = true;
      seen.set(key, rec);
    }
  }
  family.cells = [...cells.values()].sort((a, b) => a.order - b.order);
  family.toggles = [...seen.entries()].filter(([, rec]) => rec.zero && rec.nonzero).map(([key]) => key);
  return family;
}

// Variant matching an effort order and toggle states; fewest toggle diffs wins.
function matchVariant(family, effortOrder, toggles) {
  const same = family.variants.filter(variant => variant.effortOrder === effortOrder && !variant.disabled);
  if (!same.length) return null;
  let best = same[0], bestScore = Infinity;
  for (const variant of same) {
    const score = (family.toggles || []).reduce(
      (n, key) => n + (((variant.toggles?.[key] || 0) !== (toggles?.[key] || 0)) ? 1 : 0), 0);
    if (score < bestScore) { best = variant; bestScore = score; }
  }
  return best;
}

// Exact variant for an effort order with every family toggle matching.
function exactVariant(family, effortOrder, toggles) {
  return family.variants.find(variant => variant.effortOrder === effortOrder && !variant.disabled
    && (family.toggles || []).every(key => (variant.toggles?.[key] || 0) === (toggles?.[key] || 0))) || null;
}

// Card-level switches (Fast, 1M, ...) rendered in the card's subtitle row. A
// switch is disabled when flipping it has no exact variant at the current effort.
function toggleSwitches(family, cardState, disabled, onFlip) {
  const row = el('span', 'dmp-togs');
  for (const key of family.toggles || []) {
    const on = (cardState.toggles[key] || 0) !== 0;
    const next = { ...cardState.toggles, [key]: on ? 0 : 1 };
    const pill = el('button', 'dmp-tog' + (on ? ' dmp-on' : ''));
    const track = el('span', 'dmp-tog-track');
    track.appendChild(el('span', 'dmp-tog-knob'));
    pill.appendChild(track);
    pill.appendChild(el('span', 'dmp-tog-txt', toggleLabel(key)));
    pill.setAttribute('aria-pressed', String(on));
    const target = cardState.effortOrder != null ? exactVariant(family, cardState.effortOrder, next) : null;
    if (disabled || (cardState.effortOrder != null && !target)) {
      pill.disabled = true;
      if (!disabled) pill.title = '当前强度没有' + toggleLabel(key) + '版本';
    } else pill.addEventListener('click', event => {
      event.stopPropagation();
      cardState.toggles = next;
      onFlip(target);
    });
    row.appendChild(pill);
  }
  return row;
}

// Groups filtered visibleModelConfigs into merged family cards.
// Each card: { cardKey, name, version, variant, families: [{ providerName,
// vendor, free, variants: [{ uid, label, effort, effortText, disabled,
// disabledReason, isDefault }] }] } preserving first-appearance order.
function groupCards(models, state) {
  const byok = state?.byok || {};
  const cards = new Map();
  for (const model of models || []) {
    const uid = model?.modelUid;
    if (typeof uid !== 'string' || !uid) continue;
    if (HIDDEN_DISPLAY.has(model.displayOption)) continue;
    if (uid.startsWith('fusion-')) continue;
    if (model.familyMetadata && typeof model.familyMetadata === 'object' && model.familyMetadata.Lead) continue;
    const byokEntry = uid.startsWith('dmp-') ? byok[uid] : undefined;
    // BYOK families are per provider+model (one dropdown entry each); native
    // families use the server familyUid. Families then merge across providers
    // into one card via cardKey.
    const familyUid = byokEntry && byokEntry.providerId && byokEntry.modelId
      ? 'byok:' + byokEntry.providerId + ':' + byokEntry.modelId
      : (model.familyUid || uid);
    const { effort: effortDim, toggles: toggleDims } = dimRoles(model.familyMetadata);
    const byokEffort = byokEntry ? byokEntry.effort : undefined;
    const nativeEffort = effortDim ? effortDim[1].name : undefined;
    const effort = byokEntry ? byokEffort : (nativeEffort ?? null);
    // BYOK's null-effort variant is the provider default and gets no cell;
    // every native effort order is a cell ('None' → Off).
    const effortOrder = byokEntry
      ? (byokEffort === null ? null
        : (effortDim ? effortDim[1].order : (EFFORT_ORDER[String(byokEffort).toLowerCase()] ?? 1e9)))
      : (effortDim ? effortDim[1].order : null);
    const toggles = Object.fromEntries(toggleDims.map(([key, val]) => [key, Number(val.order) || 0]));
    const providerName = byokEntry ? (byokEntry.providerName || String(byokEntry.label || '').split(' · ')[0] || 'BYOK') : 'Devin';
    const variant = {
      uid, label: String(model.label || uid), effort, effortOrder, toggles,
      disabled: model.disabled === true, disabledReason: model.disabledReason,
      isDefault: byokEntry ? byokEntry.effort === null : model.isDefaultModelInFamily === true,
      free: model.modelCost?.type === 'free' || model.modelCost?.tier === 'free',
      supportsImages: model.supportsImages !== false,
    };
    // BYOK labels carry the effort suffix ('… High'); the model id is the
    // stable name basis so every effort variant lands on the same card.
    const parsed = cardName(byokEntry?.modelId || baseLabel(model, byokEntry));
    const key = cardKey(parsed);
    if (!cards.has(key)) cards.set(key, { ...parsed, cardKey: key, prefKey: key, families: new Map() });
    const card = cards.get(key);
    if (!card.families.has(familyUid)) {
      card.families.set(familyUid, { providerName, vendor: vendorOf(model, byokEntry), variants: [], familyLabel: '',
        providerId: byokEntry?.providerId || null, modelId: byokEntry?.modelId || null });
    }
    const family = card.families.get(familyUid);
    if (providerName && !family.providerName) family.providerName = providerName;
    if (!family.familyLabel) {
      // Subtitle: the family's own label — native familyLabel, or the BYOK
      // label minus provider prefix and trailing effort name.
      let base = byokEntry ? stripProvider(byokEntry.label || '') : String(model.familyLabel || stripProvider(model.label));
      if (byokEntry && nativeEffort && base.endsWith(' ' + nativeEffort)) base = base.slice(0, -nativeEffort.length - 1);
      family.familyLabel = base;
    }
    family.free = family.free || variant.free;
    family.variants.push(variant);
  }
  for (const card of cards.values()) {
    card.families = [...card.families.values()];
    for (const family of card.families) {
      family.variants.sort((a, b) => (a.effortOrder ?? 1e9) - (b.effortOrder ?? 1e9));
      aggregateFamily(family);
    }
  }
  return [...cards.values()];
}

// Default variant per family: null-effort BYOK variant, then
// isDefaultModelInFamily, then first enabled variant.
function defaultVariant(family) {
  const byokNull = family.variants.find(variant => variant.effort === null && !variant.disabled);
  if (byokNull) return byokNull;
  const flagged = family.variants.find(variant => variant.isDefault && !variant.disabled);
  if (flagged) return flagged;
  return family.variants.find(variant => !variant.disabled) || null;
}

// Fusion candidates → family cards. BYOK groups by candidate.familyKey;
// native groups by the matching visibleModelConfigs familyUid (fallback
// familyKey), effort name from that entry's familyMetadata.Effort.name.
function groupFusion(candidates, nativeIndex) {
  const cards = new Map();
  for (const candidate of candidates || []) {
    const ref = candidate?.ref;
    if (!ref || typeof ref.uid !== 'string') continue;
    const nativeEntry = ref.kind === 'native' ? nativeIndex?.get(ref.uid) : undefined;
    // Family identity prefers the live visibleModelConfigs entry — backends
    // that drop family fields emit familyKey = uid; candidate fields are the
    // fallback when the entry is not in the visible list.
    const { effort: effortDim, toggles: toggleDims } = dimRoles(nativeEntry?.familyMetadata);
    const familyKey = (ref.kind === 'native' && nativeEntry?.familyUid) || candidate.familyKey || ref.uid;
    const effort = candidate.effort ?? (effortDim ? effortDim[1].name : null);
    // Same aggregation as single mode: BYOK null = default (no cell), native
    // effort orders become deduplicated cells.
    const effortOrder = ref.kind === 'byok'
      ? (candidate.effortOrder ?? (candidate.effort == null ? null : (EFFORT_ORDER[String(candidate.effort).toLowerCase()] ?? 1e9)))
      : (effortDim ? effortDim[1].order : (candidate.effortOrder ?? null));
    const toggles = Object.fromEntries(toggleDims.map(([key, val]) => [key, Number(val.order) || 0]));
    const parsed = cardName(nativeEntry?.familyLabel || candidate.familyLabel || candidate.label);
    const key = (ref.kind === 'byok' ? 'b:' : 'n:') + familyKey;
    if (!cards.has(key)) cards.set(key, { ...parsed, cardKey: key, prefKey: cardKey(parsed), providerName: candidate.providerName,
      vendor: ref.kind === 'byok' ? 'other' : 'windsurf', variants: [], familyLabel: '',
      providerId: ref.kind === 'byok' ? (candidate.familyKey || '').split(':')[1] || null : null,
      modelId: ref.kind === 'byok' ? (candidate.familyKey || '').split(':')[2] || null : null });
    const card = cards.get(key);
    if (!card.familyLabel) {
      let base = (ref.kind === 'native' && nativeEntry?.familyLabel) || candidate.familyLabel || stripProvider(candidate.label || '');
      if (!nativeEntry?.familyLabel && !candidate.familyLabel && effort && base.endsWith(' ' + effort)) base = base.slice(0, -effort.length - 1);
      card.familyLabel = base;
    }
    card.variants.push({ ref, uid: ref.uid, label: candidate.label, effort, effortOrder, toggles,
      disabled: false, isDefault: ref.kind === 'byok' ? candidate.effort == null : nativeEntry?.isDefaultModelInFamily === true });
  }
  for (const card of cards.values()) {
    card.variants.sort((a, b) => (a.effortOrder ?? 1e9) - (b.effortOrder ?? 1e9));
    aggregateFamily(card);
  }
  return [...cards.values()];
}

// A ref's underlying-model key used for the same-model rule: BYOK shares its
// model-level familyKey across effort variants; native keys on the uid itself.
function underlyingKey(ref, candidates) {
  if (!ref) return '';
  if (ref.kind === 'native') return 'native:' + ref.uid;
  // Backend same-model rule: BYOK compares providerId+modelId — exactly what
  // the candidate familyKey ('byok:<providerId>:<modelId>') encodes.
  const found = [...(candidates?.leads || []), ...(candidates?.sidekicks || [])]
    .find(item => item.ref.kind === 'byok' && item.ref.uid === ref.uid);
  return found?.familyKey || 'byok:' + ref.uid;
}

// Prefill fusion slots from the current picker value. Returns
// { lead, sidekick, startedInFusion }.
function prefillFusion(value, state, candidates) {
  const result = { lead: null, sidekick: null, startedInFusion: typeof value === 'string' && value.startsWith('fusion-') };
  if (typeof value !== 'string') return result;
  const slotMatch = /^fusion-dmp-([ab])$/.exec(value);
  const slots = state?.fusionSlots || {};
  const take = ref => ref && typeof ref.uid === 'string' ? { kind: ref.kind, uid: ref.uid } : null;
  if (slotMatch) {
    const slot = slots[slotMatch[1]];
    if (slot) { result.lead = take(slot.lead); result.sidekick = take(slot.sidekick); }
    return result;
  }
  const marker = value.lastIndexOf('-sidekick-');
  if (value.startsWith('fusion-') && marker > 'fusion-'.length) {
    const leadUid = value.slice('fusion-'.length, marker);
    const sideUid = value.slice(marker + '-sidekick-'.length);
    const leadOk = candidates?.leads?.some(item => item.ref.kind === 'native' && item.ref.uid === leadUid);
    const sideOk = candidates?.sidekicks?.some(item => item.ref.kind === 'native' && item.ref.uid === sideUid);
    if (leadOk) result.lead = { kind: 'native', uid: leadUid };
    if (sideOk) result.sidekick = { kind: 'native', uid: sideUid };
  }
  return result;
}

// Card preferences: order/favorites/hidden/aliases keyed by the canonical
// cardKey ('name|version|variant', lowercase) — shared by both modes.
function sanitizePrefs(raw) {
  const out = { order: [], favorites: [], hidden: [], aliases: {} };
  if (!raw || typeof raw !== 'object') return out;
  const keys = value => Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string' && item.trim() !== ''))]
    : [];
  out.order = keys(raw.order);
  out.favorites = keys(raw.favorites);
  out.hidden = keys(raw.hidden);
  if (raw.aliases && typeof raw.aliases === 'object' && !Array.isArray(raw.aliases)) {
    for (const [key, value] of Object.entries(raw.aliases)) {
      if (typeof value === 'string' && value.trim()) out.aliases[key] = value.trim().slice(0, 40);
    }
  }
  return out;
}

// Order: prefs.order ranks first (ties/unranked keep catalog order), then
// favorites stable-partitioned to the front, hidden removed unless shown.
// Mutates cards: .favorite, .hidden.
function arrangeCards(cards, prefs, showHidden) {
  const rank = new Map((prefs?.order || []).map((key, index) => [key, index]));
  const sorted = [...cards].sort((a, b) => {
    const ra = rank.get(a.prefKey), rb = rank.get(b.prefKey);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
  const favorites = new Set(prefs?.favorites || []);
  const hidden = new Set(prefs?.hidden || []);
  for (const card of sorted) {
    card.favorite = favorites.has(card.prefKey);
    card.hidden = hidden.has(card.prefKey);
  }
  sorted.sort((a, b) => Number(b.favorite) - Number(a.favorite));
  return sorted.filter(card => showHidden || !card.hidden);
}

// 3-zone drop reorder over an ordered key list: 'before'/'after' move the
// source next to the target, 'swap' exchanges both in place.
function applyCardDrop(keys, fromIndex, toIndex, mode) {
  const next = [...keys];
  if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length || fromIndex === toIndex) return next;
  if (mode === 'swap') {
    const temp = next[fromIndex]; next[fromIndex] = next[toIndex]; next[toIndex] = temp;
    return next;
  }
  let insert = mode === 'before' ? toIndex : toIndex + 1;
  const [moved] = next.splice(fromIndex, 1);
  if (fromIndex < insert) insert -= 1;
  next.splice(insert, 0, moved);
  return next;
}

// Drop zone from the pointer's horizontal ratio inside a card (0..1).
function dropModeFromRatio(ratio) { return ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'swap'; }

// Move key to first/last slot; returns a copy even when the key is absent.
function moveCardKey(keys, key, mode) {
  const index = keys.indexOf(key);
  if (index < 0) return [...keys];
  const next = [...keys];
  next.splice(index, 1);
  if (mode === 'first') next.unshift(key); else next.push(key);
  return next;
}

function toggleKey(list, key) { return list.includes(key) ? list.filter(item => item !== key) : [...list, key]; }

// Fold a reordered subset (e.g. only the visible cards) back into the full
// key arrangement: subset keys keep their slots, filled in the new order.
function mergeSubsetOrder(fullKeys, reorderedSubset) {
  const queue = [...reorderedSubset];
  const inSubset = new Set(reorderedSubset);
  return fullKeys.map(key => (inSubset.has(key) && queue.length ? queue.shift() : key));
}

// Validates a saved fusion draft against the current candidates: each ref must
// still be a candidate in its own role.
function validDraft(draft, candidates) {
  const take = (ref, list) => ref && (ref.kind === 'native' || ref.kind === 'byok') && typeof ref.uid === 'string' &&
    (list || []).some(item => item.ref.kind === ref.kind && item.ref.uid === ref.uid)
    ? { kind: ref.kind, uid: ref.uid } : null;
  if (!draft || typeof draft !== 'object') return { lead: null, sidekick: null };
  return { lead: take(draft.lead, candidates?.leads), sidekick: take(draft.sidekick, candidates?.sidekicks) };
}

// Fusion slot prefill precedence: the current fusion value wins, then the
// saved draft, then empty. Each slot falls through independently.
function pickFusionSlots(value, state, candidates, draft) {
  const prefill = prefillFusion(value, state, candidates);
  const backup = validDraft(draft, candidates);
  return { lead: prefill.lead || backup.lead, sidekick: prefill.sidekick || backup.sidekick };
}

const PICKER_ORIGIN = 'vscode-file://vscode-app';
const API_BASE = 'http://127.0.0.1:39852';
const LS_KEY = 'devin-model-picker:v1';

const exportsMap = { cardName, effortLabel, filterNorm, filterMatch, cardKey, baseLabel,
  vendorOf, VENDORS, groupCards, groupFusion, prefillFusion, defaultVariant,
  underlyingKey, matchVariant, exactVariant, dimRoles, aggregateFamily, toggleLabel, stripProvider,
  validDraft, pickFusionSlots, sanitizePrefs, arrangeCards, applyCardDrop, dropModeFromRatio,
  moveCardKey, toggleKey, mergeSubsetOrder,
  IDLIKE, HIDDEN_DISPLAY, LS_KEY, API_BASE };
if (typeof module === 'object' && module.exports) { module.exports = exportsMap; return; }

// ---------------------------------------------------------------------------
// DOM side. Everything below runs inside the workbench window.
// ---------------------------------------------------------------------------
if (window.__devinModelPicker) return;
window.__devinModelPicker = { version: '0.1.0' };
console.log('[devin-model-picker] loaded');

const CSS = `
.dmp-panel{position:fixed;z-index:2147483000;-webkit-app-region:no-drag;width:min(720px,94vw);max-height:min(480px,70vh);
 display:flex;flex-direction:column;border-radius:12px;border:1px solid var(--dmp-border);
 background:var(--dmp-bg);color:var(--dmp-fg);box-shadow:0 12px 40px rgba(0,0,0,.35);
 font:13px/1.4 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
 opacity:0;transform:scale(.97) translateY(4px);transition:opacity .12s ease,transform .12s ease}
.dmp-panel.dmp-open{opacity:1;transform:none}
.dmp-light{--dmp-bg:#ffffff;--dmp-fg:#1f2329;--dmp-muted:#6b7280;--dmp-border:#d7dbe0;
 --dmp-card:#f6f7f9;--dmp-card-hover:#eef0f3;--dmp-sel:#2563eb;--dmp-chip:#eceef1;--dmp-track:#e5e7eb}
.dmp-dark{--dmp-bg:#1c1f24;--dmp-fg:#e7e9ec;--dmp-muted:#9aa0a8;--dmp-border:#34383f;
 --dmp-card:#24282e;--dmp-card-hover:#2b3036;--dmp-sel:#4f8cff;--dmp-chip:#2c3138;--dmp-track:#30343b}
.dmp-toolbar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dmp-border)}
.dmp-seg{display:flex;background:var(--dmp-track);border-radius:8px;padding:2px;gap:2px}
.dmp-seg button{border:0;background:transparent;color:var(--dmp-muted);border-radius:6px;
 padding:3px 10px;font-size:12px;cursor:pointer}
.dmp-seg button.dmp-on{background:var(--dmp-bg);color:var(--dmp-fg);box-shadow:0 1px 3px rgba(0,0,0,.18)}
.dmp-filter{flex:1;border:1px solid var(--dmp-border);border-radius:8px;background:transparent;
 color:var(--dmp-fg);padding:5px 9px;font-size:12px;outline:none;min-width:0}
.dmp-filter:focus{border-color:var(--dmp-sel)}
.dmp-grid{padding:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));
 gap:8px;overflow-y:auto;flex:1;min-height:0}
.dmp-card{position:relative;display:flex;flex-direction:column;gap:6px;padding:9px 10px 8px;
 border-radius:10px;border:1px solid var(--dmp-border);background:var(--dmp-card);cursor:pointer}
.dmp-card:hover{background:var(--dmp-card-hover)}
.dmp-card.dmp-sel{border-color:var(--dmp-sel);box-shadow:0 0 0 1px var(--dmp-sel)}
.dmp-card.dmp-off{opacity:.45;cursor:default}
.dmp-top{display:flex;align-items:center;gap:5px;min-height:14px}
.dmp-idx{font:10px/1 ui-monospace,Consolas,monospace;color:var(--dmp-muted);min-width:14px}
.dmp-dot{width:7px;height:7px;border-radius:50%;flex:none}
.dmp-free{font-size:9px;color:#16a34a;border:1px solid currentColor;border-radius:4px;padding:0 3px}
.dmp-prov{margin-left:auto;font-size:9px;color:var(--dmp-muted);background:var(--dmp-chip);
 border-radius:5px;padding:1px 6px;cursor:pointer;max-width:88px;overflow:hidden;
 text-overflow:ellipsis;white-space:nowrap;border:1px solid transparent}
.dmp-prov:hover{border-color:var(--dmp-border)}
.dmp-name{font-weight:700;line-height:1.15;word-break:break-word}
.dmp-ver{font-size:.62em;font-weight:600;color:var(--dmp-muted);vertical-align:super;margin-left:2px}
.dmp-var{font-size:.68em;font-weight:500;color:var(--dmp-muted);margin-left:4px}
.dmp-sub{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dmp-muted)}
.dmp-sub-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmp-eff{display:flex;gap:3px;margin-top:auto}
.dmp-eff button{flex:1;border:1px solid var(--dmp-border);border-radius:6px;background:transparent;
 color:var(--dmp-muted);font-size:10px;padding:2px 0;cursor:pointer;min-width:0;
 overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dmp-eff button:hover{color:var(--dmp-fg);border-color:var(--dmp-muted)}
.dmp-eff button.dmp-on{background:var(--dmp-sel);border-color:var(--dmp-sel);color:#fff}
.dmp-eff button:disabled{opacity:.4;cursor:default}
.dmp-togs{display:flex;gap:6px;flex:none;margin-left:auto}
.dmp-tog{display:inline-flex;align-items:center;gap:4px;border:0;background:transparent;
 color:var(--dmp-muted);font-size:10px;padding:0;cursor:pointer}
.dmp-tog-track{position:relative;width:17px;height:10px;border-radius:999px;flex:none;
 background:var(--dmp-track);border:1px solid var(--dmp-border);box-sizing:border-box}
.dmp-tog-knob{position:absolute;top:1px;left:1px;width:6px;height:6px;border-radius:50%;
 background:var(--dmp-muted)}
.dmp-tog.dmp-on .dmp-tog-track{background:var(--dmp-sel);border-color:var(--dmp-sel)}
.dmp-tog.dmp-on .dmp-tog-knob{left:8px;background:#fff}
.dmp-tog:disabled{opacity:.4;cursor:default}
.dmp-foot{padding:7px 12px;border-top:1px solid var(--dmp-border);font-size:11px;
 color:var(--dmp-muted);display:flex;align-items:center;gap:8px}
.dmp-empty{padding:24px;text-align:center;color:var(--dmp-muted);font-size:12px}
.dmp-pop{position:absolute;top:22px;right:8px;z-index:5;background:var(--dmp-bg);
 border:1px solid var(--dmp-border);border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.3);
 min-width:110px;padding:3px}
.dmp-pop button{display:block;width:100%;border:0;background:transparent;color:var(--dmp-fg);
 text-align:left;font-size:11px;padding:5px 8px;border-radius:6px;cursor:pointer}
.dmp-pop button:hover{background:var(--dmp-card-hover)}
.dmp-slots{display:flex;gap:6px;padding:8px 12px 0}
.dmp-slot{flex:1;border:1px solid var(--dmp-border);border-radius:8px;background:var(--dmp-chip);
 color:var(--dmp-muted);font-size:11px;padding:6px 9px;cursor:pointer;text-align:left;
 overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmp-slot.dmp-on{border-color:var(--dmp-sel);color:var(--dmp-fg)}
.dmp-slot b{display:block;font-size:9px;font-weight:600;color:var(--dmp-muted);letter-spacing:.04em}
.dmp-apply{margin-left:auto;border:0;border-radius:8px;background:var(--dmp-sel);color:#fff;
 font-size:12px;padding:6px 14px;cursor:pointer}
.dmp-apply:disabled{opacity:.45;cursor:default}
.dmp-err{font-size:11px;color:#ef4444}
.dmp-card.dmp-hid{opacity:.5}
.dmp-card[data-drop="before"]{box-shadow:-3px 0 0 0 var(--dmp-sel)}
.dmp-card[data-drop="after"]{box-shadow:3px 0 0 0 var(--dmp-sel)}
.dmp-card[data-drop="swap"]{outline:2px dashed var(--dmp-sel);outline-offset:-2px}
.dmp-card.dmp-drag{opacity:.5}
.dmp-star{font-size:10px;color:#f5a623;flex:none}
.dmp-rename{font:700 16px/1.15 inherit;color:inherit;border:1px solid var(--dmp-sel);border-radius:4px;
 background:var(--dmp-bg);padding:0 3px;min-width:0;width:100%;box-sizing:border-box}
.dmp-menu{position:absolute;z-index:20;min-width:150px;background:var(--dmp-bg);
 border:1px solid var(--dmp-border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);padding:3px}
.dmp-menu button{display:block;width:100%;border:0;background:transparent;color:var(--dmp-fg);
 text-align:left;font-size:12px;padding:5px 10px;border-radius:6px;cursor:pointer}
.dmp-menu button:hover{background:var(--dmp-card-hover)}
.dmp-menu button.dmp-danger{color:#ef4444}
.dmp-showhidden{border:1px solid var(--dmp-border);border-radius:6px;background:transparent;
 color:var(--dmp-muted);font-size:11px;padding:2px 8px;cursor:pointer}
.dmp-status{font-size:11px;color:var(--dmp-muted)}
.dmp-btn{white-space:nowrap;flex:none;border:0;border-radius:7px;background:var(--dmp-sel);color:#fff;font-size:12px;
 padding:6px 12px;cursor:pointer}
.dmp-btn:disabled{opacity:.45;cursor:default}
.dmp-btn.sec{background:var(--dmp-chip);color:var(--dmp-fg)}
.dmp-btn.danger{background:#dc2626;color:#fff}
/* --- Providers tab --- */
.dmp-provtab{flex:1;min-height:0;display:none;overflow:hidden}
.dmp-panel.dmp-mode-prov .dmp-provtab{display:flex}
.dmp-panel.dmp-mode-prov .dmp-grid{display:none}
.dmp-panel.dmp-mode-prov .dmp-filter{display:none}
.dmp-plist{width:172px;flex:none;overflow-y:auto;border-right:1px solid var(--dmp-border);padding:6px}
.dmp-pitem{display:block;width:100%;text-align:left;border:0;background:transparent;
 color:var(--dmp-fg);padding:7px 8px;border-radius:8px;cursor:pointer;font-size:12px}
.dmp-pitem:hover{background:var(--dmp-card-hover)}
.dmp-pitem.dmp-on{background:var(--dmp-chip);outline:1px solid var(--dmp-sel)}
.dmp-pitem .cnt{color:var(--dmp-muted);font-size:10px;margin-left:4px}
.dmp-pitem.dmp-additem{color:var(--dmp-muted);border:1px dashed var(--dmp-border);margin-top:6px;text-align:center}
.dmp-pitem.dmp-additem:hover{color:var(--dmp-fg)}
.dmp-fmt{font-size:9px;color:var(--dmp-muted);border:1px solid var(--dmp-border);
 border-radius:4px;padding:0 4px;margin-left:5px;white-space:nowrap}
.dmp-pdetail{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.dmp-pd-head{padding:10px 12px 6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
 border-bottom:1px solid var(--dmp-border)}
.dmp-pd-name{font-size:13px;font-weight:600;cursor:text}
.dmp-pd-url{font-size:10px;color:var(--dmp-muted);overflow:hidden;text-overflow:ellipsis;
 white-space:nowrap;max-width:100%}
.dmp-pd-acts{margin-left:auto;display:flex;gap:6px}
.dmp-pd-tools{display:flex;gap:6px;align-items:center;padding:8px 12px;flex-wrap:wrap}
.dmp-pd-tools input[type=text]{flex:1;min-width:80px}
.dmp-chip-btn{border:1px solid var(--dmp-border);border-radius:10px;background:transparent;
 color:var(--dmp-muted);font-size:10px;padding:2px 8px;cursor:pointer}
.dmp-chip-btn.dmp-on{color:var(--dmp-fg);border-color:var(--dmp-sel);background:var(--dmp-chip)}
.dmp-mlist{flex:1;min-height:0;overflow-y:auto;padding:4px 12px}
.dmp-mrow{display:flex;align-items:center;gap:8px;padding:5px 4px;border-radius:6px}
.dmp-mrow:hover{background:var(--dmp-card-hover)}
.dmp-mrow .lbl{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmp-mrow .mid{color:var(--dmp-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;
 white-space:nowrap;max-width:40%}
.dmp-mrow .meta{color:var(--dmp-muted);font-size:10px;margin-left:auto;white-space:nowrap}
.dmp-missing{font-size:9px;color:#d97706;border:1px solid #d9770655;border-radius:4px;
 padding:0 4px;white-space:nowrap}
.dmp-msw{flex:none;width:26px;height:15px;border-radius:8px;background:var(--dmp-chip);
 border:1px solid var(--dmp-border);position:relative;cursor:pointer;padding:0}
.dmp-msw .k{position:absolute;top:1px;left:1px;width:11px;height:11px;border-radius:50%;
 background:var(--dmp-muted);transition:left .12s}
.dmp-msw.dmp-on{background:var(--dmp-sel);border-color:var(--dmp-sel)}
.dmp-msw.dmp-on .k{left:12px;background:#fff}
.dmp-pdetail input[type=text],.dmp-pdetail input[type=password],.dmp-pdetail select{
 border:1px solid var(--dmp-border);border-radius:7px;background:var(--dmp-bg);
 color:var(--dmp-fg);padding:5px 8px;font-size:12px;outline:none}
.dmp-pdetail input:focus,.dmp-pdetail select:focus{border-color:var(--dmp-sel)}
.dmp-pd-form{padding:14px 12px;display:flex;flex-direction:column;gap:8px;max-width:340px}
.dmp-lab{font-size:11px;color:var(--dmp-muted);display:block;margin-bottom:2px}
@media (prefers-reduced-motion:reduce){.dmp-panel{transition:none}}
`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// React fiber plumbing -------------------------------------------------------
function propKey(node, prefix) {
  for (const key of Object.keys(node)) if (key.startsWith(prefix)) return key;
  return null;
}
function fiberOf(node) {
  const fKey = propKey(node, '__reactFiber$'), pKey = propKey(node, '__reactProps$');
  if (!fKey || !pKey) return null;
  const props = node[pKey], fiber = node[fKey];
  for (const candidate of [fiber, fiber && fiber.alternate]) {
    if (candidate && candidate.memoizedProps === props) return candidate;
  }
  return fiber || null;
}
// Walk .return to find the host (onModelSelect + visibleModelConfigs) and the
// LocalModelPicker root (value + onSelect). Matched by prop names only.
function locate(fiber) {
  let host = null, rootPicker = null, current = fiber, depth = 0;
  while (current && depth++ < 40 && !(host && rootPicker)) {
    const props = current.memoizedProps;
    if (props && typeof props === 'object') {
      if (!host && Array.isArray(props.visibleModelConfigs) && typeof props.onModelSelect === 'function') host = props;
      if (!rootPicker && typeof props.onSelect === 'function' &&
          ('value' in props || 'modelConfig' in props) && props.modelConfig !== undefined) rootPicker = props;
    }
    current = current.return;
  }
  return host ? { host, root: rootPicker } : null;
}
function locateTrigger(button) {
  const fiber = fiberOf(button);
  return fiber ? locate(fiber) : null;
}

// Backend --------------------------------------------------------------------
let lastState = null;
async function fetchState() {
  try {
    const response = await fetch(API_BASE + '/picker/state', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (response.ok) lastState = await response.json();
  } catch {}
  return lastState;
}
async function postFusion(body) {
  const response = await fetch(API_BASE + '/picker/fusion', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, ...data };
}

// Provider choice persistence ------------------------------------------------
function savedProviders() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}').provider || {}; } catch { return {}; }
}
function saveProvider(key, providerName) {
  try {
    const data = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    data.provider = { ...(data.provider || {}), [key]: providerName };
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {}
}

// Unapplied fusion picks survive across opens: { lead, sidekick } refs only.
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}').fusionDraft || null; } catch { return null; }
}
function saveDraft() {
  try {
    const data = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const slots = panelState?.fusionSlots || {};
    data.fusionDraft = { lead: slots.lead || null, sidekick: slots.sidekick || null };
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {}
}

// Card preferences (order/favorites/hidden/aliases) live in the same LS object.
function loadPrefs() {
  try { return sanitizePrefs(JSON.parse(localStorage.getItem(LS_KEY) || '{}').prefs); } catch { return sanitizePrefs(null); }
}
function savePrefs() {
  try {
    const data = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    data.prefs = panelState?.prefs || sanitizePrefs(null);
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {}
}
function prefAlias(key) { return panelState?.prefs?.aliases?.[key] || null; }

// Panel ----------------------------------------------------------------------
let styleNode = null;
let panel = null;
let panelState = null; // { trigger, located, mode, filter, fusionSlots, activeSlot }
let observer = null;

function ensureStyle() {
  if (styleNode) return;
  styleNode = document.createElement('style');
  styleNode.textContent = CSS;
  document.head.appendChild(styleNode);
}

// Theme: relative luminance of the first mostly-opaque ancestor background
// (translucent overlays like rgba(255,255,255,.05) say nothing about the theme)
// walking up from the trigger (Devin's workbench body has no .dark class).
function isDark(anchor) {
  try {
    let node = anchor || document.body;
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(bg || '');
      if (match && (match[4] === undefined || Number(match[4]) >= 0.5)) {
        const lum = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
        return lum < 0.5;
      }
      if (node === document.documentElement) break;
      node = node.parentElement || null;
    }
  } catch {}
  return document.body?.classList.contains('dark')
    || document.documentElement?.classList.contains('dark')
    || !!document.querySelector('.monaco-workbench.vs-dark, .monaco-workbench.hc-black');
}

function currentValue(located) { return located?.root?.value; }

// Select through the freshly located host (props die with each React render),
// keep the panel open, optimistically update our copy of the current value,
// then re-read it from live props once React has settled.
function selectModel(uid) {
  if (!panelState) return;
  if (panelState.trigger?.isConnected) {
    const fresh = locateTrigger(panelState.trigger);
    if (fresh) panelState.located = fresh;
  }
  try { panelState.located?.host.onModelSelect({ modelUid: uid }); } catch {}
  panelState.value = uid;
  panelState.pendingUid = uid;
  rerenderGrid();
  // Existing sessions switch only after the ACP round-trip: keep the optimistic
  // value until live props confirm it, and accept whatever is live at the end.
  for (const delay of [60, 300, 1000]) setTimeout(() => refreshLocated(false), delay);
  setTimeout(() => refreshLocated(true), 2500);
}

// Re-walk the trigger's fiber chain — rebinding to a replacement trigger when
// React detached ours — and sync value/located from live props.
function refreshLocated(final) {
  if (!panel || !panelState) return;
  let trigger = panelState.trigger;
  if (!trigger?.isConnected) {
    trigger = [...document.querySelectorAll('button[aria-haspopup="menu"][data-dmp-bound]')]
      .find(button => button.isConnected && locateTrigger(button)) || null;
    if (!trigger) return;
    panelState.trigger = trigger;
  }
  const located = locateTrigger(trigger);
  if (!located) return;
  panelState.located = located;
  const live = currentValue(located);
  if (panelState.pendingUid && live !== panelState.pendingUid && !final) return;
  panelState.pendingUid = null;
  if (live === panelState.value) return;
  panelState.value = live;
  rerenderGrid();
}

// --- Context menu, drag & drop, rename --------------------------------------

function openMenu(x, y, items) {
  closeMenu();
  const menu = el('div', 'dmp-menu');
  for (const item of items) {
    const btn = el('button', item.danger ? 'dmp-danger' : '', item.label);
    btn.addEventListener('click', event => { event.stopPropagation(); closeMenu(); item.action(); });
    menu.appendChild(btn);
  }
  panel.appendChild(menu);
  const pr = panel.getBoundingClientRect(), mr = menu.getBoundingClientRect();
  let left = x - pr.left, top = y - pr.top;
  if (left + mr.width > pr.width - 4) left = pr.width - mr.width - 4;
  if (top + mr.height > pr.height - 4) top = pr.height - mr.height - 4;
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top = Math.max(4, top) + 'px';
  panelState.menu = menu;
  // A scroll already applied before the menu opened may deliver its scroll
  // event afterwards — only close when the position actually changes again.
  panelState.menuScroll = panel.querySelector('.dmp-grid')?.scrollTop ?? 0;
}
function closeMenu() {
  if (!panelState) return;
  panelState.menu?.remove();
  panelState.menu = null;
}

function commitRename(key, value) {
  const alias = (value || '').trim().slice(0, 40);
  if (alias) panelState.prefs.aliases[key] = alias; else delete panelState.prefs.aliases[key];
  panelState.editing = null;
  savePrefs();
  rerenderGrid();
}

function cardMenuItems(card, resolveUid) {
  const prefs = panelState.prefs;
  const key = card.prefKey;
  const items = [
    { label: card.favorite ? '取消收藏' : '收藏', action: () => {
      prefs.favorites = toggleKey(prefs.favorites, key); savePrefs(); rerenderGrid(); } },
    { label: '移到最前', action: () => {
      const base = prefs.order.includes(key) ? prefs.order : [...prefs.order, key];
      prefs.order = moveCardKey(base, key, 'first'); savePrefs(); rerenderGrid(); } },
    { label: '移到最后', action: () => {
      const base = prefs.order.includes(key) ? prefs.order : [...prefs.order, key];
      prefs.order = moveCardKey(base, key, 'last'); savePrefs(); rerenderGrid(); } },
    { label: '重命名', action: () => { panelState.editing = key; rerenderGrid(); } },
  ];
  if (prefs.aliases[key]) items.push({ label: '恢复原名', action: () => {
    delete prefs.aliases[key]; savePrefs(); rerenderGrid(); } });
  const uid = resolveUid();
  if (uid) items.push({ label: '复制模型 ID', action: () => {
    try { navigator.clipboard?.writeText(uid)?.catch?.(() => {}); } catch {} } });
  items.push({ label: card.hidden ? '取消隐藏' : '隐藏', action: () => {
    const hiding = !prefs.hidden.includes(key);
    prefs.hidden = hiding ? [...prefs.hidden, key] : prefs.hidden.filter(entry => entry !== key);
    savePrefs(); rerenderGrid();
    const byokFams = (card.families || []).filter(family => family.providerId);
    if (hiding && byokFams.length) {
      for (const family of byokFams) {
        pickerPost('/picker/models/enabled', { providerId: family.providerId,
          modelIds: [family.modelId], enabled: false }).catch(() => {});
      }
      panelState.status = '已隐藏，正在刷新…';
      renderFoot();
      pollForRefresh();
      refreshProviders();
    }
  } });
  const byokInfo = card.providerId ? card
    : (card.families || []).find(family => family.providerId) || null;
  if (byokInfo) {
    items.push({ label: '管理供应商…', action: () => {
      panelState.provSel = byokInfo.providerId;
      panelState.setMode('providers');
    } });
  }
  return items;
}

// Shared card chrome: context menu + 3-zone HTML5 drag reorder (same group only).
function wireCardChrome(node, card, index, resolveUid) {
  node.addEventListener('contextmenu', event => {
    event.preventDefault(); event.stopPropagation();
    openMenu(event.clientX, event.clientY, cardMenuItems(card, resolveUid));
  });
  node.draggable = true;
  node.addEventListener('dragstart', event => {
    if (panelState.editing) { event.preventDefault(); return; }
    panelState.dragIndex = index;
    panelState.dragCard = card;
    node.classList.add('dmp-drag');
    try { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', card.prefKey); } catch {}
  });
  node.addEventListener('dragend', () => {
    panelState.dragIndex = null;
    panelState.dragCard = null;
    node.classList.remove('dmp-drag');
    for (const marked of panel.querySelectorAll('[data-drop]')) marked.removeAttribute('data-drop');
    panelState.suppressClick = true;
    setTimeout(() => { if (panelState) panelState.suppressClick = false; }, 80);
  });
  node.addEventListener('dragover', event => {
    const src = panelState.dragCard;
    if (!src || src === card || src.favorite !== card.favorite) { node.removeAttribute('data-drop'); return; }
    event.preventDefault();
    const rect = node.getBoundingClientRect();
    node.setAttribute('data-drop', dropModeFromRatio((event.clientX - rect.left) / Math.max(1, rect.width)));
  });
  node.addEventListener('dragleave', () => node.removeAttribute('data-drop'));
  node.addEventListener('drop', event => {
    event.preventDefault();
    const src = panelState.dragCard;
    const rect = node.getBoundingClientRect();
    node.removeAttribute('data-drop');
    if (!src || src === card || src.favorite !== card.favorite || panelState.dragIndex == null) return;
    const mode = dropModeFromRatio((event.clientX - rect.left) / Math.max(1, rect.width));
    const keys = (panelState.visibleCards || []).map(item => item.prefKey);
    const toIndex = keys.indexOf(card.prefKey);
    if (toIndex < 0) return;
    panelState.prefs.order = mergeSubsetOrder(panelState.fullKeys || keys,
      applyCardDrop(keys, panelState.dragIndex, toIndex, mode));
    savePrefs();
    rerenderGrid();
  });
}

function renameField(card, nameRow) {
  const input = el('input', 'dmp-rename');
  input.value = prefAlias(card.prefKey) || card.name;
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') commitRename(card.prefKey, input.value);
    else if (event.key === 'Escape' && panelState) { panelState.editing = null; rerenderGrid(); }
  });
  input.addEventListener('blur', () => {
    if (panelState?.editing === card.prefKey) commitRename(card.prefKey, input.value);
  });
  nameRow.appendChild(input);
  setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 0);
}

// --- BYOK provider API ------------------------------------------------------

async function pickerPost(path, body) {
  const res = await fetch(API_BASE + path, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.error) return { error: 'http_' + res.status, message: '\u672c\u5730\u670d\u52a1\u9519\u8bef' };
  return data;
}

// After a write, the catalog updates once config.json has propagated to the
// host — poll until every BYOK uid is visible again (or ~10s pass).
async function pollForRefresh() {
  const deadline = Date.now() + 10000;
  while (panelState && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    await fetchState();
    refreshLocated();
    const visible = new Set((panelState?.located?.host?.visibleModelConfigs || []).map(model => model.modelUid));
    if (!Object.keys(lastState?.byok || {}).some(uid => !visible.has(uid))) break;
  }
  if (!panelState) return;
  panelState.status = '';
  renderFoot();
  rerenderGrid();
}

async function refreshProviders() {
  try {
    const res = await fetch(API_BASE + '/picker/providers');
    const data = await res.json();
    if (panelState) panelState.providers = data.providers || [];
  } catch { /* keep the stale list */ }
  renderProviders();
}

function afterCatalogEdit(message) {
  if (!panelState) return;
  panelState.status = message;
  renderFoot();
  pollForRefresh();
}

// --- Providers tab -----------------------------------------------------------

const FMT_LABEL = { 'openai-responses': 'Responses', openai: 'Chat', anthropic: 'Anthropic' };
const fmtLabel = format => FMT_LABEL[format] || format || '';

function devinCards() {
  const models = panelState?.located?.host?.visibleModelConfigs || [];
  const hidden = new Set(panelState?.prefs?.hidden || []);
  const cards = groupCards(models, lastState)
    .map(card => ({ ...card, families: card.families.filter(family => !family.providerId) }))
    .filter(card => card.families.length);
  return { cards, hidden };
}

function renderProviders() {
  if (!panel || !panelState || panelState.mode !== 'providers') return;
  const tab = panel.querySelector('.dmp-provtab');
  if (!tab) return;
  tab.replaceChildren();
  const list = el('div', 'dmp-plist');
  const detail = el('div', 'dmp-pdetail');
  tab.appendChild(list);
  tab.appendChild(detail);
  const sel = panelState.provSel;
  const devins = devinCards();
  const devShown = devins.cards.filter(card => !devins.hidden.has(card.prefKey)).length;
  const devItem = el('button', 'dmp-pitem' + (sel === 'devin' ? ' dmp-on' : ''));
  devItem.appendChild(el('span', '', '\u0044evin'));
  devItem.appendChild(el('span', 'cnt', devShown + '/' + devins.cards.length));
  devItem.addEventListener('click', () => { panelState.provSel = 'devin'; panelState.provEdit = null; panelState.provError = ''; renderProviders(); });
  list.appendChild(devItem);
  for (const provider of panelState.providers || []) {
    const shown = (provider.models || []).filter(model => model.enabled).length;
    const item = el('button', 'dmp-pitem' + (sel === provider.id ? ' dmp-on' : ''));
    item.appendChild(el('span', '', provider.name));
    item.appendChild(el('span', 'cnt', shown + '/' + (provider.models || []).length));
    item.appendChild(el('span', 'dmp-fmt', fmtLabel(provider.apiFormat)));
    item.addEventListener('click', () => {
      panelState.provSel = provider.id;
      panelState.provEdit = null;
      panelState.provConfirmDelete = false;
      panelState.provError = '';
      renderProviders();
    });
    list.appendChild(item);
  }
  const addItem = el('button', 'dmp-pitem dmp-additem' + (sel === 'add' ? ' dmp-on' : ''), '+ \u6dfb\u52a0\u4f9b\u5e94\u5546');
  addItem.addEventListener('click', () => { panelState.provSel = 'add'; panelState.provError = ''; renderProviders(); });
  list.appendChild(addItem);
  if (panelState.provError) detail.appendChild(el('div', 'dmp-err', panelState.provError));
  if (sel === 'add') renderProvAdd(detail);
  else if (sel === 'devin') renderDevinDetail(detail, devins);
  else {
    const provider = (panelState.providers || []).find(item => item.id === sel);
    if (!provider) { panelState.provSel = 'devin'; renderProviders(); return; }
    renderProvDetail(detail, provider);
  }
}

// Shared model-switch list: search, bulk show/hide of filtered rows, count and
// an only-shown chip. items: [{ key, on, label, sub, meta, missing }].
function renderModelList(box, items, { toggle, bulk }) {
  const tools = el('div', 'dmp-pd-tools');
  const search = el('input', '');
  search.type = 'text';
  search.placeholder = '\u7b5b\u9009\u6a21\u578b';
  search.value = panelState.provSearch || '';
  const listEl = el('div', 'dmp-mlist');
  const err = el('div', 'dmp-err');
  const matches = item => {
    const norm = filterNorm(panelState.provSearch || '');
    return !norm || filterNorm(item.label + ' ' + (item.sub || '')).includes(norm);
  };
  const count = el('span', 'dmp-status');
  const fill = () => {
    listEl.replaceChildren();
    const visible = items.filter(item => matches(item) && (!panelState.provOnlyShown || item.on));
    for (const item of visible) {
      const row = el('div', 'dmp-mrow');
      const sw = el('button', 'dmp-msw' + (item.on ? ' dmp-on' : ''));
      sw.appendChild(el('span', 'k'));
      sw.setAttribute('aria-pressed', String(item.on));
      sw.addEventListener('click', () => toggle(item, sw));
      row.appendChild(sw);
      row.appendChild(el('span', 'lbl', item.label));
      if (item.sub) row.appendChild(el('span', 'mid', item.sub));
      if (item.missing) row.appendChild(el('span', 'dmp-missing', '\u4e0a\u6e38\u672a\u5217\u51fa'));
      if (item.meta) row.appendChild(el('span', 'meta', item.meta));
      listEl.appendChild(row);
    }
    if (!visible.length) listEl.appendChild(el('div', 'dmp-empty', '\u6ca1\u6709\u5339\u914d\u7684\u6a21\u578b'));
    count.textContent = '\u5df2\u663e\u793a ' + items.filter(item => item.on).length + ' / ' + items.length;
  };
  search.addEventListener('input', () => { panelState.provSearch = search.value; fill(); });
  const showBtn = el('button', 'dmp-btn sec', '\u663e\u793a\u7b5b\u9009\u7ed3\u679c');
  showBtn.addEventListener('click', () => bulk(items.filter(matches).map(item => item.key), true, err));
  const hideBtn = el('button', 'dmp-btn sec', '\u9690\u85cf\u7b5b\u9009\u7ed3\u679c');
  hideBtn.addEventListener('click', () => bulk(items.filter(matches).map(item => item.key), false, err));
  const only = el('button', 'dmp-chip-btn' + (panelState.provOnlyShown ? ' dmp-on' : ''), '\u53ea\u770b\u5df2\u663e\u793a');
  only.addEventListener('click', () => { panelState.provOnlyShown = !panelState.provOnlyShown; fill(); });
  tools.appendChild(search);
  tools.appendChild(showBtn);
  tools.appendChild(hideBtn);
  tools.appendChild(only);
  tools.appendChild(count);
  box.appendChild(tools);
  box.appendChild(listEl);
  box.appendChild(err);
  fill();
}

function renderProvAdd(box) {
  const form = el('div', 'dmp-pd-form');
  form.appendChild(el('label', 'dmp-lab', 'API \u5730\u5740'));
  const url = el('input', '');
  url.type = 'text';
  url.placeholder = 'https://api.example.com';
  form.appendChild(url);
  form.appendChild(el('label', 'dmp-lab', 'API Key'));
  const key = el('input', '');
  key.type = 'password';
  form.appendChild(key);
  const err = el('div', 'dmp-err');
  const submit = el('button', 'dmp-btn', '\u8fde\u63a5');
  const connect = async () => {
    err.textContent = '';
    submit.disabled = true;
    submit.textContent = '\u8fde\u63a5\u4e2d\u2026';
    const res = await pickerPost('/picker/providers/connect',
      { baseUrl: url.value, apiKey: key.value })
      .catch(() => ({ error: 'service_unavailable', message: '\u672c\u5730\u670d\u52a1\u672a\u5c31\u7eea' }));
    submit.disabled = false;
    submit.textContent = '\u8fde\u63a5';
    if (!panelState) return;
    if (res.error) { err.textContent = res.message || '\u8fde\u63a5\u5931\u8d25'; return; }
    panelState.provSel = res.provider.id;
    await refreshProviders();
    afterCatalogEdit('\u5df2\u8fde\u63a5 ' + res.provider.name + '\uff0c\u6b63\u5728\u5237\u65b0\u2026');
  };
  submit.addEventListener('click', connect);
  key.addEventListener('keydown', event => { if (event.key === 'Enter') connect(); });
  form.appendChild(submit);
  form.appendChild(err);
  box.appendChild(form);
}

function renderProvDetail(box, provider) {
  const head = el('div', 'dmp-pd-head');
  if (panelState.provEdit === 'rename') {
    const input = el('input', '');
    input.type = 'text';
    input.value = provider.name;
    const commit = async () => {
      const name = input.value.trim();
      panelState.provEdit = null;
      if (!name || name === provider.name) { renderProviders(); return; }
      const res = await pickerPost('/picker/providers/update', { id: provider.id, name });
      if (res.error) panelState.provError = res.message;
      await refreshProviders();
    };
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') commit();
      else if (event.key === 'Escape') { panelState.provEdit = null; renderProviders(); }
    });
    input.addEventListener('blur', commit);
    head.appendChild(input);
    setTimeout(() => { try { input.focus(); input.select(); } catch {} }, 0);
  } else {
    const name = el('span', 'dmp-pd-name', provider.name);
    name.title = '\u70b9\u51fb\u91cd\u547d\u540d';
    name.addEventListener('click', () => { panelState.provEdit = 'rename'; renderProviders(); });
    head.appendChild(name);
  }
  const fmt = el('select', '');
  for (const [value, label] of [['openai-responses', 'Responses'], ['openai', 'Chat'], ['anthropic', 'Anthropic']]) {
    const option = el('option', '', label);
    option.value = value;
    if (provider.apiFormat === value) option.selected = true;
    fmt.appendChild(option);
  }
  fmt.addEventListener('change', async () => {
    const res = await pickerPost('/picker/providers/update', { id: provider.id, apiFormat: fmt.value });
    if (res.error) panelState.provError = res.message || '\u66f4\u65b0\u5931\u8d25';
    await refreshProviders();
    afterCatalogEdit('\u5df2\u66f4\u65b0\u63a5\u53e3\u7c7b\u578b\uff0c\u6b63\u5728\u5237\u65b0\u2026');
  });
  head.appendChild(fmt);
  const acts = el('div', 'dmp-pd-acts');
  const refresh = el('button', 'dmp-btn sec', '\u5237\u65b0\u6a21\u578b');
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    refresh.textContent = '\u5237\u65b0\u4e2d\u2026';
    const res = await pickerPost('/picker/providers/refresh', { id: provider.id })
      .catch(() => ({ error: 'service_unavailable', message: '\u672c\u5730\u670d\u52a1\u672a\u5c31\u7eea' }));
    if (!panelState) return;
    if (res.error) { refresh.disabled = false; refresh.textContent = '\u5237\u65b0\u6a21\u578b'; panelState.provError = res.message; renderProviders(); return; }
    await refreshProviders();
    afterCatalogEdit('\u5df2\u5237\u65b0\u6a21\u578b\u5217\u8868\uff0c\u6b63\u5728\u66f4\u65b0\u2026');
  });
  acts.appendChild(refresh);
  if (panelState.provEdit === 'key') {
    const keyInput = el('input', '');
    keyInput.type = 'password';
    keyInput.placeholder = '\u65b0 API Key';
    const saveKey = async () => {
      panelState.provEdit = null;
      const res = await pickerPost('/picker/providers/update', { id: provider.id, apiKey: keyInput.value });
      if (res.error) panelState.provError = res.message;
      await refreshProviders();
    };
    keyInput.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') saveKey();
      else if (event.key === 'Escape') { panelState.provEdit = null; renderProviders(); }
    });
    const saveBtn = el('button', 'dmp-btn sec', '\u4fdd\u5b58');
    saveBtn.addEventListener('click', saveKey);
    acts.appendChild(keyInput);
    acts.appendChild(saveBtn);
    setTimeout(() => { try { keyInput.focus(); } catch {} }, 0);
  } else {
    const keyBtn = el('button', 'dmp-btn sec', '\u66f4\u6362 Key');
    keyBtn.addEventListener('click', () => { panelState.provEdit = 'key'; renderProviders(); });
    acts.appendChild(keyBtn);
  }
  const del = el('button', 'dmp-btn danger', panelState.provConfirmDelete ? '\u786e\u8ba4\u5220\u9664' : '\u5220\u9664');
  del.addEventListener('click', async () => {
    if (!panelState.provConfirmDelete) { panelState.provConfirmDelete = true; renderProviders(); return; }
    panelState.provConfirmDelete = false;
    panelState.provSel = 'devin';
    const res = await pickerPost('/picker/providers/delete', { id: provider.id })
      .catch(() => ({ error: 'service_unavailable', message: '\u672c\u5730\u670d\u52a1\u672a\u5c31\u7eea' }));
    if (!panelState) return;
    if (res.error) { panelState.provSel = provider.id; panelState.provError = res.message; renderProviders(); return; }
    await refreshProviders();
    afterCatalogEdit('\u5df2\u5220\u9664\u4f9b\u5e94\u5546\uff0c\u6b63\u5728\u5237\u65b0\u2026');
  });
  acts.appendChild(del);
  head.appendChild(acts);
  box.appendChild(head);
  const urlLine = el('div', 'dmp-pd-url', provider.baseUrl || '');
  urlLine.style.padding = '6px 12px 0';
  box.appendChild(urlLine);
  const items = (provider.models || []).map(model => ({
    key: model.id, on: model.enabled !== false, label: model.label || model.id,
    sub: model.id, missing: model.missing === true,
    meta: [model.contextWindow ? Math.round(model.contextWindow / 1000) + 'k' : null,
      ...(model.efforts || []).filter(Boolean).map(effortLabel)].filter(Boolean).join(' \u00b7 '),
  }));
  renderModelList(box, items, {
    async toggle(item, sw) {
      item.on = !item.on;
      sw.classList.toggle('dmp-on', item.on);
      const res = await pickerPost('/picker/models/enabled',
        { providerId: provider.id, modelIds: [item.key], enabled: item.on })
        .catch(() => ({ error: 'service_unavailable', message: '\u672c\u5730\u670d\u52a1\u672a\u5c31\u7eea' }));
      if (res.error) {
        item.on = !item.on;
        sw.classList.toggle('dmp-on', item.on);
        panelState.provError = res.message || '\u66f4\u65b0\u5931\u8d25';
        renderProviders();
        return;
      }
      refreshProviders();
      panelState.status = '\u6b63\u5728\u5237\u65b0\u2026';
      renderFoot();
      pollForRefresh();
    },
    async bulk(keys, show, err) {
      if (!keys.length) return;
      const res = await pickerPost('/picker/models/enabled',
        { providerId: provider.id, modelIds: keys, enabled: show })
        .catch(() => ({ error: 'service_unavailable', message: '\u672c\u5730\u670d\u52a1\u672a\u5c31\u7eea' }));
      if (res.error) { err.textContent = res.message || '\u66f4\u65b0\u5931\u8d25'; return; }
      for (const item of items) if (keys.includes(item.key)) item.on = show;
      refreshProviders();
      panelState.status = '\u6b63\u5728\u5237\u65b0\u2026';
      renderFoot();
      pollForRefresh();
    },
  });
}

function renderDevinDetail(box, devins) {
  box.appendChild(el('div', 'dmp-pd-head', 'Devin \u81ea\u5e26\u6a21\u578b'));
  const items = devins.cards.map(card => ({
    key: card.prefKey, on: !devins.hidden.has(card.prefKey),
    label: (prefAlias(card.prefKey) || card.name) + (card.version ? ' ' + card.version : '') + (card.variant ? ' ' + card.variant : ''),
    sub: card.families[0]?.familyLabel || card.prefKey,
    meta: (card.families[0]?.cells || []).map(cell => cell.label).join(' \u00b7 '),
  }));
  renderModelList(box, items, {
    toggle(item) {
      item.on = !item.on;
      panelState.prefs.hidden = item.on
        ? panelState.prefs.hidden.filter(key => key !== item.key)
        : [...new Set([...panelState.prefs.hidden, item.key])];
      savePrefs();
      renderProviders();
    },
    bulk(keys, show) {
      const set = new Set(panelState.prefs.hidden);
      for (const key of keys) { if (show) set.delete(key); else set.add(key); }
      panelState.prefs.hidden = [...set];
      savePrefs();
      renderProviders();
    },
  });
}

function chooseFamily(card, located) {
  const saved = savedProviders();
  const wanted = saved[card.cardKey];
  const index = card.families.findIndex(family => family.providerName === wanted);
  return card.families[index >= 0 ? index : 0];
}

// Per-card local state: which effort + toggles the card would select. The
// current family mirrors the live variant; others start from their default.
function cardStateFor(card, family) {
  const key = card.cardKey + '|' + (family.providerName || '');
  if (!panelState.cardStates.has(key)) {
    const value = panelState.value;
    const live = family.variants.find(variant => variant.uid === value);
    const def = live || defaultVariant(family);
    panelState.cardStates.set(key, {
      effortOrder: def?.effortOrder ?? family.cells[0]?.order ?? null,
      toggles: Object.fromEntries((family.toggles || []).map(tk => [tk, def?.toggles?.[tk] ?? 0])),
    });
  }
  return panelState.cardStates.get(key);
}

function buildCard(card, index, located) {
  const family = chooseFamily(card, located);
  const node = el('div', 'dmp-card');
  node.setAttribute('data-dmp-key', card.cardKey);
  const value = panelState.value;
  const allUids = card.families.flatMap(item => item.variants.map(variant => variant.uid));
  const selected = allUids.includes(value);
  if (selected) node.classList.add('dmp-sel');
  const enabledVariants = family.variants.filter(variant => !variant.disabled);
  const cardDisabled = enabledVariants.length === 0;
  if (cardDisabled) { node.classList.add('dmp-off'); node.title = family.variants[0]?.disabledReason || ''; }
  if (card.hidden) node.classList.add('dmp-hid');
  const live = family.variants.find(variant => variant.uid === value);
  const cardState = cardStateFor(card, family);
  if (live) {
    // The current family mirrors the live variant's effort + toggles.
    cardState.effortOrder = live.effortOrder ?? cardState.effortOrder;
    for (const key of family.toggles || []) cardState.toggles[key] = live.toggles?.[key] ?? 0;
  }

  const top = el('div', 'dmp-top');
  top.appendChild(el('span', 'dmp-idx', String(index + 1).padStart(2, '0')));
  const dot = el('span', 'dmp-dot');
  dot.style.background = VENDORS[family.vendor] || VENDORS.other;
  top.appendChild(dot);
  if (family.free) top.appendChild(el('span', 'dmp-free', '免费'));
  if (card.favorite) top.appendChild(el('span', 'dmp-star', '★'));
  const chip = el('button', 'dmp-prov', family.providerName || 'Devin');
  chip.title = card.families.length > 1 ? '切换供应商' : '';
  top.appendChild(chip);
  node.appendChild(top);

  const displayName = prefAlias(card.prefKey) || card.name;
  const nameRow = el('div');
  const nameSize = displayName.length <= 6 ? 22 : displayName.length <= 8 ? 19 : 16;
  if (panelState.editing === card.prefKey) renameField(card, nameRow);
  else {
    const nameEl = el('span', 'dmp-name', displayName);
    nameEl.style.fontSize = nameSize + 'px';
    nameRow.appendChild(nameEl);
    if (card.version) nameRow.appendChild(el('span', 'dmp-ver', card.version));
    if (card.variant) nameRow.appendChild(el('span', 'dmp-var', card.variant));
  }
  node.appendChild(nameRow);

  const sub = el('div', 'dmp-sub');
  sub.appendChild(el('span', 'dmp-sub-txt', (family.familyLabel || card.name) + ' · ' + (family.providerName || 'Devin')));
  if ((family.toggles || []).length) sub.appendChild(toggleSwitches(family, cardState, cardDisabled, target => {
    if (live && target) selectModel(target.uid); else rerenderGrid();
  }));
  node.appendChild(sub);

  if (family.cells.length) {
    const eff = el('div', 'dmp-eff');
    for (const cell of family.cells) {
      const btn = el('button', '', cell.label || '?');
      const active = live ? live.effortOrder === cell.order : cardState.effortOrder === cell.order;
      if (active) btn.classList.add('dmp-on');
      btn.addEventListener('click', event => {
        event.stopPropagation();
        cardState.effortOrder = cell.order;
        const target = matchVariant(family, cell.order, cardState.toggles);
        if (target) selectModel(target.uid);
      });
      eff.appendChild(btn);
    }
    node.appendChild(eff);
  }

  if (card.families.length > 1) {
    chip.addEventListener('click', event => {
      event.stopPropagation();
      for (const old of node.querySelectorAll('.dmp-pop')) old.remove();
      const pop = el('div', 'dmp-pop');
      for (const fam of card.families) {
        const item = el('button', '', fam.providerName || 'Devin');
        item.addEventListener('click', event2 => {
          event2.stopPropagation();
          saveProvider(card.cardKey, fam.providerName);
          pop.remove();
          rerenderGrid();
        });
        pop.appendChild(item);
      }
      node.appendChild(pop);
      const dismiss = event3 => {
        if (!pop.contains(event3.target)) { pop.remove(); document.removeEventListener('pointerdown', dismiss, true); }
      };
      document.addEventListener('pointerdown', dismiss, true);
    });
  }
  const resolveUid = () => {
    const order = cardState.effortOrder ?? defaultVariant(family)?.effortOrder ?? null;
    const target = (order != null ? matchVariant(family, order, cardState.toggles) : null) || defaultVariant(family);
    return target?.uid || null;
  };
  if (!cardDisabled) {
    node.addEventListener('click', () => {
      if (panelState?.suppressClick || panelState?.editing === card.prefKey) return;
      const order = cardState.effortOrder ?? defaultVariant(family)?.effortOrder ?? null;
      const target = (order != null ? matchVariant(family, order, cardState.toggles) : null) || defaultVariant(family);
      if (target && !target.disabled) selectModel(target.uid);
    });
  }
  wireCardChrome(node, card, index, resolveUid);
  return node;
}

function buildFusionCard(card, index, located, state) {
  const node = el('div', 'dmp-card');
  node.setAttribute('data-dmp-key', card.cardKey);
  const slots = panelState.fusionSlots;
  const other = panelState.activeSlot === 'lead' ? slots.sidekick : slots.lead;
  const otherKey = underlyingKey(other, state?.fusionCandidates);
  const cardKeys = card.variants.map(variant => underlyingKey(variant.ref, state?.fusionCandidates));
  const blocked = other && cardKeys.includes(otherKey);
  const selectedRefs = [slots.lead, slots.sidekick].filter(Boolean).map(ref => ref.kind + ':' + ref.uid);
  if (blocked) { node.classList.add('dmp-off'); node.title = '两个槽位不能使用同一模型'; }
  if (card.hidden) node.classList.add('dmp-hid');

  const top = el('div', 'dmp-top');
  top.appendChild(el('span', 'dmp-idx', String(index + 1).padStart(2, '0')));
  const dot = el('span', 'dmp-dot');
  dot.style.background = VENDORS[card.vendor] || VENDORS.other;
  top.appendChild(dot);
  if (card.favorite) top.appendChild(el('span', 'dmp-star', '★'));
  top.appendChild(el('span', 'dmp-prov', card.providerName || 'Devin'));
  node.appendChild(top);
  const displayName = prefAlias(card.prefKey) || card.name;
  const nameRow = el('div');
  const nameSize = displayName.length <= 6 ? 22 : displayName.length <= 8 ? 19 : 16;
  if (panelState.editing === card.prefKey) renameField(card, nameRow);
  else {
    const nameEl = el('span', 'dmp-name', displayName);
    nameEl.style.fontSize = nameSize + 'px';
    nameRow.appendChild(nameEl);
    if (card.version) nameRow.appendChild(el('span', 'dmp-ver', card.version));
    if (card.variant) nameRow.appendChild(el('span', 'dmp-var', card.variant));
  }
  node.appendChild(nameRow);
  const sub = el('div', 'dmp-sub');
  sub.appendChild(el('span', 'dmp-sub-txt', (card.familyLabel || card.name) + ' · ' + (card.providerName || 'Devin')));
  node.appendChild(sub);

  const fkey = card.cardKey;
  if (!panelState.cardStates.has(fkey)) {
    const pre = card.variants.find(variant => selectedRefs.includes(variant.ref.kind + ':' + variant.ref.uid)) || defaultVariant(card);
    panelState.cardStates.set(fkey, {
      effortOrder: pre?.effortOrder ?? card.cells[0]?.order ?? null,
      toggles: Object.fromEntries((card.toggles || []).map(tk => [tk, pre?.toggles?.[tk] ?? 0])),
    });
  }
  const cardState = panelState.cardStates.get(fkey);
  const held = card.variants.find(variant => selectedRefs.includes(variant.ref.kind + ':' + variant.ref.uid));
  if (held) {
    cardState.effortOrder = held.effortOrder ?? cardState.effortOrder;
    for (const key of card.toggles || []) cardState.toggles[key] = held.toggles?.[key] ?? 0;
  }
  const fill = variant => {
    if (!variant || blocked) return;
    slots[panelState.activeSlot] = variant.ref;
    if (panelState.activeSlot === 'lead' && !slots.sidekick) panelState.activeSlot = 'sidekick';
    saveDraft();
    rerenderGrid();
  };
  if ((card.toggles || []).length) sub.appendChild(toggleSwitches(card, cardState, blocked, target => {
    // A slot already holding this card follows the switch.
    for (const slot of ['lead', 'sidekick']) {
      if (target && slots[slot] && card.variants.some(variant => variant.ref.kind === slots[slot].kind && variant.ref.uid === slots[slot].uid)) slots[slot] = target.ref;
    }
    saveDraft();
    rerenderGrid();
  }));
  if (card.cells.length) {
    const eff = el('div', 'dmp-eff');
    for (const cell of card.cells) {
      const btn = el('button', '', cell.label || '?');
      if (cardState.effortOrder === cell.order) btn.classList.add('dmp-on');
      if (blocked) btn.disabled = true;
      else btn.addEventListener('click', event => {
        event.stopPropagation();
        cardState.effortOrder = cell.order;
        fill(matchVariant(card, cell.order, cardState.toggles));
      });
      eff.appendChild(btn);
    }
    node.appendChild(eff);
  }
  if (!blocked) node.addEventListener('click', () => {
    if (panelState?.suppressClick || panelState?.editing === card.prefKey) return;
    fill((cardState.effortOrder != null ? matchVariant(card, cardState.effortOrder, cardState.toggles) : null) || defaultVariant(card));
  });
  if (selectedRefs.length && card.variants.some(variant => selectedRefs.includes(variant.ref.kind + ':' + variant.ref.uid))) {
    node.classList.add('dmp-sel');
  }
  wireCardChrome(node, card, index, () =>
    (matchVariant(card, cardState.effortOrder ?? null, cardState.toggles) || defaultVariant(card))?.ref?.uid || null);
  return node;
}

function slotChip(slot, label) {
  const chip = el('button', 'dmp-slot' + (panelState.activeSlot === slot ? ' dmp-on' : ''));
  chip.appendChild(el('b', '', label));
  const ref = panelState.fusionSlots[slot];
  let text = '未选择';
  if (ref) {
    const cand = [...(lastState?.fusionCandidates?.leads || []), ...(lastState?.fusionCandidates?.sidekicks || [])]
      .find(item => item.ref.kind === ref.kind && item.ref.uid === ref.uid);
    const parsed = cardName(cand?.label || ref.uid);
    const eff = cand?.effort != null ? ' ' + effortLabel(cand.effort) : '';
    text = parsed.name + (parsed.version ? ' ' + parsed.version : '') + eff;
  }
  chip.appendChild(el('span', '', text));
  chip.addEventListener('click', () => { panelState.activeSlot = slot; rerenderGrid(); });
  return chip;
}

function rerenderGrid() {
  if (!panel || !panelState) return;
  const grid = panel.querySelector('.dmp-grid');
  if (!grid) return;
  // Synthetic scroll events caused by the rebuild must not close an open
  // context menu — suppress them for a frame.
  panelState.rebuildingGrid = true;
  const clearRebuild = () => { if (panelState) panelState.rebuildingGrid = false; };
  requestAnimationFrame(clearRebuild);
  setTimeout(clearRebuild, 50);
  const scrollTop = grid.scrollTop;
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  const { located, mode } = panelState;
  const models = located.host.visibleModelConfigs || [];
  if (mode === 'fusion') {
    const slotRowEl = panel.querySelector('.dmp-slots');
    if (slotRowEl) slotRowEl.replaceChildren(slotChip('lead', '主模型'), slotChip('sidekick', '辅助模型'));
    const oldApply = panel.querySelector('.dmp-apply'); if (oldApply) oldApply.remove();
    const oldErr = panel.querySelector('.dmp-err'); if (oldErr) oldErr.remove();
    if (!lastState) { grid.appendChild(el('div', 'dmp-empty', '本地服务未就绪')); renderFoot(); return; }
    const nativeIndex = new Map(models.map(model => [model.modelUid, model]));
    const active = panelState.activeSlot === 'lead' ? 'leads' : 'sidekicks';
    const cards = groupFusion(lastState.fusionCandidates?.[active] || [], nativeIndex);
    panelState.fullKeys = arrangeCards(cards, panelState.prefs, true).map(card => card.prefKey);
    const arranged = arrangeCards(cards, panelState.prefs, panelState.showHidden);
    const rendered = [];
    let shown = 0;
    arranged.forEach(card => {
      if (!filterMatch(panelState.filter, [card.name, prefAlias(card.prefKey), card.variant, card.providerName, card.cardKey])) return;
      rendered.push(card);
      grid.appendChild(buildFusionCard(card, shown++, located, lastState));
    });
    panelState.visibleCards = rendered;
    if (!shown) grid.appendChild(el('div', 'dmp-empty',
      cards.length ? '没有匹配的模型' : '暂无可用的 Fusion 模型'));
    grid.scrollTop = scrollTop;
    renderFoot();
    return;
  }
  const oldApply = panel.querySelector('.dmp-apply'); if (oldApply) oldApply.remove();
  const oldErr = panel.querySelector('.dmp-err'); if (oldErr) oldErr.remove();
  const cards = groupCards(models, lastState);
  // Merged hide semantics: a card is hidden only when its key is in prefs.hidden
  // AND no enabled BYOK family keeps it alive; the provider chip then offers
  // only the visible families.
  const hiddenSet = new Set(panelState.prefs.hidden);
  const effective = cards
    .filter(card => hiddenSet.has(card.prefKey) && !card.families.some(family => family.providerId))
    .map(card => card.prefKey);
  const arrPrefs = effective.length === panelState.prefs.hidden.length ? panelState.prefs
    : { ...panelState.prefs, hidden: effective };
  panelState.fullKeys = arrangeCards(cards, arrPrefs, true).map(card => card.prefKey);
  const arranged = arrangeCards(cards, arrPrefs, panelState.showHidden);
  const rendered = [];
  let shown = 0;
  arranged.forEach(card => {
    const hay = [card.name, prefAlias(card.prefKey), card.version, card.variant, card.cardKey,
      ...card.families.flatMap(family => [family.providerName, ...family.variants.map(variant => variant.uid + ' ' + variant.label)])];
    if (!filterMatch(panelState.filter, hay)) return;
    rendered.push(card);
    const render = card.hidden ? card
      : { ...card, families: card.families.filter(family => family.providerId || !hiddenSet.has(card.prefKey)) };
    grid.appendChild(buildCard(render, shown++, located));
  });
  panelState.visibleCards = rendered;
  if (!shown) grid.appendChild(el('div', 'dmp-empty', '没有匹配的模型'));
  grid.scrollTop = scrollTop;
  renderFoot();
}

// Footer: hidden-card toggle + status/hint, then the fusion apply button.
function renderFoot() {
  const foot = panel?.querySelector('.dmp-foot');
  if (!foot || !panelState) return;
  while (foot.firstChild) foot.removeChild(foot.firstChild);
  const hiddenSet = new Set(panelState.prefs.hidden || []);
  const hiddenCount = (panelState.fullKeys || []).filter(key => hiddenSet.has(key)).length;
  if (hiddenCount > 0) {
    const btn = el('button', 'dmp-showhidden',
      (panelState.showHidden ? '收起已隐藏' : '显示已隐藏') + ' (' + hiddenCount + ')');
    btn.addEventListener('click', event => {
      event.stopPropagation();
      panelState.showHidden = !panelState.showHidden;
      rerenderGrid();
    });
    foot.appendChild(btn);
  }
  foot.appendChild(el('span', panelState.status ? 'dmp-status' : '',
    panelState.status || '输入即可筛选 · Alt+点击打开原生菜单'));
  if (panelState.mode === 'fusion') renderFusionFooter();
}

function renderFusionFooter() {
  if (!panel || !panelState || panelState.mode !== 'fusion') return;
  const foot = panel.querySelector('.dmp-foot');
  if (!foot) return;
  const oldApply = panel.querySelector('.dmp-apply'); if (oldApply) oldApply.remove();
  const oldErr = panel.querySelector('.dmp-err'); if (oldErr) oldErr.remove();
  if (!lastState) return;
  const slots = panelState.fusionSlots;
  const err = el('span', 'dmp-err');
  const apply = el('button', 'dmp-apply', '使用此组合');
  apply.disabled = !(slots.lead && slots.sidekick);
  apply.addEventListener('click', async () => {
    err.textContent = '';
    apply.disabled = true;
    saveDraft();
    try {
      const result = await postFusion({ lead: slots.lead, sidekick: slots.sidekick,
        currentUid: panelState.value });
      if (result.error === 'same_model') { err.textContent = '两个槽位不能使用同一模型'; apply.disabled = false; foot.prepend(err); return; }
      if (result.error === 'invalid_ref') { err.textContent = '所选模型不可用'; apply.disabled = false; foot.prepend(err); return; }
      if (result.uid) { selectModel(result.uid); return; }
      err.textContent = '本地服务错误'; apply.disabled = false;
    } catch {
      err.textContent = '本地服务未就绪'; apply.disabled = false;
    }
    foot.prepend(err);
  });
  foot.prepend(apply);
}

// Bottom edge of the window's title bar: clicks on a drag region never reach
// the page, so the panel must stay below it.
function titleBarBottom() {
  let bottom = 44;
  try {
    for (const x of [window.innerWidth / 2, window.innerWidth - 160, 160]) {
      for (const node of document.elementsFromPoint(x, 4)) {
        if (panel && panel.contains(node)) continue;
        let hit = null;
        for (let el = node; el && el !== document.body; el = el.parentElement) {
          const style = getComputedStyle(el);
          if ((style.webkitAppRegion || style.getPropertyValue('-webkit-app-region')) === 'drag') { hit = el; break; }
        }
        if (hit) { bottom = Math.max(bottom, Math.min(hit.getBoundingClientRect().bottom + 8, 120)); break; }
      }
    }
  } catch {}
  return bottom;
}

function positionPanel(trigger) {
  const rect = trigger.getBoundingClientRect();
  const desired = 480;
  const minTop = titleBarBottom();
  const spaceAbove = rect.top - 8 - minTop;
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const above = spaceAbove >= desired || (spaceBelow < desired && spaceAbove >= spaceBelow);
  const maxH = Math.max(120, Math.min(desired, above ? spaceAbove : spaceBelow));
  panel.style.maxHeight = maxH + 'px';
  const pw = panel.offsetWidth;
  const left = Math.min(Math.max(8, rect.right - pw), Math.max(8, window.innerWidth - pw - 8));
  panel.style.left = left + 'px';
  panel.style.top = (above ? Math.max(minTop, rect.top - maxH - 8) : rect.bottom + 8) + 'px';
}

function openPanel(trigger, located) {
  if (panel) closePanel();
  if (located.root && located.root.disabled === true) return;
  ensureStyle();
  const value = currentValue(located);
  const startsFusion = typeof value === 'string' && value.startsWith('fusion-');
  panelState = { trigger, located, mode: startsFusion ? 'fusion' : 'single', filter: '',
    value, activeSlot: 'lead', cardStates: new Map(),
    fusionSlots: { lead: null, sidekick: null },
    prefs: loadPrefs(), showHidden: false, menu: null, editing: null,
    dragIndex: null, suppressClick: false, status: '',
    providers: [], provSel: 'devin', provSearch: '', provOnlyShown: false,
    provEdit: null, provConfirmDelete: false, provError: '' };
  panel = el('div', 'dmp-panel' + (isDark(trigger) ? ' dmp-dark' : ' dmp-light'));
  panel.setAttribute('data-devin-zh-skip', '');
  const toolbar = el('div', 'dmp-toolbar');
  const seg = el('div', 'dmp-seg');
  const btnSingle = el('button', panelState.mode === 'single' ? 'dmp-on' : '', '单模型');
  const btnFusion = el('button', panelState.mode === 'fusion' ? 'dmp-on' : '', 'Fusion');
  const btnProv = el('button', panelState.mode === 'providers' ? 'dmp-on' : '', '供应商');
  const provTab = el('div', 'dmp-provtab');
  const setMode = mode => {
    panelState.mode = mode;
    btnSingle.className = mode === 'single' ? 'dmp-on' : '';
    btnFusion.className = mode === 'fusion' ? 'dmp-on' : '';
    btnProv.className = mode === 'providers' ? 'dmp-on' : '';
    panel.classList.toggle('dmp-mode-prov', mode === 'providers');
    slotRow.style.display = mode === 'fusion' ? '' : 'none';
    if (mode === 'providers') refreshProviders();
    else rerenderGrid();
  };
  panelState.setMode = setMode;
  btnSingle.addEventListener('click', () => setMode('single'));
  btnFusion.addEventListener('click', () => setMode('fusion'));
  btnProv.addEventListener('click', () => setMode('providers'));
  seg.appendChild(btnSingle); seg.appendChild(btnFusion); seg.appendChild(btnProv);
  toolbar.appendChild(seg);
  const filter = el('input', 'dmp-filter');
  filter.placeholder = '输入以筛选';
  filter.addEventListener('input', () => { panelState.filter = filter.value; rerenderGrid(); });
  toolbar.appendChild(filter);
  panel.appendChild(toolbar);
  const slotRow = el('div', 'dmp-slots');
  slotRow.appendChild(slotChip('lead', '主模型'));
  slotRow.appendChild(slotChip('sidekick', '辅助模型'));
  panel.appendChild(slotRow);
  slotRow.style.display = panelState.mode === 'fusion' ? '' : 'none';
  const grid = el('div', 'dmp-grid');
  grid.addEventListener('scroll', () => {
    if (!panelState?.menu || panelState.rebuildingGrid) return;
    if (grid.scrollTop !== panelState.menuScroll) closeMenu();
  });
  panel.appendChild(grid);
  panel.appendChild(provTab);
  const foot = el('div', 'dmp-foot', '输入即可筛选 · Alt+点击打开原生菜单');
  panel.appendChild(foot);
  document.body.appendChild(panel);
  void fetchState().then(() => {
    if (!panelState) return;
    const prefill = pickFusionSlots(panelState.value, lastState, lastState?.fusionCandidates, loadDraft());
    panelState.fusionSlots.lead = panelState.fusionSlots.lead || prefill.lead;
    panelState.fusionSlots.sidekick = panelState.fusionSlots.sidekick || prefill.sidekick;
    slotRow.replaceChildren(slotChip('lead', '主模型'), slotChip('sidekick', '辅助模型'));
    rerenderGrid();
  });
  rerenderGrid();
  positionPanel(trigger);
  requestAnimationFrame(() => panel && panel.classList.add('dmp-open'));
  setTimeout(() => { if (panel) filter.focus(); }, 30);

  const onDocDown = event => {
    if (!panel) return;
    if (panelState?.menu && !panelState.menu.contains(event.target)) closeMenu();
    if (!panel.contains(event.target) && event.target !== trigger && !trigger.contains(event.target)) closePanel();
  };
  const onKey = event => {
    if (!panelState) return;
    if (event.key === 'Escape') {
      // Innermost first: menu → inline rename → provider edit/confirm → filter → panel.
      if (panelState.menu) closeMenu();
      else if (panelState.editing) { panelState.editing = null; rerenderGrid(); }
      else if (panelState.provEdit || panelState.provConfirmDelete) {
        panelState.provEdit = null; panelState.provConfirmDelete = false; renderProviders(); }
      else if (panelState.filter) { panelState.filter = ''; filter.value = ''; rerenderGrid(); }
      else closePanel();
      event.stopPropagation();
      return;
    }
    const active = document.activeElement;
    if (panelState.menu) return;
    if (panelState.mode === 'providers') return;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
      || active.tagName === 'SELECT' || active.isContentEditable)) return;
    if (event.key === 'Enter') {
      const first = panel.querySelector('.dmp-card:not(.dmp-off):not(.dmp-add):not(.dmp-hid)');
      if (first) first.click();
    } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      filter.focus();
    }
  };
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  const onResize = () => { if (panel) positionPanel(trigger); };
  window.addEventListener('resize', onResize);
  panelState.cleanup = () => {
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
  };
}

function closePanel() {
  if (!panel) return;
  const node = panel;
  panel = null;
  panelState?.cleanup?.();
  panelState = null;
  node.classList.remove('dmp-open');
  setTimeout(() => node.remove(), 150);
}

function togglePanel(trigger) {
  if (panel) { closePanel(); return; }
  const located = locateTrigger(trigger);
  if (!located) return; // let the native menu open
  openPanel(trigger, located);
}

// Trigger binding ------------------------------------------------------------
function bind() {
  const buttons = document.querySelectorAll('button[aria-haspopup="menu"]:not([data-dmp-bound])');
  for (const button of buttons) {
    const fiber = fiberOf(button);
    if (!fiber || !locate(fiber)) continue;
    button.setAttribute('data-dmp-bound', '');
  }
}
let bindScheduled = false;
function scheduleBind() {
  if (bindScheduled) return;
  bindScheduled = true;
  requestAnimationFrame(() => { bindScheduled = false; bind(); });
}

for (const type of ['pointerdown', 'mousedown', 'click']) {
  window.addEventListener(type, event => {
    const button = event.target && event.target.closest ? event.target.closest('button[aria-haspopup="menu"][data-dmp-bound]') : null;
    if (!button) return;
    if (event.altKey) return; // escape hatch → native menu
    if (type === 'click') {
      if (!locateTrigger(button)) return; // host vanished → native
      event.preventDefault();
      event.stopImmediatePropagation();
      togglePanel(button);
      return;
    }
    if (locateTrigger(button)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}
window.addEventListener('keydown', event => {
  if (!['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
  const button = event.target && event.target.closest ? event.target.closest('button[aria-haspopup="menu"][data-dmp-bound]') : null;
  if (!button || event.altKey) return;
  if (!locateTrigger(button)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  togglePanel(button);
}, true);

observer = new MutationObserver(scheduleBind);
observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
const themeObserver = new MutationObserver(() => {
  if (panel && panelState) {
    const dark = isDark(panelState.trigger);
    panel.classList.toggle('dmp-dark', dark);
    panel.classList.toggle('dmp-light', !dark);
  }
});
if (document.body) themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
bind();
})();
