#!/usr/bin/env python3
"""Is `_body_outline` ever genuinely translucent, or is BLEND vestigial?

core/loader.js keeps every `*_outline` material blended with depthWrite off,
on the stated grounds that it covers pieces meant to read as see-through.  In the
player models that material is `m_PL_<id>_body_outline`, and it covers the hands
and sleeves -- so if its texture is fully opaque, the blend flag buys nothing and
costs the hands, which land in the transparent queue and get painted over.

This samples the atlas alpha under the UVs of every mesh using an `_outline`
material, across a sample of models, and reports how many are effectively opaque.
A blanket opaque flip in the loader is only safe if translucent cases are absent
or rare enough to handle by measured alpha rather than by name.

The loader applies one rule to players, enemies and weapons alike, so --kind
covers all three: a predicate justified only on players would be a guess about
the other 600-odd models.

Usage:
    python tools/survey_outline_alpha.py --limit 150
    python tools/survey_outline_alpha.py --kind en --limit 200
    python tools/survey_outline_alpha.py --limit 400 --json tmp/outline_alpha.json
"""

from __future__ import annotations

import argparse
import io
import json
import os
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probe_arm_reach import read_accessor, read_glb  # noqa: E402
from probe_hand_alpha import image_bytes  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
# Below this the piece is doing real blending and must keep it.
OPAQUE_MEAN = 0.999


def atlas_for_material(gltf, binary, index, cache):
    if index in cache:
        return cache[index]
    material = gltf["materials"][index]
    tex = material.get("pbrMetallicRoughness", {}).get("baseColorTexture")
    if not tex:
        cache[index] = None
        return None
    source = gltf["textures"][tex["index"]].get("source")
    if source is None:
        cache[index] = None
        return None
    image = Image.open(io.BytesIO(image_bytes(gltf, binary, source))).convert("RGBA")
    cache[index] = np.asarray(image)
    return cache[index]


def survey_model(path):
    gltf, binary = read_glb(path)
    materials = gltf.get("materials", [])
    outline = {i for i, m in enumerate(materials)
               if "_outline" in (m.get("name") or "").lower()}
    if not outline:
        return None

    cache = {}
    rows = []
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            mi = prim.get("material")
            if mi not in outline:
                continue
            atlas = atlas_for_material(gltf, binary, mi, cache)
            uv_index = prim.get("attributes", {}).get("TEXCOORD_0")
            if atlas is None or uv_index is None:
                continue
            uvs = read_accessor(gltf, binary, uv_index)
            h, w = atlas.shape[:2]
            xs = np.clip((uvs[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(int)
            ys = np.clip((1.0 - uvs[:, 1] % 1.0) * (h - 1), 0, h - 1).astype(int)
            alpha = atlas[ys, xs, 3] / 255.0
            rows.append({
                "mesh": mesh.get("name"),
                "material": materials[mi].get("name"),
                "alphaMode": materials[mi].get("alphaMode"),
                "verts": int(len(alpha)),
                "alphaMean": float(alpha.mean()),
                "alphaMin": float(alpha.min()),
                "fracBelowHalf": float((alpha < 0.5).mean()),
            })
    return rows or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=150)
    ap.add_argument("--kind", default="pl", choices=("pl", "en", "wpn"))
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--json")
    args = ap.parse_args()

    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    base = ROOT / "asset" / "models"
    # Weapons are `wpn_<id>`, not `model_wpn_<id>` -- guessing the third prefix from
    # the first two silently surveys nothing and reports a clean result.
    prefix = "wpn_" if args.kind == "wpn" else f"model_{args.kind}_"
    dirs = sorted(d for d in os.listdir(base) if d.startswith(prefix))
    random.seed(args.seed)
    if args.limit and args.limit < len(dirs):
        dirs = random.sample(dirs, args.limit)

    results = {}
    translucent = []
    read = 0
    for name in dirs:
        path = base / name / "model.glb.gz"
        if not path.is_file():
            continue
        try:
            rows = survey_model(path)
        except Exception as exc:                                    # noqa: BLE001
            print(f"  skip {name}: {type(exc).__name__} {exc}", file=sys.stderr)
            continue
        if rows is None:
            continue
        read += 1
        results[name] = rows
        for row in rows:
            if row["alphaMean"] < OPAQUE_MEAN:
                translucent.append((name, row))

    total_meshes = sum(len(v) for v in results.values())
    print(f"kind={args.kind}  candidates={len(dirs)}")
    print(f"models read with an _outline material : {read}")
    print(f"meshes using an _outline material     : {total_meshes}")
    print(f"of those, effectively opaque (mean alpha >= {OPAQUE_MEAN}): "
          f"{total_meshes - len(translucent)}")
    print(f"of those, genuinely translucent       : {len(translucent)}")

    if translucent:
        print("\ntranslucent cases (these must keep blending):")
        worst = sorted(translucent, key=lambda pair: pair[1]["alphaMean"])
        for name, row in worst[:25]:
            print(f"  {name:<20}{row['mesh']:<16}mean={row['alphaMean']:.3f} "
                  f"min={row['alphaMin']:.3f} below0.5={row['fracBelowHalf']*100:.1f}% "
                  f"verts={row['verts']}")
        names = sorted({n for n, _ in translucent})
        print(f"\n{len(names)} distinct models affected")
    else:
        print("\nNo translucent case found: for every mesh sampled, the _outline "
              "material's texture is opaque where that mesh samples it.\n"
              "The BLEND flag changes no pixel colour; it only moves these pieces "
              "into the transparent queue, where they get painted over.")

    if args.json:
        Path(args.json).write_text(
            json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
