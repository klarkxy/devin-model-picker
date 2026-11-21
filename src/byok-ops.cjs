'use strict';
// Shared BYOK provider operations used by the settings webview and the
// picker's HTTP API. Ops mutate the passed config object; callers persist it.
const crypto = require('node:crypto');
const { buildCatalog } = require('./catalog.cjs');
const { lookup, mergeMetadata } = require('./models-dev.cjs');
const { modelEfforts } = require('./model-capabilities.cjs');
const { normalizeBaseUrlPath } = require('./panel/base-url.cjs');

class SettingsInputError extends Error {}
const fail = message => { throw new SettingsInputError(message); };
function text(value, label, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(label + '无效。');
  return value.trim();
}
function baseUrl(value) {
  let url; try { url = new URL(text(value, 'API 地址', 2048)); } catch { fail('请填写完整的 http:// 或 https:// API 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('API 地址不能包含登录信息、查询参数或片段。');
  url.pathname = normalizeBaseUrlPath(url.pathname);
  return url.toString().replace(/\/$/, '');
}
function boolean(value, label) { if (typeof value !== 'boolean') fail(label + '无效。'); return value; }
function providerAt(config, id) { return config.providers.find(provider => provider.id === id) || fail('该供应商已不存在，请刷新。'); }

// Merges a raw /models item with the models.dev index entry into the stored
// model shape. re-import/refresh recomputes all metadata fields.
function mergeModel(provider, item, index) {
  const merged = mergeMetadata(item.id, item, lookup(index, item.id));
  return { id: item.id, label: merged.label || provider.name + ' · ' + item.id,
    contextWindow: merged.contextWindow, maxOutputTokens: merged.maxOutputTokens,
    efforts: merged.efforts ?? modelEfforts({ id: item.id }),
    supportsImages: merged.supportsImages, meta: merged.meta };
}

// Pending discover results stay valid only while the provider record is
// unchanged — key/url/format edits must re-fetch before importing.
function signature(provider) { return JSON.stringify([provider.id, provider.baseUrl, provider.apiFormat, provider.apiKey]); }

function setEnabled(config, payload) { config.enabled = boolean(payload.enabled, '启用状态'); }

// Creates or updates a provider. apiKey omitted/empty on edit keeps the
// stored key. Returns the provider id.
function saveProvider(config, payload) {
  const existing = payload.id ? providerAt(config, payload.id) : null;
  const name = text(payload.name, '供应商名称', 80), url = baseUrl(payload.baseUrl);
  if (!['openai-responses', 'openai', 'anthropic'].includes(payload.apiFormat)) fail('请选择 API 类型。');
  if (payload.apiKey !== undefined && (typeof payload.apiKey !== 'string' || payload.apiKey.length > 8192 || /[\r\n]/.test(payload.apiKey))) fail('API Key 无效。');
  const apiKey = payload.apiKey?.trim() || existing?.apiKey || '';
  if (existing) {
    const previousName = existing.name;
    Object.assign(existing, { name, baseUrl: url, apiFormat: payload.apiFormat, apiKey });
    if (name !== previousName) for (const model of existing.models) if (model.label?.startsWith(previousName + ' · ')) model.label = name + model.label.slice(previousName.length);
    return existing.id;
  }
  const provider = { id: 'provider-' + crypto.randomUUID(), name, baseUrl: url, apiFormat: payload.apiFormat, apiKey, enabled: true, models: [] };
  config.providers.push(provider);
  return provider.id;
}

function deleteProvider(config, payload) {
  providerAt(config, payload.id);
  config.providers = config.providers.filter(provider => provider.id !== payload.id);
}

function setProviderEnabled(config, payload) { providerAt(config, payload.id).enabled = boolean(payload.enabled, '启用状态'); }

function setModelEnabled(config, payload) {
  const model = providerAt(config, payload.providerId).models.find(item => item.id === payload.modelId) || fail('该模型已不存在。');
  model.enabled = boolean(payload.enabled, '启用状态');
}

function removeModel(config, payload) {
  const provider = providerAt(config, payload.providerId);
  provider.models = provider.models.filter(model => model.id !== payload.modelId);
}

// Fetches /models from the provider and merges with models.dev metadata.
// Returns { models } — caller stores them as a pending import keyed by the
// provider signature so later edits invalidate the list.
async function discoverModels(config, payload, { discover, index } = {}) {
  const provider = providerAt(config, payload.providerId ?? payload.id);
  const items = await discover(provider);
  const merged = items.map(item => mergeModel(provider, item, index));
  // Validate a private candidate catalog without changing saved models.
  buildCatalog({ ...config, providers: [{ ...provider, enabled: true, models: merged.map(model => ({ ...model, enabled: true })) }] });
  return { provider, models: merged };
}

// Import view of a pending discover result (what the checklist shows).
function importView(provider, models) {
  return models.map(model => ({ id: model.id, label: model.label, contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens, efforts: model.efforts, supportsImages: model.supportsImages,
    source: model.meta.source, imported: provider.models.some(existing => existing.id === model.id) }));
}

// pending = { providerId, signature, models } from discoverModels.
function importModels(config, payload, pending) {
  const provider = providerAt(config, payload.providerId ?? payload.id);
  if (!pending || pending.providerId !== provider.id || pending.token !== payload.token || pending.signature !== signature(provider)) fail('模型列表已失效，请重新获取后选择。');
  if (!Array.isArray(payload.ids) || payload.ids.some(id => typeof id !== 'string') || new Set(payload.ids).size !== payload.ids.length) fail('请选择要导入的模型。');
  const candidates = new Map(pending.models.map(model => [model.id, model]));
  if (payload.ids.some(id => !candidates.has(id))) fail('所选模型不在获取的列表中，请重新选择。');
  const existing = new Set(provider.models.map(model => model.id));
  for (const id of payload.ids) {
    if (existing.has(id)) { const current = provider.models.find(model => model.id === id); Object.assign(current, candidates.get(id), { enabled: current.enabled }); }
    else provider.models.push({ ...candidates.get(id), enabled: true });
  }
  return payload.ids.length;
}

async function refreshMeta(config, payload, { discover, index } = {}) {
  const provider = providerAt(config, payload.providerId);
  const items = await discover(provider);
  const byId = new Map(items.map(item => [item.id, item]));
  for (const model of provider.models) {
    const merged = mergeModel(provider, byId.get(model.id) || { id: model.id }, index);
    Object.assign(model, { label: merged.label, contextWindow: merged.contextWindow,
      maxOutputTokens: merged.maxOutputTokens, efforts: merged.efforts,
      supportsImages: merged.supportsImages, meta: merged.meta });
  }
}


// Auto-detect a provider endpoint: probes <base>/models with Bearer first,
// then Anthropic headers on 401/403, picks the working base (/v1 appended
// when the path has no version suffix), and classifies the API format.
async function probeProvider({ baseUrl: raw, apiKey, fetchImpl = fetch } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) fail('请填写 API Key。');
  const root = baseUrl(raw);
  // baseUrl() already appends /v1 when the path has no version segment; the
  // bare fallback must be derived from the user's original path.
  const origPath = new URL(raw).pathname;
  const hasVersion = origPath.split('/').some(segment => /^v\d+/i.test(segment));
  const bare = root.replace(/\/v1$/, '');
  const bases = hasVersion ? [root] : (bare !== root ? [root, bare] : [root]);
  let working = null, auth = 'bearer', items = null, sawAuth = false, sawListless = false;
  for (const candidate of bases) {
    for (const mode of ['bearer', 'anthropic']) {
      const headers = mode === 'bearer'
        ? { Authorization: 'Bearer ' + key }
        : { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      let response;
      try {
        response = await fetchImpl(candidate + '/models', { headers, signal: AbortSignal.timeout(10000) });
      } catch { fail('无法连接到该地址，请检查 API 地址。'); }
      if (response.status === 401 || response.status === 403) { sawAuth = true; continue; }
      if (!response.ok) { sawListless = true; continue; }
      let json;
      try { json = await response.json(); } catch { sawListless = true; continue; }
      if (!Array.isArray(json.data)) { sawListless = true; continue; }
      working = candidate; auth = mode; items = json.data;
      break;
    }
    if (working) break;
  }
  if (!working) {
    if (sawAuth && !sawListless) fail('API Key 无效。');
    fail('该地址没有返回模型列表。');
  }
  const looksAnthropic = auth === 'anthropic' || items.some(item => item && item.type === 'model' && item.display_name);
  let apiFormat;
  if (looksAnthropic) apiFormat = 'anthropic';
  else {
    let status = null;
    try {
      const probe = await fetchImpl(working + '/responses', {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + key },
        body: '{}', signal: AbortSignal.timeout(10000) });
      status = probe.status;
    } catch { status = null; }
    apiFormat = status != null && ![404, 405, 501].includes(status) ? 'openai-responses' : 'openai';
  }
  return { baseUrl: working, apiFormat, name: hostName(working) };
}

// Default provider name: hostname without api./www. prefixes.
function hostName(base) {
  let host;
  try { host = new URL(base).hostname; } catch { host = String(base); }
  return host.replace(/^(api|www)\./, '') || host;
}

// Appends " 2", " 3"… when another provider already uses the name.
function uniqueName(wanted, config, excludeId) {
  const taken = new Set((config.providers || []).filter(p => p.id !== excludeId).map(p => p.name));
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) if (!taken.has(wanted + ' ' + i)) return wanted + ' ' + i;
}

// Merges a fresh /models listing into provider.models: new entries start
// disabled, existing keep their flag; entries absent upstream are dropped
// when disabled, otherwise kept and flagged meta.missing.
function mergeDiscovered(provider, items, index) {
  const previous = new Map((provider.models || []).map(model => [model.id, model]));
  const next = [];
  const seen = new Set();
  for (const item of items) {
    const merged = mergeModel(provider, item, index);
    const existing = previous.get(item.id);
    seen.add(item.id);
    next.push(existing ? { ...merged, enabled: existing.enabled !== false }
      : { ...merged, enabled: false });
  }
  for (const existing of provider.models || []) {
    if (seen.has(existing.id)) continue;
    if (existing.enabled === false) continue;
    next.push({ ...existing, meta: { ...(existing.meta || {}), missing: true } });
  }
  provider.models = next;
}

// Rename / override apiFormat / rotate the key. Undefined fields stay.
function updateProvider(config, payload) {
  const provider = providerAt(config, payload.id);
  if (payload.name !== undefined) {
    const name = text(payload.name, '供应商名称', 80);
    const previous = provider.name;
    provider.name = name;
    if (name !== previous) for (const model of provider.models || []) {
      if (model.label && model.label.startsWith(previous + ' · ')) model.label = name + model.label.slice(previous.length);
    }
  }
  if (payload.apiFormat !== undefined) {
    if (!['openai-responses', 'openai', 'anthropic'].includes(payload.apiFormat)) fail('请选择 API 类型。');
    provider.apiFormat = payload.apiFormat;
  }
  if (payload.apiKey !== undefined) {
    if (typeof payload.apiKey !== 'string' || payload.apiKey.length > 8192 || /[\r\n]/.test(payload.apiKey)) fail('API Key 无效。');
    const key = payload.apiKey.trim();
    if (key) provider.apiKey = key;
  }
}

// Bulk show/hide of provider models. Returns how many known ids were applied.
function setModelsEnabled(config, payload) {
  const provider = providerAt(config, payload.providerId);
  if (!Array.isArray(payload.modelIds) || payload.modelIds.length > 2000
    || payload.modelIds.some(id => typeof id !== 'string')) fail('模型列表无效。');
  const enabled = boolean(payload.enabled, '启用状态');
  const wanted = new Set(payload.modelIds);
  let applied = 0;
  for (const model of provider.models || []) {
    if (wanted.has(model.id)) { model.enabled = enabled; applied++; }
  }
  return applied;
}

module.exports = { SettingsInputError, text, baseUrl, boolean, providerAt, mergeModel, signature,
  setEnabled, saveProvider, deleteProvider, setProviderEnabled, setModelEnabled, removeModel,
  discoverModels, importView, importModels, refreshMeta,
  probeProvider, hostName, uniqueName, mergeDiscovered, updateProvider, setModelsEnabled };
