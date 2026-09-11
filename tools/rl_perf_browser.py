# Browser gate for the 60fps bar (spec/02 §4: 1080p 中端核显 60fps, 同屏
# ≤10 敌人 + 满弹幕; spec/06 T16's missing deliverable).
#
# A headless gate cannot measure a mid-tier iGPU, so it certifies the two
# things that actually decide that bar, on the real pipeline (window.kirafanRL
# step = world.update + consumeEvents + syncViews + renderer.render):
#
#   1. the GPU load proxy -- renderer.info's draw-call and triangle counts
#      with 10 real enemy models alive and the danmaku pool near its cap
#   2. the CPU load -- median JS time per frame (step minus a render-only
#      sample of the same scene), which has to leave the frame budget room
#      for a real GPU to draw those calls in
#   3. stability -- renderer.info.memory flat across 600 more frames (no
#      per-frame geometry/texture leak), and the bullet pool never exceeds
#      its authored capacity of 1024
#
# Usage:
#   python tools/rl_perf_browser.py            the gate
#   python tools/rl_perf_browser.py --probe    measurements only, no asserts
# Owns its server. Usage: python tools/rl_perf_browser.py [port]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

# --- authored budgets (never read back out of the measurement) ----------------
# SwiftShader's raster time is not a mid-tier iGPU's, so the gate does not
# assert on wall-clock step time. It asserts on what a real GPU scales with:
# draw calls and triangles (budget = the scene the bar names, plus headroom),
# and on the JS share of the frame (16.67ms budget minus a realistic
# 1080p draw of that many calls -- the rest is the game's own logic).
ENEMY_COUNT = 10          # spec/02 §4: 「同屏 ≤10 敌人」
BULLET_FLOOR = 800        # 「满弹幕」read as ≥ 800 of the 1024 pool alive
MAX_CALLS = 600           # 09-04 budget was 300, authored off a 131-call
                          # scene when character views rendered ~8-9 meshes.
                          # The T22m/T23e fidelity wave (facial variant
                          # tables, full model attachment, unwrap-rewrap)
                          # legitimately tripled per-character visible
                          # meshes (player 36 visible of 61 authored; donor
                          # model_en_1300 37 of 82 -- costume/face variants
                          # correctly pruned; no runtime duplicates -- see
                          # spec/06 T24e-2). Worst case re-measured 330-332
                          # on 09-06; positional worst ~438. 600 still
                          # fails per-character mesh doubling (~800) and
                          # variant-unpruning (~950).
MAX_TRIANGLES = 100000    # measured ~8k; the whole scene is card quads
SIM_MEDIAN_MS = 6.0       # JS share of the 16.67ms frame
BULLET_CAP = 1024         # danmaku.js capacity, asserted as a hard ceiling


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            return True
        page.wait_for_timeout(200)
    return False


def wait_player(page, timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate(
                "!!(window.kirafanRL.world && window.kirafanRL.world.player)"):
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


def main() -> int:
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = int(argv[0]) if argv else 8970
    probe = "--probe" in sys.argv
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
            # spec/02 §4's bar is stated at 1080p.
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            boot(page, url)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.click(".roster-card")
            wait_player(page)
            dismiss_dialogue(page)

            # --- build the worst case -----------------------------------
            # Enter a battle room (real enemies, real props), then grow the
            # field to 10 by cloning a live enemy through world.spawnEnemy —
            # the same typed entry spawnFromSpec uses — and pushing a summon
            # event so consumeEvents attaches their views. Enemies get huge
            # HP and the player huge i-frames: the scene must stay at its
            # worst case for the whole measurement, not decay as the fight
            # resolves.
            entered = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const w = k.world;
                const battle = w.dungeon.rooms.find(r => r.type === 'battle');
                if (!battle) { return false; }
                w.enterRoom(battle.id, 'N');
                return true;
            })()""")
            if not entered:
                print("FAIL no battle room in the dungeon")
                return 1
            # let the room build and the models land
            for _ in range(60):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(8)
            deadline = time.time() + 40
            while page.evaluate("window.kirafanRL.pending"):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(50)
                if time.time() > deadline:
                    break

            built = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const w = k.world;
                const p = w.player;
                p.iframes = 1e9;
                p.hp = p.maxHp;
                const alive = w.enemies.filter(e => !e.dead);
                if (!alive.length) { return 0; }
                const donor = alive[0];
                while (w.enemies.filter(e => !e.dead).length < %d) {
                    const ang = Math.random() * Math.PI * 2;
                    const dist = 3 + Math.random() * 4;
                    const u = w.spawnEnemy({
                        enemyId: donor.enemyId, name: donor.name,
                        nameZh: donor.nameZh, model: donor.model,
                        shadowScale: donor.shadowScale,
                        voiceCueSheet: donor.voiceCueSheet,
                        x: Math.min(w.width - 1, Math.max(1, p.x + Math.cos(ang) * dist)),
                        y: Math.min(w.height - 1, Math.max(1, p.y + Math.sin(ang) * dist)),
                        radius: donor.radius, hp: 1e9, atk: donor.atk,
                        mgc: donor.mgc, def: donor.def, mdef: donor.mdef,
                        spd: donor.spd, luck: donor.luck, element: donor.element,
                        aiType: donor.aiType, elite: donor.elite,
                        moveset: donor.moveset,
                        turnSeconds: donor.turnSeconds, room: w.roomId
                    });
                    u.actionTimer = 0.05 + Math.random();
                }
                w.enemies.forEach(e => { e.hp = 1e9; e.maxHp = 1e9; });
                // consumeEvents attaches views on a summon event
                w.events.push({ type: 'summon', unit: donor, count: 0 });
                // the player keeps swinging: real player bullets in flight too
                k.input.state.attack = true;
                // fill the pool toward its cap with slow, long-lived rings.
                // Room-bounds culling is the real limiter, not life: slow
                // bullets stay in the room for the whole measurement.
                for (let i = 0; i < 40; i++) {
                    w.danmaku.emit('ring',
                        { x: p.x, y: p.y },
                        { side: 'enemy', count: 24, speed: 0.4 + Math.random() * 0.4,
                          life: 600, power: 1, coef: 0.1, radius: 0.2, element: 1 });
                }
                return w.enemies.filter(e => !e.dead).length;
            })()""" % ENEMY_COUNT)
            for _ in range(30):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(8)
            deadline = time.time() + 40
            while page.evaluate("window.kirafanRL.pending"):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(50)
                if time.time() > deadline:
                    break

            # --- measurement --------------------------------------------
            # The whole measurement runs in one evaluate so per-frame timings
            # are not sliced across protocol round-trips.
            m = page.evaluate("""(() => {
                const k = window.kirafanRL;
                const w = k.world;
                const med = a => {
                    const s = a.slice().sort((x, y) => x - y);
                    return s.length % 2 ? s[(s.length - 1) / 2]
                                        : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
                };
                const pct = (a, q) => a.slice().sort((x, y) => x - y)[
                    Math.min(a.length - 1, Math.floor(q * a.length))];

                // warm-up: let the mixers, the view syncs and the bullet
                // field reach steady state before timing anything
                for (let i = 0; i < 60; i++) { k.step(1/60); }

                const steps = [];
                let maxBullets = 0;
                const countBullets = () => {
                    let n = 0;
                    w.danmaku.forEach(b => { if (b.life > 0) { n++; } });
                    return n;
                };
                // Hold the worst case: bullets that leave the room are culled
                // by bounds, so the field is topped back up during measurement
                // (the same slow rings the setup used).
                const topUp = p => {
                    for (let i = 0; i < 5; i++) {
                        w.danmaku.emit('ring', { x: p.x, y: p.y },
                            { side: 'enemy', count: 24, speed: 0.4 + Math.random() * 0.4,
                              life: 600, power: 1, coef: 0.1, radius: 0.2, element: 1 });
                    }
                };
                for (let i = 0; i < 240; i++) {
                    if (i % 60 === 0 && countBullets() < 900) {
                        topUp(w.player);
                    }
                    const t0 = performance.now();
                    k.step(1/60);
                    steps.push(performance.now() - t0);
                    if (i % 10 === 0) { maxBullets = Math.max(maxBullets, countBullets()); }
                }

                // render-only samples of the same scene, so the JS share of
                // the frame can be separated from SwiftShader's raster time
                const renders = [];
                for (let i = 0; i < 60; i++) {
                    const t0 = performance.now();
                    k.renderOnce();
                    renders.push(performance.now() - t0);
                }

                const info = k.renderer.info;
                const mem0 = { g: info.memory.geometries, t: info.memory.textures };

                // stability: 600 more frames at the worst case
                for (let i = 0; i < 600; i++) {
                    if (i % 60 === 0 && countBullets() < 900) {
                        topUp(w.player);
                    }
                    k.step(1/60);
                    if (i % 50 === 0) { maxBullets = Math.max(maxBullets, countBullets()); }
                }
                const mem1 = { g: info.memory.geometries, t: info.memory.textures };

                return {
                    enemies: w.enemies.filter(e => !e.dead).length,
                    views: k.views.enemies.length,
                    bullets: countBullets(),
                    maxBullets: maxBullets,
                    calls: info.render.calls,
                    triangles: info.render.triangles,
                    stepMed: med(steps), stepP95: pct(steps, 0.95),
                    renderMed: med(renders),
                    mem0: mem0, mem1: mem1
                };
            })()""")

            sim_med = m["stepMed"] - m["renderMed"]
            print("worst case: %d enemies (%d views), %d bullets alive (max %d)"
                  % (m["enemies"], m["views"], m["bullets"], m["maxBullets"]))
            print("draw calls %d, triangles %d" % (m["calls"], m["triangles"]))
            print("step median %.2fms p95 %.2fms | render-only median %.2fms | JS share ~%.2fms"
                  % (m["stepMed"], m["stepP95"], m["renderMed"], sim_med))
            print("memory geometries %d -> %d, textures %d -> %d"
                  % (m["mem0"]["g"], m["mem1"]["g"], m["mem0"]["t"], m["mem1"]["t"]))

            if probe:
                print("PROBE: no assertions run")
                browser.close()
                return 0

            check("worst case built: %d enemies alive with views" % ENEMY_COUNT,
                  m["enemies"] >= ENEMY_COUNT and m["views"] >= ENEMY_COUNT,
                  "%d/%d" % (m["enemies"], m["views"]))
            check("满弹幕: >= %d of the 1024 pool alive" % BULLET_FLOOR,
                  m["bullets"] >= BULLET_FLOOR and m["maxBullets"] >= BULLET_FLOOR,
                  "alive %d max %d" % (m["bullets"], m["maxBullets"]))
            check("bullet pool never exceeds its capacity", m["maxBullets"] <= BULLET_CAP,
                  "max %d" % m["maxBullets"])
            check("draw calls <= %d at the worst case" % MAX_CALLS,
                  m["calls"] <= MAX_CALLS, str(m["calls"]))
            check("triangles <= %d at the worst case" % MAX_TRIANGLES,
                  m["triangles"] <= MAX_TRIANGLES, str(m["triangles"]))
            check("JS share of the frame <= %.1fms (median)" % SIM_MEDIAN_MS,
                  sim_med <= SIM_MEDIAN_MS, "%.2fms" % sim_med)
            check("no per-frame geometry/texture leak over 600 frames",
                  m["mem1"]["g"] <= m["mem0"]["g"] and m["mem1"]["t"] <= m["mem0"]["t"],
                  "g %d->%d t %d->%d" % (m["mem0"]["g"], m["mem1"]["g"],
                                         m["mem0"]["t"], m["mem1"]["t"]))
            check("zero pageerrors", not errors,
                  "; ".join(errors[:3]) if errors else "")

            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)

    print("PERF GATE: " + ("ALL OK" if fails == 0 else "%d FAILURES" % fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
