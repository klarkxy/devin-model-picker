# Captures high-DPI documentation screenshots into docs/images/ using Playwright
# and the live media/picker.js script against realistic native + BYOK fixtures.
import functools
import glob
import http.server
import os
import threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'docs', 'images')
os.makedirs(OUT_DIR, exist_ok=True)


def chromium_launch_kwargs():
    override = os.environ.get('DMP_CHROMIUM')
    if override:
        return {'executable_path': override}
    cand = sorted(
        glob.glob(r'T:/Caches/Playwright/chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe')
        + glob.glob(r'C:/Users/27837/AppData/Local/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe')
    )
    if cand:
        return {'executable_path': cand[-1]}
    return {}


DOCS_HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>devin-model-picker docs harness</title>
<style>
  body { margin:0; font:13px/1.5 -apple-system,"Segoe UI",sans-serif; }
  body.dmp-dark { background:rgb(20,20,20); color:#e7e9ec; }
  body.dmp-light { background:rgb(244,245,247); color:#1f2329; }
  #composer { position:fixed; left:5%; right:5%; bottom:28px; padding:14px 16px;
    background:rgba(255,255,255,.04); border:1px solid #8884; border-radius:12px;
    display:flex; align-items:center; gap:10px; }
  button[aria-haspopup="menu"] { border:1px solid #8886; background:transparent; color:inherit;
    border-radius:8px; padding:5px 12px; font-size:12px; cursor:pointer; }
  body.capture-clean #composer { opacity: 0; pointer-events: none; }
</style>
</head>
<body class="dmp-dark">
<div id="composer"></div>
<script src="/dev/real-data.js"></script>
<script>
(() => {
  const providers = [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiFormat: 'openai-responses',
      apiKey: 'sk-or-demo',
      models: [
        { id: 'claude-opus-5-5', label: 'OpenRouter · Claude Opus 5.5', enabled: true, contextWindow: 200000, efforts: [null, 'low', 'medium', 'high', 'max'], supportsImages: true },
        { id: 'gpt-5-6-codex', label: 'OpenRouter · GPT-5.6 Codex', enabled: true, contextWindow: 400000, efforts: [null, 'medium', 'high'], supportsImages: true },
        { id: 'qwen-3-coder', label: 'OpenRouter · Qwen 3 Coder', enabled: false, contextWindow: 128000, efforts: [null], supportsImages: false },
        { id: 'gemini-3-8-pro', label: 'OpenRouter · Gemini 3.8 Pro', enabled: false, contextWindow: 1000000, efforts: [null, 'high'], supportsImages: true },
      ],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiFormat: 'openai',
      apiKey: 'sk-ds-demo',
      models: [
        { id: 'deepseek-chat', label: 'DeepSeek · DeepSeek Chat', enabled: true, contextWindow: 128000, efforts: [null], supportsImages: false },
        { id: 'deepseek-reasoner', label: 'DeepSeek · DeepSeek Reasoner', enabled: true, contextWindow: 128000, efforts: [null, 'high'], supportsImages: false },
        { id: 'deepseek-coder', label: 'DeepSeek · DeepSeek Coder', enabled: false, contextWindow: 128000, efforts: [null], supportsImages: false },
      ],
    },
  ];
  window.DMP_FAKE_PROVIDERS = providers;
  const byok = {};
  const byokVmc = [];
  const byokCands = [];
  for (const prov of providers) {
    for (const m of prov.models) {
      if (!m.enabled) continue;
      const baseTitle = m.label.replace(/^.*? · /, '');
      const efforts = m.efforts && m.efforts.length ? m.efforts : [null];
      for (let i = 0; i < efforts.length; i++) {
        const eff = efforts[i];
        const uid = 'dmp-' + prov.id + '-' + m.id + '-' + i;
        const label = prov.name + ' · ' + baseTitle + (eff ? ' ' + eff[0].toUpperCase() + eff.slice(1) : '');
        byok[uid] = {
          uid,
          providerId: prov.id,
          providerName: prov.name,
          modelId: m.id,
          label,
          effort: eff,
          family: prov.name,
          contextWindow: m.contextWindow,
          supportsImages: m.supportsImages,
        };
        byokVmc.push({
          modelUid: uid,
          label,
          familyUid: 'dmp-fam-' + prov.id + '-' + m.id,
          familyLabel: baseTitle,
          supportsImages: m.supportsImages,
        });
        byokCands.push({
          ref: { kind: 'byok', uid },
          label,
          providerName: prov.name,
          effort: eff ? eff[0].toUpperCase() + eff.slice(1) : null,
          familyLabel: baseTitle,
          familyKey: 'byok:' + prov.id + ':' + m.id,
        });
      }
    }
  }
  const natives = window.DMP_VMC_OVERRIDE || [];
  window.DMP_VMC_OVERRIDE = [...natives, ...byokVmc];
  const st = window.DMP_STATE_OVERRIDE;
  st.byok = byok;
  st.fusionCandidates.leads = [...byokCands, ...st.fusionCandidates.leads];
  st.fusionCandidates.sidekicks = [...byokCands, ...st.fusionCandidates.sidekicks];
})();
</script>
<script src="/dev/fixture.js"></script>
<script>
(() => {
  const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
  document.body.className = theme === 'light' ? 'dmp-light' : 'dmp-dark';
  const fixture = window.DMP_FIXTURE;
  const holder = window.DMP_FIBER({ visibleModelConfigs: fixture.visibleModelConfigs });
  holder.pickerProps.value = 'claude-opus-5-5-medium';
  holder.button.querySelector('[data-label]').textContent = 'Claude Opus 5.5 Medium';
  document.getElementById('composer').appendChild(holder.button);
})();
</script>
<script src="/media/picker.js"></script>
</body>
</html>
"""


class DocsHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path.split('?')[0] == '/dev/docs-harness.html':
            body = DOCS_HTML.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def panel_clip(page, pad=14):
    box = page.locator('.dmp-panel').bounding_box()
    return {
        'x': max(0, box['x'] - pad),
        'y': max(0, box['y'] - pad),
        'width': box['width'] + pad * 2,
        'height': box['height'] + pad * 2,
    }


def main():
    server = http.server.HTTPServer(('127.0.0.1', 0), DocsHandler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{port}/dev/docs-harness.html'

    with sync_playwright() as pw:
        browser = pw.chromium.launch(**chromium_launch_kwargs())

        # 1. Dark theme shots: Single-Model, Context Menu, Fusion, Providers
        ctx = browser.new_context(viewport={'width': 1000, 'height': 820}, device_scale_factor=2)
        page = ctx.new_page()
        page.goto(base + '?theme=dark')
        page.wait_for_timeout(300)
        page.evaluate("""localStorage.setItem('devin-model-picker:v1', JSON.stringify({
          prefs: {
            order: ['opus|5.5|', 'deepseek||chat', 'gpt|5.6|codex', 'swe|2|', 'gemini|3.8|flash', 'kimi|3.1|pro', 'glm|5.3|', 'deepseek||reasoner', 'swe|2|flash'],
            favorites: ['deepseek||chat'],
            hidden: [],
            aliases: {}
          }
        }))""")
        page.reload()
        page.wait_for_timeout(300)
        page.click('#composer button[aria-haspopup="menu"]')
        page.wait_for_selector('.dmp-panel.dmp-open', timeout=3000)
        page.wait_for_timeout(350)
        # Blur filter input so no distracting focus ring sits on the search box in hero shots
        page.evaluate("document.activeElement?.blur(); document.body.classList.add('capture-clean');")
        page.wait_for_timeout(120)
        page.screenshot(path=os.path.join(OUT_DIR, 'picker-single-dark.png'), clip=panel_clip(page))

        # Context menu on DeepSeek V3.2 (first card) or GPT-5.6 Codex (BYOK card)
        page.locator('.dmp-card', has_text='Codex').first.click(button='right')
        page.wait_for_selector('.dmp-menu', timeout=2000)
        page.wait_for_timeout(150)
        page.screenshot(path=os.path.join(OUT_DIR, 'picker-context-menu.png'), clip=panel_clip(page))
        page.keyboard.press('Escape')
        page.wait_for_timeout(150)

        # Fusion tab: Lead = Claude Opus 5.5 Medium Fast (Devin), Sidekick = DeepSeek Chat (DeepSeek BYOK)
        page.locator('.dmp-seg button', has_text='Fusion').click()
        page.wait_for_timeout(300)
        page.locator('.dmp-slot').nth(1).click()
        page.wait_for_timeout(200)
        page.locator('.dmp-card', has_text='DeepSeek Chat').first.click()
        page.wait_for_timeout(200)
        page.locator('.dmp-slot').first.click()
        page.wait_for_timeout(200)
        page.locator('.dmp-card', has_text='Claude Opus 5.5 · Devin').first.click()
        page.wait_for_timeout(200)
        opus = page.locator('.dmp-card', has_text='Claude Opus 5.5 · Devin').first
        opus.locator('.dmp-eff button:text-is("M")').click()
        page.wait_for_timeout(200)
        opus = page.locator('.dmp-card', has_text='Claude Opus 5.5 · Devin').first
        opus.locator('.dmp-sub .dmp-tog', has_text='Fast').click()
        page.wait_for_timeout(250)
        page.evaluate("document.activeElement?.blur();")
        page.screenshot(path=os.path.join(OUT_DIR, 'picker-fusion.png'), clip=panel_clip(page))

        # Providers tab: OpenRouter selected
        page.locator('.dmp-seg button', has_text='供应商').click()
        page.wait_for_timeout(300)
        page.locator('.dmp-pitem', has_text='OpenRouter').click()
        page.wait_for_timeout(250)
        page.evaluate("document.activeElement?.blur();")
        page.screenshot(path=os.path.join(OUT_DIR, 'picker-providers.png'), clip=panel_clip(page))
        ctx.close()

        # 2. Light theme shot: Single-Model with OpenRouter/Devin provider switch dropdown open
        ctx_light = browser.new_context(viewport={'width': 1000, 'height': 820}, device_scale_factor=2)
        page_l = ctx_light.new_page()
        page_l.goto(base + '?theme=light')
        page_l.wait_for_timeout(300)
        page_l.evaluate("""localStorage.setItem('devin-model-picker:v1', JSON.stringify({
          prefs: {
            order: ['opus|5.5|', 'gpt|5.6|codex', 'gemini|3.8|flash', 'deepseek||chat', 'swe|2|', 'kimi|3.1|pro', 'glm|5.3|', 'swe|2|flash', 'neon|4|'],
            favorites: [],
            hidden: [],
            aliases: {}
          }
        }))""")
        page_l.reload()
        page_l.wait_for_timeout(300)
        page_l.click('#composer button[aria-haspopup="menu"]')
        page_l.wait_for_selector('.dmp-panel.dmp-open', timeout=3000)
        page_l.wait_for_timeout(300)
        page_l.locator('.dmp-card', has_text='Claude Opus 5.5').first.locator('.dmp-prov').click()
        page_l.wait_for_selector('.dmp-pop', timeout=2000)
        page_l.evaluate("document.activeElement?.blur(); document.body.classList.add('capture-clean');")
        page_l.wait_for_timeout(150)
        page_l.screenshot(path=os.path.join(OUT_DIR, 'picker-single-light.png'), clip=panel_clip(page_l))
        ctx_light.close()

        browser.close()
    server.shutdown()
    print('Captured screenshots in', OUT_DIR)


if __name__ == '__main__':
    main()
