#!/usr/bin/env python3
"""Convert ADV standing portraits to WebP for the fan game.

Each character ships a body PNG with the Default face already drawn into it,
plus one face tile per expression (default / angry / happy / joy / shy / sorrow
/ surprise / unique1-3). This composites each expression onto the body and
writes one WebP per expression, so the runtime does no compositing and a face
change is a single image swap.

Compositing here rather than in the browser costs disk but buys three things:
the offsets stay in the tool that solved them, an expression swap cannot flicker
mid-blend, and the body's 300KB PNG is paid once per expression at WebP rates
instead of once per character in PNG plus a canvas op per line.

Bodies are also written at a capped height: a 1056px portrait is taller than it
will ever be drawn on a 1080p screen at 62% of frame, and the cap is where most
of the 809MB goes away.

Usage:
    python tools/convert_standpic.py lamp match kirara archives
    python tools/convert_standpic.py --all
    python tools/convert_standpic.py --all --jobs 8 --dry-run
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from PIL import Image

SOURCE_ROOT = Path("../standpic/adv/standpic")
OUT_ROOT = Path("site/asset/story/standpic")
INDEX_PATH = Path("site/asset/story/standpic-index.json")

# The game's own expression set, in the order it names them. A script says
# `face: "sorrow"` and this is what answers.
EXPRESSIONS = ["default", "angry", "happy", "joy", "shy", "sorrow", "surprise",
               "unique1", "unique2", "unique3"]

# Tallest a portrait is drawn: 62% of a 1080p frame is ~670px, so 760 leaves
# headroom for a taller viewport without keeping pixels nothing will show.
MAX_HEIGHT = 760
QUALITY = 82


def find_parts(directory: Path) -> tuple[Path | None, dict[str, Path]]:
    body: Path | None = None
    body_rank = 99
    faces: dict[str, Path] = {}
    for bundle in sorted(directory.iterdir()):
        if not bundle.is_dir():
            continue
        for png in bundle.glob("*.png"):
            stem = png.stem.lower()
            if "_standpic_" in stem:
                # Prefer _0: later indices are event poses, and a chapter that
                # wants one asks for it by name.
                rank = 0 if stem.endswith("_0") else 1
                if rank < body_rank:
                    body, body_rank = png, rank
            elif "_face_" in stem:
                parts = png.stem.split("_")
                if len(parts) >= 4:
                    faces.setdefault(parts[-1].lower(), png)
    return body, faces


def score_at(body: np.ndarray, face: np.ndarray, top: int, left: int) -> float:
    fh, fw = face.shape[:2]
    window = body[top:top + fh, left:left + fw]
    if window.shape[:2] != (fh, fw):
        return float("inf")
    alpha = face[:, :, 3:4]
    total = alpha.sum()
    if total < 1.0:
        return float("inf")
    colour = ((window[:, :, :3] - face[:, :, :3]) ** 2 * alpha).sum() / total
    opacity = ((window[:, :, 3:4] - alpha) ** 2).mean()
    return float(colour + opacity * 2.0)


def solve_offset(body_img: Image.Image, face_img: Image.Image) -> tuple[int, int, float]:
    """Locate the Default face tile inside the body it is drawn into."""
    body = np.asarray(body_img.convert("RGBA"), dtype=np.float32) / 255.0
    face = np.asarray(face_img.convert("RGBA"), dtype=np.float32) / 255.0
    bh, bw = body.shape[:2]
    fh, fw = face.shape[:2]
    if fh > bh or fw > bw:
        return -1, -1, float("inf")
    max_top = max(0, min(bh - fh, int(bh * 0.55) - fh))
    best = (0, 0, float("inf"))
    for top in range(0, max_top + 1, 4):
        for left in range(0, bw - fw + 1, 4):
            value = score_at(body, face, top, left)
            if value < best[2]:
                best = (top, left, value)
    top0, left0 = best[0], best[1]
    for top in range(max(0, top0 - 4), min(bh - fh, top0 + 4) + 1):
        for left in range(max(0, left0 - 4), min(bw - fw, left0 + 4) + 1):
            value = score_at(body, face, top, left)
            if value < best[2]:
                best = (top, left, value)
    return best


def convert_one(name: str, source_root: Path, out_root: Path,
                max_height: int, quality: int, dry_run: bool) -> dict:
    directory = source_root / name
    body_path, faces = find_parts(directory)
    if body_path is None:
        return {"name": name, "error": "no standpic body"}
    if "default" not in faces:
        return {"name": name, "error": "no Default face"}

    body = Image.open(body_path).convert("RGBA")
    default_face = Image.open(faces["default"]).convert("RGBA")
    top, left, score = solve_offset(body, default_face)
    if top < 0:
        return {"name": name, "error": "face tile larger than body"}

    scale = min(1.0, max_height / body.height)
    out_dir = out_root / name
    written: dict[str, int] = {}
    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    for expression in EXPRESSIONS:
        face_path = faces.get(expression)
        if face_path is None:
            continue
        frame = body.copy()
        if expression != "default":
            face = Image.open(face_path).convert("RGBA")
            # alpha_composite, not paste: the tile's edges are feathered against
            # the hair behind them, and paste would cut a hard rectangle.
            region = frame.crop((left, top, left + face.width, top + face.height))
            region = Image.alpha_composite(region, face)
            frame.paste(region, (left, top))
        if scale < 1.0:
            frame = frame.resize(
                (max(1, round(frame.width * scale)), max(1, round(frame.height * scale))),
                Image.LANCZOS)
        target = out_dir / f"{expression}.webp"
        if dry_run:
            written[expression] = 0
            continue
        frame.save(target, "WEBP", quality=quality, method=6)
        written[expression] = target.stat().st_size

    return {
        "name": name,
        "bodySize": [body.width, body.height],
        "size": [round(body.width * scale), round(body.height * scale)],
        "faceOffset": [left, top],
        "matchScore": round(score, 5),
        "expressions": sorted(written),
        "bytes": sum(written.values())
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--source", type=Path, default=SOURCE_ROOT)
    parser.add_argument("--out", type=Path, default=OUT_ROOT)
    parser.add_argument("--index", type=Path, default=INDEX_PATH)
    parser.add_argument("--max-height", type=int, default=MAX_HEIGHT)
    parser.add_argument("--quality", type=int, default=QUALITY)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.all:
        names = sorted(p.name for p in args.source.iterdir() if p.is_dir())
    else:
        names = args.names
    if args.limit:
        names = names[: args.limit]
    if not names:
        parser.error("name(s) or --all required")

    # Merge into any existing index, so converting four characters does not
    # drop the other 903.
    index: dict[str, dict] = {}
    if args.index.exists():
        try:
            index = json.loads(args.index.read_text(encoding="utf-8")).get("characters", {})
        except (ValueError, OSError):
            index = {}

    results: list[dict] = []
    errors: list[str] = []
    if args.jobs > 1 and len(names) > 1:
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            futures = {
                pool.submit(convert_one, name, args.source, args.out,
                            args.max_height, args.quality, args.dry_run): name
                for name in names
            }
            for future in as_completed(futures):
                results.append(future.result())
    else:
        for name in names:
            results.append(convert_one(name, args.source, args.out,
                                       args.max_height, args.quality, args.dry_run))

    total = 0
    for entry in sorted(results, key=lambda e: e["name"]):
        if "error" in entry:
            errors.append(f"{entry['name']}: {entry['error']}")
            continue
        total += entry["bytes"]
        # A weak match means the offset was inferred rather than found, so the
        # non-default expressions on that character may sit wrong.
        flag = "  <-- weak offset" if entry["matchScore"] > 0.01 else ""
        print(f"{entry['name']:34s} {entry['size'][0]:4d}x{entry['size'][1]:4d} "
              f"{len(entry['expressions']):2d} expr {entry['bytes'] / 1024:8.1f} KiB{flag}")
        index[entry["name"]] = {
            "size": entry["size"],
            "expressions": entry["expressions"],
            "faceOffset": entry["faceOffset"]
        }

    print(f"\n{len(results) - len(errors)} character(s), {total / 1048576:.2f} MiB")
    if errors:
        print(f"{len(errors)} failed:")
        for line in errors[:30]:
            print("  -", line)

    if not args.dry_run:
        args.index.parent.mkdir(parents=True, exist_ok=True)
        args.index.write_text(json.dumps({
            "version": 1,
            "root": "site/asset/story/standpic/",
            "expressions": EXPRESSIONS,
            "characters": index
        }, indent=1, sort_keys=True), encoding="utf-8")
        print(f"wrote {args.index} ({len(index)} characters)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
