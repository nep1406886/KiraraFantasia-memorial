# Browser diagnostic for the stun gauge (spec/04 §11), driven through the
# same code paths a player uses. Verifies the graze removal left no dangling
# references (module import, HUD node) and that stun fills/trips in the real
# page. Not a gate -- a repro driver.
# Usage: python tools/rl_stun_browser.py [port]
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8951
    url = "http://127.0.0.1:%d/site/game/roguelike.html" % port
    result = {"console": [], "errors": []}
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("console", lambda m: result["console"].append(m.type + ": " + m.text))
        page.on("pageerror", lambda e: result["errors"].append(str(e)))
        page.on("requestfailed", lambda r: result["errors"].append(
            "REQFAIL " + r.url + " " + str(r.failure)))
        page.goto(url, wait_until="load", timeout=60000)

        deadline = time.time() + 40
        while time.time() < deadline:
            if page.evaluate("!!window.kirafanRL"):
                break
            page.wait_for_timeout(200)
        try:
            page.wait_for_selector(".roster-card", timeout=15000)
            page.query_selector(".roster-card").click()
        except Exception as e:
            print("no roster: %s" % e)
        for _ in range(60):
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(10)
        # T12 wired later than this gate: v1_open is up at boot and freezes
        # the world, so the stun bullets need it dismissed first.
        for _ in range(90):
            vis = page.evaluate(
                "(() => { const b = document.getElementById('dialogue-box');"
                " return !!(b && b.style.display !== 'none'); })()")
            if not vis:
                break
            page.evaluate("document.getElementById('dialogue-box').click()")
            page.wait_for_timeout(90)

        def ev(js):
            return page.evaluate(js)

        # The start room need not be a fight; a battle room guarantees enemies.
        ev("""(() => {
            const w = window.kirafanRL.world;
            const battle = w.dungeon.rooms.find(r => r.type === 'battle');
            if (battle) { w.enterRoom(battle.id, 'S'); }
            for (let i = 0; i < 30; i++) window.kirafanRL.step(1/60);
        })()""")

        print("=== 1. graze removal is clean ===")
        r = ev("""(() => {
            return {
                grazeNode: !!document.getElementById('graze-display'),
                grazeCountNode: !!document.getElementById('graze-count'),
                coinNode: !!document.getElementById('coin-display')
            };
        })()""")
        print(str(r).encode("ascii", "replace").decode())
        ok_removed = (not r.get("grazeNode") and not r.get("grazeCountNode")
                      and r.get("coinNode"))
        print("GRAZE-REMOVED " + ("OK" if ok_removed else "FAIL"))

        print("=== 2. one player bullet fills the gauge ===")
        r = ev("""(() => {
            const w = window.kirafanRL.world;
            const p = w.player;
            // A dedicated target beside the player: in a populated room the
            // room's own enemies would absorb the bullets first.
            const foe = w.spawnEnemy({x: p.x + 2, y: p.y, hp: 10000, atk: 0,
                                      aiType: 'sentry'});
            window.__stunFoe = foe;    // checks 3/4 reuse this exact enemy
            const angle = 0;
            w.danmaku.emit('aimed', {x: p.x, y: p.y, angle: angle},
                {side: 'player', power: 10, coef: 1, count: 1,
                 speed: 10, life: 4});
            for (let i = 0; i < 60; i++) window.kirafanRL.step(1/60);
            return {stun: foe.stun, hp: foe.hp, dead: foe.dead};
        })()""")
        print(str(r).encode("ascii", "replace").decode())
        ok_fill = r.get("stun", 0) > 0
        print("STUN-FILL " + ("OK" if ok_fill else "FAIL"))

        print("=== 3. enough bullets trip the stun window ===")
        r = ev("""(() => {
            const w = window.kirafanRL.world;
            const p = w.player;
            const foe = window.__stunFoe;
            if (!foe || foe.dead) return {error: 'no test enemy'};
            const angle = 0;
            w.danmaku.emit('aimed', {x: p.x, y: p.y, angle: angle},
                {side: 'player', power: 1, coef: 0.01, count: 20,
                 speed: 10, life: 4, stepDelay: 0.02});
            let stunned = false;
            for (let i = 0; i < 120; i++) {
                window.kirafanRL.step(1/60);
                stunned = stunned || foe.stunTimer > 0;
            }
            return {stunned: stunned, timer: foe.stunTimer,
                    hp: foe.hp, dead: foe.dead};
        })()""")
        print(str(r).encode("ascii", "replace").decode())
        ok_trip = r.get("stunned") and r.get("hp", 0) > 0
        print("STUN-TRIP " + ("OK" if ok_trip else "FAIL"))

        print("=== 4. stun event reaches the view (beat line) ===")
        r = ev("""(() => {
            const w = window.kirafanRL.world;
            const p = w.player;
            const foe = window.__stunFoe;
            if (!foe || foe.dead) return {error: 'no test enemy'};
            const angle = 0;
            // One hit from tripping: the next landed hit must stun, and the
            // main loop's beat line (the #hint element) is where the view
            // acknowledges it. kirafanRL.step drains the event queue itself,
            // so the beat text is the observable. Check 3 left the enemy
            // inside a stun window -- a hit during the window must NOT
            // re-trip (spec/04 §11), so let it expire first.
            for (let i = 0; i < 60 * 4; i++) window.kirafanRL.step(1/60);
            if (foe.stunTimer > 0) return {error: 'stun window did not expire'};
            // The room's own sentries roam, and one parked in the east line
            // absorbs the burst before it reaches the test enemy (the
            // section-2 comment's hazard, arrived four seconds later). Clear
            // them, pin the test enemy back beside the player, then fire.
            w.enemies = w.enemies.filter(function (e) { return e === foe; });
            foe.x = p.x + 2; foe.y = p.y;
            foe.stun = 95;
            w.danmaku.emit('aimed', {x: p.x, y: p.y, angle: angle},
                {side: 'player', power: 1, coef: 0.01, count: 2,
                 speed: 10, life: 4, stepDelay: 0.02});
            for (let i = 0; i < 30; i++) {
                window.kirafanRL.step(1/60);
            }
            const hint = document.getElementById('hint').textContent;
            return {timer: foe.stunTimer, hint: hint};
        })()""")
        print(str(r).encode("ascii", "replace").decode())
        ok_event = r.get("timer", 0) > 0 and "眩晕" in (r.get("hint") or "")
        print("STUN-EVENT " + ("OK" if ok_event else "FAIL"))

        print("=== 5. drive 300 steps for stability ===")
        for _ in range(300):
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(5)

        print("=== pageerrors ===")
        for e in result["errors"]:
            print(e[:1500])
        print("=== console (error/warning) ===")
        for c in result["console"]:
            if c.startswith("error") or c.startswith("warning"):
                print(c[:1500])
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
