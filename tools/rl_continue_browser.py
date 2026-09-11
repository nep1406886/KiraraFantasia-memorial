# Browser check for 局内续档 (run persistence across reload, plan 阶段 5's
# deferred item):
#   A. progress made in a run (floor/level/exp/hp/gauge/coin/equipment) is
#      captured by the 5-second game-time autosave
#   B. after a reload the roster offers #roster-continue, and resuming
#      restores every field and rebuilds the SAVED floor (not floor 1),
#      without replaying the volume opening
#   C. picking a normal roster card instead abandons the snapshot
#   D. dying clears the snapshot, so a later reload offers no continue
# Owns its server. Usage: python tools/rl_continue_browser.py [port]
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
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            break
        page.wait_for_timeout(200)


def wait_player(page, timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        has = page.evaluate(
            "!!(window.kirafanRL.world && window.kirafanRL.world.player)")
        if has:
            return True
        page.wait_for_timeout(200)
    return False


def dismiss_dialogue(page):
    for _ in range(90):
        vis = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " return !!(b && b.style.display !== 'none'); })()")
        if not vis:
            return
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)


def park(page):
    # Every poll here is real seconds of live world; park the run so nothing
    # eats the player mid-gate (same hardening as the us gate).
    page.evaluate("""(() => {
        const w = window.kirafanRL.world;
        w.enemies.forEach(e => { e.actionTimer = 1e9; });
        if (w.player) { w.player.iframes = 1e9; }
    })()""")


def run_slot(page):
    from rl_result_browser import slot
    return slot(page)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8969
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
        # No ?volume: the boot volume must come from the snapshot after the
        # reload in phase B (a plain reload is the player's path).
        url = "http://127.0.0.1:%d/site/game/roguelike.html" % port
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                      "--autoplay-policy=no-user-gesture-required"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            # --- A. progress + autosave -----------------------------------
            boot(page, port, url)   # new browser context is already an empty save
            page.wait_for_selector(".roster-card", timeout=20000)
            check("fresh storage offers no continue button",
                  not page.evaluate("!!document.getElementById('roster-continue')"))
            page.evaluate("document.querySelector('.roster-card').click()")
            check("player booted", wait_player(page))
            dismiss_dialogue(page)
            park(page)

            # A real affix id, so the resumed equipment runs through
            # applyEquipment/passiveRuntime like a genuine drop would.
            affix = page.evaluate("""fetch('/site/asset/rl/weapons-rl.json')
                .then(r => r.json())
                .then(w => Object.keys(w.passives)[0])""")
            page.evaluate("""async (affix) => {
                const w = window.kirafanRL.world;
                const p = w.player;
                const {generateDungeon} = await import('/site/game/rl/dungeon.js');
                const {layoutSeedFor} = await import('/site/game/rl/runschema.js');
                const seed = JSON.parse(localStorage.getItem('kirafan-rl:profile')).run.seed;
                w.floor = 7;
                // v3 validates all room-claim IDs against this floor's layout.
                // Changing only floor can retain 9 old IDs over a new 6-room
                // layout, correctly rejecting the fixture for some seeds.
                w.setDungeon(generateDungeon(layoutSeedFor(seed, 7), {roomsMin: 6, roomsMax: 9}));
                p.level = 9;
                p.exp = 123;
                p.hp = 555;
                p.skills.addGauge(Math.round(p.skills.gaugeMax / 2));
                w.coin = 77;
                p.equipment = [{ slot: 'charm', rarity: 'epic',
                                 affixes: [affix] }];
            }""", affix)
            # 6 s of game time > the 5 s autosave interval
            for _ in range(24):
                page.evaluate("window.kirafanRL.step(0.25)")
            snap = run_slot(page)
            check("autosave wrote a run snapshot", snap is not None)
            if snap:
                check("snapshot carries the mutated run",
                      snap["floor"] == 7 and snap["level"] == 9
                      and snap["exp"] == 123 and snap["hp"] == 555
                      and snap["coin"] == 77
                      and len(snap["equipment"]) == 1,
                      "floor=%s lv=%s exp=%s hp=%s coin=%s eq=%s"
                      % (snap["floor"], snap["level"], snap["exp"],
                         snap["hp"], snap["coin"], len(snap["equipment"])))

            # --- B. reload + resume ---------------------------------------
            boot(page, port, url)
            page.wait_for_selector(".roster-card", timeout=20000)
            check("reload offers the continue button",
                  page.evaluate("!!document.getElementById('roster-continue')"))
            page.evaluate("document.getElementById('roster-continue').click()")
            check("resume boots the player", wait_player(page))
            park(page)
            resumed = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const p = w.player;
                return { floor: w.floor, level: p.level, exp: p.exp,
                         hp: p.hp, hpmax: p.maxHp,
                         gauge: p.skills.gauge, max: p.skills.gaugeMax,
                         coin: w.coin, eq: p.equipment,
                         rooms: w.dungeon ? w.dungeon.rooms.length : 0,
                         hud: document.getElementById('floor-display').textContent };
            })()""")
            check("resumed at the saved floor (7), not floor 1",
                  resumed["floor"] == 7 and resumed["rooms"] >= 6,
                  "floor=%s rooms=%s" % (resumed["floor"], resumed["rooms"]))
            check("HUD shows the resumed floor",
                  "7" in (resumed["hud"] or ""), resumed["hud"])
            check("level/exp restored", resumed["level"] == 9 and resumed["exp"] == 123,
                  "lv=%s exp=%s" % (resumed["level"], resumed["exp"]))
            check("hp restored (clamped to the re-derived max)",
                  resumed["hp"] == min(555, resumed["hpmax"]),
                  "%s (max %s)" % (resumed["hp"], resumed["hpmax"]))
            check("gauge restored",
                  0 < resumed["gauge"] <= resumed["max"],
                  "%s / %s" % (resumed["gauge"], resumed["max"]))
            check("coins restored", resumed["coin"] == 77, resumed["coin"])
            check("equipment restored",
                  len(resumed["eq"]) == 1 and resumed["eq"][0]["slot"] == "charm"
                  and len(resumed["eq"][0]["affixes"]) == 1,
                  resumed["eq"])
            # The volume opening belongs to the first boot only: after the
            # prologue (seen in meta from phase A) nothing may queue.
            page.wait_for_timeout(800)
            check("resume does not replay the volume opening",
                  page.evaluate("""(() => {
                      const b = document.getElementById('dialogue-box');
                      return !(b && b.style.display !== 'none');
                  })()"""))
            check("no pageerrors after resume", not errors, errors[:3])

            # --- C. a normal pick abandons the snapshot -------------------
            previous_run_id = page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).runId")
            boot(page, port, url)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.evaluate("document.querySelector('.roster-card').click()")
            check("fresh pick boots the player", wait_player(page))
            fresh = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                return { floor: w.floor, level: w.player.level,
                         baseline: w.encounter && w.encounter.playerLevel || 1,
                         hp: w.player.hp, max: w.player.maxHp,
                         eq: w.player.equipment.length };
            })()""")
            check("fresh run starts at floor 1, clean slate",
                  fresh["floor"] == 1
                  and fresh["level"] == max(fresh["baseline"], 1)
                  and fresh["hp"] == fresh["max"] and fresh["eq"] == 0,
                  "floor=%s lv=%s (baseline %s) hp=%s/%s eq=%s"
                  % (fresh["floor"], fresh["level"], fresh["baseline"],
                     fresh["hp"], fresh["max"], fresh["eq"]))
            fresh_snapshot = run_slot(page)
            check("picking a card replaces the stale checkpoint with a newly bound run",
                  fresh_snapshot is not None and fresh_snapshot["floor"] == 1
                  and fresh_snapshot["equipment"] == []
                  and page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).runId") != previous_run_id)

            # --- D. death clears the snapshot ------------------------------
            dismiss_dialogue(page)
            park(page)
            # Kill through the real funnel (danmaku -> tryHit -> pushHit ->
            # the "died" event clearRun hangs off of) — same trick as the
            # meta gate, because nothing else produces the death event.
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const p = w.player;
                p.iframes = 0;
                w.danmaku.emit('aimed', {x: p.x - 3, y: p.y, angle: 0},
                    {side: 'enemy', power: 9999999, coef: 1, count: 1,
                     speed: 10, life: 4});
            })()""")
            deadline = time.time() + 15
            dead = False
            while time.time() < deadline:
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(30)
                dead = page.evaluate("window.kirafanRL.world.player.dead")
                if dead:
                    break
            check("player dies through the damage funnel", dead)
            check("death cleared the run snapshot", run_slot(page) is None)
            receipt = page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).lastResult")
            boot(page, port, url)
            page.wait_for_selector("#rl-result[open]", timeout=20000)
            check("death reload restores the same receipt without resurrecting combat",
                  page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).lastResult") == receipt
                  and page.evaluate("!window.kirafanRL.world.player"))
            page.locator("#result-restart").click()
            page.wait_for_selector(".roster-card", timeout=20000)
            check("no continue button after the death reload",
                  not page.evaluate("!!document.getElementById('roster-continue')"))

            check("no pageerrors overall", not errors, errors[:3])
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
