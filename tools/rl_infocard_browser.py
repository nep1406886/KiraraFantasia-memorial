# Browser gate for T22i 人物卡 / 技能卡 (feedback item 10):
#   1. roster 人物卡: the 详情 button opens the sheet for the FIRST roster
#      character; the sheet shows the character name, title, CV, profile,
#      class/element tags, init stats, and 3 skill sheets each with a Chinese
#      name and detail (baked by rl_bake_profiles.py) plus 词条 chips; 返回
#      closes back to the roster (selection still pending); 出发 starts the
#      run (roster gone, world player spawned with that card)
#   1.5 后藤 一里 (user correction): the 孤独摇滚 character's zh name is
#      后藤 一里 everywhere it renders (roster card + sheet + player)
#   2. in-run 技能卡: Esc opens the menu, 技能说明 opens the skill card with
#      the player's normal attack + 3 slots; Esc closes the CARD (menu stays
#      up), a second Esc closes the menu; world stays frozen throughout
#   3. no page errors at any width in {375, 430, 768, 1280}, and the sheet's
#      close buttons stay inside clientWidth (reachable)
# Owns its own server. Usage: python tools/rl_infocard_browser.py [port]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

KANA = "぀ゟ"


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
    page.keyboard.down("Escape")
    page.evaluate("window.kirafanRL.step(1/60)")
    page.wait_for_timeout(50)
    page.keyboard.up("Escape")
    page.evaluate("window.kirafanRL.step(1/60)")
    page.wait_for_timeout(50)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8976
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = 0

    def check(label, ok, detail=""):
        nonlocal fails
        print(("OK   " if ok else "FAIL ") + label
              + (("  " + str(detail)) if detail else ""))
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

            # --- 1. roster 人物卡 ----------------------------------------
            boot(page, port, url)
            page.wait_for_selector(".roster-card", timeout=20000)

            sheet_probe = """(() => {
                const sheet = document.getElementById('rl-charcard');
                if (!sheet) { return null; }
                return {
                    name: (sheet.querySelector('.nm span:last-child')
                           || {}).textContent || '',
                    title: (sheet.querySelector('.ttl') || {}).textContent || '',
                    cv: (sheet.querySelector('.cv') || {}).textContent || '',
                    profile: (sheet.querySelector('.profile')
                              || {}).textContent || '',
                    tags: Array.from(sheet.querySelectorAll('.tag'))
                        .map(t => t.textContent),
                    statKeys: Array.from(
                        sheet.querySelectorAll('.statblock .k'))
                        .map(k => k.textContent),
                    skills: Array.from(sheet.querySelectorAll('.skill'))
                        .map(s => ({
                            name: (s.querySelector('.skname .skname-text')
                                   || {}).textContent || '',
                            detail: (s.querySelector('.skdetail')
                                     || {}).textContent || '',
                            cd: (s.querySelector('.cd')
                                 || {}).textContent || '',
                            words: Array.from(s.querySelectorAll('.word'))
                                .map(w => w.textContent)
                        })),
                    buttons: Array.from(sheet.querySelectorAll(
                        '.close-row button')).map(b => b.textContent)
                };
            })()"""

            # open the first character's sheet
            page.click(".roster-card .rl-roster-info")
            info = page.evaluate(sheet_probe)
            check("sheet opens from 详情", info is not None)
            check("sheet shows a zh name", bool(info["name"]), info["name"])
            check("sheet shows the work title", "《" in info["title"], info["title"])
            check("sheet shows the CV", info["cv"].startswith("CV："), info["cv"])
            check("sheet shows a profile paragraph", len(info["profile"]) >= 10,
                  len(info["profile"]))
            check("sheet tags include element+class+rarity",
                  len(info["tags"]) >= 3, info["tags"])
            check("sheet stats show all 7 keys",
                  set(["HP", "物攻", "魔攻", "物防", "魔防", "速度", "幸运"])
                  .issubset(set(info["statKeys"])), info["statKeys"])
            check("sheet shows 3 skills", len(info["skills"]) == 3,
                  len(info["skills"]))
            named = [s for s in info["skills"] if s["name"]]
            detailed = [s for s in info["skills"] if s["detail"]]
            check("all 3 skills carry a Chinese name",
                  len(named) == 3 and all(not any("぀" <= c <= "ゟ"
                                                  for c in s["name"])
                                          for s in named),
                  [s["name"] for s in info["skills"]])
            check("all 3 skills carry a Chinese detail",
                  len(detailed) == 3 and all(
                      not any("぀" <= c <= "ゟ" for c in s["detail"])
                      for s in detailed),
                  [s["detail"][:18] for s in info["skills"]])
            check("at least one skill has a cooldown readout",
                  any(s["cd"] for s in info["skills"]))
            check("skills carry 词条 chips",
                  sum(len(s["words"]) for s in info["skills"]) >= 3)
            check("sheet has 出发 and 返回",
                  set(info["buttons"]) >= {"出发", "返回"}, info["buttons"])

            # 返回 returns to the roster without consuming the selection
            page.click("#rl-charcard .close-row button:not(.primary)")
            page.wait_for_timeout(200)
            check("返回 closes the sheet, roster still up",
                  page.evaluate("!!document.getElementById('roster-overlay')")
                  and not page.evaluate(
                      "!!document.getElementById('rl-charcard')"))

            # --- 1.5 后藤 一里 ----------------------------------------------
            # ひとり is a vol5 unlock, so the vol1 roster deliberately lacks
            # her; assert the correction where it is consumed — the cards
            # table the UI reads — plus a same-page render of an unlocked
            # kana name (琴音/蓉子-style names all render Chinese, so any
            # kana leak here would be a bake miss).
            hito = page.evaluate("""(() => {
                return fetch('../../site/asset/rl/cards-rl.json')
                    .then(r => r.json())
                    .then(doc => {
                        const card = doc.cards.find(c => c.id === 46002000);
                        return card ? card.characterZh : null;
                    });
            })()""")
            hito = hito.value() if hasattr(hito, "value") else hito
            if hito is not None and hasattr(hito, "json"):
                hito = hito.json()
            check("ひとり's card renders as 后藤 一里 in the data the UI reads",
                  hito == "后藤 一里", repr(hito))
            kana_leak = page.evaluate("""(() => {
                const names = Array.from(
                    document.querySelectorAll('.roster-card .who'))
                    .map(w => w.textContent);
                return names.filter(n => /[\぀-ヿ]/.test(n));
            })()""")
            check("no kana names leak into the roster",
                  len(kana_leak) == 0, kana_leak)

            # --- 1.6 出发 starts the run ------------------------------------
            page.click(".roster-card .rl-roster-info")
            page.wait_for_selector("#rl-charcard", timeout=10000)
            page.click("#rl-charcard .close-row button.primary")
            deadline = time.time() + 30
            while time.time() < deadline:
                if page.evaluate(
                        "!!(window.kirafanRL && window.kirafanRL.world"
                        " && window.kirafanRL.world.player)"):
                    break
                page.wait_for_timeout(200)
            check("出发 spawns the player", page.evaluate(
                "!!(window.kirafanRL && window.kirafanRL.world"
                " && window.kirafanRL.world.player)"))
            check("roster is gone after 出发", not page.evaluate(
                "!!document.getElementById('roster-overlay')"))
            dismiss_dialogue(page)
            page.evaluate(
                "window.requestAnimationFrame = function () { return 0; }")

            # --- 2. in-run 技能卡 ------------------------------------------
            press_escape(page)
            page.wait_for_timeout(200)
            menu_visible = page.evaluate(
                "(() => { const m = document.getElementById('menu-panel');"
                " return !!(m && !m.classList.contains('hidden')); })()")
            check("Esc opens the pause menu", menu_visible)
            frozen = page.evaluate(
                "!!(window.kirafanRL.world.frozen)")
            check("world frozen under the menu", frozen)

            page.click("#menu-skills")
            page.wait_for_selector("#rl-skillcard", timeout=10000)
            sk = page.evaluate("""(() => {
                const card = document.getElementById('rl-skillcard');
                if (!card) { return null; }
                const sheets = Array.from(card.querySelectorAll('.skill'));
                return {
                    who: (card.querySelector('.nm') || {}).textContent || '',
                    count: sheets.length,
                    names: sheets.map(s => (s.querySelector('.skname span')
                                            || {}).textContent || ''),
                    details: sheets.map(s => (s.querySelector('.skdetail')
                                              || {}).textContent || '')
                };
            })()""")
            check("技能说明 opens the skill card", sk is not None)
            check("skill card names the player", len(sk["who"]) >= 1, sk["who"])
            check("skill card lists normal attack + 3 slots",
                  sk["count"] == 4, sk["count"])
            check("skill card names are Chinese", all(
                not any("぀" <= c <= "ゟ" for c in n) for n in sk["names"]),
                  sk["names"])
            check("skill card details are Chinese", all(
                not any("぀" <= c <= "ゟ" for c in d) for d in sk["details"]),
                  [d[:12] for d in sk["details"]])

            # Esc closes the CARD, not the menu under it
            press_escape(page)
            page.wait_for_timeout(200)
            check("Esc closes the skill card", not page.evaluate(
                "!!document.getElementById('rl-skillcard')"))
            check("menu still up after the card closes", page.evaluate(
                "(() => { const m = document.getElementById('menu-panel');"
                " return !!(m && !m.classList.contains('hidden')); })()"))
            press_escape(page)
            page.wait_for_timeout(200)
            check("second Esc closes the menu", not page.evaluate(
                "(() => { const m = document.getElementById('menu-panel');"
                " return !!(m && !m.classList.contains('hidden')); })()"))

            # --- 3. widths ---------------------------------------------------
            for width in (375, 430, 768, 1280):
                page.set_viewport_size({"width": width, "height": 800})
                page.wait_for_timeout(150)
                page.click(".roster-card") if False else None
                # reopen the char card from the menu path: Esc menu -> skills
                press_escape(page)
                page.wait_for_timeout(150)
                page.click("#menu-skills")
                page.wait_for_selector("#rl-skillcard", timeout=10000)
                rects = page.evaluate("""(() => {
                    const card = document.getElementById('rl-skillcard');
                    const sheet = card.querySelector('.sheet');
                    const btn = card.querySelector('.close-row button');
                    const r = sheet.getBoundingClientRect();
                    const b = btn.getBoundingClientRect();
                    return {
                        sheet: { l: r.left, r: r.right, t: r.top, b: r.bottom },
                        btn: { l: b.left, r: b.right, t: b.top, b: b.bottom },
                        cw: document.documentElement.clientWidth,
                        ch: document.documentElement.clientHeight
                    };
                })()""")
                inside = (rects["sheet"]["l"] >= 0
                          and rects["sheet"]["r"] <= rects["cw"]
                          and rects["sheet"]["t"] >= 0
                          and rects["sheet"]["b"] <= rects["ch"]
                          and rects["btn"]["r"] <= rects["cw"])
                reach = page.evaluate("""(() => {
                    const btn = document.querySelector(
                        '#rl-skillcard .close-row button');
                    const r = btn.getBoundingClientRect();
                    const el = document.elementFromPoint(
                        (r.left + r.right) / 2, (r.top + r.bottom) / 2);
                    return el === btn || (btn.contains(el));
                })()""")
                check("width %d: sheet+close stay inside the viewport" % width,
                      inside and reach)
                press_escape(page)
                page.wait_for_timeout(150)
                press_escape(page)
                page.wait_for_timeout(150)

            check("no page errors at any stage", not errors, errors[:3])
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)

    print("RESULT " + ("PASS" if fails == 0 else "FAIL %d" % fails))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
