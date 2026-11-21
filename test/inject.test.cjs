'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inject = require('../src/inject.cjs');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64').replace(/=+$/, '');
const SOURCE = path.resolve(__dirname, '../media/picker.js');

function fakeApp(t) {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-app-'));
  const dir = path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench');
  fs.mkdirSync(dir, { recursive: true });
  const html = [
    '<html><head></head><body>',
    '<script src="./devin-zh-dom.js"></script>',
    '<script src="./workbench.js" type="module"></script>',
    '</body></html>',
  ].join('\n');
  const workbenchHtml = path.join(dir, 'workbench.html');
  fs.writeFileSync(workbenchHtml, html);
  fs.writeFileSync(path.join(dir, 'devin-zh-dom.js'), '// zh-hans\n');
  fs.writeFileSync(path.join(dir, 'workbench.js'), '// workbench\n');
  // Checksum keys are relative to appRoot/out (see syncChecksums).
  const rel = file => path.relative(path.join(appRoot, 'out'), file).split(path.sep).join('/');
  fs.writeFileSync(path.join(appRoot, 'product.json'), JSON.stringify({ checksums: {
    [rel(workbenchHtml)]: sha(workbenchHtml),
    [rel(path.join(dir, 'workbench.js'))]: sha(path.join(dir, 'workbench.js')),
  } }, null, 2));
  t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
  return { appRoot, dir, workbenchHtml };
}

const checksums = appRoot => JSON.parse(fs.readFileSync(path.join(appRoot, 'product.json'), 'utf8')).checksums;
const HTML_KEY = 'vs/code/electron-browser/workbench/workbench.html';

test('apply inserts our script once, never touches the zh-dom tag, updates checksums', t => {
  const { appRoot, dir, workbenchHtml } = fakeApp(t);
  const before = checksums(appRoot);
  const first = inject.applyInjection({ appRoot, source: SOURCE });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  const html = fs.readFileSync(workbenchHtml, 'utf8');
  assert.ok(html.includes('<script src="./devin-zh-dom.js"></script>'), 'zh-hans tag untouched');
  assert.ok(html.includes('<script src="./devin-model-picker.js"></script>\n\t<script src="./workbench.js" type="module"></script>'));
  assert.ok(fs.existsSync(path.join(dir, 'devin-model-picker.js')));
  const after = checksums(appRoot);
  assert.notEqual(after[HTML_KEY], before[HTML_KEY]);
  assert.equal(after[HTML_KEY], sha(workbenchHtml));
  const second = inject.applyInjection({ appRoot, source: SOURCE });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false, 'idempotent');
  assert.equal(fs.readFileSync(workbenchHtml, 'utf8').split('devin-model-picker.js').length - 1, 1);
});

test('remove deletes only our tag and file, then restores checksum consistency', t => {
  const { appRoot, dir, workbenchHtml } = fakeApp(t);
  const originalHtml = fs.readFileSync(workbenchHtml, 'utf8');
  inject.applyInjection({ appRoot, source: SOURCE });
  const removed = inject.removeInjection({ appRoot });
  assert.equal(removed.changed, true);
  assert.equal(fs.readFileSync(workbenchHtml, 'utf8'), originalHtml);
  assert.ok(!fs.existsSync(path.join(dir, 'devin-model-picker.js')));
  assert.ok(fs.existsSync(path.join(dir, 'devin-zh-dom.js')));
  for (const [file, sum] of Object.entries(checksums(appRoot))) {
    assert.equal(sum, sha(path.join(appRoot, 'out', file)), file);
  }
  assert.equal(inject.removeInjection({ appRoot }).changed, false);
});

test('missing workbench anchor reports anchor_missing without writes', t => {
  const { appRoot, workbenchHtml, dir } = fakeApp(t);
  fs.writeFileSync(workbenchHtml, '<html>no anchor</html>');
  const result = inject.applyInjection({ appRoot, source: SOURCE });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'anchor_missing');
  assert.equal(fs.readFileSync(workbenchHtml, 'utf8'), '<html>no anchor</html>');
  assert.ok(fs.existsSync(path.join(dir, 'devin-model-picker.js')), 'script copy is still maintained');
});

test('html write errors surface as failures instead of throwing', t => {
  const { appRoot, workbenchHtml } = fakeApp(t);
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).includes('workbench.html')) {
      const error = new Error('denied'); error.code = 'EPERM'; throw error;
    }
    return real(file, ...args);
  });
  const result = inject.applyInjection({ appRoot, source: SOURCE });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'html_write_failed');
});
