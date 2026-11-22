'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const upd = require('../src/update.cjs');

// --- in-test zip builder (store + deflate) -----------------------------------

const crc32 = typeof zlib.crc32 === 'function'
  ? buffer => zlib.crc32(buffer) >>> 0
  : (() => {
      const table = new Int32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
      return buffer => { let c = 0xffffffff; for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    })();

function buildZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const stored = entry.deflate ? zlib.deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, stored);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(stored.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += local.length + nameBytes.length + stored.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const part of central) centralSize += part.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...parts, ...central, end]);
}

function manifest({ name = 'devin-model-picker', version = '0.2.0', publisher = 'klarkxy', attrs = {} } = {}) {
  const identity = `<Identity Language="en-US" Id="${name}" Version="${version}" Publisher="${publisher}" ${attrs.extra || ''}/>`;
  return Buffer.from(`<?xml version="1.0"?><PackageManifest Version="2.0.0"><Metadata>${identity}<DisplayName>x</DisplayName></Metadata></PackageManifest>`);
}

function vsixFor(version, { deflate = false, name, publisher, manifestOverride } = {}) {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>'), deflate },
    { name: 'extension/package.json', data: Buffer.from(JSON.stringify({
      name: name || 'devin-model-picker', publisher: publisher || 'klarkxy', version })), deflate },
    { name: 'extension.vsixmanifest', data: manifestOverride ?? manifest({ name, version, publisher }), deflate },
  ]);
}

// --- helpers ------------------------------------------------------------------

function releasePayload(version, { digest, size, url, draft = false, prerelease = false, assets, html_url } = {}) {
  const name = `devin-model-picker-${version}.vsix`;
  return {
    tag_name: 'v' + version, draft, prerelease, body: 'notes',
    html_url: html_url ?? `https://github.com/klarkxy/devin-model-picker/releases/tag/v${version}`,
    assets: assets ?? [{ name, size: size ?? 12345, digest: 'sha256:' + (digest ?? 'a'.repeat(64)),
      browser_download_url: url ?? `https://github.com/klarkxy/devin-model-picker/releases/download/v${version}/${name}` }],
  };
}

function updaterFixture({ currentVersion = '0.1.11', version = '0.2.0', choice, release, fetchImpl, installImpl, deflate = false } = {}) {
  const vsix = vsixFor(version, { deflate });
  const digest = crypto.createHash('sha256').update(vsix).digest('hex');
  const download = `https://github.com/klarkxy/devin-model-picker/releases/download/v${version}/devin-model-picker-${version}.vsix`;
  const info = release ?? releasePayload(version, { digest, size: vsix.length, url: download });
  const calls = { fetches: [], available: [], installed: [], error: [], upToDate: [], openUrl: [], installedFiles: [], logs: [] };
  const store = {};
  const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-upd-'));
  const updater = upd.createUpdater({ currentVersion,
    globalState: { get: key => store[key], update: async (key, value) => { store[key] = value; } },
    storagePath,
    fetchImpl: fetchImpl || (async url => {
      calls.fetches.push(url);
      return url === upd.API ? new Response(JSON.stringify(info)) : new Response(vsix);
    }),
    install: installImpl || (async file => { calls.installedFiles.push(file); calls.fileExisted = fs.existsSync(file); }),
    ui: {
      available: async item => { calls.available.push(item); return typeof choice === 'function' ? choice(item) : choice; },
      installed: async v => calls.installed.push(v),
      error: async m => calls.error.push(m),
      upToDate: async v => calls.upToDate.push(v),
      openUrl: async u => calls.openUrl.push(u),
    },
    log: event => calls.logs.push(event) });
  return { updater, calls, store, storagePath, vsix, info };
}

// --- version + release parsing ------------------------------------------------

test('parseVersion is strict x.y.z; compareVersions orders', () => {
  assert.deepEqual(upd.parseVersion('1.2.3'), [1, 2, 3]);
  assert.equal(upd.parseVersion('1.2'), null);
  assert.equal(upd.parseVersion('v1.2.3'), null);
  assert.equal(upd.parseVersion('1.2.3-beta'), null);
  assert.ok(upd.compareVersions('0.2.0', '0.1.11') > 0);
  assert.ok(upd.compareVersions('0.1.10', '0.1.11') < 0);
  assert.equal(upd.compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(Number.isNaN(upd.compareVersions('x', '1.0.0')));
});

test('releaseInfo accepts the real-shaped payload and gates installable', () => {
  const info = upd.releaseInfo(releasePayload('0.1.10', { size: 7777 }));
  assert.equal(info.version, '0.1.10');
  assert.equal(info.tag, 'v0.1.10');
  assert.equal(info.name, 'devin-model-picker-0.1.10.vsix');
  assert.equal(info.digest, 'a'.repeat(64));
  assert.equal(info.installable, true);
  assert.equal(info.page, 'https://github.com/klarkxy/devin-model-picker/releases/tag/v0.1.10');
  for (const bad of [{ draft: true }, { prerelease: true }]) {
    assert.throws(() => upd.releaseInfo(releasePayload('0.2.0', bad)), /unpublished/);
  }
  assert.throws(() => upd.releaseInfo(releasePayload('x.y', {})), /tag/);
  assert.throws(() => upd.releaseInfo(releasePayload('0.2', {})), /tag/);
  assert.throws(() => upd.releaseInfo(null), /invalid/);
  const cases = {
    'missing asset': releasePayload('0.2.0', { assets: [{ name: 'other.vsix' }] }),
    'wrong download url': releasePayload('0.2.0', { url: 'https://evil.invalid/x.vsix' }),
    'tag in url differs': releasePayload('0.2.0', { url: 'https://github.com/klarkxy/devin-model-picker/releases/download/v9.9.9/devin-model-picker-0.2.0.vsix' }),
    'bad digest': releasePayload('0.2.0', { digest: 'zzzz' }),
    'missing digest': releasePayload('0.2.0', { digest: undefined, assets: [{ name: 'devin-model-picker-0.2.0.vsix', size: 5, browser_download_url: 'https://github.com/klarkxy/devin-model-picker/releases/download/v0.2.0/devin-model-picker-0.2.0.vsix' }] }),
    'zero size': releasePayload('0.2.0', { size: 0 }),
    'oversize': releasePayload('0.2.0', { size: upd.MAX + 1 }),
  };
  for (const [label, payload] of Object.entries(cases)) {
    assert.equal(upd.releaseInfo(payload).installable, false, label);
  }
  assert.equal(upd.releaseInfo(releasePayload('0.2.0', { html_url: '' })).page,
    'https://github.com/klarkxy/devin-model-picker/releases/tag/v0.2.0');
});

// --- fetchBytes ---------------------------------------------------------------

test('fetchBytes follows an allowed redirect and streams within the limit', async () => {
  const seen = [];
  const data = await upd.fetchBytes('https://github.com/a', {
    limit: 16,
    fetchImpl: async (url, options) => {
      seen.push(url);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers['user-agent'], 'devin-model-picker');
      if (url === 'https://github.com/a') return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/blob' } });
      return new Response(Buffer.from('ok'));
    } });
  assert.equal(data.toString(), 'ok');
  assert.deepEqual(seen, ['https://github.com/a', 'https://release-assets.githubusercontent.com/blob']);
  assert.equal(upd.fetchBytes.length >= 0, true);
  // API calls get the GitHub accept header.
  let accept;
  await upd.fetchBytes('https://api.github.com/x', { limit: 8,
    fetchImpl: async (url, options) => { accept = options.headers.accept; return new Response('{}'); } });
  assert.equal(accept, 'application/vnd.github+json');
});

test('fetchBytes rejects disallowed hops, http URLs and over-limit bodies', async () => {
  const to = url => ({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: url } }) });
  await assert.rejects(upd.fetchBytes('https://github.com/a', { limit: 8, ...to('https://evil.invalid/x') }), /blocked/);
  await assert.rejects(upd.fetchBytes('https://github.com/a', { limit: 8, ...to('http://github.com/x') }), /blocked/);
  await assert.rejects(upd.fetchBytes('https://github.com/a', { limit: 8, ...to('https://user:pw@github.com/x') }), /blocked/);
  await assert.rejects(upd.fetchBytes('https://github.com/a', { limit: 8, ...to('https://github.com:8443/x') }), /blocked/);
  await assert.rejects(upd.fetchBytes('http://github.com/x', { limit: 8, fetchImpl: async () => new Response('x') }), /blocked/);
  await assert.rejects(upd.fetchBytes('https://github.com/a', { limit: 8, fetchImpl: async () => new Response(Buffer.alloc(64)) }), /too_large/);
  await assert.rejects(upd.fetchBytes('https://github.com/a', { limit: 8, fetchImpl: async () => new Response('x', { status: 404 }) }), /http_404/);
});

// --- zip + vsix verification ----------------------------------------------------

test('readZipEntry reads store and deflate entries', () => {
  for (const deflate of [false, true]) {
    const zip = vsixFor('0.2.0', { deflate });
    const pkg = JSON.parse(upd.readZipEntry(zip, 'extension/package.json').toString('utf8'));
    assert.equal(pkg.name, 'devin-model-picker');
    assert.match(upd.readZipEntry(zip, 'extension.vsixmanifest').toString('utf8'), /<Identity/);
  }
  assert.throws(() => upd.readZipEntry(vsixFor('0.2.0'), 'missing'), /missing/);
  assert.throws(() => upd.readZipEntry(Buffer.from('not a zip'), 'x'), /invalid/);
});

test('verifyVsix accepts matching identity, rejects mismatches and unsafe manifests', () => {
  assert.equal(upd.verifyVsix(vsixFor('0.2.0'), '0.2.0'), true);
  assert.equal(upd.verifyVsix(vsixFor('0.2.0', { deflate: true }), '0.2.0'), true);
  assert.throws(() => upd.verifyVsix(vsixFor('0.2.0', { name: 'other-ext' }), '0.2.0'));
  assert.throws(() => upd.verifyVsix(vsixFor('0.2.0', { publisher: 'someone' }), '0.2.0'));
  assert.throws(() => upd.verifyVsix(vsixFor('0.2.0'), '0.3.0'));
  const doctype = Buffer.from('<?xml version="1.0"?><!DOCTYPE x><PackageManifest><Metadata><Identity Id="devin-model-picker" Version="0.2.0" Publisher="klarkxy"/></Metadata></PackageManifest>');
  assert.throws(() => upd.verifyVsix(vsixFor('0.2.0', { manifestOverride: doctype }), '0.2.0'));
  const two = Buffer.from('<PackageManifest><Metadata><Identity Id="a" Version="1" Publisher="p"/><Identity Id="devin-model-picker" Version="0.2.0" Publisher="klarkxy"/></Metadata></PackageManifest>');
  assert.throws(() => upd.verifyVsix(vsixFor('0.2.0', { manifestOverride: two }), '0.2.0'));
});

test('verifyVsix accepts the real VSIX produced by scripts/package.cjs', () => {
  const root = path.resolve(__dirname, '..');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-pkg-'));
  try {
    for (const name of ['package.json', 'src', 'media', 'scripts', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
      fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
    }
    const out = execFileSync(process.execPath, [path.join(stage, 'scripts', 'package.cjs')], { encoding: 'utf8' }).trim();
    const pkg = require('../package.json');
    assert.equal(path.basename(out), `devin-model-picker-${pkg.version}.vsix`);
    assert.equal(upd.verifyVsix(fs.readFileSync(out), pkg.version), true);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});

// --- createUpdater --------------------------------------------------------------

test('a newer release is announced once; ignore persists, manual still offers', async () => {
  const f = updaterFixture({ choice: 'ignore' });
  await f.updater.check({ manual: false });
  assert.equal(f.calls.available.length, 1);
  assert.equal(f.calls.available[0].version, '0.2.0');
  assert.equal(f.calls.available[0].installable, true);
  assert.equal(f.store.dmpUpdate.ignoredVersion, '0.2.0');
  await f.updater.check({ manual: false });
  assert.equal(f.calls.available.length, 1, 'ignored version stays silent on auto checks');
  await f.updater.check({ manual: true });
  assert.equal(f.calls.available.length, 2, 'manual check still offers an ignored version');
});

test('a dismissed auto announcement is not repeated within the session', async () => {
  const f = updaterFixture({ choice: undefined });
  await f.updater.check({ manual: false });
  await f.updater.check({ manual: false });
  assert.equal(f.calls.available.length, 1);
});

test('update downloads, verifies digest+vsix, installs, cleans temp dir', async () => {
  const f = updaterFixture({ choice: 'update' });
  await f.updater.check({ manual: false });
  assert.deepEqual(f.calls.fetches.slice(0, 1), [upd.API]);
  assert.ok(f.calls.fetches.includes('https://github.com/klarkxy/devin-model-picker/releases/download/v0.2.0/devin-model-picker-0.2.0.vsix'));
  assert.equal(f.calls.installedFiles.length, 1);
  assert.equal(f.calls.fileExisted, true, 'file exists when install is invoked');
  assert.equal(path.dirname(f.calls.installedFiles[0]).startsWith(f.storagePath), true);
  assert.equal(fs.existsSync(path.dirname(f.calls.installedFiles[0])), false, 'temp dir removed afterwards');
  assert.deepEqual(f.calls.installed, ['0.2.0']);
  assert.deepEqual(f.calls.error, []);
});

test('update flow works on a deflate-compressed VSIX too', async () => {
  const f = updaterFixture({ choice: 'update', deflate: true });
  await f.updater.check({ manual: false });
  assert.equal(f.calls.installedFiles.length, 1);
  assert.deepEqual(f.calls.installed, ['0.2.0']);
});

test('digest mismatch skips install and reports the error', async () => {
  const f = updaterFixture({ choice: 'update' });
  f.info.assets[0].digest = 'sha256:' + 'f'.repeat(64);
  await f.updater.check({ manual: false });
  assert.equal(f.calls.installedFiles.length, 0);
  assert.equal(f.calls.installed.length, 0);
  assert.deepEqual(f.calls.error, ['更新失败，可以重试或到发布页手动下载安装。']);
  assert.ok(f.calls.logs.includes('update-install-failed'));
});

test('notes opens the release page; non-installable omits the update path', async () => {
  const f = updaterFixture({ choice: 'notes' });
  await f.updater.check({ manual: false });
  assert.deepEqual(f.calls.openUrl, [f.info.html_url]);
  const noAsset = updaterFixture({ choice: 'update', release: releasePayload('0.2.0', { assets: [] }) });
  await noAsset.updater.check({ manual: false });
  assert.equal(noAsset.calls.available[0].installable, false);
  assert.equal(noAsset.calls.installedFiles.length, 0);
  assert.deepEqual(noAsset.calls.error, []);
});

test('same or older version: manual says up-to-date, auto stays silent', async () => {
  const f = updaterFixture({ version: '0.1.11', choice: 'update' });
  await f.updater.check({ manual: false });
  assert.equal(f.calls.available.length, 0);
  await f.updater.check({ manual: true });
  assert.equal(f.calls.available.length, 0);
  assert.deepEqual(f.calls.upToDate, ['0.1.11']);
});

test('check failures: manual shows an error, automatic only logs', async () => {
  const failing = manual => {
    const calls = { error: [], logs: [] };
    const updater = upd.createUpdater({ currentVersion: '0.1.11',
      globalState: { get: () => undefined, update: async () => {} },
      storagePath: os.tmpdir(),
      fetchImpl: async () => { throw new Error('network down'); },
      install: async () => {}, ui: { error: async m => calls.error.push(m) },
      log: e => calls.logs.push(e) });
    return updater.check({ manual }).then(() => calls);
  };
  const manual = await failing(true);
  assert.deepEqual(manual.error, ['检查更新失败，请检查网络后重试。']);
  assert.deepEqual(manual.logs, []);
  const auto = await failing(false);
  assert.deepEqual(auto.error, []);
  assert.deepEqual(auto.logs, ['update-check-failed']);
});

test('concurrent checks share the network fetch, not the prompt', async () => {
  let fetches = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = updaterFixture({ fetchImpl: async () => { fetches++; await gate; return new Response(JSON.stringify(releasePayload('0.2.0'))); } });
  const a = f.updater.check({ manual: false });
  const b = f.updater.check({ manual: true });
  release();
  await Promise.all([a, b]);
  assert.equal(fetches, 1, 'one network request for both checks');
  assert.equal(f.calls.available.length, 2, 'each caller still prompts independently');
});

test('a stalled prompt never blocks a later manual check', async () => {
  const f = updaterFixture({ choice: () => f.calls.available.length === 1 ? new Promise(() => {}) : 'ignore' });
  void f.updater.check({ manual: false });
  for (let i = 0; i < 50 && f.calls.available.length === 0; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(f.calls.available.length, 1, 'auto prompt is pending');
  await f.updater.check({ manual: true });
  assert.equal(f.calls.available.length, 2, 'manual check prompts while the auto prompt is pending');
  assert.equal(f.calls.fetches.length, 2, 'manual check fetched again after the first network call settled');
  assert.equal(f.store.dmpUpdate.ignoredVersion, '0.2.0');
  f.updater.dispose();
});

test('a second update choice during an install is a no-op', async () => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const installs = [];
  const f = updaterFixture({ choice: 'update', installImpl: async file => { installs.push(file); await gate; } });
  const first = f.updater.check({ manual: true });
  for (let i = 0; i < 50 && installs.length === 0; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(installs.length, 1, 'first install is running');
  await f.updater.check({ manual: true });
  assert.equal(installs.length, 1, 'second update choice does not reinstall');
  assert.equal(f.calls.available.length, 2);
  resume();
  await first;
  assert.deepEqual(f.calls.installed, ['0.2.0']);
});

test('start checks after 15s then every interval; dispose stops timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => t.mock.timers.reset());
  let fetches = 0;
  const f = updaterFixture({ fetchImpl: async () => { fetches++; return new Response(JSON.stringify(releasePayload('0.1.11'))); } });
  f.updater.start();
  assert.equal(fetches, 0);
  t.mock.timers.tick(15000);
  assert.equal(fetches, 1, 'first check after 15 seconds');
  await new Promise(r => setImmediate(r));
  t.mock.timers.tick(upd.INTERVAL);
  assert.equal(fetches, 2, 'then every interval');
  await new Promise(r => setImmediate(r));
  f.updater.dispose();
  t.mock.timers.tick(upd.INTERVAL * 5);
  assert.equal(fetches, 2, 'no checks after dispose');
});
