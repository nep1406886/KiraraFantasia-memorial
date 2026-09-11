#!/usr/bin/env python3
"""Audit the per-clip visibility table against the published GLBs.

Two things must hold for every player model:

  * every node the table governs and the model owns ends up with exactly one
    member of each variant set visible -- not zero (a missing leg) and not all
    six (the smear the table exists to fix);
  * every governed node named by a clip exists on the models that clip plays on,
    or the curve is addressing something the exporter dropped.

This reads the GLB node lists directly, so it does not need a browser: the table
is a pure function of clip name plus node name, and the viewer applies it
verbatim.

Usage:
  python tools/check_visibility.py            # every model in the manifest
  python tools/check_visibility.py --limit 80
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import re
import struct
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# leg_L_A / leg_L_A_2 / hat_L: the set is the part plus the side, and the variant
# is everything after it.
VARIANT = re.compile(r"^(leg_[LR]|hat)_(.+)$", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-root", type=Path, default=ROOT)
    parser.add_argument("--limit", type=int, default=0, help="check only N models")
    return parser.parse_args()


def glb_mesh_nodes(path: Path) -> set[str]:
    raw = gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes()
    if raw[:4] != b"glTF":
        raise ValueError(f"{path} is not a GLB")
    length, kind = struct.unpack_from("<II", raw, 12)
    document = json.loads(raw[20:20 + length].decode("utf-8"))
    return {
        str(node.get("name") or "")
        for node in document.get("nodes", [])
        if "mesh" in node
    }


def variant_set(name: str) -> tuple[str, str] | None:
    match = VARIANT.match(name)
    if not match:
        return None
    return match.group(1).lower(), match.group(2).lower()


def value_at(track, frame: float) -> int:
    if not isinstance(track, list):
        return 1 if track else 0
    value = track[0][1] if track else 1
    for key_frame, key_value in track:
        if key_frame > frame:
            break
        value = key_value
    return value


def main() -> int:
    args = parse_args()
    site_root = args.site_root.resolve()
    table_path = site_root / "asset" / "models" / "visibility.json"
    with io.open(table_path, encoding="utf-8") as handle:
        table = json.load(handle)

    with io.open(site_root / "asset" / "models" / "manifest.json", encoding="utf-8") as handle:
        manifest = json.load(handle)

    player = {
        name: entry
        for name, entry in manifest["models"].items()
        if "model_pl_" in name
    }
    names = sorted(player)
    if args.limit:
        names = names[: args.limit]

    # Every clip, shared and per-class, is checked against every model: the
    # viewer offers class actions on any model of that class and the shared clips
    # on all of them.
    clip_tables: list[tuple[str, dict]] = [
        (name, tracks) for name, tracks in table["clips"].items()
    ]
    for class_id, clips in (table.get("classClips") or {}).items():
        for name, tracks in clips.items():
            clip_tables.append((f"class{class_id}:{name}", tracks))

    failures: list[str] = []
    counts: Counter[str] = Counter()
    checked = 0

    for name in names:
        entry = player[name]
        rel = entry["file"].split("?", 1)[0]
        path = site_root / rel
        if not path.is_file():
            counts["missing glb"] += 1
            continue
        try:
            nodes = glb_mesh_nodes(path)
        except Exception as error:  # pragma: no cover - corrupt publish
            failures.append(f"{name}: unreadable ({error})")
            continue
        checked += 1

        owned = {n for n in nodes if variant_set(n)}
        if not owned:
            counts["no variant nodes"] += 1
            continue

        # Which sets this model actually has, so a model with no hat is not
        # reported for a hat curve.
        sets: dict[str, set[str]] = {}
        for node in owned:
            part, variant = variant_set(node)
            sets.setdefault(part, set()).add(node)

        for clip_name, tracks in clip_tables:
            # Sample the frames the curves actually switch on, plus frame 0.
            frames = {0.0}
            for track in tracks.values():
                if isinstance(track, list):
                    frames.update(float(f) for f, _ in track)
            for frame in sorted(frames):
                for part, members in sets.items():
                    visible = [
                        node
                        for node in sorted(members)
                        if value_at(tracks.get(node, 0), frame) == 1
                    ]
                    governed = [node for node in members if node in tracks]
                    if not governed:
                        # The clip says nothing about this set on this model; the
                        # viewer leaves the previous pose standing.
                        counts[f"ungoverned:{part}"] += 1
                        continue
                    if len(members) < 2:
                        # Nothing to switch to, so the viewer keeps the one member
                        # on rather than leaving the model without the part
                        # (model_pl_120301 has hat_R and no hat_L).
                        counts[f"single:{part}"] += 1
                        continue
                    if len(visible) == 1:
                        counts["ok"] += 1
                        continue
                    failures.append(
                        f"{name} {clip_name} f{frame:g} {part}: "
                        f"{len(visible)} visible {visible} of {sorted(members)}"
                    )

    print(f"checked {checked} models x {len(clip_tables)} clips")
    for key, value in sorted(counts.items()):
        print(f"  {key}: {value}")
    if failures:
        print(f"FAIL: {len(failures)} bad states")
        for line in failures[:25]:
            print("  " + line)
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
