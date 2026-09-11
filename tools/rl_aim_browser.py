# Browser gate for T22k 键鼠联动: the mouse aim channel drives attack facing.
#
#   1. boot + battle room; the pointer NDC latch starts inactive
#   2. mouse move over the canvas → input.state.pointer goes active with NDC
#      in -1..1, and world.aim lands on the ground plane (y≈0, finite)
#   3. attack with the cursor parked right of the player → the swing's facing
#      points at the cursor (≈ 0 rad), NOT at the stale last facing
#   4. aim priority over movement: holding D (move facing 0) while the cursor
#      sits north → facing is north (≈ -π/2; world y+ is screen-down, so
#      atan2(dy,dx) of a northern aim is NEGATIVE π/2)
#   5. cursor parked on the player → aim is zero-length, aimFacingFor yields
#      null, the swing keeps the last movement facing
#   6. pointer active=false (mouseleave) → movement facing again
#   7. no page errors / console errors
#
# Three gate-side traps this file is written against (all measured):
#   - the canvas is NOT at the viewport origin (a HUD bar above #stage): every
#     projected NDC→mouse coordinate conversion must add rect.left/rect.top,
#     or the cursor lands 40 px north of where the check thinks it is;
#   - the rig lens is ORTHOGRAPHIC (view/camera.js): screen-up maps to world
#     -y, so "north" expectations must use -π/2, never +π/2;
#   - the swing has a 0.38 s re-arm window: a check that fires two swings
#     closer than that silently no-ops (facing unchanged) — every swing here
#     settles ≥ 0.6 s first and asserts swingId actually incremented.
#
# rAF is stubbed once the first room is reached: all later driving goes through
# window.kirafanRL.step(), so the real clock cannot advance frames between the
# cursor park and the swing.
#
# Owns its server. Usage: python tools/rl_aim_browser.py [port]
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            break
        page.wait_for_timeout(200)


def dismiss_dialogue(page):
    # Two races to survive, both observed as "every swing check no-ops with
    # a stale facing" (6 phantom failures, zero console errors):
    #   - on a slow boot the opening box opens AFTER the first poll: a
    #     dismissal that returns before it exists leaves the world frozen;
    #   - between queued dialogue nodes the box hides for a microtask while
    #     world.frozen is still true — exiting on visibility alone stops
    #     there. So: wait for the box, then click until hidden AND unfrozen.
    deadline = time.time() + 15
    while time.time() < deadline:
        if page.evaluate(
                "(() => { const b = document.getElementById('dialogue-box');"
                " return !!(b && b.style.display !== 'none'); })()"):
            break
        page.wait_for_timeout(100)
    for _ in range(120):
        state = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " const w = window.kirafanRL && window.kirafanRL.world;"
            " return { vis: !!(b && b.style.display !== 'none'),"
            "          frozen: !!(w && w.frozen) }; })()")
        if not state["vis"] and not state["frozen"]:
            return True
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)
    return False


def angle_diff(a, b):
    return math.degrees(abs((a - b + math.pi) % (2 * math.pi) - math.pi))


# In-page: project the player's GROUND point (y=0 — the aim plane) to
# viewport coordinates, canvas rect offset included. The lens is ortho, so
# the view→clip mapping is affine (w=1): no perspective divide.
PROJ_PLAYER = """(() => {
    const rl = window.kirafanRL;
    const cam = rl.camera;
    cam.updateMatrixWorld();
    const p = rl.world.player;
    const e = cam.matrixWorldInverse.elements;
    const vx = e[0]*p.x + e[8]*p.y + e[12];
    const vy = e[1]*p.x + e[9]*p.y + e[13];
    const pe = cam.projectionMatrix.elements;
    const cx = pe[0]*vx + pe[12];
    const cy = pe[5]*vy + pe[13];
    const canvas = document.querySelector('#stage canvas');
    const r = canvas.getBoundingClientRect();
    return {
        sx: (cx * 0.5 + 0.5) * r.width + r.left,
        sy: (1 - (cy * 0.5 + 0.5)) * r.height + r.top
    };
})()"""

# Settle the swing cooldown / state machine (0.67 s > the 0.38 s re-arm),
# then fire one attack and report the facing. Returns {fired, facing}:
# fired=false means the swing never left the ground (cooldown) and the
# caller must not trust the angle.
SETTLE = ("for (let i = 0; i < 40; i++) { window.kirafanRL.step(1/60); }")
FIRE_SWING = """(() => {
    const rl = window.kirafanRL;
    const before = rl.world.player.swingId;
    rl.input.state.attack = true;
    rl.step(1/60);
    rl.input.state.attack = false;
    return { fired: rl.world.player.swingId === before + 1,
             facing: rl.world.player.facing };
})()"""


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8979
    import subprocess
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
            console_errors = []
            page.on("console", lambda m: console_errors.append(m.text)
                    if m.type == "error" else None)

            boot(page, url)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.click(".roster-card")
            dismissed = dismiss_dialogue(page)
            check("boot dialogue dismissed, world unfrozen", dismissed)
            deadline = time.time() + 30
            while time.time() < deadline:
                if page.evaluate(
                        "window.kirafanRL && window.kirafanRL.world"
                        " && window.kirafanRL.world.room"):
                    break
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(30)
            check("first room reached", page.evaluate(
                "!!(window.kirafanRL && window.kirafanRL.world"
                " && window.kirafanRL.world.room)"))

            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                if (w.player) { w.player.iframes = 1e9; }
                const battle = w.dungeon.rooms.find(r => r.type === 'battle');
                if (!battle) { throw new Error('no battle room'); }
                w.enterRoom(battle.id, 'S');
            })()""")
            # rAF off from here: the page clock must not run frames the gate
            # cannot see between a cursor park and its swing.
            page.evaluate(
                "window.requestAnimationFrame = function () { return 0; }")
            # 1 s of steps: room entry settles, follow camera eases onto the
            # player (stiffness 6 → residual offset < 0.3%).
            page.evaluate(
                "for (let i = 0; i < 60; i++) { window.kirafanRL.step(1/60); }")

            # --- 1. pointer latch starts inactive -------------------------
            # A real click already swept the pointer across the page (the
            # roster card click), so the honest check is: mouseleave clears
            # the latch back to inactive.
            page.evaluate("document.dispatchEvent(new Event('mouseleave'))")
            page.evaluate("window.kirafanRL.step(1/60)")
            check("pointer latch inactive after mouseleave", page.evaluate(
                "window.kirafanRL.input.state.pointer.active === false"))

            # --- 2. mouse move activates the aim channel ------------------
            page.mouse.move(900, 200)   # upper-right of the stage
            page.evaluate("window.kirafanRL.step(1/60)")
            aim1 = page.evaluate("""(() => {
                const p = window.kirafanRL.input.state.pointer;
                const w = window.kirafanRL.world;
                return { px: p.x, py: p.y, active: p.active,
                         aim: w.aim, player: w.player
                             ? { x: w.player.x, y: w.player.y } : null };
            })()""")
            check("pointer latches on move", aim1["active"], aim1)
            check("NDC within range",
                  -1 <= aim1["px"] <= 1 and -1 <= aim1["py"] <= 1, aim1)
            check("world.aim finite on ground plane",
                  aim1["aim"] is not None
                  and abs(aim1["aim"]["x"]) < 200
                  and abs(aim1["aim"]["y"]) < 200, aim1["aim"])
            check("aim lands north-east of player (upper-right cursor)",
                  aim1["aim"] and aim1["player"]
                  and aim1["aim"]["x"] > aim1["player"]["x"]
                  and aim1["aim"]["y"] < aim1["player"]["y"], aim1)

            # --- 3. swing tracks the cursor -------------------------------
            # Stale facing west, cursor parked 200 px east of the player's
            # projected feet; the swing must face east (0 rad).
            page.evaluate(SETTLE)
            page.evaluate("window.kirafanRL.world.player.facing = Math.PI")
            scr = page.evaluate(PROJ_PLAYER)
            page.mouse.move(scr["sx"] + 200, scr["sy"])
            page.evaluate("window.kirafanRL.step(1/60)")
            swing = page.evaluate(FIRE_SWING)
            check("swing fired (cooldown settled)", swing["fired"], swing)
            check("swing faces the cursor (east ≈ 0)",
                  swing["fired"] and angle_diff(swing["facing"], 0.0) < 12,
                  swing)

            # --- 4. aim beats movement -------------------------------------
            # Hold D (movement facing 0) while the cursor sits due north of
            # the player; the swing must face north (≈ -π/2 — world y+ is
            # screen-down), not 0. The settle runs BEFORE the walk: a held D
            # through the settle would walk the player away from the parked
            # cursor and stale the aim by ~120°.
            page.evaluate(SETTLE)
            page.evaluate(
                "window.kirafanRL.input.state.move.x = 1")
            page.evaluate(
                "for (let i = 0; i < 5; i++) { window.kirafanRL.step(1/60); }")
            scr_n = page.evaluate(PROJ_PLAYER)   # player walked: re-project
            page.mouse.move(scr_n["sx"], scr_n["sy"] - 220)
            page.evaluate("window.kirafanRL.step(1/60)")
            swing2 = page.evaluate(FIRE_SWING)
            page.evaluate("window.kirafanRL.input.state.move.x = 0")
            check("second swing fired", swing2["fired"], swing2)
            check("aim beats movement (north ≈ -π/2, not east)",
                  swing2["fired"]
                  and angle_diff(swing2["facing"], -math.pi / 2) < 12,
                  swing2)

            # --- 5. cursor on the player → last movement facing ------------
            # Walk east so movement sets facing = 0, stop (facing persists
            # through idle), park the cursor exactly on the player's feet:
            # the aim is zero-length, aimFacingFor yields null and the swing
            # keeps the last movement facing instead of snapping. The settle
            # runs first so check 4's swing commitment is over — walking
            # during the attack state neither moves nor re-faces the player.
            page.evaluate(SETTLE)
            page.evaluate(
                "window.kirafanRL.input.state.move.x = 1")
            page.evaluate(
                "for (let i = 0; i < 8; i++) { window.kirafanRL.step(1/60); }")
            page.evaluate(
                "window.kirafanRL.input.state.move.x = 0")
            page.evaluate(
                "for (let i = 0; i < 10; i++) { window.kirafanRL.step(1/60); }")
            scr_p = page.evaluate(PROJ_PLAYER)
            page.mouse.move(scr_p["sx"], scr_p["sy"])
            page.evaluate("window.kirafanRL.step(1/60)")
            near = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                if (!w.aim || !w.player) { return null; }
                return Math.hypot(w.aim.x - w.player.x, w.aim.y - w.player.y);
            })()""")
            check("cursor on player → aim is zero-length (< 0.06)",
                  near is not None and near < 0.06, near)
            swing3 = page.evaluate(FIRE_SWING)
            check("third swing fired", swing3["fired"], swing3)
            check("cursor on player → keeps movement facing (east ≈ 0)",
                  swing3["fired"]
                  and angle_diff(swing3["facing"], 0.0) < 12, swing3)

            # --- 6. mouseleave deactivates ---------------------------------
            page.evaluate("document.dispatchEvent(new Event('mouseleave'))")
            page.evaluate("window.kirafanRL.step(1/60)")
            check("mouseleave clears the latch", page.evaluate(
                "window.kirafanRL.input.state.pointer.active === false"
                " && window.kirafanRL.world.aim === null"))

            check("no page errors", not errors, errors[:2])
            check("no console errors", not console_errors,
                  console_errors[:2])
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()

    print("RESULT " + ("PASS" if fails == 0 else "FAIL (%d)" % fails))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
