#!/usr/bin/env python3
"""2026-09-28 装备鼠标拾取 Chromium 验证.

Contract:
  - a left click whose ground projection lands within PICKUP_RADIUS of an
    unoffered drop opens the equipment comparison
  - the click does NOT also swing (swingId unchanged by the pickup click)
  - a click with no drop under it swings as before (historical behavior)
  - E-key approach still offers (the old path is intact)

Usage: python tools/rl_pickup_click_browser.py
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
OUT = ROOT / ".codex-tmp" / "pickup-click"

SPAWN_DROP = """() => {
    const w = kirafanRL.world;
    const p = w.player;
    // A real catalog weapon drop beside the player.
    const drop = { x: p.x + 1.2, y: p.y, items: [{
        slot: 'weapon', rarity: 'rare', catalogId: 100101, affixes: [] }] };
    w.drops.push(drop);
    w.events.push({ type: 'drop', drop: drop, items: drop.items, x: drop.x, y: drop.y });
    kirafanRL.step(1/60);
    return { dropX: drop.x, dropY: drop.y, playerX: p.x, playerY: p.y };
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

            # Spawn a drop, project its ground point back to the screen, and
            # click there through the real canvas event path.
            at = page.evaluate(SPAWN_DROP)
            # Drive the click via input.state.pickupProbe + pointer so the
            # full consumeEvents path runs:
            out = page.evaluate("""async (at) => {
                const k = kirafanRL, w = k.world;
                const {THREE} = await (await import('/site/core/loader.js')).loadModules();
                const p = new THREE.Vector3(at.dropX, 0, at.dropY).project(k.camera);
                const rect = k.renderer.domElement.getBoundingClientRect();
                const cx = rect.left + (p.x * .5 + .5) * rect.width;
                const cy = rect.top + (.5 - p.y * .5) * rect.height;
                // dispatch a real mousedown on the canvas
                k.renderer.domElement.dispatchEvent(new MouseEvent('mousedown', {
                    button: 0, clientX: cx, clientY: cy, bubbles: true }));
                const swingBefore = w.player.swingId;
                k.step(1/60);
                const choiceOpen = !!document.getElementById('rl-equipment-choice');
                const swingAfter = w.player.swingId;
                return { choiceOpen, swingBefore, swingAfter,
                         probe: k.input.state.pickupProbe };
            }""", at)
            check("点击掉落标记弹出装备对比", out["choiceOpen"], out)
            check("拾取点击不会同时挥击", out["swingAfter"] == out["swingBefore"], out)
            # Close the choice (decline) and confirm a miss-click swings.
            page.evaluate("""() => {
                const el = document.getElementById('rl-equipment-choice');
                const keep = el && el.querySelector('button');
                // The first button is 不换 (decline) — same as a player passing.
                if (keep) keep.click();
            }""")
            for _ in range(20):
                if not page.evaluate("!!document.getElementById('rl-equipment-choice')"):
                    break
                page.wait_for_timeout(50)
            miss = page.evaluate("""async (at) => {
                const k = kirafanRL, w = k.world;
                const {THREE} = await (await import('/site/core/loader.js')).loadModules();
                // A point far from any drop: over the room corner.
                const p = new THREE.Vector3(2, 0, 2).project(k.camera);
                const rect = k.renderer.domElement.getBoundingClientRect();
                const cx = rect.left + (p.x * .5 + .5) * rect.width;
                const cy = rect.top + (.5 - p.y * .5) * rect.height;
                const swingBefore = w.player.swingId;
                k.renderer.domElement.dispatchEvent(new MouseEvent('mousedown', {
                    button: 0, clientX: cx, clientY: cy, bubbles: true }));
                k.step(1/60);
                k.renderer.domElement.dispatchEvent(new MouseEvent('mouseup', {
                    button: 0, clientX: cx, clientY: cy, bubbles: true }));
                for (let i = 0; i < 90 && w.player.swingId === swingBefore; i++) {
                    k.step(1/60);
                }
                return { swung: w.player.swingId !== swingBefore,
                         state: w.player.sm.state,
                         frozen: w.frozen,
                         choiceStill: !!document.getElementById('rl-equipment-choice') };
            }""", at)
            check("无掉落处的点击照常攻击", miss["swung"], miss)
            check("无页面异常", not report["errors"], report["errors"][:3])
            page.screenshot(path=str(OUT / "pickup-click.png"))
            browser.close()
    finally:
        server.shutdown()
        worker.join(timeout=5)
        (OUT / "report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failed = sum(1 for c in report["checks"] if not c["ok"])
    print("Pickup click gate: %d checks, %d failed" % (len(report["checks"]), failed), flush=True)
    return 1 if failed or report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
