'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const next = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, initial = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-ext-'));
  const extensionPath = path.resolve(__dirname, '..');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(initial.config ?? { providers: [] }));
  const commands = new Map(), logs = [], notices = [], errors = [], watchers = [];
  const agentEnv = { ...(initial.agentEnv || {}) };
  const updates = [];
  const settings = {
    get: (key, fallback) => key === 'agentEnv' ? agentEnv : key === 'agentPreferences' ? {} : fallback,
    update: async (key, value) => { updates.push({ key, value }); if (key === 'agentEnv') Object.assign(agentEnv, value); },
  };
  const state = new Map();
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    StatusBarAlignment: { Right: 2 },
    workspace: { getConfiguration: section => section === 'http' ? { get: () => '' } : settings,
      onDidChangeConfiguration: () => ({ dispose() {} }) },
    extensions: { getExtension: id => {
      if (id === 'local.devin-fusion-byok') return initial.legacy ? { isActive: true } : undefined;
      if (id === 'codeium.windsurf') return { extensionPath: '/native', packageJSON: { main: 'main.js', version: 'test' } };
      return undefined;
    } },
    env: { appRoot: initial.appRoot || '/fake-approot' },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async () => {} },
    window: {
      createOutputChannel: () => ({ appendLine: v => logs.push(v), show() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showInformationMessage: async text => { notices.push(text); return undefined; },
      showErrorMessage: async text => { errors.push(text); return undefined; },
    },
  };
  const identity = { service: 'devin-model-picker', version: '0.1.0', sourceId: 's', networkId: 'n', rootId: 'r' };
  let fetchImpl = async () => new Response(JSON.stringify({ ...identity, managementProtocol: 1, instanceId: 'i', activeRequests: 0, draining: false }));
  const calls = { apply: [], remove: [], acp: [], ls: [], host: [], refresh: [] };
  let acpInstalled = { dispose() { calls.acpDisposed = (calls.acpDisposed || 0) + 1; } };
  const overrides = {
    vscode,
    'node:fs': { ...fs, watchFile: (_f, _o, cb) => watchers.push(cb), unwatchFile: () => {} },
    'node:child_process': { spawn: () => { const c = new EventEmitter(); c.unref = () => {}; return c; } },
    './inject.cjs': {
      applyInjection: options => { calls.apply.push(options); return { ok: true, changed: true }; },
      removeInjection: options => { calls.remove.push(options); return { changed: true }; },
    },
    './runtime/acp-injection.cjs': { installAcpInjection: async options => { calls.acp.push(options); return acpInstalled; } },
    './runtime/ls-injection.cjs': { installLsInjection: async options => {
      calls.ls.push(options); await options.createBridge(1234);
      return { status: { state: 'ready' }, dispose: async () => { calls.lsDisposed = (calls.lsDisposed || 0) + 1; } };
    } },
    './runtime/bridge.cjs': { createLsBridge: async (_p, o) => { calls.bridge = o; return { port: 4567, close() {} }; } },
    './runtime/backend.cjs': { runtimeIdentity: () => identity, controlFile: r => path.join(r, 'runtime-control.json'), PORT: 39852, MANAGEMENT_PROTOCOL: 1 },
    './runtime/host-catalog.cjs': { installHostCatalog: options => {
      calls.host.push(options); return { refresh: async () => { calls.refresh.push(1); }, dispose() {} };
    } },
    './runtime/native-models.cjs': { readNativeModels: async () => ({ status: 'ready', models: [] }) },
  };
  const filename = path.resolve(extensionPath, 'src/extension.cjs');
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process, Buffer, URL,
    AbortController, AbortSignal, setInterval, clearInterval,
    setTimeout: (fn, _ms) => setTimeout(fn, 0), clearTimeout,
    fetch: (...args) => fetchImpl(...args),
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : realRequire(name),
  }, { filename });
  const context = { globalStorageUri: { fsPath: root }, extensionPath, subscriptions: [],
    globalState: { get: (k, fb) => state.has(k) ? state.get(k) : fb,
      update: async (k, v) => v === undefined ? state.delete(k) : state.set(k, v) } };
  t.after(async () => { try { await module.exports.deactivate(); } catch {} context.subscriptions.forEach(s => s.dispose?.()); });
  return { ...module.exports, context, root, commands, logs, notices, errors, calls, agentEnv, updates,
    settle: async (ticks = 30) => { for (let i = 0; i < ticks; i++) await next(); } };
}

test('an active legacy extension blocks activation with a Chinese error', async t => {
  const f = fixture(t, { legacy: true });
  await f.activate(f.context);
  assert.ok(f.errors.some(text => text.includes('检测到旧版 Devin Fusion BYOK 仍在启用')));
  assert.equal(f.calls.apply.length, 0);
  assert.equal(f.commands.size, 0, 'no commands registered');
});

test('activation applies the picker injection, installs local ACP + LS hooks, and owns agentEnv', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  assert.equal(f.calls.apply.length, 1);
  assert.equal(f.calls.apply[0].appRoot, '/fake-approot');
  assert.ok(f.calls.apply[0].source.endsWith(path.join('media', 'picker.js')));
  assert.ok(f.notices.some(text => text.includes('选择器已更新')), 'reload notice shown');
  assert.equal(f.calls.acp.length, 1, 'ACP injection installed locally without remote support');
  assert.equal(f.calls.acp[0].apiServerUrl, 'http://127.0.0.1:39852');
  assert.equal(f.calls.ls.length, 1, 'LS injection installed after backend is healthy');
  assert.equal(f.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, 'http://127.0.0.1:39852');
  for (const id of ['devinModelPicker.openSettings', 'devinModelPicker.reinject', 'devinModelPicker.disable']) {
    assert.ok(f.commands.has(id), id);
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, 'settings-restore.json'), 'utf8'));
  assert.ok(receipt.changes.some(change => change.path.join('.') === 'devin.acp.agentEnv.devin-cli.WINDSURF_API_SERVER_URL'));
});

test('disable restores owned settings, removes the injection and disposes hooks', async t => {
  const f = fixture(t);
  await f.activate(f.context);
  await f.settle();
  await f.commands.get('devinModelPicker.disable')();
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'config.json'), 'utf8'));
  assert.equal(saved.enabled, false);
  assert.equal(f.calls.remove.length, 1);
  assert.equal(f.agentEnv['devin-cli'].WINDSURF_API_SERVER_URL, undefined, 'agentEnv restored via receipt');
  assert.equal(f.calls.lsDisposed, 1);
  assert.ok(f.calls.acpDisposed >= 1);
  assert.ok(f.notices.some(text => text.includes('已停用')));
});
