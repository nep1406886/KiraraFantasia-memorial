#!/usr/bin/env python3
"""B.5 死亡表现 Chromium 验证.

Contract:
  - every enemy kill spawns a death stain (count matches kills)
  - stains retire after ~1.2s of game time and are fully gone
  - leaving the room clears them
  - no page errors

Usage: python tools/rl_death_browser.py
"""
import functools
import json
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import NoCacheHandler, Server
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".codex-tmp" / "death-fx"

KILL_ONE = """() => {
    const w = kirafanRL.world;
    const p = w.player;
    const target = w.enemies.find(e => !e.dead);
    if (!target) { return { noTarget: true }; }
    p.x = target.x - 2.5; p.y = target.y; p.iframes = 1e9; p.hp = p.maxHp;
    w.danmaku.emit("aimed", { x: p.x + 1, y: p.y, angle: 0 }, {
        side: "player", srcId: p.id, power: target.hp + 5000, coef: 1,
        speed: 30, offset: 0, life: 2, radius: 6
    });
    for (let t = 0; t < 16; t++) { kirafanRL.step(1/60); }
    return { dead: !!target.dead, stains: kirafanRL.views.deathStains.count };
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
            # Enter a battle room so enemies exist.
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

            enemies = page.evaluate("kirafanRL.world.enemies.filter(e => !e.dead).length")
            check("战斗房里有敌人可击杀", enemies > 0, enemies)
            kill1 = page.evaluate(KILL_ONE)
            check("击杀一只后地面残留出现", kill1.get("stains", 0) >= 1, kill1)
            # Stains retire after ~1.2s of game time.
            page.evaluate(
                "() => { for (let i = 0; i < 100; i++) { kirafanRL.step(1/60); } }")
            after = page.evaluate("kirafanRL.views.deathStains.count")
            check("残留随时间消退", after == 0, after)
            # Kill again: the count tracks.
            kill2 = page.evaluate(KILL_ONE)
            check("再次击杀再次出现残留", kill2.get("stains", 0) >= 1, kill2)
            # Room switch clears.
            page.evaluate("""() => {
                const w = kirafanRL.world;
                const back = w.dungeon.rooms.find(r => r.type !== "battle") || w.dungeon.start;
                w.enterRoom(back.id, "N"); kirafanRL.step(1/60);
            }""")
            for _ in range(80):
                page.wait_for_timeout(50)
                if not page.evaluate("kirafanRL.roomLoading"):
                    break
            cleared = page.evaluate("kirafanRL.views.deathStains.count")
            check("换房清空残留", cleared == 0, cleared)
            check("无页面异常", not report["errors"], report["errors"][:3])
            page.screenshot(path=str(OUT / "death-stains.png"))
            browser.close()
    finally:
        server.shutdown()
        worker.join(timeout=5)
        (OUT / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failed = sum(1 for c in report["checks"] if not c["ok"])
    print("Death FX gate: %d checks, %d failed" % (len(report["checks"]), failed), flush=True)
    return 1 if failed or report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
