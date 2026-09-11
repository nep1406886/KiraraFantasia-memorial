#!/usr/bin/env python3
"""Publish每角色的必杀 / 专属技动作 for the WebGL viewer.

Two bundles carry a character's own skill motion, and both keep the body and the
head clip together in one file:

  uniqueskill/uniqueskill_pl_{id}_0.muast   owner_body@skill / owner_head@skill
  anim/player/chara_battle_{id}.muast       Chara_Battle_body@chara_skill_1 ...

The unique-skill bundle is really a whole cinematic -- effect meshes, particles,
an orthographic camera, Signal_* timing nodes and its own UniqueSkill@Take 001
clip.  None of that is exported: only the two clips that drive the character are,
because those target the same root/* and Head_root/* paths the viewer already
retargets class actions onto.  The effect scene would need a particle and shader
port that three.js has no equivalent for.

Output is one animation-only GLB per character, listed in the manifest under
"skillActions" so the viewer can fetch it on demand next to the model.
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import struct
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

import UnityPy

from build_model_catalog import asset_url, download, gzip_model, optimize_model
from convert_kirafan_model import KirafanExporter

DATABASE_URL = "https://database.kirafan.cn/assetBundle.json"
HTTP_HEADERS = {"User-Agent": "kirafan-timer-model-builder/1.0"}
PLAYER_MODEL = re.compile(r"^model/player/model_pl_(\d+)\.muast$")
# Exported clip name -> bundle template.  "skill" is とっておき (the ultimate),
# "chara_skill_1" is the character's own battle skill.
SKILL_BUNDLES = {
    "skill": "uniqueskill/uniqueskill_pl_{model}_0.muast",
    "chara_skill_1": "anim/player/chara_battle_{model}.muast",
}


def fetch(entry: dict, destination: Path, attempts: int = 5) -> Path:
    """Download with retries: the asset CDN drops SSL connections under load."""
    for attempt in range(1, attempts + 1):
        try:
            return download(asset_url(entry), destination)
        except (urllib.error.URLError, OSError):
            destination.with_suffix(destination.suffix + ".part").unlink(missing_ok=True)
            if attempt == attempts:
                raise


def fetch_parsable(entry: dict, destination: Path) -> Path:
    """Fetch a bundle and make sure it actually opens.

    download() reuses any cached file that is merely non-empty, so a bundle left
    truncated by a dropped connection is reused for good and every later run dies
    on the same LZ4 error inside UnityPy.  This parses the file once and, if that
    fails, throws the cache entry away and downloads it again -- which is the only
    way a corrupt cache can heal itself.
    """
    path = fetch(entry, destination)
    for attempt in (1, 2):
        try:
            # Parse from bytes, not from the path: UnityPy keeps the file open, and
            # Windows then refuses the unlink below with WinError 32.
            UnityPy.load(path.read_bytes())
            return path
        except Exception:
            if attempt == 2:
                raise
            print(f"  cached bundle {path.name} does not parse, re-downloading")
            path.unlink(missing_ok=True)
            path = fetch(entry, destination)
    return path


def glb_animation_names(path: Path) -> list[str]:
    """Read the clip names out of a gzipped GLB without a glTF library.

    A reused GLB has to declare the clips it really holds: the viewer mounts one
    button per name in the manifest and fetches on click, so a name that is not
    in the file becomes a button that loads and then does nothing.  Only the
    header and the JSON chunk are read -- the binary payload stays on disk.
    """
    with gzip.open(path, "rb") as handle:
        header = handle.read(12)
        if len(header) != 12 or header[:4] != b"glTF":
            raise ValueError(f"{path.name} is not a GLB")
        length, kind = struct.unpack("<II", handle.read(8))
        if kind != 0x4E4F534A:  # 'JSON'
            raise ValueError(f"{path.name} does not start with a JSON chunk")
        document = json.loads(handle.read(length).decode("utf-8"))
    return [clip["name"] for clip in document.get("animations", []) if clip.get("name")]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--cache-dir", type=Path,
                        default=Path(tempfile.gettempdir()) / "kirafan-model-cache")
    parser.add_argument("--gltfpack", type=Path)
    parser.add_argument("--limit", type=int, default=0, help="only build this many characters")
    parser.add_argument("--only", action="append", help="build just this model id (repeatable)")
    parser.add_argument("--scene", action="append", help="publish an exact scene's owner motion using its mapped model rig")
    parser.add_argument("--force", action="store_true", help="rebuild GLBs that already exist")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    site_root = args.site_root.resolve()
    manifest_path = site_root / "asset" / "models" / "manifest.json"
    output_root = site_root / "asset" / "models" / "skill-actions"
    animation_dir = args.cache_dir / "animations"
    gltfpack = args.gltfpack.resolve() if args.gltfpack else None
    if gltfpack and not gltfpack.is_file():
        raise SystemExit(f"gltfpack executable not found: {gltfpack}")

    request = urllib.request.Request(DATABASE_URL, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=90) as response:
        entries = json.load(response)
    by_name = {entry["name"]: entry for entry in entries
               if isinstance(entry, dict) and "name" in entry}

    models = sorted({PLAYER_MODEL.match(name).group(1) for name in by_name
                     if PLAYER_MODEL.match(name)})
    scene_models = {}
    if args.scene:
        if args.only:
            raise SystemExit("use --scene or --only, not both")
        identities = json.loads((site_root / "site/asset/battle/skill-playback.json").read_text(encoding="utf-8"))["models"]
        for model, identity in sorted(identities.items()):
            scene = (identity.get("ultimate") or {}).get("sceneId")
            if scene:
                scene_models.setdefault(scene, model)
        if any(scene not in scene_models for scene in args.scene):
            raise SystemExit("scene has no original model identity")
        models = sorted(set(args.scene))
    if args.only:
        wanted = set(args.only)
        models = [model for model in models if model in wanted]
    if args.limit:
        models = models[:args.limit]

    # Read once up front only to recover the clip names of GLBs already on disk.
    # The authoritative read happens right before the write, so a concurrent
    # writer touching other keys of the manifest survives this run.
    previous = json.loads(manifest_path.read_text(encoding="utf-8")).get("skillActions", {})

    published: dict[str, dict] = {}
    skipped = 0
    failed: list[str] = []
    for index, model in enumerate(models, 1):
        bundles = {}
        for action, template in SKILL_BUNDLES.items():
            if args.scene and action != "skill":
                continue
            entry = by_name.get(template.format(model=model))
            if entry:
                bundles[action] = entry
        if not bundles:
            skipped += 1
            continue

        output = output_root / f"model_pl_{model}" / "skill.glb"
        compressed = output.with_suffix(output.suffix + ".gz")
        if compressed.is_file() and compressed.stat().st_size and not args.force:
            # Prefer the names the previous run recorded; fall back to reading the
            # file, which is the case for every GLB built before the manifest was
            # written.  An unreadable one is treated as absent so it gets rebuilt.
            names = (previous.get(model) or {}).get("animations")
            if not names:
                try:
                    names = glb_animation_names(compressed)
                except Exception as error:
                    print(f"[{index}/{len(models)}] {model}: cached GLB unreadable "
                          f"({type(error).__name__}), rebuilding")
                    compressed.unlink(missing_ok=True)
                    names = None
            if names:
                published[model] = {
                    "file": f"{compressed.relative_to(site_root).as_posix()}"
                            f"?v={int(compressed.stat().st_mtime)}",
                    "compression": "gzip",
                    "meshopt": bool(gltfpack),
                    "animations": names,
                }
                print(f"[{index}/{len(models)}] {model}: reused "
                      f"{compressed.stat().st_size:,} bytes, {', '.join(names)}")
                continue

        model_id = scene_models[model] if args.scene else model
        model_entry = by_name[f"model/player/model_pl_{model_id}.muast"]
        # One unreadable bundle out of 1255 must not end the run.  Everything from
        # the download to the export is per-character, so a failure here costs that
        # character and nothing else; the ids are collected and reported at the end
        # so a second pass can pick them up with --only.
        try:
            model_path = fetch_parsable(model_entry,
                                        args.cache_dir / "bundles" / f"model_pl_{model_id}.muast")
            downloaded = {}
            for action, entry in bundles.items():
                downloaded[action] = fetch_parsable(entry, animation_dir / Path(entry["name"]).name)

            exporter = KirafanExporter(
                model_path,
                animation_dir,
                include_common_animations=False,
                animation_only=True,
                extra_animation_bundles=downloaded,
            )
            exporter.export(output)
        except Exception as error:
            output.unlink(missing_ok=True)
            failed.append(model)
            print(f"[{index}/{len(models)}] {model}: failed ({type(error).__name__}: {error})")
            continue
        if not exporter.published_bundle_animations:
            # Nothing retargeted: the clips named no path this model has.  Leave
            # the character out rather than shipping an empty GLB the viewer
            # would offer a dead button for.
            output.unlink(missing_ok=True)
            skipped += 1
            print(f"[{index}/{len(models)}] {model}: no clip matched the rig, skipped")
            continue
        if gltfpack:
            optimize_model(output, gltfpack)
        compressed = gzip_model(output)
        published[model] = {
            "file": f"{compressed.relative_to(site_root).as_posix()}"
                    f"?v={int(compressed.stat().st_mtime)}",
            "compression": "gzip",
            "meshopt": bool(gltfpack),
            "animations": exporter.published_bundle_animations,
        }
        print(f"[{index}/{len(models)}] {model}: {compressed.stat().st_size:,} bytes, "
              f"{', '.join(exporter.published_bundle_animations)}")

    # Re-read here rather than reusing the copy taken before the loop: this run
    # takes hours, and another writer may have updated unrelated keys meanwhile.
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    # --only and --limit build a subset, so merge instead of replacing; a full run
    # simply overwrites every key it rebuilt.
    merged = dict(manifest.get("skillActions", {})) if (args.only or args.scene or args.limit) else {}
    merged.update(published)
    manifest["skillActions"] = dict(sorted(merged.items()))
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                             encoding="utf-8")
    total = sum((output_root / f"model_pl_{model}" / "skill.glb.gz").stat().st_size
                for model in published)
    print(f"\nwrote {len(published)} skill sources ({total / 1024:.0f} KiB total), "
          f"{skipped} characters have none")
    if failed:
        print(f"{len(failed)} failed, retry with: "
              f"{' '.join('--only ' + model for model in failed)}")


if __name__ == "__main__":
    main()
