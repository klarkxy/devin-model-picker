'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { discover } = require('./config.cjs');
const { normalizeBaseUrlPath } = require('./panel/base-url.cjs');
const { loadIndex, lookup, mergeMetadata } = require('./models-dev.cjs');
const { modelEfforts } = require('./model-capabilities.cjs');
const { buildCatalog } = require('./catalog.cjs');

class SettingsInputError extends Error {}
const fail = message => { throw new SettingsInputError(message); };
function text(value, label, maximum = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) fail(label + '无效。');
  return value.trim();
}
function baseUrl(value) {
  let url; try { url = new URL(text(value, 'API 地址', 2048)); } catch { fail('请填写完整的 http:// 或 https:// API 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('API 地址不能包含登录信息、查询参数或片段。');
  url.pathname = normalizeBaseUrlPath(url.pathname);
  return url.toString().replace(/\/$/, '');
}
function boolean(value, label) { if (typeof value !== 'boolean') fail(label + '无效。'); return value; }
function providerAt(config, id) { return config.providers.find(provider => provider.id === id) || fail('该供应商已不存在，请刷新。'); }

// Merges a raw /models item with the models.dev index entry into the stored
// model shape. re-import/refresh recomputes all metadata fields.
function mergeModel(provider, item, index) {
  const merged = mergeMetadata(item.id, item, lookup(index, item.id));
  return { id: item.id, label: merged.label || provider.name + ' · ' + item.id,
    contextWindow: merged.contextWindow, maxOutputTokens: merged.maxOutputTokens,
    efforts: merged.efforts ?? modelEfforts({ id: item.id }),
    supportsImages: merged.supportsImages, meta: merged.meta };
}

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
.row { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
</style></head><body>
<h1 style="font-size:17px">Devin Model Picker：设置</h1>
<label style="font-size:13px"><input type="checkbox" id="enabled"> 启用 BYOK 模型接入</label>
<h2>供应商</h2>
<div id="providers"></div>
<button id="add">添加供应商</button>
<dialog id="editor"><h2 id="editor-title">供应商</h2>
<label class="field">名称</label><input type="text" id="f-name">
<label class="field">API 地址</label><input type="text" id="f-url" placeholder="https://api.example.com/v1">
<div class="muted" id="f-url-preview"></div>
<label class="field">密钥（留空保持不变）</label><input type="password" id="f-key" autocomplete="off">
<label class="field">接口类型</label><select id="f-format"><option value="openai">OpenAI 对话</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic</option></select>
<div class="error" id="f-error"></div>
<div class="row"><button class="secondary" id="f-cancel">取消</button><button id="f-save">保存</button></div>
</dialog>
<dialog id="importer"><h2>导入模型</h2>
<input type="text" id="i-search" placeholder="搜索模型…">
<div class="checklist" id="i-list"></div>
<div class="muted" id="i-status"></div>
<div class="error" id="i-error"></div>
<div class="row"><button class="secondary" id="i-cancel">取消</button><button id="i-save">导入所选</button></div>
</dialog>
<script nonce="__NONCE__">
const vscode = acquireVsCodeApi();
const normalizeBaseUrlPath = __NORMALIZE__;
let state = { enabled: true, providers: [] };
let pendingImport = null;
let editing = null;
const $ = id => document.getElementById(id);
function post(op, payload) { vscode.postMessage({ op, payload }); }
function td(parent, text) { const el = document.createElement('td'); el.textContent = text; parent.appendChild(el); return el; }
function btn(text, cls, onclick) { const b = document.createElement('button'); b.textContent = text; if (cls) b.className = cls; b.onclick = onclick; return b; }
function render() {
  $('enabled').checked = state.enabled;
  const host = $('providers'); host.textContent = '';
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
    head.appendChild(btn('导入模型', '', () => post('discover', { providerId: p.id })));
    head.appendChild(btn('刷新元数据', 'secondary', () => post('refreshMeta', { providerId: p.id })));
    head.appendChild(btn('删除', 'secondary', () => { if (confirm('删除供应商「' + p.name + '」及其全部模型？')) post('deleteProvider', { id: p.id }); }));
    card.appendChild(head);
    if (p.models.length) {
      const table = document.createElement('table');
      const hr = document.createElement('tr'); ['模型', '上下文', '输出', '档位', '图片', '来源', ''].forEach(h => { const th = document.createElement('th'); th.textContent = h; hr.appendChild(th); });
      table.appendChild(hr);
      for (const m of p.models) {
        const tr = document.createElement('tr');
        const name = td(tr, ''); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = m.enabled;
        cb.onchange = () => post('setModelEnabled', { providerId: p.id, modelId: m.id, enabled: cb.checked });
        name.appendChild(cb); name.appendChild(document.createTextNode(' ' + m.label));
        td(tr, String(m.contextWindow || ''));
        td(tr, String(m.maxOutputTokens || ''));
        td(tr, (m.efforts || []).map(e => e === null ? '默认' : e).join(', '));
        td(tr, m.supportsImages ? '是' : '否');
        td(tr, m.source || '');
        const ops = td(tr, ''); ops.appendChild(btn('移除', 'secondary', () => post('removeModel', { providerId: p.id, modelId: m.id })));
        table.appendChild(tr);
      }
      card.appendChild(table);
    } else {
      const empty = document.createElement('div'); empty.className = 'muted'; empty.textContent = '尚未导入模型，点击“导入模型”获取列表。'; card.appendChild(empty);
    }
    host.appendChild(card);
  }
}
function openEditor(p) {
  editing = p || null;
  $('editor-title').textContent = p ? '编辑供应商' : '添加供应商';
  $('f-name').value = p ? p.name : '';
  $('f-url').value = p ? p.baseUrl : '';
  $('f-key').value = ''; $('f-key').placeholder = p && p.keyConfigured ? '已配置，留空保持不变' : '';
  $('f-format').value = p ? p.apiFormat : 'openai';
  $('f-error').textContent = ''; previewUrl();
  $('editor').showModal();
}
function previewUrl() {
  try {
    const u = new URL($('f-url').value);
    u.pathname = normalizeBaseUrlPath(u.pathname);
    $('f-url-preview').textContent = '请求地址：' + u.toString().replace(/\\/$/, '') + '/chat/completions';
  } catch { $('f-url-preview').textContent = ''; }
}
function renderImport() {
  const list = $('i-list'); list.textContent = '';
  const filter = $('i-search').value.toLowerCase();
  for (const m of pendingImport.models) {
    if (filter && !(m.id.toLowerCase().includes(filter) || m.label.toLowerCase().includes(filter))) continue;
    const label = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = m.id;
    cb.checked = !m.imported; cb.disabled = m.imported;
    label.appendChild(cb);
    const info = document.createElement('span');
    info.textContent = m.label + '  ·  ' + m.contextWindow + ' ctx  ·  ' + (m.efforts || []).map(e => e === null ? '默认' : e).join(',') + (m.imported ? '  （已导入）' : '');
    label.appendChild(info);
    list.appendChild(label);
  }
}
$('add').onclick = () => openEditor(null);
$('enabled').onchange = () => post('setEnabled', { enabled: $('enabled').checked });
$('f-url').oninput = previewUrl;
$('f-cancel').onclick = () => $('editor').close();
$('f-save').onclick = () => post('saveProvider', { id: editing ? editing.id : undefined, name: $('f-name').value, baseUrl: $('f-url').value, apiKey: $('f-key').value || undefined, apiFormat: $('f-format').value });
$('i-cancel').onclick = () => $('importer').close();
$('i-search').oninput = renderImport;
$('i-save').onclick = () => {
  const ids = [...$('i-list').querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
  post('importModels', { providerId: pendingImport.providerId, token: pendingImport.token, ids });
};
window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.type === 'state') { state = msg.state; render(); }
  if (msg.type === 'import') { pendingImport = msg; $('i-error').textContent = ''; $('i-status').textContent = '共 ' + msg.models.length + ' 个模型'; $('i-search').value = ''; renderImport(); $('importer').showModal(); }
  if (msg.type === 'close') { $('editor').close(); $('importer').close(); }
  if (msg.type === 'error') { if ($('editor').open) $('f-error').textContent = msg.message; else if ($('importer').open) $('i-error').textContent = msg.message; }
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
  const signature = provider => JSON.stringify([provider.id, provider.baseUrl, provider.apiFormat, provider.apiKey]);
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
          config.enabled = boolean(payload.enabled, '启用状态');
          write(config); await changed(); return;
        case 'saveProvider': {
          const existing = payload.id ? providerAt(config, payload.id) : null;
          const name = text(payload.name, '供应商名称', 80), url = baseUrl(payload.baseUrl);
          if (!['openai-responses', 'openai', 'anthropic'].includes(payload.apiFormat)) fail('请选择 API 类型。');
          if (payload.apiKey !== undefined && (typeof payload.apiKey !== 'string' || payload.apiKey.length > 8192 || /[\r\n]/.test(payload.apiKey))) fail('API Key 无效。');
          const apiKey = payload.apiKey?.trim() || existing?.apiKey || '';
          if (existing) {
            const previousName = existing.name;
            Object.assign(existing, { name, baseUrl: url, apiFormat: payload.apiFormat, apiKey });
            if (name !== previousName) for (const model of existing.models) if (model.label?.startsWith(previousName + ' · ')) model.label = name + model.label.slice(previousName.length);
          } else config.providers.push({ id: 'provider-' + crypto.randomUUID(), name, baseUrl: url, apiFormat: payload.apiFormat, apiKey, enabled: true, models: [] });
          write(config); try { panel.webview.postMessage({ type: 'close' }); } catch {}
          await changed(); return;
        }
        case 'deleteProvider':
          providerAt(config, payload.id);
          config.providers = config.providers.filter(p => p.id !== payload.id);
          write(config); await changed(); return;
        case 'setProviderEnabled':
          providerAt(config, payload.id).enabled = boolean(payload.enabled, '启用状态');
          write(config); await changed(); return;
        case 'setModelEnabled': {
          const model = providerAt(config, payload.providerId).models.find(m => m.id === payload.modelId) || fail('该模型已不存在。');
          model.enabled = boolean(payload.enabled, '启用状态');
          write(config); await changed(); return;
        }
        case 'removeModel': {
          const provider = providerAt(config, payload.providerId);
          provider.models = provider.models.filter(m => m.id !== payload.modelId);
          write(config); await changed(); return;
        }
        case 'discover': {
          const provider = providerAt(config, payload.providerId);
          const items = await discover(provider);
          const index = await modelsDevIndex();
          const merged = items.map(item => mergeModel(provider, item, index));
          // Validate a private candidate catalog without changing saved models.
          buildCatalog({ ...config, providers: [{ ...provider, enabled: true, models: merged.map(m => ({ ...m, enabled: true })) }] });
          pending = { providerId: provider.id, signature: signature(provider), token: crypto.randomUUID(), models: merged };
          panel.webview.postMessage({ type: 'import', providerId: provider.id, token: pending.token,
            models: merged.map(m => ({ id: m.id, label: m.label, contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens,
              efforts: m.efforts, supportsImages: m.supportsImages, source: m.meta.source,
              imported: provider.models.some(existing => existing.id === m.id) })) });
          return;
        }
        case 'importModels': {
          const provider = providerAt(config, payload.providerId);
          if (!pending || pending.providerId !== provider.id || pending.token !== payload.token || pending.signature !== signature(provider)) fail('模型列表已失效，请重新获取后选择。');
          if (!Array.isArray(payload.ids) || payload.ids.some(id => typeof id !== 'string') || new Set(payload.ids).size !== payload.ids.length) fail('请选择要导入的模型。');
          const candidates = new Map(pending.models.map(m => [m.id, m]));
          if (payload.ids.some(id => !candidates.has(id))) fail('所选模型不在获取的列表中，请重新选择。');
          const existing = new Set(provider.models.map(m => m.id));
          for (const id of payload.ids) {
            if (existing.has(id)) { const current = provider.models.find(m => m.id === id); Object.assign(current, candidates.get(id), { enabled: current.enabled }); }
            else provider.models.push({ ...candidates.get(id), enabled: true });
          }
          write(config); pending = null;
          try { panel.webview.postMessage({ type: 'close' }); } catch {}
          await changed(); return;
        }
        case 'refreshMeta': {
          const provider = providerAt(config, payload.providerId);
          const items = await discover(provider);
          const index = await modelsDevIndex();
          const byId = new Map(items.map(item => [item.id, item]));
          for (const model of provider.models) {
            const merged = mergeModel(provider, byId.get(model.id) || { id: model.id }, index);
            Object.assign(model, { label: merged.label, contextWindow: merged.contextWindow,
              maxOutputTokens: merged.maxOutputTokens, efforts: merged.efforts,
              supportsImages: merged.supportsImages, meta: merged.meta });
          }
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
