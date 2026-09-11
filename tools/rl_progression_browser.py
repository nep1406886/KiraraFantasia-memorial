# Browser diagnostic for the progression systems (spec/04 §9):
# pickup / level / coin / shop / rest / boss bar / menu, driven through the
# same code paths a player uses (world.enterRoom + kirafanRL.interact etc).
# Not a gate -- a repro driver. Usage: python tools/rl_progression_browser.py [port]
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8931
    # floor=20: the boss-bar check enters the boss room, and floors 1-19 hold
    # a 層守衛 (an elite, no boss bar) there — boot on the final floor.
    url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=1&floor=20" % port
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
        # pick the first roster card so the world exists
        try:
            page.wait_for_selector(".roster-card", timeout=15000)
            page.query_selector(".roster-card").click()
        except Exception as e:
            print("no roster: %s" % e)
        # let the room build
        for _ in range(60):
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(10)
        # T12 wired later than this gate: v1_open is up at boot and freezes
        # the world, so the pickup/kill sections need it dismissed first.
        for _ in range(90):
            vis = page.evaluate(
                "(() => { const b = document.getElementById('dialogue-box');"
                " return !!(b && b.style.display !== 'none'); })()")
            if not vis:
                break
            page.evaluate("document.getElementById('dialogue-box').click()")
            page.wait_for_timeout(90)

        def ev(js):
            return page.evaluate(js)

        print("=== 1. pickup ===")
        r = ev("""(() => {
            const w = window.kirafanRL.world;
            const p = w.player;
            if (!p) return {error: 'no player'};
            const pool = p.equipment.length;
            w.drops.push({x: p.x, y: p.y, items: [
                {slot: 'weapon', rarity: 'rare', affixes: ['10002001']}
            ]});
            window.kirafanRL.step(1/60);
            return {before: pool, after: p.equipment.length,
                    drops: w.drops.length,
                    atk: p.base.atk, atkBefore: null};
        })()""")
        print(str(r).encode("ascii", "replace").decode())
        ok_pickup = r.get("after") == (r.get("before", 0) + 1) and r.get("drops") == 0
        print("PICKUP " + ("OK" if ok_pickup else "FAIL"))

        print("=== 2. level + coin via real kill ===")
        r = ev("""(() => {
            const w = window.kirafanRL.world;
            const p = w.player;
            const coin0 = w.coin, lvl0 = p.level, exp0 = p.exp;
            const foe = w.spawnEnemy({x: p.x + 0.6, y: p.y, hp: 1, atk: 0,
                                      aiType: 'sentry'});
            window.kirafanRL.input.state.attack = true;
            let dead = false;
            for (let i = 0; i < 180 && !dead; i++) {
                window.kirafanRL.step(1/60);
                dead = foe.dead;
            }
            window.kirafanRL.input.state.attack = false;
            return {dead: dead, coin0: coin0, coin: w.coin,
                    lvl0: lvl0, level: p.level, exp0: exp0, exp: p.exp,
                    hp: p.hp, maxHp: p.maxHp};
        })()""")
        print(str(r).encode("ascii", "replace").decode())
        ok_kill = r.get("dead") and r.get("coin", 0) > r.get("coin0", 0) and r.get("exp", 0) > r.get("exp0", 0)
        print("KILL-REWARDS " + ("OK" if ok_kill else "FAIL"))

        print("=== 3. shop: enter, open, buy, close ===")
        r = ev("""(() => {
            const w = window.kirafanRL.world;
            const rooms = w.dungeon.rooms;
            const shop = rooms.find(r => r.type === 'shop');
            if (!shop) return {error: 'no shop room in this dungeon'};
            w.enterRoom(shop.id, 'S');
            for (let i = 0; i < 30; i++) window.kirafanRL.step(1/60);
            const offer = w.getShopOffer();
            window.kirafanRL.interact();
            const panelOpen = !document.getElementById('shop-panel')
                .classList.contains('hidden');
            const frozenWhileOpen = w.frozen;
            const cheapIdx = offer.findIndex(e => e.item);
            w.coin = 9999;
            const bought = window.kirafanRL.buyShopItem(cheapIdx);
            const coinAfter = w.coin;
            window.kirafanRL.closeShop();
            const panelClosed = document.getElementById('shop-panel')
                .classList.contains('hidden');
            return {offer: offer.length, panelOpen: panelOpen,
                    frozenWhileOpen: frozenWhileOpen,
                    bought: !!bought, price: offer[cheapIdx].price,
                    coinAfter: coinAfter, panelClosed: panelClosed,
                    frozenAfter: w.frozen,
                    equipped: w.player.equipment.length};
        })()""")
        print(str(r).encode("ascii", "replace").decode())
        ok_shop = (r.get("panelOpen") and r.get("frozenWhileOpen")
                   and r.get("bought") and r.get("panelClosed")
                   and not r.get("frozenAfter"))
        print("SHOP " + ("OK" if ok_shop else "FAIL"))

        print("=== 4. rest heal ===")
        r = ev("""(() => {
            const w = window.kirafanRL.world;
            const p = w.player;
            const rest = w.dungeon.rooms.find(r => r.type === 'rest');
            if (!rest) return {error: 'no rest room'};
            w.enterRoom(rest.id, 'S');
            for (let i = 0; i < 10; i++) window.kirafanRL.step(1/60);
            p.hp = Math.max(1, Math.round(p.maxHp * 0.2));
            const hp0 = p.hp;
            const healed = w.restHeal();
            for (let i = 0; i < 5; i++) window.kirafanRL.step(1/60);
            const again = w.restHeal();
            return {hp0: hp0, hp: p.hp, healed: healed, again: again};
        })()""")
        print(str(r).encode("ascii", "replace").decode())
        ok_rest = r.get("healed", 0) > 0 and r.get("again") == 0
        print("REST " + ("OK" if ok_rest else "FAIL"))

        print("=== 5. boss bar ===")
        r = ev("""(() => {
            const w = window.kirafanRL.world;
            const boss = w.dungeon.rooms.find(r => r.type === 'boss');
            if (!boss) return {error: 'no boss room'};
            w.enterRoom(boss.id, 'S');
            for (let i = 0; i < 30; i++) window.kirafanRL.step(1/60);
            const bar = document.getElementById('boss-bar');
            const visible = bar.style.display !== 'none';
            const name = bar.querySelector('.boss-name').textContent;
            const width = bar.querySelector('.boss-fill').style.width;
            return {visible: visible, name: name, width: width};
        })()""")
        print(str(r).encode("ascii", "replace").decode())
        ok_boss = r.get("visible") and r.get("width") in ("100%",)
        print("BOSS-BAR " + ("OK" if ok_boss else "FAIL"))

        print("=== 6. menu overlay ===")
        r = ev("""(() => {
            const w = window.kirafanRL.world;
            window.kirafanRL.toggleMenu();
            const open = !document.getElementById('menu-panel')
                .classList.contains('hidden');
            const frozen = w.frozen;
            window.kirafanRL.toggleMenu();
            const closed = document.getElementById('menu-panel')
                .classList.contains('hidden');
            return {open: open, frozen: frozen, closed: closed,
                    frozenAfter: w.frozen};
        })()""")
        print(str(r).encode("ascii", "replace").decode())
        ok_menu = (r.get("open") and r.get("frozen") and r.get("closed")
                   and not r.get("frozenAfter"))
        print("MENU " + ("OK" if ok_menu else "FAIL"))

        print("=== 7. drive 300 steps for stability ===")
        for _ in range(300):
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(5)

        print("=== pageerrors ===")
        for e in result["errors"]:
            print(e[:1500])
        print("=== console (error/warning) ===")
        for c in result["console"]:
            if c.startswith("error") or c.startswith("warning"):
                print(c[:1500])
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
