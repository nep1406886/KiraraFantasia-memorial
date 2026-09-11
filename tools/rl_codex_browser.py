# Browser check for the 残页図鑑 (T13) wiring in main.js / roster.js:
#   1. roster path: the 図鑑 button opens the codex before any run; closing
#      it returns to the roster (selection not dropped)
#   2. menu path: Esc -> menu -> 図鑑 opens it mid-run, world frozen while
#      open, unfrozen on close; the closing Esc does NOT fall through to the
#      menu underneath
#   2.5 enemy tab (T22f): walking into a battle room records the faces to the
#      meta slot (遭遇解锁); the 敌人 tab lists all 96 authored faces with
#      met/un-met rendering, stats+rewards detail, a lazily rendered model
#      thumbnail, and tabbing back restores the 残页 grid
#   3. contents: 37 entries (14010000 deduped from vol2+vol5), 6 sections,
#      count reflects the seeded save, collected vs locked rendering, detail
#      on click for both states
#   4. widths 375/390/412/430/768/1280: every entry + close button rect stays
#      inside clientWidth; #codex-close and a sample entry are reachable via
#      elementFromPoint
# Owns its server. Usage: python tools/rl_codex_browser.py [port]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

# Seeded collection: vol1's first three pages + the みら finale page.
# 37 total is the authored number (游玩说明 §六.3), not read from the data.
SEEDED = [29001000, 47002000, 28001000, 38001000]
WIDTHS = [375, 390, 412, 430, 768, 1280]


def boot(page, port, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            break
        page.wait_for_timeout(200)


def dismiss_dialogue(page):
    for _ in range(90):
        vis = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " return !!(b && b.style.display !== 'none'); })()")
        if not vis:
            return
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)


def press_escape(page):
    # Two headless traps in one keypress: the game polls the menu key from
    # the clock's update loop (and headless rAF never ticks, so the world
    # must be stepped through the sanctioned kirafanRL.step handle), and
    # keyboard.press delivers keydown+keyup before any step runs — the
    # edge-triggered poll would only ever see menu === false again. A real
    # player holds the key across frames, so: down, step, up, step.
    page.keyboard.down("Escape")
    page.evaluate("window.kirafanRL.step(1/60)")
    page.wait_for_timeout(50)
    page.keyboard.up("Escape")
    page.evaluate("window.kirafanRL.step(1/60)")
    page.wait_for_timeout(50)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8967
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
            # Seed the save BEFORE any page script runs, so boot reads the
            # collection through the real meta.read() funnel.
            page.add_init_script(
                "localStorage.setItem('kirafan-rl:meta', %s);"
                % json.dumps(json.dumps(
                    {"pages": SEEDED, "prologueSeen": True})))

            # --- 1. roster path ------------------------------------------
            boot(page, port, url)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.click("#roster-codex")
            page.wait_for_selector("#codex-overlay", timeout=10000)

            stats = page.evaluate("""(() => {
                const entries = Array.from(
                    document.querySelectorAll('.codex-entry'));
                return {
                    total: entries.length,
                    sections: document.querySelectorAll('.codex-section').length,
                    count: (document.getElementById('codex-count')
                            || {}).textContent || '',
                    collected: entries.filter(
                        e => e.dataset.collected === '1').length,
                    locked: entries.filter(
                        e => e.dataset.collected === '0').length,
                    lockedNames: entries.filter(
                        e => e.dataset.collected === '0'
                    ).every(e => e.querySelector('.codex-name')
                             .textContent === '？？？')
                };
            })()""")
            check("37 entries (14010000 deduped)", stats["total"] == 37,
                  stats["total"])
            check("6 section headers (5 卷 + 終章)", stats["sections"] == 6,
                  stats["sections"])
            check("count text is 4 / 37", stats["count"] == "4 / 37",
                  stats["count"])
            check("4 collected / 33 locked", stats["collected"] == 4
                  and stats["locked"] == 33,
                  "%d/%d" % (stats["collected"], stats["locked"]))
            check("locked entries are ？？？", stats["lockedNames"])

            seeded = page.evaluate(
                "(() => { return !!document.querySelector("
                "'.codex-entry[data-page-id=\"29001000\"]'); })()")
            check("seeded page 29001000 is in the grid", seeded)

            # detail on click, collected and locked
            page.click('.codex-entry[data-page-id="29001000"]')
            detail = page.evaluate(
                "document.getElementById('codex-detail').textContent")
            check("collected detail names the hero", "大空 遥" in detail,
                  detail[:50])
            page.click('.codex-entry[data-page-id="21000000"]')
            detail = page.evaluate(
                "document.getElementById('codex-detail').textContent")
            check("locked detail says not rescued",
                  "还没有被救回" in detail, detail[:50])

            # keyboard: focus a collected entry, Enter opens its detail
            page.evaluate(
                'document.querySelector(\'.codex-entry[data-page-id="38001000"]\').focus()')
            page.keyboard.press("Enter")
            detail = page.evaluate(
                "document.getElementById('codex-detail').textContent")
            check("Enter on focused entry opens detail",
                  "米拉" in detail, detail[:50])

            # Escape closes; the roster underneath survives
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            state = page.evaluate("""(() => {
                return {
                    codex: !!document.getElementById('codex-overlay'),
                    roster: !!document.getElementById('roster-overlay')
                };
            })()""")
            check("Escape closes the codex", not state["codex"])
            check("roster still up after the peek", state["roster"])

            # --- 2. menu path (mid-run) ----------------------------------
            page.evaluate(
                "document.querySelector('.roster-card').click()")
            deadline = time.time() + 30
            while time.time() < deadline:
                has = page.evaluate(
                    "!!(window.kirafanRL.world && window.kirafanRL.world.player)")
                if has:
                    break
                page.wait_for_timeout(300)
            dismiss_dialogue(page)

            press_escape(page)
            page.wait_for_timeout(200)
            menu_vis = page.evaluate(
                "!document.getElementById('menu-panel')"
                ".classList.contains('hidden')")
            check("Esc opens the pause menu", menu_vis)

            page.click("#menu-codex")
            page.wait_for_selector("#codex-overlay", timeout=10000)
            state = page.evaluate("""(() => {
                return {
                    frozen: window.kirafanRL.world.frozen,
                    menuHidden: document.getElementById('menu-panel')
                        .classList.contains('hidden')
                };
            })()""")
            check("world frozen while codex open", state["frozen"])
            check("menu hands focus to the codex", state["menuHidden"])

            # The closing Esc must not fall through to the menu underneath.
            press_escape(page)
            page.wait_for_timeout(200)
            state = page.evaluate("""(() => {
                return {
                    codex: !!document.getElementById('codex-overlay'),
                    menuHidden: document.getElementById('menu-panel')
                        .classList.contains('hidden'),
                    frozen: window.kirafanRL.world.frozen
                };
            })()""")
            check("codex closed by Esc", not state["codex"])
            check("Esc did not open the menu underneath", state["menuHidden"])
            check("world unfrozen after close", not state["frozen"])

            # --- 2.5 enemy codex (T22f) ----------------------------------
            # 遭遇解锁: walk into a battle room (the sanctioned enterRoom
            # path), step once so consumeEvents runs the recorder, and the
            # ids must land in the meta save slot.
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                if (w.player) { w.player.iframes = 1e9; }
                const battle = w.dungeon.rooms.find(r => r.type === 'battle');
                if (!battle) { throw new Error('no battle room'); }
                w.enterRoom(battle.id, 'S');
            })()""")
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(300)
            enc = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const meta = JSON.parse(localStorage.getItem('kirafan-rl:profile')).meta;
                return {
                    spawned: w.enemies.map(e => String(e.enemyId)),
                    saved: meta.enemies || []
                };
            })()""")
            check("battle-room faces are recorded to the meta slot",
                  len(enc["spawned"]) > 0
                  and all(i in enc["saved"] for i in enc["spawned"]),
                  enc["spawned"][:3])

            press_escape(page)          # menu
            page.wait_for_timeout(150)
            page.click("#menu-codex")
            page.wait_for_selector("#codex-overlay", timeout=10000)
            check("page, enemy and story tabs present", page.evaluate(
                "JSON.stringify(Array.from(document.querySelectorAll('.codex-tab'), b => b.dataset.tab)) === JSON.stringify(['pages', 'enemies', 'stories'])"))
            page.click('.codex-tab[data-tab="enemies"]')
            page.wait_for_timeout(200)
            estats = page.evaluate("""(() => {
                const entries = Array.from(
                    document.querySelectorAll('.codex-entry'));
                return {
                    total: entries.length,
                    sections: document.querySelectorAll('.codex-section').length,
                    count: (document.getElementById('codex-count')
                            || {}).textContent || '',
                    encountered: entries.filter(
                        e => e.dataset.encountered === '1').length,
                    lockedNames: entries.filter(
                        e => e.dataset.encountered === '0'
                    ).every(e => e.querySelector('.codex-name')
                             .textContent === '？？？')
                };
            })()""")
            check("96 enemy entries (5 卷, mob+elite+boss)",
                  estats["total"] == 96, estats["total"])
            check("5 section headers", estats["sections"] == 5,
                  estats["sections"])
            check("count text is N / 96 with N > 0",
                  estats["count"].endswith("/ 96")
                  and int(estats["count"].split(" / ")[0]) > 0,
                  estats["count"])
            check("un-met entries are ？？？", estats["lockedNames"])

            met_id = page.evaluate(
                "document.querySelector("
                "'.codex-entry[data-encountered=\\\"1\\\"]').dataset.enemyId")
            page.click('.codex-entry[data-enemy-id="%s"]' % met_id)
            detail = page.evaluate(
                "document.getElementById('codex-detail').textContent")
            check("met entry detail carries stats and rewards",
                  ("HP" in detail and "攻" in detail and "コイン" in detail),
                  detail[:60])
            page.click('.codex-entry[data-encountered="0"]')
            detail = page.evaluate(
                "document.getElementById('codex-detail').textContent")
            check("un-met entry detail says not encountered",
                  "还没有遭遇过" in detail, detail[:40])

            # 立绘: the model snapshot renders lazily into the art box.
            thumb = None
            for _ in range(40):
                thumb = page.evaluate(
                    "(() => { const a = document.querySelector("
                    "'.codex-entry[data-encountered=\\\"1\\\"] .codex-art');"
                    " return a && a.style.backgroundImage || ''; })()")
                if thumb:
                    break
                page.wait_for_timeout(400)
            check("met entry gets a rendered model thumbnail",
                  bool(thumb), (thumb or "")[:40])

            # tab back: the pages grid returns, and only its entries are in
            # the DOM (the count reads 4 / 37 again)
            page.click('.codex-tab[data-tab="pages"]')
            page.wait_for_timeout(150)
            back = page.evaluate("""(() => {
                return {
                    pages: document.querySelectorAll(
                        '.codex-entry[data-page-id]').length,
                    enemies: document.querySelectorAll(
                        '.codex-entry[data-enemy-id]').length,
                    count: (document.getElementById('codex-count')
                            || {}).textContent || ''
                };
            })()""")
            check("back on 残页: 37 page entries, no enemy entries",
                  back["pages"] == 37 and back["enemies"] == 0)
            check("count reads 4 / 37 again", back["count"] == "4 / 37",
                  back["count"])
            page.click("#codex-close")
            page.wait_for_timeout(150)

            # --- 3. widths ------------------------------------------------
            # The widths loop leaves ~300 ms of live play between codex
            # closes; a mid-loop death (and its dialogue) would derail the
            # Esc handling, so park the run: no enemy ever acts and the
            # player keeps a huge iframe shield.
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                w.enemies.forEach(e => { e.actionTimer = 1e9; });
                if (w.player) { w.player.iframes = 1e9; }
            })()""")
            for w in WIDTHS:
                page.set_viewport_size({"width": w, "height": 800})
                page.wait_for_timeout(150)
                press_escape(page)                # menu
                page.wait_for_timeout(150)
                page.click("#menu-codex")
                page.wait_for_selector("#codex-overlay", timeout=10000)
                page.wait_for_timeout(250)        # images decode lazily
                res = page.evaluate("""(() => {
                    const doc = document.documentElement;
                    const cw = doc.clientWidth;
                    const bad = [];
                    const targets = Array.from(
                        document.querySelectorAll(
                            '.codex-entry, #codex-close, #codex-count'));
                    targets.forEach(el => {
                        const r = el.getBoundingClientRect();
                        if (r.width === 0) return;
                        if (r.right > cw + 0.5 || r.left < -0.5) {
                            bad.push(el.className + '@' + Math.round(r.right));
                        }
                    });
                    const close = document.getElementById('codex-close');
                    const cr = close.getBoundingClientRect();
                    const hit = document.elementFromPoint(
                        cr.left + cr.width / 2, cr.top + cr.height / 2);
                    const entry = document.querySelector('.codex-entry');
                    entry.scrollIntoView({block: 'center'});
                    const er = entry.getBoundingClientRect();
                    const ehit = document.elementFromPoint(
                        er.left + er.width / 2, er.top + er.height / 2);
                    const owns = (a, b) => !!(a && b && (a === b
                        || a.contains(b) || b.contains(a)));
                    return {
                        bad: bad, cw: cw,
                        closeReach: owns(close, hit),
                        entryReach: owns(entry, ehit)
                    };
                })()""")
                check("width %d: all rects inside clientWidth" % w,
                      not res["bad"], res["bad"][:3])
                check("width %d: close button reachable" % w, res["closeReach"])
                check("width %d: entry reachable" % w, res["entryReach"])
                page.click("#codex-close")
                page.wait_for_timeout(150)
                closed = page.evaluate(
                    "!document.getElementById('codex-overlay')")
                menu_hidden = page.evaluate(
                    "document.getElementById('menu-panel')"
                    ".classList.contains('hidden')")
                check("width %d: close button dismisses (menu still hidden)"
                      % w, closed and menu_hidden)

            check("no pageerrors", not errors, errors[:3])
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    print("RESULT " + ("ALL OK" if fails == 0 else "%d FAILURES" % fails))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
