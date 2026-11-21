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
    if (!cards.has(key)) cards.set(key, { ...parsed, cardKey: key, families: new Map() });
    const card = cards.get(key);
    if (!card.families.has(familyUid)) {
      card.families.set(familyUid, { providerName, vendor: vendorOf(model, byokEntry), variants: [], familyLabel: '' });
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
    if (!cards.has(key)) cards.set(key, { ...parsed, cardKey: key, providerName: candidate.providerName,
      vendor: ref.kind === 'byok' ? 'other' : 'windsurf', variants: [], familyLabel: '' });
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
  validDraft, pickFusionSlots,
  IDLIKE, HIDDEN_DISPLAY, LS_KEY, API_BASE };
if (typeof module === 'object' && module.exports) { module.exports = exportsMap; return; }

// ---------------------------------------------------------------------------
// DOM side. Everything below runs inside the workbench window.
// ---------------------------------------------------------------------------
if (window.__devinModelPicker) return;
window.__devinModelPicker = { version: '0.1.0' };
console.log('[devin-model-picker] loaded');

const CSS = `
.dmp-panel{position:fixed;z-index:2147483000;width:min(720px,94vw);max-height:min(560px,70vh);
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
  const chip = el('button', 'dmp-prov', family.providerName || 'Devin');
  chip.title = card.families.length > 1 ? '切换供应商' : '';
  top.appendChild(chip);
  node.appendChild(top);

  const nameRow = el('div');
  const nameSize = card.name.length <= 6 ? 22 : card.name.length <= 8 ? 19 : 16;
  const nameEl = el('span', 'dmp-name', card.name);
  nameEl.style.fontSize = nameSize + 'px';
  nameRow.appendChild(nameEl);
  if (card.version) nameRow.appendChild(el('span', 'dmp-ver', card.version));
  if (card.variant) nameRow.appendChild(el('span', 'dmp-var', card.variant));
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
  if (!cardDisabled) {
    node.addEventListener('click', () => {
      const order = cardState.effortOrder ?? defaultVariant(family)?.effortOrder ?? null;
      const target = (order != null ? matchVariant(family, order, cardState.toggles) : null) || defaultVariant(family);
      if (target && !target.disabled) selectModel(target.uid);
    });
  }
  return node;
}

function buildFusionCard(card, index, located, state) {
  const node = el('div', 'dmp-card');
  const slots = panelState.fusionSlots;
  const other = panelState.activeSlot === 'lead' ? slots.sidekick : slots.lead;
  const otherKey = underlyingKey(other, state?.fusionCandidates);
  const cardKeys = card.variants.map(variant => underlyingKey(variant.ref, state?.fusionCandidates));
  const blocked = other && cardKeys.includes(otherKey);
  const selectedRefs = [slots.lead, slots.sidekick].filter(Boolean).map(ref => ref.kind + ':' + ref.uid);
  if (blocked) { node.classList.add('dmp-off'); node.title = '两个槽位不能使用同一模型'; }

  const top = el('div', 'dmp-top');
  top.appendChild(el('span', 'dmp-idx', String(index + 1).padStart(2, '0')));
  const dot = el('span', 'dmp-dot');
  dot.style.background = VENDORS[card.vendor] || VENDORS.other;
  top.appendChild(dot);
  top.appendChild(el('span', 'dmp-prov', card.providerName || 'Devin'));
  node.appendChild(top);
  const nameRow = el('div');
  const nameSize = card.name.length <= 6 ? 22 : card.name.length <= 8 ? 19 : 16;
  const nameEl = el('span', 'dmp-name', card.name);
  nameEl.style.fontSize = nameSize + 'px';
  nameRow.appendChild(nameEl);
  if (card.version) nameRow.appendChild(el('span', 'dmp-ver', card.version));
  if (card.variant) nameRow.appendChild(el('span', 'dmp-var', card.variant));
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
  if (!blocked) node.addEventListener('click', () =>
    fill((cardState.effortOrder != null ? matchVariant(card, cardState.effortOrder, cardState.toggles) : null) || defaultVariant(card)));
  if (selectedRefs.length && card.variants.some(variant => selectedRefs.includes(variant.ref.kind + ':' + variant.ref.uid))) {
    node.classList.add('dmp-sel');
  }
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
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  const { located, mode } = panelState;
  const models = located.host.visibleModelConfigs || [];
  if (mode === 'fusion') {
    const slotRowEl = panel.querySelector('.dmp-slots');
    if (slotRowEl) slotRowEl.replaceChildren(slotChip('lead', '主模型'), slotChip('sidekick', '辅助模型'));
    const oldApply = panel.querySelector('.dmp-apply'); if (oldApply) oldApply.remove();
    const oldErr = panel.querySelector('.dmp-err'); if (oldErr) oldErr.remove();
    if (!lastState) { grid.appendChild(el('div', 'dmp-empty', '本地服务未就绪')); renderFusionFooter(); return; }
    const nativeIndex = new Map(models.map(model => [model.modelUid, model]));
    const active = panelState.activeSlot === 'lead' ? 'leads' : 'sidekicks';
    const cards = groupFusion(lastState.fusionCandidates?.[active] || [], nativeIndex);
    let shown = 0;
    cards.forEach((card, index) => {
      if (!filterMatch(panelState.filter, [card.name, card.variant, card.providerName, card.cardKey])) return;
      grid.appendChild(buildFusionCard(card, shown++, located, lastState));
    });
    if (!shown) grid.appendChild(el('div', 'dmp-empty',
      cards.length ? '没有匹配的模型' : '暂无可用的 Fusion 模型'));
    renderFusionFooter();
    return;
  }
  const oldApply = panel.querySelector('.dmp-apply'); if (oldApply) oldApply.remove();
  const oldErr = panel.querySelector('.dmp-err'); if (oldErr) oldErr.remove();
  const cards = groupCards(models, lastState);
  let shown = 0;
  cards.forEach(card => {
    const hay = [card.name, card.version, card.variant, card.cardKey,
      ...card.families.flatMap(family => [family.providerName, ...family.variants.map(variant => variant.uid + ' ' + variant.label)])];
    if (!filterMatch(panelState.filter, hay)) return;
    grid.appendChild(buildCard(card, shown++, located));
  });
  if (!shown) grid.appendChild(el('div', 'dmp-empty', '没有匹配的模型'));
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

function positionPanel(trigger) {
  const rect = trigger.getBoundingClientRect();
  const desired = 560;
  const spaceAbove = rect.top - 8;
  const spaceBelow = window.innerHeight - rect.bottom - 8;
  const above = spaceAbove >= desired || (spaceBelow < desired && spaceAbove >= spaceBelow);
  const maxH = Math.max(120, Math.min(desired, above ? spaceAbove : spaceBelow));
  panel.style.maxHeight = maxH + 'px';
  const pw = panel.offsetWidth;
  const left = Math.min(Math.max(8, rect.right - pw), Math.max(8, window.innerWidth - pw - 8));
  panel.style.left = left + 'px';
  panel.style.top = (above ? Math.max(8, rect.top - maxH - 8) : rect.bottom + 8) + 'px';
}

function openPanel(trigger, located) {
  if (panel) closePanel();
  if (located.root && located.root.disabled === true) return;
  ensureStyle();
  const value = currentValue(located);
  const startsFusion = typeof value === 'string' && value.startsWith('fusion-');
  panelState = { trigger, located, mode: startsFusion ? 'fusion' : 'single', filter: '',
    value, activeSlot: 'lead', cardStates: new Map(),
    fusionSlots: { lead: null, sidekick: null } };
  panel = el('div', 'dmp-panel' + (isDark(trigger) ? ' dmp-dark' : ' dmp-light'));
  panel.setAttribute('data-devin-zh-skip', '');
  const toolbar = el('div', 'dmp-toolbar');
  const seg = el('div', 'dmp-seg');
  const btnSingle = el('button', panelState.mode === 'single' ? 'dmp-on' : '', '单模型');
  const btnFusion = el('button', panelState.mode === 'fusion' ? 'dmp-on' : '', 'Fusion');
  const setMode = mode => {
    panelState.mode = mode;
    btnSingle.className = mode === 'single' ? 'dmp-on' : '';
    btnFusion.className = mode === 'fusion' ? 'dmp-on' : '';
    rerenderGrid();
  };
  btnSingle.addEventListener('click', () => setMode('single'));
  btnFusion.addEventListener('click', () => setMode('fusion'));
  seg.appendChild(btnSingle); seg.appendChild(btnFusion);
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
  const syncSlots = () => { slotRow.style.display = panelState.mode === 'fusion' ? '' : 'none'; };
  btnSingle.addEventListener('click', syncSlots);
  btnFusion.addEventListener('click', syncSlots);
  panel.appendChild(el('div', 'dmp-grid'));
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
    if (panel && !panel.contains(event.target) && event.target !== trigger && !trigger.contains(event.target)) closePanel();
  };
  const onKey = event => {
    if (!panelState) return;
    if (event.key === 'Escape') {
      if (panelState.filter) { panelState.filter = ''; filter.value = ''; rerenderGrid(); }
      else closePanel();
      event.stopPropagation();
    } else if (event.key === 'Enter' && document.activeElement !== filter) {
      const first = panel.querySelector('.dmp-card:not(.dmp-off)');
      if (first) first.click();
    } else if (event.key.length === 1 && document.activeElement !== filter && !event.altKey && !event.ctrlKey && !event.metaKey) {
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
