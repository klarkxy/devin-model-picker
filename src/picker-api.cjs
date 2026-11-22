'use strict';

// Renderer-side card picker API. The injected workbench script runs with origin
// vscode-file://vscode-app; that exact origin is required on every /picker/*
// request while all other backend routes keep rejecting any Origin header.
const crypto = require('node:crypto');
const { effortMetadata } = require('./catalog.cjs');
const ops = require('./byok-ops.cjs');

const PICKER_ORIGIN = 'vscode-file://vscode-app';
const BODY_LIMIT = 64 * 1024;

function corsHeaders() {
  return {
    'access-control-allow-origin': PICKER_ORIGIN,
    'access-control-allow-methods': 'GET, POST',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
    'cache-control': 'no-store',
  };
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { ...corsHeaders(), 'content-type': 'application/json' });
  response.end(payload);
}

function validRef(ref) {
  return ref && typeof ref === 'object' && !Array.isArray(ref) &&
    (ref.kind === 'byok' || ref.kind === 'native') && typeof ref.uid === 'string' && ref.uid.length > 0 && ref.uid.length <= 256;
}

function refKey(ref) { return ref.kind + ':' + ref.uid; }

// CandidateView: { ref, label, providerName ('Devin' for native), effort, familyKey }
function candidates(catalog, config) {
  const leads = [], sidekicks = [];
  const providers = new Map((Array.isArray(config.providers) ? config.providers : []).map(p => [p.id, p]));
  for (const route of Object.values(catalog.routes || {})) {
    if (route.enabled === false) continue;
    const provider = providers.get(route.providerId);
    const model = provider && Array.isArray(provider.models)
      ? provider.models.find(item => item && item.id === route.model) : null;
    const efforts = Array.isArray(model?.efforts) ? model.efforts : [];
    const index = route.effort == null ? null : efforts.indexOf(route.effort);
    const effortOrder = route.effort == null ? null
      : (index >= 0 ? index : (effortMetadata(route.effort).order ?? null));
    // Label without the "<provider> · " prefix — the card's family name.
    const label = route.label || route.model;
    const prefix = (provider?.name || route.providerId) + ' · ';
    const candidate = {
      ref: { kind: 'byok', uid: route.uid },
      label, providerName: provider?.name || route.providerId,
      effort: route.effort ?? null,
      ...(effortOrder != null ? { effortOrder } : {}),
      familyLabel: label.startsWith(prefix) ? label.slice(prefix.length) : label,
      familyKey: 'byok:' + route.providerId + ':' + route.model,
    };
    leads.push(candidate);
    sidekicks.push({ ...candidate, ref: { ...candidate.ref } });
  }
  for (const native of catalog.roles?.eligibleNativeLeads?.values() || []) {
    leads.push({ ref: { kind: 'native', uid: native.uid }, label: native.label || native.uid,
      providerName: 'Devin', effort: native.effortDimension?.name ?? null,
      ...(native.effortOrder != null ? { effortOrder: native.effortOrder } : {}),
      ...(native.familyLabel ? { familyLabel: native.familyLabel } : {}),
      familyKey: native.familyUid || native.uid });
  }
  for (const native of catalog.roles?.eligibleNativeSidekicks?.values() || []) {
    sidekicks.push({ ref: { kind: 'native', uid: native.uid }, label: native.label || native.uid,
      providerName: 'Devin', effort: native.effort ?? null,
      ...(native.effortOrder != null ? { effortOrder: native.effortOrder } : {}),
      ...(native.familyLabel ? { familyLabel: native.familyLabel } : {}),
      familyKey: native.familyUid || native.uid });
  }
  return { leads, sidekicks };
}

function refLabel(ref, catalog, config) {
  if (!validRef(ref)) return typeof ref?.uid === 'string' ? ref.uid : '';
  if (ref.kind === 'byok') return catalog.routes?.[ref.uid]?.label || ref.uid;
  const native = catalog.roles?.eligibleNativeLeads?.get(ref.uid) || catalog.roles?.eligibleNativeSidekicks?.get(ref.uid);
  return native?.label || ref.uid;
}

function refView(ref, catalog, config) {
  return { kind: ref.kind, uid: ref.uid, label: refLabel(ref, catalog, config) };
}

// GET /picker/state payload. Never includes apiKey or baseUrl.
function pickerState({ version, catalog, config }) {
  const byok = {};
  const providers = new Map((Array.isArray(config.providers) ? config.providers : []).map(p => [p.id, p]));
  for (const route of Object.values(catalog.routes || {})) {
    if (route.enabled === false) continue;
    const provider = providers.get(route.providerId);
    byok[route.uid] = {
      providerId: route.providerId, providerName: provider?.name || route.providerId,
      modelId: route.model, label: route.label || route.model, effort: route.effort ?? null,
      family: provider ? (provider.name || provider.id) : route.providerId,
      contextWindow: route.contextWindow, supportsImages: route.supportsImages === true,
    };
  }
  const slots = config.fusionSlots && typeof config.fusionSlots === 'object' ? config.fusionSlots : {};
  const fusionSlots = {};
  for (const slot of ['a', 'b']) {
    const current = slots[slot];
    if (current && validRef(current.lead) && validRef(current.sidekick)) {
      fusionSlots[slot] = { lead: refView(current.lead, catalog, config), sidekick: refView(current.sidekick, catalog, config) };
    }
  }
  const lists = candidates(catalog, config);
  return { version, enabled: config.enabled !== false, byok, fusionSlots,
    fusionCandidates: { leads: lists.leads, sidekicks: lists.sidekicks } };
}

// POST /picker/fusion. Writes the chosen pair into the alternating slot and
// returns the fusion uid the renderer should select.
async function pickerFusion(body, { catalog, config, configFile, writeConfig, observedNatives }) {
  if (config.enabled === false) return { status: 503, body: { error: 'disabled' } };
  if (!body || typeof body !== 'object' || Array.isArray(body) || !validRef(body.lead) || !validRef(body.sidekick)) {
    return { status: 400, body: { error: 'invalid_ref' } };
  }
  const lists = candidates(catalog, config);
  const lead = lists.leads.find(item => refKey(item.ref) === refKey(body.lead));
  const sidekick = lists.sidekicks.find(item => refKey(item.ref) === refKey(body.sidekick));
  if (!lead || !sidekick) return { status: 400, body: { error: 'invalid_ref' } };
  const sameModel = body.lead.kind === 'byok' && body.sidekick.kind === 'byok'
    ? catalog.routes[body.lead.uid].providerId === catalog.routes[body.sidekick.uid].providerId &&
      catalog.routes[body.lead.uid].model === catalog.routes[body.sidekick.uid].model
    : body.lead.kind === 'native' && body.sidekick.kind === 'native' && body.lead.uid === body.sidekick.uid;
  if (sameModel) return { status: 400, body: { error: 'same_model' } };
  if (body.lead.kind === 'native' && body.sidekick.kind === 'native') {
    const officialUid = 'fusion-' + body.lead.uid + '-sidekick-' + body.sidekick.uid;
    const observed = observedNatives?.get(officialUid);
    if (observed && observed.disabled !== true) return { status: 200, body: { uid: officialUid } };
  }
  // Re-selecting the pair a slot already holds is a no-op: keep that uid
  // instead of rewriting the other slot.
  const slots = config.fusionSlots && typeof config.fusionSlots === 'object' ? config.fusionSlots : {};
  const sameRef = (a, b) => a?.kind === b?.kind && a?.uid === b?.uid;
  const held = ['a', 'b'].find(key => sameRef(slots[key]?.lead, body.lead) && sameRef(slots[key]?.sidekick, body.sidekick));
  if (held) return { status: 200, body: { uid: 'fusion-dmp-' + held } };
  const slot = body.currentUid === 'fusion-dmp-a' ? 'b' : 'a';
  const next = { ...config, fusionSlots: { ...(config.fusionSlots || {}),
    [slot]: { lead: { kind: body.lead.kind, uid: body.lead.uid }, sidekick: { kind: body.sidekick.kind, uid: body.sidekick.uid } } } };
  writeConfig(configFile, next);
  return { status: 200, body: { uid: 'fusion-dmp-' + slot } };
}

// baseUrl with credentials and query stripped — safe to echo back. Stored
// values already pass validation; this guards hand-edited config.json files.
function safeBaseUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return String(value || '').split('?')[0]; }
}

// Per-provider public view — never includes apiKey.
function providerView(provider) {
  return {
    id: provider.id, name: provider.name, baseUrl: safeBaseUrl(provider.baseUrl),
    apiFormat: provider.apiFormat, keyConfigured: !!provider.apiKey,
    enabled: provider.enabled !== false,
    models: (provider.models || []).map(model => ({ id: model.id, label: model.label || model.id,
      enabled: model.enabled !== false, contextWindow: model.contextWindow,
      efforts: model.efforts, supportsImages: model.supportsImages !== false,
      missing: model.meta?.missing === true })),
  };
}

// GET /picker/providers — never includes apiKey.
function providerList(config) {
  return { providers: (Array.isArray(config.providers) ? config.providers : []).map(providerView) };
}

function ensureProviders(config) { if (!Array.isArray(config.providers)) config.providers = []; }

const PROVIDER_POSTS = new Map([
  ['/picker/providers/save', async (body, ctx) => {
    const config = ctx.config;
    ensureProviders(config);
    const id = ops.saveProvider(config, body || {});
    ctx.writeConfig(ctx.configFile, config);
    return { status: 200, body: { id } };
  }],
  ['/picker/providers/discover', async (body, ctx) => {
    const config = ctx.config;
    ensureProviders(config);
    const index = await ctx.modelsDevIndex?.();
    let result;
    try {
      result = await ops.discoverModels(config, body || {}, { discover: ctx.discover, index });
    } catch (error) {
      if (error instanceof ops.SettingsInputError) throw error;
      return { status: 502, body: { error: 'discover_failed', message: '获取模型失败，请检查接口配置和连接状态。' } };
    }
    const pending = ctx.pendingDiscovers || (ctx.pendingDiscovers = new Map());
    const token = crypto.randomUUID();
    pending.set(result.provider.id, { providerId: result.provider.id,
      signature: ops.signature(result.provider), token, models: result.models });
    return { status: 200, body: { token, models: ops.importView(result.provider, result.models) } };
  }],
  ['/picker/providers/import', async (body, ctx) => {
    const config = ctx.config;
    ensureProviders(config);
    const id = typeof body?.id === 'string' ? body.id : body?.providerId;
    const count = ops.importModels(config, body || {}, ctx.pendingDiscovers?.get(id) ?? null);
    ctx.writeConfig(ctx.configFile, config);
    return { status: 200, body: { ok: true, imported: count } };
  }],
  ['/picker/providers/delete', async (body, ctx) => {
    const config = ctx.config;
    ensureProviders(config);
    ops.deleteProvider(config, body || {});
    ctx.pendingDiscovers?.delete(body?.id);
    ctx.writeConfig(ctx.configFile, config);
    return { status: 200, body: { ok: true } };
  }],
  ['/picker/models/remove', async (body, ctx) => {
    const config = ctx.config;
    ensureProviders(config);
    ops.removeModel(config, body || {});
    ctx.writeConfig(ctx.configFile, config);
    return { status: 200, body: { ok: true } };
  }],
  // One-call connect: probe the endpoint, create/update the provider, then
  // fetch + merge the full model list (all recorded, disabled by default).
  ['/picker/providers/connect', async (body, ctx) => {
    const config = ctx.config;
    ensureProviders(config);
    const probed = await ops.probeProvider({ baseUrl: body?.baseUrl, apiKey: body?.apiKey, fetchImpl: ctx.fetchImpl || fetch });
    let provider;
    if (body?.id) {
      provider = ops.providerAt(config, body.id);
      Object.assign(provider, { baseUrl: probed.baseUrl, apiFormat: probed.apiFormat,
        apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : provider.apiKey });
    } else {
      provider = { id: 'provider-' + crypto.randomUUID(), name: ops.uniqueName(probed.name, config),
        baseUrl: probed.baseUrl, apiFormat: probed.apiFormat, apiKey: String(body?.apiKey || '').trim(),
        enabled: true, models: [] };
      config.providers.push(provider);
    }
    const index = await ctx.modelsDevIndex?.();
    let items;
    try { items = await ctx.discover(provider); }
    catch { return { status: 502, body: { error: 'discover_failed', message: '获取模型失败，请检查接口配置和连接状态。' } }; }
    ops.mergeDiscovered(provider, items, index);
    ctx.writeConfig(ctx.configFile, config);
    return { status: 200, body: { provider: providerView(provider) } };
  }],
  // Re-fetch + merge without re-probing.
  ['/picker/providers/refresh', async (body, ctx) => {
    const config = ctx.config;
    ensureProviders(config);
    const provider = ops.providerAt(config, body?.id);
    const index = await ctx.modelsDevIndex?.();
    let items;
    try { items = await ctx.discover(provider); }
    catch { return { status: 502, body: { error: 'discover_failed', message: '获取模型失败，请检查接口配置和连接状态。' } }; }
    ops.mergeDiscovered(provider, items, index);
    ctx.writeConfig(ctx.configFile, config);
    return { status: 200, body: { provider: providerView(provider) } };
  }],
  // Rename / override format / rotate key.
  ['/picker/providers/update', async (body, ctx) => {
    const config = ctx.config;
    ensureProviders(config);
    ops.updateProvider(config, body || {});
    ctx.writeConfig(ctx.configFile, config);
    return { status: 200, body: { provider: providerView(ops.providerAt(config, body.id)) } };
  }],
  // Bulk show/hide of provider models.
  ['/picker/models/enabled', async (body, ctx) => {
    const config = ctx.config;
    ensureProviders(config);
    const applied = ops.setModelsEnabled(config, body || {});
    ctx.writeConfig(ctx.configFile, config);
    return { status: 200, body: { ok: true, applied } };
  }],
]);

async function readBody(request, limit = BODY_LIMIT) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

// Returns true when the request was handled. Caller already enforced the exact
// picker Origin and answered OPTIONS preflights.
async function handlePickerRequest(request, response, pathname, context) {
  if (request.method === 'GET' && pathname === '/picker/state') {
    send(response, 200, pickerState(context));
    return true;
  }
  if (request.method === 'POST' && pathname === '/picker/fusion') {
    let body;
    try { body = JSON.parse(await readBody(request)); }
    catch (error) {
      send(response, error?.message === 'too_large' ? 413 : 400, { error: error?.message === 'too_large' ? 'too_large' : 'invalid_ref' });
      return true;
    }
    const result = await pickerFusion(body, context);
    send(response, result.status, result.body);
    return true;
  }
  if (request.method === 'GET' && pathname === '/picker/providers') {
    send(response, 200, providerList(context.config));
    return true;
  }
  const providerPost = PROVIDER_POSTS.get(pathname);
  if (request.method === 'POST' && providerPost) {
    let body;
    try { body = JSON.parse(await readBody(request)); }
    catch (error) {
      send(response, error?.message === 'too_large' ? 413 : 400, { error: error?.message === 'too_large' ? 'too_large' : 'invalid_input' });
      return true;
    }
    try {
      const result = await providerPost(body, context);
      send(response, result.status, result.body);
    } catch (error) {
      if (error instanceof ops.SettingsInputError) {
        send(response, 400, { error: 'invalid_input', message: error.message });
      } else throw error;
    }
    return true;
  }
  send(response, 404, { error: 'not_found' });
  return true;
}

module.exports = { PICKER_ORIGIN, corsHeaders, pickerState, pickerFusion, handlePickerRequest, candidates };
