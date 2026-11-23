'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { discover } = require('./config.cjs');
const { normalizeBaseUrlPath } = require('./panel/base-url.cjs');
const { loadIndex } = require('./models-dev.cjs');
const { SettingsInputError, mergeModel, signature: providerSignature,
  setEnabled, saveProvider, deleteProvider, setProviderEnabled, setModelEnabled,
  removeModel, discoverModels, importView, importModels, refreshMeta } = require('./byok-ops.cjs');

function publicState(config) {
  return {
    enabled: config.enabled !== false,
    providers: (config.providers || []).map(provider => ({
      id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat, enabled: provider.enabled !== false, keyConfigured: !!provider.apiKey,
      models: (provider.models || []).map(model => ({
        id: model.id, label: model.label || model.id, enabled: model.enabled !== false,
        contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
        efforts: model.efforts || [], supportsImages: model.supportsImages !== false,
        source: model.meta?.source || 'default', family: model.meta?.family || '',
      })),
    })),
  };
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-__NONCE__';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Devin Model Picker：设置</title>
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; max-width: 900px; }
h2 { font-size: 15px; margin: 18px 0 8px; }
.provider { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; }
.provider-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.provider-head strong { font-size: 13px; }
.muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button:hover { filter: brightness(1.1); }
table { border-collapse: collapse; width: 100%; margin-top: 8px; }
td, th { text-align: left; padding: 4px 8px; font-size: 12px; border-bottom: 1px solid var(--vscode-panel-border); }
input[type=text], input[type=password], select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 4px 8px; font-size: 12px; width: 100%; box-sizing: border-box; }
label.field { display: block; margin: 8px 0 2px; font-size: 12px; }
dialog { background: var(--vscode-editor-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 16px; width: 640px; max-width: 95vw; }
dialog::backdrop { background: rgba(0,0,0,.4); }
.checklist { max-height: 320px; overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 8px 0; }
.checklist label { display: flex; gap: 8px; padding: 4px 8px; font-size: 12px; align-items: baseline; }
.error { color: var(--vscode-errorForeground); font-size: 12px; margin-top: 6px; }
.row { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; align-items: center; }
.row .spacer { margin-right: auto; display: flex; gap: 6px; }
button:disabled { opacity: .45; cursor: default; }
button.danger { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
</style></head><body>
<h1 style="font-size:17px;margin-bottom:4px">Devin Model Picker：设置</h1>
<p class="muted" style="margin:0 0 12px">管理自定义 OpenAI / Anthropic 兼容供应商与模型；也可以直接在编辑器的模型卡片选择器「供应商」标签页中快速添加。</p>
<label style="font-size:13px"><input type="checkbox" id="enabled"> 启用 BYOK 模型接入</label>
<div class="error" id="page-error"></div>
<div class="muted" id="page-status" style="margin-top:4px"></div>
<h2>供应商</h2>
<div id="providers"></div>
<button id="add">添加供应商</button>
<dialog id="editor"><h2 id="editor-title">供应商</h2>
<label class="field">名称</label><input type="text" id="f-name" placeholder="例如 OpenRouter / DeepSeek">
<label class="field">API 地址</label><input type="text" id="f-url" placeholder="https://api.example.com/v1">
<div class="muted" id="f-url-preview" style="margin-top:3px"></div>
<label class="field">密钥（编辑时留空表示沿用当前密钥）</label><input type="password" id="f-key" autocomplete="off" placeholder="sk-...">
<label class="field">接口类型</label><select id="f-format"><option value="openai">OpenAI 对话</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option></select>
<div class="error" id="f-error"></div>
<div class="row"><button class="secondary" id="f-cancel">取消</button><button id="f-save">保存</button></div>
</dialog>
<dialog id="importer"><h2>导入模型</h2>
<input type="text" id="i-search" placeholder="搜索模型名称或 ID…">
<div class="checklist" id="i-list"></div>
<div class="muted" id="i-status"></div>
<div class="error" id="i-error"></div>
<div class="row"><span class="spacer"><button class="secondary" id="i-all">全选当前</button><button class="secondary" id="i-none">取消全选</button></span><button class="secondary" id="i-cancel">取消</button><button id="i-save">导入所选</button></div>
</dialog>
<script nonce="__NONCE__">
const vscode = acquireVsCodeApi();
const normalizeBaseUrlPath = __NORMALIZE__;
let state = { enabled: true, providers: [] };
let pendingImport = null;
let selectedImportIds = new Set();
let editing = null;
let confirmDeleteId = null;
const $ = id => document.getElementById(id);
function post(op, payload) { $('page-error').textContent = ''; vscode.postMessage({ op, payload }); }
function td(parent, text, title) { const el = document.createElement('td'); el.textContent = text; if (title) el.title = title; parent.appendChild(el); return el; }
function btn(text, cls, onclick) { const b = document.createElement('button'); b.textContent = text; if (cls) b.className = cls; b.onclick = onclick; return b; }
function fmtTokens(n) {
  if (!n || !Number.isFinite(n)) return '';
  if (n >= 1000000) return parseFloat((n / 1000000).toFixed(2)) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}
function fmtSource(s) { return s === 'provider' ? '接口返回' : s === 'default' ? '默认' : (s || ''); }
function render() {
  $('enabled').checked = state.enabled;
  const host = $('providers'); host.textContent = '';
  if (!state.providers.length) {
    const none = document.createElement('div');
    none.className = 'muted';
    none.style.marginBottom = '10px';
    none.textContent = '尚未添加供应商。点击下方「添加供应商」开始接入自定义模型。';
    host.appendChild(none);
    return;
  }
  for (const p of state.providers) {
    const card = document.createElement('div'); card.className = 'provider';
    const head = document.createElement('div'); head.className = 'provider-head';
    head.appendChild(btn(p.enabled ? '已启用' : '已停用', 'secondary', () => post('setProviderEnabled', { id: p.id, enabled: !p.enabled })));
    const title = document.createElement('strong'); title.textContent = p.name; head.appendChild(title);
    const fmt = { openai: 'OpenAI 对话', 'openai-responses': 'OpenAI Responses', anthropic: 'Anthropic' }[p.apiFormat] || p.apiFormat;
    const meta = document.createElement('span'); meta.className = 'muted';
    meta.textContent = fmt + ' · ' + p.baseUrl + (p.keyConfigured ? ' · 已配置密钥' : ' · 未配置密钥');
    head.appendChild(meta);
    head.appendChild(btn('编辑', 'secondary', () => openEditor(p)));
    head.appendChild(btn('导入模型', '', () => { $('page-status').textContent = '正在从「' + p.name + '」获取模型列表…'; post('discover', { providerId: p.id }); }));
    head.appendChild(btn('刷新元数据', 'secondary', () => { $('page-status').textContent = '正在刷新「' + p.name + '」的模型元数据…'; post('refreshMeta', { providerId: p.id }); }));
    if (confirmDeleteId === p.id) {
      head.appendChild(btn('确认删除', 'danger', () => { confirmDeleteId = null; post('deleteProvider', { id: p.id }); }));
      head.appendChild(btn('取消', 'secondary', () => { confirmDeleteId = null; render(); }));
    } else {
      head.appendChild(btn('删除', 'secondary', () => { confirmDeleteId = p.id; render(); }));
    }
    card.appendChild(head);
    if (p.models.length) {
      const table = document.createElement('table');
      const hr = document.createElement('tr'); ['模型', '上下文', '最大输出', '推理档位', '图片', '元数据来源', ''].forEach(h => { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
      table.appendChild(hr);
      for (const m of p.models) {
        const tr = document.createElement('tr');
        const name = td(tr, '', m.id); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = m.enabled;
        cb.onchange = () => post('setModelEnabled', { providerId: p.id, modelId: m.id, enabled: cb.checked });
        name.appendChild(cb); name.appendChild(document.createTextNode(' ' + m.label));
        td(tr, fmtTokens(m.contextWindow), m.contextWindow ? String(m.contextWindow) : '');
        td(tr, fmtTokens(m.maxOutputTokens), m.maxOutputTokens ? String(m.maxOutputTokens) : '');
        td(tr, (m.efforts || []).map(e => e === null ? '默认' : e).join(', '));
        td(tr, m.supportsImages ? '支持' : '不支持');
        td(tr, fmtSource(m.source));
        const ops = td(tr, ''); ops.appendChild(btn('移除', 'secondary', () => post('removeModel', { providerId: p.id, modelId: m.id })));
        table.appendChild(tr);
      }
      card.appendChild(table);
    } else {
      const empty = document.createElement('div'); empty.className = 'muted'; empty.style.marginTop = '8px'; empty.textContent = '尚未导入模型，点击「导入模型」获取可用模型列表。'; card.appendChild(empty);
    }
    host.appendChild(card);
  }
}
function openEditor(p) {
  editing = p || null;
  $('editor-title').textContent = p ? '编辑供应商' : '添加供应商';
  $('f-name').value = p ? p.name : '';
  $('f-url').value = p ? p.baseUrl : '';
  $('f-key').value = ''; $('f-key').placeholder = p && p.keyConfigured ? '已配置密钥，留空保持不变' : 'sk-...';
  $('f-format').value = p ? p.apiFormat : 'openai';
  $('f-error').textContent = ''; previewUrl();
  $('editor').showModal();
}
function previewUrl() {
  try {
    const u = new URL($('f-url').value);
    u.pathname = normalizeBaseUrlPath(u.pathname);
    const base = u.toString();
    const clean = base.endsWith('/') ? base.slice(0, -1) : base;
    const suffix = { openai: '/chat/completions', 'openai-responses': '/responses', anthropic: '/messages' }[$('f-format').value] || '/chat/completions';
    $('f-url-preview').textContent = '实际请求地址：' + clean + suffix;
  } catch { $('f-url-preview').textContent = ''; }
}
function updateImportStatus() {
  if (!pendingImport) return;
  $('i-status').textContent = '共 ' + pendingImport.models.length + ' 个模型，本次已选 ' + selectedImportIds.size + ' 个';
  $('i-save').disabled = selectedImportIds.size === 0;
}
function renderImport() {
  const list = $('i-list'); list.textContent = '';
  const filter = $('i-search').value.toLowerCase();
  for (const m of pendingImport.models) {
    if (filter && !(m.id.toLowerCase().includes(filter) || m.label.toLowerCase().includes(filter))) continue;
    const label = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = m.id;
    cb.checked = m.imported ? false : selectedImportIds.has(m.id); cb.disabled = m.imported;
    cb.onchange = () => {
      if (cb.checked) selectedImportIds.add(m.id);
      else selectedImportIds.delete(m.id);
      updateImportStatus();
    };
    label.appendChild(cb);
    const info = document.createElement('span');
    info.textContent = m.label + '  ·  ' + (fmtTokens(m.contextWindow) || m.contextWindow) + ' ctx  ·  ' + (m.efforts || []).map(e => e === null ? '默认' : e).join(', ') + (m.imported ? '  （已导入）' : '');
    label.appendChild(info);
    list.appendChild(label);
  }
  updateImportStatus();
}
$('add').onclick = () => openEditor(null);
$('enabled').onchange = () => post('setEnabled', { enabled: $('enabled').checked });
$('f-url').oninput = previewUrl;
$('f-format').onchange = previewUrl;
for (const id of ['f-name', 'f-url', 'f-key']) {
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('f-save').click(); } });
}
$('f-cancel').onclick = () => $('editor').close();
$('f-save').onclick = () => post('saveProvider', { id: editing ? editing.id : undefined, name: $('f-name').value, baseUrl: $('f-url').value, apiKey: $('f-key').value || undefined, apiFormat: $('f-format').value });
$('i-cancel').onclick = () => $('importer').close();
$('i-search').oninput = renderImport;
$('i-all').onclick = () => { for (const cb of $('i-list').querySelectorAll('input[type=checkbox]:not(:disabled)')) { cb.checked = true; selectedImportIds.add(cb.value); } updateImportStatus(); };
$('i-none').onclick = () => { for (const cb of $('i-list').querySelectorAll('input[type=checkbox]:not(:disabled)')) { cb.checked = false; selectedImportIds.delete(cb.value); } updateImportStatus(); };
$('i-save').onclick = () => {
  const ids = [...selectedImportIds];
  post('importModels', { providerId: pendingImport.providerId, token: pendingImport.token, ids });
};
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'state') { $('page-status').textContent = ''; $('page-error').textContent = ''; state = msg.state; render(); }
  if (msg.type === 'import') { $('page-status').textContent = ''; pendingImport = msg; selectedImportIds = new Set(msg.models.filter(m => !m.imported).map(m => m.id)); $('i-error').textContent = ''; $('i-search').value = ''; renderImport(); $('importer').showModal(); }
  if (msg.type === 'close') { $('editor').close(); $('importer').close(); }
  if (msg.type === 'error') {
    $('page-status').textContent = '';
    if ($('editor').open) $('f-error').textContent = msg.message;
    else if ($('importer').open) $('i-error').textContent = msg.message;
    else $('page-error').textContent = msg.message;
  }
});
post('ready', {});
</script></body></html>`;

function nonce() { return crypto.randomBytes(16).toString('base64'); }

let panel;
function openSettings({ vscode, context, root, configFile, read, write, log = () => {}, afterChange = async () => {} } = {}) {
  if (panel) { panel.reveal(); return panel; }
  panel = vscode.window.createWebviewPanel('devinModelPicker.settings', 'Devin Model Picker：设置',
    vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  const modelsDevFile = path.join(root, 'models-dev.json');
  const n = nonce();
  panel.webview.html = HTML.replaceAll('__NONCE__', n).replace('__NORMALIZE__', normalizeBaseUrlPath.toString());
  panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
  let pending = null;
  const state = () => publicState(read());
  const push = () => { try { panel.webview.postMessage({ type: 'state', state: state() }); } catch {} };
  const failTo = message => { try { panel.webview.postMessage({ type: 'error', message }); } catch {} };
  const changed = async () => { push(); await afterChange(); };
  const modelsDevIndex = async () => { try { return (await loadIndex({ file: modelsDevFile })).index; } catch { return null; } };
  panel.webview.onDidReceiveMessage(async message => {
    const op = message?.op, payload = message?.payload || {};
    try {
      if (op === 'ready') { push(); return; }
      const config = read();
      switch (op) {
        case 'setEnabled':
          setEnabled(config, payload);
          write(config); await changed(); return;
        case 'saveProvider':
          saveProvider(config, payload);
          write(config); try { panel.webview.postMessage({ type: 'close' }); } catch {}
          await changed(); return;
        case 'deleteProvider':
          deleteProvider(config, payload);
          write(config); await changed(); return;
        case 'setProviderEnabled':
          setProviderEnabled(config, payload);
          write(config); await changed(); return;
        case 'setModelEnabled':
          setModelEnabled(config, payload);
          write(config); await changed(); return;
        case 'removeModel':
          removeModel(config, payload);
          write(config); await changed(); return;
        case 'discover': {
          const index = await modelsDevIndex();
          const { provider, models } = await discoverModels(config, payload, { discover, index });
          pending = { providerId: provider.id, signature: providerSignature(provider), token: crypto.randomUUID(), models };
          panel.webview.postMessage({ type: 'import', providerId: provider.id, token: pending.token, models: importView(provider, models) });
          return;
        }
        case 'importModels': {
          importModels(config, payload, pending);
          write(config); pending = null;
          try { panel.webview.postMessage({ type: 'close' }); } catch {}
          await changed(); return;
        }
        case 'refreshMeta': {
          const index = await modelsDevIndex();
          await refreshMeta(config, payload, { discover, index });
          write(config); await changed(); return;
        }
      }
    } catch (error) {
      failTo(error instanceof SettingsInputError ? error.message : '操作失败，请检查接口配置和连接状态。');
      if (!(error instanceof SettingsInputError)) try { log('settings-error', { message: String(error?.message || error) }); } catch {}
    }
  });
  return panel;
}

module.exports = { openSettings, publicState, mergeModel };
