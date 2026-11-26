'use strict';

// Devin 3.10+ only lists a model when both the renderer catalog (GetUserStatus,
// fetched when a conversation view mounts) and the CLI session options
// (GetCliModelConfigs, re-fetched on session/new once its ~60s cache is stale)
// contain it. Starting a new conversation refreshes both without restarting
// the CLI or interrupting running sessions.
const COMMANDS = ['devin.newConversation', 'windsurf.triggerCascade'];
const DEBOUNCE_MS = 1500;
const CLI_CACHE_MS = 65 * 1000;

function signatureOf(models) {
  return (Array.isArray(models) ? models : []).map(model =>
    typeof model === 'string' ? model : `${model?.uid ?? ''}\u0000${model?.label ?? ''}`).sort().join('\u0001');
}

function createPickerRefresh({ executeCommand, readModels, log = () => {}, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout, debounceMs = DEBOUNCE_MS, cliCacheMs = CLI_CACHE_MS } = {}) {
  if (typeof executeCommand !== 'function' || typeof readModels !== 'function') throw new TypeError('executeCommand and readModels are required');
  let last, timer, lastRun = -Infinity, disposed = false, paused = false;
  function read() {
    try { return signatureOf(readModels()); } catch { return undefined; }
  }
  async function run() {
    timer = undefined;
    if (disposed || paused) return;
    lastRun = now();
    for (const command of COMMANDS) {
      try { await executeCommand(command); log('picker-refresh', { command }); return; }
      catch { /* Try the legacy command id before giving up. */ }
    }
    log('picker-refresh-unavailable');
  }
  function scheduleRun() {
    if (timer !== undefined) cancel(timer);
    // A second refresh inside the CLI cache window would not re-fetch its
    // model list, so defer it until the cache is stale again.
    const delay = Math.max(debounceMs, lastRun + cliCacheMs - now());
    timer = schedule(() => { run().catch(() => {}); }, delay);
  }
  return {
    prime() { last = read(); },
    changed() {
      if (disposed || paused) return false;
      const current = read();
      if (current === undefined || current === last) return false;
      last = current;
      scheduleRun();
      return true;
    },
    // Signature-less fire for catalog events the cliModels signature cannot
    // express — a server-side native release never touches BYOK entries.
    trigger() {
      if (disposed || paused) return false;
      scheduleRun();
      return true;
    },
    // Pausing cancels any pending run: a disabled plugin must not open a new
    // conversation out of a timer that was armed while it was still active.
    pause() {
      paused = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
    },
    resume() { paused = false; },
    dispose() { disposed = true; if (timer !== undefined) cancel(timer); timer = undefined; },
  };
}

module.exports = { createPickerRefresh, signatureOf, COMMANDS };
