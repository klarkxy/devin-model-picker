'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// models.dev is the primary metadata source for imported BYOK models; fields
// reported by the provider's own /models listing override it per field.
const MODELS_DEV_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30000;
const FIRST_PARTY = ['anthropic', 'openai', 'google', 'deepseek', 'moonshotai', 'xai', 'zai', 'alibaba', 'mistral', 'minimax'];

function normalizeId(id) {
  return String(id || '').split('/').at(-1).toLowerCase().replace(/[._]/g, '-');
}

function effortOption(entry) {
  for (const option of Array.isArray(entry?.reasoning_options) ? entry.reasoning_options : []) {
    if (option?.type === 'effort' && Array.isArray(option.values) &&
        option.values.length && option.values.every(v => typeof v === 'string' && /^[a-z0-9_-]{1,32}$/.test(v))) {
      return [null, ...new Set(option.values)];
    }
  }
  return undefined;
}

function derive(providerId, entry) {
  if (!entry || typeof entry !== 'object') return null;
  const limit = entry.limit && typeof entry.limit === 'object' ? entry.limit : {};
  return {
    providerId,
    canonicalPrefix: typeof entry.canonical_model_id === 'string' ? entry.canonical_model_id.split('/')[0] : '',
    name: typeof entry.name === 'string' && entry.name ? entry.name : undefined,
    family: typeof entry.family === 'string' && entry.family ? entry.family : undefined,
    contextWindow: Number.isSafeInteger(limit.context) && limit.context > 0 ? limit.context : undefined,
    maxOutputTokens: Number.isSafeInteger(limit.output) && limit.output > 0 ? limit.output : undefined,
    efforts: effortOption(entry),
    supportsImages: Array.isArray(entry.modalities?.input) ? entry.modalities.input.includes('image') : undefined,
  };
}

// Multiple providers can expose the same normalized leaf id. Prefer the entry
// whose canonical model id points back at its own provider, then first-party
// providers in a fixed order, then first seen.
function better(candidate, current) {
  if (!current) return true;
  if (candidate.canonicalPrefix === candidate.providerId && current.canonicalPrefix !== current.providerId) return true;
  if (current.canonicalPrefix === current.providerId && candidate.canonicalPrefix !== candidate.providerId) return false;
  const a = FIRST_PARTY.indexOf(candidate.providerId), b = FIRST_PARTY.indexOf(current.providerId);
  return (a === -1 ? FIRST_PARTY.length : a) < (b === -1 ? FIRST_PARTY.length : b);
}

function buildIndex(apiJson) {
  const index = new Map();
  for (const [providerId, section] of Object.entries(apiJson || {})) {
    const models = section && typeof section === 'object' ? section.models : null;
    if (!models || typeof models !== 'object') continue;
    for (const entry of Object.values(models)) {
      // Skip embedding/image/audio-like non-chat types; untyped entries stay.
      if (typeof entry?.type === 'string' && entry.type !== 'language') continue;
      const key = normalizeId(entry?.id);
      if (!key) continue;
      const derived = derive(providerId, entry);
      if (!derived) continue;
      if (better(derived, index.get(key))) index.set(key, derived);
    }
  }
  return index;
}

// Exact normalized match, then one retry after stripping a trailing date stamp
// or -latest. No other fuzzy matching.
function lookup(index, modelId) {
  if (!index || typeof modelId !== 'string') return null;
  const key = normalizeId(modelId);
  if (index.has(key)) return index.get(key);
  const stripped = key.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '');
  return stripped !== key && index.has(stripped) ? index.get(stripped) : null;
}

function readCache(file) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached && Number.isSafeInteger(cached.fetchedAt) && cached.data && typeof cached.data === 'object') return cached;
  } catch {}
  return null;
}

function writeCache(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.' + crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch {}
}

// Loads the models.dev index, refreshing the on-disk cache when stale. Fetch
// failures fall back to the stale cache; with no cache at all the index is null
// and callers proceed with /models data and defaults only.
async function loadIndex({ file, fetchImpl = fetch, now = () => Date.now(), ttlMs = TTL_MS } = {}) {
  const cached = file ? readCache(file) : null;
  if (cached && now() - cached.fetchedAt < ttlMs) return { index: buildIndex(cached.data), fetchedAt: cached.fetchedAt, stale: false };
  try {
    const response = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) throw new Error('models.dev HTTP ' + response.status);
    const data = await response.json();
    const fetchedAt = now();
    if (file) writeCache(file, { fetchedAt, data });
    return { index: buildIndex(data), fetchedAt, stale: false };
  } catch {
    return cached ? { index: buildIndex(cached.data), fetchedAt: cached.fetchedAt, stale: true } : { index: null, fetchedAt: 0, stale: true };
  }
}

const positive = value => Number.isSafeInteger(value) && value > 0;
const firstPositive = values => { for (const value of values) if (positive(value)) return value; return undefined; };
const effortArray = value => Array.isArray(value) && value.length &&
  value.every(v => typeof v === 'string' && /^[a-z0-9_-]{1,32}$/.test(v)) ? [null, ...new Set(value)] : undefined;
const modalityArray = value => Array.isArray(value) && value.every(v => typeof v === 'string') ? value : undefined;
const v1Name = (v1, id) => {
  for (const value of [v1?.display_name, v1?.name]) if (typeof value === 'string' && value && value !== id) return value;
  return undefined;
};

// /models fields win over models.dev; meta.source is the highest-precedence
// source that contributed anything (v1 > models.dev > default).
function mergeMetadata(modelId, v1Item, devEntry) {
  const v1 = v1Item && typeof v1Item === 'object' ? v1Item : null;
  const topProvider = v1?.top_provider && typeof v1.top_provider === 'object' ? v1.top_provider : {};
  const v1Context = v1 ? firstPositive([v1.context_length, v1.context_window, v1.max_input_tokens, v1.max_context_length, topProvider.context_length]) : undefined;
  const v1Output = v1 ? firstPositive([v1.max_output_tokens, v1.max_completion_tokens, topProvider.max_completion_tokens, v1.max_tokens]) : undefined;
  const v1Efforts = v1 ? (effortArray(v1.supported_reasoning_efforts) ?? effortArray(v1.reasoning_efforts)) : undefined;
  const v1Modalities = v1 ? (modalityArray(v1.input_modalities) ?? modalityArray(v1.architecture?.input_modalities)) : undefined;
  const v1Label = v1 ? v1Name(v1, modelId) : undefined;

  const label = v1Label ?? devEntry?.name;
  const contextWindow = v1Context ?? devEntry?.contextWindow ?? 272000;
  const maxOutputTokens = Math.min(v1Output ?? devEntry?.maxOutputTokens ?? 131072, contextWindow);
  const efforts = v1Efforts ?? devEntry?.efforts;
  const supportsImages = (v1Modalities ? v1Modalities.includes('image') : undefined) ?? devEntry?.supportsImages ?? true;
  const source = [v1Label, v1Context, v1Output, v1Efforts, v1Modalities].some(v => v !== undefined) ? 'v1'
    : [devEntry?.name, devEntry?.contextWindow, devEntry?.maxOutputTokens, devEntry?.efforts, devEntry?.supportsImages, devEntry?.family]
      .some(v => v !== undefined) ? 'models.dev' : 'default';
  return { label, contextWindow, maxOutputTokens, efforts, supportsImages,
    meta: { source, ...(devEntry?.family ? { family: devEntry.family } : {}) } };
}

module.exports = { MODELS_DEV_URL, TTL_MS, normalizeId, buildIndex, lookup, loadIndex, mergeMetadata };
