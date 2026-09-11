"""Screenshot the viewer and crop the head region, for face-part inspection."""
import sys
import time

from PIL import Image
from playwright.sync_api import sync_playwright

name = sys.argv[1]
out = sys.argv[2]
preset = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "-" else None
url = f"http://localhost:8642/site/models.html#{name}"
raw = out + ".raw.png"

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1400, "height": 1500})
    page.goto(url, wait_until="load", timeout=60000)
    page.wait_for_selector("canvas", timeout=40000)
    time.sleep(12)
    if preset:
        button = page.query_selector(f"[data-face-preset='{preset}']")
        if button:
            button.click()
            time.sleep(3)
        else:
            print(f"no preset {preset!r}")
    page.evaluate("()=>document.querySelector('canvas').scrollIntoView({block:'center'})")
    time.sleep(1.5)
    page.query_selector("canvas").screenshot(path=raw)
    browser.close()

image = Image.open(raw)
w, h = image.size
# The model is framed head-up and centred; the head occupies the top third.
crop = image.crop((int(w * 0.30), int(h * 0.00), int(w * 0.70), int(h * 0.30)))
crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
crop.save(out)
print(f"canvas {w}x{h} -> face crop {crop.size[0]}x{crop.size[1]}")
