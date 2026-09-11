# T21e posture audit: measure every enemy model the encounters actually ship,
# in the real rendering context (roguelike.html, CHARACTER_SCALE applied,
# blob shadow, billboard mirror), and flag the per-case defects the T21 plan
# called 姿态修整:
#   floating / sunk   feet clearly off the ground plane (bob is only ±0.06)
#   tilted            root pitch/roll on a paper stack (the mirror is the only
#                     legal facing channel)
#   size outlier      height outside the player's own 1.4–2.2 band the map is
#                     authored for (view/layers.js CHARACTER_SCALE note)
#   flat              depth comparable to width — a stack lying on its back
# Owns its server. Usage: python tools/rl_enemy_audit.py [port]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

# In-page: spawn one unit, wait for its view, measure the root's world-space
# bounding box mesh by mesh (no THREE handle is exposed), dispose, splice.
AUDIT_ONE = """(model) => {
    return new Promise((resolve) => {
        const rl = window.kirafanRL;
        const w = rl.world;
        w.frozen = true;                       // nothing acts; views still sync
        const unit = w.spawnEnemy({
            model: model, name: 'audit', nameZh: 'audit',
            x: 12, y: 9, hp: 999999, aiType: 'sentry'
        });
        window.__auditUnit = unit;
        w.events.push({ type: 'summon' });     // consumeEvents -> ensureEnemyViews
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
                let minX = 1e9, minY = 1e9, minZ = 1e9;
                let maxX = -1e9, maxY = -1e9, maxZ = -1e9;
                let meshes = 0, untextured = 0;
                root.traverse(function (child) {
                    if (!child.isMesh || !child.geometry || !child.visible) { return; }
                    meshes += 1;
                    if (!child.material || !(Array.isArray(child.material)
                            ? child.material[0] : child.material).map) {
                        untextured += 1;
                    }
                    const pos = child.geometry.attributes.position;
                    if (!pos) { return; }
                    const e = child.matrixWorld.elements;
                    for (let i = 0; i < pos.count; i++) {
                        const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
                        const wx = e[0]*vx + e[4]*vy + e[8]*vz + e[12];
                        const wy = e[1]*vx + e[5]*vy + e[9]*vz + e[13];
                        const wz = e[2]*vx + e[6]*vy + e[10]*vz + e[14];
                        if (wx < minX) { minX = wx; } if (wx > maxX) { maxX = wx; }
                        if (wy < minY) { minY = wy; } if (wy > maxY) { maxY = wy; }
                        if (wz < minZ) { minZ = wz; } if (wz > maxZ) { maxZ = wz; }
                    }
                });
                out.meshes = meshes;
                out.untextured = untextured;
                out.minY = minY; out.maxY = maxY;
                out.height = maxY - minY;
                out.width = maxX - minX;
                out.depth = maxZ - minZ;
                out.bobY = root.position.y;    // static-model float offset
                out.rotX = root.rotation.x;
                out.rotY = root.rotation.y;
                out.rotZ = root.rotation.z;
                out.scaleX = root.scale.x;
                out.scaleY = root.scale.y;
                view.dispose();
            }
            const i = w.enemies.indexOf(unit);
            if (i >= 0) { w.enemies.splice(i, 1); }
            window.__auditUnit = null;
            resolve(out);
        }, 20);
    });
}"""


# Deep pass: per-mesh bboxes + y-percentiles, to tell an origin error (bulk of
# the model below ground) from legitimate geometry (a wing tip or hanging tail
# dipping below an otherwise correct origin).
DEEP_ONE = """(model) => {
    return new Promise((resolve) => {
        const rl = window.kirafanRL;
        const w = rl.world;
        w.frozen = true;
        const unit = w.spawnEnemy({
            model: model, name: 'audit', nameZh: 'audit',
            x: 12, y: 9, hp: 999999, aiType: 'sentry'
        });
        w.events.push({ type: 'summon' });
        const t0 = performance.now();
        const timer = setInterval(() => {
            rl.step(1 / 60);
            const view = rl.views.enemies.find(v => v.unit === unit);
            if (!view && performance.now() - t0 < 20000) { return; }
            clearInterval(timer);
            let out = { model: model, attached: !!view, meshes: [] };
            if (view) {
                const root = view.object;
                root.updateWorldMatrix(true, true);
                const ys = [];
                root.traverse(function (child) {
                    if (!child.isMesh || !child.geometry) { return; }
                    const pos = child.geometry.attributes.position;
                    if (!pos) { return; }
                    const e = child.matrixWorld.elements;
                    let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9;
                    for (let i = 0; i < pos.count; i++) {
                        const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
                        const wx = e[0]*vx + e[4]*vy + e[8]*vz + e[12];
                        const wy = e[1]*vx + e[5]*vy + e[9]*vz + e[13];
                        const wz = e[2]*vx + e[6]*vy + e[10]*vz + e[14];
                        ys.push(wy);
                        if (wy < minY) { minY = wy; } if (wy > maxY) { maxY = wy; }
                        if (wx < minX) { minX = wx; } if (wx > maxX) { maxX = wx; }
                    }
                    if (pos.count) {
                        out.meshes.push({
                            name: child.name || '(mesh)',
                            n: pos.count,
                            minY: +minY.toFixed(2), maxY: +maxY.toFixed(2),
                            minX: +minX.toFixed(2), maxX: +maxX.toFixed(2)
                        });
                    }
                });
                ys.sort(function (a, b) { return a - b; });
                const pct = function (p) {
                    return ys.length ? +ys[Math.min(ys.length - 1,
                        Math.floor(p * ys.length))].toFixed(2) : null;
                };
                out.p5 = pct(0.05); out.p25 = pct(0.25);
                out.p50 = pct(0.50); out.p75 = pct(0.75); out.p95 = pct(0.95);
                out.below0 = ys.length
                    ? +(ys.filter(function (y) { return y < 0; }).length
                        / ys.length).toFixed(3) : null;
                view.dispose();
            }
            const i = w.enemies.indexOf(unit);
            if (i >= 0) { w.enemies.splice(i, 1); }
            resolve(out);
        }, 20);
    });
}"""


def deep(models, port):
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.0)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.on("pageerror", lambda e: print("PAGEERROR:", e))
            page.goto("http://127.0.0.1:%d/site/game/roguelike.html" % port,
                      wait_until="load", timeout=60000)
            deadline = time.time() + 40
            while time.time() < deadline and not page.evaluate("!!window.kirafanRL"):
                page.wait_for_timeout(200)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.evaluate("document.querySelector('.roster-card').click()")
            deadline = time.time() + 30
            while time.time() < deadline and not page.evaluate("!!window.kirafanRL.world.player"):
                page.wait_for_timeout(200)
            for _ in range(90):
                if not page.evaluate(
                        "(() => { const b = document.getElementById('dialogue-box');"
                        " return !!(b && b.style.display !== 'none'); })()"):
                    break
                page.evaluate("document.getElementById('dialogue-box').click()")
                page.wait_for_timeout(90)
            page.evaluate("(() => { const p = window.kirafanRL.world.player;"
                          " p.x = 2; p.y = 2; })()")
            for model in models:
                out = page.evaluate(DEEP_ONE, model)
                print("\n%s  below0=%s  p5=%s p25=%s p50=%s p75=%s p95=%s" % (
                    model.split("/")[-1], out.get("below0"), out.get("p5"),
                    out.get("p25"), out.get("p50"), out.get("p75"),
                    out.get("p95")))
                for m in sorted(out["meshes"], key=lambda m: m["minY"])[:8]:
                    print("    %-28s n=%-5d y[%+.2f, %+.2f] x[%+.2f, %+.2f]" % (
                        m["name"][:28], m["n"], m["minY"], m["maxY"],
                        m["minX"], m["maxX"]))
                if len(out["meshes"]) > 8:
                    print("    ... %d more meshes" % (len(out["meshes"]) - 8))
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    return 0


def main() -> int:
    if len(sys.argv) > 2 and sys.argv[1] == "--deep":
        return deep(sys.argv[2].split(","), int(sys.argv[3]) if len(sys.argv) > 3 else 8980)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8980
    enc = json.load(open(ROOT / "site/asset/rl/encounters.json", encoding="utf-8"))

    # unique (model, role, vol, shadowScale) across every volume's rows
    seen = {}
    for vol in enc["volumes"]:
        for role, rows in (("mob", vol["mobs"]), ("elite", vol["elites"]),
                           ("boss", [vol["boss"]])):
            for row in rows:
                key = row["model"]
                if key not in seen:
                    seen[key] = {"model": key, "role": role, "vol": vol["vol"],
                                 "shadowScale": row.get("shadowScale"),
                                 "aiType": row.get("aiType"),
                                 "id": row["id"]}
    rows = sorted(seen.values(), key=lambda r: (r["role"], r["model"]))
    print("auditing %d unique enemy models" % len(rows))

    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    results = []
    try:
        time.sleep(1.0)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.on("pageerror", lambda e: print("PAGEERROR:", e))
            page.goto("http://127.0.0.1:%d/site/game/roguelike.html" % port,
                      wait_until="load", timeout=60000)
            deadline = time.time() + 40
            while time.time() < deadline and not page.evaluate("!!window.kirafanRL"):
                page.wait_for_timeout(200)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.evaluate("document.querySelector('.roster-card').click()")
            deadline = time.time() + 30
            while time.time() < deadline and not page.evaluate("!!window.kirafanRL.world.player"):
                page.wait_for_timeout(200)
            for _ in range(90):
                if not page.evaluate(
                        "(() => { const b = document.getElementById('dialogue-box');"
                        " return !!(b && b.style.display !== 'none'); })()"):
                    break
                page.evaluate("document.getElementById('dialogue-box').click()")
                page.wait_for_timeout(90)
            # park the player away from the audit spot
            page.evaluate("(() => { const p = window.kirafanRL.world.player;"
                          " p.x = 2; p.y = 2; })()")

            for row in rows:
                res = page.evaluate(AUDIT_ONE, row["model"])
                res.update({k: row[k] for k in
                            ("role", "vol", "shadowScale", "aiType", "id")})
                results.append(res)
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    # flags
    for r in results:
        flags = []
        if not r.get("attached"):
            flags.append("NO-VIEW")
        else:
            # Feet read straight against the ground plane (y = 0); the ±0.06
            # idle bob and any POSTURE lift are both real height, so the
            # flag thresholds absorb the bob and the lift is part of the
            # answer being audited. Hidden meshes (POSTURE deadParts) are
            # skipped by the probe itself.
            feet = r["minY"]
            r["feet"] = round(feet, 3)
            if feet > 0.18:
                flags.append("float")
            if feet < -0.18:
                flags.append("sunk")
            if abs(r["rotX"]) > 0.05 or abs(r["rotZ"]) > 0.05:
                flags.append("tilt")
            if r["height"] < 0.9 or r["height"] > 4.6:
                flags.append("size")
            if r["depth"] > 0.7 and r["depth"] > 0.55 * r["width"]:
                flags.append("flat")
            if r.get("untextured"):
                flags.append("untextured:%d" % r["untextured"])
        r["flags"] = flags

    print("\n%-38s %-6s %3s %5s %6s %6s %6s %6s %6s %6s %6s  %s" % (
        "model", "role", "vol", "shdw", "feet", "minY", "height", "width",
        "depth", "rotX", "rotZ", "flags"))
    for r in results:
        if not r.get("attached"):
            print("%-38s %-6s %3d %5s %6s %6s %6s %6s %6s %6s %6s  %s" % (
                r["model"].split("/")[-1], r["role"], r["vol"],
                r["shadowScale"], "-", "-", "-", "-", "-", "-", "-",
                ",".join(r["flags"])))
            continue
        print("%-38s %-6s %3d %5.2f %+6.2f %+6.2f %6.2f %6.2f %6.2f %+6.2f %+6.2f  %s" % (
            r["model"].split("/")[-1], r["role"], r["vol"], r["shadowScale"],
            r["feet"], r["minY"], r["height"], r["width"], r["depth"],
            r["rotX"], r["rotZ"], ",".join(r["flags"])))

    flagged = [r for r in results if r["flags"]]
    print("\n%d of %d models flagged" % (len(flagged), len(results)))
    with open(ROOT / ".cache" / "rl_enemy_audit.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    print("full table: .cache/rl_enemy_audit.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
