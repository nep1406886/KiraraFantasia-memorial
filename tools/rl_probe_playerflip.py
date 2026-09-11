# Probe WHY player models render upside-down in T-pose through the enemy
# pipeline (tools/rl_model_sweep.py finding) while the real player view is
# upright. Compare, for the SAME model (pl_100000):
#   1. the live player view's object tree (rotation/position per node level),
#   2. the same model spawned through spawnEnemy -> enemyview,
# plus whether loaded.animations exist on the enemy path (view.play('idle')).
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "sweep"

SPAWN = """(arg) => {
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
            if (!view && performance.now() - t0 < 20000) { return; }
            clearInterval(timer);
            if (!view) { resolve({ attached: false }); return; }
            window.__probeUnit = unit;
            resolve({ attached: true });
        }, 20);
    });
}"""

# Describe a scene-object subtree: name, rotation, position, scale, up to
# depth 3, plus the first skinned mesh's bind-pose head marker (any node
# with "head" in the name) world position.
DESCRIBE = """() => {
    function row(o, depth) {
        const r = o.rotation, p = o.position, s = o.scale;
        return {
            d: depth, name: o.name || o.type,
            rot: [+r.x.toFixed(3), +r.y.toFixed(3), +r.z.toFixed(3)],
            pos: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)],
            scl: [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)]
        };
    }
    function walk(o, depth, out) {
        out.push(row(o, depth));
        if (depth >= 3) { return; }
        o.children.forEach(function (c) { walk(c, depth + 1, out); });
    }
    const rl = window.kirafanRL;
    const out = { tree: [], heads: [], plays: {} };
    // 1. live player view
    const pv = rl.views.player;
    if (pv && pv.object) {
        pv.object.updateWorldMatrix(true, true);
        walk(pv.object, 0, out.tree);
        // where is the head bone in world space?
        let head = null;
        pv.object.traverse(function (c) {
            if (!head && /head/i.test(c.name || "")) { head = c; }
        });
        if (head) {
            const wp = new (head.position.constructor)();
            head.getWorldPosition(wp);
            out.headY_player = +wp.y.toFixed(3);
        }
    }
    // 2. enemy-pipeline root for the same model
    const unit = window.__probeUnit;
    const ev = rl.views.enemies.find(function (v) { return v.unit === unit; });
    if (ev) {
        const root = ev.object;
        root.updateWorldMatrix(true, true);
        let ehead = null;
        root.traverse(function (c) {
            if (!ehead && /head/i.test(c.name || "")) { ehead = c; }
        });
        if (ehead) {
            const wp2 = new (ehead.position.constructor)();
            ehead.getWorldPosition(wp2);
            out.headY_enemy = +wp2.y.toFixed(3);
        }
        // can idle play? (does an action exist)
        out.plays.idle = ev.play('idle', { loop: true });
        out.current = ev.current;
        // count meshes / skinned meshes
        let meshes = 0, skinned = 0;
        root.traverse(function (c) {
            if (c.isMesh) { meshes++; }
            if (c.isSkinnedMesh) { skinned++; }
        });
        out.meshes = meshes;
        out.skinned = skinned;
        // tree of the enemy root
        out.etree = [];
        walk(root, 0, out.etree);
    }
    return out;
}"""

DISPOSE = """() => {
    const rl = window.kirafanRL;
    const w = rl.world;
    const unit = window.__probeUnit;
    if (!unit) { return false; }
    const view = rl.views.enemies.find(v => v.unit === unit);
    if (view) { view.dispose(); }
    const i = w.enemies.indexOf(unit);
    if (i >= 0) { w.enemies.splice(i, 1); }
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


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8982
    import subprocess
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.0)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            boot(page, port)
            info = page.evaluate(SPAWN, {"model": "model/player/model_pl_100000.muast"})
            print("spawn:", info)
            desc = page.evaluate(DESCRIBE)
            import json
            print(json.dumps(desc, indent=1)[:6000])
            page.evaluate(DISPOSE)
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
