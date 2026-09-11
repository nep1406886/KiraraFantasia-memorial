"""Render several models into one labelled contact sheet, reusing one browser."""
import sys
import time

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

out = sys.argv[1]
folder = sys.argv[2]
names = sys.argv[3:]
CELL = 300

frames = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 900, "height": 900})
    for name in names:
        # Only the hash differs between models, and a hash-only goto does not
        # reload, so the viewer would keep showing the previous model.
        page.goto("about:blank")
        page.goto(
            f"http://localhost:8642/site/models.html#model/{folder}/{name}.muast",
            wait_until="load",
            timeout=60000,
        )
        try:
            page.wait_for_selector("canvas", timeout=40000)
            time.sleep(9)
            page.evaluate("()=>document.querySelector('canvas').scrollIntoView({block:'center'})")
            time.sleep(0.8)
            raw = f"{out}.{name}.png"
            page.query_selector("canvas").screenshot(path=raw)
            frames.append((name, Image.open(raw).convert("RGB").resize((CELL, CELL), Image.LANCZOS)))
            print("ok", name)
        except Exception as error:  # noqa: BLE001 - keep rendering the rest
            print("FAIL", name, error)
    browser.close()

if not frames:
    raise SystemExit("nothing rendered")
cols = 6
rows = (len(frames) + cols - 1) // cols
sheet = Image.new("RGB", (cols * CELL, rows * (CELL + 18)), (18, 18, 18))
draw = ImageDraw.Draw(sheet)
for index, (name, frame) in enumerate(frames):
    x = (index % cols) * CELL
    y = (index // cols) * (CELL + 18)
    sheet.paste(frame, (x, y))
    draw.text((x + 4, y + CELL + 3), name, fill=(255, 255, 0))
sheet.save(out)
print(f"{len(frames)} models -> {sheet.size[0]}x{sheet.size[1]}")
