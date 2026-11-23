// Dev harness fixture: fake React fiber chain + picker API stubs for
// media/picker.js. Load order: fixture.js → picker.js.
'use strict';
(() => {
  const model = (uid, label, extra = {}) => ({ modelUid: uid, label, ...extra });
  const fam = (uid, label, entries) => ({ familyUid: uid, familyLabel: label, familyMetadata: entries });
  const effort = (order, name) => ({ Effort: { order, name } });
  window.DMP_FIXTURE = (() => {
    const providers = [{ id: 'magpie', name: 'Magpie' }, { id: 'relay', name: 'Relay' }];
    const mk = (pid, mid, label, effort, i) => ({
      uid: 'dmp-' + pid + '-' + mid + '-' + i, providerId: pid, providerName: providers.find(p => p.id === pid).name,
      modelId: mid, label: providers.find(p => p.id === pid).name + ' · ' + label + (effort ? ' ' + effort[0].toUpperCase() + effort.slice(1) : ''), effort });
    const byok = {};
    const byokModels = [];
    let seq = 0;
    const addByok = (pid, mid, label, efforts) => {
      for (const eff of efforts) {
        const entry = mk(pid, mid, label, eff, seq++);
        byok[entry.uid] = entry;
        byokModels.push(model(entry.uid, entry.label, { familyUid: 'dmp-fam-' + pid + '-' + mid }));
      }
    };
    addByok('magpie', 'claude-opus-5-5', 'Claude Opus 5.5', [null, 'low', 'medium', 'high', 'xhigh', 'max']);
    addByok('relay', 'claude-opus-5-5', 'Claude Opus 5.5', [null, 'high']);
    addByok('magpie', 'gpt-6-1-terra', 'GPT-6.1 Terra', [null, 'high']);
    addByok('magpie', 'deepseek-v4-pro', 'DeepSeek V4 Pro', [null, 'high']);
    addByok('magpie', 'kimi-k3', 'Kimi K3', [null]);
    addByok('magpie', 'glm-5-3', 'GLM-5.3', [null, 'high']);
    // Host `costs` metrics on the native Opus family — the card must render
    // the explicit price line (and hide its '1x' multiplier chip).
    const opusCosts = [
      { label: 'Input', value: 5, denominator: '1M tokens' },
      { label: 'Cached Input', value: 0.5, denominator: '1M tokens' },
      { label: 'Output', value: 25, denominator: '1M tokens' },
      { label: 'Effort', text: 'Higher effort consumes more tokens' },
    ];
    const natives = [
      model('swe-1p6', 'SWE-1.6', { provider: 'windsurf', isDefaultModelInFamily: true, ...fam('fam-swe16', 'SWE-1.6', {}) }),
      model('swe-1p7-medium', 'SWE-1.7 Medium', { provider: 'windsurf', ...fam('fam-swe17', 'SWE-1.7', effort(2, 'Medium')) }),
      model('swe-2-flash', 'SWE-2 Flash', { provider: 'windsurf', modelCost: { type: 'free' }, ...fam('fam-swe2', 'SWE-2', effort(1, 'Flash')) }),
      model('swe-2-high', 'SWE-2 High', { provider: 'windsurf', isDefaultModelInFamily: true,
        modelCost: { type: 'credit', multiplier: 1 }, ...fam('fam-swe2', 'SWE-2', effort(3, 'High')) }),
      model('swe-2-max', 'SWE-2 Max', { provider: 'windsurf',
        modelCost: { type: 'credit', multiplier: 2.5 }, ...fam('fam-swe2', 'SWE-2', effort(5, 'Max')) }),
      model('claude-opus-5-5-low', 'Claude Opus 5.5 Low', { provider: 'anthropic', costs: opusCosts,
        modelCost: { type: 'credit', multiplier: 0.5 }, ...fam('fam-opus', 'Claude Opus 5.5', effort(1, 'Low')) }),
      model('claude-opus-5-5-medium', 'Claude Opus 5.5 Medium', { provider: 'anthropic', isDefaultModelInFamily: true,
        costs: opusCosts, modelCost: { type: 'credit', multiplier: 1 }, ...fam('fam-opus', 'Claude Opus 5.5', effort(2, 'Medium')) }),
      model('claude-opus-5-5-high', 'Claude Opus 5.5 High', { provider: 'anthropic', costs: opusCosts,
        modelCost: { type: 'credit', multiplier: 2.5 }, ...fam('fam-opus', 'Claude Opus 5.5', effort(3, 'High')) }),
      model('muse-wonder-high', 'Muse Wonder High', { provider: 'xai', ...fam('fam-muse', 'Muse Wonder', effort(3, 'High')) }),
      model('nemotron-3-5-lightning', 'Nemotron 3.5 Lightning', { provider: 'nvidia', ...fam('fam-nemo', 'Nemotron 3.5', effort(1, 'Lightning')) }),
      model('gemini-4-argon', 'Gemini 4 Argon', { provider: 'google', ...fam('fam-gem4', 'Gemini 4', effort(1, 'Argon')) }),
      model('locked-model', 'Locked Enterprise', { provider: 'google', disabled: true, disabledReason: '需要团队版订阅', ...fam('fam-lock', 'Locked', {}) }),
    ];
    const fusionEntry = model('fusion-claude-opus-5-5-high-sidekick-swe-2-high',
      'Fusion (Claude Opus 5.5 High + SWE-2 High)', {
        displayOption: 'model-router', provider: 'windsurf',
        familyMetadata: { Lead: { order: 3, name: 'Claude Opus 5.5 High' }, Effort: { order: 3, name: 'High' }, Sidekick: { order: 3, name: 'SWE-2 High' } },
      });
    const dmpFusions = [
      model('fusion-dmp-a', 'BYOK Fusion', { displayOption: 'model-router', provider: 'windsurf', familyMetadata: {} }),
      model('fusion-dmp-b', 'BYOK Fusion', { displayOption: 'model-router', provider: 'windsurf', familyMetadata: {} }),
    ];
    const visibleModelConfigs = window.DMP_VMC_OVERRIDE || [...byokModels, ...natives, fusionEntry, ...dmpFusions];
    const cand = e => ({ ref: { kind: 'byok', uid: e.uid }, label: e.label.replace(/^.*? · /, ''), providerName: e.providerName, effort: e.effort, familyKey: 'byok:' + e.providerId + ':' + e.modelId });
    const leads = [
      ...Object.values(byok).map(cand),
      { ref: { kind: 'native', uid: 'claude-opus-5-5-high' }, label: 'Claude Opus 5.5 High', providerName: 'Devin', effort: null, familyKey: 'fam-opus' },
      { ref: { kind: 'native', uid: 'swe-2-high' }, label: 'SWE-2 High', providerName: 'Devin', effort: null, familyKey: 'fam-swe2' },
    ];
    const sidekicks = [
      ...Object.values(byok).map(cand),
      { ref: { kind: 'native', uid: 'swe-2-high' }, label: 'SWE-2 High', providerName: 'Devin', effort: null, familyKey: 'fam-swe2' },
      { ref: { kind: 'native', uid: 'swe-2-max' }, label: 'SWE-2 Max', providerName: 'Devin', effort: null, familyKey: 'fam-swe2' },
    ];
    const state = { version: '0.1.0', enabled: true, byok,
      fusionSlots: { a: { lead: { kind: 'byok', uid: leads[3].ref.uid, label: leads[3].label }, sidekick: { kind: 'native', uid: 'swe-2-high', label: 'SWE-2 High' } } },
      fusionCandidates: { leads, sidekicks } };
    let slotToggle = 'a';
    const effectiveState = window.DMP_STATE_OVERRIDE || state;
    effectiveState.byok = effectiveState.byok || {};
    // Fake provider store backing /picker/providers* — mirrors the backend API.
    const fakeProviders = window.DMP_FAKE_PROVIDERS = window.DMP_FAKE_PROVIDERS || [];
    for (const entry of Object.values(effectiveState.byok || {})) {
      let provider = fakeProviders.find(item => item.id === entry.providerId);
      if (!provider) {
        provider = { id: entry.providerId, name: entry.providerName,
          baseUrl: 'https://' + entry.providerId + '.invalid/v1', apiFormat: 'openai',
          apiKey: 'sk-' + entry.providerId, models: [] };
        fakeProviders.push(provider);
      }
      if (!provider.models.some(item => item.id === entry.modelId)) {
        provider.models.push({ id: entry.modelId, label: entry.providerName + ' · ' + entry.modelId, enabled: true });
      }
    }
    // Fake gateway with ~200 models — the renderer connects to it with only URL + key.
    window.DMP_GATEWAY_MODELS = window.DMP_GATEWAY_MODELS || Array.from({ length: 200 }, (_, i) => ({
      id: 'gw-model-' + String(i + 1).padStart(3, '0'),
      label: 'Gateway Model ' + (i + 1),
      contextWindow: 128000,
      efforts: i % 7 === 0 ? [null, 'high'] : [null],
      supportsImages: i % 11 === 0,
    }));
    const providerView = provider => ({
      id: provider.id, name: provider.name, baseUrl: provider.baseUrl,
      apiFormat: provider.apiFormat, keyConfigured: !!provider.apiKey,
      models: provider.models.map(model => ({ id: model.id, label: model.label,
        enabled: model.enabled !== false, contextWindow: model.contextWindow,
        efforts: model.efforts, supportsImages: model.supportsImages === true,
        missing: model.missing === true })),
    });
    const publicProviders = () => ({
      providers: fakeProviders.map(provider => providerView(provider)),
    });
    // Rebuild this provider's byok/visibleModelConfigs entries from enabled models,
    // mimicking the host re-reading config.json after a write.
    const syncByok = provider => {
      for (const uid of Object.keys(effectiveState.byok)) {
        if (effectiveState.byok[uid].providerId === provider.id) delete effectiveState.byok[uid];
      }
      for (let i = visibleModelConfigs.length - 1; i >= 0; i--) {
        if (String(visibleModelConfigs[i].modelUid).startsWith('dmp-' + provider.id + '-')) visibleModelConfigs.splice(i, 1);
      }
      for (const model of provider.models) {
        if (model.enabled === false) continue;
        const efforts = model.efforts && model.efforts.length ? model.efforts : [null];
        for (let i = 0; i < efforts.length; i++) {
          const uid = 'dmp-' + provider.id + '-' + model.id + '-' + i;
          const label = provider.name + ' · ' + model.label
            + (efforts[i] ? ' ' + efforts[i][0].toUpperCase() + efforts[i].slice(1) : '');
          effectiveState.byok[uid] = { uid, providerId: provider.id, providerName: provider.name,
            modelId: model.id, label, effort: efforts[i], efforts: model.efforts };
          visibleModelConfigs.push({ modelUid: uid, label,
            familyUid: 'dmp-fam-' + provider.id + '-' + model.id, familyLabel: model.label });
        }
      }
    };
    const ok = body => new Response(JSON.stringify(body), { status: 200 });
    const bad = message => new Response(JSON.stringify({ error: 'invalid_input', message }), { status: 400 });
    window.fetch = async (url, options = {}) => {
      const path = String(url);
      if (path.endsWith('/picker/state')) return ok(effectiveState);
      if (path.endsWith('/picker/fusion')) {
        const body = JSON.parse(options.body || '{}');
        const log = document.getElementById('dmp-harness-log');
        if (log) log.textContent += '\nPOST /picker/fusion ' + JSON.stringify(body);
        slotToggle = slotToggle === 'a' ? 'b' : 'a';
        return ok({ uid: 'fusion-dmp-' + slotToggle });
      }
      if (path.endsWith('/picker/providers') && (options.method || 'GET') === 'GET') return ok(publicProviders());
      if (path.endsWith('/picker/providers/save')) {
        const body = JSON.parse(options.body || '{}');
        if (!body.name || !body.baseUrl) return bad('请填写名称和 API 地址。');
        if (body.id) {
          const provider = fakeProviders.find(item => item.id === body.id);
          if (!provider) return bad('该供应商已不存在。');
          Object.assign(provider, { name: body.name, baseUrl: body.baseUrl, apiFormat: body.apiFormat });
          if (body.apiKey) provider.apiKey = body.apiKey;
          return ok({ id: provider.id });
        }
        const provider = { id: 'prov-' + (fakeProviders.length + 1), name: body.name,
          baseUrl: body.baseUrl, apiFormat: body.apiFormat, apiKey: body.apiKey || '', models: [] };
        fakeProviders.push(provider);
        return ok({ id: provider.id });
      }
      if (path.endsWith('/picker/providers/connect')) {
        const body = JSON.parse(options.body || '{}');
        if (!body.baseUrl || !body.apiKey) return bad('请填写 API 地址和 API Key。');
        if (String(body.baseUrl).includes('bad-key')) return bad('API Key 无效。');
        let provider = body.id ? fakeProviders.find(item => item.id === body.id) : null;
        if (body.id && !provider) return bad('该供应商已不存在。');
        const host = String(body.baseUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '')
          .replace(/^(api|www)\./, '') || 'gateway';
        if (!provider) {
          provider = { id: 'prov-' + (fakeProviders.length + 1), name: host,
            baseUrl: body.baseUrl, apiFormat: 'openai-responses', apiKey: body.apiKey, models: [] };
          fakeProviders.push(provider);
        } else {
          provider.baseUrl = body.baseUrl;
          provider.apiKey = body.apiKey;
        }
        const upstream = new Set(window.DMP_GATEWAY_MODELS.map(model => model.id));
        for (const model of window.DMP_GATEWAY_MODELS) {
          const existing = provider.models.find(item => item.id === model.id);
          if (existing) { existing.missing = false; continue; }
          provider.models.push({ ...model, enabled: false, missing: false });
        }
        for (const model of provider.models) {
          if (upstream.has(model.id)) continue;
          if (model.enabled === false) model.dead = true; else model.missing = true;
        }
        provider.models = provider.models.filter(model => !model.dead);
        syncByok(provider);
        return ok({ provider: providerView(provider) });
      }
      if (path.endsWith('/picker/providers/refresh')) {
        const body = JSON.parse(options.body || '{}');
        const provider = fakeProviders.find(item => item.id === body.id);
        if (!provider) return bad('该供应商已不存在。');
        const upstream = new Set(window.DMP_GATEWAY_MODELS.map(model => model.id));
        for (const model of window.DMP_GATEWAY_MODELS) {
          const existing = provider.models.find(item => item.id === model.id);
          if (existing) { existing.missing = false; continue; }
          provider.models.push({ ...model, enabled: false, missing: false });
        }
        for (const model of provider.models) {
          if (upstream.has(model.id)) continue;
          if (model.enabled === false) model.dead = true; else model.missing = true;
        }
        provider.models = provider.models.filter(model => !model.dead);
        syncByok(provider);
        return ok({ provider: providerView(provider) });
      }
      if (path.endsWith('/picker/providers/update')) {
        const body = JSON.parse(options.body || '{}');
        const provider = fakeProviders.find(item => item.id === body.id);
        if (!provider) return bad('该供应商已不存在。');
        if (body.name) provider.name = body.name;
        if (body.apiFormat) provider.apiFormat = body.apiFormat;
        if (body.apiKey) provider.apiKey = body.apiKey;
        syncByok(provider);
        return ok({ provider: providerView(provider) });
      }
      if (path.endsWith('/picker/models/enabled')) {
        const body = JSON.parse(options.body || '{}');
        const provider = fakeProviders.find(item => item.id === body.providerId);
        if (!provider) return bad('该供应商已不存在。');
        if (!Array.isArray(body.modelIds) || typeof body.enabled !== 'boolean') return bad('参数无效。');
        for (const id of body.modelIds) {
          const model = provider.models.find(item => item.id === id);
          if (model) model.enabled = body.enabled;
        }
        syncByok(provider);
        return ok({ ok: true });
      }
      if (path.endsWith('/picker/providers/discover')) {
        const body = JSON.parse(options.body || '{}');
        const provider = fakeProviders.find(item => item.id === body.id);
        if (!provider) return bad('该供应商已不存在。');
        return ok({ token: 'harness-token', models: [] });
      }
      if (path.endsWith('/picker/providers/import')) {
        return ok({ ok: true });
      }
      if (path.endsWith('/picker/providers/delete')) {
        const body = JSON.parse(options.body || '{}');
        const index = fakeProviders.findIndex(item => item.id === body.id);
        if (index < 0) return bad('该供应商已不存在。');
        fakeProviders.splice(index, 1);
        for (const uid of Object.keys(effectiveState.byok)) {
          if (effectiveState.byok[uid].providerId === body.id) delete effectiveState.byok[uid];
        }
        for (let i = visibleModelConfigs.length - 1; i >= 0; i--) {
          if (effectiveState.byok[visibleModelConfigs[i].modelUid] === undefined && String(visibleModelConfigs[i].modelUid).startsWith('dmp-')) visibleModelConfigs.splice(i, 1);
        }
        return ok({ ok: true });
      }
      if (path.endsWith('/picker/models/remove')) {
        const body = JSON.parse(options.body || '{}');
        const provider = fakeProviders.find(item => item.id === body.providerId);
        if (!provider) return bad('该供应商已不存在。');
        provider.models = provider.models.filter(item => item.id !== body.modelId);
        for (const uid of Object.keys(effectiveState.byok)) {
          const entry = effectiveState.byok[uid];
          if (entry.providerId === body.providerId && entry.modelId === body.modelId) delete effectiveState.byok[uid];
        }
        for (let i = visibleModelConfigs.length - 1; i >= 0; i--) {
          if (String(visibleModelConfigs[i].modelUid).startsWith('dmp-' + body.providerId + '-' + body.modelId)) visibleModelConfigs.splice(i, 1);
        }
        return ok({ ok: true });
      }
      return new Response('{}', { status: 404 });
    };
    return { visibleModelConfigs, state: effectiveState };
  })();

  // Fake React fiber chain: button → trigger wrapper → host → LocalModelPicker.
  // The trigger also behaves like the real component: pointer/click/keyboard
  // events that reach it open a native menu, portaled to <body> with the
  // picker's own root props on its fiber chain.
  window.DMP_FIBER = root => {
    const selected = [];
    const log = document.getElementById('dmp-harness-log');
    let menuEl = null;
    const setOpen = open => {
      if (open && !menuEl) {
        menuEl = document.createElement('div');
        menuEl.setAttribute('role', 'menu');
        menuEl.setAttribute('data-native-menu', '');
        for (const cfg of (root.visibleModelConfigs || []).slice(0, 8)) {
          const item = document.createElement('button');
          item.setAttribute('role', 'menuitem');
          item.textContent = cfg.label || cfg.modelUid;
          item.addEventListener('click', event => {
            event.stopPropagation();
            hostProps.onModelSelect({ modelUid: cfg.modelUid });
            try { pickerProps.onSelect?.(); } catch {}
            setOpen(false);
          });
          menuEl.appendChild(item);
        }
        // Portal fiber: the menu element's chain carries the same rootPicker
        // props object the trigger resolves to — the real render shares it.
        const menuProps = { role: 'menu' };
        menuEl.__reactFiber$menu = { memoizedProps: menuProps, alternate: null,
          return: { memoizedProps: pickerProps, return: null } };
        menuEl.__reactProps$menu = menuProps;
        document.body.appendChild(menuEl);
      } else if (!open && menuEl) {
        menuEl.remove();
        menuEl = null;
      }
    };
    const hostProps = {
      open: false, onOpenChange: setOpen, visibleModelConfigs: root.visibleModelConfigs,
      // Mirrors Devin's getCostTag(model) → { label, tooltip }: credit
      // multiplier → 'Nx', free → 'free', BYOK → 'API' (a tripwire — the
      // renderer must never ask for a BYOK tag), none → null.
      getCostTag(model) {
        if (String(model?.modelUid || '').startsWith('dmp-')) return { label: 'API', tooltip: 'BYOK 供应商' };
        const cost = model?.modelCost;
        if (!cost) return null;
        if (cost.type === 'free' || cost.tier === 'free') return { label: 'free', tooltip: 'Devin Credits：免费' };
        if (typeof cost.multiplier === 'number') return { label: (+cost.multiplier.toFixed(3)) + 'x', tooltip: 'Devin Credits：按量计费' };
        return null;
      },
      selectedModels: [], recentlyUsedModels: [], modelSorts: [],
      onModelSelect(payload) {
        selected.push(payload);
        if (log) log.textContent += '\nonModelSelect ' + JSON.stringify(payload);
        button.querySelector('[data-label]').textContent = payload.modelUid;
        pickerProps.value = payload.modelUid;
      },
    };
    const pickerProps = { connectorId: 'c', modelConfig: {}, value: 'swe-2-high',
      onSelect() {}, disabled: false, onClose: () => setOpen(false), onOpenChange: setOpen };
    const chain = {
      memoizedProps: { label: 'SWE-2', tooltip: '', open: false, onOpenChange: setOpen },
      return: { memoizedProps: hostProps, return: { memoizedProps: pickerProps, return: null } },
    };
    const button = document.createElement('button');
    button.setAttribute('aria-haspopup', 'menu');
    const span = document.createElement('span');
    span.setAttribute('data-label', '');
    span.textContent = 'SWE-2 High';
    button.appendChild(span);
    const domProps = { children: [] };
    button.__reactFiber$test = { memoizedProps: domProps, alternate: null, return: chain };
    button.__reactProps$test = domProps;
    button.__dmpSelectLog = selected;
    // The component's own listeners — reached only when our capture layer lets
    // the event through (Alt, classic view, or the replayed Alt sequence).
    button.addEventListener('click', () => setOpen(true));
    button.addEventListener('keydown', event => {
      if (['Enter', ' ', 'ArrowDown'].includes(event.key)) setOpen(true);
    });
    button.__dmpSetOpen = setOpen;
    button.__dmpHarness = { hostProps, pickerProps };
    return { button, hostProps, pickerProps, selected };
  };
})();
