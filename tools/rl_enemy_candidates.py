#!/usr/bin/env python3
"""B.1 敌人扩表候选清单: 从 enemies.json 的未用行里筛出符合
 encounters 配额的候选 (animated rig / element 配比 / shadowScale / 故事名).

Usage: python tools/rl_enemy_candidates.py [--vol N] [--out PATH]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# clip-empty rigs (memory + GLB probes): never pick these.
CLIP_EMPTY = {
    "model/enemy/model_en_12600.muast", "model/enemy/model_en_12700.muast",
    "model/enemy/model_en_13300.muast", "model/enemy/model_en_13800.muast",
    "model/enemy/model_en_15000.muast", "model/enemy/model_en_8400.muast",
    "model/enemy/model_en_10001.muast", "model/enemy/model_en_10002.muast",
}
# manifest lies for some rows (8400 flagged animated but GLB has 0 clips):
# also demand the GLB itself carry an animations chunk. Quick probe: does the
# GLB declare any animation in its JSON chunk?
def glb_has_animation(path: Path) -> bool:
    try:
        import gzip, struct
        with gzip.open(path, "rb") as fh:
            head = fh.read(20)
            if len(head) < 20 or head[:4] != b"glTF":
                return False
            total = struct.unpack("<I", head[4:8])[0]
            chunk_len = struct.unpack("<I", head[8:12])[0]
            chunk_type = head[12:16]
            if chunk_type != b"JSON":
                return False
            body = gzip.open(path, "rb").read(20 + chunk_len)[20:]
            doc = json.loads(body.decode("utf-8", "replace"))
            return bool(doc.get("animations"))
    except Exception:
        return False

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vol", type=int, default=0, help="只看某一卷 (1-5)")
    ap.add_argument("--out", type=str, default="", help="写 JSON 到该路径")
    args = ap.parse_args()

    enemies = json.loads((ROOT / "site/asset/rl/enemies.json").read_text(encoding="utf8"))["enemies"]
    manifest = json.loads((ROOT / "site/asset/models/manifest.json").read_text(encoding="utf8"))["models"]
    enc = json.loads((ROOT / "site/asset/rl/encounters.json").read_text(encoding="utf8"))

    used_ids = set()
    used_models = set()
    for vol in enc["volumes"]:
        for spec in [vol["boss"]] + list(vol.get("elites") or []) + list(vol.get("mobs") or []):
            used_ids.add(spec["id"])
            used_models.add(spec["model"])
            split = spec.get("splitInto")
            if split:
                used_models.add(split["model"])

    # Skip rows whose model is already in the encounter tables at all.
    candidates = []
    for row in enemies:
        model = row.get("model")
        if not model or model in used_models or model in CLIP_EMPTY:
            continue
        mrow = manifest.get(model)
        if not mrow or not mrow.get("animations"):
            continue
        shadow = row.get("shadowScale") or 0
        if not (1.2 <= shadow <= 3.5):
            continue
        candidates.append({
            "id": row["id"], "name": row.get("name"),
            "nameZh": row.get("nameZh"), "model": model,
            "element": row.get("element"), "isBoss": bool(row.get("isBoss")),
            "shadowScale": shadow, "voice": row.get("voiceCueSheet") or "",
            "skills": row.get("skillIds") or [],
        })

    # group by element for quota-based manual review
    by_el: dict[int, list] = {}
    for c in candidates:
        by_el.setdefault(c["element"], []).append(c)

    target_vol = args.vol
    out = {"per_element": {}, "animated_check": "manifest-only (GLB probe on demand)"}
    for el in sorted(by_el):
        rows = by_el[el]
        out["per_element"][str(el)] = {
            "count": len(rows),
            "bosses": [r for r in rows if r["isBoss"]][:40],
            "mobs": [r for r in rows if not r["isBoss"]][:60],
        }

    if args.out:
        Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf8")
        print("written", args.out)
    else:
        for el, group in out["per_element"].items():
            print(f"--- element {el}: {group['count']} candidates")
            print("  bosses:", ", ".join(f'{r["id"]} {r["nameZh"] or r["name"]} s{r["shadowScale"]}'
                                        for r in group["bosses"][:12]))
            print("  mobs:", ", ".join(f'{r["id"]} {r["nameZh"] or r["name"]} s{r["shadowScale"]}'
                                       for r in group["mobs"][:12]))
    return 0

if __name__ == "__main__":
    sys.exit(main())
