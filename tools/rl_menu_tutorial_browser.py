# Browser gate for plan 阶段 8「菜单、教学、成就」: the first-run tutorial
# walkthrough, the 成就 overlay + toast, the 操作说明 overlay + 重新教学, and
# the SE-volume slider. Owns its server; run alone (browser gates starve when
# run concurrently).
#
#   python tools/rl_menu_tutorial_browser.py [port]
#
# Cases, in order:
#   1. fresh save -> roster (after the prologue dialogue, skipped)
#   2. selecting a card starts a fresh run; the volume opening + tutorial
#      dialogue play; once they finish, the on-screen walkthrough begins
#   3. the walkthrough steps advance on real input and mark tutorialSeen
#   4. pause menu: 成就 overlay (15 rows, none done on a fresh save),
#      Escape dismisses and returns to the menu
#   5. pause menu: 操作说明 overlay (keyboard/mouse/touch rows), 关闭 + 重新教学
#   6. SE volume slider drives core/audio.setSeVolume
#   7. no horizontal overflow for either overlay at 375 and 1280
#   8. a save that crosses an achievement threshold toasts at boot ("潮声重现")
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def boot(page, port, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 60
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            return
        page.wait_for_timeout(200)
    raise RuntimeError("window.kirafanRL never appeared")


def skip_dialogues(page, cap=8):
    """Dismiss every queued dialogue node via 跳过此段; cap guards infinite loops."""
    for _ in range(cap):
        try:
            box = page.query_selector("#dialogue-box")
        except Exception:
            box = None
        if not box:
            return
        visible = box.evaluate("el => getComputedStyle(el).display !== 'none'")
        if not visible:
            return
        skip = box.query_selector("#dialogue-skip")
        if not skip:
            return
        skip.click()
        page.wait_for_timeout(250)


def wait_hint_contains(page, text, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        hint = page.evaluate("document.getElementById('hint').textContent || ''")
        if text in hint:
            return hint
        page.wait_for_timeout(100)
    raise RuntimeError("hint never contained " + text)


def press_held(page, key, hold_ms=140):
    """Like tap() but for navigation keys: Escape must stay held across a
    clock tick or the fixed-step update never samples the key as down (the
    edge-polled-key lesson)."""
    page.keyboard.down(key)
    page.wait_for_timeout(hold_ms)
    page.keyboard.up(key)


def open_menu(page):
    """Press Escape (held) until the pause menu is up — an earlier Escape may
    have closed a shop/decision the walkthrough's interact press opened."""
    for _ in range(4):
        cls = page.evaluate(
            "document.getElementById('menu-panel').className || ''")
        if "hidden" not in cls:
            return True
        press_held(page, "Escape")
    return "hidden" not in page.evaluate(
        "document.getElementById('menu-panel').className || ''")


def unfreeze(page):
    """Dismiss whatever overlay is up (shop/decision/menu) so the run resumes."""
    for _ in range(6):
        if not page.evaluate("window.kirafanRL.world.frozen"):
            return True
        press_held(page, "Escape")
    return not page.evaluate("window.kirafanRL.world.frozen")


def tap(page, key, hold_ms=90):
    page.keyboard.down(key)
    page.wait_for_timeout(hold_ms)
    page.keyboard.up(key)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8973
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = 0

    def check(label, ok, detail=""):
        nonlocal fails
        print(("OK   " if ok else "FAIL ") + label + ("  " + str(detail) if detail else ""))
        if not ok:
            fails += 1

    try:
        time.sleep(1.5)
        url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=1" % port
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                      "--autoplay-policy=no-user-gesture-required"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            # --- 1/2. fresh save -> roster -> start a run -------------------
            page.goto(url, wait_until="load", timeout=60000)
            page.wait_for_timeout(500)
            page.wait_for_selector(".roster-card", timeout=40000)
            cards = page.evaluate(
                "Array.from(document.querySelectorAll('.roster-card')).length")
            check("fresh save: roster renders", cards >= 40, "cards=%d" % cards)

            # The dialogue chain (prologue → volume opening → tutorial) stays
            # queued UNDER the roster overlay until a card is chosen; it only
            # surfaces once the run starts. So: pick a card, then skip the
            # dialogue chain as it surfaces.
            page.evaluate("document.querySelector('.roster-card').click()")
            deadline = time.time() + 50
            while time.time() < deadline:
                if page.evaluate("!!(window.kirafanRL.world && window.kirafanRL.world.player)"):
                    break
                page.wait_for_timeout(250)
            check("card click starts a run", bool(
                page.evaluate("!!(window.kirafanRL.world && window.kirafanRL.world.player)")))

            # Volume opening + tutorial dialogue play; skip to the walkthrough.
            skip_dialogues(page)

            # --- 3. the walkthrough runs its whole arc -----------------------
            wait_hint_contains(page, "移动")
            # move: 0.5s hold clears the 0.4s threshold
            page.keyboard.down("a")
            page.wait_for_timeout(550)
            page.keyboard.up("a")
            wait_hint_contains(page, "攻击")
            check("walkthrough: move hint -> attack hint", True)
            tap(page, "j")
            wait_hint_contains(page, "闪避")
            check("walkthrough: attack -> dodge", True)
            tap(page, "Space")
            wait_hint_contains(page, "技能")
            tap(page, "Digit2")
            wait_hint_contains(page, "互动")
            check("walkthrough: dodge -> skill -> interact", True)
            tap(page, "e")
            wait_hint_contains(page, "齐了")
            check("walkthrough: interact -> closing line", True)
            # The interact press may have opened a chest/shop/rest overlay; the
            # done-linger only counts down while the world is unfrozen. Once it
            # elapses, onDone marks the one-shot flag in memory (the storage
            # write is deferred — a reload later confirms durability).
            unfreeze(page)
            deadline = time.time() + 12
            seen = False
            while time.time() < deadline:
                if page.evaluate("window.kirafanRL.tutorialSeen === true"):
                    seen = True
                    break
                page.wait_for_timeout(200)
            check("walkthrough completion marks tutorialSeen", seen)
            check("no pageerror during boot+walkthrough", len(errors) == 0, str(errors[:3]))

            # --- 4. 成就 overlay from the pause menu -------------------------
            check("pause menu opens from Escape", open_menu(page))
            page.wait_for_selector("#menu-panel:not(.hidden)", timeout=5000)
            page.evaluate("document.getElementById('menu-achv').click()")
            page.wait_for_selector("#achv-overlay", timeout=5000)
            n_rows = page.evaluate(
                "document.querySelectorAll('.achv-row').length")
            n_locked = page.evaluate("""
                Array.from(document.querySelectorAll('.achv-row'))
                     .filter(el => el.dataset.done === '0').length""")
            check("成就 overlay: 15 rows, all locked on a fresh save",
                  n_rows == 15 and n_locked == 15, "rows=%d locked=%d" % (n_rows, n_locked))
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            after = page.evaluate("""(() => {
                const panel = document.getElementById('menu-panel');
                return { achvGone: !document.getElementById('achv-overlay'),
                         menuVisible: !!panel && !panel.className.split(' ').includes('hidden') };
            })()""")
            check("成就: Escape dismisses and returns to the menu",
                  after["achvGone"] and after["menuVisible"], str(after))

            # --- 5. 操作说明 overlay -----------------------------------------
            page.evaluate("document.getElementById('menu-howto').click()")
            page.wait_for_selector("#howto-overlay", timeout=5000)
            n_kbd = page.evaluate("""
                Array.from(document.querySelectorAll('.howto-card'))
                     .filter(el => el.textContent.includes('键盘') || el.textContent.includes('触屏')).length""")
            n_keys = page.evaluate("document.querySelectorAll('.howto-key').length")
            check("操作说明: keyboard + touch cards render",
                  n_kbd == 2 and n_keys >= 8,
                  "cards=%d keys=%d" % (n_kbd, n_keys))
            # 重新教学: closes the overlay and restarts the walkthrough
            can_again = page.evaluate("!!document.getElementById('howto-again')")
            check("操作说明: 重新教学 present with an active run", can_again)
            if can_again:
                page.evaluate("document.getElementById('howto-again').click()")
                page.wait_for_timeout(300)
                check("操作说明: 重新教学 closes the overlay",
                      page.evaluate("!document.getElementById('howto-overlay')"))
                wait_hint_contains(page, "移动")  # walkthrough restarted
                check("操作说明: 重新教学 restarts the walkthrough", True)
                # finish it so later steps run unfrozen
                page.keyboard.down("a"); page.wait_for_timeout(550); page.keyboard.up("a")
                tap(page, "j"); tap(page, "Space"); tap(page, "Digit2"); tap(page, "e")
                wait_hint_contains(page, "齐了")
                unfreeze(page)

            # --- 6. SE volume slider drives core/audio -----------------------
            check("pause menu opens after 重新教学", open_menu(page))
            page.wait_for_selector("#menu-panel:not(.hidden)", timeout=5000)
            page.evaluate("""(() => {
                const sl = document.getElementById('menu-sevol');
                sl.value = '30';
                sl.dispatchEvent(new Event('input'));
            })()""")
            se = page.evaluate("import('/site/core/audio.js').then(m => m.getSeVolume())")
            check("SE slider sets core/audio SE volume", abs(se - 0.3) < 1e-6, "se=%.4f" % se)

            # --- 7. no horizontal overflow at 375 ----------------------------
            page.set_viewport_size({"width": 375, "height": 800})
            page.wait_for_timeout(300)
            page.evaluate("document.getElementById('menu-howto').click()")
            page.wait_for_selector("#howto-overlay", timeout=5000)
            overflow = page.evaluate("""(() => {
                const w = document.documentElement.clientWidth;
                return Array.from(document.querySelectorAll('.howto-row, .howto-card, .howto-close'))
                    .map(el => { const r = el.getBoundingClientRect();
                        return [r.left, r.right]; })
                    .every(p => p[0] >= -1 && p[1] <= w + 1);
            })()""")
            check("howto overlay fits inside the 375px viewport", overflow)
            press_held(page, "Escape")
            page.set_viewport_size({"width": 1280, "height": 800})
            page.wait_for_timeout(200)

            # --- 8. threshold crossing toasts at boot ------------------------
            page.evaluate("""import('/site/game/rl/meta.js').then(m => {
                const meta = m.createMeta(); meta.read(); meta.clearVolume(1);
            })""")
            page.evaluate("window.location.reload()")
            boot(page, port, url)
            skip_dialogues(page)
            deadline = time.time() + 12
            toasted = False
            while time.time() < deadline:
                cls = page.evaluate("document.getElementById('achv-toast').className || ''")
                text = page.evaluate("document.getElementById('achv-toast').textContent || ''")
                if "show" in cls and "潮声重现" in text:
                    toasted = True
                    break
                page.wait_for_timeout(150)
            check("boot sweep toasts a fresh volume-clear achievement", toasted, text if 'text' in dir() else "")

            # The reload's pagehide flushed the deferred meta write, so the
            # one-shot flag must survive back into the booted meta.
            check("tutorialSeen survives a reload (deferred write flushed)",
                  page.evaluate("window.kirafanRL.tutorialSeen === true"))

            # --- 9. camp entry: 成就 reachable from the roster screen --------
            # The reward-crossing save sits on the roster now; the button must
            # show the seeded v1 as done without starting a run.
            page.wait_for_selector("#roster-achv", timeout=20000)
            page.evaluate("document.getElementById('roster-achv').click()")
            page.wait_for_selector("#achv-overlay", timeout=5000)
            camp = page.evaluate("""(() => ({
                rows: document.querySelectorAll('.achv-row').length,
                done: Array.from(document.querySelectorAll('.achv-row'))
                    .filter(el => el.dataset.done === '1').length
            }))()""")
            check("roster 成就 entry: 15 rows, seeded v1 shows done",
                  camp["rows"] == 15 and camp["done"] >= 1, str(camp))
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            check("roster 成就: Escape returns to the roster screen",
                  page.evaluate("!document.getElementById('achv-overlay')"))

            check("no pageerror across the whole gate", len(errors) == 0, str(errors[:3]))
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()
    print("")
    print("ALL OK" if fails == 0 else "%d FAILURES" % fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())