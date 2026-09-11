#!/usr/bin/env python3
"""Build favicon.png from the game's own stamina-recovery pocket watch.

The site is a timer, so the icon should be a clock the game actually ships.
ItemList has exactly three: the スタミナ回復アイテム 小/中/大 pocket watches
(IDs 1000/1001/1002, eItemType.Stamina), drawn as bronze, silver and gold-red.

The sprite is 87x101 -- a round dial with a crown and ring above it.  We trim
the transparent margin and pad to a square, so the whole watch survives.

--dial instead crops to just the dial, which buys a bigger clock face at 16-32px.
Be aware it cuts the watch off: the dial and the ring overlap vertically (the
ring occupies rows 19-25, the dial's widest row is 59-64), so any box tight
enough to frame the dial slices the ring and leaves a cropped gold stub on top.

Usage:
    python tools/build_favicon.py                 # whole gold-red watch, 64px
    python tools/build_favicon.py --item 1001     # silver instead
    python tools/build_favicon.py --dial          # bigger face, clips the ring
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

# The item names are Japanese; the Windows console codepage would mangle them.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parent))

import UnityPy  # noqa: E402
from PIL import Image  # noqa: E402

from build_model_catalog import asset_url, download, load_asset_index  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "itemicon"
OUTPUT = ROOT / "favicon.png"

# eItemType.Stamina items, from ItemList in database/database.muast.
STAMINA_ITEMS = {
    1000: "スタミナ回復アイテム 小 (bronze)",
    1001: "スタミナ回復アイテム 中 (silver)",
    1002: "スタミナ回復アイテム 大 (gold-red)",
}
ALPHA_FLOOR = 24


def load_item_sprite(item_id: int, index_file: Path | None) -> Image.Image:
    """Download texture/itemicon/itemicon_<id>.muast and return its Sprite."""
    name = f"texture/itemicon/itemicon_{item_id}.muast"
    entries = (
        json.loads(index_file.read_text(encoding="utf-8"))
        if index_file
        else load_asset_index()
    )
    entry = next((e for e in entries if e["name"] == name), None)
    if entry is None:
        raise SystemExit(f"{name} is not in the asset index")

    CACHE.mkdir(parents=True, exist_ok=True)
    bundle = download(asset_url(entry), CACHE / f"itemicon_{item_id}.muast")

    # Prefer the Sprite: it is already trimmed to the art, while the Texture2D
    # is the padded 128x128 atlas page.
    best: Image.Image | None = None
    for obj in UnityPy.load(str(bundle)).objects:
        if obj.type.name not in ("Sprite", "Texture2D"):
            continue
        image = obj.read().image
        if image is None:
            continue
        if obj.type.name == "Sprite":
            return image.convert("RGBA")
        best = image.convert("RGBA")
    if best is None:
        raise SystemExit(f"no texture inside {name}")
    return best


def dial_square(img: Image.Image) -> Image.Image:
    """Square crop around the watch dial.  Clips the ring -- see module docstring."""
    alpha = img.getchannel("A")
    pixels = alpha.load()
    width, height = img.size

    rows: list[tuple[int, int] | None] = []
    for y in range(height):
        row = [x for x in range(width) if pixels[x, y] > ALPHA_FLOOR]
        rows.append((row[0], row[-1]) if row else None)

    spans = [r for r in rows if r]
    if not spans:
        raise SystemExit("sprite is fully transparent")

    # The dial is widest across several rows (59-64 for item 1002); its
    # centreline is the middle of that run, not the first row of it.
    widest = max(r[1] - r[0] for r in spans)
    at_widest = [y for y, r in enumerate(rows) if r and (r[1] - r[0]) == widest]
    centre_y = (at_widest[0] + at_widest[-1]) // 2
    left, right = rows[centre_y]  # type: ignore[misc]

    diameter = right - left + 1
    centre_x = (left + right) // 2
    box = (
        centre_x - diameter // 2,
        centre_y - diameter // 2,
        centre_x - diameter // 2 + diameter,
        centre_y - diameter // 2 + diameter,
    )
    dial = Image.new("RGBA", (diameter, diameter), (0, 0, 0, 0))
    dial.paste(img.crop(box), (0, 0))
    return dial


def whole_square(img: Image.Image, margin: float = 0.04) -> Image.Image:
    """Trim the transparent margin, then pad to a centred square.

    The art is taller than it is wide (83x97), so squaring it leaves the watch
    flush against the top and bottom rows.  Nothing is lost, but touching the
    edge reads as cropped, so `margin` keeps a little breathing room around it.
    """
    trimmed = img.crop(img.getchannel("A").getbbox())
    side = round(max(trimmed.size) * (1 + 2 * margin))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(trimmed, ((side - trimmed.width) // 2, (side - trimmed.height) // 2))
    return canvas


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--item", type=int, default=1002, choices=sorted(STAMINA_ITEMS),
        help="which stamina pocket watch to use (default: 1002, gold-red)",
    )
    parser.add_argument("--size", type=int, default=64, help="output edge in px")
    parser.add_argument(
        "--dial", action="store_true",
        help="crop to the dial for a bigger face; clips the ring off the top",
    )
    parser.add_argument(
        "--margin", type=float, default=0.04,
        help="transparent breathing room around the watch, as a fraction of its"
             " longest edge (default: 0.04; ignored with --dial)",
    )
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument(
        "--index-file", type=Path,
        help="use a previously downloaded assetBundle.json instead of fetching it",
    )
    args = parser.parse_args()

    sprite = load_item_sprite(args.item, args.index_file)
    squared = dial_square(sprite) if args.dial else whole_square(sprite, args.margin)
    icon = squared.resize((args.size, args.size), Image.LANCZOS)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    icon.save(args.output, optimize=True)

    print(f"{STAMINA_ITEMS[args.item]}: {sprite.size} -> {squared.size} -> {icon.size}")
    written = args.output.resolve()
    try:
        shown: Path | str = written.relative_to(ROOT)
    except ValueError:
        shown = written
    print(f"wrote {shown} ({written.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
