"""Assert each model's visible face layers match the expression it claims to show.

The earlier version of this asserted exactly one eye, one brow and one mouth with
no overlays lit.  That is not what the game authored: `eye_A` and `eye_A_2` are the
two halves of one eye, and plenty of states legitimately light `cheek` or `cry`.
Those assertions failed on correct models and would have passed a model stuck on
its export defaults, which is the failure actually worth catching.

So compare against the authored table instead.  Where a character has one, the
visible set must equal the layers its current state lists, less anything in the
table's `hide` list.  Where a character has none, fall back to the weaker
structural claim the facePart classifier can still support: at most one eye
variant group, one brow and one mouth, and no overlay lit by default.

Usage:
  python tools/check_faces.py model_pl_150200 model_en_2600 ...
  python tools/check_faces.py --from .codex-tmp/stale.txt --limit 40
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

# Report the layer names the head is actually showing, plus the state the facial
# table believes it is in, so a mismatch can be attributed to one or the other.
PROBE = """() => {
  const root = window.__modelDebug;
  if (!root) return {error: 'no model root'};
  const parts = {eye: [], eyebrow: [], mouth: [], overlay: []};
  const totals = {};
  const visibleLayers = [];
  root.traverse(node => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    const name = node.name || '';
    const part = node.userData && node.userData.facePart;
    if (part) {
      totals[part.kind] = (totals[part.kind] || 0) + 1;
      if (node.visible) parts[part.kind].push(part.name);
    }
    if (/^l30_/i.test(name) && node.visible) visibleLayers.push(name.slice(4));
  });
  const facial = window.__facialDebug ? window.__facialDebug() : null;
  let state = null, layers = null, hide = null, stateIndex = -1;
  if (facial && facial.table) {
    stateIndex = facial.stateIndex;
    layers = facial.table.layers || [];
    hide = facial.table.hide || [];
    const row = facial.table.states && facial.table.states[stateIndex];
    if (row) state = row.map(i => layers[i]).filter(Boolean);
  }
  return {parts, totals, visibleLayers, state, layers, hide, stateIndex,
          hasTable: !!(facial && facial.table)};
}"""


def folder_for(name: str) -> str:
    if name.startswith("model_en_"):
        return "enemy"
    if name.startswith("wpn_"):
        return "weapon"
    return "player"


def group_of(variant: str) -> str:
    """Collapse mirrored halves so eye_A and eye_A_2 count as one eye.

    Suffixes seen in the data are `_2`, `_3` and a bare trailing digit, so strip
    a single trailing index and treat what is left as the variant identity.
    """
    return re.sub(r"_?\d+$", "", variant)


def check(result: dict) -> list[str]:
    problems: list[str] = []
    if result.get("hasTable") and result.get("state") is not None:
        # Authoritative path: the visible L30 layers the table controls must be
        # exactly the state's list.  Layers the table never mentions are head
        # base (hair, face, backhead) and are excluded from the comparison.
        controlled = set(result["layers"] or [])
        hidden = set(result["hide"] or [])
        expected = set(result["state"]) - hidden
        actual = {layer for layer in result["visibleLayers"] if layer in controlled}
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        if missing:
            problems.append("missing=" + ",".join(missing))
        if extra:
            problems.append("extra=" + ",".join(extra))
        if result["stateIndex"] < 0:
            problems.append("no state applied")
        return problems

    # Fallback path for characters with no authored table.
    parts = result["parts"]
    totals = result["totals"]
    for kind in ("eye", "eyebrow", "mouth"):
        if not totals.get(kind):
            continue
        groups = {group_of(v) for v in parts[kind]}
        if len(groups) != 1:
            problems.append(f"{kind}={len(groups)} groups of {totals[kind]} "
                            f"({','.join(sorted(parts[kind])[:4])})")
    if parts["overlay"]:
        problems.append("overlay=" + ",".join(sorted(parts["overlay"])))
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*")
    parser.add_argument("--from", dest="from_file", type=Path,
                        help="read model names from this file, one per line")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--settle", type=float, default=9.0,
                        help="seconds to let the facial table load and apply")
    parser.add_argument("--port", type=int, default=8642)
    args = parser.parse_args()

    names = list(args.names)
    if args.from_file:
        names += [Path(line.strip()).stem
                  for line in args.from_file.read_text(encoding="utf-8").splitlines()
                  if line.strip() and not line.startswith("#")]
    if not names:
        manifest = json.loads((ROOT / "asset" / "models" / "manifest.json")
                              .read_text(encoding="utf-8"))
        names = [Path(key).stem for key, preview in manifest["models"].items()
                 if preview.get("expressions")]
    if args.limit:
        names = names[:args.limit]

    failures = 0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            args=["--enable-unsafe-swiftshader", "--use-gl=swiftshader"])
        for index, name in enumerate(names, 1):
            page = browser.new_page(viewport={"width": 1100, "height": 900})
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            url = (f"http://localhost:{args.port}/site/models.html?debug=1"
                   f"#model/{folder_for(name)}/{name}.muast")
            try:
                page.goto(url, wait_until="load", timeout=60000)
                page.wait_for_selector("canvas", timeout=40000)
                page.wait_for_function("() => !!window.__modelDebug", timeout=40000)
                time.sleep(args.settle)
                result = page.evaluate(PROBE)
            except Exception as error:  # noqa: BLE001 - report and keep going
                result = {"error": f"{type(error).__name__}: {error}"}
            page.close()

            if "error" in result:
                print(f"[{index}/{len(names)}] FAIL {name}: {result['error']}")
                failures += 1
                continue
            problems = check(result)
            if errors:
                problems.append("pageerror=" + errors[0][:70])
            if problems:
                failures += 1
                print(f"[{index}/{len(names)}] FAIL {name:<18} "
                      f"{'; '.join(problems)}")
            else:
                shown = ",".join(sorted(
                    result["parts"]["eye"] + result["parts"]["eyebrow"]
                    + result["parts"]["mouth"] + result["parts"]["overlay"]))
                source = "table" if result.get("hasTable") else "fallback"
                print(f"[{index}/{len(names)}] ok   {name:<18} [{source}] {shown}")
        browser.close()
    print(f"\n{len(names) - failures}/{len(names)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
