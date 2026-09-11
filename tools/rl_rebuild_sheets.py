# Rebuild the sweep contact sheets from the PNGs + results JSONs already on
# disk — no browser, no server. Exists because the original sheet builders
# pasted one M|F pair per row (gi = pair index) onto a 4-row canvas, which
# silently clipped pairs 5-8 of every sheet: only half the models were ever
# reviewable. The fixed grid runs cells left-to-right, top-to-bottom.
# Usage: python tools/rl_rebuild_sheets.py [players|enemies]
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "sweep"

CELL_H = 340
LABEL_H = 22
COLS, ROWS = 4, 4
PER_SHEET = COLS * ROWS // 2  # 8 M|F pairs


def build(results, prefix, keep_glob):
    cells = []
    for r in results:
        if r.get("flags"):
            continue
        pair = []
        for st in ("M", "F"):
            p = OUT / ("%s__%s.png" % (r["label"], st))
            if p.exists():
                pair.append((p, "%s %s" % (r["label"], st)))
        if len(pair) == 2:
            cells.append(pair)
    # Stale sheets first: a shrink must never leave orphans to mis-review.
    # keep_glob is narrower than the save prefix so the enemy pass cannot
    # unlink the players' sheet_pl_* files.
    for old in OUT.glob(keep_glob):
        old.unlink()
    sheets = [cells[i:i + PER_SHEET] for i in range(0, len(cells), PER_SHEET)]
    index = []
    for si, group in enumerate(sheets):
        from PIL import Image, ImageDraw
        imgs = []
        for pair in group:
            row = []
            for p, cap in pair:
                im = Image.open(p)
                w = int(im.width * CELL_H / im.height)
                row.append((im.resize((w, CELL_H)), cap))
            imgs.append(row)
        cw = max(max(im.width for im, _ in row) for row in imgs) + 8
        sheet = Image.new("RGB", (cw * COLS, (CELL_H + LABEL_H + 6) * ROWS),
                          "white")
        dr = ImageDraw.Draw(sheet)
        for idx, row in enumerate(imgs):
            for off, (im, cap) in enumerate(row):
                gi, ci = divmod(idx * 2 + off, COLS)
                x = ci * cw
                y = gi * (CELL_H + LABEL_H + 6)
                dr.text((x + 4, y + 4), cap, fill="black")
                sheet.paste(im, (x + 4, y + LABEL_H))
                index.append({"sheet": si, "cell": "%d,%d" % (gi, ci),
                              "caption": cap})
        sheet.save(OUT / ("%s%02d.png" % (prefix, si)))
    return len(sheets), index


def main() -> int:
    from PIL import Image, ImageDraw  # noqa: F401  fail fast, before unlink
    which = sys.argv[1] if len(sys.argv) > 1 else "both"
    if which in ("players", "both"):
        results = json.load(
            open(OUT / "players_results.json", encoding="utf-8"))
        n, _ = build(results, "sheet_pl_", "sheet_pl_[0-9][0-9].png")
        ok = sum(1 for r in results if not r.get("flags"))
        print("players: %d ok -> %d sheets (sheet_pl_*.png)" % (ok, n))
    if which in ("enemies", "both"):
        results = json.load(
            open(OUT / "sweep_results.json", encoding="utf-8"))
        # The first sweep's pl_* records are the invalid bind-pose renders;
        # players live in sheet_pl_* from the real-pipeline sweep instead.
        results = [r for r in results
                   if not str(r.get("label", "")).startswith("pl_")]
        n, index = build(results, "sheet_", "sheet_[0-9][0-9].png")
        with open(OUT / "sheet_index.json", "w", encoding="utf-8") as f:
            json.dump(index, f, ensure_ascii=False, indent=1)
        ok = sum(1 for r in results if not r.get("flags"))
        print("enemies: %d ok -> %d sheets (sheet_*.png + sheet_index.json)"
              % (ok, n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
