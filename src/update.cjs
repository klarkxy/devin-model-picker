'use strict';

// Self-update from GitHub Releases: a VSIX-installed copy polls the latest
// release, verifies the asset's sha256 and inner manifest, and hands the file
// to the workbench extension installer. Downloads never leave GitHub hosts.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const REPOSITORY = 'klarkxy/devin-model-picker';
const API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const PAGE = `https://github.com/${REPOSITORY}/releases`;
const INTERVAL = 6 * 60 * 60 * 1000;
const MAX = 20 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['api.github.com', 'github.com',
  'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const STATE_KEY = 'dmpUpdate';

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

// Negative / zero / positive like a comparator; NaN when either side is not
// a strict x.y.z version.
function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return NaN;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Shapes the /releases/latest payload into an update descriptor. Throws on
// draft/prerelease releases and unparseable tags; installable only when the
// exact VSIX asset is present with the matching download URL, a sha256 digest
// and a sane size.
function releaseInfo(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('release_invalid');
  if (json.draft === true || json.prerelease === true) throw new Error('release_unpublished');
  const tag = typeof json.tag_name === 'string' ? json.tag_name : '';
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (!parseVersion(version)) throw new Error('release_tag_invalid');
  const name = `devin-model-picker-${version}.vsix`;
  const expected = `${PAGE}/download/${tag}/${name}`;
  const asset = (Array.isArray(json.assets) ? json.assets : []).find(item => item && item.name === name) || null;
  let url = '', digest = '', size = 0;
  if (asset) {
    url = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
    const match = /^sha256:([a-f0-9]{64})$/.exec(typeof asset.digest === 'string' ? asset.digest : '');
    digest = match ? match[1] : '';
    size = Number.isSafeInteger(asset.size) ? asset.size : 0;
  }
  const installable = !!asset && url === expected && !!digest && size > 0 && size <= MAX;
  const page = typeof json.html_url === 'string' && json.html_url ? json.html_url : `${PAGE}/tag/${tag}`;
  return { version, tag, name, url, digest, size, installable, page };
}

// GET a URL following up to 5 redirects. Every hop must stay plain https on a
// known GitHub host — no userinfo, no explicit port.
async function fetchBytes(url, { limit = MAX, signal, fetchImpl, timeout = 30000 } = {}) {
  const request = fetchImpl || fetch;
  const REDIRECTS = new Set([301, 302, 303, 307, 308]);
  let current = String(url);
  for (let hop = 0; hop <= 5; hop++) {
    const target = new URL(current);
    if (target.protocol !== 'https:' || target.username || target.password || target.port !== '' ||
        !ALLOWED_HOSTS.has(target.hostname)) throw new Error('download_blocked');
    const response = await request(current, {
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      headers: { 'user-agent': 'devin-model-picker',
        accept: target.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' },
    });
    const status = Number(response?.status) || 0;
    if (REDIRECTS.has(status)) {
      const location = response.headers?.get?.('location');
      try { await response.body?.cancel?.(); } catch {}
      if (!location) throw new Error('download_redirect');
      current = new URL(location, current).toString();
      continue;
    }
    if (status !== 200) {
      try { await response.body?.cancel?.(); } catch {}
      throw new Error('download_http_' + status);
    }
    const chunks = [];
    let length = 0;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value?.length || 0;
        if (length > limit) { try { await reader.cancel(); } catch {} throw new Error('download_too_large'); }
        chunks.push(value);
      }
      return Buffer.concat(chunks, length);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > limit) throw new Error('download_too_large');
    return data;
  }
  throw new Error('download_redirect');
}

// Minimal ZIP reader for VSIX files: locate the End Of Central Directory,
// walk the central directory, then read the local header for the data offset.
// Supports store (0) and deflate (8); every offset is bounds-checked.
function readZipEntry(buffer, name) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('zip_invalid');
  let eocd = -1;
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip_invalid');
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buffer.length) throw new Error('zip_invalid');
  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cdEnd || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('zip_invalid');
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > cdEnd) throw new Error('zip_invalid');
    const entryName = buffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    if (entryName === name) {
      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip_invalid');
      const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
      if (dataStart + compressed > buffer.length) throw new Error('zip_invalid');
      const data = buffer.subarray(dataStart, dataStart + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('zip_method_unsupported');
    }
    pos = next;
  }
  throw new Error('zip_entry_missing');
}

// A candidate VSIX must be this extension, this publisher, this version — in
// both extension/package.json and the manifest's single Identity element.
function verifyVsix(buffer, version) {
  let pkg;
  try { pkg = JSON.parse(readZipEntry(buffer, 'extension/package.json').toString('utf8')); }
  catch { throw new Error('vsix_invalid'); }
  if (pkg?.name !== 'devin-model-picker' || pkg?.publisher !== 'klarkxy' || pkg?.version !== version) {
    throw new Error('vsix_invalid');
  }
  let manifest;
  try { manifest = readZipEntry(buffer, 'extension.vsixmanifest').toString('utf8'); }
  catch { throw new Error('vsix_invalid'); }
  if (manifest.includes('<!') || manifest.includes('&')) throw new Error('vsix_invalid');
  const identities = manifest.match(/<Identity\b[^>]*>/g) || [];
  if (identities.length !== 1) throw new Error('vsix_invalid');
  const attr = key => new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(identities[0])?.[1] || '';
  if (attr('Id') !== 'devin-model-picker' || attr('Version') !== version || attr('Publisher') !== 'klarkxy') {
    throw new Error('vsix_invalid');
  }
  return true;
}

function createUpdater({ currentVersion, globalState, storagePath, fetchImpl, install, ui = {}, now = Date.now, log = () => {} } = {}) {
  let first, repeat, inFlight, announced, installing, disposed = false;
  const aborters = new Set();
  const readState = () => { try { return globalState?.get(STATE_KEY) || {}; } catch { return {}; } };

  async function installUpdate(info, signal) {
    let dir;
    try {
      const buffer = await fetchBytes(info.url, { limit: MAX, signal, fetchImpl });
      if (buffer.length !== info.size) throw new Error('size_mismatch');
      if (crypto.createHash('sha256').update(buffer).digest('hex') !== info.digest) throw new Error('digest_mismatch');
      verifyVsix(buffer, info.version);
      fs.mkdirSync(storagePath, { recursive: true, mode: 0o700 });
      dir = fs.mkdtempSync(path.join(storagePath, 'update-'));
      const file = path.join(dir, info.name);
      fs.writeFileSync(file, buffer, { mode: 0o600 });
      await install(file);
      await ui.installed?.(info.version);
    } catch (error) {
      if (signal?.aborted || disposed) return;
      await ui.error?.('更新失败，可以重试或到发布页手动下载安装。');
      log('update-install-failed');
    } finally {
      if (dir) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  // Concurrent checks share the network lookup only; compare, dedupe, prompt
  // and install run per caller, so a notification left pending can never block
  // a later manual or automatic check.
  function latest() {
    if (disposed) return Promise.reject(new Error('disposed'));
    if (inFlight) return inFlight;
    const abort = new AbortController();
    aborters.add(abort);
    inFlight = (async () => {
      try {
        const body = await fetchBytes(API, { limit: 1024 * 1024, signal: abort.signal, fetchImpl });
        return releaseInfo(JSON.parse(body.toString('utf8')));
      } finally {
        aborters.delete(abort);
      }
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  async function check({ manual } = {}) {
    if (disposed) return;
    let info;
    try {
      info = await latest();
    } catch {
      if (disposed) return;
      if (manual) await ui.error?.('检查更新失败，请检查网络后重试。');
      else log('update-check-failed');
      return;
    }
    try {
      if (disposed || !(compareVersions(info.version, currentVersion) > 0)) {
        if (manual && !disposed) await ui.upToDate?.(currentVersion);
        return;
      }
      const ignored = readState().ignoredVersion === info.version;
      if (!manual && (ignored || announced === info.version)) return;
      announced = info.version;
      const choice = await ui.available?.(info);
      if (disposed) return;
      if (choice === 'ignore') {
        await globalState?.update?.(STATE_KEY, { ...readState(), ignoredVersion: info.version });
        return;
      }
      if (choice === 'notes') { await ui.openUrl?.(info.page); return; }
      if (choice !== 'update' || !info.installable || installing) return;
      const abort = new AbortController();
      aborters.add(abort);
      installing = true;
      try { await installUpdate(info, abort.signal); }
      finally { installing = false; aborters.delete(abort); }
    } catch (error) {
      if (disposed) return;
      if (manual) await ui.error?.('检查更新失败，请检查网络后重试。');
      else log('update-check-failed');
    }
  }

  function start() {
    if (disposed || first || repeat) return;
    first = setTimeout(() => {
      first = undefined;
      void check({});
      repeat = setInterval(() => { void check({}); }, INTERVAL);
      repeat.unref?.();
    }, 15000);
    first.unref?.();
  }

  function dispose() {
    disposed = true;
    if (first) { clearTimeout(first); first = undefined; }
    if (repeat) { clearInterval(repeat); repeat = undefined; }
    for (const abort of aborters) abort.abort();
  }

  return { check, start, dispose };
}

// Wires the updater to the workbench: install command, notifications, and the
// manual checkUpdates command.
function createUpdateHost({ vscode, context, log = () => {} } = {}) {
  const updater = createUpdater({
    currentVersion: context?.extension?.packageJSON?.version || require('../package.json').version,
    globalState: context.globalState,
    storagePath: context.globalStorageUri?.fsPath || os.tmpdir(),
    install: file => vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file)),
    ui: {
      available: async info => {
        const choice = await vscode.window.showInformationMessage(
          `Devin Model Picker ${info.version} 已发布`,
          ...(info.installable ? ['更新'] : []), '查看说明', '忽略此版本');
        return choice === '更新' ? 'update' : choice === '查看说明' ? 'notes' : choice === '忽略此版本' ? 'ignore' : undefined;
      },
      installed: async version => {
        const choice = await vscode.window.showInformationMessage(
          `Devin Model Picker 已更新到 ${version}，重新加载窗口后生效`, '重新加载');
        if (choice === '重新加载') await vscode.commands.executeCommand('workbench.action.reloadWindow');
      },
      upToDate: version => vscode.window.showInformationMessage(`Devin Model Picker 已是最新版本（${version}）`),
      error: message => vscode.window.showWarningMessage(message),
      openUrl: url => vscode.env.openExternal(vscode.Uri.parse(url)),
    },
    log,
  });
  context.subscriptions.push(updater,
    vscode.commands.registerCommand('devinModelPicker.checkUpdates', () => updater.check({ manual: true })));
  updater.start();
  return updater;
}

module.exports = { REPOSITORY, API, PAGE, INTERVAL, MAX, parseVersion, compareVersions,
  releaseInfo, fetchBytes, readZipEntry, verifyVsix, createUpdater, createUpdateHost };
