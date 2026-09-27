#!/usr/bin/env python3
"""Reproduce the touch-variant dialogue stall from the boss gate."""
import functools
import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import NoCacheHandler, Server
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

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
        page.goto(base + "/site/game/roguelike.html?seed=73061&volume=4&floor=20",
                  wait_until="load", timeout=60000)
        page.wait_for_selector(".roster-card", timeout=60000)
        card = page.locator(".roster-card").filter(has=page.locator('img[src$="/14002001.webp"]'))
        card.tap()
        page.wait_for_function(
            "window.kirafanRL?.world?.player && kirafanRL.pending===0",
            polling=100, timeout=60000)
        ok = True
        for i in range(60):
            if not page.locator("#dialogue-box").is_visible():
                print("closed after", i, "rounds")
                ok = False if i >= 59 else True
                break
            try:
                page.locator("#dialogue-skip").tap(timeout=2000)
            except Exception as e:
                print("tap fail", i, str(e)[:90])
            page.wait_for_timeout(30)
        if ok and i >= 59:
            print("STALL")
            print(json.dumps(page.evaluate(
                "()=>({cls:document.getElementById('dialogue-box').className,"
                " vis:document.getElementById('dialogue-box').style.visibility,"
                " txt:(document.getElementById('dialogue-box').textContent||'').slice(0,50)})"),
                ensure_ascii=False))
        b.close()
    srv.shutdown(); t.join(timeout=4)
