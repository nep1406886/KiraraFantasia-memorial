# Browser gate for the 7 new SE recipes (plan §2.3 / plan line 881).
# The original's SE shipped as CRIWARE banks that are gone, so core/audio.js
# synthesises every cue from WebAudio recipes keyed by the original cue names,
# and an unknown name is a caught mistake (console warning), not silence.
# This gate pins both halves of that contract:
#   offline: RECIPES holds exactly the 19 cues the node-count table knows,
#            and main.js wires all 7 new cues (dodge/crit/pickup/door/death/
#            levelup/guard); the crit branch no longer borrows chime
#   browser A (synthesis): each of the 19 cues builds exactly the nodes its
#            recipe body says (noiseBurst -> 1 buffer source, tone -> 1
#            oscillator), counted by an AudioContext wrapper; an unknown cue
#            warns exactly once and builds nothing
#   browser B (wiring): pushing each world event and stepping one frame
#            synchronously fires exactly the cues the consumeEvents branches
#            own — dodge 2 noise, pickup 1+3, levelup 1+4, roomClear(door)
#            1+1, a player crit hit = hit+crit 2+2, an いまいち hit =
#            hit+guard 2+2, and a killing blow on the player = hit+death 2+3
#            (finishRun("defeat") ends the run, so death is pushed last)
# `new AudioContext()` is lazy and detached, so the gate wraps it into
# window.__synth counters via an init script; --autoplay-policy keeps the
# context out of suspended state so headless adds no autoplay warnings.
# Owns its server. Usage: python tools/rl_se_browser.py [port]
import json
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
AUDIO_SRC = ROOT / "site" / "core" / "audio.js"
MAIN_SRC = ROOT / "site" / "game" / "rl" / "main.js"

NEW_CUES = ["dodge", "crit", "pickup", "door", "death", "levelup", "guard"]

# (buffer sources, oscillators) per cue, read straight off each recipe body:
# one noiseBurst call builds 1 createBufferSource, one tone call builds 1
# createOscillator. Case A asserts these exact counts against the live module.
NODE_COUNTS = {
    "footstep_run": (6, 0),
    "footstep": (1, 0),
    "page_turn": (2, 0),
    "page_fade": (1, 1),
    "ui_confirm": (0, 2),
    "ui_cancel": (0, 1),
    "ui_click": (1, 0),
    "chime": (1, 2),
    "whoosh": (1, 0),
    "hit": (1, 1),
    "magic": (1, 5),
    "special": (1, 2),
    "dodge": (2, 0),
    "crit": (1, 1),
    "pickup": (1, 3),
    "door": (1, 1),
    "death": (1, 2),
    "levelup": (1, 4),
    "guard": (1, 1),
}

# World event -> (buffer sources, oscillators) expected from the
# consumeEvents branches that own each cue. The hit rows stack the impact
# thud with the layered cue (crit / guard / death).
WIRING = [
    ("dodge", (2, 0)),
    ("pickup", (1, 3)),
    ("levelup", (1, 4)),
    ("roomClear", (1, 1)),
    ("crit", (2, 2)),
    ("guard", (2, 2)),
    # LAST: the branch calls finishRun("defeat"), which ends the run.
    ("death", (2, 3)),
]

INIT_SCRIPT = """
window.__synth = { osc: 0, noise: 0 };
class LoggedAC extends window.AudioContext {
    createOscillator() {
        window.__synth.osc += 1;
        return super.createOscillator();
    }
    createBufferSource() {
        window.__synth.noise += 1;
        return super.createBufferSource();
    }
}
window.AudioContext = LoggedAC;
"""

# One synchronous turn: snapshot, push the event built in-page (dodge/death
# need the live world.player reference), step one frame, report deltas. The
# natural rAF loop cannot interleave with a synchronous evaluate.
PUSH_AND_STEP = """(kind) => {
    const w = window.kirafanRL.world;
    const makers = {
        dodge: () => ({ type: "dodge", unit: w.player }),
        pickup: () => ({ type: "pickup", items: [{}], drop: null, x: 0, y: 0 }),
        levelup: () => ({ type: "levelup", unit: w.player, level: 2, healed: 3 }),
        roomClear: () => ({ type: "roomClear" }),
        crit: () => ({ type: "hit", damage: 7, crit: true,
                       target: { kind: "enemy", x: 0, y: 0 },
                       attacker: { kind: "player", element: 0 } }),
        guard: () => ({ type: "hit", damage: 4, hitFlag: -1,
                        target: { kind: "enemy", x: 0, y: 0 },
                        attacker: { kind: "player", element: 0 } }),
        death: () => ({ type: "hit", damage: 999, died: true,
                        target: w.player, attacker: { kind: "enemy" } })
    };
    const ev = makers[kind]();
    const before = { n: window.__synth.noise, o: window.__synth.osc };
    w.events.push(ev);
    window.kirafanRL.step(1 / 60);
    return { n: window.__synth.noise - before.n,
             o: window.__synth.osc - before.o };
}"""


def check_offline(check) -> None:
    src = AUDIO_SRC.read_text(encoding="utf-8")
    body = src.split("const RECIPES = {", 1)[1].split("\n};", 1)[0]
    keys = re.findall(r"^    (\w+): function", body, re.M)
    check("RECIPES holds 19 cues", len(keys) == 19, len(keys))
    check("recipe set matches the node-count table",
          set(keys) == set(NODE_COUNTS),
          sorted(set(keys) ^ set(NODE_COUNTS)))
    main = MAIN_SRC.read_text(encoding="utf-8")
    missing = [c for c in NEW_CUES if ('audio.se("%s"' % c) not in main]
    check("all 7 new cues wired in main.js", not missing, missing)
    check("crit no longer borrows chime (the 0.22 call is gone)",
          'audio.se("chime", { volume: 0.22 }' not in main)


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            return True
        page.wait_for_timeout(200)
    return False


def start_run(page):
    page.wait_for_selector(".roster-card", timeout=20000)
    page.evaluate("document.querySelector('.roster-card').click()")
    deadline = time.time() + 30
    while time.time() < deadline \
            and not page.evaluate("!!window.kirafanRL.world.player"):
        page.wait_for_timeout(200)
    return bool(page.evaluate("!!window.kirafanRL.world.player"))


def dismiss_dialogues(page, rounds=90):
    for _ in range(rounds):
        vis = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " return !!(b && b.style.display !== 'none'); })()")
        if not vis:
            return True
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)
    return False


def unlock_module(page):
    # Same resolved URL as main.js's import, so this is the live module
    # instance the consumeEvents branches play through. Kept on window so
    # the per-cue evaluates can call se() directly.
    return page.evaluate("""async () => {
        const m = await import("../core/audio.js");
        window.__audio = m;
        m.unlock();
        m.setSeVolume(1);
        return m.SE_CUES;
    }""")


def run_synth_case(page, base_url, check, warnings, errors) -> None:
    if not boot(page, base_url):
        check("boot (synthesis case)", False)
        return
    cues = unlock_module(page)
    check("module exposes 19 cues", len(cues) == 19, cues)
    for cue in cues:
        got = page.evaluate("""(cue) => {
            const before = { n: window.__synth.noise, o: window.__synth.osc };
            window.__audio.se(cue, { volume: 1 });
            return { n: window.__synth.noise - before.n,
                     o: window.__synth.osc - before.o };
        }""", cue)
        want = NODE_COUNTS.get(cue)
        check("se(%s) builds %s" % (cue, want),
              want is not None and (got["n"], got["o"]) == want, got)

    # Negative: an unknown cue must warn once and build nothing.
    before = page.evaluate("JSON.parse(JSON.stringify(window.__synth))")
    n_warn = len(warnings)
    page.evaluate("window.__audio.se('__nope__')")
    after = page.evaluate("JSON.parse(JSON.stringify(window.__synth))")
    new = warnings[n_warn:]
    check("unknown cue builds nothing", before == after,
          {"before": before, "after": after})
    check("unknown cue warns exactly once",
          len(new) == 1 and 'unknown cue "__nope__"' in new[0], new)
    check("synthesis: no pageerrors", not errors, errors[:3])


def run_wiring_case(page, base_url, check, warnings, errors) -> None:
    if not boot(page, base_url):
        check("boot (wiring case)", False)
        return
    if not start_run(page):
        check("player loaded (wiring case)", False)
        return
    dismiss_dialogues(page)
    unlock_module(page)

    quiet = page.evaluate("""() => {
        const before = { n: window.__synth.noise, o: window.__synth.osc };
        window.kirafanRL.step(1 / 60);
        return { n: window.__synth.noise - before.n,
                 o: window.__synth.osc - before.o };
    }""")
    check("quiet world steps silently", quiet == {"n": 0, "o": 0}, quiet)

    for kind, want in WIRING:
        got = page.evaluate(PUSH_AND_STEP, kind)
        check("event %s fires %s" % (kind, want),
              (got["n"], got["o"]) == want, got)
    check("wiring: no pageerrors", not errors, errors[:3])
    check("wiring: no console warnings", not warnings, warnings[:3])


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8986
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
        check_offline(check)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                      "--autoplay-policy=no-user-gesture-required"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.add_init_script(INIT_SCRIPT)
            base_url = "http://127.0.0.1:%d/site/game/roguelike.html" % port

            warnings, errors = [], []
            page.on("console", lambda m: warnings.append(m.text)
                    if m.type in ("warning", "error")
                    and "GL Driver Message" not in m.text else None)
            page.on("pageerror", lambda e: errors.append(str(e)))

            run_synth_case(page, base_url, check, warnings, errors)

            warnings, errors = [], []   # fresh collectors for the wiring case
            run_wiring_case(page, base_url, check, warnings, errors)

            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    print("=" * 60)
    if fails == 0:
        print("ALL OK — 7 new SE recipes (plan §2.3)")
        return 0
    print(fails, "check(s) failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
