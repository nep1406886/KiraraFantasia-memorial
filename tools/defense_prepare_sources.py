"""Prepare independently audited assets for the Etowaria defense P0 scene.

Original inputs stay read-only. New downloads belong to .cache/etowaria-defense,
and exports go only to site/etowaria-defense or its documentation directory.
"""
from collections import Counter
from hashlib import sha256
import argparse
import gzip
import json
from pathlib import Path
import shutil
import urllib.request

from PIL import Image
import UnityPy

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = SITE / "etowaria-defense"
CACHE = ROOT / ".cache" / "etowaria-defense"
DOC = ROOT / "docs" / "etowaria-defense"
ROOM_BUNDLES = [
    "prefab/room/background/background_1006_0.muast",
    "prefab/room/background/background_1013_0.muast",
    "prefab/room/background/background_1013_1.muast",
    "prefab/room/floor/floor_1010_m.muast",
    "prefab/room/floor/floor_1012_m_0.muast",
    "prefab/room/floor/floor_1013_m.muast",
    "prefab/room/desk/desk_1001.muast",
    "prefab/room/goods/goods_1001.muast",
    "prefab/room/goods/goods_1043.muast",
    "prefab/room/hobby/hobby_1014.muast",
]
ROLES = [
    ("珠辉", "同路输出", 100), ("凛", "水魔法加速", 175),
    ("咏深", "越障抛投", 200), ("智乃", "蓄力会心", 250),
    ("莓香", "周期连发", 200), ("琴音", "炎魔法范围", 225),
    ("心爱", "近战破防", 75), ("透", "蓄力重击", 150),
    ("可怜", "会心支援", 175), ("玛莉", "睡眠特攻", 175),
    ("千矢", "低费挡线", 75), ("安奈", "持续承伤", 125),
    ("遥", "屏障拦截", 175), ("花小泉杏", "净化承伤", 200),
    ("由乃", "单体治疗", 125), ("由纪", "周期治疗阵", 150),
    ("薰子", "净化异常", 125), ("鸣", "节奏支援", 175),
    ("小春", "迟缓蓄力", 150), ("纱路", "削弱魔防", 175),
    ("渚", "破防与睡眠", 150), ("米拉", "干扰蓄力", 175),
    ("町子凉", "饥饿与收割", 175), ("兰普", "关键目标束缚", 175),
]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def registry(copy_ui=True):
    evidence = read(DOC / "research/card-source-evidence.json")["units"]
    manifest = read(SITE / "asset/models/manifest.json")
    playback = read(SITE / "asset/battle/skill-playback.json")
    ui_source = DOC / "research/original-ui"
    target = OUT / "assets/ui"
    if copy_ui:
        target.mkdir(parents=True, exist_ok=True)
        for file in (ui_source / "sprites").glob("*.png"):
            shutil.copy2(file, target / file.name)
        ui = {r["name"]: r for r in read(ui_source / "ui-sprites.json") if r["atlas"] == "commonuiatlas"}
        write(OUT / "data/ui.json", {name: ui[name] for name in sorted(p.stem for p in target.glob("*.png"))})

    units, keys, action_keys, skill_keys = [], set(), set(), set()
    classes = ["战士", "魔法使", "僧侣", "骑士", "炼金术士"]
    elements = ["炎", "水", "土", "风", "月", "阳"]
    for row, (short_name, role, cost) in zip(evidence, ROLES, strict=True):
        raw = row["rawCard"]
        rid, cid = row["resourceId"], row["cardId"]
        keys.add(f"model/player/model_pl_{rid}.muast")
        keys.add(f"model/weapon/wpn_{1000 + row['classId'] * 100}.muast")
        action_keys.add(f"{row['classId']}:{raw['m_HeadID']}")
        skill_keys.add(str(rid))
        units.append({
            "id": row["unitId"], "cardId": cid, "resourceId": rid,
            "name": row["displayNameZh"].replace(" ", "").replace("風色", "风色"), "shortName": short_name,
            "originalName": row["originalName"], "work": row["workZh"],
            "classId": row["classId"], "className": classes[row["classId"]],
            "elementId": row["elementId"], "elementName": elements[row["elementId"]],
            "headId": raw["m_HeadID"], "displayScale": raw["m_DispScale"], "role": role, "plannedCost": cost,
            "icon": f"asset/img/rl/icon/{cid}.webp",
            "card": f"asset/img/rl/card/{cid}.webp" if row["assets"]["availability"]["fullArt"] else None,
            "skills": [{"id": s["id"], "name": s["definition"]["m_SkillName"],
                        "detail": s["definition"]["m_SkillDetail"], "graphics": s["definition"]["m_SAG"],
                        "effects": (s.get("content") or {}).get("m_Datas", [])}
                       for s in row["skills"]],
            "voice": row["assets"]["voice"], "ultimateScene": row["assets"]["uniqueScene"],
        })
    for rid in (10000, 10100, 10200):
        keys.add(f"model/enemy/model_en_{rid}.muast")
    missing = keys - manifest["models"].keys()
    if missing:
        raise ValueError("Missing exact models: " + str(sorted(missing)))
    subset = {"version": manifest["version"], "models": {k: manifest["models"][k] for k in sorted(keys)},
              "classActions": {k: manifest["classActions"][k] for k in sorted(action_keys)},
              "skillActions": {k: manifest["skillActions"][k] for k in sorted(skill_keys) if k in manifest["skillActions"]},
              "facialActions": manifest["facialActions"], "visibility": manifest["visibility"]}
    for value in [*subset["models"].values(), *subset["classActions"].values(), *subset["skillActions"].values()]:
        if not (SITE / value["file"].split("?")[0]).is_file():
            raise ValueError("Asset not on disk: " + value["file"])
    write(OUT / "data/models.json", subset)
    write(OUT / "data/units.json", {"version": 1, "phase": "P0 visual study",
          "defaultParty": ["U01", "U07", "U11", "U12", "U15", "U19"], "units": units})
    write(OUT / "data/playback.json", {str(unit["cardId"]): playback["cards"][str(unit["cardId"])] for unit in units})
    native = read(SITE / "asset/rl/native/index.json")
    write(OUT / "data/native.json", {k: native[k] for k in ("effects", "graphics", "skills", "furniture", "buildings", "trails")})
    print(f"Registry: {len(units)} exact cards, {len(keys)} models; UI sprites copied")


def fetch(row):
    file = CACHE / row["name"]
    if not file.exists():
        url = f"https://bucket-{row['path'][-1]}-asset.kirafan.cn/{row['name']}"
        req = urllib.request.Request(url, headers={"User-Agent": "kirafan-timer-defense/1.0"})
        with urllib.request.urlopen(req, timeout=45) as response:
            payload = response.read()
        if not payload.startswith(b"UnityFS"):
            raise ValueError("Not an original Unity bundle: " + row["name"])
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(payload)
    return file


def room_sources():
    from export_uniqueskill_scene import SceneExporter
    rows = {r["name"]: r for r in read(ROOT / ".codex-tmp/assetBundle.json")}
    entries = {}
    for name in ROOM_BUNDLES:
        if name not in rows:
            raise ValueError("Unknown original bundle: " + name)
        file = fetch(rows[name])
        env = UnityPy.load(str(file))
        stem = file.stem
        info = {"bundle": name, "sha256": sha256(file.read_bytes()).hexdigest(),
                "objects": dict(Counter(o.type.name for o in env.objects)), "images": []}
        image_dir = OUT / "assets/room" / stem
        image_dir.mkdir(parents=True, exist_ok=True)
        for obj in env.objects:
            if obj.type.name not in ("Sprite", "Texture2D"):
                continue
            item = obj.read()
            image = item.image.convert("RGBA")
            dest = image_dir / (item.m_Name.replace("/", "_") + ".png")
            image.save(dest)
            info["images"].append({"name": item.m_Name, "file": dest.relative_to(SITE).as_posix(),
                                   "width": image.width, "height": image.height, "type": obj.type.name})
        if info["objects"].get("Mesh", 0):
            blob, stats = SceneExporter(file, timeline={"channels": []}).export()
            dest = OUT / "assets/native" / (stem + ".glb.gz")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(gzip.compress(blob, mtime=0))
            info.update({"file": dest.relative_to(SITE).as_posix(), "compression": "gzip", "stats": stats})
        entries[stem] = info
        print(stem, json.dumps(info["objects"]), flush=True)
        write(OUT / "data/room-assets.json", entries)
    print("Room source export complete; visual inspection is still required")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--room", action="store_true")
    parser.add_argument("--data-only", action="store_true", help="leave audited UI sprite framing untouched")
    args = parser.parse_args()
    registry(copy_ui=not args.data_only)
    if args.room:
        room_sources()


if __name__ == "__main__":
    main()
