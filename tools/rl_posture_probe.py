# Ground-contact probe for the two live-reported defect classes:
#   (a) feet occluded by terrain / floating  (b) head pieces missing or wrong
# For every player (real pipeline, idle) and enemy (spawnEnemy path) record:
#   minY/minYover  — lowest world-Y of visible mesh vertices now / over 2.6s
#   rootY          — object root position.y start vs end (does the mixer own it?)
#   animated       — whether a mixer is driving clips
# Plus, for models named in DUMP, a per-mesh dump (name/visible/side/alphaTest/
# world bbox) so the missing-foot and wrong-face nodes can be identified.
# Owns its server. Usage: python tools/rl_posture_probe.py [port]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "posture.json"
DUMP = ("pl_280001", "pl_100000", "pl_460001")

# Player probe: park, then sample the actor bbox floor over ~2.6s of idle.
PLAYER_PROBE = """(dumpName) => {
    return new Promise((resolve) => {
        const rl = window.kirafanRL;
        rl.world.frozen = true;
        rl.views.enemies.forEach(v => { if (v.object) v.object.visible = false; });
        const pv = rl.views.player;
        if (!pv || !pv.actor || !pv.actor.object) { resolve({error:'no-view'}); return; }
        const root = pv.actor.object;
        const label = 'pl_' + (window.__probeRid || '0');
        function bbox() {
            root.updateWorldMatrix(true, true);
            let minY = 1e9, maxY = -1e9, legMin = 1e9;
            root.traverse(function (child) {
                if (!child.isMesh || !child.geometry || !child.visible) return;
                const p = child.geometry.attributes.position;
                if (!p) return;
                const e = child.matrixWorld.elements;
                const isLeg = /^leg_[LR]_/i.test(child.name || "");
                for (let i = 0; i < p.count; i++) {
                    const vy = e[1]*p.getX(i) + e[5]*p.getY(i) + e[9]*p.getZ(i) + e[13];
                    if (vy < minY) minY = vy;
                    if (vy > maxY) maxY = vy;
                    if (isLeg && vy < legMin) legMin = vy;
                }
            });
            return minY > maxY ? null : { minY: minY, maxY: maxY, legMin: legMin };
        }
        function dump() {
            const meshes = [];
            root.traverse(function (child) {
                if (!child.isMesh || !child.geometry) return;
                child.updateWorldMatrix(true, false);
                const p = child.geometry.attributes.position;
                let y0 = null, y1 = null;
                if (p) {
                    const e = child.matrixWorld.elements;
                    y0 = 1e9; y1 = -1e9;
                    for (let i = 0; i < p.count; i++) {
                        const vy = e[1]*p.getX(i) + e[5]*p.getY(i) + e[9]*p.getZ(i) + e[13];
                        if (vy < y0) y0 = vy;
                        if (vy > y1) y1 = vy;
                    }
                }
                meshes.push({
                    name: child.name,
                    vis: child.visible,
                    side: child.material && child.material.side,
                    at: child.material ? child.material.alphaTest : null,
                    y: y0 === null ? null : [+y0.toFixed(3), +y1.toFixed(3)]
                });
            });
            return meshes;
        }
        const t0 = performance.now();
        let over = 1e9, legOver = 1e9, rootStart = root.position.y, rootEnd = rootStart;
        const timer = setInterval(() => {
            for (let i = 0; i < 4; i++) rl.step(1 / 60);
            const b = bbox();
            if (b && b.minY < over) over = b.minY;
            if (b && b.legMin < legOver) legOver = b.legMin;
            rootEnd = root.position.y;
            if (performance.now() - t0 < 2600) return;
            clearInterval(timer);
            const rec = {
                minY: bbox() ? +bbox().minY.toFixed(3) : null,
                minYover: +over.toFixed(3),
                legMinY: b ? +b.legMin.toFixed(3) : null,
                legMinYover: +legOver.toFixed(3),
                maxY: b ? +b.maxY.toFixed(3) : null,
                rootStart: +rootStart.toFixed(3),
                rootEnd: +rootEnd.toFixed(3),
                animated: !!(pv.actor && pv.actor.mixer)
            };
            if (dumpName && label === dumpName) { rec.meshes = dump(); }
            resolve(rec);
        }, 20);
    });
}"""

# Enemy probe: spawn at (12,9), sample floor over 2.6s (bob period 1.2s).
ENEMY_PROBE = """(arg) => {
    return new Promise((resolve) => {
        const rl = window.kirafanRL;
        const w = rl.world;
        w.frozen = true;
        let unit;
        try {
            unit = w.spawnEnemy({
                model: arg.model, name: 'probe', nameZh: 'probe',
                x: 12, y: 9, hp: 999999, aiType: 'sentry'
            });
        } catch (e) { resolve({ error: String(e) }); return; }
        w.events.push({ type: 'summon' });
        const t0 = performance.now();
        const timer = setInterval(() => {
            rl.step(1 / 60);
            const view = rl.views.enemies.find(v => v.unit === unit);
            if (!view && performance.now() - t0 < 20000) return;
            clearInterval(timer);
            if (!view) { resolve({ attached: false }); return; }
            window.__probeUnit = unit;
            const root = view.object;
            function bbox() {
                root.updateWorldMatrix(true, true);
                let minY = 1e9, maxY = -1e9;
                root.traverse(function (child) {
                    if (!child.isMesh || !child.geometry || !child.visible) return;
                    const p = child.geometry.attributes.position;
                    if (!p) return;
                    const e = child.matrixWorld.elements;
                    for (let i = 0; i < p.count; i++) {
                        const vy = e[1]*p.getX(i) + e[5]*p.getY(i) + e[9]*p.getZ(i) + e[13];
                        if (vy < minY) minY = vy;
                        if (vy > maxY) maxY = vy;
                    }
                });
                return minY > maxY ? null : { minY: minY, maxY: maxY };
            }
            const t1 = performance.now();
            let over = 1e9;
            const rootStart = root.position.y;
            const t2 = setInterval(() => {
                for (let i = 0; i < 4; i++) rl.step(1 / 60);
                const b = bbox();
                if (b && b.minY < over) over = b.minY;
                if (performance.now() - t1 < 2600) return;
                clearInterval(t2);
                resolve({
                    minY: bbox() ? +bbox().minY.toFixed(3) : null,
                    minYover: +over.toFixed(3),
                    rootStart: +rootStart.toFixed(3),
                    rootEnd: +root.position.y.toFixed(3),
                    animated: !!view.mixer
                });
            }, 20);
        }, 20);
    });
}"""

DISPOSE_ONE = """() => {
    const rl = window.kirafanRL;
    const w = rl.world;
    const unit = window.__probeUnit;
    if (!unit) return false;
    const view = rl.views.enemies.find(v => v.unit === unit);
    if (view) view.dispose();
    const i = w.enemies.indexOf(unit);
    if (i >= 0) w.enemies.splice(i, 1);
    window.__probeUnit = null;
    return true;
}"""


def boot(page, port):
    page.goto("http://127.0.0.1:%d/site/game/roguelike.html" % port,
              wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline and not page.evaluate("!!window.kirafanRL"):
        page.wait_for_timeout(200)
    page.wait_for_selector(".roster-card", timeout=20000)
    page.evaluate("document.querySelector('.roster-card').click()")
    deadline = time.time() + 30
    while time.time() < deadline and not page.evaluate(
            "!!window.kirafanRL.world.player"):
        page.wait_for_timeout(200)
    for _ in range(90):
        if not page.evaluate(
                "(() => { const b = document.getElementById('dialogue-box');"
                " return !!(b && b.style.display !== 'none'); })()"):
            break
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)


def save(records):
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=1)


def main() -> int:
    port = 8985
    for a in sys.argv[1:]:
        if a.isdigit():
            port = int(a)
    players = json.load(open(ROOT / ".cache/sweep_players.json"))
    enemies = json.load(open(ROOT / ".cache/sweep_fleet.json"))
    records = {}

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
            # --- players: one boot per character, real pipeline ---
            rid2ids = {}
            for row in json.load(open(
                    ROOT / "site/asset/rl/cards-rl.json",
                    encoding="utf-8"))["cards"]:
                rid2ids.setdefault(str(row.get("resourceId")), []).append(
                    str(row.get("id")))
            for rid in players["rids"]:
                label = "pl_%d" % rid
                page.goto("about:blank")
                try:
                    page.goto(
                        "http://127.0.0.1:%d/site/game/roguelike.html" % port,
                        wait_until="domcontentloaded", timeout=60000)
                    page.wait_for_selector(".roster-card", timeout=30000)
                    cards = page.evaluate(
                        "(() => Array.from(document.querySelectorAll"
                        "('.roster-card')).map((el, i) => {"
                        " const img = el.querySelector('img.art');"
                        " const m = img && img.src ?"
                        " img.src.match(/(\\d+)\\.webp/) : null;"
                        " return { i: i, id: m ? m[1] : null }; }))()")
                except Exception as exc:
                    records[label] = {"error": str(exc)[:150]}
                    continue
                want = rid2ids.get(str(rid)) or [str(rid * 100)]
                pick = next((c for c in cards if c["id"] in want), None)
                if pick is None:
                    records[label] = {"error": "NO-CARD"}
                    continue
                page.evaluate("document.querySelectorAll"
                              "('.roster-card')[%d].click()" % pick["i"])
                deadline = time.time() + 60
                while time.time() < deadline:
                    ok = page.evaluate(
                        "(() => { const rl = window.kirafanRL; return !!(rl"
                        " && rl.world && rl.world.player && rl.views.player"
                        " && rl.views.player.actor"
                        " && rl.views.player.actor.object); })()")
                    if ok:
                        break
                    page.wait_for_timeout(250)
                else:
                    records[label] = {"error": "NO-VIEW"}
                    continue
                for _ in range(90):
                    if not page.evaluate(
                            "(() => { const b = document.getElementById"
                            "('dialogue-box'); return !!(b &&"
                            " b.style.display !== 'none'); })()"):
                        break
                    page.evaluate(
                        "document.getElementById('dialogue-box').click()")
                    page.wait_for_timeout(90)
                page.evaluate("window.__probeRid = %d" % rid)
                rec = page.evaluate(PLAYER_PROBE,
                                    label if label in DUMP else "")
                records[label] = rec
                save(records)
                print("%-14s %s" % (label, json.dumps(rec)[:140]))
            # --- enemies: spawn path ---
            try:
                boot(page, port)
            except Exception as exc:
                print("enemy boot failed: %s" % exc)
            for d in enemies["enemies"]:
                label = "en_%s" % d
                try:
                    info = page.evaluate(ENEMY_PROBE,
                                         {"model": "model/enemy/%s.muast" % d})
                except Exception as exc:
                    info = {"error": str(exc)[:150]}
                page.evaluate(DISPOSE_ONE)
                records[label] = info
                save(records)
                print("%-14s %s" % (label, json.dumps(info)[:140]))
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

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=1)
    bad = [k for k, v in records.items() if v.get("error") or not v]
    print("done: %d records, %d bad -> %s" % (len(records), len(bad), OUT))
    return 0


if __name__ == "__main__":
    sys.exit(main())