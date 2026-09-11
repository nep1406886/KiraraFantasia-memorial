"""T29 quality tiers (spec/08 section 5): menu select, pixel ratio + trail rate,
persistence applied at boot, and backup import validation for the tier enum.
Presentation-only: world logic, hit ranges and the fixed step are untouched."""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

from serve import NoCacheHandler, Server
from rl_floor_loot_browser import check
from skill_playback_browser import start_game

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "quality"

MENU_JS = """() => {
    const k = window.kirafanRL;
    if (!k.world.frozen) { k.toggleMenu(); k.step(1/60); }
    return document.getElementById('menu-panel').classList.contains('hidden');
}"""

OPEN_MENU = """() => {
    const k = window.kirafanRL;
    if (!k.world.frozen) { k.toggleMenu(); k.step(1/60); }
}"""

CLOSE_MENU = """() => {
    const k = window.kirafanRL;
    if (k.world.frozen && !document.getElementById('menu-panel').classList.contains('hidden')) {
        k.toggleMenu(); k.step(1/60);
    }
}"""


def settings_of(page):
    return page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).settings")


def render_state(page):
    return page.evaluate("""() => {
        const k = window.kirafanRL, gl = k.renderer.getContext();
        return { level: k.quality && k.quality.level, ratio: k.renderer.getPixelRatio(),
            buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
            trailRate: k.quality && k.quality.trailRate,
            select: (function () {
                const n = document.getElementById('menu-quality');
                return n ? { tag: n.tagName, value: n.value, visible: !!(n.offsetParent),
                    options: [...n.options].map(o => o.value) } : null;
            })() };
    }""")


def ui_and_ratio(page, base):
    start_game(page, base)
    page.evaluate(OPEN_MENU)
    state = render_state(page)
    check("菜单提供画质三档选择且默认还原档",
          state["select"] and state["select"]["tag"] == "SELECT" and state["select"]["visible"]
          and state["select"]["options"] == ["high", "balanced", "performance"]
          and state["select"]["value"] == "high", state["select"])
    check("默认档保持至少2倍像素比还原", state["ratio"] >= 2 and state["level"] == "high"
          and state["trailRate"] == 18, state)
    wide = state["buffer"][0]

    page.locator("#menu-quality").select_option("performance")
    page.evaluate('window.kirafanRL.step(1/60)')
    perf = render_state(page)
    check("切到流畅档立即写入档案设置", settings_of(page).get("quality") == "performance",
          settings_of(page))
    check("流畅档即时降为1倍像素比并降低拖尾粒子率",
          perf["ratio"] == 1 and perf["buffer"][0] < wide and perf["trailRate"] == 6
          and perf["level"] == "performance", perf)

    page.locator("#menu-quality").select_option("balanced")
    page.evaluate('window.kirafanRL.step(1/60)')
    bal = render_state(page)
    check("均衡档恢复介于两档之间的像素比与粒子率",
          bal["ratio"] == 1.5 and bal["trailRate"] == 12, bal)
    page.locator("#menu-quality").select_option("performance")
    page.evaluate('window.kirafanRL.step(1/60)')
    page.evaluate(CLOSE_MENU)


def boot_and_persistence(page, base):
    start_game(page, base)
    state = render_state(page)
    check("重载后画质档位在启动时即生效", state["level"] == "performance"
          and state["ratio"] == 1 and state["trailRate"] == 6, state)
    page.evaluate(OPEN_MENU)
    value = page.evaluate("document.getElementById('menu-quality').value")
    check("重载后菜单选择器反映保存的档位", value == "performance", value)

    page.locator("#menu-quality").select_option("high")
    page.evaluate('window.kirafanRL.step(1/60)')
    page.evaluate(CLOSE_MENU)
    start_game(page, base)
    state = render_state(page)
    check("切回还原档并重载后恢复2倍像素比", state["level"] == "high"
          and state["ratio"] >= 2 and settings_of(page).get("quality") == "high", state)


def import_validation(page):
    result = page.evaluate("""async () => {
        const save = await import('/site/game/rl/save.js');
        const raw = JSON.parse(save.exportSave());
        const low = JSON.parse(JSON.stringify(raw));
        low.settings['quality'] = 'low';
        const good = JSON.parse(JSON.stringify(raw));
        good.settings['quality'] = 'balanced';
        return { low: save.previewImport(JSON.stringify(low)),
            good: save.previewImport(JSON.stringify(good)) };
    }""")
    check("非法画质档位的备份被拒绝且指向画质校验",
          not result["low"]["ok"] and "画质" in result["low"]["error"], result["low"])
    check("合法画质档位的备份可通过预览校验", result["good"]["ok"], result["good"])


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
                    ui_and_ratio(page, base)
                    boot_and_persistence(page, base)
                    import_validation(page)
                    check("画质档位验证无未处理页面异常", not errors, errors)
                    context.close()
                finally:
                    browser.close()
        finally:
            server.shutdown()
            thread.join(timeout=5)
    print("QUALITY ALL OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
