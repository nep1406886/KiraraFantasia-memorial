# Browser gate for T21e posture fixes (spec/06 T21e): the POSTURE table in
# game/rl/view/enemyview.js lifts the static models whose rest pose sits in
# the ground, and swaps 12001 to its baked corpse on death.
#   1. each lifted model's feet land on the ground plane (world minY of the
#      VISIBLE meshes, tolerance absorbs the ±0.06 idle bob)
#   2. 12001 hides its corpse meshes while alive, shows them (and only them)
#      once dead, holds at deadLift, and never runs the generic sink
#   3. an unlisted static model is untouched: alive bob only, death sinks
#   4. no pageerrors / console warnings
# Owns its server. Usage: python tools/rl_posture_browser.py [port]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

# T24e (spec/06): the T21e hand-audited lifts predate the billboard tilt and
# floated 10-26cm once it went live; re-sized per the T24e record. 12001
# keeps its hand lift (rests +0.022, corpse-swap bands tuned around it).
LIFT_CASES = {
    "model/enemy/model_en_12001.muast": 0.12,
    "model/enemy/model_en_14304.muast": 0.27,
    "model/enemy/model_en_11804.muast": 0.155,
    "model/enemy/model_en_11801.muast": 0.155,
    "model/enemy/model_en_11301.muast": 0.087,
}
DEAD_PARTS = ["deadbody_obj", "deadsword_obj"]
CONTROL = "model/enemy/model_en_10501.muast"   # authored hover, no POSTURE

# Spawns one frozen unit, waits for its view, then answers everything the
# gate needs from inside the page: feet, per-mesh visibility, and what the
# death path does to position.y over further steps.
PROBE = """(arg) => {
    const model = arg.model;
    const wantDead = arg.dead;
    return new Promise((resolve) => {
        const rl = window.kirafanRL;
        const w = rl.world;
        w.frozen = true;
        const unit = w.spawnEnemy({
            model: model, name: 'probe', nameZh: 'probe',
            x: 12, y: 9, hp: 999999, aiType: 'sentry'
        });
        w.events.push({ type: 'summon' });
        const t0 = performance.now();
        const timer = setInterval(() => {
            rl.step(1 / 60);
            const view = rl.views.enemies.find(v => v.unit === unit);
            if (!view && performance.now() - t0 < 20000) { return; }
            clearInterval(timer);
            let out = { model: model, attached: !!view };
            if (view) {
                const root = view.object;
                root.updateWorldMatrix(true, true);
                // Ground truth is the world-space minY of the VISIBLE
                // meshes only (the hidden corpse must not count), read
                // directly against the ground plane y = 0 -- subtracting
                // root.position.y would cancel the lift being tested.
                let minY = 1e9;
                const meshes = [];
                const perMeshMin = {};
                root.traverse(function (child) {
                    if (!child.isMesh || !child.geometry) { return; }
                    const pos = child.geometry.attributes.position;
                    if (!pos || !pos.count) { return; }
                    meshes.push({ name: child.name, visible: child.visible });
                    if (!child.visible) { return; }
                    const e = child.matrixWorld.elements;
                    let lo = 1e9;
                    for (let i = 0; i < pos.count; i++) {
                        const wy = e[1]*pos.getX(i) + e[5]*pos.getY(i)
                                 + e[9]*pos.getZ(i) + e[13];
                        if (wy < minY) { minY = wy; }
                        if (wy < lo) { lo = wy; }
                    }
                    perMeshMin[child.name] = lo;
                });
                out.minY = minY;
                out.meshes = meshes;
                out.perMeshMin = perMeshMin;
                if (!wantDead) {
                    out.posY = root.position.y;
                } else {
                    unit.dead = true;
                    for (let i = 0; i < 240; i++) { rl.step(1/60); }
                    out.posYDead = root.position.y;
                    root.updateWorldMatrix(true, true);
                    out.perMeshMinDead = {};
                    out.visDead = {};
                    root.traverse(function (child) {
                        if (!child.isMesh || !child.geometry) { return; }
                        out.visDead[child.name] = child.visible;
                        if (!child.visible) { return; }
                        const pos = child.geometry.attributes.position;
                        if (!pos || !pos.count) { return; }
                        const e = child.matrixWorld.elements;
                        let lo = 1e9;
                        for (let i = 0; i < pos.count; i++) {
                            const wy = e[1]*pos.getX(i) + e[5]*pos.getY(i)
                                     + e[9]*pos.getZ(i) + e[13];
                            if (wy < lo) { lo = wy; }
                        }
                        out.perMeshMinDead[child.name] = lo;
                    });
                }
                view.dispose();
            }
            const i = w.enemies.indexOf(unit);
            if (i >= 0) { w.enemies.splice(i, 1); }
            resolve(out);
        }, 20);
    });
}"""


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
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8981
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
            page.evaluate("document.querySelector('.roster-card').click()")
            deadline = time.time() + 30
            while time.time() < deadline \
                    and not page.evaluate("!!window.kirafanRL.world.player"):
                page.wait_for_timeout(200)
            check("player loaded", page.evaluate("!!window.kirafanRL.world.player"))
            dismiss_boot_dialogue(page)
            page.evaluate("(() => { const p = window.kirafanRL.world.player;"
                          " p.x = 2; p.y = 2; })()")

            # -- 1: lifted models land on the ground ---------------------
            for model, lift in LIFT_CASES.items():
                out = page.evaluate(PROBE, {"model": model, "dead": False})
                name = model.split("/")[-1]
                if not out.get("attached"):
                    check("%s view attached" % name, False)
                    continue
                check("%s feet on the ground (lift %.2f)" % (name, lift),
                      abs(out["minY"]) <= 0.12,
                      "minY=%+.3f (bob ±0.06)" % out["minY"])
                check("%s lift applied to position.y" % name,
                      abs(out["posY"] - lift) <= 0.07,
                      "posY=%+.3f (bob ±0.06)" % out["posY"])

            # -- 2: 12001 corpse swap ------------------------------------
            alive = page.evaluate(PROBE, {"model": "model/enemy/model_en_12001.muast", "dead": False})
            vis = {m["name"]: m["visible"] for m in alive["meshes"]}
            corpse_hidden = all(not vis.get(n, True) for n in DEAD_PARTS)
            live_shown = all(v for n, v in vis.items() if n not in DEAD_PARTS)
            check("12001 corpse hidden while alive", corpse_hidden,
                  {n: vis.get(n) for n in DEAD_PARTS})
            check("12001 live parts shown while alive", live_shown)

            dead = page.evaluate(PROBE, {"model": "model/enemy/model_en_12001.muast", "dead": True})
            visd = dead["visDead"]
            corpse_shown = all(visd.get(n) for n in DEAD_PARTS)
            live_hidden = all(not v for n, v in visd.items()
                              if n not in DEAD_PARTS)
            check("12001 corpse shown once dead", corpse_shown,
                  {n: visd.get(n) for n in DEAD_PARTS})
            check("12001 live parts hidden once dead", live_hidden)
            check("12001 holds at deadLift, no generic sink",
                  abs(dead["posYDead"] - 0.30) <= 0.02,
                  "posY=%+.3f" % dead["posYDead"])
            # The authored corpse: body slumped on the ground, the fallen
            # sword's tip left in the dirt (deadsword spans well below 0).
            body = dead["perMeshMinDead"].get("deadbody_obj")
            sword = dead["perMeshMinDead"].get("deadsword_obj")
            check("12001 corpse body rests on the ground",
                  body is not None and -0.15 <= body <= 0.35,
                  "deadbody minY=%s" % body)
            check("12001 fallen sword tip in the dirt",
                  sword is not None and -0.65 <= sword <= 0.1,
                  "deadsword minY=%s" % sword)

            # -- 3: unlisted model untouched -----------------------------
            ctl_alive = page.evaluate(PROBE, {"model": CONTROL, "dead": False})
            check("control model has no lift (bob only)",
                  abs(ctl_alive["posY"]) <= 0.061,
                  "posY=%+.3f" % ctl_alive["posY"])
            ctl_dead = page.evaluate(PROBE, {"model": CONTROL, "dead": True})
            check("control model still sinks on death",
                  ctl_dead["posYDead"] < -0.5,
                  "posY=%+.3f" % ctl_dead["posYDead"])

            # -- 4: cleanliness ------------------------------------------
            check("no pageerrors through the probes", not errors, errors[:3])
            check("no console warnings through the probes", not warnings,
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
        print("ALL OK — posture lifts + 12001 corpse swap (T21e-1)")
        return 0
    print(fails, "check(s) failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
