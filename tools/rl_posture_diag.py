# One-off diagnostic: for the two posture-gate failures (14304, 11804),
# dump every mesh's name / visibility / world minY so we can see which
# mesh used to be the lowest vertex and whether modelrules hid it.
# Owns its server. Usage: python tools/rl_posture_diag.py [port]
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

MODELS = [
    "model/enemy/model_en_14304.muast",
    "model/enemy/model_en_11804.muast",
]

PROBE = """(arg) => {
    const model = arg.model;
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
            const root = view.object;
            root.updateWorldMatrix(true, true);
            const meshes = [];
            root.traverse((child) => {
                if (!child.isMesh) return;
                child.updateWorldMatrix(true, false);
                const pos = child.geometry.attributes.position;
                let minY = 1e9;
                const e = child.matrixWorld.elements;
                for (let k = 0; k < pos.count; k++) {
                    // matrixWorld row 1: world Y = e[1]x + e[5]y + e[9]z + e[13]
                    const wy = e[1] * pos.getX(k) + e[5] * pos.getY(k)
                             + e[9] * pos.getZ(k) + e[13];
                    if (wy < minY) minY = wy;
                }
                meshes.push({
                    name: child.name,
                    visible: !!child.visible,
                    minY: +minY.toFixed(4),
                });
            });
            meshes.sort((a, b) => a.minY - b.minY);
            resolve({ model: model, posY: +root.position.y.toFixed(4),
                      meshes: meshes.slice(0, 14) });
        }, 50);
    });
}"""


def dismiss_boot_dialogue(page):
    for _ in range(40):
        vis = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " return !!(b && b.style.display !== 'none'); })()")
        if not vis:
            return
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8993
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.0)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto("http://127.0.0.1:%d/site/game/roguelike.html" % port)
            page.wait_for_function("!!window.kirafanRL", timeout=30000)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.evaluate("document.querySelector('.roster-card').click()")
            deadline = time.time() + 30
            while time.time() < deadline \
                    and not page.evaluate("!!window.kirafanRL.world.player"):
                page.wait_for_timeout(200)
            dismiss_boot_dialogue(page)
            page.evaluate("(() => { const p = window.kirafanRL.world.player;"
                          " p.x = 2; p.y = 2; })()")
            for model in MODELS:
                out = page.evaluate(PROBE, {"model": model})
                print("== %s  posY=%s" % (out["model"], out["posY"]))
                for m in out["meshes"]:
                    print("   %-30s vis=%-5s minY=%+8.4f" % (
                        m["name"], m["visible"], m["minY"]))
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
