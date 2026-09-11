#!/usr/bin/env python3
"""Publish per-model rarity and とっておき ownership for the WebGL viewer.

The viewer was offering the 必杀演出 group to every model that happened to have
an exported skill clip.  That is wrong: the game only grants a とっておき from ★4
up.  Two tables answer it, and they have to be read together:

  CharacterList.m_Rare        0-based, so 2/3/4 == ★3/★4/★5.  Covers all 1255
                              player resource ids.
  SkillList_PL.m_UniqueSkillScene  the cinematic the ultimate plays.  Present for
                              every ★4/★5 in the dump and absent for every ★3.

Neither alone is enough.  m_Rare covers everyone but does not say whether the
ultimate was ever authored; the scene list says so exactly but the database dump
predates ~34 late characters (ぼっち・ざ・ろっく, 【第2部】, some 【温泉】), whose
skill rows are missing entirely -- their m_CharaSkillID is not even in
SkillList_PL.  Gating on the scene alone would strip the ultimate from
characters that plainly have one in game.

So: rarity is the gate, and the scene list is the corroboration.  A model gets
the ultimate when m_Rare >= 3 (★4+).  Where a scene exists we record it, because
the viewer wants the skill name and the SE/voice frames for the presentation.

Output: asset/models/rarity.json
    {"version": 1,
     "meta": {...},
     "models": {"130402": {"rarity": 4, "totteoki": true, "scene": "PL_130402_0"},
                ...}}

Usage:
    python tools/build_rarity_table.py
    python tools/build_rarity_table.py --characters .codex-tmp/db/CharacterList.json
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHARACTER_URL = "https://database.kirafan.cn/database/CharacterList.json"
HTTP_HEADERS = {"User-Agent": "kirafan-timer-rarity-builder/1.0"}
# CharacterList.m_Rare is 0-based; the UI and every wiki count stars from 1.
RARITY_OFFSET = 1
# ★4 is the lowest rarity the game gives a とっておき to.
TOTTEOKI_MIN_RARITY = 4
PLAYER_MODEL = re.compile(r"^model/player/model_pl_(\d+)\.muast$")
SCENE_KEY = re.compile(r"^PL_(\d+)_\d+$")


def read_characters(path: Path | None) -> list[dict]:
    """Prefer a local dump; fall back to the database host."""
    if path and path.exists():
        print(f"  characters <- {path}")
        return json.loads(path.read_text("utf-8"))
    print(f"  characters <- {CHARACTER_URL}")
    request = urllib.request.Request(CHARACTER_URL, headers=HTTP_HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def read_scenes(path: Path) -> dict[str, dict]:
    """site/asset/battle/uniqueskill.js is a JS assignment, not JSON."""
    if not path.exists():
        print(f"  ! {path.relative_to(ROOT)} missing; scene corroboration skipped")
        return {}
    text = path.read_text("utf-8")
    start = text.index("{")
    payload = json.loads(text[start:text.rindex("}") + 1])
    print(f"  scenes     <- {path.relative_to(ROOT)}")
    return payload.get("scenes", {})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--characters", type=Path,
                        default=ROOT / ".codex-tmp" / "db" / "CharacterList.json",
                        help="local CharacterList.json; downloaded when absent")
    parser.add_argument("--uniqueskill", type=Path,
                        default=ROOT / "asset" / "battle" / "uniqueskill.js")
    parser.add_argument("--manifest", type=Path,
                        default=ROOT / "asset" / "models" / "manifest.json")
    parser.add_argument("--out", type=Path,
                        default=ROOT / "asset" / "models" / "rarity.json")
    args = parser.parse_args()

    print("reading sources")
    characters = read_characters(args.characters)
    scenes = read_scenes(args.uniqueskill)
    manifest = json.loads(args.manifest.read_text("utf-8"))

    # A resource id can appear on several rows (one per costume/class variant).
    # They share the model, so take the highest rarity any row grants it.
    rarity: dict[str, int] = {}
    for row in characters:
        key = str(row["m_ResourceID"])
        rarity[key] = max(rarity.get(key, 0), row["m_Rare"] + RARITY_OFFSET)

    scene_of: dict[str, str] = {}
    for key in scenes:
        match = SCENE_KEY.match(key)
        if match:
            scene_of.setdefault(match.group(1), key)

    model_ids = sorted(match.group(1) for match in
                       (PLAYER_MODEL.match(name) for name in manifest["models"])
                       if match)
    clip_ids = {key.replace("model_pl_", "") for key, entry
                in manifest.get("skillActions", {}).items()
                if "skill" in entry.get("animations", [])}

    models: dict[str, dict] = {}
    histogram: collections.Counter = collections.Counter()
    missing_rarity = []
    for model_id in model_ids:
        stars = rarity.get(model_id)
        if stars is None:
            missing_rarity.append(model_id)
            continue
        entry: dict = {"rarity": stars, "totteoki": stars >= TOTTEOKI_MIN_RARITY}
        scene = scene_of.get(model_id)
        if scene:
            entry["scene"] = scene
        models[model_id] = entry
        histogram[(stars, entry["totteoki"])] += 1

    # Both directions of disagreement between the gate and the shipped assets.
    over = sorted(mid for mid in clip_ids
                  if mid in models and not models[mid]["totteoki"])
    under = sorted(mid for mid in models
                   if models[mid]["totteoki"] and mid not in clip_ids)
    stale = sorted(mid for mid in models
                   if models[mid]["totteoki"] and "scene" not in models[mid])

    payload = {
        "version": 1,
        "stamp": int(time.time()),
        "meta": {
            "source": "CharacterList.m_Rare + SkillList_PL.m_UniqueSkillScene",
            "note": "m_Rare is 0-based in the game table; rarity here is 1-based "
                    "stars. totteoki is rarity >= %d, which is the game's own rule; "
                    "scene is present only where the database dump still carries "
                    "the skill row." % TOTTEOKI_MIN_RARITY,
            "models": len(models),
            "totteoki": sum(1 for e in models.values() if e["totteoki"]),
            "scenes": sum(1 for e in models.values() if "scene" in e),
        },
        "models": models,
    }
    args.out.write_text(json.dumps(payload, ensure_ascii=False,
                                   separators=(",", ":"), sort_keys=True) + "\n",
                        encoding="utf-8")

    # Point the manifest at it, the way build_facial_table.py does for
    # facialActions, so the viewer gets a cache-busted URL from one place.
    relative = args.out.relative_to(ROOT).as_posix()
    manifest["rarity"] = f"{relative}?v={payload['stamp']}"
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                             encoding="utf-8")

    print(f"\nwrote {args.out.relative_to(ROOT)}  "
          f"{len(models)} models, {payload['meta']['totteoki']} with a とっておき")
    print("  (stars, totteoki) -> count")
    for key in sorted(histogram):
        print(f"    {key}: {histogram[key]}")
    if missing_rarity:
        print(f"  ! {len(missing_rarity)} models absent from CharacterList: "
              f"{missing_rarity[:8]}")
    print(f"  exported clip the gate now hides (★3): {len(over)} {over[:6]}")
    print(f"  gate allows but no clip exported:      {len(under)} {under[:6]}")
    print(f"  ★4+ whose skill row postdates the dump: {len(stale)} {stale[:6]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
