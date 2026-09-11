#!/usr/bin/env python3
"""Find where a standpic's face tile sits on its body.

An ADV portrait ships as a body PNG plus one 150x150 face tile per expression.
The offset that composites them lives in the game's ADV prefab, which is not in
the extracted asset set -- but the body PNG already has the Default face drawn
into it, so the offset can be recovered by locating that tile in the body.

Matching is on alpha and colour together over a coarse-to-fine search. Alpha
alone is not enough: a face tile is mostly opaque and so is the head around it,
so the alpha channel has little to lock onto. Colour alone drifts on flat hair.

Usage:
    python tools/solve_standpic_offset.py lamp match kirara archives
    python tools/solve_standpic_offset.py --all --out asset/story/standpic-offsets.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

STANDPIC_ROOT = Path("../standpic/adv/standpic")


def load_rgba(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32) / 255.0


def find_body_and_faces(directory: Path) -> tuple[Path | None, dict[str, Path]]:
    body = None
    faces: dict[str, Path] = {}
    for bundle in sorted(directory.iterdir()):
        if not bundle.is_dir():
            continue
        for png in bundle.glob("*.png"):
            stem = png.stem.lower()
            if "_standpic_" in stem:
                # Some characters ship several poses; the first is the one the
                # ADV engine uses by default, and the rest are event variants.
                if body is None or stem.endswith("_0"):
                    body = png
            elif "_face_" in stem:
                # Name is <Chara>_Face_<n>_<Expression>.
                parts = png.stem.split("_")
                if len(parts) >= 4:
                    faces[parts[-1].lower()] = png
    return body, faces


def score_at(body: np.ndarray, face: np.ndarray, top: int, left: int) -> float:
    fh, fw = face.shape[:2]
    window = body[top:top + fh, left:left + fw]
    if window.shape[:2] != (fh, fw):
        return float("inf")
    alpha = face[:, :, 3:4]
    # Only compare where the face tile actually draws: its transparent corners
    # would otherwise reward any position over empty background.
    weight = alpha
    total = weight.sum()
    if total < 1.0:
        return float("inf")
    colour = ((window[:, :, :3] - face[:, :, :3]) ** 2 * weight).sum() / total
    opacity = ((window[:, :, 3:4] - alpha) ** 2).mean()
    return float(colour + opacity * 2.0)


def solve(body_path: Path, face_path: Path, step_coarse: int = 4) -> tuple[int, int, float]:
    body = load_rgba(body_path)
    face = load_rgba(face_path)
    bh, bw = body.shape[:2]
    fh, fw = face.shape[:2]
    if fh > bh or fw > bw:
        return -1, -1, float("inf")

    # A face is in the upper half of a portrait, so the search is bounded there
    # -- it removes most of the plane and stops a chest pattern from winning.
    max_top = max(0, int(bh * 0.55) - fh)
    best = (0, 0, float("inf"))
    for top in range(0, max_top + 1, step_coarse):
        for left in range(0, bw - fw + 1, step_coarse):
            value = score_at(body, face, top, left)
            if value < best[2]:
                best = (top, left, value)

    # Refine around the coarse winner.
    top0, left0 = best[0], best[1]
    for top in range(max(0, top0 - step_coarse), min(bh - fh, top0 + step_coarse) + 1):
        for left in range(max(0, left0 - step_coarse), min(bw - fw, left0 + step_coarse) + 1):
            value = score_at(body, face, top, left)
            if value < best[2]:
                best = (top, left, value)
    return best


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*", help="standpic directory names, e.g. lamp")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--root", type=Path, default=STANDPIC_ROOT)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    if args.all:
        names = sorted(p.name for p in args.root.iterdir() if p.is_dir())
    else:
        names = args.names
    if args.limit:
        names = names[: args.limit]
    if not names:
        parser.error("name(s) or --all required")

    result: dict[str, dict] = {}
    bad: list[str] = []
    for name in names:
        directory = args.root / name
        if not directory.is_dir():
            bad.append(f"{name}: no such directory")
            continue
        body, faces = find_body_and_faces(directory)
        if body is None:
            bad.append(f"{name}: no standpic body")
            continue
        if "default" not in faces:
            bad.append(f"{name}: no Default face to solve against")
            continue
        top, left, score = solve(body, faces["default"])
        body_size = Image.open(body).size
        face_size = Image.open(faces["default"]).size
        entry = {
            "body": body.name,
            "bodySize": list(body_size),
            "faceSize": list(face_size),
            "faceOffset": [left, top],
            "score": round(score, 5),
            "expressions": sorted(faces),
        }
        result[name] = entry
        # A residual over ~0.01 means the Default face is not actually drawn into
        # the body, so the offset is a guess rather than a match.
        flag = "  <-- weak match" if score > 0.01 else ""
        print(f"{name:34s} body={body_size} face={face_size} "
              f"offset=({left},{top}) score={score:.5f}{flag}")
        if score > 0.01:
            bad.append(f"{name}: weak match, score {score:.5f}")

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=1, sort_keys=True), encoding="utf-8")
        print(f"\nwrote {args.out} ({len(result)} entries)")

    if bad:
        print(f"\n{len(bad)} to look at:")
        for line in bad[:30]:
            print("  -", line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
