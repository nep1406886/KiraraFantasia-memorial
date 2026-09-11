# Browser check for the T22h enemy animation semantics (spec/06):
#   A. telegraph on a charge_skill model resolves to the looping charge clip
#      and hands off to skill_0 when the skill state opens
#   B. the skill gesture LINGERS past its 0.45s state window until the clip
#      (1.33s on model_en_1000) finishes, then falls back to idle -- instead
#      of being truncated and popping back
#   C. damage lingers the same way past the 0.35s flinch window
#   D. death sinks the animated model: family A dead clips animate nothing
#      usable (the corpse would stand in idle pose all room), family B rises
#      +0.45 for a fade this game does not run -- the sink is the readable
#      death, monotone, floored at -0.8, never rising
#   E. on a model WITHOUT charge_skill (model_en_11500) the telegraph falls
#      back to skill_0, carries it through the skill window without a
#      restart, and lingers to the clip's own end
# Owns its server. Usage: python tools/rl_anim_browser.py [port]
#
# Durations these assertions are pinned to come from tools/rl_anim_audit.py
# (.cache/rl_anim_audit.json): 1000 skill_0 1.33s / damage 0.80s,
# 11500 skill_0 1.17s. If the audit moves, move the pins.
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

DT = 1.0 / 60.0


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
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


SPAWN = """((mid) => {
    const k = window.kirafanRL, w = k.world, p = w.player;
    p.iframes = 1e9;
    w.enemies.forEach(function (e) {
        e.actionTimer = 1e9;
        if (e.sm && e.sm.state === 'telegraph') { e.sm.force('idle'); }
    });
    const u = w.spawnEnemy({ model: mid, x: p.x + 2, y: p.y,
        hp: 60, aiType: 'sentry', room: w.room.id });
    u.actionTimer = 1e9;
    // ensureEnemyViews only runs inside consumeEvents (room/summon), and a
    // directly spawned unit emits neither -- queue the same event the world
    // itself uses for reinforcements so the view attaches on the next step.
    w.events.push({ type: 'summon', unit: u, count: 0 });
    window.kirafanRL.step(1 / 60);
    return { id: u.id };
})"""


def wait_view(page, uid, timeout=40):
    """The model load is async and only progresses while the page's event
    loop runs, so poll from Python instead of looping inside one evaluate."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        got = page.evaluate("""((id) => {
            const k = window.kirafanRL;
            const v = k.views.enemies.find(function (x) { return x.unit.id === id; });
            return v ? { clip: v.current, y: v.object.position.y } : null;
        })""", uid)
        if got is not None:
            return got
        page.wait_for_timeout(150)
    return None

# Runs the scenario entirely in-page: steps the game loop, samples
# view.current / state / root y every frame, and reports the timeline plus
# when the clip first changed to each target name. sec are seconds of game
# time to run after setting the state.
DRIVE = """((spec) => {
    const k = window.kirafanRL;
    const u = k.world.enemies.find(function (e) { return e.id === spec.id; });
    const view = k.views.enemies.find(function (v) { return v.unit === u; });
    if (!u || !view) { return { error: 'unit or view gone' }; }
    if (spec.setState) {
        if (!u.sm.set(spec.setState)) { return { error: 'sm.set rejected' }; }
    }
    if (spec.kill) { u.hp = 0; u.dead = true; u.sm.force('dead'); }
    const frames = [];
    for (let i = 0; i < Math.round(spec.sec * 60); i++) {
        window.kirafanRL.step(1 / 60);
        frames.push([i / 60, view.current, u.sm.state,
                     +view.object.position.y.toFixed(3)]);
    }
    return { frames: frames };
})"""


def first_at(frames, name, key=1):
    for t, cur, state, y in frames:
        if cur == name:
            return t
    return None


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8972
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

            check("boot", boot(page, url))
            page.wait_for_selector(".roster-card", timeout=20000)
            page.click(".roster-card")
            deadline = time.time() + 30
            while time.time() < deadline:
                if page.evaluate(
                        "!!(window.kirafanRL.world && window.kirafanRL.world.player)"):
                    break
                page.wait_for_timeout(300)
            dismiss_dialogue(page)
            check("run started", bool(
                page.evaluate("!!window.kirafanRL.world.player")))
            # The page runs its own rAF clock; between evaluates it would
            # advance the world by real time and smear every timing pin.
            # Stubbing rAF stops the clock's re-arm (at most one already
            # scheduled frame still fires); k.step is the only driver now.
            page.evaluate("window.requestAnimationFrame = function () { return 0; }")

            # --- A/B/C/D: model_en_1000 (charge_skill, dead family A) ------
            r = page.evaluate(SPAWN, "model/enemy/model_en_1000.muast")
            uid = r.get("id")
            v0 = wait_view(page, uid) if uid else None
            check("A0 spawn+view", v0 is not None and v0.get("clip") == "idle",
                  v0)

            # A: telegraph -> charge_skill, handoff to skill_0
            f = page.evaluate(DRIVE, {"id": uid, "setState": "telegraph",
                                      "sec": 0.7}).get("frames", [])
            a_charge = first_at(f, "charge_skill")
            check("A1 telegraph plays charge_skill", a_charge is not None
                  and a_charge <= 0.05, "first at %s" % a_charge)
            mid_t = [x for x in f if 0.3 < x[0] < 0.6]
            check("A2 charge_skill held through telegraph",
                  mid_t and all(x[1] == "charge_skill" for x in mid_t))

            # B: skill window -> skill_0, then linger to clip end (1.33s)
            f = page.evaluate(DRIVE, {"id": uid, "sec": 3.0}).get("frames", [])
            b_skill = first_at(f, "skill_0")
            b_idle = first_at(f, "idle")
            # clip has played 0.45s of 1.33 when idle lands; flip ~0.88s later
            check("B1 skill_0 opens with skill state",
                  b_skill is not None and b_skill <= 0.1,
                  "first at %s" % b_skill)
            check("B2 skill_0 lingers past the 0.45s window",
                  b_idle is None or b_idle >= 0.75,
                  "idle at %s (want >= 0.75)" % b_idle)
            check("B3 skill_0 finishes within the clip's own length",
                  b_idle is not None and b_idle <= 1.45,
                  "idle at %s (want <= 1.45)" % b_idle)
            linger_states = set(x[2] for x in f if x[1] == "skill_0")
            check("B4 lingering clip spans idle state",
                  "idle" in linger_states, linger_states)

            # C: damage lingers past the 0.35s flinch (clip 0.80s)
            page.evaluate(DRIVE, {"id": uid, "setState": "damage", "sec": 0.1})
            f = page.evaluate(DRIVE, {"id": uid, "sec": 1.5}).get("frames", [])
            c_dmg = [x for x in f if x[1] == "damage"]
            c_idle = first_at(f, "idle")
            check("C1 damage clip plays", bool(c_dmg))
            check("C2 damage lingers past 0.35s flinch",
                  c_dmg and c_dmg[-1][0] >= 0.5,
                  "last damage frame %s" % (c_dmg[-1][0] if c_dmg else None))
            check("C3 damage clip ends within its own 0.80s",
                  c_idle is not None and 0.35 <= c_idle <= 0.85,
                  "idle at %s" % c_idle)

            # D: death sinks, monotone, floored, never rises (family A)
            f = page.evaluate(DRIVE, {"id": uid, "kill": True, "sec": 1.5}).get("frames", [])
            ys = [x[3] for x in f]
            below = next((x[0] for x in f if x[3] <= -0.3), None)
            floor_hit = next((x[0] for x in f if x[3] <= -0.79), None)
            drops = [ys[i + 1] - ys[i] for i in range(len(ys) - 1)]
            check("D1 corpse sinks below -0.3 within 0.6s",
                  below is not None and below <= 0.6, "below -0.3 at %s" % below)
            check("D2 sink reaches the -0.8 floor", floor_hit is not None,
                  "final y %s" % (ys[-1] if ys else None))
            check("D3 sink is monotone (no rise)",
                  all(d <= 0.001 for d in drops),
                  "max rise %s" % (max(drops) if drops else 0))
            check("D4 no pageerrors during A-D", not errors, errors[:3])
            if errors:
                errors.clear()

            # --- E: model_en_11500 (no charge_skill, dead family B) --------
            r = page.evaluate(SPAWN, "model/enemy/model_en_11500.muast")
            uid2 = r.get("id")
            v0 = wait_view(page, uid2) if uid2 else None
            check("E0 spawn+view", v0 is not None and v0.get("clip") == "idle",
                  v0)

            f = page.evaluate(DRIVE, {"id": uid2, "setState": "telegraph",
                                      "sec": 0.7}).get("frames", [])
            e_fall = first_at(f, "skill_0")
            check("E1 telegraph falls back to skill_0 (no charge clip)",
                  e_fall is not None and e_fall <= 0.05,
                  "first at %s" % e_fall)
            check("E2 no looped charge name on a fallback model",
                  first_at(f, "charge_skill") is None)

            # carry through skill window without restart, linger to 1.17s
            f = page.evaluate(DRIVE, {"id": uid2, "sec": 2.5}).get("frames", [])
            e_skill = [x for x in f if x[1] == "skill_0"]
            e_idle = first_at(f, "idle")
            check("E3 skill_0 carried without restart",
                  bool(e_skill) and e_skill[0][0] <= 0.1)
            check("E4 skill_0 outlives the 0.45s window (barely: the clip is "
                  "1.17s and telegraph+skill already ate 1.15s)",
                  e_idle is None or e_idle >= 0.4,
                  "idle at %s" % e_idle)
            check("E5 flips well inside the 1.17s clip",
                  e_idle is not None and e_idle <= 0.7,
                  "idle at %s" % e_idle)

            # family B dead rises +0.45 in the clip -- the sink must win
            f = page.evaluate(DRIVE, {"id": uid2, "kill": True, "sec": 1.5}).get("frames", [])
            ys = [x[3] for x in f]
            check("E6 risen-clip corpse does NOT rise (+0.45 authored)",
                  ys and max(ys) <= 0.15, "max y %s" % (max(ys) if ys else None))
            check("E7 family B corpse still sinks to the floor",
                  ys and ys[-1] <= -0.79, "final y %s" % (ys[-1] if ys else None))
            check("E8 no pageerrors during E", not errors, errors[:3])

            browser.close()
    finally:
        server.terminate()
        server.wait()

    print("\n%s (%d fails)" % ("ALL OK" if fails == 0 else "FAILED", fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
