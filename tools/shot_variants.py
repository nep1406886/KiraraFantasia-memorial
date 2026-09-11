"""Render one face-part variant per frame and tile them into a labelled sheet."""
import sys
import time

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

model = sys.argv[1]
kind_label = sys.argv[2]
out = sys.argv[3]
BOX = (0.36, 0.02, 0.64, 0.22)

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1400, "height": 1500})
    page.goto(f"http://localhost:8642/site/models.html#{model}", wait_until="load", timeout=60000)
    page.wait_for_selector("canvas", timeout=40000)
    time.sleep(13)
    page.evaluate("()=>{const d=document.getElementById('modelFaceAdvanced'); if(d) d.open=true;}")
    selector = f"select[aria-label='{kind_label}']"
    if not page.query_selector(selector):
        print("no select for", kind_label)
        browser.close()
        raise SystemExit(1)
    options = page.eval_on_selector(selector, "s=>Array.from(s.options).map(o=>o.value)")
    page.evaluate("()=>document.querySelector('canvas').scrollIntoView({block:'center'})")
    time.sleep(1.0)
    canvas = page.query_selector("canvas")
    frames = []
    for value in options:
        if not value:
            continue
        page.select_option(selector, value)
        time.sleep(1.4)
        tmp = out + f".{value}.png"
        canvas.screenshot(path=tmp)
        image = Image.open(tmp)
        w, h = image.size
        frames.append((value, image.crop((int(w * BOX[0]), int(h * BOX[1]), int(w * BOX[2]), int(h * BOX[3])))))
    browser.close()

if not frames:
    raise SystemExit("no frames captured")
cell_w, cell_h = frames[0][1].size
scale = 2
cell_w, cell_h = cell_w * scale, cell_h * scale
cols = 5
rows = (len(frames) + cols - 1) // cols
sheet = Image.new("RGB", (cols * cell_w, rows * (cell_h + 20)), (20, 20, 20))
draw = ImageDraw.Draw(sheet)
for index, (value, frame) in enumerate(frames):
    x = (index % cols) * cell_w
    y = (index // cols) * (cell_h + 20)
    sheet.paste(frame.resize((cell_w, cell_h), Image.LANCZOS), (x, y))
    draw.text((x + 4, y + cell_h + 4), value, fill=(255, 255, 0))
sheet.save(out)
print(f"{len(frames)} variants -> {sheet.size[0]}x{sheet.size[1]}")
