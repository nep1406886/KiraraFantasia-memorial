#!/usr/bin/env python3
"""Publish the per-clip node visibility curves the GLB exporter cannot carry.

Every player body is authored with alternate silhouettes for the same limb --
leg_L_A/_B/_C plus a leg_L_A_2/_B_2/_C_2, hat_L against hat_R -- and exactly one
of each set is meant to be on screen at a time.  Unity switches them by toggling
the GameObject, and the game keeps that switch in its own clip format
(MeigeAnimClip.m_AnimNodeHandlerArray, target type 9) rather than in the Unity
AnimationClip.  glTF has no channel for node visibility, so
convert_kirafan_model.py drops it and the viewer ends up drawing all twelve leg
cards at once: six coincident alpha-masked layers per leg, which is what makes
the feet read as a smear.

The curves live in the shared animation bundles and address nodes by name, so
one table serves every model.  Values are 0 or 1 with stepped keys
(m_CtrlType 2), so a curve is stored as its keyframes and the viewer holds the
last key -- no interpolation.

Usage:
  python tools/build_visibility_table.py
  python tools/build_visibility_table.py --cache-dir /tmp/kirafan-model-cache
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import UnityPy  # noqa: E402

from build_model_catalog import asset_url, download  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATABASE_URL = "https://database.kirafan.cn/assetBundle.json"
HTTP_HEADERS = {"User-Agent": "kirafan-timer-model-builder/1.0"}

# MeigeAnimClip.m_AnimNodeHandlerArray[].m_Target.m_TargetType.  9 is the
# GameObject-visibility track; the transform tracks stay in the Unity clip.
TARGET_TYPE_VISIBILITY = 9

# The bundles the viewer actually plays clips from.  Class and character skill
# bundles are per-class/per-character but reuse the same node names, so they are
# folded into the same table under their exported clip names.
COMMON_BUNDLES = (
    "anim/player/common_menu_body.muast",
    "anim/player/common_battle_body.muast",
)
# The five class bundles reuse the clip names idle/attack/class_skill_1..3 but
# pose them differently, so their curves disagree -- a fighter's `attack` stands
# on leg_L_A_2 where a magician's stands on leg_L_A.  They have to stay keyed by
# class index, matching build_class_action_catalog.CLASS_SOURCES.
CLASS_NAMES = ("fighter", "magician", "priest", "knight", "alchemist")

# MeigeAnimClip names carry the rig prefix the exporter strips.
CLIP_PREFIXES = ("Common_body@", "Common_body_tight@", "Chara_Battle_body@")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-root", type=Path, default=ROOT)
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=Path(tempfile.gettempdir()) / "kirafan-model-cache",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "asset" / "models" / "visibility.json",
    )
    parser.add_argument(
        "--local-dir",
        type=Path,
        help="read bundles from here instead of downloading (for offline runs)",
    )
    return parser.parse_args()


def exported_clip_name(name: str) -> str:
    for prefix in CLIP_PREFIXES:
        if name.startswith(prefix):
            return name[len(prefix):]
    return name.split("@", 1)[-1] if "@" in name else name


def read_bundle(path: Path) -> dict[str, dict]:
    """{exported clip name: {node: [[frame, value], ...]}} for one bundle."""
    env = UnityPy.load(str(path))
    clips: dict[str, dict] = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        clip = tree.get("m_MeigeAnimClip")
        if not isinstance(clip, dict):
            continue
        nodes = clip.get("m_AnimNodeHandlerArray") or []
        if not nodes:
            continue
        tracks: dict[str, list] = {}
        for node in nodes:
            target = node.get("m_Target") or {}
            if target.get("m_TargetType") != TARGET_TYPE_VISIBILITY:
                continue
            name = str(target.get("m_TargetName") or "")
            if not name:
                continue
            keys: list[list[float]] = []
            for curve in node.get("m_Curves") or []:
                for component in curve.get("m_ComponentCurves") or []:
                    for key in component.get("m_KeyDatas") or []:
                        keys.append([
                            round(float(key["m_Frame"]), 3),
                            1 if float(key["m_Value"]) >= 0.5 else 0,
                        ])
            if not keys:
                continue
            keys.sort(key=lambda item: item[0])
            # A curve that never changes is one number, not a key list: it is
            # the common case and the table would otherwise be mostly noise.
            values = {value for _, value in keys}
            tracks[name] = keys[0][1] if len(values) == 1 else keys
        if not tracks:
            continue
        # Tight-skirt variants animate the same nodes as the plain rig; keep
        # whichever the exporter publishes under that clip name and do not let a
        # second bundle silently overwrite it.
        exported = exported_clip_name(str(clip.get("m_Name") or ""))
        clips.setdefault(exported, {}).update(tracks)
    return clips


def resolve(args: argparse.Namespace, wanted: list[str]) -> list[tuple[str, Path]]:
    paths: list[tuple[str, Path]] = []
    if args.local_dir:
        for name in wanted:
            candidate = args.local_dir / Path(name).name
            if candidate.is_file():
                paths.append((name, candidate))
            else:
                print(f"  missing locally, skipped: {name}")
        return paths
    request = urllib.request.Request(DATABASE_URL, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=90) as response:
        entries = json.load(response)
    by_name = {
        entry["name"]: entry
        for entry in entries
        if isinstance(entry, dict) and "name" in entry
    }
    for name in wanted:
        entry = by_name.get(name)
        if not entry:
            print(f"  not in the asset index, skipped: {name}")
            continue
        target = args.cache_dir / "animations" / Path(name).name
        paths.append((name, download(asset_url(entry), target)))
    return paths


def main() -> None:
    args = parse_args()
    site_root = args.site_root.resolve()

    common_paths = resolve(args, list(COMMON_BUNDLES))
    class_paths = resolve(
        args, [f"anim/player/class_{name}_body.muast" for name in CLASS_NAMES]
    )

    clips: dict[str, dict] = {}
    for name, path in common_paths:
        found = read_bundle(path)
        for clip, tracks in found.items():
            clips.setdefault(clip, {}).update(tracks)
        print(f"  {name}: {len(found)} clips")

    classes: dict[str, dict] = {}
    for index, name in enumerate(CLASS_NAMES):
        match = [p for n, p in class_paths if n.endswith(f"class_{name}_body.muast")]
        if not match:
            continue
        found = read_bundle(match[0])
        # A class bundle repeats some common clips (abnormal, damage) unchanged;
        # only the class's own actions need a per-class entry.
        own = {
            clip: tracks
            for clip, tracks in found.items()
            if clip not in clips or clips[clip] != tracks
        }
        classes[str(index)] = own
        print(f"  class {index} ({name}): {len(found)} clips, {len(own)} class-specific")

    nodes = sorted(
        {node for tracks in clips.values() for node in tracks}
        | {
            node
            for table in classes.values()
            for tracks in table.values()
            for node in tracks
        }
    )
    payload = {
        "version": 1,
        "stamp": int(time.time()),
        "meta": {
            "source": "MeigeAnimClip.m_AnimNodeHandlerArray target type 9",
            "bundles": [name for name, _ in common_paths + class_paths],
            "note": "value 1 = visible; keys are stepped, hold the last key",
            "classes": list(CLASS_NAMES),
        },
        "nodes": nodes,
        "clips": {name: clips[name] for name in sorted(clips)},
        "classClips": {
            index: {name: table[name] for name in sorted(table)}
            for index, table in sorted(classes.items())
        },
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with io.open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")

    manifest_path = site_root / "asset" / "models" / "manifest.json"
    with io.open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    relative = args.out.relative_to(site_root).as_posix()
    manifest["visibility"] = f"{relative}?v={payload['stamp']}"
    with io.open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")

    animated = sum(
        1
        for table in [clips] + list(classes.values())
        for tracks in table.values()
        for value in tracks.values()
        if isinstance(value, list)
    )
    class_clips = sum(len(table) for table in classes.values())
    print(
        f"wrote {args.out} : {len(clips)} shared clips, {class_clips} class clips, "
        f"{len(nodes)} nodes, {animated} animated tracks"
    )


if __name__ == "__main__":
    main()
