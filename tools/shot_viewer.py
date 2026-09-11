"""Screenshot the real model viewer for a manifest model name."""
import sys
import time

from playwright.sync_api import sync_playwright

name = sys.argv[1]
out = sys.argv[2]
wait = float(sys.argv[3]) if len(sys.argv) > 3 else 12.0
url = f"http://localhost:8642/site/models.html#{name}"

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 900, "height": 1000})
    msgs = []
    page.on("console", lambda m: msgs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: msgs.append(f"PAGEERR: {e}"))
    page.goto(url, wait_until="load", timeout=60000)
    try:
        page.wait_for_selector("canvas", timeout=30000)
    except Exception:
        print("no canvas appeared")
    time.sleep(wait)
    preset = sys.argv[4] if len(sys.argv) > 4 else None
    if preset:
        button = page.query_selector(f"[data-face-preset='{preset}']")
        if not button:
            print(f"no preset button {preset!r}")
        else:
            button.scroll_into_view_if_needed()
            button.click()
            time.sleep(3.0)
    canvas = page.query_selector("canvas")
    if canvas:
        page.evaluate("()=>document.querySelector('canvas').scrollIntoView({block:'center'})")
        time.sleep(2.0)
        canvas.screenshot(path=out)
    else:
        page.screenshot(path=out)
    print("canvases:", page.evaluate("()=>document.querySelectorAll('canvas').length"))
    err = page.evaluate("()=>{const e=document.querySelector('.model-3d-error');return e?e.textContent:''}")
    if err:
        print("VIEWER ERROR:", err)
    for m in msgs[:10]:
        print("LOG", m)
    browser.close()
