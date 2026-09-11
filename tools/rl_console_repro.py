# Minimal repro: load roguelike.html headless, dump console errors + pageerrors.
# Not a gate — a diagnostic. Usage: python tools/rl_console_repro.py [port]
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8931
    url = "http://127.0.0.1:%d/site/game/roguelike.html" % port
    result = {"console": [], "errors": []}
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("console", lambda m: result["console"].append(m.type + ": " + m.text))
        page.on("pageerror", lambda e: result["errors"].append(str(e)))
        page.on("requestfailed", lambda r: result["errors"].append(
            "REQFAIL " + r.url + " " + str(r.failure)))
        page.goto(url, wait_until="load", timeout=60000)
        deadline = time.time() + 40
        while time.time() < deadline:
            if page.evaluate("!!window.kirafanRL"):
                break
            page.wait_for_timeout(200)
        # auto-select the first roster card if the roster is up
        try:
            page.wait_for_selector("#rl-roster-card-0, .roster-card", timeout=8000)
            cards = page.query_selector_all(".roster-card, [id^='rl-roster-card']")
            if not cards:
                # fall back: first clickable child of the roster grid
                cards = page.query_selector_all("div[style*='grid'] > div")
            if cards:
                cards[0].click()
                print("clicked first roster card")
        except Exception as e:
            print("no roster to click: %s" % e)
        # drive the world like the real gate does
        for _ in range(300):
            page.evaluate("window.kirafanRL && window.kirafanRL.step(1/60)")
            page.wait_for_timeout(20)
        # fire each skill once, then the ultimate, watching for errors
        for slot in ("0", "1", "2"):
            page.evaluate(
                "window.kirafanRL.input.state.skill[%s] = true" % slot)
            for _ in range(10):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(10)
            page.evaluate(
                "window.kirafanRL.input.state.skill[%s] = false" % slot)
            for _ in range(30):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(10)
        page.evaluate("window.kirafanRL.input.state.ultimate = true")
        for _ in range(60):
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(10)
        page.evaluate("window.kirafanRL.input.state.ultimate = false")
        extra = page.evaluate(
            "window.kirafanRL.world.player && window.kirafanRL.world.player.skills"
            " ? ({bullets: window.kirafanRL.world.danmaku.active, "
            "playerHp: window.kirafanRL.world.player.hp, "
            "gauge: window.kirafanRL.world.player.skills.gauge, "
            "slots: window.kirafanRL.world.player.skills.slots "
            "? window.kirafanRL.world.player.skills.slots.length : 0}) : null")
        print("=== after skills/ultimate ===")
        print(str(extra).encode("ascii", "replace").decode())
        print("=== pageerrors ===")
        for e in result["errors"]:
            print(e[:2000])
        print("=== console (error/warning) ===")
        for c in result["console"]:
            if c.startswith("error") or c.startswith("warning"):
                print(c[:2000])
        state = page.evaluate(
            "window.kirafanRL ? {mapview: !!window.kirafanRL.mapview.group, "
            "player: !!window.kirafanRL.world.player, "
            "status: document.getElementById('status') ? "
            "document.getElementById('status').textContent : null} : null")
        print("=== state ===")
        print(str(state).encode("ascii", "replace").decode())
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
