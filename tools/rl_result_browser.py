"""T23: real combat -> terminal save barrier -> dialogue -> result -> new run.

Run --probe against the old implementation to prove the save resurrection.
Owns a port-0 server and an isolated browser context; screenshots stay local.
"""
import argparse
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / ".codex-tmp" / "t23-results"
WIDTHS = (375, 390, 412, 430, 768, 1280)


def check(label, condition, detail=None):
    if not condition:
        raise AssertionError(label + (": " + str(detail) if detail is not None else ""))
    print("PASS " + label, flush=True)


def slot(page, name="run"):
    # Inspect durable bytes directly; do not use the game's in-page candidate.
    return page.evaluate("""name => {
        const raw = localStorage.getItem('kirafan-rl:profile');
        if (raw !== null) { const p = JSON.parse(raw); return name === 'cam-height' ? p.settings[name] ?? null : p[name] ?? null; }
        const legacy = localStorage.getItem('kirafan-rl:' + name);
        return legacy === null ? null : JSON.parse(legacy);
    }""", name)


def dismiss_dialogue(page):
    for _ in range(180):
        visible = page.evaluate("""() => {
            const box = document.getElementById('dialogue-box');
            return !!box && box.style.display !== 'none';
        }""")
        if not visible:
            page.wait_for_timeout(30)
            return
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(30)
    raise AssertionError("dialogue queue did not finish")


def start(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    page.wait_for_selector(".roster-card", timeout=40000)
    page.locator(".roster-card").first.click(); page.wait_for_timeout(100)
    # With the transaction matrix's rAF disabled, the queued room event needs
    # the same first driver tick that a real frame would provide.
    page.evaluate('window.kirafanRL?.step(1/60)')
    page.wait_for_function("window.kirafanRL?.world?.dungeon && window.kirafanRL.world.player",
                           polling=50, timeout=40000)
    ready_room(page)
    page.evaluate("window.kirafanRL.world.player.iframes = 1e9")


def ready_room(page):
    # A world/dungeon exists before its asynchronous map and room objects do.
    page.wait_for_function('window.kirafanRL?.world?.player && window.kirafanRL.world.dungeon',
                           polling=50, timeout=60000)
    page.evaluate('kirafanRL.step(1/60)')
    page.wait_for_function('''()=>{const k=kirafanRL;return k.pending===0 && k.interactPending===0
        && !k.roomLoading && k.mapview.group?.name==='room:'+k.world.roomId;}''', polling=50, timeout=60000)
    dismiss_dialogue(page)
    page.wait_for_function('!kirafanRL.world.frozen', polling=50, timeout=30000)


def prepare_prayer(page):
    ready_room(page)
    before = page.evaluate('''()=>{const w=kirafanRL.world;
        return {floor:w.floor,room:w.roomId,clear:!!w.roomState.get(w.roomId)?.cleared,
            dead:w.player.dead,locked:w.roomLocked,shrine:!!w.floorShrine,
            loading:!!document.querySelector('#rl-floor-load'),result:!!document.querySelector('#rl-result[open]')};}''')
    check('首领清场后保留当前层，只开放雕像而不自动下潜或结算', before['clear']
          and before['shrine'] and not any(before[key] for key in ['dead', 'locked', 'loading', 'result']), before)
    # Stage outside range, then use real movement/collision on the lateral route
    # so unclaimed centre-room loot is not silently picked up by this fixture.
    page.evaluate('''()=>{const w=kirafanRL.world,s=w.floorShrine;
        w.player.x=s.x-1.65;w.player.y=s.y+4;w.player.sm.force('idle');}''')
    page.keyboard.down('w')
    page.evaluate('''()=>{for(let i=0;i<180;i++){
        kirafanRL.step(1/60);
        if (kirafanRL.world.canCommuneAtShrine) return;
    } throw new Error('shrine was not reached by real movement');}''')
    page.keyboard.up('w')
    page.evaluate('kirafanRL.step(1/60)')
    check('实际移动后雕像祈愿可用，未拾取掉落也能选择前行',
          page.evaluate('kirafanRL.world.canCommuneAtShrine'),
          page.evaluate('''()=>{const w=kirafanRL.world,s=w.floorShrine,p=w.player;
              return {shrine:s&&{x:s.x,y:s.y},player:{x:p.x,y:p.y},
                      distance:s&&Math.hypot(p.x-s.x,p.y-s.y),frozen:w.frozen};}'''))
    page.keyboard.down('e'); page.evaluate('kirafanRL.step(1/60)')
    page.keyboard.up('e'); page.evaluate('kirafanRL.step(1/60)')
    page.wait_for_selector('#rl-floor-departure[open]', timeout=10000)
    check('祈愿预览确认前不切层或打开结果页', page.evaluate('''before=>{const w=kirafanRL.world;
        return w.floor===before.floor&&w.roomId===before.room&&w.frozen
            &&!document.querySelector('#rl-floor-load')&&!document.querySelector('#rl-result[open]');}''', before))


def confirm_prayer(page):
    page.locator('#floor-departure-confirm').click()
    page.wait_for_selector('#rl-floor-departure', state='hidden', timeout=10000)


def enter_boss(page):
    page.evaluate("""() => {
        const k = window.kirafanRL;
        const bossRoom = k.world.dungeon.rooms.find(r => r.type === 'boss');
        k.world.enterRoom(bossRoom.id, 'N');
        k.step(1 / 60);
        k.world.enemies.forEach(e => { e.actionTimer = 1e9; });
    }""")
    ready_room(page)


def kill_boss(page):
    page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world;
        const boss = w.enemies.find(e => e.kind === 'boss');
        if (!boss || boss.dead) throw new Error('fixture needs a live final boss');
        window.t23Boss = boss;
        boss.iframes = 0;
        w.danmaku.emit('aimed', {x: boss.x - 3, y: boss.y, angle: 0},
            {side: 'player', power: 999999999, coef: 1, count: 1,
             speed: 10, life: 4});
        for (let i = 0; i < 120 && !boss.dead; i++) k.step(1 / 60);
        if (!boss.dead) throw new Error('real projectile did not kill the boss');
    }""")


def save_triggers(page):
    page.evaluate("""() => {
        for (let i = 0; i < 24; i++) window.kirafanRL.step(0.25);
        window.dispatchEvent(new Event('pagehide'));
    }""")


def canvas_check(page):
    pixels = page.evaluate("""() => {
        const k = window.kirafanRL;
        k.renderOnce();
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const ctx = c.getContext('2d');
        ctx.drawImage(k.renderer.domElement, 0, 0, 64, 64);
        const data = ctx.getImageData(0, 0, 64, 64).data;
        const colors = new Set();
        let opaque = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3]) opaque++;
            colors.add(data[i] + ',' + data[i + 1] + ',' + data[i + 2]);
        }
        return {opaque, colors: colors.size};
    }""")
    check("rendered canvas has scene pixels", pixels["opaque"] > 4000
          and pixels["colors"] > 80, pixels)


def assert_result(page, outcome):
    dismiss_dialogue(page)
    page.wait_for_selector("#rl-result[open]", timeout=10000)
    check(outcome + " result", page.locator("#rl-result").get_attribute("data-outcome") == outcome)
    check("result names the selected character", page.locator(".result-character").inner_text() == "由乃")
    check("terminal run stays frozen", page.evaluate("window.kirafanRL.world.frozen"))
    save_triggers(page)
    check("autosave and pagehide cannot resurrect terminal run", slot(page) is None)


def layout_check(page):
    for width in WIDTHS:
        page.set_viewport_size({"width": width, "height": 844 if width < 768 else 800})
        bad = page.evaluate("""() => {
            const dialog = document.getElementById('rl-result');
            return [...dialog.querySelectorAll('button:not([hidden])')].flatMap(el => {
                const r = el.getBoundingClientRect();
                const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight
                    || r.height < 44 || !el.contains(top) ? [el.id] : [];
            });
        }""")
        check("result controls reachable at width " + str(width), not bad, bad)
        image_ok = page.locator("#rl-result img").evaluate("el => el.complete && el.naturalWidth > 0")
        check("result uses loaded local card art at width " + str(width), image_ok)
        if width in (375, 1280):
            canvas_check(page)
            page.screenshot(path=str(SHOTS / ("victory-" + str(width) + ".png")))
    page.keyboard.press("Escape")
    check("Escape cannot dismiss terminal result", page.locator("#rl-result").is_visible())
    check("keyboard focus stays inside result", page.evaluate(
        "document.getElementById('rl-result').contains(document.activeElement)"))
    for key in ("Tab", "Tab", "Shift+Tab", "Shift+Tab"):
        page.keyboard.press(key)
        check("Tab remains in modal", page.evaluate(
            "document.getElementById('rl-result').contains(document.activeElement)"))


def simultaneous_defeat(page):
    # Hold both real fatal hit events in one drain batch, with the boss event first.
    page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world, p = w.player;
        const boss = w.enemies.find(e => e.kind === 'boss');
        boss.iframes = 0;
        w.danmaku.emit('aimed', {x: boss.x - 3, y: boss.y, angle: 0},
            {side: 'player', power: 999999999, coef: 1, count: 1, speed: 10, life: 4});
        for (let i = 0; i < 120 && !boss.dead; i++) w.update(1 / 60);
        p.iframes = 0;
        w.danmaku.emit('aimed', {x: p.x - 3, y: p.y, angle: 0},
            {side: 'enemy', power: 999999999, coef: 1, count: 1, speed: 10, life: 4});
        for (let i = 0; i < 120 && !p.dead; i++) w.update(1 / 60);
        if (!boss.dead || !p.dead) throw new Error('both real fatal hits are required');
        if (!w.events.some(e => e.type === 'hit' && e.target === boss && e.died)
            || !w.events.some(e => e.type === 'hit' && e.target === p && e.died)) {
            throw new Error('both events must be pending before the driver drains them');
        }
        k.step(1 / 60);
    }""")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with Server(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = "http://127.0.0.1:%d/site/game/roguelike.html" % server.server_address[1]
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                                  "--autoplay-policy=no-user-gesture-required"])
                context = browser.new_context(viewport={"width": 1280, "height": 800})
                context.add_init_script("""if (!localStorage.getItem('kirafan-rl:meta')) {
                    localStorage.setItem('kirafan-rl:meta', JSON.stringify({prologueSeen: true}));
                }""")
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda err: errors.append(str(err)))
                start(page, url + "?volume=1&floor=20")
                enter_boss(page)
                page.wait_for_function("window.kirafanRL.pending === 0", timeout=40000)
                canvas_check(page)
                if not args.probe:
                    SHOTS.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(SHOTS / "battle-desktop.png"))
                kill_boss(page)
                prepare_prayer(page)
                confirm_prayer(page)
                if args.probe:
                    save_triggers(page)
                    check("OLD BUG: cleared boss run is recreated by save triggers",
                          slot(page) is not None, slot(page))
                    check("OLD BUG: no actionable result view", page.locator("#rl-result").count() == 0)
                    print("PROBE reproduced terminal save resurrection", flush=True)
                    browser.close()
                    return 0

                assert_result(page, "victory")
                check("volume one clear recorded", slot(page, "meta")["volumes"] == 1)
                check("next volume action offered", page.locator("#result-next").count() == 1)
                layout_check(page)
                saved_meta = slot(page, "meta")
                page.evaluate("""() => {
                    const k = window.kirafanRL;
                    k.world.events.push({type: 'hit', target: window.t23Boss,
                        attacker: k.world.player, damage: 1, died: true});
                    k.step(1 / 60);
                    k.toggleMenu();
                }""")
                check("duplicate boss event cannot settle twice", slot(page, "meta") == saved_meta)
                check("terminal result blocks pause toggle", page.evaluate("window.kirafanRL.world.frozen")
                      and page.locator("#menu-panel").is_hidden())

                page.locator("#result-next").click()
                page.wait_for_selector(".roster-card", timeout=40000)
                check("next volume navigation removes debug floor", page.url.endswith("?volume=2"), page.url)
                check("new volume has no stale continue", page.locator("#roster-continue").count() == 0)
                page.locator(".roster-card").first.click(); page.wait_for_timeout(100)
                page.wait_for_function("window.kirafanRL?.world?.dungeon", timeout=40000)
                dismiss_dialogue(page)
                check("next volume starts at floor one", page.evaluate("window.kirafanRL.world.floor === 1"))

                # The active save remains compatible, then a real fatal bullet settles it once.
                page.evaluate("""() => {
                    const w = window.kirafanRL.world;
                    w.player.iframes = 1e9;
                    w.player.equipment = [{slot: 'charm', rarity: 'legendary', affixes: []}];
                }""")
                save_triggers(page)
                check("active run still saves", slot(page) is not None)
                page.reload(wait_until="load")
                page.wait_for_selector("#roster-continue", timeout=40000)
                page.locator("#roster-continue").click()
                ready_room(page)
                check("old snapshot fields still resume", page.evaluate(
                    "window.kirafanRL.world.player.equipment[0].rarity === 'legendary'"))
                previous_gems = slot(page, "meta").get("gems", 0)
                page.evaluate("""() => {
                    const k = window.kirafanRL, w = k.world, p = w.player;
                    p.iframes = 0;
                    w.danmaku.emit('aimed', {x: p.x - 3, y: p.y, angle: 0},
                        {side: 'enemy', power: 999999999, coef: 1, count: 1,
                         speed: 10, life: 4});
                    for (let i = 0; i < 120 && !p.dead; i++) k.step(1 / 60);
                    if (!p.dead) throw new Error('real projectile did not kill player');
                }""")
                assert_result(page, "defeat")
                earned = slot(page, "meta")["gems"] - previous_gems
                check("defeat converts equipped loot", earned > 0, earned)
                page.evaluate("""() => {
                    const k = window.kirafanRL;
                    k.world.events.push({type: 'hit', target: k.world.player,
                        attacker: null, damage: 1, died: true});
                    k.step(1 / 60);
                }""")
                check("duplicate death does not award more gems",
                      slot(page, "meta")["gems"] == previous_gems + earned)
                check("defeat offers no next volume", page.locator("#result-next").count() == 0)
                page.screenshot(path=str(SHOTS / "defeat-desktop.png"))
                page.locator("#result-restart").click()
                page.wait_for_selector(".roster-card", timeout=40000)
                check("restart returns to current volume selection", page.url.endswith("?volume=2"))
                check("restart does not recreate old save on pagehide", slot(page) is None)

                # A last-volume clear may not create a volume-six route.
                start(page, url + "?volume=5&floor=20")
                enter_boss(page)
                kill_boss(page)
                prepare_prayer(page)
                confirm_prayer(page)
                assert_result(page, "victory")
                check("finale has no sixth-volume action", page.locator("#result-next").count() == 0)
                page.locator("#result-restart").click()
                page.wait_for_selector(".roster-card", timeout=40000)
                check("finale receipt is confirmed before starting another test run",
                      slot(page, "lastResult")["acknowledged"])

                # Menu restart is explicitly a fresh run, even from a debug floor.
                start(page, url + "?volume=1&floor=7")
                save_triggers(page)
                page.evaluate("window.kirafanRL.toggleMenu()")
                page.locator("#menu-restart").click()
                page.wait_for_selector(".roster-card", timeout=40000)
                check("menu restart removes debug floor", page.url.endswith("?volume=1"), page.url)
                check("menu restart abandons save before pagehide", slot(page) is None)

                touch_context = browser.new_context(viewport={"width": 844, "height": 390},
                                                    is_mobile=True, has_touch=True)
                touch_context.add_init_script("""if (!localStorage.getItem('kirafan-rl:meta')) {
                    localStorage.setItem('kirafan-rl:meta', JSON.stringify({prologueSeen: true}));
                }""")
                touch = touch_context.new_page()
                touch.on("pageerror", lambda err: errors.append(str(err)))
                start(touch, url + "?volume=1&floor=20")
                enter_boss(touch)
                touch.wait_for_function("window.kirafanRL.pending === 0", timeout=40000)
                canvas_check(touch)
                touch.screenshot(path=str(SHOTS / "battle-mobile.png"))
                simultaneous_defeat(touch)
                touch.set_viewport_size({'width': 390, 'height': 844})
                check("off-screen damage cannot enlarge the mobile viewport", touch.evaluate(
                    "innerWidth === 390 && document.documentElement.scrollWidth === 390"))
                assert_result(touch, "defeat")
                check("touch result fits the visual viewport", touch.locator("#rl-result").evaluate(
                    "el => { const r = el.getBoundingClientRect(); return r.x >= 0 && r.right <= 390"
                    " && r.y >= 0 && r.bottom <= 844 && visualViewport.offsetTop === 0; }"))
                check("simultaneous defeat cannot also clear the volume",
                      slot(touch, "meta").get("volumes", 0) == 0)
                touch.screenshot(path=str(SHOTS / "defeat-mobile.png"))
                touch.locator("#result-restart").tap()
                # Mobile portrait keeps the fresh roster behind the landscape
                # gate: the card grid exists but must stay hidden until the
                # viewport actually rotates back to landscape.
                touch.wait_for_selector("#landscape-guard:not([hidden])", timeout=40000)
                check("portrait restart shows the landscape gate, not the roster",
                      not touch.locator(".roster-card").first.is_visible())
                touch.set_viewport_size({"width": 844, "height": 390})
                touch.wait_for_selector(".roster-card", timeout=40000)
                check("touch restart starts a fresh selection", touch.url.endswith("?volume=1")
                      and slot(touch) is None)
                touch_context.close()
                check("no uncaught page errors", not errors, errors)
                browser.close()
        finally:
            server.shutdown()
            thread.join(timeout=5)
    print("RESULT ALL OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
