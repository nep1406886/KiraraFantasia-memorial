#!/usr/bin/env python3
"""Enumerate the DOM observables of every syncWorldFrozen input."""
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
        c = b.new_context(viewport={"width": 1280, "height": 840})
        c.add_init_script(
            "window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};"
            "localStorage.setItem('kirafan-rl:meta',"
            "JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
        pg = c.new_page()
        pg.goto(base + "/site/game/roguelike.html?seed=73061&volume=1&floor=20",
                wait_until="load", timeout=60000)
        pg.wait_for_selector(".roster-card", timeout=60000)
        pg.locator(".roster-card").filter(
            has=pg.locator('img[src$="/14002001.webp"]')).click()
        pg.wait_for_function(
            "window.kirafanRL?.world?.player && kirafanRL.pending===0",
            polling=100, timeout=60000)
        for _ in range(60):
            if not pg.locator("#dialogue-box").is_visible():
                break
            pg.locator("#dialogue-skip").click()
            pg.wait_for_timeout(60)
        pg.evaluate("""() => { const w = kirafanRL.world;
            const bossRoom = w.dungeon.rooms.find(r => r.type === "boss");
            w.enterRoom(bossRoom.id, "N"); kirafanRL.step(1/60); }""")
        for _ in range(300):
            pg.evaluate("kirafanRL.step(1/60)")
            if pg.evaluate("() => !!kirafanRL.world.enemies.find(e => e.kind === 'boss')"):
                break
            pg.wait_for_timeout(8)
        for _ in range(10):
            pg.wait_for_timeout(500)
            if not pg.evaluate("kirafanRL.roomLoading"):
                break
        out = pg.evaluate("""() => {
            const box = document.getElementById('dialogue-box');
            return { boxCls: box.className, boxVis: box.offsetParent !== null,
                     stage: document.getElementById('stage').className,
                     menu: !!document.querySelector('#menu-panel:not(.hidden)'),
                     shop: !!document.querySelector('#shop-panel:not(.hidden)'),
                     roster: !!document.querySelector('.rl-roster'),
                     codex: !!document.querySelector('.codex-overlay'),
                     achv: !!document.querySelector('.achv-overlay'),
                     howto: !!document.querySelector('.howto-overlay'),
                     decision: !!document.querySelector('.rl-decision'),
                     result: !!document.querySelector('.rl-run-result'),
                     frozen: kirafanRL.world.frozen };
        }""")
        print(json.dumps(out, ensure_ascii=False))
        b.close()
    srv.shutdown(); t.join(timeout=4)
