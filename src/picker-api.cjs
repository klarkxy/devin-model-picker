'use strict';

// Renderer-side card picker API. The injected workbench script runs with origin
// vscode-file://vscode-app; that exact origin is required on every /picker/*
// request while all other backend routes keep rejecting any Origin header.
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
    const provider = providers.get(route.providerId);
    const candidate = {
      ref: { kind: 'byok', uid: route.uid },
      label: route.label || route.model,
      providerName: provider?.name || route.providerId,
      effort: route.effort ?? null,
      familyKey: 'byok:' + route.providerId + ':' + route.model,
    };
    leads.push(candidate);
    sidekicks.push({ ...candidate, ref: { ...candidate.ref } });
  }
  for (const native of catalog.roles?.eligibleNativeLeads?.values() || []) {
    leads.push({ ref: { kind: 'native', uid: native.uid }, label: native.label || native.uid,
      providerName: 'Devin', effort: native.effortDimension?.name ?? null, familyKey: native.familyUid || native.uid });
  }
  for (const native of catalog.roles?.eligibleNativeSidekicks?.values() || []) {
    sidekicks.push({ ref: { kind: 'native', uid: native.uid }, label: native.label || native.uid,
      providerName: 'Devin', effort: null, familyKey: native.familyUid || native.uid });
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
  const slot = body.currentUid === 'fusion-dmp-a' ? 'b' : 'a';
  const next = { ...config, fusionSlots: { ...(config.fusionSlots || {}),
    [slot]: { lead: { kind: body.lead.kind, uid: body.lead.uid }, sidekick: { kind: body.sidekick.kind, uid: body.sidekick.uid } } } };
  writeConfig(configFile, next);
  return { status: 200, body: { uid: 'fusion-dmp-' + slot } };
}

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
  send(response, 404, { error: 'not_found' });
  return true;
}

module.exports = { PICKER_ORIGIN, corsHeaders, pickerState, pickerFusion, handlePickerRequest, candidates };
