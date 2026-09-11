# Browser check for the T22h PLAYER-side animation semantics (spec/06):
# the class/model one-shot clips are authored cinematically (attack ~0.87s,
# dodge/hit similar) while the state windows are 0.38s / 0.45s / 0.30s, so
# switching the clip on every state exit truncates each gesture at half.
#   A. the attack clip LINGERS past the 0.38s attack state into idle until
#      the clip's own duration, then hands back to idle
#   B. attacking again during the hold restarts the swing (a new swing is a
#      new gesture; the hold must not swallow the re-entry)
#   C. moving during the hold cuts it immediately -- and battle_run really
#      plays (the open question from the T22h audit: the model ships the
#      clip but nothing had ever observed it run)
#   D. the dodge clip (kirarajump_0) lingers the same way past 0.45s
#   E. the hit flinch (damage clip) lingers past 0.30s
# Durations are probed in-page (the class-action GLBs are meshopt, so the
# Python audit cannot read them; the live mixer can). Owns its server.
# Usage: python tools/rl_anim_player_browser.py [port]
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

# Which clip the view is showing, plus the live action time for a name.
PROBE_CLIPS = """(() => {
    const k = window.kirafanRL, v = k.views.player, p = k.world.player;
    p.iframes = 1e9;
    k.world.enemies.forEach(function (e) { e.actionTimer = 1e9; });
    // Create the actions (the actor builds them lazily on play) and read
    // their authored durations straight off the clips.
    const names = ["idle", "attack", "battle_run", "damage", "kirarajump_0",
                   "dead"];
    const out = {};
    names.forEach(function (n) {
        if (v.actor.play(n, { loop: false, fade: 0 })) {
            const a = v.actor.mixer._actions.find(
                function (x) { return x.getClip().name === n; });
            out[n] = a ? +a.getClip().duration.toFixed(3) : null;
        } else {
            out[n] = null;
        }
    });
    v.actor.play("idle", { loop: true, fade: 0 });
    v.current = "idle";
    return out;
})()"""

# Drive a scenario in-page: press (and release) an input, optionally force a
# state, then step the game and sample [t, view.current, state, actionTime]
# every frame. `press` fires on frame 0 only; `holdMove` keeps move.x set.
DRIVE = """((spec) => {
    const k = window.kirafanRL, v = k.views.player, p = k.world.player;
    p.iframes = 1e9;
    if (spec.press) {
        k.input.state[spec.press] = true;
        window.kirafanRL.step(1 / 60);
        k.input.state[spec.press] = false;
    }
    if (spec.force) { p.sm.set(spec.force); }
    const frames = [];
    for (let i = 0; i < Math.round(spec.sec * 60); i++) {
        if (spec.holdMove !== undefined) { k.input.state.move.x = spec.holdMove; }
        window.kirafanRL.step(1 / 60);
        let at = null;
        if (spec.track) {
            const a = v.actor.mixer._actions.find(
                function (x) { return x.getClip().name === spec.track; });
            at = a ? +a.time.toFixed(3) : null;
        }
        frames.push([i / 60, v.current, p.sm.state, at]);
    }
    k.input.state.move.x = 0;
    return { frames: frames };
})"""


def first_at(frames, name, key=1):
    for f in frames:
        if f[key] == name:
            return f[0]
    return None


def settle(page, sec=1.2):
    page.evaluate("((s) => { for (let i = 0; i < Math.round(s*60); i++)"
                  " window.kirafanRL.step(1/60); })", sec)
    # let any held one-shot finish so scenarios start from clean idle
    return page.evaluate("window.kirafanRL.views.player.current")


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8974
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

            page.goto(url, wait_until="load", timeout=60000)
            deadline = time.time() + 40
            while time.time() < deadline:
                if page.evaluate("!!window.kirafanRL"):
                    break
                page.wait_for_timeout(200)
            check("boot", page.evaluate("!!window.kirafanRL"))
            page.wait_for_selector(".roster-card", timeout=20000)
            page.click(".roster-card")
            deadline = time.time() + 30
            while time.time() < deadline:
                if page.evaluate(
                        "!!(window.kirafanRL.world && window.kirafanRL.world.player)"):
                    break
                page.wait_for_timeout(300)
            for _ in range(90):
                vis = page.evaluate(
                    "(() => { const b = document.getElementById('dialogue-box');"
                    " return !!(b && b.style.display !== 'none'); })()")
                if not vis:
                    break
                page.evaluate("document.getElementById('dialogue-box').click()")
                page.wait_for_timeout(90)
            check("run started", bool(
                page.evaluate("!!window.kirafanRL.world.player")))
            # same rAF stub as the enemy gate: k.step is the only clock now
            page.evaluate("window.requestAnimationFrame = function () { return 0; }")

            dur = page.evaluate(PROBE_CLIPS)
            check("P0 clip durations probed",
                  dur.get("attack") and dur.get("kirarajump_0")
                  and dur.get("damage") and dur.get("battle_run"), dur)
            d_att = dur.get("attack") or 0.867
            d_dge = dur.get("kirarajump_0") or 0.8
            d_hit = dur.get("damage") or 0.8
            check("P1 attack clip really is longer than the 0.38s state",
                  d_att > 0.6, d_att)

            settle(page, 1.5)

            # --- A: attack lingers into idle -----------------------------
            f = page.evaluate(DRIVE, {"press": "attack", "sec": d_att + 0.6,
                                      "track": "attack"}).get("frames", [])
            a_start = first_at(f, "attack")
            a_idle = first_at(f, "idle")
            check("A1 attack clip opens with the attack state",
                  a_start is not None and a_start <= 0.05,
                  "first at %s" % a_start)
            check("A2 attack lingers past the 0.38s state window",
                  a_idle is None or a_idle >= 0.55,
                  "idle at %s (want >= 0.55)" % a_idle)
            check("A3 attack finishes within its own clip length",
                  a_idle is not None and d_att - 0.05 <= a_idle <= d_att + 0.25,
                  "idle at %s (clip %s)" % (a_idle, d_att))
            tail_states = set(x[2] for x in f if x[1] == "attack" and x[0] > 0.45)
            check("A4 the lingering swing spans the idle state",
                  "idle" in tail_states, tail_states)
            att_times = [x[3] for x in f if x[1] == "attack"]
            check("A5 action time runs to the clip end (no restart)",
                  att_times and max(att_times) >= d_att - 0.05,
                  "max t %s" % (max(att_times) if att_times else None))

            settle(page, d_att + 0.5)

            # --- B: re-attack during the hold restarts the swing ---------
            # press at t=0, again at t=0.5 (mid-hold); the action time must
            # reset and the flip to idle must follow the NEW start.
            f = page.evaluate("""((spec) => {
                const k = window.kirafanRL, v = k.views.player, p = k.world.player;
                p.iframes = 1e9;
                k.input.state.attack = true;
                k.step(1/60);
                k.input.state.attack = false;
                const frames = [];
                let pressed = false;
                for (let i = 0; i < Math.round(spec.sec * 60); i++) {
                    k.step(1/60);
                    if (!pressed && i / 60 >= 0.5) {
                        k.input.state.attack = true;
                        k.step(1/60);
                        k.input.state.attack = false;
                        pressed = true;
                    }
                    const a = v.actor.mixer._actions.find(
                        function (x) { return x.getClip().name === 'attack'; });
                    frames.push([i / 60, v.current, p.sm.state,
                                 a ? +a.time.toFixed(3) : null]);
                }
                return { frames: frames };
            })""", {"sec": d_att + 1.0}).get("frames", [])
            mid = [x for x in f if 0.45 <= x[0] <= 0.55]
            t_before = [x[3] for x in f if 0.40 <= x[0] < 0.5]
            t_after = [x[3] for x in f if 0.55 < x[0] <= 0.65]
            check("B1 the hold was live at the re-press (attack showing)",
                  mid and all(x[1] == "attack" for x in mid),
                  [x[:2] for x in mid[:3]])
            check("B2 the re-attack resets the action time (new swing)",
                  t_before and t_after
                  and min(t_after) < min(t_before) + 0.05
                  and min(t_after) < 0.25,
                  "before %s after %s" %
                  (min(t_before) if t_before else None,
                   min(t_after) if t_after else None))
            idle_after = first_at([x for x in f if x[0] >= 0.5], "idle")
            check("B3 the new swing runs to its own end",
                  idle_after is not None and 0.5 + d_att - 0.1 <= idle_after,
                  "idle at %s (want >= %s)" % (idle_after, 0.5 + d_att - 0.1))

            settle(page, d_att + 0.5)

            # --- C: moving during the hold cuts it, and battle_run plays --
            f = page.evaluate("""((spec) => {
                const k = window.kirafanRL, v = k.views.player, p = k.world.player;
                p.iframes = 1e9;
                k.input.state.attack = true;
                k.step(1/60);
                k.input.state.attack = false;
                const frames = [];
                let moved = false;
                for (let i = 0; i < Math.round(spec.sec * 60); i++) {
                    k.step(1/60);
                    if (!moved && i / 60 >= 0.5) {
                        k.input.state.move.x = 1;
                        moved = true;
                    }
                    frames.push([i / 60, v.current, p.sm.state]);
                }
                k.input.state.move.x = 0;
                return { frames: frames };
            })""", {"sec": 1.2}).get("frames", [])
            run_at = first_at([x for x in f if x[0] >= 0.45], "battle_run")
            check("C1 moving during the hold cuts to battle_run",
                  run_at is not None and run_at <= 0.65,
                  "battle_run at %s (want <= 0.65)" % run_at)
            run_frames = [x for x in f if x[1] == "battle_run"]
            check("C2 battle_run actually plays while moving",
                  run_frames and len(run_frames) >= 10
                  and all(x[2] == "move" for x in run_frames),
                  "%d frames" % len(run_frames))
            check("C3 the hold really was live before the cut",
                  any(x[1] == "attack" and x[0] > 0.45 for x in f))

            settle(page, 1.0)

            # --- D: dodge lingers past 0.45s -----------------------------
            f = page.evaluate(DRIVE, {"press": "dodge", "sec": d_dge + 0.6,
                                      "track": "kirarajump_0"}).get("frames", [])
            d_start = first_at(f, "kirarajump_0")
            d_idle = first_at(f, "idle")
            check("D1 dodge clip opens with the dodge state",
                  d_start is not None and d_start <= 0.05,
                  "first at %s" % d_start)
            if d_dge > 0.55:
                check("D2 dodge lingers past the 0.45s state window",
                      d_idle is None or d_idle >= 0.55,
                      "idle at %s (want >= 0.55)" % d_idle)
                check("D3 dodge finishes within its own clip length",
                      d_idle is not None
                      and d_dge - 0.05 <= d_idle <= d_dge + 0.25,
                      "idle at %s (clip %s)" % (d_idle, d_dge))
            else:
                check("D2/D3 dodge clip fits its window (no linger needed)",
                      True, "clip %s" % d_dge)

            settle(page, d_dge + 0.5)

            # --- E: hit flinch lingers past 0.30s ------------------------
            f = page.evaluate(DRIVE, {"force": "hit", "sec": d_hit + 0.6,
                                      "track": "damage"}).get("frames", [])
            e_start = first_at(f, "damage")
            e_idle = first_at(f, "idle")
            check("E1 hit state plays the damage clip",
                  e_start is not None and e_start <= 0.05,
                  "first at %s" % e_start)
            check("E2 the flinch lingers past the 0.30s state window",
                  e_idle is None or e_idle >= 0.4,
                  "idle at %s (want >= 0.4)" % e_idle)
            check("E3 the flinch finishes within its own clip length",
                  e_idle is not None and d_hit - 0.05 <= e_idle <= d_hit + 0.25,
                  "idle at %s (clip %s)" % (e_idle, d_hit))

            check("F1 no pageerrors during the run", not errors, errors[:3])

            browser.close()
    finally:
        server.terminate()
        server.wait()

    print("\n%s (%d fails)" % ("ALL OK" if fails == 0 else "FAILED", fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
