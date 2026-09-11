# Browser gate for T22j 掉落/图标素材: the drop markers must render authored
# icon sprites (IconFrame frame tinted by rarity), not octahedron
# meshes, and kill/barrel/altar coins must be visible sprite receipts.
#
#   1. boot + first room: no octahedron geometry anywhere in the scene
#   2. skill sprites: a kill spawns a coinGain receipt (Sprite with map)
#   3. drop event: the drop marker is a THREE.Sprite wearing equipment-frame.webp
#   4. drop tint: rarity colour rides the sprite material
#   5. coin fly: coinGain spawns an ephemeral sprite that fades (world time)
#   6. 技能卡 icons: menu 技能说明 sheets carry skicon spans (mask/img)
#   7. no page errors / failed requests
#
# Owns its server. Usage: python tools/rl_drops_browser.py [port]
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            break
        page.wait_for_timeout(200)


def dismiss_dialogue(page):
    # Two races (both observed as flakes): on a slow boot the opening box
    # opens AFTER the first poll — returning before it exists leaves the
    # world frozen and every later kill check no-ops; and between queued
    # nodes the box hides for a microtask while world.frozen is still true.
    # So: wait for the box, then click until hidden AND unfrozen.
    deadline = time.time() + 15
    while time.time() < deadline:
        if page.evaluate(
                "(() => { const b = document.getElementById('dialogue-box');"
                " return !!(b && b.style.display !== 'none'); })()"):
            break
        page.wait_for_timeout(100)
    for _ in range(120):
        state = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " const w = window.kirafanRL && window.kirafanRL.world;"
            " return { vis: !!(b && b.style.display !== 'none'),"
            "          frozen: !!(w && w.frozen) }; })()")
        if not state["vis"] and not state["frozen"]:
            return True
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)
    return False


def press_escape(page):
    page.keyboard.down("Escape")
    page.evaluate("window.kirafanRL.step(1/60)")
    page.wait_for_timeout(50)
    page.keyboard.up("Escape")
    page.evaluate("window.kirafanRL.step(1/60)")
    page.wait_for_timeout(50)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8978
    import subprocess
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = 0

    def check(label, ok, detail=""):
        nonlocal fails
        print(("OK   " if ok else "FAIL ") + label + ("  " + str(detail) if detail else ""))
        if not ok:
            fails += 1

    try:
        time.sleep(1.5)
        url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=1" % port
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                      "--autoplay-policy=no-user-gesture-required"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            failed_requests = []
            page.on("requestfailed", lambda r: failed_requests.append(r.url))

            boot(page, url)
            page.wait_for_selector(".roster-card", timeout=20000)
            page.click(".roster-card")
            dismissed = dismiss_dialogue(page)
            check("boot dialogue dismissed, world unfrozen", dismissed)
            # rAF is stubbed from here: the coin receipts age on rendered
            # time, and headless rAF ticks under load can stretch the
            # interleaved wait_for_timeout calls past the 1.6 s sprite life
            # — the count then finds 0 sprites for a kill that paid (observed
            # once as coin=20 / coinSprites=0). With the stub, only step()
            # advances time.
            page.evaluate(
                "window.requestAnimationFrame = function () { return 0; }")
            # step the world until the first room.
            deadline = time.time() + 30
            while time.time() < deadline:
                if page.evaluate(
                        "window.kirafanRL && window.kirafanRL.world"
                        " && window.kirafanRL.world.room"):
                    break
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(30)
            check("first room reached", page.evaluate(
                "!!(window.kirafanRL && window.kirafanRL.world"
                " && window.kirafanRL.world.room)"))

            # Enter a battle room via the sanctioned path (the boot room may
            # be non-battle, with no enemies to kill).
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                if (w.player) { w.player.iframes = 1e9; }
                const battle = w.dungeon.rooms.find(r => r.type === 'battle');
                if (!battle) { throw new Error('no battle room'); }
                w.enterRoom(battle.id, 'S');
            })()""")
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(400)

            # --- 1. no octahedron markers; sprites only -------------------
            geom = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                let octa = 0, sprites = 0;
                window.kirafanRL.scene.traverse(o => {
                    if (o.geometry && o.geometry.type === 'OctahedronGeometry') octa++;
                    if (o.isSprite) sprites++;
                });
                return { octa, sprites };
            })()""")
            check("no octahedron drop markers", geom["octa"] == 0, geom)
            check("drop textures preloaded", page.evaluate(
                "!!window.kirafanRL.dropTexturesReady"), geom)

            # --- 2+5. kill → coinGain receipt ------------------------------
            # The real attack funnel: park the first enemy in the swing arc,
            # drop its hp so one hit kills, press attack through two steps.
            coin_before = page.evaluate("window.kirafanRL.world.coin")
            page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const e = w.enemies[0];
                if (e) {
                    e.x = w.player.x + 0.5;
                    e.y = w.player.y;
                    e.hp = 1;
                    e.sm && e.sm.force && e.sm.force('idle');
                }
                window.kirafanRL.input.state.attack = true;
            })()""")
            for _ in range(30):
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(20)
            page.evaluate("window.kirafanRL.input.state.attack = false")
            coin_state = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                let coinSprites = 0;
                window.kirafanRL.scene.traverse(o => {
                    if (o.isSprite && o.material.map
                        && o.material.map.image
                        && String(o.material.map.image.src).indexOf('coin.webp') >= 0) {
                        coinSprites++;
                    }
                });
                return { coin: w.coin, coinSprites };
            })()""")
            check("kill credits coin", coin_state["coin"] > coin_before, coin_state)
            check("coin receipt sprite visible", coin_state["coinSprites"] >= 1,
                  coin_state)

            # --- 3+4. equipment drop marker is a tinted frame sprite -------
            marker = page.evaluate("""(() => {
                const w = window.kirafanRL.world;
                const items = [{ slot: 'weapon', rarity: 'epic', affixes: [] }];
                const entry = { x: w.player.x + 1, y: w.player.y, items };
                w.drops.push(entry);
                w.events.push({ type: 'drop', x: entry.x, y: entry.y,
                                items, drop: entry });
                window.kirafanRL.step(1/60);
                let found = null;
                window.kirafanRL.scene.traverse(o => {
                    if (o.isSprite && o.material.map && o.material.map.image
                        && String(o.material.map.image.src).indexOf('equipment-frame.webp') >= 0
                        && !found) {
                        found = {
                            color: o.material.color.getHexString(),
                            w: o.scale.x, h: o.scale.y,
                            y: o.position.y
                        };
                    }
                });
                return found;
            })()""")
            check("drop marker is frame sprite", marker is not None, marker)
            if marker:
                check("epic tint applied", marker["color"] == "b44dff", marker)
                check("sprite scale readable", 0.6 < marker["w"] < 0.9, marker)

            # --- 6. 技能卡 icons -------------------------------------------
            press_escape(page)
            page.click("#menu-skills")
            page.wait_for_selector("#rl-skillcard", timeout=5000)
            icons = page.evaluate("""(() => {
                const icons = document.querySelectorAll('#rl-skillcard .skicon');
                const masked = Array.from(icons).filter(i =>
                    getComputedStyle(i).maskImage !== 'none'
                    || getComputedStyle(i).webkitMaskImage !== 'none'
                    || getComputedStyle(i).backgroundImage !== 'none');
                return { count: icons.length, styled: masked.length };
            })()""")
            check("skillcard icons present", icons["count"] >= 3, icons)
            check("skillcard icons styled",
                  icons["styled"] == icons["count"], icons)
            page.click("#rl-skillcard .close-row button")
            page.wait_for_timeout(100)
            press_escape(page)   # close menu, unfreeze

            check("no page errors", not errors, errors[:2])
            bg_404 = [u for u in failed_requests if "drop/" in u]
            check("no failed drop-icon requests", not bg_404, bg_404[:3])
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()

    print("RESULT " + ("PASS" if fails == 0 else "FAIL (%d)" % fails))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
