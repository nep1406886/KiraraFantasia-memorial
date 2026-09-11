# Browser gate for T21b (打击感包, spec/06 T21b): hit-stop, slash arc and
# SE cues wired through the real event funnel.
#   1. a swing (J held one tick) leaves a slash-arc mesh in the vfx layer,
#      and it retires after its life
#   2. a landed melee hit sets world.hitStop > 0 and the next step freezes
#      the simulation (world.time does not advance)
#   3. the player taking a hit sets the heavier 0.07 hit-stop
#   4. the SE graph fires: an AudioContext is created and buffer/oscillator
#      nodes are built (whoosh = buffers only; hit = buffer + oscillator)
#   5. no pageerrors, no console warnings through the whole drive
# T22d additions (碰撞/受击判定与反馈):
#   6. the slash arc's standing geometry IS the hitbox -- outer radius =
#      attackRange + one enemy radius, arc = attackArc (read off the live
#      RingGeometry against a dynamic import of actorstate.js, so the two
#      cannot drift apart)
#   7. the judgment's edge is the light's edge: a foe centred just inside
#      range + radius is hit (and knocked back along the attacker->target
#      direction); a foe just outside is not; the player who takes a hit is
#      never shoved (p.kx stays 0)
#   8. layered SE: a forced crit fires hit + the chime accent (oscillator
#      count doubles); ばつぐん and いまいち land different hit volumes
#      (recorded off the gain ramps the recipes schedule)
# Owns its server. Usage: python tools/rl_hitfeel_browser.py [port]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

# Wraps the WebAudio constructors BEFORE any page script runs, so the counts
# prove core/audio.js's se() actually built its graph (it is the only
# AudioContext user on this page -- BGM/voice are HTMLAudio elements).
# The ramp recorder catches every exponentialRampToValueAtTime target; every
# frequency ramp in the recipes is >= 60 Hz, so a recorded value below ~1 can
# only be a gain -- that is how the volume layering is measured.
AUDIO_SPY = """
window.__audioSpy = { contexts: 0, buffers: 0, oscillators: 0, gains: [] };
(() => {
    const RealCtx = window.AudioContext;
    if (!RealCtx) { return; }
    const proto = window.AudioParam && window.AudioParam.prototype;
    if (proto && proto.exponentialRampToValueAtTime) {
        const realRamp = proto.exponentialRampToValueAtTime;
        proto.exponentialRampToValueAtTime = function (v, t) {
            window.__audioSpy.gains.push(v);
            return realRamp.call(this, v, t);
        };
    }
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
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8976
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
            # ".WebGL-…GL Driver Message" is ANGLE/Chromium noise from
            # renderOnce(), not an application warning.
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
            # A battle room guarantees the fight context the events assume.
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const battle = w.dungeon.rooms.find(r => r.type === 'battle');
                if (battle) { w.enterRoom(battle.id, 'S'); }
                for (let i = 0; i < 30; i++) window.kirafanRL.step(1/60);
            })()""")

            # -- 1: a swing leaves a slash arc in the vfx layer -------------
            slash_probe = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                const p = w.player;
                p.facing = 0;
                const foe = w.spawnEnemy({x: p.x + 1.2, y: p.y, hp: 100000,
                                          atk: 0, aiType: 'sentry'});
                window.__feelFoe = foe;
                const before = { arcs: 0 };
                rl.input.state.attack = true;
                rl.step(1/60);
                rl.input.state.attack = false;
                let arcs = 0;
                rl.scene.traverse(function (o) {
                    if (o.isMesh && o.renderOrder === 400000) { arcs += 1; }
                });
                return { arcs: arcs, spy: window.__audioSpy,
                         state: p.sm.state, swingHits: p.swingHits ? p.swingHits.size : -1 };
            })()""")
            check("swing leaves a slash-arc mesh", slash_probe["arcs"] >= 1,
                  "arcs=%d state=%s" % (slash_probe["arcs"], slash_probe["state"]))

            retired = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                for (let i = 0; i < 20; i++) { rl.step(1/60); }   // 0.33s > 0.18s life
                let arcs = 0;
                rl.scene.traverse(function (o) {
                    if (o.isMesh && o.renderOrder === 400000) { arcs += 1; }
                });
                return arcs;
            })()""")
            check("slash arc retires after its life", retired == 0,
                  "%d arcs left" % retired)

            # -- 2: a landed melee hit freezes the next step ----------------
            # Check 1's swing already spent itself (hit window 0.12-0.30s
            # into it); a fresh swing is what check 2 measures.
            hit_probe = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                const p = w.player;
                p.facing = 0;
                const foe = window.__feelFoe;
                foe.hp = foe.maxHp = 100000;
                foe.dead = false;
                foe.x = p.x + 1.2; foe.y = p.y;
                const hp0 = foe.hp;
                rl.input.state.attack = true;
                rl.step(1/60);
                rl.input.state.attack = false;
                let landed = false;
                for (let i = 0; i < 120 && !landed; i++) {
                    rl.step(1/60);
                    landed = foe.hp < hp0;
                }
                const stopAfterHit = w.hitStop;
                const t0 = w.time;
                rl.step(1/60);
                return { landed: landed, hp: foe.hp,
                         stopAfterHit: stopAfterHit,
                         stopNext: w.hitStop, frozenTime: w.time === t0,
                         spy: window.__audioSpy };
            })()""")
            check("melee swing connected", hit_probe["landed"],
                  "hp %s" % hit_probe["hp"])
            check("landed melee sets hit-stop", hit_probe["stopAfterHit"] > 0,
                  "hitStop=%s" % hit_probe["stopAfterHit"])
            check("hit-stop freezes the next step",
                  hit_probe["frozenTime"] and hit_probe["stopNext"] >= 0
                  and hit_probe["stopNext"] < hit_probe["stopAfterHit"],
                  "time frozen=%s, %.4f -> %.4f" % (
                      hit_probe["frozenTime"], hit_probe["stopAfterHit"],
                      hit_probe["stopNext"]))

            # -- 3: taking a hit is the heavier freeze ----------------------
            taken_probe = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                const p = w.player;
                p.hp = p.maxHp = 5000;   // survive: the freeze, not the death
                p.iframes = 0;
                const hp0 = p.hp;
                w.danmaku.emit('aimed', {x: p.x - 3, y: p.y, angle: 0},
                    {side: 'enemy', power: 50, coef: 1, count: 1,
                     speed: 10, life: 4});
                let taken = false;
                for (let i = 0; i < 120 && !taken; i++) {
                    rl.step(1/60);
                    taken = p.hp < hp0;
                }
                return { taken: taken, hp: p.hp, hitStop: w.hitStop };
            })()""")
            check("enemy bullet damaged the player", taken_probe["taken"],
                  "hp %s" % taken_probe["hp"])
            check("taking a hit sets the heavier stop",
                  0.06 <= taken_probe["hitStop"] <= 0.08,
                  "hitStop=%s" % taken_probe["hitStop"])

            # -- 6 (T22d): the slash arc's geometry IS the hitbox ---------
            # Every probe below first settles: steps until the player is back
            # in an actionable state with no hit-stop pending, and freezes the
            # enemies' attack timers so a stray bullet cannot eat the swing's
            # hit window mid-flight.
            geo_probe = page.evaluate("""(() => import('/site/game/rl/actorstate.js')
                .then(function (state) {
                    return import('/site/game/rl/elements.js').then(function (el) {
                const rl = window.kirafanRL;
                const w = rl.world;
                const p = w.player;
                p.facing = 0;
                w.enemies.forEach(function (e) {
                    e.actionTimer = 1e9;
                    e.contactCooldown = 1e9;
                });
                p.iframes = 1000;                   // shield the drain
                for (let i = 0; i < 150; i++) { rl.step(1/60); }
                p.iframes = 0;
                for (let i = 0; i < 240; i++) {
                    rl.step(1/60);
                    if (p.sm.state === 'idle' && w.hitStop <= 0) { break; }
                }
                const actionable = p.sm.state === 'idle' || p.sm.state === 'move';
                rl.input.state.attack = true;
                rl.step(1/60);
                rl.input.state.attack = false;
                let mesh = null;
                rl.scene.traverse(function (o) {
                    if (!mesh && o.isMesh && o.renderOrder === 400000) { mesh = o; }
                });
                let goodPair = null, badPair = null;
                for (let a = 1; a <= 5; a++) {
                    for (let d = 1; d <= 5; d++) {
                        const f = el.elementHit(a, d);
                        if (f === 1 && !goodPair) { goodPair = [a, d]; }
                        if (f === -1 && !badPair) { badPair = [a, d]; }
                    }
                }
                const pr = (mesh && mesh.geometry.parameters)
                    ? mesh.geometry.parameters : {};
                return {
                    actionable: actionable,
                    found: !!mesh,
                    outer: pr.outerRadius,
                    arc: pr.thetaLength,
                    range: state.PLAYER_TIMING.attackRange,
                    hitArc: state.PLAYER_TIMING.attackArc,
                    goodPair: goodPair, badPair: badPair
                };
            }); }))()""")
            check("player actionable when the geometry probe swings",
                  geo_probe["actionable"], str(geo_probe["actionable"]))
            check("slash arc mesh present for the geometry read",
                  geo_probe["found"], str(geo_probe["found"]))
            check("slash outer radius = attackRange + one enemy radius",
                  geo_probe["outer"] is not None
                  and abs(geo_probe["outer"] - (geo_probe["range"] + 0.5)) < 1e-6,
                  "outer=%s range=%s" % (geo_probe["outer"], geo_probe["range"]))
            check("slash arc = the hit window's arc",
                  geo_probe["arc"] is not None
                  and abs(geo_probe["arc"] - geo_probe["hitArc"]) < 1e-6,
                  "arc=%s hitArc=%s" % (geo_probe["arc"], geo_probe["hitArc"]))
            check("element ring has both advantage pairs",
                  bool(geo_probe["goodPair"]) and bool(geo_probe["badPair"]),
                  "good=%s bad=%s" % (geo_probe["goodPair"], geo_probe["badPair"]))

            # -- 7 (T22d): the judgment's edge is the light's edge ---------
            rng = geo_probe["range"]
            edge_probe = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                const p = w.player;
                p.facing = 0;
                const settle = function () {
                    p.iframes = 1000;               // shield the drain
                    for (let i = 0; i < 150; i++) { rl.step(1/60); }
                    p.iframes = 0;
                    for (let i = 0; i < 240; i++) {
                        rl.step(1/60);
                        if (p.sm.state === 'idle' && w.hitStop <= 0) { return true; }
                    }
                    return false;
                };
                const foe = window.__feelFoe;
                const swing = function (steps) {
                    rl.input.state.attack = true;
                    rl.step(1/60);
                    rl.input.state.attack = false;
                    for (let i = 0; i < steps; i++) { rl.step(1/60); }
                };
                foe.hp = foe.maxHp = 100000;
                foe.dead = false;
                foe.kx = 0; foe.ky = 0;
                foe.element = null;
                settle();
                const edgeX = p.x + %f + foe.radius - 0.05;
                foe.x = edgeX; foe.y = p.y;
                swing(90);
                const edgeLanded = foe.hp < 100000;
                const pushed = foe.x - edgeX;
                foe.hp = foe.maxHp = 100000;
                foe.dead = false;
                settle();
                foe.x = p.x + %f + foe.radius + 0.4;
                foe.y = p.y;
                swing(90);
                const farLanded = foe.hp < 100000;
                return { edgeLanded: edgeLanded, farLanded: farLanded,
                         pushed: pushed, pkx: p.kx || 0,
                         foeRadius: foe.radius };
            })()""" % (rng, rng))
            check("foe at the hitbox's edge is hit",
                  edge_probe["edgeLanded"],
                  "radius=%s" % edge_probe["foeRadius"])
            check("foe past the edge is not hit",
                  not edge_probe["farLanded"])
            check("landed hit knocks the foe along the hit direction",
                  edge_probe["pushed"] > 0.2,
                  "pushed=%.3f (impulse/decay ~0.38)" % edge_probe["pushed"])
            check("a hit the player takes shoves nobody",
                  edge_probe["pkx"] == 0,
                  "p.kx=%s" % edge_probe["pkx"])

            # -- 8 (T22d): layered SE --------------------------------------
            crit_probe = page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                const p = w.player;
                p.facing = 0;
                const foe = window.__feelFoe;
                foe.hp = foe.maxHp = 100000;
                foe.dead = false;
                foe.element = null;
                // Shield the drain, then wait out any hit state: a bullet that
                // lands mid-drain procs hitStack -> reapplyEquipment, which
                // would rewrite p.luck before the swing.
                p.iframes = 1000;
                for (let i = 0; i < 150; i++) { rl.step(1/60); }
                p.iframes = 0;
                for (let i = 0; i < 240; i++) {
                    rl.step(1/60);
                    if (p.sm.state === 'idle' && w.hitStop <= 0) { break; }
                }
                // refreshPlayer recomputes p.luck from p.base.luck every tick,
                // so the force has to go on the base, not the live value.
                const luck0 = p.base.luck;
                p.base.luck = 99999;    // crit chance clamps to 1: every hit crits
                p.critBonus = 0;
                foe.x = p.x + 1.2; foe.y = p.y;
                const b0 = window.__audioSpy.buffers;
                const o0 = window.__audioSpy.oscillators;
                rl.input.state.attack = true;
                rl.step(1/60);
                rl.input.state.attack = false;
                let landed = false;
                for (let i = 0; i < 90; i++) {
                    rl.step(1/60);
                    if (foe.hp < 100000) { landed = true; }
                }
                p.base.luck = luck0;    // back on the curve for later probes
                p.luck = 0;             // back to no-crit for the volume probes
                return { landed: landed,
                         db: window.__audioSpy.buffers - b0,
                         dosc: window.__audioSpy.oscillators - o0 };
            })()""")
            # whoosh = 1 buffer; hit = 1 buffer + 1 osc; chime = 1 buffer +
            # 2 osc. So a crit swing is >= 3 buffers and exactly 3 oscillators.
            check("crit lands the layered accent (hit + chime)",
                  crit_probe["landed"] and crit_probe["dosc"] >= 3
                  and crit_probe["db"] >= 2,
                  "landed=%s dbuffers=%s dosc=%s" % (
                      crit_probe["landed"], crit_probe["db"], crit_probe["dosc"]))

            good_pair = geo_probe["goodPair"]
            bad_pair = geo_probe["badPair"]
            elem_probe = page.evaluate("""(() => import('/site/core/audio.js')
                .then(function (audio) {
                const rl = window.kirafanRL;
                const w = rl.world;
                const p = w.player;
                p.facing = 0;
                const luck1 = p.base.luck;   // restored after the two runs
                const foe = window.__feelFoe;
                foe.hp = foe.maxHp = 100000;
                foe.dead = false;
                foe.element = null;
                const settle = function () {
                    p.iframes = 1000;               // shield the drain
                    for (let i = 0; i < 150; i++) { rl.step(1/60); }
                    p.iframes = 0;
                    for (let i = 0; i < 240; i++) {
                        rl.step(1/60);
                        if (p.sm.state === 'idle' && w.hitStop <= 0) { return; }
                    }
                };
                const run = function () {
                    settle();
                    foe.hp = foe.maxHp = 100000;
                    // Set after settle (a bullet in the drain procs
                    // reapplyEquipment) and on the base (refreshPlayer
                    // recomputes the live value every tick): a random crit off
                    // the card's luck curve would pollute the volume read.
                    p.base.luck = 0;
                    p.critBonus = 0;
                    const g0 = window.__audioSpy.gains.length;
                    rl.input.state.attack = true;
                    rl.step(1/60);
                    rl.input.state.attack = false;
                    for (let i = 0; i < 90; i++) { rl.step(1/60); }
                    return { gains: window.__audioSpy.gains.slice(g0),
                             landed: foe.hp < 100000 };
                };
                p.element = %d; foe.element = %d;   // ばつぐん
                const good = run();
                p.element = %d; foe.element = %d;   // いまいち
                const bad = run();
                p.element = null; foe.element = null;
                p.base.luck = luck1;
                return { good: good, bad: bad,
                         seVolume: audio.getSeVolume() };
            }))()""" % (good_pair[0], good_pair[1], bad_pair[0], bad_pair[1]))
            k = elem_probe["seVolume"]
            near = lambda run, want: any(abs(v - want) < 0.005 for v in run["gains"])
            # The hit cue's noise ramp is 0.5 x the se() volume; se() scales by
            # the master SE volume (getSeVolume). 0.95 -> 0.475k, 0.55 -> 0.275k.
            check("ばつぐん swing landed",
                  elem_probe["good"]["landed"])
            check("いまいち swing landed",
                  elem_probe["bad"]["landed"])
            check("ばつぐん lands the brighter hit volume",
                  near(elem_probe["good"], 0.475 * k),
                  "want=%.4f got=%s" % (0.475 * k,
                      [v for v in elem_probe["good"]["gains"] if v < 1][:8]))
            check("いまいち lands the duller hit volume",
                  near(elem_probe["bad"], 0.275 * k),
                  "want=%.4f got=%s" % (0.275 * k,
                      [v for v in elem_probe["bad"]["gains"] if v < 1][:8]))

            # -- 4: the SE graph actually fired -----------------------------
            spy = page.evaluate("window.__audioSpy")
            check("AudioContext created (SE unlocked and fired)",
                  spy["contexts"] >= 1, str(spy))
            check("noise bursts synthesised (whoosh/hit)",
                  spy["buffers"] >= 2, str(spy))
            check("tonal layer synthesised (the hit cue's square blip)",
                  spy["oscillators"] >= 1, str(spy))

            # -- 5: stability + cleanliness ---------------------------------
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
        print("ALL OK — hit-stop + slash arc + SE cues verified (T21b); "
              "slash geometry = hitbox, directional knockback, layered SE "
              "verified (T22d)")
        return 0
    print(fails, "check(s) failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
