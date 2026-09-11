#!/usr/bin/env python3
"""Convert ADV backgrounds to WebP for the fan game.

`adv/background` holds 617 bundles, each a single large texture. The game names
them by number -- bg_adv_ev_0320, bg_adv_com_02_03, bg_adv_kir_21_01 -- with no
indication of what is in them, so this tool does two jobs:

  fetch/convert   pull a bundle, pull the texture out, write WebP
  contact sheet   convert a batch to thumbnails so a scene can be *found*

The scripts refer to backgrounds by role ("library", "library-outside"), not by
bundle id, because a script should not have to know that the 図書館 interior is
bg_adv_com_02_03. The mapping lives in BACKGROUNDS below, and each entry records
why that bundle is the right one -- otherwise the next person has to re-identify
617 images.

Usage:
    python tools/convert_advbg.py --list
    python tools/convert_advbg.py library library-outside
    python tools/convert_advbg.py --all
    python tools/convert_advbg.py --sheet ev 0 60      # find a scene by eye
"""

from __future__ import annotations

import argparse
import gzip
import http.client
import io
import json
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "advbg"
OUT_ROOT = ROOT / "asset" / "story" / "background"
INDEX_PATH = ROOT / "asset" / "story" / "background-index.json"
SHEET_ROOT = ROOT / ".cache" / "advbg-sheets"

DATABASE_URL = "https://database.kirafan.cn/assetBundle.json"
LOCAL_INDEX = ROOT / ".codex-tmp" / "assetBundle.json"
HTTP_HEADERS = {"User-Agent": "kirafan-timer-advbg/1.0"}

# ADV backgrounds are drawn at 1136x640 (the game's 16:9 canvas). Kept at source
# width: unlike a standpic, a background fills the frame, so downscaling shows.
# q82 rather than q80 -- these are soft painted skies, and banding in a gradient
# is the one artefact that reads as "cheap" on a full-screen image.
WEBP_QUALITY = 82
MAX_WIDTH = 1600

# Role name -> bundle, with the reason. `role` is what a script writes.
BACKGROUNDS: dict[str, dict[str, str]] = {}

BACKGROUND_NOTES = ROOT / "tools" / "advbg_map.json"


def load_map() -> dict[str, dict[str, str]]:
    """Role -> {bundle, why}. Kept as data so identifying a scene does not
    require editing code, and so the reasoning survives next to the mapping."""
    if BACKGROUND_NOTES.exists():
        return json.loads(BACKGROUND_NOTES.read_text(encoding="utf-8"))
    return {}


def open_url(url: str, timeout: int = 90):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HTTP_HEADERS), timeout=timeout)


def load_asset_index(attempts: int = 5) -> list[dict]:
    # Prefer the copy already on disk: the index is 39,669 entries and does not
    # change, so re-fetching it to convert one image is wasted bandwidth.
    if LOCAL_INDEX.exists():
        return json.loads(LOCAL_INDEX.read_text(encoding="utf-8"))
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            with open_url(DATABASE_URL) as response:
                entries = json.loads(response.read())
            if isinstance(entries, list):
                return entries
            raise RuntimeError("asset index is not a list")
        except (http.client.IncompleteRead, json.JSONDecodeError, OSError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(min(8, 2 ** attempt))
    raise RuntimeError(f"unable to read asset index: {last_error}")


def asset_url(entry: dict) -> str:
    bucket = str(entry["path"])[-1]
    return f"https://bucket-{bucket}-asset.kirafan.cn/{entry['name']}"


def download(entry: dict) -> Path:
    destination = CACHE / Path(entry["name"]).name
    if destination.exists() and destination.stat().st_size:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    url = asset_url(entry)
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        response = open_url(url)
    except urllib.error.HTTPError as error:
        # Same fallback the model catalog uses: some bundles are only on the
        # unbucketed host.
        if error.code != 404 or "-asset.kirafan.cn/" not in url:
            raise
        path = urllib.parse.urlsplit(url).path.lstrip("/")
        response = open_url(f"https://asset.kirafan.cn/{path}")
    with response, temporary.open("wb") as handle:
        while chunk := response.read(1024 * 1024):
            handle.write(chunk)
    temporary.replace(destination)
    return destination


def biggest_texture(bundle: Path):
    """The background image out of a bundle.

    A bundle usually holds exactly one Texture2D, but some carry a small extra
    (a mask, a thumbnail). Taking the largest by pixel count picks the
    background in either case without needing to know the naming convention.
    """
    import UnityPy

    env = UnityPy.load(str(bundle))
    best = None
    best_area = 0
    for obj in env.objects:
        if obj.type.name not in ("Texture2D", "Sprite"):
            continue
        try:
            data = obj.read()
            image = data.image
        except Exception:
            continue
        if image is None:
            continue
        area = image.width * image.height
        if area > best_area:
            best = image
            best_area = area
    return best


# Padding detection. Mirrors tools/check_mv_art.py's content_rect, including the
# slack: the measured failure there was a single bright boundary row on top of a
# 159-row letterbox (lossy compression bleeding art across the edge), and a scan
# that stops at the first non-dark line is blind to it.
PAD_DARK = 24        # near-black, summed over R+G+B (0..765)
PAD_BAND = 0.92      # fraction of a line that must be dark to count as padding
PAD_STEP = 8
PAD_SLACK = 2


def trim_padding(image):
    """Return the image cropped to its non-black content, or the original.

    Only trims whole bands off the four edges. Deliberately not a bounding box of
    all non-black pixels: art with a dark vignette would lose real content that
    way, and every case here is a centred picture in a padded square.
    """
    rgb = image.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    xs = range(0, w, PAD_STEP)
    ys = range(0, h, PAD_STEP)
    nx = len(range(0, w, PAD_STEP))
    ny = len(range(0, h, PAD_STEP))

    def row_dark(y):
        return sum(1 for x in xs if sum(px[x, y]) < PAD_DARK) / nx

    def col_dark(x):
        return sum(1 for y in ys if sum(px[x, y]) < PAD_DARK) / ny

    def band(limit, dark_at):
        last = 0
        misses = 0
        for i in range(max(0, limit)):
            if dark_at(i) > PAD_BAND:
                last = i + 1
                misses = 0
            else:
                misses += 1
                if misses > PAD_SLACK:
                    break
        return last

    top = band(h // 2, row_dark)
    bottom = band(h // 2 - top, lambda i: row_dark(h - 1 - i))
    left = band(w // 2, col_dark)
    right = band(w // 2 - left, lambda i: col_dark(w - 1 - i))
    if not (top or bottom or left or right):
        return image
    return image.crop((left, top, w - right, h - bottom))


def convert(role: str, entry: dict, force: bool = False) -> dict | None:
    from PIL import Image

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    out = OUT_ROOT / (role + ".webp")
    if out.exists() and not force:
        with Image.open(out) as existing:
            return {"role": role, "bundle": entry["name"], "size": list(existing.size),
                    "bytes": out.stat().st_size, "skipped": True}

    bundle = download(entry)
    image = biggest_texture(bundle)
    if image is None:
        print(f"  ! {role}: no texture in {entry['name']}")
        return None

    # Unity stores textures bottom-up; UnityPy already flips, so this is only
    # about mode and size.
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA")

    # Crop the letterbox the originals are padded with, before any resize.
    #
    # These textures are square power-of-two sheets holding art that is not
    # square, so the remainder is stored as black rows inside the picture.
    # Measured on bg_adv_com_02_03 (role "library"): 159 black rows at the top
    # and 160 at the bottom of 1600, i.e. 20% of the file is padding. Nothing in
    # CSS can hide that -- `background-size: cover` scales the black in with
    # everything else -- so it has to come off here.
    #
    # Cropping before the downscale also keeps the resize from smearing the black
    # edge into the first row of real art.
    trimmed = trim_padding(image)
    if trimmed is not image:
        before, after = image.size, trimmed.size
        print(f"  cropped padding: {before[0]}x{before[1]} -> {after[0]}x{after[1]}")
        image = trimmed

    if image.width > MAX_WIDTH:
        height = round(image.height * MAX_WIDTH / image.width)
        image = image.resize((MAX_WIDTH, height), Image.LANCZOS)

    # A background is opaque by definition, and dropping the alpha channel saves
    # roughly a fifth of the file on these.
    if image.mode == "RGBA":
        flat = Image.new("RGB", image.size, (255, 255, 255))
        flat.paste(image, mask=image.split()[3])
        image = flat

    image.save(out, "WEBP", quality=WEBP_QUALITY, method=6)
    return {"role": role, "bundle": entry["name"], "size": list(image.size),
            "bytes": out.stat().st_size, "skipped": False}


def sheet(entries: list[dict], name: str, columns: int = 6, thumb: int = 260) -> Path:
    """A contact sheet with the bundle id printed on each cell.

    This is the tool that makes 617 anonymous images usable: convert a range,
    look at it, read the id off the picture you want, and put it in
    tools/advbg_map.json with a note.
    """
    from PIL import Image, ImageDraw

    SHEET_ROOT.mkdir(parents=True, exist_ok=True)
    cells = []
    for entry in entries:
        try:
            image = biggest_texture(download(entry))
        except Exception as error:
            print(f"  ! {entry['name']}: {error}")
            continue
        if image is None:
            continue
        if image.mode != "RGB":
            image = image.convert("RGB")
        image.thumbnail((thumb, thumb), Image.LANCZOS)
        cells.append((Path(entry["name"]).stem, image))
        print(f"  . {entry['name']}")

    if not cells:
        raise RuntimeError("no textures for the sheet")

    label = 16
    width = max(c[1].width for c in cells)
    height = max(c[1].height for c in cells) + label
    rows = (len(cells) + columns - 1) // columns
    canvas = Image.new("RGB", (width * columns, height * rows), (24, 24, 28))
    draw = ImageDraw.Draw(canvas)
    for i, (stem, image) in enumerate(cells):
        x = (i % columns) * width
        y = (i // columns) * height
        canvas.paste(image, (x, y))
        draw.text((x + 3, y + image.height + 2), stem, fill=(210, 210, 215))
    path = SHEET_ROOT / f"sheet-{name}.webp"
    canvas.save(path, "WEBP", quality=80, method=4)
    return path


def bg_entries(index: list[dict]) -> dict[str, dict]:
    """stem -> index entry, for every adv/background bundle."""
    out = {}
    for entry in index:
        name = entry.get("name", "")
        if name.startswith("adv/background/") and name.endswith(".muast"):
            out[Path(name).stem] = entry
    return out


def write_index(records: list[dict]) -> None:
    """What the runtime reads. Roles only -- the renderer asks for a role name
    and needs the pixel size to letterbox correctly."""
    existing = {}
    if INDEX_PATH.exists():
        existing = json.loads(INDEX_PATH.read_text(encoding="utf-8")).get("backgrounds", {})
    for record in records:
        existing[record["role"]] = {"bundle": record["bundle"], "size": record["size"]}
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(
        json.dumps({"backgrounds": existing}, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
        encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("roles", nargs="*", help="role names from tools/advbg_map.json")
    parser.add_argument("--all", action="store_true", help="convert every mapped role")
    parser.add_argument("--list", action="store_true", help="print the role map and exit")
    parser.add_argument("--force", action="store_true", help="re-convert even if the WebP exists")
    parser.add_argument("--sheet", nargs=3, metavar=("GROUP", "START", "COUNT"),
                        help="contact sheet for a slice of a group (ev/com/kir/btl)")
    args = parser.parse_args()

    mapping = load_map()

    if args.list:
        if not mapping:
            print("no roles mapped yet -- use --sheet to find scenes, then edit tools/advbg_map.json")
            return 0
        for role in sorted(mapping):
            entry = mapping[role]
            print(f"{role:22s} {entry['bundle']:34s} {entry.get('why', '')}")
        return 0

    index = load_asset_index()
    available = bg_entries(index)

    if args.sheet:
        group, start, count = args.sheet[0], int(args.sheet[1]), int(args.sheet[2])
        stems = sorted(s for s in available if f"_{group}_" in s or s.startswith(f"bg_adv_{group}"))
        chosen = [available[s] for s in stems[start:start + count]]
        if not chosen:
            print(f"no bundles in group {group} at {start}")
            return 1
        print(f"{len(chosen)} bundles, group {group}, from {start}")
        path = sheet(chosen, f"{group}-{start}-{start + len(chosen)}")
        print(f"-> {path.relative_to(ROOT)}")
        return 0

    roles = sorted(mapping) if args.all else args.roles
    if not roles:
        parser.error("name a role, or pass --all / --list / --sheet")

    records = []
    problems = 0
    for role in roles:
        if role not in mapping:
            print(f"  ! {role}: not in tools/advbg_map.json")
            problems += 1
            continue
        stem = Path(mapping[role]["bundle"]).stem
        if stem not in available:
            print(f"  ! {role}: {stem} not in the asset index")
            problems += 1
            continue
        record = convert(role, available[stem], force=args.force)
        if record is None:
            problems += 1
            continue
        records.append(record)
        state = "skip" if record["skipped"] else "ok  "
        print(f"  {state} {role:22s} {record['size'][0]}x{record['size'][1]}"
              f"  {record['bytes'] / 1024:.0f}KB  {record['bundle']}")

    if records:
        write_index(records)
        total = sum(r["bytes"] for r in records)
        print(f"{len(records)} background(s), {total / 1024 / 1024:.1f}MB total")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
