#!/usr/bin/env python3
"""Fetch voice cues for the 40-character roster from the CRI GitLab Pages mirror.

T04 语音落盘 (roguelike-plan.md 阶段 6): downloads とっておき voice mp3 from
`kirafan.gitlab.io/cri/buckets/voice/<sheet>/<cue>.mp3` into `audio/voice/`,
driven by the `voice.frames` arrays in `site/asset/battle/uniqueskill.js` for the
39 playable roster rids (ひとり 46002000 has no uniqueskill scene and is the
only exception in the 40-character roster).

The `link` field in every index entry points at `cri-asset.kirafan.cn` (dead,
404) — ignore it and build the Pages URL from bucket + sheet + cue instead.
File names carry a `_0` suffix: `voice_kirarajump_000` in frames becomes
`voice_kirarajump_000_0.mp3` on disk.

Self-check: every downloaded file must have the MPEG frame header `\xff\xfb`
and size >1KB. Outputs `site/asset/rl/voices.json` keyed by rid-string:
{<rid>: {sheet, cues: {<cue_name>: <rel_path_from_audio_voice>}}}.
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
UNIQUESKILL_JS = ROOT / "asset" / "battle" / "uniqueskill.js"
OUT_DIR = ROOT / "audio" / "voice"
INDEX_OUT = ROOT / "asset" / "rl" / "voices.json"

ROSTER_RIDS = [
    100001, 180001, 140001, 300001, 230001, 150001, 350001, 110101, 380001, 240001,
    200001, 320001, 290001, 470001, 280001, 310001, 210001, 190001, 370001, 340001,
    390001, 250201, 260001, 360001, 140101, 120001, 270001, 410001, 430001, 420001,
    330101, 170001, 160001, 450001, 400001, 130001, 220001, 230101, 321701,
]

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

    # Collect sheet → cues for all roster rids
    roster_voices: dict[int, dict] = {}
    for rid in ROSTER_RIDS:
        key = f"PL_{rid}_0"
        if key not in scenes:
            print(f"{rid}: scene {key} not in uniqueskill.js", flush=True)
            continue
        v = scenes[key].get("voice", {})
        if not v:
            print(f"{rid}: no voice field in scene {key}", flush=True)
            continue
        sheet = v["sheet"]
        frames = v.get("frames", [])
        cues = {cue for frame, cue in frames}
        roster_voices[rid] = {"sheet": sheet, "cues": list(sorted(cues))}
        print(f"{rid}: {sheet} → {len(cues)} cues", flush=True)

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
        INDEX_OUT.write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n",
                             encoding="utf-8")

    print(f"\n{len(index)} rids, {total_bytes / 1024 / 1024:.2f} MiB total", flush=True)
    if failed:
        print(f"{len(failed)} cues failed:", flush=True)
        for rid, cue, reason in failed[:20]:
            print(f"  {rid} {cue}: {reason}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
