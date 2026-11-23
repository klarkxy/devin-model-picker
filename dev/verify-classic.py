# Classic/cards view toggle + native getCostTag verification against dev/harness.html.
# Mirrors _verify.py's bootstrap; uses the richer fixture (BYOK + native modelCost).
import json, sys, threading, http.server, functools, os, glob
from playwright.sync_api import sync_playwright

def chromium_launch_kwargs():
    override = os.environ.get('DMP_CHROMIUM')
    if override:
        return {'executable_path': override}
    cand = sorted(glob.glob(r'T:/Caches/Playwright/chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe')
        + glob.glob(r'C:/Users/27837/AppData/Local/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-win64/chrome-headless-shell.exe'))
    if cand:
        return {'executable_path': cand[-1]}
    return {}

PORT = 8934
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo root
handler = functools.partial(http.server.SimpleHTTPRequestHandler)
server = http.server.HTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d/dev/harness.html' % PORT
SHOTS = 'dev/screenshots'
os.makedirs(SHOTS, exist_ok=True)
errors = []
results = []

def check(name, cond, extra=''):
    results.append((name, bool(cond), extra))
    print(('PASS' if cond else 'FAIL'), name, extra)

with sync_playwright() as pw:
    browser = pw.chromium.launch(**chromium_launch_kwargs())
    ctx = browser.new_context(viewport={'width': 1000, 'height': 820})
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_timeout(300)
    page.evaluate("localStorage.clear()")
    page.reload()
    page.wait_for_timeout(500)

    trigger = '#composer button[aria-haspopup="menu"]'
    panel = '.dmp-panel'
    menu = '[data-native-menu]'
    get_view = lambda: page.evaluate("JSON.parse(localStorage.getItem('devin-model-picker:v1')||'{}').view||'missing'")

    # --- no adjacent entry next to the trigger while in cards view (default) ---
    page.wait_for_timeout(300)
    outside = page.evaluate("""[...document.querySelectorAll('[data-dmp-native-switch]')]
      .filter(el => !el.closest('[role=menu]')).length""")
    check('no card-switch outside menus (cards view)', outside == 0, str(outside))

    # --- cards mode: trigger opens our panel ---
    page.click(trigger)
    page.wait_for_selector(panel, timeout=3000)
    check('cards: panel opens on trigger click', page.locator(panel).count() == 1)
    check('classic button in toolbar', page.locator('.dmp-classic').inner_text() == '经典选择器')

    # --- native cost tags come from the host's getCostTag; BYOK shows none ---
    # SWE-2 is a pure-native card; its default High variant prices 1x.
    swe = page.locator('.dmp-card', has_text='SWE-2').first
    tag = swe.locator('.dmp-cost')
    check('native cost tag from getCostTag', tag.count() == 1 and tag.inner_text() == '1x',
        swe.inner_text()[:120])
    check('cost tag tooltip names Devin', 'Devin' in (tag.get_attribute('title') or ''),
        tag.get_attribute('title') or '')
    # Effort switch reprices the same card — Max costs 2.5x.
    swe.locator('.dmp-eff button', has_text='Max').click()
    page.wait_for_timeout(250)
    swe = page.locator('.dmp-card', has_text='SWE-2').first
    check('cost tag follows effort', swe.locator('.dmp-cost').inner_text() == '2.5x',
        swe.inner_text()[:120])
    # Flash is free: the tag replaces the generic free badge, not duplicated.
    swe.locator('.dmp-eff button', has_text='Flash').click()
    page.wait_for_timeout(250)
    swe = page.locator('.dmp-card', has_text='SWE-2').first
    check('free effort shows free tag', swe.locator('.dmp-cost').inner_text() == 'free',
        swe.inner_text()[:120])
    check('free badge not duplicated', swe.locator('.dmp-free').count() == 0)
    swe.locator('.dmp-eff button').get_by_text('H', exact=True).click()
    page.wait_for_timeout(250)
    # BYOK cards never carry a native tag or a models.dev reference price.
    for name in ['Opus', 'DeepSeek', 'Kimi']:
        card = page.locator('.dmp-card', has_text=name).first
        check('%s card has no cost tag' % name, card.locator('.dmp-cost').count() == 0,
            card.inner_text()[:100])
    check('no price rows while BYOK family shown',
        all(page.locator('.dmp-card', has_text=name).first.locator('.dmp-price').count() == 0
            for name in ['Opus', 'DeepSeek', 'Kimi']))
    check('no models.dev reference text', 'models.dev' not in page.locator(panel).inner_text()
        and '参考' not in page.locator(panel).inner_text())
    # A merged card switched to its Devin family shows the tag; back to BYOK hides it.
    opus = page.locator('.dmp-card', has_text='Opus').first
    opus.locator('.dmp-prov').click()
    opus.locator('.dmp-pop button', has_text='Devin').click()
    page.wait_for_timeout(300)
    opus = page.locator('.dmp-card', has_text='Opus').first
    check('Devin family shows explicit price',
        opus.locator('.dmp-price').count() == 1
        and opus.locator('.dmp-price').inner_text() == '输入 $5 · 缓存输入 $0.5 · 输出 $25 / 1M',
        opus.inner_text()[:120])
    check('priced card hides multiplier chip', opus.locator('.dmp-cost').count() == 0,
        opus.inner_text()[:120])
    page.screenshot(path=SHOTS + '/priced-card.png', clip=opus.bounding_box())
    opus.locator('.dmp-prov').click()
    opus.locator('.dmp-pop button', has_text='Magpie').click()
    page.wait_for_timeout(300)
    opus = page.locator('.dmp-card', has_text='Opus').first
    check('BYOK family hides cost tag again', opus.locator('.dmp-cost').count() == 0
        and opus.locator('.dmp-price').count() == 0)
    page.screenshot(path=SHOTS + '/native-cost.png', clip=page.locator(panel).bounding_box())

    # --- Enter/Space on 经典选择器 must open classic without picking a card ---
    select_log = lambda: page.evaluate("""() => {
      const btn = document.querySelector('#composer button[aria-haspopup="menu"]');
      return (btn.__dmpSelectLog || []).map(p => p.modelUid);
    }""")
    current_value = lambda: page.evaluate("""() => {
      const btn = document.querySelector('#composer button[aria-haspopup="menu"]');
      return btn.__dmpHarness.pickerProps.value;
    }""")
    first_card_text = page.locator('.dmp-card:not(.dmp-off):not(.dmp-add)').first.inner_text()
    check('first card is not the live SWE-2 selection', 'SWE-2' not in first_card_text,
        first_card_text[:80])
    for key, label in [('Enter', 'Enter'), ('Space', 'Space')]:
        page.wait_for_selector(panel + '.dmp-open', timeout=3000)
        before_log, before_value = select_log(), current_value()
        page.locator('.dmp-classic').focus()
        page.keyboard.press(key)
        page.wait_for_selector(menu, timeout=3000)
        after_log, after_value = select_log(), current_value()
        check('%s on classic does not call onModelSelect' % label, after_log == before_log,
            '%s -> %s' % (before_log, after_log))
        check('%s on classic keeps current model' % label, after_value == before_value,
            '%s -> %s' % (before_value, after_value))
        check('%s on classic opens native menu' % label, page.locator(menu).count() == 1)
        page.wait_for_selector(menu + ' [data-dmp-native-switch]', timeout=3000)
        page.locator(menu + ' [data-dmp-native-switch]').click()
        page.wait_for_selector(panel + '.dmp-open', timeout=3000)
        page.wait_for_timeout(80)

    # --- toolbar classic button: persists classic, closes panel, opens native ---
    # Instrument first: the public onOpenChange must be the path taken, and no
    # synthetic click may reach the trigger.
    page.evaluate("""(() => {
      const btn = document.querySelector('#composer button[aria-haspopup="menu"]');
      window.__dmpClicks = 0; window.__dmpOpenCalls = 0;
      btn.addEventListener('click', () => { window.__dmpClicks++; });
      const hp = btn.__dmpHarness.hostProps;
      const orig = hp.onOpenChange;
      hp.onOpenChange = v => { window.__dmpOpenCalls++; return orig(v); };
    })()""")
    page.locator('.dmp-classic').click()
    page.wait_for_selector(menu, timeout=3000)
    check('classic persisted', get_view() == 'classic', get_view())
    page.wait_for_timeout(300)
    check('panel closed after classic switch', page.locator(panel).count() == 0)
    check('native menu opened', page.locator(menu).count() == 1)
    check('opened via public onOpenChange once', page.evaluate('window.__dmpOpenCalls') == 1,
        str(page.evaluate('window.__dmpOpenCalls')))
    check('no synthetic click on trigger', page.evaluate('window.__dmpClicks') == 0,
        str(page.evaluate('window.__dmpClicks')))

    # --- portal menu carries our switch at the top ---
    page.wait_for_selector(menu + ' [data-dmp-native-switch]', timeout=3000)
    check('in-menu switch at top', page.locator(menu + ' [data-dmp-native-switch]').count() == 1)

    # --- classic mode: selecting keeps classic; trigger re-opens native only ---
    page.locator(menu + ' [role=menuitem]').first.click()
    page.wait_for_timeout(300)
    check('menu closed after select', page.locator(menu).count() == 0)
    check('still classic after select', get_view() == 'classic')
    page.click(trigger)
    page.wait_for_selector(menu, timeout=3000)
    page.wait_for_timeout(300)
    check('classic: trigger opens native, not panel', page.locator(panel).count() == 0 and page.locator(menu).count() == 1)

    # --- in-menu switch restores cards and opens the panel ---
    page.locator(menu + ' [data-dmp-native-switch]').click()
    page.wait_for_selector(panel, timeout=3000)
    check('in-menu switch opens panel', page.locator(panel).count() == 1)
    check('view restored to cards', get_view() == 'cards', get_view())
    page.wait_for_timeout(300)
    check('menu closed after restore', page.locator(menu).count() == 0)

    # --- classic view gets an adjacent switch back as the visible way out ---
    page.locator('.dmp-classic').click()
    page.wait_for_selector(menu, timeout=3000)
    check('classic persisted again', get_view() == 'classic', get_view())
    page.wait_for_timeout(300)
    check('adjacent switch appears in classic view',
        page.locator('#composer [data-dmp-native-switch]').count() == 1,
        str(page.locator('#composer [data-dmp-native-switch]').count()))
    page.locator('#composer [data-dmp-native-switch]').click()
    page.wait_for_selector(panel, timeout=3000)
    check('adjacent switch restores cards + opens panel',
        page.locator(panel).count() == 1 and get_view() == 'cards', get_view())
    page.wait_for_timeout(300)
    outside = page.evaluate("""[...document.querySelectorAll('[data-dmp-native-switch]')]
      .filter(el => !el.closest('[role=menu]')).length""")
    check('adjacent switch gone in cards view', outside == 0, str(outside))

    # --- the in-menu switch opens the panel directly ---
    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    page.click(trigger, modifiers=['Alt'])
    page.wait_for_selector(menu, timeout=3000)
    page.locator(menu + ' [data-dmp-native-switch]').click()
    page.wait_for_selector(panel, timeout=3000)
    check('in-menu switch opens panel', page.locator(panel).count() == 1)

    # --- Alt+click is the one-shot escape: native opens, view stays cards ---
    page.keyboard.press('Escape')
    page.wait_for_timeout(300)
    page.click(trigger, modifiers=['Alt'])
    page.wait_for_selector(menu, timeout=3000)
    page.wait_for_timeout(300)
    check('Alt+click opens native', page.locator(menu).count() == 1)
    check('Alt+click does not change view', get_view() == 'cards', get_view())
    page.locator(menu + ' [role=menuitem]').first.click()
    page.wait_for_timeout(300)
    page.click(trigger)
    page.wait_for_selector(panel, timeout=3000)
    check('cards still enhanced after Alt+click', page.locator(panel).count() == 1)
    page.screenshot(path=SHOTS + '/classic-roundtrip.png', clip=page.locator(panel).bounding_box())

    # --- fallback: every public onOpenChange removed → the replayed Alt
    # sequence is the only path left and must open the native menu ---
    page.evaluate("""(() => {
      const btn = document.querySelector('#composer button[aria-haspopup="menu"]');
      for (const key of Object.keys(btn)) if (key.startsWith('__reactFiber$')) {
        let c = btn[key];
        while (c) { if (c.memoizedProps && 'onOpenChange' in c.memoizedProps) c.memoizedProps.onOpenChange = null; c = c.return; }
      }
      btn.__dmpOpenChange = null;
    })()""")
    clicks_before = page.evaluate('window.__dmpClicks')
    opens_before = page.evaluate('window.__dmpOpenCalls')
    page.locator('.dmp-classic').click()
    page.wait_for_selector(menu, timeout=3000)
    check('fallback replay opens native menu', page.locator(menu).count() == 1)
    check('fallback dispatched synthetic click', page.evaluate('window.__dmpClicks') == clicks_before + 1,
        str(page.evaluate('window.__dmpClicks')))
    check('fallback never called an opener', page.evaluate('window.__dmpOpenCalls') == opens_before,
        str(page.evaluate('window.__dmpOpenCalls')))
    check('view still classic after fallback', get_view() == 'classic')
    # The in-menu switch still restores cards; with no opener left, closing
    # falls back to the root's public onClose.
    page.wait_for_selector(menu + ' [data-dmp-native-switch]', timeout=3000)
    page.locator(menu + ' [data-dmp-native-switch]').click()
    page.wait_for_selector(panel + '.dmp-open', timeout=3000)
    check('in-menu switch restores panel (onClose path)', page.locator(panel + '.dmp-open').count() == 1)
    check('menu closed via onClose', page.locator(menu).count() == 0)

    # --- short window: the panel top never slips under the title-bar floor.
    # The composer trigger ends up with < 120px of space above, so the above-
    # branch must pin top=minTop (44 in this harness) instead of anchoring the
    # bottom and letting the 120px maxH floor lift the top past the title bar.
    page.set_viewport_size({'width': 1000, 'height': 220})
    page.wait_for_timeout(400)
    top = page.evaluate("document.querySelector('.dmp-panel').getBoundingClientRect().top")
    check('panel top honors title-bar floor', top >= 43, 'top=%s' % top)
    page.screenshot(path=SHOTS + '/panel-min-top.png', clip=page.locator(panel).bounding_box())

    check('no console errors', len(errors) == 0, '; '.join(errors[:5]))
    browser.close()

server.shutdown()
fails = [r for r in results if not r[1]]
print('\n%d/%d passed' % (len(results) - len(fails), len(results)))
sys.exit(1 if fails else 0)
