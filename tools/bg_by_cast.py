#!/usr/bin/env python3
"""Which backgrounds does a given character appear against?

Identifying a background by eye means judging 617 numbered images. This asks the
data instead: the staging scripts say who is on screen and what the background
is, so "the background アルシーヴ stands in most often, outside battle" is a
query, not a guess.

Used to bind role names (library, library-outside) in tools/advbg_map.json to
real bundle ids, with evidence rather than a hunch.

Usage:
    python tools/bg_by_cast.py アルシーヴ --limit 120
    python tools/bg_by_cast.py アルシーヴ ソラ --kind story event
"""

from __future__ import annotations

import argparse

import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# No stdout wrapping here on purpose: probe_advscript already replaces sys.stdout
# with a UTF-8 wrapper at import, and wrapping the same buffer a second time
# closes the first wrapper, so every later print fails on a closed file.
from probe_advscript import backgrounds_in, commands, download, index

# Commands whose first argument is a character name. Enough to tell who is
# actually staged in a scene rather than merely mentioned.
CAST_FUNCS = ("CharaShot", "CharaIn", "CharaInFade", "CharaHighlight", "CharaFace",
              "CharaMot", "CharaEmotion", "CharaMove")


def cast_of(rows: list[dict]) -> set[str]:
    who = set()
    for row in rows:
        if row["func"] in CAST_FUNCS:
            for arg in row["args"]:
                if isinstance(arg, str) and not arg.lstrip("-").isdigit() and not arg.startswith("ef_"):
                    who.add(arg)
    return who


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("names", nargs="+", help="character names as the scripts spell them")
    parser.add_argument("--kind", nargs="*", default=["story"], help="script kinds to scan")
    parser.add_argument("--limit", type=int, default=120, help="scripts per kind")
    args = parser.parse_args()

    entries = index()
    wanted = set(args.names)

    hits: Counter[str] = Counter()
    where: dict[str, list[str]] = defaultdict(list)
    scanned = 0

    for kind in args.kind:
        names = sorted(n for n in entries
                       if n.startswith(f"adv/script/{kind}/advscript_") and "text" not in n)
        for name in names[:args.limit]:
            try:
                path = download(entries[name])
                rows = commands(path)
            except Exception:
                continue
            scanned += 1
            if not (cast_of(rows) & wanted):
                continue
            for bg in set(backgrounds_in(path)):
                hits[bg] += 1
                where[bg].append(Path(name).stem)

    print(f"scanned {scanned} scripts; {sum(hits.values())} background uses with {'/'.join(wanted)}")
    for bg, n in hits.most_common(25):
        kind = "battle" if "_btl_" in bg else "scene"
        print(f"  {bg:24s} {n:3d}  {kind:6s} e.g. {where[bg][0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
