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
    const natives = [
      model('swe-1p6', 'SWE-1.6', { provider: 'windsurf', isDefaultModelInFamily: true, ...fam('fam-swe16', 'SWE-1.6', {}) }),
      model('swe-1p7-medium', 'SWE-1.7 Medium', { provider: 'windsurf', ...fam('fam-swe17', 'SWE-1.7', effort(2, 'Medium')) }),
      model('swe-2-flash', 'SWE-2 Flash', { provider: 'windsurf', modelCost: { type: 'free' }, ...fam('fam-swe2', 'SWE-2', effort(1, 'Flash')) }),
      model('swe-2-high', 'SWE-2 High', { provider: 'windsurf', isDefaultModelInFamily: true, ...fam('fam-swe2', 'SWE-2', effort(3, 'High')) }),
      model('swe-2-max', 'SWE-2 Max', { provider: 'windsurf', ...fam('fam-swe2', 'SWE-2', effort(5, 'Max')) }),
      model('claude-opus-5-5-low', 'Claude Opus 5.5 Low', { provider: 'anthropic', ...fam('fam-opus', 'Claude Opus 5.5', effort(1, 'Low')) }),
      model('claude-opus-5-5-medium', 'Claude Opus 5.5 Medium', { provider: 'anthropic', isDefaultModelInFamily: true, ...fam('fam-opus', 'Claude Opus 5.5', effort(2, 'Medium')) }),
      model('claude-opus-5-5-high', 'Claude Opus 5.5 High', { provider: 'anthropic', ...fam('fam-opus', 'Claude Opus 5.5', effort(3, 'High')) }),
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
    const leads = [
      ...Object.values(byok).map(e => ({ ref: { kind: 'byok', uid: e.uid }, label: e.label.replace(/^.*? · /, ''), providerName: e.providerName, effort: e.effort, familyKey: 'byok:' + e.providerId + ':' + e.modelId })),
      { ref: { kind: 'native', uid: 'claude-opus-5-5-high' }, label: 'Claude Opus 5.5 High', providerName: 'Devin', effort: null, familyKey: 'fam-opus' },
      { ref: { kind: 'native', uid: 'swe-2-high' }, label: 'SWE-2 High', providerName: 'Devin', effort: null, familyKey: 'fam-swe2' },
    ];
    const sidekicks = [
      ...Object.values(byok).map(e => ({ ref: { kind: 'byok', uid: e.uid }, label: e.label.replace(/^.*? · /, ''), providerName: e.providerName, effort: e.effort, familyKey: 'byok:' + e.providerId + ':' + e.modelId })),
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
        provider.models.push({ id: entry.modelId, label: entry.providerName + ' · ' + entry.modelId });
      }
    }
    window.DMP_DISCOVER_MODELS = window.DMP_DISCOVER_MODELS || [
      { id: 'harness-alpha', label: 'Harness Alpha', contextWindow: 256000, efforts: [null, 'high'], supportsImages: true },
      { id: 'harness-beta', label: 'Harness Beta', contextWindow: 128000, efforts: [null, 'medium', 'high'] },
      { id: 'harness-gamma', label: 'Harness Gamma', contextWindow: 64000, efforts: [null] },
    ];
    const publicProviders = () => ({
      providers: fakeProviders.map(({ apiKey, ...rest }) => ({ ...rest, keyConfigured: !!apiKey })),
    });
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
      if (path.endsWith('/picker/providers/discover')) {
        const body = JSON.parse(options.body || '{}');
        const provider = fakeProviders.find(item => item.id === body.id);
        if (!provider) return bad('该供应商已不存在。');
        return ok({ token: 'harness-token', models: window.DMP_DISCOVER_MODELS.map(model => ({
          ...model, imported: provider.models.some(item => item.id === model.id) })) });
      }
      if (path.endsWith('/picker/providers/import')) {
        const body = JSON.parse(options.body || '{}');
        const provider = fakeProviders.find(item => item.id === body.id);
        if (!provider) return bad('该供应商已不存在。');
        for (const id of body.ids || []) {
          const discovered = window.DMP_DISCOVER_MODELS.find(item => item.id === id);
          if (!discovered) continue;
          if (!provider.models.some(item => item.id === id)) {
            provider.models.push({ id, label: provider.name + ' · ' + id });
            const uid = 'dmp-' + provider.id + '-' + id + '-0';
            effectiveState.byok[uid] = { uid, providerId: provider.id, providerName: provider.name,
              modelId: id, label: provider.name + ' · ' + discovered.label, effort: null, efforts: discovered.efforts };
            visibleModelConfigs.push({ modelUid: uid, label: provider.name + ' · ' + discovered.label,
              familyUid: 'dmp-fam-' + provider.id + '-' + id, familyLabel: discovered.label });
          }
        }
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
  window.DMP_FIBER = root => {
    const selected = [];
    const log = document.getElementById('dmp-harness-log');
    const hostProps = {
      open: false, onOpenChange() {}, visibleModelConfigs: root.visibleModelConfigs,
      selectedModels: [], recentlyUsedModels: [], modelSorts: [],
      onModelSelect(payload) {
        selected.push(payload);
        if (log) log.textContent += '\nonModelSelect ' + JSON.stringify(payload);
        button.querySelector('[data-label]').textContent = payload.modelUid;
        pickerProps.value = payload.modelUid;
      },
    };
    const pickerProps = { connectorId: 'c', modelConfig: {}, value: 'swe-2-high', onSelect() {}, disabled: false, onClose() {} };
    const chain = {
      memoizedProps: { label: 'SWE-2', tooltip: '', open: false, onOpenChange() {} },
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
    return { button, hostProps, pickerProps, selected };
  };
})();
