'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { networkIdentity } = require('./backend-env.cjs');
const { readConfig, writeConfig, discover } = require('../config.cjs');
const { buildCatalog, resolveAssignment } = require('../catalog.cjs');
const { loadIndex } = require('../models-dev.cjs');
const { PICKER_ORIGIN, corsHeaders, handlePickerRequest } = require('../picker-api.cjs');
const wire = require('../protocol/wire.cjs');
const { parseChat } = require('../protocol/chat.cjs');
const { serveChat } = require('../protocol/responses.cjs');
const { forward, collect } = require('./bridge.cjs');
const PORT = 39852;
const VERSION = require('../../package.json').version;
const API_PREFIX = '/exa.api_server_pb.ApiServerService/';
const SERVICE = 'devin-model-picker';
const MANAGEMENT_PROTOCOL = 1;
const SOURCE_FILES = ['../../package.json', 'backend.cjs', 'backend-env.cjs', 'bridge.cjs', '../config.cjs', '../catalog.cjs', '../picker-api.cjs', '../byok-ops.cjs', '../panel/base-url.cjs', '../model-capabilities.cjs', '../models-dev.cjs', '../protocol/wire.cjs', '../protocol/chat.cjs', '../protocol/responses.cjs', '../protocol/anthropic.cjs'];
function sourceId() {
  const hash = crypto.createHash('sha256');
  for (const name of SOURCE_FILES) hash.update(name).update('\0').update(fs.readFileSync(path.resolve(__dirname, name))).update('\0');
  return hash.digest('hex');
}
const LOADED_SOURCE_ID = sourceId();
function runtimeIdentity(root, freshSource = false, env = process.env) {
  return { service: SERVICE, version: VERSION, sourceId: freshSource ? sourceId() : LOADED_SOURCE_ID,
    networkId: networkIdentity(env),
    rootId: crypto.createHash('sha256').update(path.resolve(root)).digest('hex') };
}
function controlFile(root) { return path.join(root, 'runtime-control.json'); }

async function startBackend({ root, port = PORT, log = () => {} }) {
  const identity = runtimeIdentity(root);
  const instanceId = crypto.randomUUID();
  const controlToken = crypto.randomBytes(32).toString('hex');
  let activeRequests = 0;
  let draining = false;
  let closing;
  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const configFile = path.join(root, 'config.json');
  const config = () => readConfig(configFile);
  const observedNatives = new Map();
  const onNativeModels = entries => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry.uid !== 'string' || !entry.uid) continue;
      const dimension = entry.sidekickDimension;
      const effort = entry.modelEffortDimension;
      observedNatives.set(entry.uid, { uid: entry.uid, label: typeof entry.label === 'string' ? entry.label : '',
        disabled: entry.disabled === true, isModelRouter: entry.isModelRouter === true,
        harnessUids: Array.isArray(entry.harnessUids) ? entry.harnessUids.filter(value => typeof value === 'string') : [],
        ...(typeof entry.familyUid === 'string' && entry.familyUid && entry.familyUid.length <= 256 ? { familyUid: entry.familyUid } : {}),
        ...(typeof entry.familyLabel === 'string' && entry.familyLabel && entry.familyLabel.length <= 256 ? { familyLabel: entry.familyLabel } : {}),
        ...(effort && Number.isSafeInteger(effort.order) && effort.order >= 0 && effort.order <= 0x7fffffff &&
            typeof effort.name === 'string' && effort.name
          ? { modelEffortDimension: { order: effort.order, name: effort.name } } : {}),
        ...(dimension && typeof dimension === 'object'
          ? { sidekickDimension: { order: dimension.order, name: dimension.name, fastModeOrder: dimension.fastModeOrder } } : {}),
        ...(Array.isArray(entry.fusionMetadata) ? { fusionMetadata: entry.fusionMetadata } : {}),
        ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
        ...(entry.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {}),
        ...(entry.supportsImages ? { supportsImages: true } : {}) });
    }
  };
  // Re-reads config.json and rebuilds the catalog on every request so edits
  // from the settings UI or the picker API apply without a restart.
  const getCatalog = () => { const current = config(); return buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, [...observedNatives.values()]); };
  const pendingDiscovers = new Map();
  const modelsDevFile = path.join(root, 'models-dev.json');
  const pickerContext = () => ({ version: VERSION, catalog: getCatalog(), config: config(), configFile, writeConfig, observedNatives,
    discover, pendingDiscovers,
    modelsDevIndex: async () => { try { return (await loadIndex({ file: modelsDevFile })).index; } catch { return null; } } });
  const handle = async (request, response) => {
    const incoming = new URL(request.url, 'https://server.codeium.com');
    const rpc = incoming.pathname;
    const target = new URL(rpc + incoming.search, 'https://server.codeium.com');
    if (request.method !== 'POST' || ![API_PREFIX + 'AssignModel', API_PREFIX + 'GetChatMessage'].includes(rpc)) {
      forward(request, response, target, { getCatalog, log, onNativeModels }); return;
    }
    let body;
    try {
      body = await collect(request);
      const format = wire.decode(body, request.headers);
      const current = config(), catalog = buildCatalog(current.enabled === false ? { ...current, providers: [] } : current, [...observedNatives.values()]);
      if (rpc.endsWith('/AssignModel')) {
        const resolved = resolveAssignment(format.data, format, catalog);
        if (resolved) {
          const output = wire.encode(resolved, { ...format, gzip: false, compressed: false });
          response.writeHead(200, { 'content-type': format.type, 'content-length': output.length, 'connect-protocol-version': '1' });
          response.end(output);
          log('assignment', { bytes: output.length });
          return;
        }
      } else {
        const chat = parseChat(format.data);
        const route = Object.hasOwn(catalog.routes, chat.modelUid) ? catalog.routes[chat.modelUid] : undefined;
        if (route) {
          const provider = current.providers.find(p => p.id === route.providerId);
          if (!provider) throw new Error('Provider missing');
          const abort = new AbortController();
          response.on('close', () => { if (!response.writableFinished) abort.abort(); });
          log('inference', { model: route.model, effort: route.effort, tools: chat.tools.map(t => t.name) });
          await serveChat({ request: chat, route, provider, res: response, signal: abort.signal,
            log: ({ event, ...data }) => log(event, data) });
          return;
        }
      }
    } catch (error) {
      log('request-error', { code: 'request_failed', rpc: rpc.split('/').pop() });
      if (response.headersSent) { response.end(); return; }
      // Malformed data must never select a default provider.
    }
    if (body) forward(request, response, target, { body, getCatalog, log, onNativeModels });
    else { response.writeHead(502); response.end(); }
  };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/picker/')) {
      if (request.headers.origin !== PICKER_ORIGIN) { response.writeHead(403); response.end(); return; }
      if (request.method === 'OPTIONS') { response.writeHead(204, corsHeaders()); response.end(); return; }
      handlePickerRequest(request, response, pathname, pickerContext()).catch(() => {
        if (!response.headersSent) response.writeHead(502, corsHeaders());
        response.end();
      });
      return;
    }
    if (request.headers.origin) { response.writeHead(403); response.end(); return; }
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ...identity, pid: process.pid, instanceId, managementProtocol: MANAGEMENT_PROTOCOL, nativeModelsProtocol: 1, activeRequests, draining })); return;
    }
    if (request.method === 'GET' && request.url === '/_runtime/native-models') {
      const provided = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
      const expected = 'Bearer ' + controlToken;
      if (Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
        response.writeHead(403); response.end(); return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ instanceId, models: [...observedNatives.values()] })); return;
    }
    if (request.method === 'POST' && request.url === '/_runtime/shutdown') {
      const provided = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
      const expected = 'Bearer ' + controlToken;
      if (Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
        response.writeHead(403); response.end(); return;
      }
      if (activeRequests > 0) {
        response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ activeRequests })); return;
      }
      // Check and transition synchronously. A request racing the health check
      // either makes shutdown busy or is rejected before work starts.
      draining = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.once('finish', () => { close(); });
      response.end('{"stopping":true}');
      return;
    }
    if (draining) {
      response.writeHead(503); response.end(); return;
    }
    if (!/^\/exa\.[a-z_]+\.[A-Za-z]+Service\/[A-Za-z]+(?:\?|$)/.test(request.url)) {
      response.writeHead(404); response.end(); return;
    }
    activeRequests++;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; activeRequests--; } };
    response.once('finish', settle); response.once('close', settle);
    handle(request, response).catch(() => {
      log('request-error', { code: 'request_failed' });
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stateFile = controlFile(root), temporary = stateFile + '.' + instanceId;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...identity, instanceId, token: controlToken }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, stateFile);
  } catch (error) { fs.rmSync(temporary, { force: true }); server.close(); throw error; }
  function close() {
    if (closing) return closing;
    draining = true;
    closing = new Promise(resolve => {
      server.close(() => {
        try {
          if (JSON.parse(fs.readFileSync(stateFile, 'utf8')).instanceId === instanceId) fs.unlinkSync(stateFile);
        } catch { /* Another runtime may already own the control file. */ }
        resolveStopped(); resolve();
      });
      server.closeIdleConnections?.();
    });
    return closing;
  }
  log('ready', { port: server.address().port, version: VERSION });
  return { port: server.address().port, close, stopped };
}
if (require.main === module) {
  const root = process.argv[2];
  if (!root) process.exit(2);
  const logFile = path.join(root, 'runtime.log');
  const log = (event, data = {}) => {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) fs.renameSync(logFile, logFile + '.previous');
      fs.appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), event, ...data }) + '\n', { mode: 0o600 });
    } catch {}
  };
  startBackend({ root, log }).then(backend => {
    backend.stopped.then(() => process.exit(0));
    for (const name of ['SIGTERM', 'SIGINT']) process.on(name, () => backend.close().then(() => process.exit(0)));
  }).catch(error => { log('startup-error', { code: error.code === 'EADDRINUSE' ? 'port_in_use' : 'startup_failed' }); process.exit(error.code === 'EADDRINUSE' ? 0 : 1); });
}
module.exports = { startBackend, runtimeIdentity, controlFile, PORT, VERSION, MANAGEMENT_PROTOCOL };
