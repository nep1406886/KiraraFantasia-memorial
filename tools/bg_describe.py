#!/usr/bin/env python3
"""Describe ADV backgrounds numerically, to shortlist a scene without eyes.

Cast evidence narrows 617 backgrounds to a handful (see tools/bg_by_cast.py);
this separates the handful. A 図書館 interior and an overexposed sky differ in
ways that measure cleanly: mean brightness, warm-vs-cool balance, how much of
the frame is near-white, and how much vertical structure there is (shelves and
pillars give strong vertical edges; sky gives almost none).

Not a classifier -- a shortlisting aid whose numbers are printed so the call can
be made and recorded in tools/advbg_map.json.

Usage:
    python tools/bg_describe.py bg_adv_com_01_16 bg_adv_com_01_08
    python tools/bg_describe.py --group com --limit 40
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from convert_advbg import bg_entries, biggest_texture, download, load_asset_index


def describe(image) -> dict:
    import numpy as np

    small = image.convert("RGB").resize((160, 90))
    a = np.asarray(small, dtype=float)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    luma = 0.299 * r + 0.587 * g + 0.114 * b

    # Vertical structure: shelves, pillars and window frames produce strong
    # column-to-column change; a sky or a soft gradient produces almost none.
    columns = luma.mean(axis=0)
    vertical = float(abs(np.diff(columns)).mean())

    return {
        "bright": float(luma.mean()),
        "warm": float((r - b).mean()),
        "nearWhite": float((luma > 235).mean()),
        "dark": float((luma < 70).mean()),
        "vertical": vertical,
        "sat": float((a.max(axis=2) - a.min(axis=2)).mean()),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stems", nargs="*", help="bundle stems, e.g. bg_adv_com_01_16")
    parser.add_argument("--group", help="describe a whole group instead")
    parser.add_argument("--limit", type=int, default=40)
    args = parser.parse_args()

    available = bg_entries(load_asset_index())
    if args.group:
        stems = sorted(s for s in available if f"_{args.group}_" in s)[:args.limit]
    else:
        stems = args.stems
    if not stems:
        parser.error("name some stems or pass --group")

    print(f"{'bundle':24s} {'bright':>7s} {'warm':>6s} {'white%':>7s} {'dark%':>6s} {'vert':>6s} {'sat':>6s}")
    rows = []
    for stem in stems:
        if stem not in available:
            print(f"  ! {stem}: not in the index")
            continue
        try:
            image = biggest_texture(download(available[stem]))
        except Exception as error:
            print(f"  ! {stem}: {error}")
            continue
        if image is None:
            continue
        d = describe(image)
        rows.append((stem, d))
        print(f"{stem:24s} {d['bright']:7.1f} {d['warm']:6.1f} {d['nearWhite'] * 100:6.1f}%"
              f" {d['dark'] * 100:5.1f}% {d['vertical']:6.2f} {d['sat']:6.1f}")

    if len(rows) > 1:
        # The two shapes the prologue needs, called out explicitly.
        interior = max(rows, key=lambda r: r[1]["vertical"] + r[1]["warm"] / 4 - r[1]["nearWhite"] * 40)
        blown = max(rows, key=lambda r: r[1]["nearWhite"] + r[1]["bright"] / 400)
        print(f"\nmost interior-like : {interior[0]}")
        print(f"most blown-out sky : {blown[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
