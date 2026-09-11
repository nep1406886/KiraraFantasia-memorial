"""Render one model across several actions into a labelled sheet."""
import sys
import time

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

model = sys.argv[1]
out = sys.argv[2]
weapon_mode = sys.argv[3] if len(sys.argv) > 3 else None
CELL = 340

frames = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--enable-unsafe-swiftshader"])
    page = browser.new_page(viewport={"width": 1000, "height": 1000})
    page.goto(f"http://localhost:8642/site/models.html#{model}", wait_until="load", timeout=60000)
    page.wait_for_selector("canvas", timeout=40000)
    time.sleep(15)
    if weapon_mode:
        button = page.query_selector(f"[data-weapon-mode='{weapon_mode}']")
        if button:
            button.scroll_into_view_if_needed()
            button.click()
            time.sleep(4)
        else:
            print(f"no weapon mode {weapon_mode!r}")
    actions = page.evaluate(
        "()=>Array.from(document.querySelectorAll('[data-model-action]')).map(b=>b.dataset.modelAction)"
    )
    print("actions:", actions)
    canvas = page.query_selector("canvas")
    for action in actions:
        button = page.query_selector(f"[data-model-action='{action}']")
        if not button:
            continue
        button.scroll_into_view_if_needed()
        button.click()
        time.sleep(2.2)
        raw = f"{out}.{action}.png"
        canvas.screenshot(path=raw)
        frames.append((action, Image.open(raw).convert("RGB").resize((CELL, CELL), Image.LANCZOS)))
    browser.close()

cols = 5
rows = (len(frames) + cols - 1) // cols
sheet = Image.new("RGB", (cols * CELL, rows * (CELL + 18)), (18, 18, 18))
draw = ImageDraw.Draw(sheet)
for index, (action, frame) in enumerate(frames):
    x = (index % cols) * CELL
    y = (index // cols) * (CELL + 18)
    sheet.paste(frame, (x, y))
    draw.text((x + 4, y + CELL + 3), action, fill=(255, 255, 0))
sheet.save(out)
print(f"{len(frames)} actions -> {sheet.size[0]}x{sheet.size[1]}")
