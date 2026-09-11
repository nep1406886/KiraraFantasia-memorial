# Screenshot driver for the roguelike (T21c visual checks). Boots the page,
# picks a character, walks into a battle room, drives the world through
# step()+renderOnce() (rAF never ticks in a hidden pane) and saves PNGs.
# Usage: python tools/rl_screenshot.py [port] [out_prefix]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8977
    prefix = sys.argv[2] if len(sys.argv) > 2 else "rl_shot"
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
            page.evaluate(
                "document.querySelector('.roster-card').click()")
            deadline = time.time() + 30
            while time.time() < deadline:
                if page.evaluate("!!window.kirafanRL.world.player"):
                    break
                page.wait_for_timeout(200)
            # dismiss the opening dialogue (freezes the world)
            for _ in range(90):
                vis = page.evaluate(
                    "(() => { const b = document.getElementById('dialogue-box');"
                    " return !!(b && b.style.display !== 'none'); })()")
                if not vis:
                    break
                page.evaluate("document.getElementById('dialogue-box').click()")
                page.wait_for_timeout(90)

            # battle room, mid-fight: player walking, enemies up, bullets out
            page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                const battle = w.dungeon.rooms.find(r => r.type === 'battle');
                if (battle) { w.enterRoom(battle.id, 'S'); }
                for (let i = 0; i < 30; i++) rl.step(1/60);
                rl.renderOnce();
            })()""")
            page.screenshot(path=prefix + "_battle.png")
            # the same room from a corner, to see walls/fog at the far side
            page.evaluate("""(() => {
                const rl = window.kirafanRL;
                const w = rl.world;
                w.player.x = 3; w.player.y = 3;
                for (let i = 0; i < 30; i++) rl.step(1/60);
                rl.renderOnce();
            })()""")
            page.screenshot(path=prefix + "_corner.png")
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
    print("saved %s_battle.png / %s_corner.png" % (prefix, prefix))
    return 0


if __name__ == "__main__":
    sys.exit(main())
