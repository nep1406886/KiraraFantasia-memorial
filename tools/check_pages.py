#!/usr/bin/env python3
"""Load every screen in a real browser and fail on runtime errors.

tools/check_js_syntax.sh parses the .js modules, which catches nothing that only
shows up when the code runs and nothing at all in inline <script> blocks -- game.html
is entirely inline.  This loads each page, waits for it to settle, and reports
pageerrors, failed requests, and console errors.

A page that renders 3D also gets a "did anything draw" check, because a screen can
load without a single error and still be blank.

Usage:
    python tools/check_pages.py --port 8644
    python tools/check_pages.py --port 8644 --page game/rpg.html
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

# settle: extra wait in ms for screens that stream models before they are usable.
# game/town.html と game/adv.html は棚から降りた (game.html の註)。頁が無いのに
# 一覧に残しておくと、この gate が「開けない」で毎回落ちる。
#
# game/laby.html (F) を敢えて入れていない。開くし動くが、asset/lb/art.json が
# 404 する -- core/lbstage.js:377 が「絵。無くても遊べる」と書いている通りの
# 任意の資源で、欠けていても頁は成立する。ここに入れると此の gate が他人の
# 設計上の 404 で赤くなり、逃がすには IGNORE に "404" を足す事になる。それは
# 全頁の本物の 404 を見えなくする取引で、値段が高すぎる。F の頁の関門は
# plans/labyrinth.md §6.4 ⑦ が check_lb_a11y / check_lb_play に割り当てている。
# art.json が生えたら、ここに ("game/laby.html", 8000) を足すのが正しい。
# game/actor.html・actor.js・game/uniqueskill.html・uniqueskill.js 四件已在
# 2026-09-05 应用户要求删除 -- 旧工程的诊断页，没有别的页面引用；真正被
# game/rl 与 site/models.html 使用的是 core/actor.js 与 core/uniqueskill.js。
# 给 AI 的话：若有什么不兼容，自己重新手搓，别想着用回这四个文件。
PAGES = [
    ("game.html", 2500),
    ("game/rpg.html", 6000),
    ("game/mv.html", 8000),
    ("site/models.html", 8000),
]

# Noise that is expected and not a defect: audio cannot start before a gesture, and
# the SE manifest is deliberately probed and allowed to 404.
IGNORE = (
    "play() failed",
    "NotAllowedError",
    "The AudioContext was not allowed to start",
    "audio/se/",
    "favicon",
)


def interesting(text: str) -> bool:
    if any(token in text for token in IGNORE):
        return False
    # Streamed GLB reads get logged as ERR_ABORTED on a few fetches per page load, a
    # different few each run, while every byte in fact arrives -- see the note in
    # core/loader.js readModel(). Failing on it made three healthy pages red, which
    # is worse than useless: a checker that is always red hides the one real problem.
    # Kept deliberately narrow, so a genuine abort on anything else still fails.
    if "ERR_ABORTED" in text and ".glb.gz" in text:
        return False
    return True


def check(browser, port, path, settle):
    page = browser.new_page(viewport={"width": 1100, "height": 800})
    problems = []
    # Closing the page cancels whatever is still in flight, and those cancellations
    # arrive as requestfailed/ERR_ABORTED. Counting them blamed adv.html for three
    # model fetches that this checker itself aborted -- it streams actors past the
    # settle window, so it is the one page that always has requests open. Stop
    # recording once teardown begins.
    live = {"recording": True}

    def note(text):
        if live["recording"]:
            problems.append(text)

    page.on("pageerror", lambda e: note(f"pageerror: {e}"))
    page.on("console", lambda m: (
        note(f"console.{m.type}: {m.text}") if m.type == "error" else None))
    page.on("requestfailed", lambda r: note(
        f"requestfailed: {r.url.split('/')[-1]} {r.failure}"))
    drawn = None
    try:
        page.goto(f"http://localhost:{port}/{path}", wait_until="load", timeout=60000)
        page.wait_for_timeout(settle)
        drawn = page.evaluate("""() => {
          const c = document.querySelector("canvas");
          if (!c || !c.width) { return null; }
          const pad = document.createElement("canvas");
          pad.width = c.width; pad.height = c.height;
          const ctx = pad.getContext("2d", {willReadFrequently: true});
          try { ctx.drawImage(c, 0, 0); } catch (e) { return null; }
          const d = ctx.getImageData(0, 0, pad.width, pad.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 0) { n += 1; } }
          return n;
        }""")
    except Exception as exc:                                        # noqa: BLE001
        problems.append(f"load failed: {type(exc).__name__}: {exc}")
    finally:
        live["recording"] = False
        page.close()

    real = [p for p in problems if interesting(p)]
    status = "ok  " if not real else "FAIL"
    note = ""
    if drawn is not None:
        # A cross-task canvas read is unreliable without preserveDrawingBuffer, so a
        # zero here is not evidence of a blank screen -- only a non-zero is evidence
        # of a live one.
        note = f"  canvas drew {drawn} px" if drawn else "  canvas read empty (inconclusive)"
    print(f"  {status}  {path:<26}{len(real)} problem(s){note}")
    for p in real[:6]:
        print(f"          {p[:150]}")
    return not real


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8644)
    ap.add_argument("--page", action="append")
    args = ap.parse_args()

    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    todo = [(p, s) for p, s in PAGES if not args.page or p in args.page]
    if args.page:
        known = {p for p, _ in PAGES}
        todo += [(p, 6000) for p in args.page if p not in known]

    failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
        ])
        for path, settle in todo:
            if not check(browser, args.port, path, settle):
                failed += 1
        browser.close()

    print(f"\n{len(todo)} page(s) checked, {failed} with problems")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
