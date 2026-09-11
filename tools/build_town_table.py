#!/usr/bin/env python3
"""Build asset/town/buildings.js from the game's own TownObjectList.

Japanese strings come straight out of the game database and are never edited
here.  Chinese strings live in tools/town_zh.json, a hand-written overlay keyed
by m_ID, so that regenerating from a newer database dump never clobbers a
translation.  Anything missing from the overlay falls back to the Japanese text
and is reported, so gaps are visible instead of silent.

Usage:
    python tools/build_town_table.py [--db .codex-tmp/db/TownObjectList.raw]
"""

import argparse
import io
import json
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# m_Category values, confirmed by inspecting the 53 live entries.
CATEGORY = {
    0: "myroom",    # マイルーム (1 entry)
    1: "material",  # ぶき素材生産所
    2: "coin",      # コイン生産所
    4: "plot",      # 汎用エリア -- empty buildable ground
    5: "training",  # class training grounds (5, one per class)
    6: "title",     # per-work buildings (38, one per title)
    7: "facility",  # quest gate, shops, summon hall, ... (6)
}

# m_ClassID is -1 on the training grounds, so the class link has to come from
# the name.  Order matches core/cards.js CLASSES.
TRAINING_CLASS = {
    140000: 0,  # せんし
    140100: 1,  # まほうつかい
    140200: 3,  # ナイト
    140300: 2,  # そうりょ
    140400: 4,  # アルケミスト
}


def asset_ids(row, kind):
    """Model ids for a row, verified against assetBundle.json (54/54 resolve).

    Asset names are always 6 digits: `prefab/town/building/bld_<id>_<variant>`.
    The 4-digit facility m_IDs are scaled by 100 (1200 -> 120000).  マイルーム
    is special: m_ID 0, but ships as bld_100000/1/2, one per m_MaxLevel.  The
    empty plot has no model, and the facilities visible in town are also baked
    into the field scene (prefab/town/field/bg_town_00_*).
    """
    if kind == "myroom":
        return [100000, 100001, 100002]
    if kind == "plot":
        return []
    bid = row["m_ID"]
    return [bid * 100 if bid < 100000 else bid]


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_titles():
    """Pull the title table out of asset/gacha/cards.js (single source of truth)."""
    path = os.path.join(ROOT, "asset", "gacha", "cards.js")
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    blob = src[src.index("{"):].rstrip().rstrip(";")
    data = json.loads(blob)
    return {t["id"]: t for t in data["titles"]}


def clean(text):
    """DB text wraps with hard newlines for the original UI width; unwrap it."""
    if not text:
        return ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # A trailing full-width space or stray blank lines show up in a few rows.
    lines = [ln.strip().strip("　") for ln in text.split("\n")]
    return "\n".join(ln for ln in lines if ln)


def build(db_path, zh_path, out_path):
    rows = load_json(db_path)
    titles = load_titles()
    zh = load_json(zh_path) if os.path.exists(zh_path) else {}
    # Descriptions we authored for rows the game shipped with a placeholder.
    written = zh.get("_written", {})

    buildings = []
    missing = []
    for row in sorted(rows, key=lambda r: (r["m_Category"], r["m_ID"])):
        bid = row["m_ID"]
        kind = CATEGORY.get(row["m_Category"])
        if kind is None:
            print("skip: unknown m_Category %s on %s" % (row["m_Category"], bid))
            continue

        name_ja = row["m_ObjName"]
        detail_ja = clean(row["m_DetailText"])
        # "効果" and "説明文" are placeholder strings left in the shipped data.
        if detail_ja in ("効果", "説明文"):
            detail_ja = ""

        over = zh.get(str(bid), {})
        entry = {
            "id": bid,
            "kind": kind,
            "resource": row["m_ResourceID"],
            "name": {"ja": name_ja, "zh": over.get("name") or name_ja},
        }
        if detail_ja:
            entry["detail"] = {"ja": detail_ja, "zh": over.get("detail") or detail_ja}
            if not over.get("detail"):
                missing.append((bid, name_ja))
        elif str(bid) in written:
            w = written[str(bid)]
            entry["detail"] = {"ja": w["ja"], "zh": w["zh"]}
            entry["ours"] = True
        else:
            missing.append((bid, name_ja))

        if row["m_TitleType"] >= 0:
            entry["title"] = row["m_TitleType"]
            t = titles.get(row["m_TitleType"])
            if t:
                entry["work"] = {"ja": t["name"], "zh": t.get("nameZh") or t["name"]}
            else:
                print("warn: titleType %s on %s has no title row"
                      % (row["m_TitleType"], bid))
        if bid in TRAINING_CLASS:
            entry["classId"] = TRAINING_CLASS[bid]

        aids = asset_ids(row, kind)
        if aids:
            # Two appearance tiers ship per building (_0 low, _1 high).
            entry["models"] = ["prefab/town/building/bld_%d_%d" % (a, v)
                               for a in aids for v in (0, 1)]
            entry["icon"] = "texture/townobjecticon/townobjecticon_bld_%d" % aids[0]

        # Layout hints the original town used to place the model on its plot.
        entry["layout"] = {
            "size": row["m_BaseSize"],
            "offset": [row["m_OffsetX"], row["m_OffsetY"]],
            "marker": row["m_MarkerPos"],
        }
        if row["m_MaxLevel"]:
            entry["maxLevel"] = row["m_MaxLevel"]
        if row["m_EntryCharaNum"]:
            entry["slots"] = row["m_EntryCharaNum"]
        if row["m_ScheduleTagLink"]:
            entry["schedule"] = row["m_ScheduleTagLink"]
        buildings.append(entry)

    payload = {
        "meta": {
            "source": "https://database.kirafan.cn/database/TownObjectList.json",
            "count": len(buildings),
            "note": "Japanese text is verbatim game data. Chinese is a hand "
                    "overlay from tools/town_zh.json.",
        },
        "buildings": buildings,
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("// Generated by tools/build_town_table.py. Do not edit by hand.\n")
        fh.write("// Chinese strings are maintained in tools/town_zh.json.\n")
        fh.write("window.kirafanTownData = ")
        json.dump(payload, fh, ensure_ascii=False, indent=1)
        fh.write(";\n")

    print("wrote %s (%d buildings)" % (os.path.relpath(out_path, ROOT), len(buildings)))
    by_kind = {}
    for b in buildings:
        by_kind[b["kind"]] = by_kind.get(b["kind"], 0) + 1
    print("  by kind:", ", ".join("%s=%d" % kv for kv in sorted(by_kind.items())))
    if missing:
        print("  %d entries still need Chinese:" % len(missing))
        for bid, name in missing:
            print("    %s %s" % (bid, name))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(ROOT, ".codex-tmp", "db",
                                                 "TownObjectList.raw"))
    ap.add_argument("--zh", default=os.path.join(ROOT, "tools", "town_zh.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "asset", "town",
                                                  "buildings.js"))
    args = ap.parse_args()
    if not os.path.exists(args.db):
        print("missing db dump: %s" % args.db)
        return 1
    build(args.db, args.zh, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
