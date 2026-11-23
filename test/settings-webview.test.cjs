'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function extractScript() {
  const source = fs.readFileSync(path.join(__dirname, '../src/settings.cjs'), 'utf8');
  const begin = source.indexOf('<script nonce="__NONCE__">');
  const end = source.indexOf('</script></body></html>', begin);
  assert.ok(begin >= 0 && end > begin, 'settings webview script not found');
  return source.slice(begin + '<script nonce="__NONCE__">'.length, end)
    .replace('const normalizeBaseUrlPath = __NORMALIZE__;', 'const normalizeBaseUrlPath = p => p;');
}

function matchSel(el, sel) {
  if (sel === 'input[type=checkbox]:not(:disabled)') {
    return el.tagName === 'INPUT' && el.type === 'checkbox' && !el.disabled;
  }
  return false;
}

function node(tag, id) {
  const listeners = Object.create(null);
  const n = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    className: '',
    value: '',
    checked: false,
    disabled: false,
    open: false,
    type: tag === 'input' ? 'text' : '',
    placeholder: '',
    title: '',
    style: {},
    childNodes: [],
    onclick: null,
    oninput: null,
    onchange: null,
    parentNode: null,
    _text: '',
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatchEvent(event) {
      const ev = event && typeof event === 'object' ? event : { type: event };
      if (ev.target == null) ev.target = n;
      for (const fn of listeners[ev.type] || []) fn(ev);
      const hook = n['on' + ev.type];
      if (typeof hook === 'function') hook(ev);
      return true;
    },
    click() { if (n.disabled) return; n.dispatchEvent({ type: 'click' }); },
    appendChild(child) { n.childNodes.push(child); child.parentNode = n; return child; },
    showModal() { n.open = true; },
    close() { n.open = false; },
    querySelectorAll(sel) {
      const out = [];
      const walk = el => {
        for (const child of el.childNodes || []) {
          if (child.tagName && matchSel(child, sel)) out.push(child);
          walk(child);
        }
      };
      walk(n);
      return out;
    },
  };
  Object.defineProperty(n, 'textContent', {
    get() {
      if (n.childNodes.length) return n.childNodes.map(child => child.textContent || child.data || '').join('');
      return n._text;
    },
    set(value) {
      n._text = String(value);
      if (value === '') n.childNodes = [];
    },
  });
  return n;
}

function loadWebview() {
  const ids = [
    'add', 'enabled', 'providers', 'page-error', 'page-status',
    'editor', 'editor-title', 'f-name', 'f-url', 'f-url-preview', 'f-key', 'f-format', 'f-error', 'f-cancel', 'f-save',
    'importer', 'i-search', 'i-list', 'i-status', 'i-error', 'i-all', 'i-none', 'i-cancel', 'i-save',
  ];
  const byId = Object.fromEntries(ids.map(id => {
    const tag = id === 'editor' || id === 'importer' ? 'dialog'
      : id.startsWith('f-') || id === 'i-search' || id === 'enabled' ? 'input' : 'div';
    return [id, node(tag, id)];
  }));
  byId.enabled.type = 'checkbox';
  byId['f-format'] = node('select', 'f-format');
  byId['f-format'].value = 'openai';
  byId['f-key'].type = 'password';
  const posts = [];
  const windowListeners = Object.create(null);
  const windowObj = {
    addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
    dispatchEvent(event) {
      for (const fn of windowListeners[event.type] || []) fn(event);
      return true;
    },
  };
  vm.runInNewContext(extractScript(), {
    acquireVsCodeApi: () => ({ postMessage: msg => posts.push(msg) }),
    document: {
      getElementById: id => byId[id] || null,
      createElement: tag => node(tag),
      createTextNode: text => ({ data: String(text), textContent: String(text) }),
    },
    window: windowObj,
    Set, URL, console,
  });
  return { byId, posts, windowObj };
}

function keyEvent(overrides = {}) {
  const event = { key: 'Enter', isComposing: false, keyCode: 13, defaultPrevented: false, ...overrides };
  event.preventDefault = () => { event.defaultPrevented = true; };
  return event;
}

function sendImport(session, models) {
  session.windowObj.dispatchEvent({
    type: 'message',
    data: { type: 'import', providerId: 'p', token: 'tok', models },
  });
}

function posted(session, op) {
  return session.posts.filter(msg => msg.op === op);
}

function postedIds(session) {
  const last = posted(session, 'importModels').at(-1);
  return last ? Array.from(last.payload.ids) : undefined;
}

test('取消全选 after a filter clears hidden import selections', () => {
  const session = loadWebview();
  sendImport(session, [
    { id: 'alpha', label: 'Alpha', imported: false, contextWindow: 1000, efforts: [null] },
    { id: 'beta', label: 'Beta', imported: false, contextWindow: 1000, efforts: [null] },
  ]);
  session.byId['i-search'].value = 'alpha';
  session.byId['i-search'].oninput();
  assert.equal(session.byId['i-list'].querySelectorAll('input[type=checkbox]:not(:disabled)').length, 1);
  session.byId['i-none'].click();
  assert.equal(session.byId['i-save'].disabled, true, 'empty selection disables the import button');
  session.byId['i-save'].click();
  assert.equal(posted(session, 'importModels').length, 0, 'a disabled import button posts nothing');
});

test('全选当前 still selects only the filtered import rows', () => {
  const session = loadWebview();
  sendImport(session, [
    { id: 'alpha', label: 'Alpha', imported: false, contextWindow: 1000, efforts: [null] },
    { id: 'beta', label: 'Beta', imported: false, contextWindow: 1000, efforts: [null] },
  ]);
  session.byId['i-none'].click();
  session.byId['i-search'].value = 'alpha';
  session.byId['i-search'].oninput();
  session.byId['i-all'].click();
  session.byId['i-save'].click();
  assert.deepEqual(postedIds(session), ['alpha']);
});

test('IME composition Enter does not save the vendor form', () => {
  const session = loadWebview();
  session.byId['f-name'].value = '未确认';
  session.byId['f-url'].value = 'https://api.example.com/v1';
  const composing = keyEvent({ isComposing: true, keyCode: 229 });
  session.byId['f-name'].dispatchEvent({ type: 'keydown', ...composing, preventDefault: composing.preventDefault });
  assert.equal(composing.defaultPrevented, false, 'composition Enter must keep the default IME confirm');
  assert.equal(posted(session, 'saveProvider').length, 0);

  const boundary = keyEvent({ isComposing: false, keyCode: 229 });
  session.byId['f-name'].dispatchEvent({ type: 'keydown', ...boundary, preventDefault: boundary.preventDefault });
  assert.equal(boundary.defaultPrevented, false);
  assert.equal(posted(session, 'saveProvider').length, 0);

  const confirm = keyEvent();
  session.byId['f-name'].dispatchEvent({ type: 'keydown', ...confirm, preventDefault: confirm.preventDefault });
  assert.equal(confirm.defaultPrevented, true);
  const saves = posted(session, 'saveProvider');
  assert.equal(saves.length, 1);
  assert.equal(saves[0].payload.name, '未确认');
});
