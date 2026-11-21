'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Injects media/picker.js into Devin's workbench.html so the renderer-side
// model card picker loads inside the workbench window. Devin updates wipe the
// tag, so activation re-applies it every time; removal deletes only our tag
// and our script file. product.json.checksums is resynchronized after every
// write so the integrity check keeps passing.
const WORKBENCH_HTML = path.join('out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html');
const JS_NAME = 'devin-model-picker.js';
const TAG = '<script src="./' + JS_NAME + '"></script>';
const ANCHOR = '<script src="./workbench.js" type="module"></script>';

function sha256b64(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64').replace(/=+$/, '');
}

function writeAtomic(file, content) {
  const temporary = file + '.' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

// Recomputes checksums for every key listed in product.json whose file hash
// changed. Returns true when product.json was rewritten.
function syncChecksums(appRoot, log = () => {}) {
  const productPath = path.join(appRoot, 'product.json');
  let product;
  try { product = JSON.parse(fs.readFileSync(productPath, 'utf8')); } catch { return false; }
  if (!product || typeof product.checksums !== 'object' || !product.checksums) return false;
  let dirty = false;
  for (const key of Object.keys(product.checksums)) {
    const file = path.join(appRoot, 'out', key);
    if (!fs.existsSync(file)) continue;
    const hash = sha256b64(file);
    if (product.checksums[key] !== hash) { product.checksums[key] = hash; dirty = true; }
  }
  if (dirty) {
    writeAtomic(productPath, JSON.stringify(product, null, '\t'));
    log('checksums-synced');
  }
  return dirty;
}

// source: absolute path to the picker script shipped in the extension (media/picker.js).
function applyInjection({ appRoot, source, log = () => {} } = {}) {
  try {
    const htmlPath = path.join(appRoot, WORKBENCH_HTML);
    if (!fs.existsSync(htmlPath)) return { ok: false, changed: false, reason: 'html_missing' };
    const jsTarget = path.join(path.dirname(htmlPath), JS_NAME);
    const content = fs.readFileSync(source);
    let changed = false;
    try {
      if (!fs.existsSync(jsTarget) || !fs.readFileSync(jsTarget).equals(content)) {
        writeAtomic(jsTarget, content);
        changed = true;
        log('picker-script-written');
      }
    } catch (error) {
      log('picker-script-write-failed', { code: error?.code });
      return { ok: false, changed, reason: 'script_write_failed', error };
    }
    let html;
    try { html = fs.readFileSync(htmlPath, 'utf8'); } catch (error) { return { ok: false, changed, reason: 'html_read_failed', error }; }
    if (!html.includes(TAG)) {
      if (!html.includes(ANCHOR)) {
        log('anchor-missing');
        return { ok: false, changed, reason: 'anchor_missing' };
      }
      try {
        writeAtomic(htmlPath, html.replace(ANCHOR, TAG + '\n\t' + ANCHOR));
        changed = true;
        log('picker-tag-injected');
      } catch (error) {
        log('picker-tag-write-failed', { code: error?.code });
        return { ok: false, changed, reason: 'html_write_failed', error };
      }
    }
    // A checksums-only resync (e.g. devin-zh-hans or a Devin update touched
    // other listed files) must not count as a change: only our script file
    // or our tag justifies a reload prompt.
    try { syncChecksums(appRoot, log); }
    catch (error) { log('checksums-sync-failed', { code: error?.code }); return { ok: false, changed, reason: 'checksums_failed', error }; }
    return { ok: true, changed };
  } catch (error) {
    return { ok: false, changed: false, reason: 'error', error };
  }
}

function removeInjection({ appRoot, log = () => {} } = {}) {
  let changed = false;
  try {
    const htmlPath = path.join(appRoot, WORKBENCH_HTML);
    if (fs.existsSync(htmlPath)) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      // The tag was inserted as "<tag>\n\t<anchor>"; remove only our line.
      const next = html.includes(TAG + '\n\t') ? html.replace(TAG + '\n\t', '') : html.replace(TAG, '');
      if (next !== html) {
        writeAtomic(htmlPath, next);
        changed = true;
        log('picker-tag-removed');
      }
    }
    const jsTarget = path.join(appRoot, path.dirname(WORKBENCH_HTML), JS_NAME);
    if (fs.existsSync(jsTarget)) {
      fs.unlinkSync(jsTarget);
      changed = true;
      log('picker-script-removed');
    }
    try { syncChecksums(appRoot, log); }
    catch (error) { log('checksums-sync-failed', { code: error?.code }); }
  } catch (error) {
    log('picker-remove-failed', { code: error?.code });
  }
  return { changed };
}

// Locates the Devin install without the vscode API (vscode:uninstall hook).
function findDevinInstall() {
  if (process.platform === 'darwin') {
    const candidates = [
      process.env.DEVIN_INSTALL,
      '/Applications/Devin.app/Contents',
      path.join(os.homedir(), 'Applications', 'Devin.app', 'Contents'),
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const inst = candidate.endsWith('.app') ? path.join(candidate, 'Contents') : candidate;
      if (fs.existsSync(path.join(inst, 'Resources', 'app', 'product.json'))) return inst;
    }
    return null;
  }
  const candidates = [
    process.env.DEVIN_INSTALL,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Devin'),
    'C:\\Program Files\\Devin',
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, 'Devin.exe'))) return candidate;
  }
  return null;
}

function devinAppRoot(install) {
  const mac = path.join(install, 'Resources', 'app');
  return fs.existsSync(mac) ? mac : path.join(install, 'resources', 'app');
}

module.exports = { applyInjection, removeInjection, syncChecksums, findDevinInstall, devinAppRoot,
  WORKBENCH_HTML, JS_NAME, TAG, ANCHOR };
