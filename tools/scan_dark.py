"""Batch-measure how dark each model's texture sampling is, in-browser.

Renders diag_forcemat.html?mode=uvstats for a list of models and scrapes the
area-weighted mean colour / dark-area percentage it prints.
"""
import json
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://localhost:8642"
PATTERN = re.compile(r"ALL-MESH mean RGB=\[([\d,]+)\] darkArea=([\d.]+)% meshes=(\d+)")


def targets(prefix: str, limit: int) -> list[tuple[str, str]]:
    manifest = json.loads((ROOT / "asset" / "models" / "manifest.json").read_text("utf-8"))
    out = []
    for key, entry in manifest["models"].items():
        file = entry["file"].split("?")[0]
        if Path(file).parent.name.startswith(prefix):
            out.append((Path(file).parent.name, "/" + file))
    out.sort()
    return out[:limit]


def main() -> None:
    prefix = sys.argv[1] if len(sys.argv) > 1 else "wpn_"
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    items = targets(prefix, limit)
    print(f"scanning {len(items)} models with prefix {prefix!r}")
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 400, "height": 400})
        for name, path in items:
            url = f"{BASE}/diag_forcemat.html?model={path}&mode=uvstats"
            try:
                page.goto(url, wait_until="load", timeout=45000)
                page.wait_for_function("() => document.title === 'DONE' || document.title === 'FAIL'", timeout=45000)
                text = page.evaluate("()=>{const e=document.getElementById('out');return e?e.textContent:''}")
            except Exception as exc:  # noqa: BLE001
                print(f"{name:<16} ERROR {type(exc).__name__}")
                continue
            match = PATTERN.search(text or "")
            if not match:
                print(f"{name:<16} no-stats title={page.title()!r}")
                continue
            rgba = match.group(1)
            dark = float(match.group(2))
            flag = "  <== BLACK" if dark > 40 else ""
            print(f"{name:<20} rgb=[{rgba}] dark={dark:5.1f}% meshes={match.group(3)}{flag}")
        browser.close()


if __name__ == "__main__":
    main()
