#!/usr/bin/env python3
"""Build five shared player class-animation sources for the WebGL viewer."""

from __future__ import annotations

import argparse
import json
import tempfile
import urllib.request
from pathlib import Path

from build_model_catalog import asset_url, download, gzip_model, optimize_model
from convert_kirafan_model import KirafanExporter


DATABASE_URL = "https://database.kirafan.cn/assetBundle.json"
HTTP_HEADERS = {"User-Agent": "kirafan-timer-model-builder/1.0"}
COMMON_ANIMATIONS = (
    "anim/player/common_menu_body.muast",
    "anim/player/common_battle_body.muast",
    "anim/player/common_menu_head_0.muast",
    "anim/player/common_battle_head_0.muast",
)
CLASS_SOURCES = {
    0: ("model/player/model_pl_100101.muast", "fighter"),
    1: ("model/player/model_pl_100005.muast", "magician"),
    2: ("model/player/model_pl_100001.muast", "priest"),
    3: ("model/player/model_pl_100000.muast", "knight"),
    4: ("model/player/model_pl_100000.muast", "alchemist"),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(tempfile.gettempdir()) / "kirafan-model-cache",
    )
    parser.add_argument("--gltfpack", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    site_root = args.site_root.resolve()
    manifest_path = site_root / "asset" / "models" / "manifest.json"
    output_root = site_root / "asset" / "models" / "class-actions"
    animation_dir = args.cache_dir / "animations"
    gltfpack = args.gltfpack.resolve() if args.gltfpack else None
    if gltfpack and not gltfpack.is_file():
        raise SystemExit(f"gltfpack executable not found: {gltfpack}")

    request = urllib.request.Request(DATABASE_URL, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=90) as response:
        entries = json.load(response)
    by_name = {entry["name"]: entry for entry in entries if isinstance(entry, dict) and "name" in entry}

    for name in COMMON_ANIMATIONS:
        entry = by_name[name]
        download(asset_url(entry), animation_dir / Path(name).name)

    published = {}
    for class_id, (model_name, class_name) in CLASS_SOURCES.items():
        model_entry = by_name[model_name]
        animation_name = f"anim/player/class_{class_name}_body.muast"
        animation_entry = by_name[animation_name]
        model_path = download(
            asset_url(model_entry),
            args.cache_dir / "bundles" / Path(model_name).name,
        )
        class_animation = download(
            asset_url(animation_entry),
            animation_dir / Path(animation_name).name,
        )
        for head_id in range(4):
            head_name = f"anim/player/class_{class_name}_head_{head_id}.muast"
            head_entry = by_name[head_name]
            head_animation = download(
                asset_url(head_entry),
                animation_dir / Path(head_name).name,
            )
            output = output_root / f"class-{class_id}" / f"head-{head_id}.glb"
            compressed = output.with_suffix(output.suffix + ".gz")
            if compressed.is_file() and compressed.stat().st_size:
                published[f"{class_id}:{head_id}"] = {
                    "file": f"{compressed.relative_to(site_root).as_posix()}?v={int(compressed.stat().st_mtime)}",
                    "compression": "gzip",
                    "meshopt": bool(gltfpack),
                    "animations": list(KirafanExporter.CLASS_ACTIONS),
                }
                print(f"Class {class_id} / head {head_id}: reused {compressed.stat().st_size:,} bytes")
                continue
            exporter = KirafanExporter(
                model_path,
                animation_dir,
                class_animation_bundle=class_animation,
                class_head_animation_bundle=head_animation,
                include_common_animations=False,
                animation_only=True,
            )
            exporter.export(output)
            if gltfpack:
                optimize_model(output, gltfpack)
            compressed = gzip_model(output)
            published[f"{class_id}:{head_id}"] = {
                "file": f"{compressed.relative_to(site_root).as_posix()}?v={int(compressed.stat().st_mtime)}",
                "compression": "gzip",
                "meshopt": bool(gltfpack),
                "animations": [
                    clip["name"] for clip in exporter.builder.document["animations"]
                ],
            }
            print(f"Class {class_id} / head {head_id}: {compressed.stat().st_size:,} bytes")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["classActions"] = published
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
