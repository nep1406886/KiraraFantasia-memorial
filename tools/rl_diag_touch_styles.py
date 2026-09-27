#!/usr/bin/env python3
"""Dump computed styles of #dialogue-box during the vol1-floor5 touch stall."""
import functools
import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

STYLE = """() => {
    const b = document.getElementById('dialogue-box');
    const cs = getComputedStyle(b);
    return { cls: b.className, display: cs.display, visibility: cs.visibility,
             opacity: cs.opacity, txt: (b.textContent || '').slice(0, 40) };
}"""

with Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT))) as srv:
    t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
    base = "http://127.0.0.1:%d" % srv.server_address[1]
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        ctx = b.new_context(viewport={"width": 844, "height": 390}, has_touch=True, is_mobile=True)
        ctx.add_init_script(
            "window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};"
            "localStorage.setItem('kirafan-rl:meta',"
            "JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
        page = ctx.new_page()
        page.goto(base + "/site/game/roguelike.html?seed=73061&volume=1&floor=5",
                  wait_until="load", timeout=60000)
        page.wait_for_selector(".roster-card", timeout=60000)
        page.locator(".roster-card").filter(
            has=page.locator('img[src$="/14002001.webp"]')).tap()
        page.wait_for_function(
            "window.kirafanRL?.world?.player && kirafanRL.pending===0",
            polling=100, timeout=60000)
        for _ in range(60):
            if not page.locator("#dialogue-box").is_visible():
                break
            page.locator("#dialogue-skip").tap(timeout=3000)
            page.wait_for_timeout(30)
        advance(page, 1 / 60)
        page.evaluate("""() => { const k = kirafanRL, w = k.world;
            window.__oldMap = k.mapview.group?.uuid;
            w.enterRoom(w.dungeon.rooms.find(r => r.type === 'boss').id);
            k.step(0); }""")
        stalled = False
        for i in range(60):
            if not page.locator("#dialogue-box").is_visible():
                print("entry closed at", i)
                break
            try:
                page.locator("#dialogue-skip").tap(timeout=3000)
            except Exception as e:
                print("tap error at", i, str(e)[:80])
            page.wait_for_timeout(30)
            if i in (5, 15, 30, 50):
                print(i, json.dumps(page.evaluate(STYLE), ensure_ascii=False))
        else:
            stalled = True
        print("stalled" if stalled else "closed")
        b.close()
    srv.shutdown(); t.join(timeout=4)
