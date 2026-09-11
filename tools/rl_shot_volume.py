#!/usr/bin/env python3
"""Screenshot driver for roguelike.html volumes (pixel-statistics verification).

    python tools/rl_shot_volume.py PORT VOLUME OUT.png

Waits for the room to build through the window.kirafanRL handle (a hidden
pane never runs rAF, so the loop is driven through step()), then renders one
frame and saves the canvas. Verification downstream is PIL statistics, not
eyes: distinct-colour count in the midband plus the centre average against
the volume's fog tint.
"""

from __future__ import annotations

import sys
import time

from playwright.sync_api import sync_playwright

BOOT_TIMEOUT = 120.0


def wait_for(page, expr, timeout, label):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate(expr):
            return
        page.evaluate("window.kirafanRL && window.kirafanRL.step(1/60)")
        page.wait_for_timeout(50)
    raise TimeoutError("timed out waiting for " + label)


def main() -> int:
    port, volume, out = sys.argv[1], sys.argv[2], sys.argv[3]
    url = f"http://127.0.0.1:{port}/site/game/roguelike.html?volume={volume}"
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url, wait_until="load", timeout=60000)
        wait_for(page, "!!(window.kirafanRL && window.kirafanRL.mapview"
                       " && window.kirafanRL.mapview.group)", BOOT_TIMEOUT,
                 "room build")
        # textures land async: wait until every kit mesh has its map
        wait_for(page, """(() => {
            const g = window.kirafanRL.mapview.group;
            let meshes = 0;
            g.traverse(c => { if (c.isMesh) meshes++; });
            return meshes > 0 && Array.from(g.children).every(
                c => !c.isMesh || (c.material && c.material.map));
        })()""", BOOT_TIMEOUT, "textures")
        for _ in range(30):
            page.evaluate("window.kirafanRL.step(1/60)")
        page.screenshot(path=out)
        if errors:
            print("PAGEERRORS:", errors[:5])
        browser.close()
    print("wrote " + out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
