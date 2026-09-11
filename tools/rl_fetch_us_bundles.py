#!/usr/bin/env python3
"""Fetch exact original scene bundles, never infer a scene from a model number.

Default: generated playable roster. --all: every card scene in skill-playback.json.
Downloaded bundles are size/magic checked and atomically published. The scene
and timeline exporters subsequently parse their full Unity data. The manifest's
crc is not a checksum of the downloaded bytes, so it is deliberately not used.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
BUNDLE_JSON = ROOT / ".codex-tmp/assetBundle.json"
OUT_DIR = ROOT / ".codex-tmp/pe_bundles_named"
ROSTER = [row["id"] for row in json.loads(
    (ROOT / "site/asset/rl/playable-roster.json").read_text(encoding="utf-8"))["cards"]]
ROUNDS = 3
CDN = "https://bucket-{bucket}-asset.kirafan.cn/{name}"


def scene_ids(playback: dict, card_ids=None) -> list[str]:
    """m_UniqueSkillScene is authoritative, including shared-scene identities."""
    wanted = set(card_ids) if card_ids is not None else None
    result = set()
    identities = playback["cards"] if "cards" in playback else playback["models"]
    if wanted is not None:
        missing = wanted - {row["cardId"] for row in identities.values()}
        if missing:
            raise ValueError("missing card identities: " + ", ".join(map(str, sorted(missing))))
    for identity in identities.values():
        if wanted is not None and identity["cardId"] not in wanted:
            continue
        scene = (identity.get("ultimate") or {}).get("sceneId")
        if scene is not None:
            if not str(scene).isdigit():
                raise ValueError("invalid scene identity: " + str(scene))
            result.add(str(scene))
    return sorted(result)


def fetch_bytes(url: str) -> bytes:
    last_err = None
    for attempt in range(ROUNDS):
        try:
            req = Request(url, headers={"User-Agent": "kirafan-skill-builder/1.0"})
            with urlopen(req, timeout=45) as resp:
                return resp.read()
        except HTTPError as exc:
            if exc.code == 404:
                raise RuntimeError("not found: " + url) from exc
            last_err = exc
        except Exception as exc:
            last_err = exc
        try:
            proc = subprocess.run(["curl", "-fsSL", "--max-time", "60", url],
                                  capture_output=True, timeout=70)
            if proc.returncode == 0 and proc.stdout:
                return proc.stdout
        except Exception as exc:
            last_err = exc
        time.sleep(min(4, 2 ** attempt))
    raise RuntimeError(f"download failed: {url} ({last_err})")


def valid_bundle(data: bytes, row: dict) -> bool:
    return data.startswith(b"UnityFS") and len(data) == int(row["size"])


def fetch_bundle(rid: str, row: dict) -> tuple[str, str]:
    destination = OUT_DIR / f"uniqueskill_pl_{rid}_0.muast"
    if destination.exists() and destination.stat().st_size == int(row["size"]):
        with destination.open("rb") as handle:
            if handle.read(7) == b"UnityFS":
                return rid, "cached"
    urls = [CDN.format(bucket=row["path"][-1], name=row["name"]),
            "https://asset.kirafan.cn/" + row["name"]]
    failures = []
    for url in urls:
        try:
            data = fetch_bytes(url)
            if not valid_bundle(data, row):
                raise ValueError("size or UnityFS signature mismatch")
            temporary = destination.with_suffix(".muast.part")
            temporary.write_bytes(data)
            temporary.replace(destination)
            return rid, "downloaded"
        except Exception as exc:
            failures.append(str(exc))
    raise RuntimeError(f"{rid}: " + "; ".join(failures))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--all", action="store_true")
    group.add_argument("--only", action="append", help="exact scene ID; repeatable")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    playback = json.loads((ROOT / "site/asset/battle/skill-playback.json").read_text(encoding="utf-8"))
    wanted = sorted(set(args.only)) if args.only else scene_ids(playback, None if args.all else ROSTER)
    if any(not rid.isdigit() for rid in wanted):
        parser.error("scene IDs must be numeric")
    by_name = {r["name"]: r for r in json.loads(BUNDLE_JSON.read_text(encoding="utf-8"))}
    entries = [(rid, by_name.get(f"uniqueskill/uniqueskill_pl_{rid}_0.muast")) for rid in wanted]
    missing = [rid for rid, row in entries if row is None]
    print(f"{len(wanted)} exact scenes, {len(missing)} absent from source manifest", flush=True)
    if missing:
        print("MISSING SOURCE: " + ", ".join(missing), flush=True)
        return 1
    if args.dry_run:
        print(" ".join(wanted))
        return 0
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    failed, counts = [], {"cached": 0, "downloaded": 0}
    with ThreadPoolExecutor(max_workers=max(1, min(8, args.jobs))) as pool:
        futures = {pool.submit(fetch_bundle, rid, row): rid for rid, row in entries}
        for i, future in enumerate(as_completed(futures), 1):
            try:
                rid, status = future.result()
                counts[status] += 1
            except Exception as exc:
                failed.append(futures[future])
                print("FAILED " + str(exc), flush=True)
            if i % 20 == 0 or i == len(futures):
                print(f"[{i}/{len(futures)}] {counts}, failures={len(failed)}", flush=True)
    if failed:
        print("FAILED scenes: " + ", ".join(sorted(failed)), flush=True)
    return int(bool(failed))


if __name__ == "__main__":
    sys.exit(main())
