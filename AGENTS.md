# Devin Model Picker

Plain CommonJS `.cjs` VS Code extension. No build step, no npm dependencies.

## Commands

```bash
npm test          # node --test test/*.test.cjs
npm run package   # node scripts/package.cjs → devin-model-picker-<version>.vsix
```

## Layout

- `src/extension.cjs` — activation: backend, LS/host-catalog injections, agentEnv receipt, commands
- `src/runtime/` — spawned backend (`backend.cjs`, port 39852), `bridge.cjs`, `ls-injection.cjs`, `acp-injection.cjs`, `host-catalog.cjs`, `native-models.cjs`, `picker-refresh.cjs`, `backend-env.cjs`
- `src/protocol/` — wire/chat/responses/anthropic codecs
- `src/catalog.cjs` — BYOK routes + `fusion-dmp-a`/`fusion-dmp-b` slots, `resolveAssignment`, `collectNativeModels`, `discoverOfficialRoles`
- `src/models-dev.cjs` — models.dev index/cache/merge (extension host side)
- `src/picker-api.cjs` — `/picker/state`, `/picker/fusion` (Origin `vscode-file://vscode-app` only)
- `src/inject.cjs` — workbench.html script injection + product.json checksums
- `src/settings.cjs` — settings webview (vanilla JS, strict CSP)
- `src/lifecycle/` — owned-settings receipt restore + `vscode:uninstall` hook
- `media/picker.js` — placeholder renderer script (real card UI is a later milestone)

## Invariants

- BYOK uids `dmp-*`, fusion uids `fusion-dmp-a|b`; secrets never appear in catalog or `/picker/*` responses; `/picker/providers` returns baseUrl without userinfo/query
- Backend re-reads `config.json` and rebuilds the catalog on every request
- Injection only ever touches our own tag/file; never modify the real Devin install in tests

## Releasing a VSIX for testing

Bump `version` in package.json before every VSIX handed to the user: reinstalling the same version does not overwrite the installed extension files.
