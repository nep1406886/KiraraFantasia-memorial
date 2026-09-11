# Browser check for the meta (T11) wiring in main.js:
#   1. fresh save -> roster shows the authored 40 (T22l: selectable from
#      the start; was "gated to the first twelve" before the widening)
#   2. run start level = max(trained, volume baseline)
#   3. player death settles equipment into 星彩石 and persists via save
#   4. legacy 残片 save loads (migration path used by the module)
# Owns its server. Usage: python tools/rl_meta_browser.py [port]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FIRST12 = [10000000, 18000000, 14000000, 30001000, 23001000, 15000000,
           35001000, 11010000, 38001000, 24001000, 20000000, 32002000]


def boot(page, port, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            break
        page.wait_for_timeout(200)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8962
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

            # --- 1. fresh save: roster carries the authored 40 ---------------
            boot(page, port, url)
            page.wait_for_selector(".roster-card", timeout=20000)
            cards = page.evaluate("""(() => {
                return Array.from(document.querySelectorAll('.roster-card'))
                    .map(el => el.textContent);
            })()""")
            # rows carry characterZh; a fresh save now sees every authored
            # character (T22l widening — was <= 12 as the T11 unlock gate)
            check("fresh roster shows the authored 40", len(cards) == 40,
                  "got %d" % len(cards))
            check("fresh roster is non-empty", len(cards) > 0)

            # T22l element-dot ring: 0=炎 1=水 2=土 3=風 4=月 5=陽. The old
            # ELEMENT_VAR was shifted one (1:fire…) and the old roster filter
            # treated element 0 as "invalid", deleting every 炎 character
            # (5 of the authored 40). Pin the computed dot colour of one 炎
            # (ココア 30001000 → #e09a7a), one 水 (苺香 20000000 → #7ab8d9)
            # and one 土 (唯 11010000 → #cbb27a).
            dots = page.evaluate("""(() => {
                const out = {};
                const want = { '30001000.webp': 'fire', '20000000.webp': 'water',
                               '11010000.webp': 'earth' };
                document.querySelectorAll('.roster-card').forEach(el => {
                    const art = el.querySelector('img.art');
                    if (!art) { return; }
                    const key = art.src.split('/').pop();
                    if (!(key in want)) { return; }
                    const dot = el.querySelector('.who .el');
                    if (dot) { out[want[key]] = getComputedStyle(dot).backgroundColor; }
                });
                return out;
            })()""")
            check("炎 (element 0) dot is fire #e09a7a",
                  dots.get("fire") == "rgb(224, 154, 122)", dots)
            check("水 (element 1) dot is water #7ab8d9",
                  dots.get("water") == "rgb(122, 184, 217)", dots)
            check("土 (element 2) dot is earth #cbb27a",
                  dots.get("earth") == "rgb(203, 178, 122)", dots)

            # --- 2. start level = max(trained, baseline) -------------------
            # Fund the camp first (settle 320 legendaries = +5760 gems),
            # train ゆの (10000000) to Lv 40 (cost 1950), reload, select her
            # card, and check the spawned player's level.
            page.evaluate("""import('/site/game/rl/meta.js').then(m => {
                const meta = m.createMeta();
                meta.read();
                meta.settle({items: Array.from({length: 320},
                    () => ({rarity: 'legendary'}))});
                meta.train(10000000, 40);
            })""")
            page.evaluate("window.location.reload()")
            boot(page, port, url)
            page.wait_for_selector(".roster-card", timeout=20000)
            picked = page.evaluate("""(() => {
                // The roster card prints the character's Chinese name
                // (由乃); the model-key placeholder text was removed with the
                // card-art restyle (T21a).
                const els = Array.from(document.querySelectorAll('.roster-card'));
                const yuno = els.find(e => (e.textContent || '').includes('由乃'));
                (yuno || els[0]).click();
                return (yuno || els[0]).textContent.slice(0, 30);
            })()""")
            deadline = time.time() + 30
            lvl = None
            while time.time() < deadline:
                lvl = page.evaluate("""(() => {
                    const w = window.kirafanRL.world;
                    return w && w.player ? w.player.level : null;
                })()""")
                if lvl is not None and lvl > 1:
                    break
                page.wait_for_timeout(300)
            # volume 1 baseline plv is authored (20); trained 40 wins
            check("start level is max(trained 40, baseline)", lvl == 40,
                  "picked %s, level %s" % (picked[:20], lvl))
            # v1_open is up at boot and freezes the world, so the death
            # funnel needs the dialogue dismissed first (T12 wiring).
            for _ in range(90):
                vis = page.evaluate(
                    "(() => { const b = document.getElementById('dialogue-box');"
                    " return !!(b && b.style.display !== 'none'); })()")
                if not vis:
                    break
                page.evaluate("document.getElementById('dialogue-box').click()")
                page.wait_for_timeout(90)

            # --- 3. death settle -> gems persist ---------------------------
            # Kill the player through the real funnel: an enemy bullet rides
            # danmaku -> onHit -> tryHit -> pushHit -> the "died" event that
            # settleRun hangs off of. (tryHit by import would skip the events.)
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const p = w.player;
                p.equipment.push({slot: 'charm', rarity: 'legendary', affixes: []});
                p.iframes = 0;
                const angle = 0;   // bullet spawns at the player, any angle hits
                w.danmaku.emit('aimed', {x: p.x - 3, y: p.y, angle: angle},
                    {side: 'enemy', power: 9999999, coef: 1, count: 1,
                     speed: 10, life: 4});
            })()""")
            gems0 = page.evaluate(
                "import('/site/game/rl/meta.js').then(m => m.createMeta().read().gems)")
            deadline = time.time() + 15
            hint = ""
            while time.time() < deadline:
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(30)
                hint = page.evaluate(
                    "document.getElementById('hint').textContent || ''")
                if "星彩石" in hint:
                    break
            gems1 = page.evaluate(
                "import('/site/game/rl/meta.js').then(m => m.createMeta().read().gems)")
            dead = page.evaluate(
                "window.kirafanRL.world.player.dead")
            # 1 legendary = 60 value x 0.3 = 18
            check("player actually died through the funnel", bool(dead))
            check("death beat mentions 星彩石", "星彩石" in hint, hint[:60])
            check("settle credits 18 gems (1 legendary)", gems1 == gems0 + 18,
                  "%d -> %d" % (gems0, gems1))

            # --- 4. legacy 残片 save migrates ------------------------------
            legacy_context = browser.new_context()
            legacy_context.add_init_script("localStorage.setItem('kirafan-rl:meta',JSON.stringify({shards:42,prologueSeen:true,tutorialSeen:true}));")
            legacy_page = legacy_context.new_page()
            legacy_page.on("pageerror", lambda error: errors.append(str(error)))
            legacy_page.goto(url, wait_until="load")
            legacy_page.wait_for_selector(".roster-card", timeout=40000)
            legacy = legacy_page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).meta.gems")
            check("legacy 残片 slot migrates to 42 gems", legacy == 42, legacy)
            check("legacy 残片 source bytes remain preserved", legacy_page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:meta')).shards") == 42)
            legacy_context.close()

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
