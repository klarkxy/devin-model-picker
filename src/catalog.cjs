'use strict';

const crypto = require('node:crypto');
const { parseFields, str, s, v, m } = require('./protocol/wire.cjs');
const { modelEfforts, modelSupportsImages } = require('./model-capabilities.cjs');

const FUSION_GROUP = 'BYOK Fusion';
const MODEL_GROUP = 'BYOK 模型';
const GROUP_NAMES = new Set([FUSION_GROUP, MODEL_GROUP]);
const FUSION_UIDS = ['fusion-dmp-a', 'fusion-dmp-b'];
const SIDEKICK_HARNESSES = ['swe-1p6', 'swe-1p5'];
const ownUid = uid => typeof uid === 'string' && /^(?:dmp-|fusion-dmp-)/.test(uid);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slug = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'model';
const concat = parts => Buffer.concat(parts);
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : fallback;

function effortMetadata(effort) {
  const names = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
  const orders = { none: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6, minimal: 7 };
  const key = effort || 'none';
  return { order: orders[key] ?? 100 + parseInt(digest(key).slice(0, 6), 16), name: names[key] || key, controlType: 1 };
}

function encodeFamily(family) {
  return concat([s(1, family.modelFamilyLabel), ...family.entries.map(entry => m(2,
    concat([s(1, entry.key), m(2, concat([v(1, entry.value.order || 0), s(2, entry.value.name || ''), v(3, entry.value.controlType || 0)]))])))]);
}

function encodeConfig(config) {
  const info = config.modelInfo;
  const features = info.modelFeatures;
  const infoRaw = concat([
    v(3, info.modelType), v(4, info.maxTokens),
    m(6, concat([v(8, 1), ...(features.supportsImages ? [v(11, 1)] : []), v(12, 1),
      ...(features.supportsThinking ? [v(15, 1)] : []), v(21, 1)])),
    v(13, info.maxOutputTokens), s(17, info.modelUid), s(18, info.inferenceServerUrl),
    ...info.harnessUids.map(uid => s(20, uid)),
    ...(info.displayOption ? [v(22, info.displayOption)] : []),
    s(23, info.modelFamilyUid), ...(info.isModelRouter ? [v(25, 1)] : []),
  ]);
  return concat([s(1, config.label), ...(config.supportsImages ? [v(5, 1)] : []),
    v(10, config.provider), v(18, config.maxTokens),
    s(22, config.modelUid), m(23, infoRaw), m(30, encodeFamily(config.modelFamilyMetadata))]);
}

function configFor({ uid, label, family, familyUid, contextWindow, maxOutputTokens, effort, fusion, supportsImages, inferenceServerUrl }) {
  const json = {
    label, modelUid: uid, provider: fusion ? 1 : 2,
    maxTokens: contextWindow, supportsImages: !!supportsImages,
    modelInfo: {
      modelUid: uid, modelType: 2, maxTokens: contextWindow,
      maxOutputTokens,
      inferenceServerUrl,
      harnessUids: fusion ? ['fusion'] : [...SIDEKICK_HARNESSES],
      displayOption: fusion ? 3 : 0, modelFamilyUid: familyUid, isModelRouter: !!fusion,
      modelFeatures: { zeroShotCapable: true, supportsImages: !!supportsImages, supportsToolCalls: true,
        supportsParallelToolCalls: true, supportsThinking: !!effort && effort !== 'none' },
    },
    modelFamilyMetadata: family,
  };
  return { uid, label, effort, kind: fusion ? 'fusion' : 'model', json, raw: encodeConfig(json) };
}

// Derives which observed native models may lead or sidekick a Fusion by reading
// the official `fusion-<lead>-sidekick-<sidekick>` router entries and their
// Lead/Effort/Sidekick family dimensions. Conflicting claims disqualify a uid.
function discoverOfficialRoles(nativeModels) {
  const observed = Array.isArray(nativeModels) ? nativeModels : [];
  const observedUids = new Set();
  const nativeModelsMap = new Map();
  for (const entry of observed) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (uid && uid.length <= 256 && !ownUid(uid) && !uid.startsWith('fusion-')) {
      observedUids.add(uid);
      nativeModelsMap.set(uid, entry);
    }
  }

  const leadNamesByOrder = new Map(), leadClaimsByTuple = new Map();
  const sidekickClaimsByUid = new Map(), sidekickClaimsByOrder = new Map();

  for (const entry of observed) {
    const uid = typeof entry?.uid === 'string' ? entry.uid : '';
    if (!uid.startsWith('fusion-') || ownUid(uid)) continue;
    const marker = uid.lastIndexOf('-sidekick-');
    if (marker < 0 || marker <= 'fusion-'.length) continue;

    const fusionMeta = Array.isArray(entry.fusionMetadata) ? entry.fusionMetadata : null;
    const leadDim = fusionMeta?.find(d => d.key === 'Lead');
    const effortDim = fusionMeta?.find(d => d.key === 'Effort');
    let sidekickDim = fusionMeta?.find(d => d.key === 'Sidekick');
    let fastModeDim = fusionMeta?.find(d => d.key === 'Fast Mode');

    if (!sidekickDim && entry.sidekickDimension) {
      sidekickDim = { order: entry.sidekickDimension.order, name: entry.sidekickDimension.name, controlType: 3 };
      fastModeDim = { order: entry.sidekickDimension.fastModeOrder ?? 0 };
    }

    const leadCandidate = uid.slice('fusion-'.length, marker);
    const sideCandidate = uid.slice(marker + '-sidekick-'.length);
    const leadKnown = observedUids.has(leadCandidate);
    const sideKnown = observedUids.has(sideCandidate);

    if (fastModeDim && fastModeDim.order !== 0) continue;
    if (entry.disabled !== false) continue;
    if (!Array.isArray(entry.harnessUids) || !entry.harnessUids.includes('fusion')) continue;

    const sideNative = sideKnown ? nativeModelsMap.get(sideCandidate) : null;
    if (sideKnown && sideNative.disabled === false && sideNative.isModelRouter === false && sideNative.harnessUids?.length) {
      if (sidekickDim && Number.isSafeInteger(sidekickDim.order) && sidekickDim.name) {
        if (!sidekickClaimsByUid.has(sideCandidate)) {
          sidekickClaimsByUid.set(sideCandidate, { orders: new Set(), names: new Set() });
        }
        const rec = sidekickClaimsByUid.get(sideCandidate);
        rec.orders.add(sidekickDim.order);
        rec.names.add(sidekickDim.name);
        if (!sidekickClaimsByOrder.has(sidekickDim.order)) sidekickClaimsByOrder.set(sidekickDim.order, new Set());
        sidekickClaimsByOrder.get(sidekickDim.order).add(sideCandidate);
      }
    }

    if (!leadKnown || !sideKnown) continue;
    const leadNative = nativeModelsMap.get(leadCandidate);
    if (leadNative.disabled !== false || leadNative.isModelRouter !== false || !leadNative.harnessUids?.length) continue;
    if (sideNative.disabled !== false || sideNative.isModelRouter !== false || !sideNative.harnessUids?.length) continue;

    if (leadDim && Number.isSafeInteger(leadDim.order) && leadDim.name &&
        effortDim && Number.isSafeInteger(effortDim.order) && effortDim.name) {
      if (!leadNamesByOrder.has(leadDim.order)) leadNamesByOrder.set(leadDim.order, new Set());
      leadNamesByOrder.get(leadDim.order).add(leadDim.name);

      if (!leadClaimsByTuple.has(leadCandidate)) {
        leadClaimsByTuple.set(leadCandidate, {
          leadOrder: leadDim.order, leadName: leadDim.name,
          effortOrder: effortDim.order, effortName: effortDim.name,
          harnesses: new Set(),
          tuples: new Set(),
        });
      }
      const rec = leadClaimsByTuple.get(leadCandidate);
      rec.tuples.add(leadDim.order + ':' + effortDim.order + ':' + leadDim.name + ':' + effortDim.name);
      rec.harnesses.add(JSON.stringify(entry.harnessUids));
    }
  }

  const inconsistentLeadOrders = new Set();
  for (const [order, names] of leadNamesByOrder) {
    if (names.size > 1) inconsistentLeadOrders.add(order);
  }

  const leadConflicts = new Set();
  const uidByTuple = new Map();
  for (const [uid, rec] of leadClaimsByTuple) {
    if (rec.tuples.size !== 1 || rec.harnesses.size !== 1 || inconsistentLeadOrders.has(rec.leadOrder)) {
      leadConflicts.add(uid);
      continue;
    }
    const tupleKey = rec.leadOrder + ':' + rec.effortOrder;
    if (uidByTuple.has(tupleKey)) {
      leadConflicts.add(uid);
      leadConflicts.add(uidByTuple.get(tupleKey));
    } else {
      uidByTuple.set(tupleKey, uid);
    }
  }

  const sidekickConflicts = new Set();
  for (const uids of sidekickClaimsByOrder.values()) if (uids.size > 1) for (const u of uids) sidekickConflicts.add(u);
  for (const [u, rec] of sidekickClaimsByUid) {
    if (rec.orders.size !== 1 || rec.names.size !== 1) sidekickConflicts.add(u);
  }

  const eligibleNativeLeads = new Map();
  for (const [uid, rec] of leadClaimsByTuple) {
    if (leadConflicts.has(uid)) continue;
    const native = nativeModelsMap.get(uid);
    const harnesses = JSON.parse([...rec.harnesses][0]);
    eligibleNativeLeads.set(uid, {
      uid, label: native.label || uid,
      leadDimension: { order: rec.leadOrder, name: rec.leadName, controlType: 3 },
      effortDimension: { order: rec.effortOrder, name: rec.effortName, controlType: 1 },
      ...(native.familyUid ? { familyUid: native.familyUid } : {}),
      ...(native.familyLabel ? { familyLabel: native.familyLabel } : {}),
      ...(native.modelEffortDimension ? { effortOrder: native.modelEffortDimension.order } : {}),
      leadHarnessUids: harnesses,
      maxTokens: native.maxTokens,
      maxOutputTokens: native.maxOutputTokens,
      supportsImages: native.supportsImages,
    });
  }

  const eligibleNativeSidekicks = new Map();
  for (const [uid, rec] of sidekickClaimsByUid) {
    if (sidekickConflicts.has(uid)) continue;
    const native = nativeModelsMap.get(uid);
    const sidekickOrder = [...rec.orders][0];
    const sidekickName = [...rec.names][0];
    eligibleNativeSidekicks.set(uid, {
      uid, label: sidekickName || native.label || uid,
      dimension: { order: sidekickOrder, name: sidekickName },
      ...(native.familyUid ? { familyUid: native.familyUid } : {}),
      ...(native.familyLabel ? { familyLabel: native.familyLabel } : {}),
      ...(native.modelEffortDimension ? { effort: native.modelEffortDimension.name, effortOrder: native.modelEffortDimension.order } : {}),
      harnessUids: native.harnessUids,
    });
  }

  // Beyond officially-paired fusion entries, every other routable native is a
  // candidate too. Its derived lead harness is ['fusion', ...own harnessUids] —
  // the same shape an official fusion entry encodes for its lead — and as
  // sidekick it keeps its own harnessUids. Non-official native pairs are then
  // routed through our fusion-dmp slots with these harnesses (hypothesis until
  // verified live).
  for (const [uid, native] of nativeModelsMap) {
    if (native.disabled !== false || native.isModelRouter !== false) continue;
    if (!Array.isArray(native.harnessUids) || !native.harnessUids.length) continue;
    const effort = native.modelEffortDimension;
    if (!eligibleNativeLeads.has(uid)) {
      eligibleNativeLeads.set(uid, {
        uid, label: native.label || uid,
        leadDimension: null,
        effortDimension: effort ? { order: effort.order, name: effort.name, controlType: 1 } : null,
        ...(native.familyUid ? { familyUid: native.familyUid } : {}),
        ...(native.familyLabel ? { familyLabel: native.familyLabel } : {}),
        ...(effort ? { effortOrder: effort.order } : {}),
        leadHarnessUids: ['fusion', ...native.harnessUids],
        maxTokens: native.maxTokens,
        maxOutputTokens: native.maxOutputTokens,
        supportsImages: native.supportsImages,
      });
    }
    if (!eligibleNativeSidekicks.has(uid)) {
      eligibleNativeSidekicks.set(uid, {
        uid, label: native.label || uid,
        dimension: effort ? { order: effort.order, name: effort.name } : null,
        ...(native.familyUid ? { familyUid: native.familyUid } : {}),
        ...(native.familyLabel ? { familyLabel: native.familyLabel } : {}),
        ...(effort ? { effort: effort.name, effortOrder: effort.order } : {}),
        harnessUids: native.harnessUids,
      });
    }
  }

  return { eligibleNativeLeads, eligibleNativeSidekicks };
}

// Resolves one fusion-slot reference { kind: 'byok'|'native', uid } against the
// catalog routes and the observed native roles. Unresolvable refs return null.
function resolveSlotRef(ref, role, routes, roles) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.uid !== 'string') return null;
  if (ref.kind === 'byok') {
    const route = routes[ref.uid];
    return route ? { uid: route.uid, native: false, contextWindow: route.contextWindow, maxOutputTokens: route.maxOutputTokens, supportsImages: route.supportsImages } : null;
  }
  if (ref.kind === 'native') {
    const eligible = role === 'lead' ? roles.eligibleNativeLeads : roles.eligibleNativeSidekicks;
    const native = eligible.get(ref.uid);
    if (!native) return null;
    return { uid: ref.uid, native: true,
      harnessUids: role === 'lead' ? native.leadHarnessUids : native.harnessUids,
      contextWindow: positive(native.maxTokens, 272000),
      maxOutputTokens: Math.min(positive(native.maxOutputTokens, 16384), positive(native.maxTokens, 272000)),
      supportsImages: native.supportsImages === true };
  }
  return null;
}

/** Build a secret-free catalog. Provider credentials stay solely in caller configuration. */
function buildCatalog(config = {}, nativeModels = []) {
  if (config.enabled === false) {
    return { models: [], cliModels: [], routes: {}, fusions: {}, roles: { eligibleNativeLeads: new Map(), eligibleNativeSidekicks: new Map() } };
  }
  const models = [], cliModels = [], routes = {}, fusions = {}, leads = [];
  const inferenceServerUrl = config.inferenceServerUrl || 'https://server.codeium.com';
  const inferenceUrl = new URL(inferenceServerUrl);
  if (!['http:', 'https:'].includes(inferenceUrl.protocol) || inferenceUrl.username || inferenceUrl.password) {
    throw new Error('Invalid inference server URL');
  }
  const providers = Array.isArray(config.providers) ? config.providers.filter(provider => provider && provider.enabled !== false) : [];
  const identities = new Set();
  for (const provider of providers) {
    if (typeof provider.id !== 'string' || !provider.id) throw new Error('Provider id is required');
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      if (!model) continue;
      if (typeof model.id !== 'string' || !model.id) throw new Error('Model id is required');
      const key = JSON.stringify([provider.id, model.id]);
      if (identities.has(key)) throw new Error('Duplicate provider/model identity');
      identities.add(key);
      // Disabled models still produce routes and CLI-side entries so a hidden
      // BYOK uid keeps working in existing sessions and visibility toggles
      // become a renderer-catalog-only change.
      const enabled = model.enabled !== false;
      const prefix = provider.name || provider.id, sourceLabel = model.label || model.id;
      const familyLabel = sourceLabel.startsWith(prefix + ' · ') ? sourceLabel : `${prefix} · ${sourceLabel}`;
      const efforts = modelEfforts(model);
      for (const effort of efforts) {
        if (effort !== null && (typeof effort !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(effort))) throw new Error('Invalid effort value');
        const uid = `dmp-${slug(provider.id)}-${slug(model.id)}-${digest([provider.id, model.id, effort]).slice(0, 16)}`;
        const contextWindow = positive(model.contextWindow, 272000);
        const maxOutputTokens = Math.min(positive(model.maxOutputTokens, 131072), contextWindow);
        const lead = { uid, key, familyLabel, providerId: provider.id, model: model.id, effort, enabled,
          contextWindow, maxOutputTokens, supportsImages: modelSupportsImages(model), inferenceServerUrl };
        leads.push(lead);
        routes[uid] = { uid, providerId: provider.id, model: model.id, effort, enabled, contextWindow, maxOutputTokens,
          supportsImages: lead.supportsImages, label: familyLabel + (effort ? ` ${effortMetadata(effort).name}` : '') };
      }
    }
  }
  const roles = discoverOfficialRoles(nativeModels);

  // Labels also identify entries in native sort groups. Disambiguate providers
  // with equal display names without changing stable routing identities.
  const familyKeys = new Map();
  for (const lead of leads) {
    if (!familyKeys.has(lead.familyLabel)) familyKeys.set(lead.familyLabel, new Set());
    familyKeys.get(lead.familyLabel).add(lead.key);
  }
  for (const lead of leads) if (familyKeys.get(lead.familyLabel).size > 1) lead.familyLabel += ` (${lead.providerId}/${lead.model})`;
  for (const lead of leads) {
    const effort = effortMetadata(lead.effort);
    const entry = configFor({ ...lead, label: lead.familyLabel + (lead.effort ? ` ${effort.name}` : ''),
      familyUid: 'dmp-family-' + digest(lead.key).slice(0, 16),
      family: { modelFamilyLabel: lead.familyLabel, entries: [{ key: 'Effort', value: effort }] } });
    cliModels.push(entry);
    if (lead.enabled) models.push(entry);
  }

  // Two stable Fusion entries the renderer card picker alternates between.
  // Slot refs that cannot resolve are omitted from `fusions`; AssignModel for
  // such a uid is then forwarded upstream unchanged.
  const slots = config.fusionSlots && typeof config.fusionSlots === 'object' ? config.fusionSlots : {};
  for (const slot of ['a', 'b']) {
    const uid = 'fusion-dmp-' + slot;
    const configured = slots[slot] && typeof slots[slot] === 'object' ? slots[slot] : null;
    const lead = configured ? resolveSlotRef(configured.lead, 'lead', routes, roles) : null;
    const sidekick = configured ? resolveSlotRef(configured.sidekick, 'sidekick', routes, roles) : null;
    const contextWindow = lead?.contextWindow ?? 272000;
    const maxOutputTokens = Math.min(lead?.maxOutputTokens ?? 131072, contextWindow);
    const fusionConfig = configFor({ uid, label: FUSION_GROUP,
      familyUid: 'dmp-fusion-family', family: { modelFamilyLabel: FUSION_GROUP, entries: [] },
      contextWindow, maxOutputTokens, supportsImages: lead?.supportsImages !== false, fusion: true, inferenceServerUrl });
    models.unshift(fusionConfig);
    cliModels.unshift(fusionConfig);
    if (lead && sidekick) {
      fusions[uid] = { uid, label: FUSION_GROUP, leadUid: lead.uid, sidekickUid: sidekick.uid,
        leadNative: lead.native, sidekickNative: sidekick.native,
        ...(lead.native ? { leadHarnessUids: lead.harnessUids } : {}),
        ...(sidekick.native ? { sidekickHarnessUids: sidekick.harnessUids } : {}) };
    }
  }
  return { models, cliModels, routes, fusions, roles };
}

function rpcShape(rpc) {
  let value = typeof rpc === 'string' ? rpc : rpc?.path || rpc?.name || '';
  try { if (value.includes('://')) value = new URL(value).pathname; } catch { return null; }
  value = value.split('?')[0];
  const method = value.slice(value.lastIndexOf('/') + 1);
  if (method === 'GetUserStatus') return { status: true, field: 1, sorts: true };
  if (['GetCliModelConfigs', 'GetCascadeModelConfigs', 'GetCommandModelConfigs'].includes(method))
    return { status: false, sorts: method === 'GetCascadeModelConfigs', cli: method === 'GetCliModelConfigs' };
  return null;
}

function rewriteMessage(data, number, transform, create = false) {
  const parsed = parseFields(data), matches = parsed.filter(field => field.number === number);
  if (matches.length > 1 || matches.some(field => field.wire !== 2)) throw new Error('Ambiguous catalog message');
  if (!matches.length) return create ? concat([data, m(number, transform(Buffer.alloc(0)))]) : data;
  return concat(parsed.map(field => field.number === number ? m(number, transform(field.value)) : field.raw));
}

function protoUid(entry) {
  const uids = parseFields(entry).filter(field => field.number === 22);
  if (uids.length !== 1 || uids[0].wire !== 2) return '';
  return uids[0].value.toString('utf8');
}

function protoDisabled(entry) {
  const flags = parseFields(entry).filter(field => field.number === 4);
  if (!flags.length) return false;
  if (flags.length !== 1 || flags[0].wire !== 0) return true;
  return Number(flags[0].value) !== 0;
}

function protoMetadata(entry) {
  const infos = parseFields(entry).filter(field => field.number === 23);
  if (infos.length !== 1 || infos[0].wire !== 2) return { harnessUids: [], isModelRouter: false };
  try {
    const inner = parseFields(infos[0].value);
    const harnesses = inner.filter(field => field.number === 20);
    if (harnesses.some(field => field.wire !== 2)) return { harnessUids: [], isModelRouter: false };
    const routers = inner.filter(field => field.number === 25);
    if (routers.length > 1 || routers.some(field => field.wire !== 0)) return { harnessUids: [], isModelRouter: false };
    const maxTokensFields = inner.filter(field => field.number === 4);
    const maxOutputFields = inner.filter(field => field.number === 13);
    const featuresFields = inner.filter(field => field.number === 6);
    let maxTokens, maxOutputTokens, supportsImages = false;
    if (maxTokensFields.length === 1 && maxTokensFields[0].wire === 0) {
      const val = Number(maxTokensFields[0].value);
      if (Number.isSafeInteger(val) && val > 0) maxTokens = val;
    }
    if (maxOutputFields.length === 1 && maxOutputFields[0].wire === 0) {
      const val = Number(maxOutputFields[0].value);
      if (Number.isSafeInteger(val) && val > 0) maxOutputTokens = val;
    }
    if (featuresFields.length === 1 && featuresFields[0].wire === 2) {
      const featInner = parseFields(featuresFields[0].value);
      const imgFields = featInner.filter(f => f.number === 11);
      if (imgFields.length === 1 && imgFields[0].wire === 0 && Number(imgFields[0].value) === 1) {
        supportsImages = true;
      }
    }
    return {
      harnessUids: harnesses.map(field => field.value.toString('utf8')),
      isModelRouter: routers.length === 1 && Number(routers[0].value) !== 0,
      ...(maxTokens ? { maxTokens } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(supportsImages ? { supportsImages: true } : {}),
    };
  } catch { return { harnessUids: [], isModelRouter: false }; }
}

// Family identity + own effort dimension of a native model: familyUid lives in
// modelInfo field 23, familyLabel in the family message field 1, effort = the
// named dimension whose key matches /effort/i (or the only named one).
// Tolerates proto3 zero-omission (absent order → 0).
function protoFamilyInfo(entry) {
  try {
    const fields = parseFields(entry);
    const infos = fields.filter(field => field.number === 23 && field.wire === 2);
    const familyUid = infos.length === 1
      ? (parseFields(infos[0].value).find(field => field.number === 23 && field.wire === 2)?.value.toString('utf8') || '') : '';
    const fams = fields.filter(field => field.number === 30 && field.wire === 2);
    let familyLabel = '', effortDimension = null;
    if (fams.length === 1) {
      const parts = parseFields(fams[0].value);
      familyLabel = parts.find(field => field.number === 1 && field.wire === 2)?.value.toString('utf8') || '';
      const named = [];
      for (const field of parts.filter(field => field.number === 2 && field.wire === 2)) {
        const item = parseFields(field.value);
        const key = item.find(part => part.number === 1 && part.wire === 2)?.value.toString('utf8') || '';
        const valMsg = item.find(part => part.number === 2 && part.wire === 2);
        if (!key || !valMsg) continue;
        const dims = parseFields(valMsg.value);
        const orderField = dims.find(part => part.number === 1 && part.wire === 0);
        const nameField = dims.find(part => part.number === 2 && part.wire === 2);
        const name = nameField ? nameField.value.toString('utf8') : '';
        if (name) named.push({ key, order: orderField ? Number(orderField.value) : 0, name });
      }
      const effort = named.find(dim => /effort/i.test(dim.key)) || (named.length === 1 ? named[0] : null);
      if (effort) effortDimension = { order: effort.order, name: effort.name };
    }
    return { familyUid, familyLabel, effortDimension };
  } catch { return { familyUid: '', familyLabel: '', effortDimension: null }; }
}

function jsonFamilyInfo(entry) {
  const info = jsonAliasValue(entry, 'modelInfo', 'model_info');
  const famUid = !info.conflict && info.present && info.value && typeof info.value === 'object'
    ? jsonAliasValue(info.value, 'modelFamilyUid', 'model_family_uid') : { present: false };
  const meta = jsonAliasValue(entry, 'modelFamilyMetadata', 'model_family_metadata');
  let familyLabel = '', effortDimension = null;
  if (!meta.conflict && meta.present && meta.value && typeof meta.value === 'object' && !Array.isArray(meta.value)) {
    const label = jsonAliasValue(meta.value, 'modelFamilyLabel', 'model_family_label');
    if (!label.conflict && label.present && typeof label.value === 'string') familyLabel = label.value;
    const list = Array.isArray(meta.value.entries) ? meta.value.entries : [];
    const named = [];
    for (const item of list) {
      if (!item || typeof item.key !== 'string' || !item.value || typeof item.value !== 'object') continue;
      const name = typeof item.value.name === 'string' ? item.value.name : '';
      if (!name) continue;
      const order = item.value.order === undefined ? 0 : item.value.order;
      if (!Number.isSafeInteger(order) || order < 0) continue;
      named.push({ key: item.key, order, name });
    }
    const effort = named.find(dim => /effort/i.test(dim.key)) || (named.length === 1 ? named[0] : null);
    if (effort) effortDimension = { order: effort.order, name: effort.name };
  }
  return { familyUid: !famUid.conflict && famUid.present && typeof famUid.value === 'string' ? famUid.value : '',
    familyLabel, effortDimension };
}

const CANONICAL_FAMILY_KEYS = new Set(['Lead', 'Effort', 'Sidekick', 'Fast Mode', 'Recommended Sidekick']);

function protoFusionMetadata(entry) {
  const families = parseFields(entry).filter(field => field.number === 30);
  if (!families.length) return null;
  if (families.length !== 1 || families[0].wire !== 2) return null;
  try {
    const parts = parseFields(families[0].value);
    if (parts.some(field => field.number === 2 && field.wire !== 2)) return null;
    const entries = [];
    const keys = new Set();
    for (const field of parts.filter(field => field.number === 2)) {
      const item = parseFields(field.value);
      const keyFields = item.filter(part => part.number === 1);
      if (keyFields.length !== 1 || keyFields[0].wire !== 2) return null;
      const key = keyFields[0].value.toString('utf8');
      if (!CANONICAL_FAMILY_KEYS.has(key)) continue;
      if (keys.has(key)) return null;
      keys.add(key);
      const valFields = item.filter(part => part.number === 2);
      if (valFields.length !== 1 || valFields[0].wire !== 2) return null;
      const dims = parseFields(valFields[0].value);
      const orders = dims.filter(part => part.number === 1);
      const names = dims.filter(part => part.number === 2);
      const controls = dims.filter(part => part.number === 3);
      // Proto3 omits zero values: an absent order field means order 0 (real
      // Fast Mode and Recommended Sidekick dims carry order 0 and no name).
      if (orders.length > 1 || orders.some(part => part.wire !== 0)) return null;
      if (names.length > 1 || names.some(part => part.wire !== 2)) return null;
      if (controls.length > 1 || controls.some(part => part.wire !== 0)) return null;
      const order = orders.length ? Number(orders[0].value) : 0;
      const name = names.length ? names[0].value.toString('utf8') : '';
      const controlType = controls.length ? Number(controls[0].value) : 0;
      if (!Number.isSafeInteger(order) || order < 0 || order > 0x7fffffff) return null;
      if (!Number.isSafeInteger(controlType) || controlType < 0 || controlType > 0x7fffffff) return null;
      if (key !== 'Fast Mode' && key !== 'Recommended Sidekick' && !name) return null;
      entries.push({ key, order, name, controlType });
    }
    return entries.length ? entries : null;
  } catch { return null; }
}

function extractSidekickDimension(entries) {
  if (!Array.isArray(entries)) return null;
  const sidekick = entries.find(e => e.key === 'Sidekick');
  if (!sidekick || !sidekick.name) return null;
  const fastMode = entries.find(e => e.key === 'Fast Mode');
  return { order: sidekick.order, name: sidekick.name, fastModeOrder: fastMode ? fastMode.order : 0 };
}

function jsonAliasValue(object, camel, snake) {
  const hasCamel = has(object, camel), hasSnake = has(object, snake);
  if (hasCamel && hasSnake && JSON.stringify(object[camel]) !== JSON.stringify(object[snake])) return { conflict: true };
  return { value: hasCamel ? object[camel] : object[snake], present: hasCamel || hasSnake };
}

function jsonMetadata(entry) {
  const empty = { harnessUids: [], isModelRouter: false };
  const info = jsonAliasValue(entry, 'modelInfo', 'model_info');
  if (info.conflict || !info.present || !info.value || typeof info.value !== 'object' || Array.isArray(info.value)) return empty;
  const harness = jsonAliasValue(info.value, 'harnessUids', 'harness_uids');
  const router = jsonAliasValue(info.value, 'isModelRouter', 'is_model_router');
  if (harness.conflict || router.conflict) return empty;
  if (harness.present && (!Array.isArray(harness.value) || harness.value.some(value => typeof value !== 'string'))) return empty;
  if (router.present && typeof router.value !== 'boolean') return empty;
  const maxTokens = jsonAliasValue(info.value, 'maxTokens', 'max_tokens');
  const maxOutputTokens = jsonAliasValue(info.value, 'maxOutputTokens', 'max_output_tokens');
  const features = jsonAliasValue(info.value, 'modelFeatures', 'model_features');
  let supportsImages = false;
  if (!features.conflict && features.present && features.value && typeof features.value === 'object' && !Array.isArray(features.value)) {
    const img = jsonAliasValue(features.value, 'supportsImages', 'supports_images');
    if (!img.conflict && img.present && img.value === true) supportsImages = true;
  }
  return {
    harnessUids: harness.present ? harness.value : [],
    isModelRouter: router.value === true,
    ...(!maxTokens.conflict && maxTokens.present && Number.isSafeInteger(maxTokens.value) && maxTokens.value > 0 ? { maxTokens: maxTokens.value } : {}),
    ...(!maxOutputTokens.conflict && maxOutputTokens.present && Number.isSafeInteger(maxOutputTokens.value) && maxOutputTokens.value > 0 ? { maxOutputTokens: maxOutputTokens.value } : {}),
    ...(supportsImages ? { supportsImages: true } : {}),
  };
}

function jsonFusionMetadata(entry) {
  const meta = jsonAliasValue(entry, 'modelFamilyMetadata', 'model_family_metadata');
  if (meta.conflict || !meta.present || !meta.value || typeof meta.value !== 'object' || Array.isArray(meta.value)) return null;
  const list = meta.value.entries;
  if (!Array.isArray(list)) return null;
  const entries = [];
  const keys = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string') return null;
    const key = item.key;
    if (!CANONICAL_FAMILY_KEYS.has(key)) continue;
    if (keys.has(key)) return null;
    keys.add(key);
    const value = item.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const control = jsonAliasValue(value, 'controlType', 'control_type');
    if (control.conflict || (control.present && (!Number.isSafeInteger(control.value) || control.value < 0 || control.value > 0x7fffffff))) return null;
    // JSON mirrors proto3 zero-omission: absent order means 0.
    const order = value.order === undefined ? 0 : value.order;
    if (!Number.isSafeInteger(order) || order < 0 || order > 0x7fffffff) return null;
    if (value.name !== undefined && typeof value.name !== 'string') return null;
    const name = typeof value.name === 'string' ? value.name : '';
    const controlType = control.present ? control.value : 0;
    if (key !== 'Fast Mode' && key !== 'Recommended Sidekick' && !name) return null;
    entries.push({ key, order, name, controlType });
  }
  return entries.length ? entries : null;
}

function nativeEntries(entries, isJson) {
  const seen = [];
  for (const entry of entries) {
    let uid, label, disabled, meta, dimension, fusionMeta, family;
    if (isJson) {
      uid = nativeUid(entry);
      label = typeof entry?.label === 'string' ? entry.label : '';
      disabled = has(entry, 'disabled') ? entry.disabled !== false : false;
      meta = jsonMetadata(entry);
      fusionMeta = jsonFusionMetadata(entry);
      dimension = extractSidekickDimension(fusionMeta);
      family = jsonFamilyInfo(entry);
    } else {
      uid = protoUid(entry);
      label = str(entry, 1);
      disabled = protoDisabled(entry);
      meta = protoMetadata(entry);
      fusionMeta = protoFusionMetadata(entry);
      dimension = extractSidekickDimension(fusionMeta);
      family = protoFamilyInfo(entry);
    }
    if (typeof uid !== 'string' || !uid || uid.length > 256 || ownUid(uid)) continue;
    seen.push({
      uid, label, disabled, harnessUids: meta.harnessUids, isModelRouter: meta.isModelRouter,
      ...(family.familyUid ? { familyUid: family.familyUid } : {}),
      ...(family.familyLabel ? { familyLabel: family.familyLabel } : {}),
      ...(family.effortDimension ? { modelEffortDimension: family.effortDimension } : {}),
      ...(dimension ? { sidekickDimension: dimension } : {}),
      ...(fusionMeta ? { fusionMetadata: fusionMeta } : {}),
      ...(meta.maxTokens ? { maxTokens: meta.maxTokens } : {}),
      ...(meta.maxOutputTokens ? { maxOutputTokens: meta.maxOutputTokens } : {}),
      ...(meta.supportsImages ? { supportsImages: true } : {}),
    });
  }
  return seen;
}

function reportNativeModels(entries, isJson, report) {
  if (typeof report !== 'function') return;
  try { const seen = nativeEntries(entries, isJson); if (seen.length) report(seen); } catch {}
}

function ownGroups(models) {
  const fusionLabels = [...new Set(models.filter(model => model.kind === 'fusion').map(model => model.label))];
  const modelLabels = [...new Set(models.filter(model => model.kind !== 'fusion').map(model => model.label))];
  return [{ name: FUSION_GROUP, labels: fusionLabels }, { name: MODEL_GROUP, labels: modelLabels }].filter(group => group.labels.length);
}

function augmentProtoList(data, catalog, hasSorts = true, onNativeModels) {
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const parsed = parseFields(data), existingLabels = new Set(models.map(model => model.label));
  const entries = parsed.filter(field => field.number === 1 && field.wire === 2).map(field => field.value);
  reportNativeModels(entries, false, onNativeModels);
  const preserved = [];
  for (const field of parsed) {
    if (field.number === 1 && field.wire === 2 && ownUid(protoUid(field.value))) {
      existingLabels.add(str(field.value, 1)); continue;
    }
    preserved.push(field);
  }
  const groups = ownGroups(models);
  let sorts = 0;
  const result = preserved.map(field => {
    if (!hasSorts || field.number !== 2 || field.wire !== 2) return field.raw;
    sorts++;
    const parts = parseFields(field.value).filter(part => {
      if (part.number !== 2 || part.wire !== 2 || !GROUP_NAMES.has(str(part.value, 1))) return true;
      return !parseFields(part.value).filter(value => value.number === 2 && value.wire === 2)
        .every(value => existingLabels.has(value.value.toString('utf8')));
    });
    const position = parts.findIndex(part => part.number === 2 && part.wire === 2);
    if (groups.length) parts.splice(position < 0 ? parts.length : position, 0,
      ...groups.map(group => ({ raw: m(2, concat([s(1, group.name), ...group.labels.map(label => s(2, label))])) })));
    return m(2, concat(parts.map(part => part.raw)));
  });
  const own = models.map(model => m(1, model.raw));
  result.splice(Math.max(preserved.findIndex(field => field.number === 1 && field.wire === 2), 0), 0, ...own);
  if (hasSorts && !sorts && groups.length) result.push(m(2, concat([s(1, MODEL_GROUP),
    ...groups.map(group => m(2, concat([s(1, group.name), ...group.labels.map(label => s(2, label))])))])));
  return concat(result);
}

function jsonKey(object, camel, snake) { return has(object, snake) && !has(object, camel) ? snake : camel; }
function nativeUid(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
  const camel = entry.modelUid, snake = entry.model_uid;
  if (has(entry, 'modelUid') && has(entry, 'model_uid') && camel !== snake) return '';
  const uid = camel ?? snake;
  return typeof uid === 'string' ? uid : '';
}
function augmentJsonList(data, catalog, hasSorts = true, onNativeModels) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid catalog JSON');
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const modelsKey = jsonKey(data, 'clientModelConfigs', 'client_model_configs');
  const sortsKey = jsonKey(data, 'clientModelSorts', 'client_model_sorts');
  const existing = data[modelsKey] || [], sorts = data[sortsKey] || [];
  if (!Array.isArray(existing) || !Array.isArray(sorts)) throw new Error('Invalid catalog list');
  reportNativeModels(existing, true, onNativeModels);
  const existingLabels = new Set(models.map(model => model.label));
  const kept = [];
  for (const model of existing) {
    if (ownUid(nativeUid(model))) { existingLabels.add(model?.label); continue; }
    kept.push(model);
  }
  const groups = ownGroups(models).map(group => ({ groupName: group.name, modelLabels: group.labels }));
  const append = sort => ({ ...sort, groups: [...groups, ...(sort.groups || []).filter(value =>
    !GROUP_NAMES.has(value.groupName ?? value.group_name) ||
    !(value.modelLabels ?? value.model_labels ?? []).every(label => existingLabels.has(label)))] });
  return { ...data,
    [modelsKey]: [...models.map(model => structuredClone(model.json)), ...kept],
    ...(hasSorts ? { [sortsKey]: sorts.length ? sorts.map(append) : (groups.length ? [{ name: MODEL_GROUP, groups }] : sorts) } : {}),
  };
}

/** Accept decoded wire messages; framing/compression is exclusively the caller's responsibility. */
function augmentCatalog(data, { rpc, format = {}, catalog, onNativeModels } = {}) {
  if (rpc === '/exa.seat_management_pb.SeatManagementService/GetCliTeamSettings') return augmentLocalModelChoices(data, format, catalog);
  const shape = rpcShape(rpc);
  if (!shape || !catalog) return data;
  // The CLI intersects its session options with the renderer catalog, so the
  // CLI-side lists carry every imported BYOK model (hidden ones included);
  // visibility toggles then only need a renderer-catalog refresh.
  const modelList = shape.cli && Array.isArray(catalog.cliModels) ? catalog.cliModels : catalog.models;
  if (!modelList?.length && typeof onNativeModels !== 'function') return data;
  const scoped = modelList === catalog.models ? catalog : { ...catalog, models: modelList };
  try {
    if (format.json === true) {
      if (!shape.status) return augmentJsonList(data, scoped, shape.sorts, onNativeModels);
      const statusKey = jsonKey(data, 'userStatus', 'user_status'), status = data?.[statusKey];
      if (!status || typeof status !== 'object' || Array.isArray(status)) return data;
      const configKey = jsonKey(status, 'cascadeModelConfigData', 'cascade_model_config_data');
      return { ...data, [statusKey]: { ...status, [configKey]: augmentJsonList(status[configKey] || {}, scoped, true, onNativeModels) } };
    }
    if (!Buffer.isBuffer(data)) return data;
    if (!shape.status) return augmentProtoList(data, scoped, shape.sorts, onNativeModels);
    return rewriteMessage(data, shape.field, status => rewriteMessage(status, 33, list => augmentProtoList(list, scoped, true, onNativeModels), true));
  } catch { return data; }
}

function collectNativeModels(data, { rpc, format = {} } = {}) {
  const shape = rpcShape(rpc);
  if (!shape) return [];
  try {
    if (format.json === true) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
      let payload = data;
      if (shape.status) {
        const status = data[jsonKey(data, 'userStatus', 'user_status')];
        if (!status || typeof status !== 'object' || Array.isArray(status)) return [];
        payload = status[jsonKey(status, 'cascadeModelConfigData', 'cascade_model_config_data')] || {};
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
      const list = payload[jsonKey(payload, 'clientModelConfigs', 'client_model_configs')];
      return Array.isArray(list) ? nativeEntries(list, true) : [];
    }
    if (!Buffer.isBuffer(data)) return [];
    if (!shape.status) return nativeEntries(parseFields(data).filter(field => field.number === 1 && field.wire === 2).map(field => field.value), false);
    const statuses = parseFields(data).filter(field => field.number === 1);
    if (statuses.length !== 1 || statuses[0].wire !== 2) return [];
    const lists = parseFields(statuses[0].value).filter(field => field.number === 33);
    if (lists.length !== 1 || lists[0].wire !== 2) return [];
    return nativeEntries(parseFields(lists[0].value).filter(field => field.number === 1 && field.wire === 2).map(field => field.value), false);
  } catch { return []; }
}

// The CLI intersects the model catalog with its configured choices. Register
// only locally routed BYOK models; native choices and every other setting stay
// byte-identical. A native Sidekick must already be in the native choice list.
function augmentLocalModelChoices(data, format, catalog) {
  const list = catalog?.cliModels ?? catalog?.models;
  if (!list?.length) return data;
  try {
    const key = format.json ? jsonKey(data, 'allowedModelUids', 'allowed_model_uids') : null;
    const parsed = format.json ? null : parseFields(data);
    const entries = format.json ? data[key] : parsed.filter(f => f.number === 7).map(f => {
      if (f.wire !== 2) throw new Error('Invalid model choice');
      return f.value.toString('utf8');
    });
    // An absent or empty list is unrestricted; do not turn it into a restriction.
    if (entries === undefined || Array.isArray(entries) && entries.length === 0) return data;
    if (!Array.isArray(entries) || entries.some(uid => typeof uid !== 'string')) return data;
    const native = new Set(entries.filter(uid => !ownUid(uid)));
    const additions = list.filter(model => {
      if (!ownUid(model.uid)) return false;
      if (Object.hasOwn(catalog.routes, model.uid)) return true;
      const fusion = catalog.fusions[model.uid];
      if (!fusion) return false;
      if (fusion.leadNative) {
        if (!native.has(fusion.leadUid)) return false;
        return fusion.sidekickNative ? native.has(fusion.sidekickUid) : ownUid(fusion.sidekickUid) && Object.hasOwn(catalog.routes, fusion.sidekickUid);
      }
      return ownUid(fusion.leadUid) && Object.hasOwn(catalog.routes, fusion.leadUid) &&
        (fusion.sidekickNative ? native.has(fusion.sidekickUid) : ownUid(fusion.sidekickUid) && Object.hasOwn(catalog.routes, fusion.sidekickUid));
    }).map(model => model.uid);
    if (format.json) return { ...data, [key]: [...entries.filter(uid => !ownUid(uid)), ...additions] };
    return concat([...parsed.filter(f => !(f.number === 7 && ownUid(f.value.toString('utf8')))).map(f => f.raw), ...additions.map(uid => s(7, uid))]);
  } catch { return data; }
}

function assignmentUid(data, format, field, camel, snake) {
  if (format.json === true) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid assignment');
    if (has(data, camel) && has(data, snake) && data[camel] !== data[snake]) throw new Error('Ambiguous assignment');
    const value = data[camel] ?? data[snake] ?? '';
    if (typeof value !== 'string') throw new Error('Invalid assignment uid');
    return value;
  }
  const values = parseFields(data).filter(value => value.number === field);
  if (values.length > 1 || values.some(value => value.wire !== 2)) throw new Error('Ambiguous assignment');
  return values[0]?.value.toString('utf8') || '';
}

// A slot that fails to resolve is absent from catalog.fusions, so assigning it
// returns null and the request is forwarded upstream unchanged.
function resolveAssignment(data, format = {}, catalog) {
  try {
    const router = assignmentUid(data, format, 2, 'modelRouterUid', 'model_router_uid');
    const leadRouter = assignmentUid(data, format, 6, 'fusionLeadRouterUid', 'fusion_lead_router_uid');
    const uid = leadRouter || router;
    const fusion = has(catalog?.fusions, uid) ? catalog.fusions[uid] : null;
    if (!fusion) return null;
    const modelUid = leadRouter ? fusion.sidekickUid : fusion.leadUid;
    if (leadRouter) {
      if (fusion.sidekickNative) {
        if (!Array.isArray(fusion.sidekickHarnessUids) || !fusion.sidekickHarnessUids.length) return null;
      } else if (!has(catalog.routes, modelUid)) return null;
    } else {
      if (fusion.leadNative) {
        if (!Array.isArray(fusion.leadHarnessUids) || !fusion.leadHarnessUids.length) return null;
      } else if (!has(catalog.routes, modelUid)) return null;
    }
    let harnessUids;
    if (leadRouter) {
      harnessUids = fusion.sidekickNative ? fusion.sidekickHarnessUids : [...SIDEKICK_HARNESSES];
    } else {
      harnessUids = fusion.leadNative ? fusion.leadHarnessUids : ['fusion'];
    }
    return format.json === true ? { assignment: { modelUid, harnessUids } }
      : m(1, concat([s(2, modelUid), ...harnessUids.map(harness => s(3, harness))]));
  } catch { return null; }
}

module.exports = { buildCatalog, augmentCatalog, augmentLocalModelChoices, collectNativeModels,
  resolveAssignment, discoverOfficialRoles, resolveSlotRef, ownUid, effortMetadata,
  FUSION_UIDS, FUSION_GROUP, MODEL_GROUP };
