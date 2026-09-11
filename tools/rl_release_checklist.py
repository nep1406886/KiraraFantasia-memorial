"""T28 spec/08 §7.4 release-candidate checklist, driven against the packed
/kirafan-timer/ copy built by tools/rl_release_pack.py.

Flows reuse the proven rl_result_browser / rl_floor_browser helpers so the
pack is exercised through the same real-event paths as development-tree
acceptance. One shared gate: zero 404+ responses and zero pageerrors across
every phase (console/request-failure check from §7.4)."""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_continuous_aim_browser import Touches
from rl_floor_browser import KILL_ROOM
from rl_result_browser import (assert_result, confirm_prayer, dismiss_dialogue,
                               enter_boss, kill_boss, prepare_prayer, ready_room,
                               slot, start, save_triggers)

ROOT = Path(__file__).resolve().parent.parent
PACK_ROOT = ROOT / ".codex-tmp" / "release-pack"
OUT = PACK_ROOT
checks = []
failures = []
errors = []


def check(label, ok, detail=None):
    if not ok:
        raise AssertionError(label + ": " + repr(detail))
    checks.append(label)
    print("PASS " + label, flush=True)


def attach(page):
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("response", lambda r: failures.append(
        {"url": r.url[-120:], "status": r.status}) if r.status >= 400 else None)


META_INIT = ("if(!localStorage.getItem('kirafan-rl:meta')){"
             "localStorage.setItem('kirafan-rl:meta',JSON.stringify("
             "{prologueSeen:true,tutorialSeen:true}));}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"complete": False}
    try:
        server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(PACK_ROOT)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        entry = "http://127.0.0.1:%d/kirafan-timer/site/game/roguelike.html" % server.server_address[1]
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                                   "--autoplay-policy=no-user-gesture-required"])
                try:
                    # --- A. new save boot + B. guarded descent (one context) ---
                    context = browser.new_context(viewport={"width": 1280, "height": 800})
                    context.add_init_script(META_INIT)
                    page = context.new_page()
                    attach(page)
                    start(page, entry + "?volume=1")
                    check("新存档开局进入第一层",
                          page.evaluate("kirafanRL.world.floor === 1 && !!kirafanRL.world.dungeon"))
                    page.evaluate("""() => {
                        const k = window.kirafanRL;
                        const guard = k.world.dungeon.rooms.find(r => r.type === 'boss');
                        k.world.enterRoom(guard.id, 'N');
                    }""")
                    ready_room(page)
                    page.evaluate(KILL_ROOM)
                    page.wait_for_function(
                        "kirafanRL.world.roomState.get(kirafanRL.world.roomId)?.cleared",
                        polling=50, timeout=40000)
                    prepare_prayer(page)
                    confirm_prayer(page)
                    page.wait_for_function("kirafanRL.world.floor === 2", polling=50, timeout=40000)
                    page.wait_for_function(
                        "kirafanRL.world.roomId === kirafanRL.world.dungeon.start",
                        polling=50, timeout=40000)
                    check("守卫清场祈愿确认后真实下潜到第2层并重建地牢",
                          page.evaluate("kirafanRL.world.floor === 2"))

                    # --- C. victory settlement + next volume ---
                    start(page, entry + "?volume=1&floor=20")
                    enter_boss(page)
                    kill_boss(page)
                    prepare_prayer(page)
                    confirm_prayer(page)
                    assert_result(page, "victory")
                    check("通关结算记录卷进度", slot(page, "meta")["volumes"] == 1)
                    check("下一卷入口已提供", page.locator("#result-next").count() == 1)
                    page.locator("#result-next").click()
                    page.wait_for_selector(".roster-card", timeout=60000)
                    check("下一卷导航回到选人且无续档", page.url.endswith("?volume=2")
                          and page.locator("#roster-continue").count() == 0, page.url)

                    # --- D. defeat settlement from a continued run ---
                    page.locator(".roster-card").first.click()
                    page.wait_for_timeout(100)
                    page.evaluate("window.kirafanRL?.step(1/60)")
                    page.wait_for_function("window.kirafanRL?.world?.dungeon",
                                           polling=50, timeout=60000)
                    dismiss_dialogue(page)
                    page.evaluate("""() => {
                        const w = window.kirafanRL.world;
                        w.player.iframes = 1e9;
                        w.player.equipment = [{slot: 'charm', rarity: 'legendary', affixes: []}];
                    }""")
                    save_triggers(page)
                    page.reload(wait_until="load")
                    page.wait_for_selector("#roster-continue", timeout=60000)
                    page.locator("#roster-continue").click()
                    ready_room(page)
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
                    check("死亡结算折价装备获得星彩石", earned > 0, earned)
                    check("失败无下一卷入口", page.locator("#result-next").count() == 0)
                    page.locator("#result-restart").click()
                    page.wait_for_selector(".roster-card", timeout=60000)
                    check("重开回到本卷选人", page.url.endswith("?volume=2"), page.url)
                    context.close()

                    # --- E. pause/settings + F. codex (fresh context) ---
                    context = browser.new_context(viewport={"width": 1280, "height": 800})
                    context.add_init_script(META_INIT)
                    page = context.new_page()
                    attach(page)
                    start(page, entry + "?volume=1")
                    page.evaluate("window.kirafanRL.toggleMenu()")
                    page.wait_for_selector("#menu-panel:not(.hidden)", timeout=20000)
                    check("暂停冻结世界", page.evaluate("window.kirafanRL.world.frozen"))
                    page.select_option("#menu-quality", "performance")
                    page.dispatch_event("#menu-quality", "change")
                    page.wait_for_function(
                        "() => kirafanRL.renderer.getPixelRatio() === 1", polling=100, timeout=20000)
                    check("流畅档切换立即降低渲染像素比",
                          page.evaluate("kirafanRL.renderer.getPixelRatio()") == 1)
                    page.select_option("#menu-quality", "high")
                    page.dispatch_event("#menu-quality", "change")
                    page.wait_for_function(
                        "() => kirafanRL.renderer.getPixelRatio() === 2", polling=100, timeout=20000)
                    page.locator("#menu-reduced-flash").check()
                    page.evaluate("window.kirafanRL.step(1/60)")
                    settings = page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).settings")
                    check("设置写档持久化",
                          settings.get("quality") == "high"
                          and settings.get("reduced-flash") is True, settings)
                    page.locator("#menu-resume").click()
                    page.wait_for_function("!window.kirafanRL.world.frozen", polling=100, timeout=20000)
                    check("恢复后世界继续", not page.evaluate("window.kirafanRL.world.frozen"))
                    page.evaluate("window.kirafanRL.toggleMenu()")
                    page.wait_for_selector("#menu-panel:not(.hidden)", timeout=20000)
                    page.locator("#menu-codex").click()
                    page.wait_for_selector(".codex-overlay", timeout=20000)
                    check("图鉴在发布包内打开且有条目",
                          page.locator(".codex-entry").count() > 0,
                          page.locator(".codex-entry").count())
                    page.keyboard.press("Escape")
                    page.wait_for_selector(".codex-overlay", state="detached", timeout=20000)
                    context.close()

                    # --- G. touch operation (landscape, real pointer) ---
                    touch_context = browser.new_context(viewport={"width": 844, "height": 390},
                                                        is_mobile=True, has_touch=True)
                    touch_context.add_init_script(META_INIT)
                    touch = touch_context.new_page()
                    attach(touch)
                    start(touch, entry + "?volume=1")
                    # start()'s mouse-assisted roster/dialogue clicks return the
                    # HUD to fine-pointer chrome; one real touch restores touch
                    # controls before the landscape joystick can be located.
                    touch.touchscreen.tap(600, 190)
                    before = touch.evaluate("kirafanRL.world.player.x")
                    zone = touch.locator(".touch-zone").bounding_box()
                    touches = Touches(touch)
                    ident = 7
                    sx = zone["x"] + zone["width"] * 0.25
                    sy = zone["y"] + zone["height"] / 2
                    touches.down(ident, sx, sy)
                    touches.move(ident, sx + 60, sy)
                    touch.wait_for_timeout(900)
                    touches.up(ident)
                    after = touch.evaluate("kirafanRL.world.player.x")
                    check("触控摇杆真实移动角色", after - before > 0.2,
                          {"before": before, "after": after})
                    touch_context.close()
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()
        check("全流程零请求失败与零页面异常", not failures and not errors,
              {"failures": failures[:10], "errors": errors[:6]})
        report["complete"] = True
        report["checks"] = len(checks)
    except Exception as error:
        report["failure"] = repr(error)
        raise
    finally:
        (OUT / "checklist-report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("RELEASE CHECKLIST OK (%d checks)" % len(checks), flush=True)


if __name__ == "__main__":
    main()
