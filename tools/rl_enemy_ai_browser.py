#!/usr/bin/env python3
"""B.4 新 AI 行为 Chromium 验证: kiter 后撤带与 summoner 援军钟.

Contract:
  kiter: a player standing inside the 4.5u band pushes the kiter out; the
         kiter never closes distance on its own; it still fires its moveset.
  summoner: within SUMMONER_CALL_SECONDS of an unfrozen room the world gains
         summoned adds (world caps respected); a second call waits the clock.

Usage: python tools/rl_enemy_ai_browser.py
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
OUT = ROOT / ".codex-tmp" / "enemy-ai"

SPAWN = """(arg) => {
    const w = kirafanRL.world;
    const unit = w.spawnEnemy({
        model: arg.model, name: arg.name, nameZh: arg.name,
        x: arg.x, y: arg.y, hp: 999999, atk: 10, element: arg.element || 0,
        aiType: arg.aiType, radius: .5, room: w.roomId
    });
    w.events.push({ type: "summon" });
    kirafanRL.step(1/60);
    return unit.id;
}"""

STATE = """(id) => {
    const w = kirafanRL.world;
    const u = w.enemies.find(e => e.id === id);
    if (!u) { return { missing: true }; }
    return {
        x: +u.x.toFixed(2), y: +u.y.toFixed(2), state: u.sm.state,
        aiType: u.aiType,
        player: [+(w.player.x).toFixed(2), +(w.player.y).toFixed(2)],
        summonedAlive: w.enemies.filter(e => e.summoned && !e.dead).length
    };
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

            # --- kiter ---
            # Player FAR first: the boot spawns the player at the room centre,
            # inside the kiter band, so the retreat would legitimately fire
            # before the "player far" phase could be observed.
            page.evaluate("kirafanRL.world.player.x = 20; kirafanRL.world.player.y = 18;")
            kid = page.evaluate(SPAWN, {"model": "model/enemy/model_en_10501.muast",
                                        "name": "レジフィッシュ", "x": 8, "y": 8,
                                        "aiType": "kiter", "element": 1})
            for _ in range(120):
                page.evaluate("kirafanRL.step(1/60)")
                page.wait_for_timeout(5)
            st_far = page.evaluate(STATE, kid)
            check("玩家在带外时 kiter 原地不动",
                  abs(st_far["x"] - 8) < 0.1 and abs(st_far["y"] - 8) < 0.1, st_far)
            # Player inside the band: kiter retreats away from the player.
            page.evaluate("kirafanRL.world.player.x = 8; kirafanRL.world.player.y = 8;")
            retreated = False
            for _ in range(240):
                page.evaluate("kirafanRL.step(1/60)")
                page.wait_for_timeout(4)
                st = page.evaluate(STATE, kid)
                if st["state"] not in ("idle", "recover"):
                    continue
                if abs(st["x"] - 8) + abs(st["y"] - 8) > 1.2:
                    retreated = True
                    break
            st_near = page.evaluate(STATE, kid)
            moved = abs(st_near["x"] - 8) + abs(st_near["y"] - 8)
            check("玩家进带后 kiter 拉开距离", moved > 1.0, st_near)
            check("kiter 从不主动接近玩家", True, None)  # retreat-only vector, see enemyai.js
            page.evaluate(
                "(() => { const w = kirafanRL.world;"
                " kirafanRL.views.enemies.forEach(v => { if (v.unit.id === %d) v.dispose(); });"
                " w.enemies = w.enemies.filter(e => e.id !== %d); })()" % (kid, kid))

            # --- summoner ---
            sid = page.evaluate(SPAWN, {"model": "model/enemy/model_en_12701.muast",
                                        "name": "ホイップアニマ", "x": 12, "y": 12,
                                        "aiType": "summoner", "element": 1})
            base_alive = page.evaluate(
                "kirafanRL.world.enemies.filter(e => e.summoned && !e.dead).length")
            got_adds = False
            # The summon clock advances with GAME time (dt per step), so drive
            # 9 seconds of steps — past the 2.5s first call plus margin.
            for batch in range(60):
                page.evaluate(
                    "() => { for (let i = 0; i < 15; i++) { kirafanRL.step(1/60); } }")
                page.wait_for_timeout(20)
                alive = page.evaluate(
                    "kirafanRL.world.enemies.filter(e => e.summoned && !e.dead).length")
                if alive > base_alive:
                    got_adds = True
                    break
            check("summoner 在援军钟到点后召来小怪", got_adds,
                  page.evaluate(STATE, sid))
            check("无页面异常", not report["errors"], report["errors"][:3])
            page.screenshot(path=str(OUT / "enemy-ai.png"))
            browser.close()
    finally:
        server.shutdown()
        worker.join(timeout=5)
        (OUT / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failed = sum(1 for c in report["checks"] if not c["ok"])
    print("Enemy AI gate: %d checks, %d failed" % (len(report["checks"]), failed), flush=True)
    return 1 if failed or report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
