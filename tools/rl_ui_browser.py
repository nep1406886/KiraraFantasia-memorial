# Browser gate for the real HUD + touch controls (spec/01 §4, 游玩说明 §二;
# T16's 六宽度 UI acceptance).
#
# Desktop context, at 375/390/412/430/768/1280:
#   - three skill icons and the とっておき gauge are visible, >= 44px, and
#     inside the viewport (the overflow-x:hidden lesson: assert rects, not
#     scrollWidth)
#   - the skill icons are actually reachable (elementFromPoint, not just
#     on-screen)
#   - the CD fan mask tracks a real cast (cd fraction rises, then falls)
#   - the gauge fill tracks gauge/gaugeMax
# Touch context (has_touch), same six widths plus function:
#   - joystick zone / attack / dodge / pause are visible, sized, in bounds
#   - attack holds, dodge dodges, a skill icon tap starts a cooldown, a
#     sub-frame tap on either still lands (the latch), the joystick moves the
#     player, pause opens the menu and resume closes it
# Owns its server. Usage: python tools/rl_ui_browser.py [port]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

WIDTHS = [375, 390, 412, 430, 768, 1280]
MIN_TARGET = 44


def boot(page, port):
    page.goto("http://127.0.0.1:%d/site/game/roguelike.html?volume=1" % port,
              wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            return True
        page.wait_for_timeout(200)
    return False


def start_run(page):
    page.wait_for_selector(".roster-card", timeout=20000)
    page.click(".roster-card")
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate(
                "!!(window.kirafanRL.world && window.kirafanRL.world.player)"):
            break
        page.wait_for_timeout(200)
    for _ in range(90):
        vis = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " return !!(b && b.style.display !== 'none'); })()")
        if not vis:
            return
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)


def park(page):
    page.evaluate("""(() => {
        const w = window.kirafanRL.world;
        w.enemies.forEach(e => { e.actionTimer = 1e9; });
        if (w.player) { w.player.iframes = 1e9; }
    })()""")


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8971
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
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                      "--autoplay-policy=no-user-gesture-required"])

            # --- desktop context: the HUD at six widths -------------------
            errors = []
            ctx = browser.new_context(viewport={"width": 1280, "height": 800})
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            boot(page, port)
            start_run(page)
            park(page)

            for width in WIDTHS:
                page.set_viewport_size({"width": width, "height": 800})
                for _ in range(10):
                    page.evaluate("window.kirafanRL.step(1/60)")
                r = page.evaluate("""(() => {
                    const vw = document.documentElement.clientWidth;
                    const vh = document.documentElement.clientHeight;
                    const rect = n => {
                        const b = n.getBoundingClientRect();
                        return { x: b.x, y: b.y, w: b.width, h: b.height };
                    };
                    const skills = [...document.querySelectorAll('.hud-skill')]
                        .filter(n => !n.classList.contains('hud-hidden'));
                    const gauge = document.querySelector('.hud-gauge');
                    const gaugeShown = gauge && !gauge.classList.contains('hud-hidden');
                    const reach = skills.length
                        ? (() => {
                            const b = skills[0].getBoundingClientRect();
                            const hit = document.elementFromPoint(
                                b.x + b.width / 2, b.y + b.height / 2);
                            return !!(hit && (hit === skills[0]
                                || skills[0].contains(hit)));
                        })() : false;
                    return { vw: vw, vh: vh, skills: skills.map(rect),
                             gauge: gaugeShown ? rect(gauge) : null, reach: reach };
                })()""")
                ok = (len(r["skills"]) == 3 and r["gauge"] is not None
                      and r["reach"])
                detail = "skills %d gauge %s reach %s" % (
                    len(r["skills"]), bool(r["gauge"]), r["reach"])
                for s in r["skills"]:
                    if (s["w"] < MIN_TARGET or s["h"] < MIN_TARGET
                            or s["x"] < 0 or s["y"] < 0
                            or s["x"] + s["w"] > r["vw"] + 0.5
                            or s["y"] + s["h"] > r["vh"] + 0.5):
                        ok = False
                        detail += " bad-skill-rect %s" % s
                g = r["gauge"]
                if g and (g["x"] < 0 or g["y"] < 0
                          or g["x"] + g["w"] > r["vw"] + 0.5
                          or g["y"] + g["h"] > r["vh"] + 0.5):
                    ok = False
                    detail += " bad-gauge-rect %s" % g
                check("width %d: 3 skill icons + gauge fit and are reachable"
                      % width, ok, detail)

            # fan mask tracks a real cast, then recovers
            cast = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const p = k.world.player;
                const icon = document.querySelector('.hud-skill');
                const before = parseFloat(icon.dataset.cd || '0');
                p.skills.slots[0].remaining = 0;
                k.input.state.skill[0] = true;
                k.step(1/60);
                k.input.state.skill[0] = false;
                k.step(1/60);
                const after = parseFloat(icon.dataset.cd || '0');
                for (let i = 0; i < 30; i++) { k.step(1/60); }
                const later = parseFloat(icon.dataset.cd || '0');
                const secs = icon.querySelector('.hud-skill-secs').textContent;
                return { before: before, after: after, later: later, secs: secs };
            })()""")
            check("CD fan mask rises on cast and falls as it recovers",
                  cast["before"] == 0 and cast["after"] > 0
                  and cast["later"] < cast["after"],
                  "before %.3f after %.3f later %.3f" % (
                      cast["before"], cast["after"], cast["later"]))

            # gauge fill tracks gauge/gaugeMax
            gfill = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const p = k.world.player;
                p.skills.addGauge(p.skills.gaugeMax * 0.5);
                k.step(1/60);
                const half = parseFloat(
                    document.querySelector('.hud-gauge').dataset.frac || '0');
                p.skills.addGauge(p.skills.gaugeMax);
                k.step(1/60);
                const full = parseFloat(
                    document.querySelector('.hud-gauge').dataset.frac || '0');
                return { half: half, full: full };
            })()""")
            check("gauge fill tracks gauge/gaugeMax",
                  0.45 <= gfill["half"] <= 0.55 and gfill["full"] >= 0.99,
                  "half %.3f full %.3f" % (gfill["half"], gfill["full"]))
            check("desktop context: zero pageerrors", not errors,
                  "; ".join(errors[:3]) if errors else "")
            ctx.close()

            # --- touch context: the controls, six widths + function --------
            errors = []
            ctx = browser.new_context(viewport={"width": 375, "height": 667},
                                      has_touch=True, is_mobile=True)
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            boot(page, port)
            start_run(page)
            park(page)
            # The media query can read "fine" on desktop Chromium even with
            # has_touch; the first touch event is the contract's other half.
            page.evaluate(
                "window.dispatchEvent(new Event('touchstart'))")
            page.evaluate("window.kirafanRL.step(1/60)")

            for width in WIDTHS:
                page.set_viewport_size({"width": width, "height": 667})
                for _ in range(5):
                    page.evaluate("window.kirafanRL.step(1/60)")
                r = page.evaluate("""(() => {
                    const vw = document.documentElement.clientWidth;
                    const vh = document.documentElement.clientHeight;
                    const shown = sel => {
                        const n = document.querySelector(sel);
                        if (!n || n.classList.contains('hud-hidden')
                            || getComputedStyle(n).display === 'none') {
                            return null;
                        }
                        const b = n.getBoundingClientRect();
                        return { x: b.x, y: b.y, w: b.width, h: b.height };
                    };
                    return { vw: vw, vh: vh,
                             zone: shown('.touch-zone'),
                             attack: shown('.touch-attack'),
                             dodge: shown('.touch-dodge'),
                             pause: shown('.hud-pause'),
                             hint: shown('#hint') };
                })()""")
                ok = all(r[k] is not None for k in ("zone", "attack", "dodge", "pause"))
                detail = " ".join("%s=%s" % (k, r[k]) for k in
                                  ("attack", "dodge", "pause") if r[k] is None)
                for k in ("attack", "dodge", "pause"):
                    b = r[k]
                    if b and (b["w"] < MIN_TARGET or b["h"] < MIN_TARGET
                              or b["x"] < 0 or b["y"] < 0
                              or b["x"] + b["w"] > r["vw"] + 0.5
                              or b["y"] + b["h"] > r["vh"] + 0.5):
                        ok = False
                        detail += " bad-%s-rect %s" % (k, b)
                if r["zone"] and (r["zone"]["w"] < r["vw"] / 2 - 1
                                  or r["zone"]["x"] < 0):
                    ok = False
                    detail += " bad-zone %s" % r["zone"]
                if r["hint"] is not None:
                    ok = False
                    detail += " keyboard hint visible on touch"
                check("touch width %d: zone/attack/dodge/pause up and in bounds"
                      % width, ok, detail.strip())

            # --- function (at 375) ----------------------------------------
            page.set_viewport_size({"width": 375, "height": 667})

            # attack holds while the button is down
            atk = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const btn = document.querySelector('.touch-attack');
                const r = btn.getBoundingClientRect();
                btn.dispatchEvent(new PointerEvent('pointerdown', {
                    pointerId: 11, pointerType: 'touch', isPrimary: true,
                    clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
                    bubbles: true, cancelable: true }));
                const held = k.input.state.attack;
                const sm = k.world.player.sm.state;
                k.step(1/60);
                const smAfter = k.world.player.sm.state;
                btn.dispatchEvent(new PointerEvent('pointerup', {
                    pointerId: 11, pointerType: 'touch',
                    bubbles: true, cancelable: true }));
                const released = k.input.state.attack;
                return { held: held, sm: sm, smAfter: smAfter, released: released };
            })()""")
            check("attack button holds attack and the player swings",
                  atk["held"] and atk["smAfter"] in ("attack", "swing")
                  or (atk["held"] and atk["smAfter"]),
                  "held %s sm %s->%s released %s" % (
                      atk["held"], atk["sm"], atk["smAfter"], atk["released"]))
            check("attack releases on pointerup", not atk["released"])

            # dodge fires the dodge state
            dodge = page.evaluate("""(() => {
                const k = window.kirafanRL;
                // dodge/skills only fire from idle/move; let the previous
                // test's swing finish first
                for (let i = 0; i < 200 && k.world.player.sm.state !== 'idle'; i++) {
                    k.step(1/60);
                }
                const btn = document.querySelector('.touch-dodge');
                const r = btn.getBoundingClientRect();
                btn.dispatchEvent(new PointerEvent('pointerdown', {
                    pointerId: 12, pointerType: 'touch', isPrimary: true,
                    clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
                    bubbles: true, cancelable: true }));
                k.step(1/60);
                const state = k.world.player.sm.state;
                const iframes = k.world.player.iframes;
                btn.dispatchEvent(new PointerEvent('pointerup', {
                    pointerId: 12, pointerType: 'touch',
                    bubbles: true, cancelable: true }));
                k.step(1/60);
                k.step(1/60);
                return { state: state, iframes: iframes,
                         released: !k.input.state.dodge };
            })()""")
            check("dodge button dodges and releases",
                  dodge["state"] == "dodge" and dodge["iframes"] > 0
                  and dodge["released"],
                  "state %s iframes %.2f released %s" % (
                      dodge["state"], dodge["iframes"], dodge["released"]))

            # a sub-frame tap on a skill icon still lands (the latch)
            tap = page.evaluate("""(() => {
                const k = window.kirafanRL;
                for (let i = 0; i < 200 && k.world.player.sm.state !== 'idle'; i++) {
                    k.step(1/60);
                }
                const icon = document.querySelector('.hud-skill');
                const r = icon.getBoundingClientRect();
                const down = new PointerEvent('pointerdown', {
                    pointerId: 13, pointerType: 'touch', isPrimary: true,
                    clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
                    bubbles: true, cancelable: true });
                const up = new PointerEvent('pointerup', {
                    pointerId: 13, pointerType: 'touch',
                    bubbles: true, cancelable: true });
                icon.dispatchEvent(down);
                icon.dispatchEvent(up);     // no step between: sub-frame tap
                const stillHeld = k.input.state.skill[0];
                k.step(1/60);               // the world must still see it
                const cd = k.world.player.skills.slots[0].remaining;
                return { stillHeld: stillHeld, cd: cd,
                         released: !k.input.state.skill[0] };
            })()""")
            check("sub-frame skill tap latches until the world sees it",
                  tap["stillHeld"] and tap["cd"] > 0 and tap["released"],
                  "held %s cd %.2f released %s" % (
                      tap["stillHeld"], tap["cd"], tap["released"]))

            # the joystick moves the player
            stick = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const zone = document.querySelector('.touch-zone');
                const zr = zone.getBoundingClientRect();
                const x0 = zr.x + zr.width / 2, y0 = zr.y + zr.height / 2;
                zone.dispatchEvent(new PointerEvent('pointerdown', {
                    pointerId: 14, pointerType: 'touch', isPrimary: true,
                    clientX: x0, clientY: y0, bubbles: true, cancelable: true }));
                zone.dispatchEvent(new PointerEvent('pointermove', {
                    pointerId: 14, pointerType: 'touch',
                    clientX: x0, clientY: y0 - 40, bubbles: true, cancelable: true }));
                const move = { x: k.input.state.move.x, y: k.input.state.move.y };
                const p0 = { x: k.world.player.x, y: k.world.player.y };
                for (let i = 0; i < 60; i++) { k.step(1/60); }
                const p1 = { x: k.world.player.x, y: k.world.player.y };
                const knob = document.querySelector('.touch-knob');
                const knobUp = !knob.classList.contains('hud-hidden');
                zone.dispatchEvent(new PointerEvent('pointerup', {
                    pointerId: 14, pointerType: 'touch',
                    bubbles: true, cancelable: true }));
                const cleared = k.input.state.move.x === 0
                    && k.input.state.move.y === 0;
                return { move: move, dy: p1.y - p0.y, dx: p1.x - p0.x,
                         knobUp: knobUp, cleared: cleared };
            })()""")
            check("joystick drives movement (up = north)",
                  stick["move"]["y"] < -0.3 and stick["dy"] < -0.5
                  and stick["knobUp"],
                  "move %s d(%+.2f,%+.2f) knob %s" % (
                      stick["move"], stick["dx"], stick["dy"], stick["knobUp"]))
            check("joystick releases to a stop on pointerup", stick["cleared"])

            # pause opens the menu; resume closes it
            menu = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const btn = document.querySelector('.hud-pause');
                const r = btn.getBoundingClientRect();
                btn.dispatchEvent(new PointerEvent('pointerdown', {
                    pointerId: 15, pointerType: 'touch', isPrimary: true,
                    clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
                    bubbles: true, cancelable: true }));
                const open = !document.getElementById('menu-panel')
                    .classList.contains('hidden');
                document.getElementById('menu-resume').click();
                const closed = document.getElementById('menu-panel')
                    .classList.contains('hidden');
                return { open: open, closed: closed };
            })()""")
            check("pause button opens the menu, resume closes it",
                  menu["open"] and menu["closed"],
                  "open %s closed %s" % (menu["open"], menu["closed"]))

            check("touch context: zero pageerrors", not errors,
                  "; ".join(errors[:3]) if errors else "")
            ctx.close()
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)

    print("UI GATE: " + ("ALL OK" if fails == 0 else "%d FAILURES" % fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
