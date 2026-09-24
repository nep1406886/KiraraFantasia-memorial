#!/usr/bin/env python3
"""Extract the original game's UI art (sprite atlases + fonts) from its Unity
asset bundles, so the offline replica can render the *actual* UI chrome 1:1.

The original stores UI sprites in per-feature .muast bundles under texture/
(e.g. texture/gachalist.muast holds the gacha result grid frames,
texture/gachabanner/* the summon banners, texture/background/* the scene
backdrops). Each bundle is one or more Texture2D atlases; the Sprite objects
(class id 213) carry the real asset names (GachaList_G00834, ...) and their
per-sprite .image property yields the cropped RGBA region.

This script is the UI half of the asset pipeline that
tools/convert_kirafan_model.py already covers for models. It:
  1. Reads the live bundle index (database.kirafan.cn/assetBundle.json).
  2. Downloads the requested bundles (reusing build_model_catalog.download,
     which handles the bucket-N / asset.kirafan.cn 404 fallback).
  3. Caches raw bundles under .codex-tmp/ui-bundles/ (gitignored) so re-runs
     don't re-download.
  4. Extracts every sprite to site/asset/game/ui/<feature>/<Name>.webp and
     every font atlas to site/asset/game/ui/fonts/<Name>.png.
  5. Writes site/asset/game/ui/manifest.json: { name -> {file, w, h} } keyed
     by the original sprite name, so the UI layer resolves art by the same
     names the C# code used.

Run:
  python tools/extract_ui_assets.py --feature gacha
  python tools/extract_ui_assets.py --feature background --feature townobjecticon
  python tools/extract_ui_assets.py --fonts
  python tools/extract_ui_assets.py --list

Features map to texture/<feature>/ bundles (or a single texture/<name>.muast
when the feature is a bare file). See --list for the full inventory.

Convention: images are WebP q82 (spec/00 §6), filenames keep the original
sprite name so the UI can reference them exactly as the source does.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import tempfile
from pathlib import Path

import UnityPy
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_model_catalog import asset_url, download, open_url  # noqa: E402

DATABASE_URL = "https://database.kirafan.cn/assetBundle.json"

# UnityPy class ids (this engine build):
CLASS_TEXTURE2D = 28   # Texture2D (atlas)
CLASS_SPRITE = 213     # Sprite (named, .image gives the cropped region)
CLASS_FONT = 128       # Font
CLASS_FONTASSET = 21   # DynamicFont / FontAsset
CLASS_ASSETBUNDLE = 142  # the bundle root

# texture/<feature>/ groups worth extracting for the 1:1 UI. Each maps to a
# bundle-prefix. "all" is a convenience that pulls the UI-chrome-critical set.
FEATURES: dict[str, str] = {
    # UI chrome / common
    "background": "texture/background/",
    "uibackground": "texture/uibackground/uibackground_0.muast",
    "titleicon": "texture/titleicon/",
    "scenetitle": "texture/scenetitle/",
    "contenttitlelogo": "texture/contenttitlelogo/",
    # gacha (phase C)
    "gacha": "texture/gachalist.muast",
    "gachabanner": "texture/gachabanner/",
    "gachaitemlabel": "texture/gachaitemlabel/",
    # town / shop (phase B/F)
    "townobjecticon": "texture/townobjecticon/",
    "shoplabel": "texture/shoplabel/shoplabel_0.muast",
    # quest (phase F)
    "questchaptericon": "texture/questchaptericon/",
    "questgroupicon": "texture/questgroupicon/",
    "questtypeicon": "texture/questtypeicon/",
    "questpartimage": "texture/questpartimage/",
    "questeventtypeicon": "texture/questeventtypeicon/",
    # items / weapons / rooms / orb
    "itemicon": "texture/itemicon/",
    "weaponicon": "texture/weaponicon/",
    "roomobjecticon": "texture/roomobjecticon/",
    "orbicon": "texture/orbicon/",
    "packageicon": "texture/packageicon/",
    "originalcharactericon": "texture/originalcharactericon/",
    "originalcharacterillust": "texture/originalcharacterillust/",
    # misc
    "npc": "texture/npc/",
    "moviebanner": "texture/moviebanner/",
    "master": "texture/master/",
    "retiretips": "texture/retiretips/",
}

# The default "all" set = everything the core 1:1 UI needs except the giant
# charauiresource (3.1 GB) and per-id weapon/achievement/icon floods, which are
# extracted on demand per phase.
DEFAULT_ALL = [
    "background", "uibackground", "titleicon", "scenetitle", "contenttitlelogo",
    "gacha", "gachabanner", "gachaitemlabel",
    "townobjecticon", "shoplabel",
    "questchaptericon", "questgroupicon", "questtypeicon", "questpartimage",
    "npc", "moviebanner",
]


def load_index() -> list[dict]:
    return json.load(open_url(DATABASE_URL, timeout=90))


def bundles_for(feature: str, index: list[dict]) -> list[dict]:
    prefix = FEATURES.get(feature, feature)
    if prefix.endswith(".muast"):
        wanted = prefix
        return [e for e in index if e.get("name") == wanted]
    return [e for e in index if e.get("name", "").startswith(prefix)]


def extract_bundles(entries: list[dict], cache: Path, out_root: Path) -> dict:
    """Download + extract every sprite in the given bundles. Returns manifest."""
    manifest: dict[str, dict] = {}
    for entry in entries:
        name = entry["name"]
        rel = name.split("texture/", 1)[-1] if name.startswith("texture/") else name
        # subfolder for output (e.g. gachabanner/ -> ui/gachabanner/)
        parts = Path(rel).parts
        subdir = out_root / parts[0] if len(parts) > 1 else out_root
        subdir.mkdir(parents=True, exist_ok=True)
        cache_path = cache / Path(name).name
        bundle = download(asset_url(entry), cache_path)
        env = UnityPy.load(str(bundle))
        count = 0
        for obj in env.objects:
            if obj.type != CLASS_SPRITE:
                continue
            data = obj.read()
            sprite_name = getattr(data, "m_Name", None)
            if not sprite_name:
                continue
            try:
                image = data.image
            except Exception:
                continue
            if image is None:
                continue
            # sanitize the name for a filename (keep it for the manifest key)
            safe = sprite_name.replace("/", "_")
            ext = ".webp"
            fp = subdir / f"{safe}{ext}"
            if not fp.exists():
                image.save(fp, "WEBP", quality=82)
            w, h = image.size
            manifest[sprite_name] = {
                "file": fp.relative_to(out_root.parent).as_posix(),
                "w": w,
                "h": h,
                "bundle": name,
            }
            count += 1
        print(f"  {name}: {count} sprites")
    return manifest


def extract_fonts(cache: Path, out_root: Path) -> dict:
    """Extract font atlas textures + font metadata from fontpack.muast."""
    index = load_index()
    by = {e["name"]: e for e in index if isinstance(e, dict) and "name" in e}
    entry = by["fontpack/fontpack.muast"]
    cache_path = cache / "fontpack.muast"
    bundle = download(asset_url(entry), cache_path)
    env = UnityPy.load(str(bundle))
    fonts_dir = out_root / "fonts"
    fonts_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict] = {}
    i = 0
    for obj in env.objects:
        if obj.type != CLASS_TEXTURE2D:
            continue
        data = obj.read()
        try:
            image = data.image
        except Exception:
            continue
        if image is None:
            continue
        fp = fonts_dir / f"fontatlas_{i}.png"
        image.save(fp)
        manifest[f"fontatlas_{i}"] = {
            "file": fp.relative_to(out_root.parent).as_posix(),
            "w": image.size[0],
            "h": image.size[1],
            "bundle": "fontpack/fontpack.muast",
        }
        i += 1
        print(f"  fontatlas_{i-1}: {image.size}")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feature", action="append",
                        help="a feature key from FEATURES (repeatable)")
    parser.add_argument("--all", action="store_true",
                        help="extract the DEFAULT_ALL set")
    parser.add_argument("--fonts", action="store_true",
                        help="also extract fontpack")
    parser.add_argument("--list", action="store_true",
                        help="list the feature inventory and exit")
    parser.add_argument("--site-root", type=Path,
                        default=Path(__file__).resolve().parents[1])
    parser.add_argument("--cache-dir", type=Path,
                        default=Path(__file__).resolve().parents[1] / ".codex-tmp" / "ui-bundles")
    args = parser.parse_args()

    out_root = args.site_root / "site" / "asset" / "game" / "ui"
    manifest_path = out_root / "manifest.json"

    if args.list:
        print("Available features:")
        for k, v in sorted(FEATURES.items()):
            print(f"  {k:24s} {v}")
        print(f"\nDEFAULT_ALL = {DEFAULT_ALL}")
        return

    features = list(args.feature or [])
    if args.all:
        features = DEFAULT_ALL
    if not features and not args.fonts:
        parser.error("nothing to do; pass --feature/--all and/or --fonts")

    index = load_index()
    entries: list[dict] = []
    for f in features:
        got = bundles_for(f, index)
        if not got:
            print(f"  (no bundles for {f})")
        entries.extend(got)

    existing = {}
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {}

    if entries:
        print(f"extracting {len(entries)} bundles -> {out_root}")
        new = extract_bundles(entries, args.cache_dir, out_root)
        existing.update(new)

    font_manifest = {}
    if args.fonts:
        print("extracting fonts")
        font_manifest = extract_fonts(args.cache_dir, out_root)

    existing["fonts"] = font_manifest
    out_root.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    sprite_count = sum(1 for k in existing if k != "fonts")
    print(f"\nmanifest: {len(existing)} sprites -> {manifest_path}")
    print(f"sprite files: {sprite_count}, font atlases: {len(font_manifest)}")


if __name__ == "__main__":
    main()
