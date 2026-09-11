"""T29 accessibility settings: menu switches, persistence, import validation and
real view-layer feedback gating. Fixtures freeze enemy timers and measure real
hit events; they never weaken danger bullets, hit ranges or the logic step."""
import functools
import json
import re
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

from serve import NoCacheHandler, Server
from rl_floor_loot_browser import check, ready, profile
from skill_playback_browser import start_game, press, charge, prepare_enemy

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "accessibility"

CHECKBOXES = [("menu-reduced-shake", "reduced-shake"),
              ("menu-reduced-flash", "reduced-flash"),
              ("menu-simplified-ultimates", "simplified-ultimates")]

MENU_JS = """() => {
    const k = window.kirafanRL;
    if (!k.world.frozen) { k.toggleMenu(); k.step(1/60); }
    return document.getElementById('menu-panel').classList.contains('hidden');
}"""


def open_menu(page):
    page.evaluate(MENU_JS)


def close_menu(page):
    page.evaluate("""() => {
        const k = window.kirafanRL;
        if (k.world.frozen && !document.getElementById('menu-panel').classList.contains('hidden')) {
            k.toggleMenu(); k.step(1/60);
        }
    }""")


def settings_of(page):
    return page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).settings")


def persistence_and_ui(page, base):
    start_game(page, base)
    open_menu(page)
    boxes = page.evaluate("""ids => ids.map(id => {
        const n = document.getElementById(id);
        return n ? {id, tag: n.tagName, type: n.type, checked: n.checked, visible:
            !!(n.offsetParent)} : null;
    })""", [row[0] for row in CHECKBOXES])
    check("菜单提供三个辅助设置开关且默认关闭", all(b and b["tag"] == "INPUT" and b["type"] == "checkbox"
          and not b["checked"] and b["visible"] for b in boxes), boxes)

    page.locator("#menu-reduced-shake").check()
    page.evaluate('window.kirafanRL.step(1/60)')
    s = settings_of(page)
    check("切换开关立即写入档案设置", s.get("reduced-shake") is True, s)

    page.locator("#menu-reduced-flash").check()
    page.locator("#menu-simplified-ultimates").check()
    page.locator("#menu-reduced-shake").uncheck()
    page.evaluate('window.kirafanRL.step(1/60)')
    s = settings_of(page)
    check("取消的开关保存显式 false 且其余保留",
          s.get("reduced-shake") is False and s.get("reduced-flash") is True
          and s.get("simplified-ultimates") is True, s)
    close_menu(page)

    page.reload(wait_until="load")
    start_game(page, base)
    open_menu(page)
    states = page.evaluate("""ids => ids.map(id => document.getElementById(id).checked)""",
                           [row[0] for row in CHECKBOXES])
    check("刷新后菜单开关恢复保存的状态", states == [False, True, True], states)
    check("刷新后档案设置与菜单一致", settings_of(page) == {
        "reduced-shake": False, "reduced-flash": True, "simplified-ultimates": True},
        settings_of(page))
    close_menu(page)


def import_validation(page):
    result = page.evaluate("""async () => {
        const save = await import('/site/game/rl/save.js');
        const raw = JSON.parse(save.exportSave());
        const bad = JSON.parse(JSON.stringify(raw));
        bad.settings['unknown-toggle'] = true;
        const good = JSON.parse(JSON.stringify(raw));
        good.settings = {'cam-height': 9, 'reduced-shake': true,
            'reduced-flash': false, 'simplified-ultimates': true};
        return {
            bad: save.previewImport(JSON.stringify(bad)),
            good: save.previewImport(JSON.stringify(good))
        };
    }""")
    check("未知设置键的备份被拒绝且指向设置校验",
          not result["bad"]["ok"] and "设置" in result["bad"]["error"], result["bad"])
    check("合法辅助设置备份可通过预览校验", result["good"]["ok"], result["good"])


def hit_player(page):
    page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world, p = w.player;
        w.enemies.forEach(e => { e.actionTimer = 1e9; });
        p.iframes = 0;
        w.danmaku.emit('aimed', {x: p.x - 3, y: p.y, angle: 0},
            {side: 'enemy', power: 5, coef: 1, count: 1, speed: 10, life: 4});
    }""")


def sample_shake(page, steps):
    return page.evaluate("""steps => {
        const k = window.kirafanRL;
        const out = [];
        for (let i = 0; i < steps; i++) {
            k.step(1/60);
            const s = k.cameraRig.lastShake();
            out.push(Math.hypot(s.x, s.z));
        }
        return {max: Math.max(...out), samples: out.length};
    }""", steps)


def shake_gate(page, base):
    start_game(page, base)
    hit_player(page)
    on = sample_shake(page, 60)
    check("未开启减少震动时真实受击仍有镜头偏移", on["max"] > 0.01, on)

    open_menu(page)
    page.locator("#menu-reduced-shake").check()
    page.evaluate('window.kirafanRL.step(1/60)')
    close_menu(page)

    hit_player(page)
    off = sample_shake(page, 60)
    check("开启减少震动后同一受击路径不再偏移镜头",
          off["max"] == 0 and page.evaluate("kirafanRL.cameraRig.lastShake().active") is False, off)
    hit_player(page)
    off = sample_shake(page, 60)
    check("减少震动在持续受击下保持稳定关闭", off["max"] == 0, off)
    close_menu(page)


def attach_foe_view(page):
    """prepare_enemy's spawned unit only gains a view through the same
    ensureEnemyViews path a summon takes; drive it and wait for the async load."""
    page.evaluate("window.kirafanRL.syncEnemyViews()")
    try:
        page.wait_for_function("""() => window.kirafanRL.pending === 0 &&
            window.kirafanRL.views.enemies.some(row => row.unit === window.skillFoe)""",
            polling=100, timeout=40000)
        return True
    except Exception:
        return False


def hit_foe(page):
    page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world, foe = window.skillFoe;
        w.danmaku.emit('aimed', {x: foe.x, y: foe.y, angle: 0},
            {side: 'player', power: 2, coef: 1, count: 1, speed: 10, life: 4});
        k.step(1/60);
    }""")


def flash_state(page):
    return page.evaluate("""() => {
        const v = window.kirafanRL.views.enemies.find(row => row.unit === window.skillFoe);
        return v.flashState();
    }""")


def flash_gate(page, base):
    start_game(page, base)
    prepare_enemy(page)
    check("测试敌人拥有真实视图", attach_foe_view(page))
    hit_foe(page)
    first = flash_state(page)
    check("未开启减少闪烁时受击为原作过曝强度", first["t"] > 0 and first["gain"] > 1.8, first)

    page.evaluate("""async () => {
        const save = await import('/site/game/rl/save.js');
        save.write('reduced-flash', true, {defer: true});
    }""")
    page.reload(wait_until="load")
    start_game(page, base)
    prepare_enemy(page)
    check("重载后测试敌人拥有真实视图", attach_foe_view(page))
    hit_foe(page)
    second = flash_state(page)
    check("开启减少闪烁后同一受击事件为柔和增益",
          second["t"] > 0 and 0 < second["gain"] <= 1.25, second)


def simplified_ultimate(page, base):
    start_game(page, base)
    open_menu(page)
    page.locator("#menu-simplified-ultimates").check()
    page.evaluate('window.kirafanRL.step(1/60)')
    close_menu(page)

    prepare_enemy(page)
    page.wait_for_function('window.kirafanRL.pending === 0', polling=100, timeout=40000)
    charge(page)
    hp = page.evaluate('window.skillFoe.hp')
    expected = page.evaluate('Math.round(window.kirafanRL.world.player.mgc*2.41*2.6)')
    press(page, 'KeyR')
    page.evaluate("()=>{for(let i=0;i<12;i++)window.kirafanRL.step(1/60);}")
    state = page.evaluate("""() => {
        const k = window.kirafanRL;
        return {stage: !!k.ultimate.stage, loading: k.ultimate.loading,
            frozen: k.world.frozen, gauge: k.world.player.skills.gauge,
            skipHidden: document.querySelector('.rl-ultimate-skip').hidden,
            hp: window.skillFoe.hp, before: %d, expected: %d};
    }""" % (hp, expected))
    check("简化演出直接结算必杀且不进入演出舞台",
          not state["stage"] and not state["loading"] and not state["frozen"]
          and state["gauge"] == 0 and state["skipHidden"] and state["hp"] == state["before"] - state["expected"],
          state)

    open_menu(page)
    page.locator("#menu-simplified-ultimates").uncheck()
    page.evaluate('window.kirafanRL.step(1/60)')
    close_menu(page)
    charge(page)
    hp = page.evaluate('window.skillFoe.hp')
    press(page, 'KeyR')
    page.wait_for_function('!!window.kirafanRL.ultimate.stage', polling=100, timeout=30000)
    frozen = page.evaluate("window.kirafanRL.world.frozen")
    page.locator('.rl-ultimate-skip').click()
    page.evaluate('window.kirafanRL.step(1/60)')
    state = page.evaluate("""() => {
        const k = window.kirafanRL;
        return {frozen: k.world.frozen, gauge: k.world.player.skills.gauge,
            hp: window.skillFoe.hp, before: %d, expected: %d};
    }""" % (hp, expected))
    check("关闭简化后同一开关立即恢复原作演出路径",
          frozen and not state["frozen"] and state["gauge"] == 0
          and state["hp"] == state["before"] - state["expected"], state)
    check("简化演出不再重复结算或残留冻结", not page.evaluate(
        "window.kirafanRL.world.frozen || window.kirafanRL.ultimate.stage"))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with Server(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = "http://127.0.0.1:%d" % server.server_address[1]
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                                   "--autoplay-policy=no-user-gesture-required"])
                try:
                    context = browser.new_context(viewport={"width": 1280, "height": 800})
                    context.add_init_script("""const raf = window.requestAnimationFrame.bind(window);
                        window.requestAnimationFrame = cb => raf(t => {
                            if (!window.__manualRAF) { cb(t); } });""")
                    page = context.new_page()
                    errors = []
                    page.on("pageerror", lambda err: errors.append(str(err)))
                    persistence_and_ui(page, base)
                    import_validation(page)
                    context.close()

                    context = browser.new_context(viewport={"width": 1280, "height": 800})
                    context.add_init_script("""const raf = window.requestAnimationFrame.bind(window);
                        window.requestAnimationFrame = cb => raf(t => {
                            if (!window.__manualRAF) { cb(t); } });""")
                    page = context.new_page()
                    page.on("pageerror", lambda err: errors.append(str(err)))
                    shake_gate(page, base)
                    context.close()

                    context = browser.new_context(viewport={"width": 1280, "height": 800})
                    context.add_init_script("""const raf = window.requestAnimationFrame.bind(window);
                        window.requestAnimationFrame = cb => raf(t => {
                            if (!window.__manualRAF) { cb(t); } });""")
                    page = context.new_page()
                    page.on("pageerror", lambda err: errors.append(str(err)))
                    flash_gate(page, base)
                    simplified_ultimate(page, base)
                    check("辅助设置验证无未处理页面异常", not errors, errors)
                    context.close()
                finally:
                    browser.close()
        finally:
            server.shutdown()
            thread.join(timeout=5)
    print("ACCESSIBILITY ALL OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
