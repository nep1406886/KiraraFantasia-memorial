#!/usr/bin/env python3
"""Fetch voice cues for the 40-character roster from the CRI GitLab Pages mirror.

T04 语音落盘 (roguelike-plan.md 阶段 6): downloads とっておき voice mp3 from
`kirafan.gitlab.io/cri/buckets/voice/<sheet>/<cue>.mp3` into `site/audio/voice/`,
driven by the `voice.frames` arrays in `site/asset/battle/uniqueskill.js` for
the 41 playable identities (2026-09-16: resolved through playable-roster ->
cards-rl skillIds.chara -> skills-rl sceneId; both the evolved scene the stage
keys on and the base scene the historic pass keyed on; ひとり 46002001 has no
uniqueskill scene and stays the one documented gap).

The `link` field in every index entry points at `cri-asset.kirafan.cn` (dead,
404) — ignore it and build the Pages URL from bucket + sheet + cue instead.
File names carry a `_0` suffix: `voice_kirarajump_000` in frames becomes
`voice_kirarajump_000_0.mp3` on disk.

Self-check: every downloaded file must have the MPEG frame header `\xff\xfb`
and size >1KB. Merges into `site/asset/rl/voices.json` keyed by scene-rid string:
{<rid>: {sheet, cues: {<cue_name>: <rel_path_from_audio_voice>}}} — existing
entries are kept, never dropped.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
UNIQUESKILL_JS = ROOT / "site" / "asset" / "battle" / "uniqueskill.js"
OUT_DIR = ROOT / "site" / "audio" / "voice"
INDEX_OUT = ROOT / "site" / "asset" / "rl" / "voices.json"
PLAYABLE = ROOT / "site" / "asset" / "rl" / "playable-roster.json"
CARDS = ROOT / "site" / "asset" / "rl" / "cards-rl.json"
SKILLS = ROOT / "site" / "asset" / "rl" / "skills-rl.json"

def roster_scene_rids() -> dict[int, str]:
    """The 41 playable identities' ultimate scene rids, resolved through the
    authored chain: playable-roster row id -> cards-rl skillIds.chara ->
    skills-rl player row sceneId. The evolved scene rid (e.g. ゆの 10002001 ->
    100004) is what playUltimate hands the stage and what voices.json keys on.
    """
    roster = json.loads(PLAYABLE.read_text(encoding="utf-8"))["cards"]
    cards = {row["id"]: row for row in json.loads(CARDS.read_text(encoding="utf-8"))["cards"]}
    skills = json.loads(SKILLS.read_text(encoding="utf-8"))["player"]
    out = {}
    for row in roster:
        # Both identities of the same character: the evolved scene (what
        # playUltimate stages today) and the base scene (the historic keys the
        # first fetch pass wrote; the base mp3s stay on disk for it).
        for card_id in (row["id"], row.get("legacyId")):
            card = cards.get(card_id)
            if card is None:
                continue
            skill_id = card["skillIds"]["chara"]
            scene_id = skills[str(skill_id)]["sceneId"]
            if scene_id:
                out[str(scene_id)] = card_id
    return out

PAGES_URL = "https://kirafan.gitlab.io/cri/buckets/voice/{sheet}/{cue}_0.mp3"
ROUNDS = 5


def fetch_bytes(url: str) -> bytes:
    last_err: Exception | None = None
    for attempt in range(ROUNDS):
        try:
            req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urlopen(req, timeout=60) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(min(8, 2 ** attempt))
        try:
            proc = subprocess.run(
                ["curl", "-fsSL", "--max-time", "120", url],
                capture_output=True, timeout=150, check=False,
            )
            if proc.returncode == 0 and proc.stdout:
                return proc.stdout
        except Exception as exc:  # noqa: BLE001
            last_err = exc
        time.sleep(min(8, 2 ** attempt))
    raise RuntimeError(f"download failed after {ROUNDS} rounds: {url} ({last_err})")


def load_scenes() -> dict:
    js = UNIQUESKILL_JS.read_text(encoding="utf-8")
    m = re.search(r"window\.kirafanUniqueSkillData\s*=\s*(\{.*?\});\s*$", js, re.S)
    if not m:
        raise ValueError(f"{UNIQUESKILL_JS}: cannot find kirafanUniqueSkillData")
    return json.loads(m.group(1))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="report, write nothing")
    args = parser.parse_args()

    data = load_scenes()
    scenes = data["scenes"]

    # Collect sheet -> cues for the 41 playable identities' ultimate scenes
    scene_rids = roster_scene_rids()
    roster_voices: dict[str, dict] = {}
    for rid, card_id in sorted(scene_rids.items()):
        key = f"PL_{rid}_0"
        if key not in scenes:
            print(f"{card_id}: scene {key} not in uniqueskill.js", flush=True)
            continue
        v = scenes[key].get("voice", {})
        if not v:
            print(f"{card_id}: no voice field in scene {key}", flush=True)
            continue
        sheet = v["sheet"]
        frames = v.get("frames", [])
        cues = {cue for frame, cue in frames}
        roster_voices[rid] = {"sheet": sheet, "cues": list(sorted(cues))}
        print(f"{card_id} scene {rid}: {sheet} -> {len(cues)} cues", flush=True)

    if not roster_voices:
        print("No voice data found for roster", flush=True)
        return 1

    if not args.dry_run:
        OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Download cues
    index = {}
    failed = []
    total_bytes = 0
    for rid, rec in sorted(roster_voices.items()):
        sheet = rec["sheet"]
        cues = rec["cues"]
        sheet_dir = OUT_DIR / sheet
        if not args.dry_run:
            sheet_dir.mkdir(parents=True, exist_ok=True)
        cue_map = {}
        for cue in cues:
            fname = f"{cue}_0.mp3"
            out_path = sheet_dir / fname
            if out_path.exists() and out_path.stat().st_size > 1024:
                cue_map[cue] = f"{sheet}/{fname}"
                total_bytes += out_path.stat().st_size
                continue
            url = PAGES_URL.format(sheet=sheet, cue=cue)
            try:
                mp3 = fetch_bytes(url)
            except RuntimeError as exc:
                print(f"{rid} {cue}: FAILED ({exc})", flush=True)
                failed.append((rid, cue, str(exc)))
                continue
            if len(mp3) < 1024:
                print(f"{rid} {cue}: too small {len(mp3)}B", flush=True)
                failed.append((rid, cue, "size"))
                continue
            if not mp3.startswith(b"\xff\xfb"):
                print(f"{rid} {cue}: bad MPEG header {mp3[:4].hex()}", flush=True)
                failed.append((rid, cue, "header"))
                continue
            if not args.dry_run:
                out_path.write_bytes(mp3)
            cue_map[cue] = f"{sheet}/{fname}"
            total_bytes += len(mp3)
            print(f"{rid} {cue}: ok {len(mp3)}B", flush=True)
        index[str(rid)] = {"sheet": sheet, "cues": cue_map}

    if not args.dry_run:
        merged = {}
        if INDEX_OUT.exists():
            merged = json.loads(INDEX_OUT.read_text(encoding="utf-8"))
        merged.update(index)
        INDEX_OUT.write_text(json.dumps(merged, ensure_ascii=False, indent=1) + "\n",
                             encoding="utf-8")
        print(f"index merged: {len(merged)} entries ({len(index)} authored this pass)", flush=True)

    print(f"\n{len(index)} rids, {total_bytes / 1024 / 1024:.2f} MiB total", flush=True)
    if failed:
        print(f"{len(failed)} cues failed:", flush=True)
        for rid, cue, reason in failed[:20]:
            print(f"  {rid} {cue}: {reason}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
