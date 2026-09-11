# Fog A/B render (T21c check): same frame rendered with the room fog and
# with fog pushed out of range, then a per-region pixel diff shows exactly
# where and how strongly the fog acts on the enlarged 24x18 rooms.
# Usage: python tools/rl_shot_fogab.py [port] [out_prefix]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8977
    prefix = sys.argv[2] if len(sys.argv) > 2 else "rl_fogab"
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.0)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto("http://127.0.0.1:%d/site/game/roguelike.html" % port,
                      wait_until="load", timeout=60000)
            deadline = time.time() + 40
            while time.time() < deadline:
                if page.evaluate("!!window.kirafanRL"):
                    break
                page.wait_for_timeout(200)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.evaluate("document.querySelector('.roster-card').click()")
            deadline = time.time() + 30
            while time.time() < deadline:
                if page.evaluate("!!window.kirafanRL.world.player"):
                    break
                page.wait_for_timeout(200)
            for _ in range(90):
                vis = page.evaluate(
                    "(() => { const b = document.getElementById('dialogue-box');"
                    " return !!(b && b.style.display !== 'none'); })()")
                if not vis:
                    break
                page.evaluate("document.getElementById('dialogue-box').click()")
                page.wait_for_timeout(90)

            # Battle room, player hugging the south wall (worst-case far wall
            # distance in a 24x18 room), camera settled via step().
            page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                const battle = w.dungeon.rooms.find(r => r.type === 'battle');
                if (battle) { w.enterRoom(battle.id, 'S'); }
                w.player.x = 12; w.player.y = 16;
                for (let i = 0; i < 60; i++) rl.step(1/60);
                rl.renderOnce();
            })()""")
            page.screenshot(path=prefix + "_fog.png")
            # Same frame, fog disabled: near beyond the far plane makes the
            # factor negative (clamped to 0) for every fragment. near/far are
            # uniforms, so no material recompile is needed.
            page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const f = rl.scene.fog;
                f.userData = { near: f.near, far: f.far };
                f.near = 1e6; f.far = 1e6 + 10;
                rl.renderOnce();
            })()""")
            page.screenshot(path=prefix + "_nofog.png")
            page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const f = rl.scene.fog;
                f.near = f.userData.near; f.far = f.userData.far;
                rl.renderOnce();
            })()""")
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    print("saved %s_fog.png / %s_nofog.png" % (prefix, prefix))
    return 0


if __name__ == "__main__":
    sys.exit(main())
