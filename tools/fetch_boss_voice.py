#!/usr/bin/env python3
"""Fetch the boss opening voice (voice_400) for the 21 voiced enemy resources.

spec/05 §6 rule 5 / plan line 852: the original plays `voice_400` on the
enemy party at eMainStep.WarningStart (BattleSystem.cs:3777), resolved per
enemy through CharacterHandler.PlayVoice → the row's m_VoiceCueSheetName.
EnemyResourceList.json has exactly 21 rows carrying a sheet name; they share
18 distinct sheets (1300+1301 → 012, 1700+4300 → 008, 8300+8400 → 018,
6600 → Voice_Misc_000).

CRI sheets carry the cue as variants `voice_400_0` / `voice_400_1` (the
middleware picks one at random), so both are downloaded and the game picks
one at playback. Files land in `audio/voice/<sheet>/<name>.mp3`; the
manifest `site/asset/rl/bossvoices.json` maps every resource ID to its sheet and
every sheet to its local variant files.

The `link` field in the index points at cri-asset.kirafan.cn (dead) — the
Pages URL is built from bucket + sheet + name instead. Self-check: MPEG
frame header `\xff\xfb`, size >1KB.
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
RAW_LIST = ROOT / "asset" / "rl" / "_raw" / "EnemyResourceList.json"
OUT_DIR = ROOT / "audio" / "voice"
INDEX_OUT = ROOT / "asset" / "rl" / "bossvoices.json"

BASE_URL = "https://kirafan.gitlab.io/cri/buckets/voice"
CUE_RE = re.compile(r"^voice_400_\d+$")
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="report, write nothing")
    args = parser.parse_args()

    raw = json.loads(RAW_LIST.read_text(encoding="utf-8"))
    resources: dict[str, str] = {}
    for row in raw:
        sheet = row.get("m_VoiceCueSheetName")
        if sheet:
            resources[str(row["m_ResourceID"])] = sheet
    sheets = sorted(set(resources.values()))
    print(f"{len(resources)} voiced resources -> {len(sheets)} sheets", flush=True)

    if not args.dry_run:
        OUT_DIR.mkdir(parents=True, exist_ok=True)

    manifest = {"cue": "voice_400", "resources": resources, "sheets": {}}
    failed = []
    total_bytes = 0
    for sheet in sheets:
        idx_url = f"{BASE_URL}/{sheet}/index.json"
        try:
            entries = json.loads(fetch_bytes(idx_url))
        except RuntimeError as exc:
            print(f"{sheet}: index FAILED ({exc})", flush=True)
            failed.append((sheet, "index", str(exc)))
            continue
        names = sorted(e["name"] for e in entries
                       if e.get("type") == "mp3" and CUE_RE.match(e.get("name", "")))
        if not names:
            print(f"{sheet}: no voice_400 variants in index", flush=True)
            failed.append((sheet, "variants", "none in index"))
            continue
        sheet_dir = OUT_DIR / sheet
        if not args.dry_run:
            sheet_dir.mkdir(parents=True, exist_ok=True)
        files = []
        for name in names:
            fname = f"{name}.mp3"
            out_path = sheet_dir / fname
            if out_path.exists() and out_path.stat().st_size > 1024:
                files.append(f"{sheet}/{fname}")
                total_bytes += out_path.stat().st_size
                continue
            url = f"{BASE_URL}/{sheet}/{fname}"
            try:
                mp3 = fetch_bytes(url)
            except RuntimeError as exc:
                print(f"{sheet}/{name}: FAILED ({exc})", flush=True)
                failed.append((sheet, name, str(exc)))
                continue
            if len(mp3) < 1024:
                print(f"{sheet}/{name}: too small {len(mp3)}B", flush=True)
                failed.append((sheet, name, "size"))
                continue
            if not mp3.startswith(b"\xff\xfb"):
                print(f"{sheet}/{name}: bad MPEG header {mp3[:4].hex()}", flush=True)
                failed.append((sheet, name, "header"))
                continue
            if not args.dry_run:
                out_path.write_bytes(mp3)
            files.append(f"{sheet}/{fname}")
            total_bytes += len(mp3)
            print(f"{sheet}/{name}: ok {len(mp3)}B", flush=True)
        if files:
            manifest["sheets"][sheet] = {"files": files}

    if not args.dry_run:
        INDEX_OUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n",
                             encoding="utf-8")

    print(f"\n{len(manifest['sheets'])}/{len(sheets)} sheets, "
          f"{total_bytes / 1024 / 1024:.2f} MiB total", flush=True)
    if failed:
        print(f"{len(failed)} failure(s):", flush=True)
        for sheet, name, reason in failed[:20]:
            print(f"  {sheet} {name}: {reason}", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
