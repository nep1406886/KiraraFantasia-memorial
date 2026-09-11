# T23e run-cycle dip check for the player foot lift. The lift controller
# (actorview.js sync) measures the lowest visible leg vertex EVERY frame in
# idle/move and eases the root up (rate 12/s) to FLOOR_Y, keeping the worst
# seen forever -- so the only residual risk is easing lag against a fast
# animated dip. This probe drives the REAL pipeline per character (roster
# boot -> actor + clips + actorview), steps the clock deterministically, and
# samples world-space min leg Y each frame:
#   idle  6s  (bob cycle)     move 4s  (battle_run leg cycle, state forced)
# Pass: after a 1s warm-up (ease-in), every frame's leg min Y stays at or
# above FLOOR_Y - 0.01. Owns its server. Usage: python tools/rl_legdip_browser.py [port] [--only rid,rid]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "legdip_results.json"

FLOOR_Y = -0.02          # actorview.js — mapview.js GROUND_Y
WARMUP = 60              # frames (1s) — ease-in transient, excluded from pass
TOL = 0.01               # easing residue + numeric slack below FLOOR_Y

# Enumerate the roster cards with their card id (from the art src) and name,
# so Python can pick the right one without trusting DOM order.
LIST_CARDS = """() => {
    return Array.from(document.querySelectorAll('.roster-card')).map((el, i) => {
        const img = el.querySelector('img.art');
        const m = img && img.src ? img.src.match(/(\\d+)\\.webp/) : null;
        const who = el.querySelector('.who');
        const nameSpan = who ? who.querySelector('span:nth-child(2)') : null;
        return { i: i, id: m ? m[1] : null, name: nameSpan ? nameSpan.textContent : '' };
    });
}"""

CLICK_CARD = """(i) => {
    const cards = document.querySelectorAll('.roster-card');
    if (!cards[i]) { return false; }
    cards[i].click();
    return true;
}"""

# Neutralize the dungeon (no freeze: the move scenario needs the state
# machine live), then settle the follow camera.
PARK = """() => {
    const rl = window.kirafanRL;
    const p = rl.world.player;
    p.iframes = 1e9;
    rl.world.enemies.forEach(function (e) { e.actionTimer = 1e9; });
    rl.views.enemies.forEach(function (v) {
        if (v.object) { v.object.visible = false; }
    });
    for (let i = 0; i < 90; i++) { rl.step(1 / 60); }
    return { x: p.x, y: p.y, state: p.sm ? p.sm.state : null };
}"""

# Drive one scenario in-page. Per frame: optionally re-force the state and
# hold the move input, step, then measure the lowest visible leg vertex in
# WORLD space (same matrix math as the actorview controller, but keeping
# rootY in: world Y is what the floor occludes). Returns compact frames
# [t, worldMinY] plus a state histogram.
LEGDIP = """((spec) => {
    const rl = window.kirafanRL, v = rl.views.player, p = rl.world.player;
    const LEG_RE = /^leg_[LR]_/i;
    const frames = [];
    const states = {};
    for (let i = 0; i < Math.round(spec.sec * 60); i++) {
        if (spec.force && p.sm.state !== spec.force) { p.sm.set(spec.force); }
        if (spec.holdMove !== undefined) { rl.input.state.move.x = spec.holdMove; }
        rl.step(1 / 60);
        states[p.sm.state] = (states[p.sm.state] || 0) + 1;
        const rootY = v.actor.object.position.y;
        let worst = Infinity;
        v.actor.object.traverse(function (child) {
            if (!child.isMesh || !child.geometry || !child.visible
                    || !LEG_RE.test(child.name || "")) { return; }
            child.updateWorldMatrix(true, false);
            const pos = child.geometry.attributes.position;
            if (!pos) { return; }
            const e = child.matrixWorld.elements;
            for (let k = 0; k < pos.count; k++) {
                const wy = e[1] * pos.getX(k) + e[5] * pos.getY(k)
                    + e[9] * pos.getZ(k) + e[13];
                if (wy < worst) { worst = wy; }
            }
        });
        frames.push([+(i / 60).toFixed(3),
                     worst === Infinity ? null : +worst.toFixed(4)]);
    }
    if (spec.holdMove !== undefined) { rl.input.state.move.x = 0; }
    return { frames: frames, states: states, lift: +v.actor.object.position.y.toFixed(4) };
})"""


def dismiss_dialogue(page):
    for _ in range(120):
        if not page.evaluate(
                "(() => { const b = document.getElementById('dialogue-box');"
                " return !!(b && b.style.display !== 'none'); })()"):
            return True
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)
    return False


def boot_character(page, port, card_index):
    """On the roster page, select card_index and wait for the player view."""
    page.evaluate(CLICK_CARD, card_index)
    deadline = time.time() + 60
    while time.time() < deadline:
        ok = page.evaluate(
            "(() => { const rl = window.kirafanRL;"
            " return !!(rl && rl.world && rl.world.player"
            " && rl.views.player && rl.views.player.actor"
            " && rl.views.player.actor.object); })()")
        if ok:
            break
        page.wait_for_timeout(250)
    else:
        return False
    return dismiss_dialogue(page)


def summarize(frames, states, force_state):
    """-> dict with warm/all dips below FLOOR_Y (negative = below floor)."""
    ys_all = [f[1] for f in frames if f[1] is not None]
    ys_warm = ys_all[WARMUP:]
    worst_all = min(ys_all) if ys_all else None
    worst_warm = min(ys_warm) if ys_warm else None
    out = {
        "states": states,
        "dipWarm": None if worst_warm is None
        else round(worst_warm - FLOOR_Y, 4),
        "dipAll": None if worst_all is None
        else round(worst_all - FLOOR_Y, 4),
    }
    if force_state:
        frac = states.get(force_state, 0) / max(1, len(frames))
        out[force_state + "Frac"] = round(frac, 2)
    return out


def main() -> int:
    port = 8991
    only = None
    for a in sys.argv[1:]:
        if a.isdigit():
            port = int(a)
        elif a.startswith("--only="):
            only = [s for s in a.split("=", 1)[1].split(",") if s]
    players = json.load(open(ROOT / ".cache/sweep_players.json"))
    rids = players["rids"]
    names = players["names"]
    if only:
        rids = [r for r in rids if str(r) in only]
    rid2ids = {}
    for row in json.load(
            open(ROOT / "site/asset/rl/cards-rl.json", encoding="utf-8"))["cards"]:
        rid2ids.setdefault(str(row.get("resourceId")), []).append(
            str(row.get("id")))
    try:
        results = json.load(open(OUT, encoding="utf-8"))
    except Exception:
        results = {}

    def save():
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)

    print("leg-dip sweep: %d players, FLOOR_Y=%s warmup=%df tol=%s"
          % (len(rids), FLOOR_Y, WARMUP, TOL))
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.0)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            for idx, rid in enumerate(rids):
                label = "pl_%d" % rid
                page.goto("about:blank")
                try:
                    page.goto(
                        "http://127.0.0.1:%d/site/game/roguelike.html" % port,
                        wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_selector(".roster-card", timeout=30000)
                    cards = page.evaluate(LIST_CARDS)
                except Exception as exc:
                    results[label] = {"flags": ["BOOT-FAIL"],
                                      "error": str(exc)[:200]}
                    save()
                    print("[%2d/%d] %-12s BOOT-FAIL %s"
                          % (idx + 1, len(rids), label, exc))
                    continue
                want = rid2ids.get(str(rid)) or [str(rid * 100)]
                pick = next((c for c in cards if c["id"] in want), None)
                if pick is None:
                    want_name = names.get(str(rid), "")
                    pick = next((c for c in cards
                                 if c["name"] == want_name), None)
                if pick is None:
                    results[label] = {"flags": ["NO-CARD"]}
                    save()
                    print("[%2d/%d] %-12s NO-CARD" % (idx + 1, len(rids),
                                                      label))
                    continue
                if not boot_character(page, port, pick["i"]):
                    results[label] = {"flags": ["NO-VIEW"]}
                    save()
                    print("[%2d/%d] %-12s NO-VIEW" % (idx + 1, len(rids),
                                                      label))
                    continue
                park = page.evaluate(PARK)
                idle = page.evaluate(LEGDIP, {"sec": 6.0})
                move = page.evaluate(
                    LEGDIP, {"sec": 4.0, "force": "move", "holdMove": 1})
                idle_s = summarize(idle["frames"], idle["states"], None)
                move_s = summarize(move["frames"], move["states"], "move")
                flags = []
                for tag, s in (("idle", idle_s), ("move", move_s)):
                    if s["dipWarm"] is None:
                        flags.append("NO-LEGS-" + tag)
                    elif s["dipWarm"] < -TOL:
                        flags.append("DIP-" + tag)
                if "moveFrac" in move_s and move_s["moveFrac"] < 0.8:
                    flags.append("NOT-MOVE")
                results[label] = {
                    "park": park, "idle": idle_s, "move": move_s,
                    "liftAfter": move["lift"], "flags": flags,
                    "states": {"idle": idle["states"],
                               "move": move["states"]},
                }
                save()
                print("[%2d/%d] %-12s idle dipWarm=%s move dipWarm=%s "
                      "lift=%s %s"
                      % (idx + 1, len(rids), label, idle_s["dipWarm"],
                         move_s["dipWarm"], move["lift"],
                         "OK" if not flags else " ".join(flags)))
            browser.close()
            if errors:
                print("PAGEERRORS (%d):" % len(errors))
                for e in errors[:10]:
                    print("  ", e[:300])
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    save()
    # flags always mean failure here (OK records carry an empty list)
    bad = [k for k, v in results.items() if v.get("flags")]
    print("done: %d records, %d bad -> %s"
          % (len(results), len(bad), OUT))
    for k in bad:
        print("  BAD", k, results[k].get("flags"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
