import sys, time
from playwright.sync_api import sync_playwright

url = sys.argv[1]
out = sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': 780, 'height': 980})
    msgs = []
    pg.on('console', lambda m: msgs.append(f"{m.type}: {m.text}"))
    pg.on('pageerror', lambda e: msgs.append(f"PAGEERR: {e}"))
    pg.on('requestfailed', lambda r: msgs.append(f"REQFAIL: {r.url} {r.failure}"))
    pg.goto(url, wait_until='load', timeout=60000)
    t0 = time.time()
    title = ''
    while time.time() - t0 < 30:
        title = pg.title()
        if title in ('RENDERED', 'FAIL', 'DONE'):
            break
        time.sleep(0.3)
    time.sleep(1.0)
    pg.screenshot(path=out)
    out_text = pg.evaluate("()=>{const e=document.getElementById('out');return e?e.textContent:'';}")
    print(f"title={title!r}")
    if out_text.strip():
        print("OUT>>>")
        print(out_text)
    for m in msgs[:20]:
        print("LOG " + m)
    b.close()
