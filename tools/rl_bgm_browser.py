# Browser check for the per-volume BGM registry (游玩说明 §七). Owns its own
# server (memory: a gate must own its server). Verifies that the *resolved*
# track differs between ?volume=1 and ?volume=5 for explore and battle, and
# that a global-only scene (menu/shop) resolves the same in both.
# Usage: python tools/rl_bgm_browser.py [port]
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def drive_volume(p, port, volume, expect_explore, expect_battle):
    browser = p.chromium.launch(
        args=["--use-gl=angle", "--enable-unsafe-swiftshader",
              "--autoplay-policy=no-user-gesture-required"])
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=%d" % (port, volume)
    page.goto(url, wait_until="load", timeout=60000)

    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            break
        page.wait_for_timeout(200)
    try:
        page.wait_for_selector(".roster-card", timeout=15000)
        page.query_selector(".roster-card").click()
    except Exception as e:
        print("volume %d: no roster: %s" % (volume, e))

    def current_track():
        return page.evaluate(
            "import('/site/game/rl/bgm.js').then(m => m.getBGM() "
            "? m.getBGM().getCurrentTrack() : null)")

    # Menu BGM fires in setup (global cue, same in every volume).
    menu_track = None
    deadline = time.time() + 15
    while time.time() < deadline:
        menu_track = current_track()
        if menu_track == "bgm_town_1":
            break
        page.wait_for_timeout(300)

    # Wait for the dungeon to load, then the explore cue to take over.
    explore_track = None
    deadline = time.time() + 30
    while time.time() < deadline:
        ready = page.evaluate(
            "!!(window.kirafanRL.world && window.kirafanRL.world.dungeon)")
        if ready:
            t = current_track()
            if t == expect_explore:
                explore_track = t
                break
        page.wait_for_timeout(300)

    # Enter a battle room: the battle cue must be volume-qualified too.
    battle_track = None
    if explore_track:
        page.evaluate("""(() => {
            const w = window.kirafanRL.world;
            const battle = w.dungeon.rooms.find(r => r.type === 'battle');
            if (battle) { w.enterRoom(battle.id, 'S'); }
        })()""")
        deadline = time.time() + 15
        while time.time() < deadline:
            t = current_track()
            if t == expect_battle:
                battle_track = t
                break
            page.wait_for_timeout(300)

    browser.close()
    return {"menu": menu_track, "explore": explore_track,
            "battle": battle_track, "errors": errors}


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8961
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.5)
        with sync_playwright() as p:
            print("=== volume 1 ===")
            v1 = drive_volume(p, port, 1,
                              "bgm_questselect", "bgm_battle_1")
            print({k: v for k, v in v1.items() if k != "errors"})
            print("=== volume 5 ===")
            v5 = drive_volume(p, port, 5,
                              "bgm_adv_13", "bgm_battle_12")
            print({k: v for k, v in v5.items() if k != "errors"})
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    ok = (v1["menu"] == "bgm_town_1" and v1["explore"] == "bgm_questselect"
          and v1["battle"] == "bgm_battle_1"
          and v5["menu"] == "bgm_town_1" and v5["explore"] == "bgm_adv_13"
          and v5["battle"] == "bgm_battle_12"
          and not v1["errors"] and not v5["errors"])
    print("MENU-GLOBAL " + ("OK" if v1["menu"] == v5["menu"] == "bgm_town_1"
                            else "FAIL"))
    print("EXPLORE-PER-VOLUME " + ("OK" if v1["explore"] != v5["explore"]
                                   and v5["explore"] == "bgm_adv_13" else "FAIL"))
    print("BATTLE-PER-VOLUME " + ("OK" if v1["battle"] != v5["battle"]
                                  and v5["battle"] == "bgm_battle_12" else "FAIL"))
    print("PAGEERRORS " + ("OK" if not v1["errors"] and not v5["errors"]
                           else "FAIL " + str((v1["errors"] + v5["errors"])[:3])))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
