#!/usr/bin/env python3
"""Diagnose the boss-gate dialogue stall: trace skip clicks + dialogue state."""
import functools
import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import NoCacheHandler, Server
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

DIALOGUE_STATE = """() => {
    const b = document.getElementById('dialogue-box');
    return { cls: b ? b.className : null,
             txt: b ? (b.textContent || '').slice(0, 60) : null,
             frozen: window.kirafanRL ? kirafanRL.world.frozen : null };
}"""

with Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT))) as srv:
    t = threading.Thread(target=srv.serve_forever, daemon=True); t.start()
    base = "http://127.0.0.1:%d" % srv.server_address[1]
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        page = b.new_page(viewport={"width": 800, "height": 600})
        page.add_init_script(
            "window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};"
            "localStorage.setItem('kirafan-rl:meta',"
            "JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
        page.goto(base + "/site/game/roguelike.html?seed=73061&volume=1&floor=20",
                  wait_until="load", timeout=60000)
        page.wait_for_selector(".roster-card", timeout=60000)
        page.locator(".roster-card").filter(
            has=page.locator('img[src$="/14002001.webp"]')).click()
        page.wait_for_function(
            "window.kirafanRL?.world?.player && kirafanRL.pending===0",
            polling=100, timeout=60000)
        for i in range(12):
            if not page.locator("#dialogue-box").is_visible():
                print(i, "box hidden — closed")
                break
            page.locator("#dialogue-skip").click(timeout=3000)
            page.wait_for_timeout(150)
            print(i, json.dumps(page.evaluate(DIALOGUE_STATE), ensure_ascii=False)[:170])
        b.close()
    srv.shutdown(); t.join(timeout=4)
