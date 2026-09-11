#!/usr/bin/env python3
"""Export the roguelike's supplementary action anchors for player models.

Master plan §2.3 assumed the player can only ever play five clips
(battle_run / damage / kirarajump_0 / win_st_0 / room_idle_L) plus the class
pack. That was a limitation of the *published* model exports, not of the
assets: the shared battle bundle also carries dead, abnormal, battle_in,
battle_out and the win_lp loops, with head-rig counterparts in
common_battle_head_0 -- they were simply never merged into model.glb
(convert_kirafan_model.ACTIONS is the site's five, and the site's viewer does
not need more).

This tool publishes them once as an animation-only GLB the roguelike loads
alongside the model and binds onto the actor's existing mixer -- the same
trick asset/models/class-actions/* uses (donor rig nodes, clips that address
the common rig by name, so one file serves every character).

Clips and their game anchors (spec 01 §5.1):

    dead        死亡        (replaces "damage parked on its last frame")
    abnormal    异常状态    阶段 3 element debuffs
    battle_in   入场        room transitions (T09)
    battle_out  离场        room clear / stage exit
    win_lp_0    通关循环    pairs with the model's own win_st_0

Usage:
    python tools/rl_export_anchors.py [--model-bundle PATH] [--animation-dir PATH]

Both default to the peer pipeline's caches (.codex-tmp); they are only read.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from build_model_catalog import gzip_model
from convert_kirafan_model import KirafanExporter

ROOT = Path(__file__).resolve().parent.parent

BATTLE = ("common_battle_body.muast", "common_battle_head_0.muast")


class AnchorExporter(KirafanExporter):
    # add_animations() iterates ACTIONS; the clip key is the name after the
    # bundle's "Common_body@" / "Common_head_0@" prefix. Same bundles the five
    # published clips come from, so the channels address the same rig paths.
    ACTIONS = {
        "dead": BATTLE,
        "abnormal": BATTLE,
        "battle_in": BATTLE,
        "battle_out": BATTLE,
        "win_lp_0": BATTLE,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model-bundle", type=Path,
        default=ROOT / ".codex-tmp" / "mdl-retry" / "bundles" / "model_pl_300302.muast",
        help="donor model bundle; only its node hierarchy is exported")
    parser.add_argument(
        "--animation-dir", type=Path,
        default=ROOT / ".codex-tmp" / "anim",
        help="directory holding common_battle_body/head_0.muast")
    parser.add_argument(
        "--output", type=Path, default=ROOT / "asset" / "rl" / "anim" / "anchors.glb")
    args = parser.parse_args()

    if not args.model_bundle.is_file():
        raise SystemExit(f"donor model bundle not found: {args.model_bundle}")
    for name in BATTLE:
        if not (args.animation_dir / name).is_file():
            raise SystemExit(f"animation bundle not found: {args.animation_dir / name}")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    exporter = AnchorExporter(
        args.model_bundle,
        args.animation_dir,
        include_common_animations=True,   # runs add_animations() over ACTIONS
        animation_only=True,              # rig nodes, no meshes
    )
    exporter.export(args.output)
    compressed = gzip_model(args.output)
    published = [clip["name"] for clip in exporter.builder.document["animations"]]
    print(f"anchors: {published}")
    print(f"wrote {compressed.relative_to(ROOT)} ({compressed.stat().st_size:,} bytes)")


if __name__ == "__main__":
    sys.exit(main())
