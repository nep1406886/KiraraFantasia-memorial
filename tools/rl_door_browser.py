# Browser gate for T21d (门/房间切换演出, spec/06 T21d): staged door
# crossings, door strips, and the lock/read of an uncleared battle room.
#   1. the start room carries one lit strip per door, at the right sides
#   2. walking into a door arms world.transition while the room has NOT
#      changed yet, and the #room-fade cover is up (0.15s ease-in < 0.18s)
#   3. 0.18s later the room swaps, the player lands just inside the door,
#      the cover comes off and the CSS opacity settles back to 0
#   4. the new room's strips match its own doors
#   5. an uncleared battle room locks its strips (dim); the roomClear event
#      opens them (white)
#   6. the page_fade SE fired (AudioContext spy), no pageerrors / warnings
# Owns its server. Usage: python tools/rl_door_browser.py [port]
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageChops

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

AUDIO_SPY = """
window.__audioSpy = { contexts: 0, buffers: 0, oscillators: 0 };
(() => {
    const RealCtx = window.AudioContext;
    if (!RealCtx) { return; }
    function CountingCtx() {
        window.__audioSpy.contexts += 1;
        const ctx = new RealCtx();
        const realBuffer = ctx.createBuffer.bind(ctx);
        const realOsc = ctx.createOscillator.bind(ctx);
        ctx.createBuffer = function () {
            window.__audioSpy.buffers += 1;
            return realBuffer.apply(null, arguments);
        };
        ctx.createOscillator = function () {
            window.__audioSpy.oscillators += 1;
            return realOsc.apply(null, arguments);
        };
        return ctx;
    }
    CountingCtx.prototype = RealCtx.prototype;
    window.AudioContext = CountingCtx;
})();
"""


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            return True
        page.wait_for_timeout(200)
    return False


def dismiss_boot_dialogue(page):
    for _ in range(90):
        vis = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " return !!(b && b.style.display !== 'none'); })()")
        if not vis:
            return True
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)
    return False


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8978
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = 0

    def check(label, ok, detail=""):
        nonlocal fails
        mark = "OK " if ok else "FAIL"
        print("%s  %s%s" % (mark, label, ("  -- " + str(detail)) if detail else ""))
        if not ok:
            fails += 1

    try:
        time.sleep(1.0)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.add_init_script(AUDIO_SPY)
            warnings = []
            errors = []
            page.on("console", lambda m: warnings.append(m.text)
                    if m.type in ("warning", "error")
                    and "GL Driver Message" not in m.text else None)
            page.on("pageerror", lambda e: errors.append(str(e)))

            if not boot(page, "http://127.0.0.1:%d/site/game/roguelike.html" % port):
                print("FAIL  boot (kirafanRL never appeared)")
                return 1
            check("boot roguelike.html", True)

            page.wait_for_selector(".roster-card", timeout=20000)
            picked = page.evaluate(
                """(() => {
                    const els = Array.from(document.querySelectorAll('.roster-card'));
                    const hit = els.find(e => (e.textContent || '').includes('由乃')) || els[0];
                    hit.click();
                    return hit.textContent.slice(0, 20);
                })()""")
            check("roster card clicked", bool(picked), picked)
            if not page.evaluate("!!window.kirafanRL.world.player"):
                deadline = time.time() + 30
                while time.time() < deadline:
                    if page.evaluate("!!window.kirafanRL.world.player"):
                        break
                    page.wait_for_timeout(200)
            check("player loaded", page.evaluate("!!window.kirafanRL.world.player"))
            dismiss_boot_dialogue(page)

            # -- 1: door strips of the start room --------------------------
            strips = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const sides = rl.world.roomDoors.map(d => d.side).sort();
                const have = [];
                rl.scene.traverse(function (o) {
                    if (o.name && o.name.indexOf('door:') === 0) { have.push(o.name.slice(5)); }
                });
                have.sort();
                return { sides: sides, have: have };
            })()""")
            check("start room has one strip per door",
                  strips["have"] == strips["sides"] and len(strips["sides"]) > 0,
                  "doors=%s strips=%s" % (strips["sides"], strips["have"]))

            # -- 2: walking into a door arms the staged transition ---------
            walk = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                const door = w.roomDoors[0];
                window.__doorFrom = w.roomId;
                window.__doorTo = door.to;
                window.__doorSide = door.side;
                const dir = { N: {x: 0, y: -1}, S: {x: 0, y: 1},
                              W: {x: -1, y: 0}, E: {x: 1, y: 0} }[door.side];
                const p = w.player;
                p.x = door.at.x - dir.x * 2;
                p.y = door.at.y - dir.y * 2;
                window.__inputReal = w.inputState;
                w.inputState = { move: dir, attack: false, dodge: false };
                const spy0 = Object.assign({}, window.__audioSpy);
                let armed = -1;
                for (let i = 0; i < 150; i++) {
                    rl.step(1/60);
                    if (w.transition) { armed = i; break; }
                }
                const fade = document.getElementById('room-fade');
                const style = fade ? getComputedStyle(fade) : null;
                return { armed: armed, roomId: w.roomId,
                         covered: !!(fade && fade.classList.contains('on')),
                         coverDur: style ? style.transitionDuration : null,
                         spy0: spy0, spy1: window.__audioSpy };
            })()""")
            check("walking into a door arms the transition", walk["armed"] >= 0,
                  "armed at step %s" % walk["armed"])
            check("room unchanged while staged",
                  walk["roomId"] == page.evaluate("window.__doorFrom"),
                  "roomId=%s" % walk["roomId"])
            check("cover is up while staged", walk["covered"])
            check("cover eases in faster than the world swaps",
                  walk["coverDur"] in ("0.15s", "0.15s "), "dur=%s" % walk["coverDur"])
            check("page_fade SE fired at the door",
                  walk["spy1"]["buffers"] > walk["spy0"]["buffers"],
                  "buffers %s -> %s" % (walk["spy0"]["buffers"], walk["spy1"]["buffers"]))

            # -- 3: the swap lands, the player enters, the cover lifts -----
            swap = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                let swapped = false;
                for (let i = 0; i < 40 && !swapped; i++) {
                    rl.step(1/60);
                    swapped = !w.transition && w.roomId === window.__doorTo;
                }
                const side = window.__doorSide;
                const entry = { N: {x: w.width / 2, y: w.height - 1.2},
                                S: {x: w.width / 2, y: 1.2},
                                W: {x: w.width - 1.2, y: w.height / 2},
                                E: {x: 1.2, y: w.height / 2} }[side];
                const p = w.player;
                const nearEntry = Math.abs(p.x - entry.x) < 0.6
                    && Math.abs(p.y - entry.y) < 0.6;
                const fade = document.getElementById('room-fade');
                return { swapped: swapped, roomId: w.roomId,
                         px: p.x, py: p.y, nearEntry: nearEntry,
                         covered: !!(fade && fade.classList.contains('on')) };
            })()""")
            check("room swapped after the fade window", swap["swapped"],
                  "roomId=%s want=%s" % (swap["roomId"],
                                         page.evaluate("window.__doorTo")))
            check("player landed just inside the door", swap["nearEntry"],
                  "p=(%.2f, %.2f)" % (swap["px"], swap["py"]))
            check("cover released on arrival", not swap["covered"])

            settled = None
            for _ in range(20):
                page.wait_for_timeout(100)
                settled = page.evaluate(
                    "parseFloat(getComputedStyle(document.getElementById('room-fade')).opacity)")
                if settled == 0:
                    break
            check("cover opacity settles to 0", settled == 0, "opacity=%s" % settled)

            # -- 4: the new room's strips match its own doors --------------
            strips2 = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const sides = rl.world.roomDoors.map(d => d.side).sort();
                const have = [];
                rl.scene.traverse(function (o) {
                    if (o.name && o.name.indexOf('door:') === 0) { have.push(o.name.slice(5)); }
                });
                have.sort();
                return { sides: sides, have: have };
            })()""")
            check("new room's strips match its doors",
                  strips2["have"] == strips2["sides"],
                  "doors=%s strips=%s" % (strips2["sides"], strips2["have"]))

            # -- 5: battle rooms lock, clearing opens -----------------------
            lock = page.evaluate("""(async () => {
                const rl = window.kirafanRL;
                const w = rl.world;
                w.inputState = window.__inputReal;
                // A battle room we already sit in would be a revisit (no
                // spawn, no lock) — the walk above may well have ended in
                // the generator's first battle room.
                let battle = w.dungeon.rooms.find(
                    r => r.type === 'battle' && r.id !== w.roomId);
                if (!battle) {
                    battle = w.dungeon.rooms.find(r => r.type === 'battle');
                    w.roomState.get(battle.id).visited = false;
                }
                w.enterRoom(battle.id, 'S');
                await new Promise((resolve, reject) => {
                    const t0 = performance.now();
                    const timer = setInterval(() => {
                        rl.step(1/60);
                        const g = rl.mapview.group;
                        if (g && g.name === 'room:' + battle.id) {
                            clearInterval(timer); resolve();
                        } else if (performance.now() - t0 > 15000) {
                            clearInterval(timer); reject(new Error('never built'));
                        }
                    }, 10);
                });
                for (let i = 0; i < 10; i++) { rl.step(1/60); }
                const mesh = ['door:S', 'door:N', 'door:W', 'door:E']
                    .map(n => rl.scene.getObjectByName(n)).find(Boolean);
                const lockedColor = mesh ? mesh.material.color.getHexString() : null;
                w.enemies.forEach(e => { e.hp = 0; e.dead = true; });
                rl.step(1/60);
                const openColor = mesh ? mesh.material.color.getHexString() : null;
                return { lockedColor: lockedColor, openColor: openColor,
                         cleared: !!(w.roomState.get(battle.id) || {}).cleared,
                         live: w.enemies.length };
            })()""")
            check("uncleared battle room locks its strips",
                  lock["lockedColor"] == "8c8c8c", lock["lockedColor"])
            check("roomClear opens the strips",
                  lock["cleared"] and lock["openColor"] == "ffffff",
                  "cleared=%s color=%s" % (lock["cleared"], lock["openColor"]))

            # -- 6: the strip renders as a LIT path (pixel A/B) -------------
            # Structural checks cannot see a strip sunk under the surround
            # plane, and a whole-canvas diff cannot see it either: the seed
            # decides which walls carry doors, so parking the player at the
            # S wall samples no strip at all when the room's doors face
            # elsewhere (the 181-px run: corpse flashes, not strips). Instead
            # stand by a wall that HAS a door and project that strip's own
            # vertices to canvas pixels with the camera matrices — the A/B
            # then diffs open → locked → open inside the projected box only.
            # Pixels that moved between the two OPEN frames are animation
            # noise (the idle mixer still advances on rAF); pixels that
            # moved open→locked but not open→open are the strip — and they
            # must be brighter open than locked.
            region = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                w.danmaku.clear();
                const side = w.roomDoors.some(d => d.side === 'S')
                    ? 'S' : w.roomDoors[0].side;
                const p = w.player;
                const spot = { S: [w.width / 2, w.height - 3],
                               N: [w.width / 2, 3],
                               W: [3, w.height / 2],
                               E: [w.width - 3, w.height / 2] }[side];
                p.x = spot[0]; p.y = spot[1];
                for (let i = 0; i < 60; i++) { rl.step(1/60); }
                rl.renderOnce();
                const mesh = rl.scene.getObjectByName('door:' + side);
                const cam = rl.camera;
                mesh.updateWorldMatrix(true, false);
                cam.updateMatrixWorld();
                const mv = cam.matrixWorldInverse.clone().multiply(mesh.matrixWorld);
                const proj = cam.projectionMatrix.clone().multiply(mv);
                const e = proj.elements;
                const pos = mesh.geometry.attributes.position;
                const canvas = rl.renderer.domElement;
                let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
                for (let i = 0; i < pos.count; i++) {
                    const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
                    const cx = e[0] * vx + e[4] * vy + e[8] * vz + e[12];
                    const cy = e[1] * vx + e[5] * vy + e[9] * vz + e[13];
                    const cw = e[3] * vx + e[7] * vy + e[11] * vz + e[15];
                    const px = (cx / cw + 1) / 2 * canvas.width;
                    const py = (1 - cy / cw) / 2 * canvas.height;
                    if (px < minX) { minX = px; }
                    if (px > maxX) { maxX = px; }
                    if (py < minY) { minY = py; }
                    if (py > maxY) { maxY = py; }
                }
                return { side: side, w: canvas.width, h: canvas.height,
                         x0: Math.max(0, Math.floor(minX)),
                         y0: Math.max(0, Math.floor(minY)),
                         x1: Math.min(canvas.width - 1, Math.ceil(maxX)),
                         y1: Math.min(canvas.height - 1, Math.ceil(maxY)) };
            })()""")
            area = (region["x1"] - region["x0"]) * (region["y1"] - region["y0"])
            check("strip projects onto the canvas", area > 2000,
                  "side=%s box=%s" % (region["side"],
                                      (region["x0"], region["y0"],
                                       region["x1"], region["y1"])))
            canvas = page.locator("canvas")
            shot_open = Image.open(BytesIO(canvas.screenshot())).convert("RGB")
            page.evaluate("""(() => {
                const rl = window.kirafanRL;
                rl.mapview.setDoorsLocked(true);
                rl.renderOnce();
            })()""")
            shot_locked = Image.open(BytesIO(canvas.screenshot())).convert("RGB")
            page.evaluate("""(() => {
                const rl = window.kirafanRL;
                rl.mapview.setDoorsLocked(false);
                rl.renderOnce();
            })()""")
            shot_open2 = Image.open(BytesIO(canvas.screenshot())).convert("RGB")
            box = (region["x0"], region["y0"], region["x1"] + 1, region["y1"] + 1)
            changed = 0
            lum_open = 0.0
            lum_locked = 0.0
            for px_open, px_open2, px_locked in zip(shot_open.crop(box).getdata(),
                                                    shot_open2.crop(box).getdata(),
                                                    shot_locked.crop(box).getdata()):
                moved = (abs(px_open[0] - px_locked[0]) > 12
                         or abs(px_open[1] - px_locked[1]) > 12
                         or abs(px_open[2] - px_locked[2]) > 12)
                noise = (abs(px_open[0] - px_open2[0]) > 6
                         or abs(px_open[1] - px_open2[1]) > 6
                         or abs(px_open[2] - px_open2[2]) > 6)
                if moved and not noise:
                    changed += 1
                    lum_open += 0.2126 * px_open[0] + 0.7152 * px_open[1] + 0.0722 * px_open[2]
                    lum_locked += 0.2126 * px_locked[0] + 0.7152 * px_locked[1] + 0.0722 * px_locked[2]
            check("strips render on screen (pixel A/B)",
                  changed > 1000, "%d px of %d changed" % (changed, area))
            if changed:
                check("strips read lit, not shut",
                      lum_open / changed > lum_locked / changed + 25,
                      "lum %.1f open vs %.1f locked" % (
                          lum_open / changed, lum_locked / changed))

            # -- 6: stability + cleanliness ---------------------------------
            for _ in range(200):
                page.evaluate("window.kirafanRL.step(1/60)")
            check("no pageerrors through the drive", not errors, errors[:3])
            check("no console warnings through the drive", not warnings,
                  "; ".join(warnings[:3]))

            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    print("=" * 60)
    if fails == 0:
        print("ALL OK — door strips + staged transitions + lock (T21d)")
        return 0
    print(fails, "check(s) failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
