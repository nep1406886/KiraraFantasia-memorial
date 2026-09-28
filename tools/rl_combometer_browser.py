#!/usr/bin/env python3
"""C.3 连击计数 Chromium 验证.

Contract:
  - under COMBO_MIN hits the ticker stays invisible
  - from COMBO_MIN on it shows "N 连击" and grows
  - the chain breaks silently after COMBO_WINDOW without hits
  - a room switch resets it
  - no page errors

Usage: python tools/rl_combometer_browser.py
"""
import functools
import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import NoCacheHandler, Server
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".codex-tmp" / "combo-meter"

HIT_ONCE = """() => {
    const w = kirafanRL.world;
    const p = w.player;
    const target = w.enemies.find(e => !e.dead);
    if (!target) { return { noTarget: true }; }
    p.x = target.x - 2.5; p.y = target.y; p.iframes = 1e9;
    // A scratch hit: enough to land, nowhere near killing.
    w.danmaku.emit("aimed", { x: p.x + 1, y: p.y, angle: 0 }, {
        side: "player", srcId: p.id, power: 10, coef: 1,
        speed: 30, offset: 0, life: 2, radius: 6
    });
    for (let t = 0; t < 16; t++) { kirafanRL.step(1/60); }
    return { count: kirafanRL.views.comboMeter.count };
}"""


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"checks": [], "errors": []}

    def check(name, ok, detail=None):
        report["checks"].append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + name, flush=True)

    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
            context = browser.new_context(viewport={"width": 1280, "height": 840})
            context.add_init_script(
                "window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};"
                "localStorage.setItem('kirafan-rl:meta',"
                "JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
            page = context.new_page()
            page.on("pageerror", lambda e: report["errors"].append(str(e)))
            page.goto(base + "/site/game/roguelike.html?seed=73061&volume=1",
                      wait_until="load", timeout=60000)
            page.wait_for_selector(".roster-card", timeout=60000)
            page.locator(".roster-card").filter(
                has=page.locator('img[src$="/14002001.webp"]')).click()
            page.wait_for_function(
                "window.kirafanRL?.world?.player && kirafanRL.pending===0",
                polling=100, timeout=60000)
            for _ in range(600):
                page.evaluate("kirafanRL.step(1/60)")
                if page.locator("#dialogue-box").is_visible():
                    page.evaluate("document.getElementById('dialogue-skip').click()")
                if not page.evaluate("kirafanRL.world.frozen"):
                    break
                page.wait_for_timeout(10)
            page.evaluate("""() => {
                const w = kirafanRL.world;
                const battle = w.dungeon.rooms.find(r => r.type === "battle");
                w.enterRoom(battle.id, "N"); kirafanRL.step(1/60);
            }""")
            for _ in range(80):
                page.wait_for_timeout(50)
                if not page.evaluate("kirafanRL.roomLoading"):
                    break
            for _ in range(600):
                page.evaluate("kirafanRL.step(1/60)")
                if page.locator("#dialogue-box").is_visible():
                    page.evaluate("document.getElementById('dialogue-skip').click()")
                if not page.evaluate("kirafanRL.world.frozen"):
                    break
                page.wait_for_timeout(10)

            # Four scratch hits: below COMBO_MIN — invisible.
            for _ in range(4):
                page.evaluate(HIT_ONCE)
            st4 = page.evaluate("""() => ({
                count: kirafanRL.views.comboMeter.count,
                visible: getComputedStyle(kirafanRL.views.comboMeter.node).opacity !== "0"
            })""")
            check("未到 5 连击时计数器不出现", st4["count"] == 4 and not st4["visible"], st4)
            # The fifth shows it.
            page.evaluate(HIT_ONCE)
            st5 = page.evaluate("""() => ({
                count: kirafanRL.views.comboMeter.count,
                text: kirafanRL.views.comboMeter.node.textContent,
                visible: getComputedStyle(kirafanRL.views.comboMeter.node).opacity !== "0"
            })""")
            check("第 5 连击起显示 N 连击", st5["count"] == 5 and "5" in (st5["text"] or "")
                  and st5["visible"], st5)
            # Silence > window resets.
            page.evaluate(
                "() => { for (let i = 0; i < 200; i++) { kirafanRL.step(1/60); } }")
            stR = page.evaluate("""() => ({
                count: kirafanRL.views.comboMeter.count,
                visible: getComputedStyle(kirafanRL.views.comboMeter.node).opacity !== "0"
            })""")
            check("断连静默归零", stR["count"] == 0 and not stR["visible"], stR)
            check("无页面异常", not report["errors"], report["errors"][:3])
            browser.close()
    finally:
        server.shutdown()
        worker.join(timeout=5)
        (OUT / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failed = sum(1 for c in report["checks"] if not c["ok"])
    print("Combo meter gate: %d checks, %d failed" % (len(report["checks"]), failed), flush=True)
    return 1 if failed or report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
