"""Screenshot the viewer canvas and save a cropped region (fractional box)."""
import sys
import time

from PIL import Image
from playwright.sync_api import sync_playwright

name = sys.argv[1]
out = sys.argv[2]
box = [float(v) for v in sys.argv[3].split(",")] if len(sys.argv) > 3 else [0, 0, 1, 1]
preset = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "-" else None
raw = out + ".raw.png"

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1400, "height": 1500})
    page.goto(f"http://localhost:8642/site/models.html#{name}", wait_until="load", timeout=60000)
    page.wait_for_selector("canvas", timeout=40000)
    time.sleep(12)
    if preset:
        selector = (f"[data-model-action='{preset[7:]}']" if preset.startswith("action:")
                    else f"[data-face-preset='{preset}']")
        button = page.query_selector(selector)
        if button:
            button.scroll_into_view_if_needed()
            button.click()
            time.sleep(3)
        else:
            print(f"no button for {preset!r}")
    page.evaluate("()=>document.querySelector('canvas').scrollIntoView({block:'center'})")
    time.sleep(1.5)
    page.query_selector("canvas").screenshot(path=raw)
    browser.close()

image = Image.open(raw)
w, h = image.size
crop = image.crop((int(w * box[0]), int(h * box[1]), int(w * box[2]), int(h * box[3])))
scale = max(1, int(1100 / max(crop.width, 1)))
crop = crop.resize((crop.width * scale, crop.height * scale), Image.LANCZOS)
crop.save(out)
print(f"canvas {w}x{h} -> {crop.size[0]}x{crop.size[1]}")
