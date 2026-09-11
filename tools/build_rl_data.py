#!/usr/bin/env python3
"""Merge the raw kirafan tables into the shipped roguelike data (T01).

    python tools/build_rl_data.py

Input  asset/rl/_raw/            (tools/fetch_database.py -- gitignored cache)
       asset/gacha/cards.js      (685 cards, the play roster's identity)
       asset/models/manifest.json (604 enemy model keys)
Output asset/rl/cards-rl.json    card -> six-stat truth, joined with names
       asset/rl/growth.json      Lv1-100 x 5 growth curves
       asset/rl/weapons-rl.json  class defaults + weapon skills + affix passives
       asset/rl/enemies.json     QuestEnemyList rows that have a model, with
                                  boss flag / voice sheet / zh name
       asset/rl/volumes.json     the 5-volume split (spec/05 §3): theme, boss,
                                  guest roster
       asset/rl/skills-rl.json   the 5 class normal attacks + every roster skill
                                  + every enemy skill, with cooldown/coefficient/
                                  physical-or-magic and (enemy side) the danmaku
                                  pattern resolved at build time
       asset/rl/encounters.json  per-volume element theme, mob pool, elite pool
                                  and boss, with aiType baked in

Discipline (spec/06 T01): no hand-written numbers in enemies.json -- every stat
is copied from QuestEnemyList. The only authored data here is the volume split
and the 40-role roster table, both transcribed from spec/05 §3–4, plus the
encounter design in ENCOUNTER_TABLE (element theme / pools / boss HP band) --
that one is game design, so it is authored on purpose and every stat it points
at is still read out of the tables.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "asset" / "rl" / "_raw"
OUT = ROOT / "asset" / "rl"

STAT_KEYS = ["Hp", "Atk", "Mgc", "Def", "MDef", "Spd", "Luck"]


def load_table(name: str) -> list[dict]:
    return json.loads((RAW / name).read_text(encoding="utf-8-sig"))


def load_gacha_data() -> dict:
    text = (ROOT / "asset" / "gacha" / "cards.js").read_text(encoding="utf-8")
    marker = "window.kirafanGachaData = "
    payload = text[text.index(marker) + len(marker):].strip().rstrip(";")
    return json.loads(payload)


def load_cards_js() -> list[dict]:
    return load_gacha_data()["cards"]


def load_translations(filename: str) -> dict[str, str]:
    """ja -> zh from a translations CSV (columns: ja,zh,en,ko)."""
    path = RAW / "trans" / filename
    reader = csv.DictReader(io.StringIO(path.read_text(encoding="utf-8-sig")))
    return {row["ja"]: row["zh"] for row in reader if row.get("ja") and row.get("zh")}


def write_json(name: str, data) -> None:
    dest = OUT / name
    dest.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    size = dest.stat().st_size
    print(f"wrote {dest.relative_to(ROOT)}  ({size/1024:.0f} KB)")


# --------------------------------------------------------------------------
# cards-rl.json + growth.json
# --------------------------------------------------------------------------

def build_cards() -> None:
    chara = {row["m_CharaID"]: row for row in load_table("CharacterList.json")}
    cards = load_cards_js()
    out = []
    missing = []

    def emit(card: dict, chara_id: int, resource_id, evolved: bool) -> None:
        row = chara.get(chara_id)
        if row is None:
            missing.append(chara_id)
            return
        out.append({
            "id": row["m_CharaID"],
            "resourceId": resource_id,
            "name": card["name"],
            "nameZh": card["nameZh"],
            "characterZh": card["characterZh"],
            "titleZh": card["titleZh"],
            # cards.js's display rarity is m_Rare + 1 (verified on all 685
            # cards); ship the number players see, not the internal scale
            "rare": row["m_Rare"] + 1,
            "class": row["m_Class"],
            "element": row["m_Element"],
            "cost": row["m_Cost"],
            "growthTableID": row["m_GrowthTableID"],
            "initLv": row["m_InitLv"],
            "initLimitLv": row["m_InitLimitLv"],
            "stunCoef": row["m_StunCoef"],
            "init": {k.lower(): row["m_Init" + k] for k in STAT_KEYS},
            "skillIds": {
                "chara": row["m_CharaSkillID"],
                "class": row["m_ClassSkillIDs"],
            },
            "dedicatedWeapon": card.get("dedicatedWeapon"),
            "evolved": evolved,
        })

    for card in cards:
        emit(card, card["id"], card["resourceId"], False)
        # the evolved form is a separate CharacterList row reached through the
        # card's evolvedId -- same character, higher cap; the roster's ★5s
        # (e.g. ゆの 10002001) are these rows
        if card.get("evolvedId"):
            emit(card, card["evolvedId"], card.get("evolvedResourceId"), True)

    if missing:
        print(f"WARNING: {len(missing)} ids have no CharacterList row: {missing[:10]}")
    write_json("cards-rl.json", {"cards": out})

    growth_rows = load_table("CharacterParamGrowthList.json")
    growth = [{
        "lv": row["m_Lv"],
        "hp": row["m_GrowthHp"], "atk": row["m_GrowthAtk"],
        "mgc": row["m_GrowthMgc"], "def": row["m_GrowthDef"],
        "mdef": row["m_GrowthMDef"], "spd": row["m_GrowthSpd"],
        "luck": row["m_GrowthLuck"],
    } for row in sorted(growth_rows, key=lambda r: r["m_Lv"])]
    write_json("growth.json", growth)


# --------------------------------------------------------------------------
# weapons-rl.json
# --------------------------------------------------------------------------

def build_weapons() -> None:
    weapon_names = load_translations("WeaponList m_WeaponName.csv")
    weapon_zh = json.loads((ROOT / "tools" / "weapon_zh.json").read_text(encoding="utf-8"))
    gacha = load_gacha_data()
    named = {row["id"]: row for row in gacha["genericWeapons"] + gacha["dedicatedWeapons"]}
    catalog = []
    for row in load_table("WeaponList.json"):
        if row["default"]:
            continue
        # The asset index contains one icon per family, shared by its stages.
        icon_id = row["m_ID"] - row["m_EvolvedCount"]
        name_zh = weapon_zh.get(str(icon_id)) or weapon_names.get(row["m_WeaponName"]) or named[icon_id]["nameZh"]
        catalog.append({
            "id": row["m_ID"], "name": row["m_WeaponName"], "nameZh": name_zh,
            "iconId": icon_id, "class": row["m_ClassType"],
            "resourceIdL": row["m_ResourceID_L"], "resourceIdR": row["m_ResourceID_R"],
            "classAnimType": row["m_ClassAnimType"],
            "rare": row["m_Rare"] + 1, "cost": row["m_Cost"],
            "evolution": row["m_EvolvedCount"],
            "minLv": row["m_InitLv"], "maxLv": row["m_LimitLv"],
            "init": {k.lower(): row["m_Init" + k] for k in ["Atk", "Mgc", "Def", "MDef"]},
            "max": {k.lower(): row["m_Max" + k] for k in ["Atk", "Mgc", "Def", "MDef"]},
            "skillId": row["m_SkillID"], "passiveId": row["m_PassiveSkillID"],
            "charaId": row["m_EquipableCharaID"],
        })

    classes = [{
        "name": row["m_ResouceBaseName"],
        "normalAttackSkillID": row["m_NormalAttackSkillID"],
        "defaultWeaponID": row["m_DefaultWeaponID"],
    } for row in load_table("ClassList.json")]

    weapons = [{
        "id": row["m_ID"],
        "charaId": row["m_CharaID"],
        "weaponId": row["m_WeaponID"],
        "condLv": row["m_CondLv"],
    } for row in load_table("CharacterWeaponList.json")]

    contents = {row["m_ID"]: row for row in load_table("SkillContentList_WPN.json")}
    skills = {}
    for row in load_table("SkillList_WPN.json"):
        content = contents.get(row["m_ID"], {})
        datas = content.get("m_Datas", [])
        skills[str(row["m_ID"])] = {
            "name": row["m_SkillName"],
            "detail": row["m_SkillDetail"],
            "type": row["m_SkillType"],
            "recasts": row["m_Recasts"],          # x0.35s -> cooldown (spec/04 §4)
            "loadFactors": row["m_LoadFactors"],
            "sap": row["m_SAP"],                  # original presentation prefab
            "sag": row["m_SAG"],
            "args": datas[0]["m_Args"] if datas else [],
            "argType": datas[0]["m_Type"] if datas else None,
            "target": datas[0]["m_Target"] if datas else None,
        }

    passives = {}
    for row in load_table("PassiveSkillList_WPN.json"):
        passives[str(row["m_ID"])] = {
            "charaId": row["m_ID"],
            "detail": row["m_SkillDetail"],
            "effects": [{
                "trigger": effect["m_Trigger"],
                "type": effect["m_Type"],
                "args": effect["m_Args"],
            } for effect in row["m_Datas"]],
        }

    # Type-8 (通常攻撃改変) effects carry child row ids (9-digit) whose rows
    # live in SkillList_PL -- the evolved weapon's own attack/skill set. Every
    # referenced id is decoded with the same convert_skill the player skill
    # table uses, so skills.js can decode them identically.
    child_ids = set()
    for row in load_table("PassiveSkillList_WPN.json"):
        for effect in row["m_Datas"]:
            if effect["m_Type"] == 8:
                for arg in effect["m_Args"]:
                    if arg and arg > 0:
                        child_ids.add(arg)
    pl_rows = {row["m_ID"]: row for row in load_table("SkillList_PL.json")}
    pl_content = {row["m_ID"]: row for row in load_table("SkillContentList_PL.json")}
    child_skills = {}
    missing = []
    for skill_id in sorted(child_ids):
        source = pl_rows.get(skill_id)
        if source is None:
            missing.append(skill_id)
            continue
        entry = convert_skill(source, pl_content.get(skill_id, {}).get("m_Datas", []),
                              enemy=False)
        entry["id"] = skill_id
        child_skills[str(skill_id)] = entry
    if missing:
        print(f"WARNING: {len(missing)} weapon child rows missing from "
              f"SkillList_PL: {missing[:5]}")
    print(f"weapons: {len(classes)} classes, {len(weapons)} weapons, "
          f"{len(skills)} WPN skills, {len(passives)} passives, "
          f"{len(child_skills)} child rows")

    write_json("weapons-rl.json", {
        "classes": classes, "weapons": weapons, "skills": skills,
        "passives": passives, "childSkills": child_skills,
        "catalog": catalog,
        "catalogSource": {
            "url": "https://gitlab.com/kirafan/database/-/raw/master/database/WeaponList.json",
            "sha256": hashlib.sha256((RAW / "WeaponList.json").read_bytes()).hexdigest(),
            "rows": len(catalog), "families": len({row["iconId"] for row in catalog}),
            "statPolicy": "stage-max", "excluded": "43 default/non-equipment rows",
            "nameOverrides": "tools/weapon_zh.json",
        },
    })
    print(f"weapon catalog: {len(catalog)} stages, {len({row['iconId'] for row in catalog})} icons")


# --------------------------------------------------------------------------
# enemies.json -- truth rows, filtered to what has a model
# --------------------------------------------------------------------------

# Authored Chinese names for rows the translation CSV leaves blank -- these
# cover both the T22e additions and the names already shipped with a blank
# (main.js falls back to the Japanese name when nameZh is empty).
ZH_ENEMY_OVERRIDES = {
    "ツインシザー": "双钳蟹",
    "スケジェルン": "骸骨怪",
    "メタドロン": "梅塔多隆",
    "ウツカイ": "器使",
    "郵便ウツカイ": "邮差器使",
    "ナイトメアウツカイ": "梦魇器使",
    "ルーボン＝バレー": "球·气球",
    "ルーボン＝サマー": "球·夏日",
    "かれら": "他们",
    "スイセン": "水仙",
    "サンストーン": "太阳石",
    "リコリス": "甘草",
    "ダチュラ": "曼陀罗",
    "カリブーツノムシ": "驯鹿角虫",
    "ヤヤヤッカイ": "呀呀麻烦怪",
    "クロモン王子": "小黑怪王子",
    "群れの長ウルファン": "狼群之长",
    "ビターマッシュ": "苦菇",
    "洞窟の魔物": "洞窟魔物",
}


def build_enemies() -> None:
    resources = {row["m_ResourceID"]: row for row in load_table("EnemyResourceList.json")}
    manifest = json.loads((ROOT / "asset" / "models" / "manifest.json")
                          .read_text(encoding="utf-8"))
    model_ids = set()
    for key in manifest["models"]:
        if "/model_en_" in key:
            model_ids.add(int(key.rsplit("_", 1)[1].split(".")[0]))
    zh_names = load_translations("QuestEnemyList m_CharaName.csv")

    out = []
    dropped = 0
    for row in load_table("QuestEnemyList.json"):
        res_id = row["m_ResourceID"]
        if res_id not in model_ids:
            dropped += 1
            continue
        resource = resources.get(res_id, {})
        skill_ids = [s for s in row["m_SkillIDs"] if s > 0]
        out.append({
            "id": row["m_ID"],
            "name": row["m_CharaName"],
            # T22a/T22e: the translation CSV leaves some shipped names blank;
            # the runtime would fall back to the Japanese name. Authored here
            # so the 中文化 gate stays honest.
            "nameZh": zh_names.get(row["m_CharaName"], "")
                or ZH_ENEMY_OVERRIDES.get(row["m_CharaName"], ""),
            "resourceId": res_id,
            "model": f"model/enemy/model_en_{res_id}.muast",
            "isBoss": bool(resource.get("m_IsBoss")),
            "voiceCueSheet": resource.get("m_VoiceCueSheetName", ""),
            "shadowScale": resource.get("m_ShadowScale", 1.75),
            "element": row["m_Element"],
            "initLv": row["m_InitLv"],
            "maxLv": row["m_MaxLv"],
            "init": {k.lower(): row["m_Init" + k] for k in STAT_KEYS},
            "max": {k.lower(): row["m_Max" + k] for k in STAT_KEYS},
            "skillIds": skill_ids,
            "stunCoef": row["m_StunCoef"],
        })
    bosses = [e for e in out if e["isBoss"]]
    voiced = [e for e in bosses if e["voiceCueSheet"]]
    print(f"enemies: {len(out)} rows ({dropped} dropped, no model); "
          f"{len(bosses)} boss, {len(voiced)} boss-with-voice")
    write_json("enemies.json", {"enemies": out})


# --------------------------------------------------------------------------
# volumes.json -- authored split from spec/05 §3-4, bosses resolved by name
# --------------------------------------------------------------------------

# The 40-role roster (spec/05 §4), transcribed. The play/unlock split is the
# game's progression data, not decoration -- meta.js reads it in stage 5.
ROSTER = [
    ("きらら", 32002000, "initial"), ("住良木 うつつ", 32172000, "final"),
    ("ゆの", 10000000, "initial"), ("櫟井 唯", 11010000, "initial"),
    ("折部 やすな", 18000000, "initial"), ("九条 カレン", 14000000, "initial"),
    ("保登 心愛", 30001000, "initial"), ("志摩 リン", 23001000, "initial"),
    ("涼風 青葉", 15000000, "initial"), ("吉田 優子", 35001000, "initial"),
    ("平沢 唯", 22000000, "initial"), ("木ノ幡 みら", 38001000, "initial"),
    ("萌田 薫子", 24001000, "initial"), ("桜ノ宮 苺香", 20000000, "initial"),
    ("大空 遥", 29001000, "vol1"), ("海凪 ひより", 47002000, "vol1"),
    ("花小泉 杏", 28001000, "vol1"), ("鳩谷 こはね", 31001000, "vol1"),
    ("一之瀬 花名", 21000000, "vol1"), ("高山 春香", 19000000, "vol1"),
    ("町子 リョウ", 37002000, "vol2"), ("クロ", 34001000, "vol2"),
    ("武田 詠深", 39001000, "vol2"), ("友兼", 25021000, "vol2"),
    ("メリー・ナイトメア", 26000000, "vol2"), ("細野はるみ", 36001000, "vol2"),
    ("アリス・カータレット", 14010000, "vol2"),
    ("丈槍 由紀", 12000000, "vol3"), ("関谷 なる", 27001000, "vol3"),
    ("御庭 つみき", 41001000, "vol3"), ("小野坂 こはる", 43001000, "vol3"),
    ("篠華 まゆ", 42001000, "vol3"), ("小田切 双葉", 33011000, "vol3"),
    ("千矢", 17000000, "vol3"),
    ("本田 珠輝", 16000000, "vol4"), ("風色 琴音", 45002000, "vol4"),
    ("桜 衣乃", 40002000, "vol4"), ("一井 透", 13000000, "vol4"),
    ("後藤 ひとり", 46002000, "vol5"), ("各務原 なでしこ", 23011000, "vol5"),
]

# Volume table (spec/05 §3): title, theme, boss name. Biome mapping lives in
# floors.json (spec/02 §3) so mapkit ownership stays with the map pipeline.
VOLUME_TABLE = [
    (1, "褪色之海", "被潮水卷走的夏天", "テンペスト"),
    (2, "沉眠之沙", "旅人与食桌的约定", "カレーの化身"),
    (3, "贪食之森", "森深处没有回声", "合体マタンゴ"),
    (4, "机械之心", "无人认领的造物", "メカこけし"),
    (5, "真实之影", "第一百个故事", "ハイプリス"),
]

# Guest cameos per volume (spec/05 §3) -- names of the §4 roster rows above.
VOLUME_GUESTS = {
    1: ["大空 遥", "海凪 ひより", "花小泉 杏", "鳩谷 こはね", "一之瀬 花名",
        "平沢 唯", "高山 春香"],
    2: ["町子 リョウ", "クロ", "武田 詠深", "友兼", "メリー・ナイトメア",
        "細野はるみ", "アリス・カータレット"],
    3: ["丈槍 由紀", "関谷 なる", "御庭 つみき", "小野坂 こはる", "篠華 まゆ",
        "小田切 双葉", "千矢"],
    4: ["涼風 青葉", "本田 珠輝", "風色 琴音", "桜ノ宮 苺香", "萌田 薫子",
        "桜 衣乃", "一井 透"],
    5: ["後藤 ひとり", "平沢 唯", "保登 心愛", "折部 やすな", "ゆの",
        "各務原 なでしこ", "九条 カレン"],
}


def playable_roster() -> list[dict]:
    """Current five-star cast, independent of stable story/page identifiers."""
    source = load_cards_js()
    by_id = {card["id"]: card for card in source}
    # Tomokane has no five-star card in the archive. Keep her story identity;
    # Kisaragi represents GA in the playable cast rather than inventing a card.
    replacements = {25021000: 25002000}
    result = []
    for legacy_id in [row[1] for row in ROSTER] + [32022000]:
        old = by_id[legacy_id]
        candidates = [card for card in source if card["rarity"] == 5
                      and card["namedType"] == old["namedType"]
                      and card["titleId"] == old["titleId"]]
        card = by_id[replacements[legacy_id]] if legacy_id in replacements else min(
            candidates, key=lambda row: row["id"])
        result.append({
            "id": card.get("evolvedId") or card["id"],
            "sourceId": card["id"], "legacyId": legacy_id,
            "resourceId": card.get("evolvedResourceId") or card["resourceId"],
            "class": card["class"], "rare": card["rarity"],
            "nameZh": card["nameZh"],
        })
    return result


def build_playable_roster() -> None:
    rows = playable_roster()
    write_json("playable-roster.json", {"cards": rows})
    path = ROOT / "game" / "rl" / "rosterids.js"
    path.write_text("// Generated by tools/build_rl_data.py; story IDs remain separate.\n"
                    "export const PLAYABLE_ROSTER = Object.freeze("
                    + json.dumps(rows, ensure_ascii=False, indent=2) + ");\n"
                    "export const PLAYABLE_IDS = Object.freeze(PLAYABLE_ROSTER.map(row => row.id));\n",
                    encoding="utf-8")


def build_volumes() -> None:
    cards = {card["id"]: card for card in load_cards_js()}
    enemies = json.loads((OUT / "enemies.json").read_text(encoding="utf-8"))["enemies"]

    def roster_entry(name: str) -> dict:
        row = next(r for r in ROSTER if r[0] == name)
        card = cards[row[1]]
        return {
            "name": name, "cardId": row[1], "unlock": row[2],
            "nameZh": card["characterZh"] or card["nameZh"],
        }

    def boss_entry(boss_name: str) -> dict:
        candidates = [e for e in enemies if e["name"] == boss_name and e["isBoss"]]
        if not candidates:
            raise RuntimeError(f"boss {boss_name} not found in enemies.json")
        # prefer the voiced variant, then the strongest InitHp (difficulty rows
        # are variants of the same enemy -- spec/04 §5)
        voiced = [e for e in candidates if e["voiceCueSheet"]]
        pool = voiced or candidates
        best = max(pool, key=lambda e: e["init"]["hp"])
        return {"id": best["id"], "name": best["name"], "nameZh": best["nameZh"]}

    volumes = []
    for vol, title, theme, boss_name in VOLUME_TABLE:
        volumes.append({
            "vol": vol, "title": title, "theme": theme,
            "boss": boss_entry(boss_name),
            "guests": [roster_entry(g) for g in VOLUME_GUESTS[vol]],
        })
    write_json("volumes.json", {
        "volumes": volumes,
        "roster": [roster_entry(name) for name, _, _ in ROSTER],
    })


# --------------------------------------------------------------------------
# skills-rl.json -- player + enemy skill rows, decoded once at build time
# --------------------------------------------------------------------------

# spec/04 §4: one recast point is 0.35s of real time.
RECAST_SECONDS = 0.35
# spec/04 §4 also fixes the original's turn at the same 8s x 0.35 anchor, so a
# buff measured in turns lasts turns * 8 * 0.35 seconds. Derived, not invented.
TURN_SECONDS = round(8 * RECAST_SECONDS, 4)

# Danmaku pattern is decided here, not at runtime: the runtime reading a table
# is the whole point of doing this in the builder (see the enemy skill names --
# a live heuristic beside a table only ever deletes information).
MELEE_WORDS = ("たいあたり", "とっしん", "ころがる", "ふりおろす", "すまっしゅ", "はたく",
               "かみつく", "ひっかく", "チョップ", "パンチ", "キック", "たたく", "突撃",
               "体当たり", "斬", "殴", "ひっさつ", "つっこむ", "つつく", "けりとばす")
SPREAD_WORDS = ("ひろがる", "たかなみ", "うずしお", "レイン", "シャワー", "ばらまき",
                "拡散", "ふぶき", "あらし", "なだれ", "みずでっぽう")
# T21e 去均匀弹幕海: four more readable shapes, still read off the skill's own
# name (each word class was checked against the 335 shipped enemy skills).
CROSS_WORDS = ("十字", "クロス", "ツイン", "双牙")
WALL_WORDS = ("壁", "峭壁", "ウォール")
WAVE_WORDS = ("はどう", "波動", "さざめき", "うねり", "スプラッシュ", "しぶき")
VOLLEY_WORDS = ("ガトリング", "バレット", "ショット", "チュー", "クアドラプル",
                "ダブル", "連射")


def danmaku_pattern(name: str, datas: list[dict]) -> str:
    """aimed / fan / ring / cross / wall / wave / volley / charge for a damage
    skill, buff for the rest."""
    damage = [d for d in datas if d["m_Type"] == 0]
    if not damage:
        return "buff"
    if any(word in name for word in MELEE_WORDS):
        return "charge"
    if any(word in name for word in CROSS_WORDS):
        return "cross"
    if any(word in name for word in WALL_WORDS):
        return "wall"
    if any(word in name for word in WAVE_WORDS):
        return "wave"
    if any(word in name for word in VOLLEY_WORDS):
        return "volley"
    if damage[0]["m_Target"] in (2, 4):      # every enemy / every ally
        return "ring"
    if any(word in name for word in SPREAD_WORDS):
        return "fan"
    return "aimed"


def convert_skill(row: dict, datas: list[dict], *, enemy: bool) -> dict:
    """One SkillList row + its SkillContentList rows -> a runtime skill."""
    damage = next((d for d in datas if d["m_Type"] == 0), None)
    out = {
        "name": row["m_SkillName"],
        "detail": row["m_SkillDetail"],
        "type": row["m_SkillType"],
        "target": datas[0]["m_Target"] if datas else 1,
        # m_Args[0] is per-mille of the attacker's Atk or Mgc (spec/04 §7);
        # m_Args[1] is the physical(0) / magical(1) bit -- proved by the five
        # class normal attacks and by the per-class Atk/Mgc means
        "coef": round(damage["m_Args"][0] / 1000, 4) if damage else 0,
        "magic": bool(damage["m_Args"][1]) if damage else False,
        "effects": [{"kind": d["m_Type"], "target": d["m_Target"], "args": d["m_Args"]}
                    for d in datas],
    }
    if enemy:
        # enemy m_Recasts are all [0,0,0] -- there is no cadence data, so the
        # AI derives cadence from the row's real Spd instead (spec/04 §5)
        out["pattern"] = danmaku_pattern(row["m_SkillName"], datas)
        out["sap"] = row["m_SAP"]
    else:
        scene = re.fullmatch(r"PL_(\d+)_\d+", row.get("m_UniqueSkillScene", ""))
        action = re.search(r"_cls([123])(?:_|$)", row.get("m_SAP", ""))
        out["sceneId"] = scene.group(1) if scene else None
        out["action"] = "skill" if scene else ("class_skill_" + action.group(1) if action else "chara_skill_1")
        out["recasts"] = row["m_Recasts"]
        out["cooldown"] = [round(r * RECAST_SECONDS, 3) for r in row["m_Recasts"]]
        out["loadFactors"] = row["m_LoadFactors"]
    return out


def build_skill_cards(sources: list[dict]) -> dict:
    """The shipped placement-reference closure in the separate CARD namespace."""
    refs = set()
    for row in sources:
        for effect in row.get("effects", []):
            if effect["kind"] != 21:
                continue
            args = effect.get("args")
            if not isinstance(args, list) or len(args) < 2 or type(args[1]) is not int \
                    or not 0 < args[1] <= 2**53 - 1:
                raise ValueError(f"invalid CARD placement reference in skill {row.get('id')}: {args}")
            refs.add(args[1])
    rows = {row["m_ID"]: row for row in load_table("SkillList_CARD.json")}
    contents = {row["m_ID"]: row for row in load_table("SkillContentList_CARD.json")}
    missing = refs - (rows.keys() & contents.keys())
    if missing:
        raise ValueError(f"missing CARD placement references: {sorted(missing)}")
    result = {}
    for ref in sorted(refs):
        entry = convert_skill(rows[ref], contents[ref]["m_Datas"], enemy=False)
        entry.update({"id": ref, "source": "CARD", "action": None})
        result[str(ref)] = entry
    return result


def referenced_skill_cards(table: dict) -> dict:
    weapons = json.loads((OUT / "weapons-rl.json").read_text(encoding="utf-8"))
    sources = [row for key in ("normalAttacks", "player", "enemy")
               for row in table.get(key, {}).values()]
    return build_skill_cards(sources + list(weapons.get("childSkills", {}).values()))


def refresh_skill_cards() -> None:
    """Rebuild only the new field without bypassing the existing enemy pruning."""
    table = json.loads((OUT / "skills-rl.json").read_text(encoding="utf-8"))
    table["skillCards"] = referenced_skill_cards(table)
    write_json("skills-rl.json", table)


def build_skills() -> None:
    cards_js = {card["id"]: card for card in load_cards_js()}
    cards = json.loads((OUT / "cards-rl.json").read_text(encoding="utf-8"))["cards"]
    enemies = json.loads((OUT / "enemies.json").read_text(encoding="utf-8"))["enemies"]

    wanted = set()
    for _, card_id, _ in ROSTER:
        wanted.add(card_id)
        evolved = cards_js.get(card_id, {}).get("evolvedId")
        if evolved:
            wanted.add(evolved)
    for entry in playable_roster():
        wanted.update([entry["sourceId"], entry["id"]])
    # Every rarity variant of a roster character is playable: the stage-0
    # character rule picks a card by resourceId (ゆの=100001 → card 10001000,
    # not the roster's 3★ 10000000), and cardByResource returns that same
    # variant at spawn. Its skillIds are the variant's own (100010000…, not
    # 100000000…), so a slots table built from base ids alone leaves that
    # variant's skill slots empty.
    charas = set()
    for card_id in wanted:
        row = cards_js.get(card_id)
        if row and row.get("character"):
            charas.add(row["character"])
    for card in cards_js.values():
        if card.get("character") in charas:
            wanted.add(card["id"])
            if card.get("evolvedId"):
                wanted.add(card["evolvedId"])

    player_ids = set()
    for card in cards:
        if card["id"] in wanted:
            player_ids.add(card["skillIds"]["chara"])
            player_ids.update(card["skillIds"]["class"])
    player_ids.discard(0)

    pl_rows = {row["m_ID"]: row for row in load_table("SkillList_PL.json")}
    pl_content = {row["m_ID"]: row for row in load_table("SkillContentList_PL.json")}
    en_rows = {row["m_ID"]: row for row in load_table("SkillList_EN.json")}
    en_content = {row["m_ID"]: row for row in load_table("SkillContentList_EN.json")}

    normal = {}
    for index, row in enumerate(load_table("ClassList.json")):
        skill_id = row["m_NormalAttackSkillID"]
        source = pl_rows.get(skill_id)
        if source is None:
            print(f"WARNING: class {index} normal attack {skill_id} has no PL row")
            continue
        entry = convert_skill(source, pl_content.get(skill_id, {}).get("m_Datas", []),
                              enemy=False)
        entry["id"] = skill_id
        normal[str(row.get("m_ID", index))] = entry
        player_ids.discard(skill_id)

    player = {}
    for skill_id in sorted(player_ids):
        source = pl_rows.get(skill_id)
        if source is None:
            print(f"WARNING: roster skill {skill_id} has no PL row")
            continue
        entry = convert_skill(source, pl_content.get(skill_id, {}).get("m_Datas", []),
                              enemy=False)
        entry["id"] = skill_id
        player[str(skill_id)] = entry

    enemy = {}
    for skill_id in sorted({s for e in enemies for s in e["skillIds"]}):
        source = en_rows.get(skill_id)
        if source is None:
            print(f"WARNING: enemy skill {skill_id} has no EN row")
            continue
        entry = convert_skill(source, en_content.get(skill_id, {}).get("m_Datas", []),
                              enemy=True)
        entry["id"] = skill_id
        enemy[str(skill_id)] = entry

    weapon_children = json.loads((OUT / "weapons-rl.json").read_text(encoding="utf-8")).get("childSkills", {})
    skill_cards = build_skill_cards(list(normal.values()) + list(player.values())
                                   + list(enemy.values()) + list(weapon_children.values()))
    patterns = {}
    for entry in enemy.values():
        patterns[entry["pattern"]] = patterns.get(entry["pattern"], 0) + 1
    print(f"skills: {len(normal)} normal attacks, {len(player)} roster, "
          f"{len(enemy)} enemy {patterns}, {len(skill_cards)} referenced CARD rows")
    write_json("skills-rl.json", {
        "recastSeconds": RECAST_SECONDS,
        "turnSeconds": TURN_SECONDS,
        "normalAttacks": normal,
        "skillCards": skill_cards,
        "player": player,
        "enemy": enemy,
    })


# --------------------------------------------------------------------------
# encounters.json -- authored encounter design over the mirrored stat rows
# --------------------------------------------------------------------------

# Every enemy name exists once per element as a separate QuestEnemyList row (the
# id's last digit is the element: クロモン 10010003 is 風, 10010004 is 月), so
# element is a *variant axis*, not an identity. That kills the obvious rule
# "the volume's pool is the boss's element" -- four of the five volume bosses
# are element 3, which would hand vols 1-4 the identical 111-name pool. The
# theme is authored here instead, and matches floors.json's biome per volume.
#
# The four dials per volume, and why they are the only ones (spec/04 §6 allows
# 词条池 / 掉落表 / 敌人组合 and forbids new hidden coefficients):
#
#   level        which rung of the row's own m_InitLv->m_MaxLv ramp the volume
#                fights at (spec/04 §5 interpolation). Small on purpose: the
#                shipped offence ramp is x64-x94 against hp x9.5, so a lv80
#                player takes 1 incoming DPS from a vol5 group at level 1 and
#                3092 at level 20. Measured, see spec/04 §5.
#   tier         which row of the *name's* shipped difficulty ladder to use.
#                Every name ships several QuestEnemyList rows -- a low-offence
#                family (ids 19.../29.../39..., atk ~300) and a ~2.7x family
#                (10.../20.../30..., atk ~800-1040). 189 names have more than
#                one. This is 敌人组合, not a coefficient: the numbers are still
#                the shipped numbers, the volume just meets a harder body.
#   playerLevel  the 局外养成 pacing statement -- what level the player is
#                expected to arrive at this volume with. Read by meta.js (阶段
#                5) and by the win-rate gate; it is not a multiplier.
#   bossHp       the one stat this table overrides, as a *row-selection target*
#                (see the boss/elite pickers below) so hpScale stays near 1.
#
# mobSegments splits each volume's pool across the four 生态段 (floors.json's
# segments: 5 floors each, matching world.js's segment rung). The lists are
# assigned by theme (name/biome reading), so each 段 has its own 3-5 faces.
# T22e 素材扩容 raised the pools 10 -> 16-17 per volume from the 604 local
# models (no downloads): every addition passed rl_enemy_audit.py posture
# flags before shipping, and each volume keeps its element-matching row.
# `mobs` in the output is the flattened union: requestSummon's fallback and
# the balance harness's random sampling keep working unchanged.
ENCOUNTER_TABLE = [
    {
        "vol": 1, "element": 1,                                    # 水 / 褪色之海
        "playerLevel": 20, "level": 1, "tier": 0.0,
        "bossHp": 220000, "eliteHp": 24000,
        # 港町 → 海底 → 深层 → 巨浪
        "mobSegments": [
            ["ペラペラの兵士", "ホイップアニマ", "クマ兵隊", "バニポップ"],  # 港町：人形与杂耍，兵与兔
            ["レジフィッシュ", "うおのたみ", "ヒカリタマ",
             "リザー", "パパリザー"],                              # 海底：鱼群与光球，海蜥一家
            ["トータン", "タートン", "シャードン",
             "待宵のワラバカシ"],                                  # 深层：老龟与暗影，黄昏的欺诈者
            ["ツインシザー", "クロモン（大）",
             "ほしわたり", "ペラペラのドラゴン"],                 # 巨浪：浪里翻涌的与越海的
        ],
        "elites": ["ソルト", "シュガー", "スイセン"],
    },
    {
        "vol": 2, "element": 2,                                    # 土 / 沉眠之沙
        "playerLevel": 30, "level": 2, "tier": 0.25,
        "bossHp": 280000, "eliteHp": 45000,
        # 沙漠入口 → 绿洲 → 夜沙丘 → 蜃楼
        "mobSegments": [
            ["暴れる牛", "ミノタウロス", "ビッグフット"],           # 入口：商队的麻烦，挡路的大个子
            ["サボンヌ", "きんいろのおをもつまもの",
             "カリブーツノムシ"],                                  # 绿洲：水边与点心
            ["スケジェルン", "ちゅう", "クロモン",
             "アイヅチ", "ヤヤヤッカイ"],                          # 夜沙丘：夜行物与跟班
            ["ゴーレム", "ドーダイ", "ハードルドーダイ",
             "ハードジェノワーズ", "砂肝うま太郎"],                # 蜃楼：沙中立起的与海市里的
        ],
        "elites": ["カルダモン", "ジンジャー"],
    },
    {
        "vol": 3, "element": 3,                                     # 風 / 贪食之森
        "playerLevel": 49, "level": 3, "tier": 0.5,
        "bossHp": 360000, "eliteHp": 65000,
        # 林边 → 蜜林 → 菌类圈 → 树海
        "mobSegments": [
            ["イノシシ", "畑アラシ", "狛犬"],                       # 林边：闯进田里的与守社的
            ["ぽぽたん", "コリス", "ウルファン",
             "ギャングー団のしたっぱ"],                            # 蜜林：甜食、野兽与偷蜜的跟班
            ["ましゅるん", "カカオマッシュ", "苔玉",
             "あぎりマタンゴ・ベイベー", "やすなマタンゴ・ベイベー",
             "ソーニャマタンゴ・ベイベー"],                        # 菌类圈：蘑菇、苔与蘑菇宝贝
            ["トレント", "ぼっくる", "クロモン王子"],               # 树海：老树、木灵与小黑怪的王子
        ],
        "elites": ["セサミ", "フェンネル"],
    },
    {
        "vol": 4, "element": 0,                                     # 炎 / 机械之心
        "playerLevel": 57, "level": 3, "tier": 0.75,
        "bossHp": 400000, "eliteHp": 85000,
        # 机关人偶 → 时计塔 → 核心炉 → 废墟
        "mobSegments": [
            ["ペイストリードール", "クロモンソルジャー",
             "ルーボン＝サマー"],                                  # 人偶：会动的造物与换季的球
            ["ド・ダイス", "メタドロン", "ルーボン", "ルーボン＝ベース"],  # 时计塔：齿轮、骰与滚动的球
            ["ソルジャーゴーレム", "ハンマゴーレム", "怒りのシャードン"],  # 核心炉：重装守卫与炉中怒鳍
            ["ウツカイ", "郵便ウツカイ", "ナイトメアウツカイ",
             "ルーボン＝バレー", "群れの長ウルファン",
             "宙に浮いたもずく"],                                  # 废墟：留在废墟里的他们
        ],
        "elites": ["ハッカ", "サンストーン"],
    },
    {
        "vol": 5, "element": 4,                                     # 月 / 真实之影
        "playerLevel": 62, "level": 10, "tier": 1.0,
        "bossHp": 470000, "eliteHp": 105000,
        # 神殿回廊 → 地下圣堂 → 记忆之间 → 终之书架
        # (ビターマッシュ/洞窟の魔物/カブリエル were candidates: the first two
        # ship whole event-scripted kits -- coef 1.0-9.999 sleep/Santa rows the
        # SANE_ENEMY_COEF table invariant exists to keep out -- and カブリエル's
        # atk curve reaches 16.9k at elv25 where the volume band is ~8k, which
        # alone knocked §6's 承伤/清怪 anchor from 2.00 to 1.50. 黒雪だるま
        # moved over from vol4 to keep vol5 at 15 faces.)
        # (ビターマッシュ/洞窟の魔物/カブリエル were candidates: the first two
        # ship whole event-scripted kits -- coef 1.0-9.999 sleep/Santa rows the
        # SANE_ENEMY_COEF table invariant exists to keep out -- and カブリエル's
        # atk curve reaches 16.9k at elv25 where the volume band is ~8k, which
        # alone knocked §6's 承伤/清怪 anchor from 2.00 to 1.50. 黒雪だるま
        # moved over from vol4 to keep vol5 at 15 faces.)
        "mobSegments": [
            ["三人官女", "五人囃子", "フワリー"],                  # 回廊：神殿的侍者与妖精
            ["ゾゾゾンビ", "黒黒団", "クロモンヌ", "黒雪だるま"],  # 圣堂：地下的黑影
            ["戸棚に潜む魔物", "めんどうくさいという魔物", "かれら",
             "迅雷のウルファン", "ペラペラのイノシシ"],            # 记忆：旧日的东西
            ["ド・クロモン", "キングクロモン", "ワラバカシ"],       # 书架：终局的软体
        ],
        "elites": ["リコリス", "ダチュラ"],
    },
]

# The plan's 分裂型 has no data source -- no enemy skill anywhere mentions
# 分裂/ぶんれつ -- so it is authored, on the one enemy whose name says it: the
# big blob leaves two small ones. hpFraction is of the parent's *max* HP.
SPLITTERS = {
    "クロモン（大）": {"name": "クロモン", "count": 2, "hpFraction": 0.35},
    "ド・クロモン": {"name": "クロモン", "count": 2, "hpFraction": 0.3},
}

# T22e pool additions whose shipped growth curve runs far above their volume's
# face band (フワリー reaches 7.1k HP at vol5's dial level 10 where every other
# face sits at 0.8k-3.7k; 迅雷のウルファン 5.8k). Same mechanism as the elite
# and boss pickers below: hpScale = target / hp_at(row, level), so the number
# is a stated HP at the volume's level, not a magic multiplier.
MOB_HP = {
    "フワリー": 2900,
    "迅雷のウルファン": 2900,
    "黒雪だるま": 2900,
    "ペラペラのイノシシ": 2800,
}

# Gimmick rows (event bosses, damage-check walls) carry stats that would wreck
# an action game: atk 40300, def 10000, hp 500000, even a negative Mgc. Anything
# outside these bounds is not a fightable body.
SANE_ATK = 2500
SANE_DEF = 400
SANE_MOB_HP = 5000


def build_encounters() -> None:
    enemies = json.loads((OUT / "enemies.json").read_text(encoding="utf-8"))["enemies"]
    skills = json.loads((OUT / "skills-rl.json").read_text(encoding="utf-8"))["enemy"]
    volumes = json.loads((OUT / "volumes.json").read_text(encoding="utf-8"))["volumes"]

    def sane(row: dict, *, hp_cap: int | None) -> bool:
        init = row["init"]
        if min(init.values()) < 0 or init["hp"] <= 0:
            return False
        if init["atk"] > SANE_ATK or init["mgc"] > SANE_ATK or init["def"] > SANE_DEF:
            return False
        return hp_cap is None or init["hp"] <= hp_cap

    def ai_type(row: dict) -> str:
        patterns = [skills[str(s)]["pattern"] for s in row["skillIds"] if str(s) in skills]
        hits = [p for p in patterns if p != "buff"]
        if not hits:
            return "sentry"
        return "charger" if patterns.count("charge") * 2 >= len(hits) else "sentry"

    def entry(row: dict, ai: str, element: int, tier: float = 0.0, **extra) -> dict:
        out = {
            "id": row["id"], "name": row["name"], "nameZh": row["nameZh"],
            "model": row["model"], "element": row["element"], "aiType": ai,
            "shadowScale": row["shadowScale"], "voiceCueSheet": row["voiceCueSheet"],
            "skills": [s for s in row["skillIds"] if str(s) in skills],
        }
        out.update(extra)
        split = SPLITTERS.get(row["name"])
        if split:
            # resolve the child here so the runtime never has to search, and so
            # the child does not have to be in the volume's own mob pool
            child = resolve_mob(split["name"], element, tier)
            if child is None:
                print(f"WARNING: {row['name']} splits into {split['name']}, which "
                      f"has no element-{element} row")
            else:
                out["splitInto"] = dict(split, count=split["count"],
                                        **entry(child, ai_type(child), element, tier))
        return out

    def resolve_mob(name: str, element: int, tier: float = 0.0) -> dict | None:
        rows = [e for e in enemies
                if e["name"] == name and not e["isBoss"] and sane(e, hp_cap=SANE_MOB_HP)]
        themed = [e for e in rows if e["element"] == element]
        if not themed:
            themed = rows
        if not themed:
            return None
        # The name's own shipped difficulty ladder, ranked by offence because
        # offence is what the fight resolves against (HP only breaks ties). One
        # row per distinct (atk, mgc, hp) so a name that ships the same body
        # three times does not get three rungs. tier 0 = gentlest shipped row,
        # 1 = harshest; see ENCOUNTER_TABLE for why this is 敌人组合.
        ladder = {}
        for row in themed:
            init = row["init"]
            ladder.setdefault((init["atk"] + init["mgc"], init["hp"]), row)
        rungs = [ladder[k] for k in sorted(ladder)]
        return rungs[round(min(max(tier, 0.0), 1.0) * (len(rungs) - 1))]

    def hp_at(row: dict, lv: int) -> float:
        """The HP the runtime will actually see -- asset/rl/stats.js interpolates
        m_InitLv->m_MaxLv, and some boss rows ramp HP x9.5 while others are flat,
        so an HP target has to be compared against the levelled value."""
        init_lv, max_lv = row["initLv"], row["maxLv"]
        span = max_lv - init_lv
        t = 0.0 if span <= 0 else (min(max(lv, init_lv), max_lv) - init_lv) / span
        return row["init"]["hp"] + (row["max"]["hp"] - row["init"]["hp"]) * t

    out_volumes = []
    for spec in ENCOUNTER_TABLE:
        vol, element, tier = spec["vol"], spec["element"], spec["tier"]
        level = spec["level"]
        mob_segments = []
        for seg_idx, seg_names in enumerate(spec["mobSegments"]):
            seg = []
            for name in seg_names:
                row = resolve_mob(name, element, tier)
                if row is None:
                    print(f"WARNING: vol{vol} segment {seg_idx} mob {name} dropped, "
                          f"no sane row at all")
                    continue
                if row["element"] != element:
                    print(f"WARNING: vol{vol} segment {seg_idx} mob {name} "
                          f"has no element-{element} row")
                extra = {}
                if name in MOB_HP:
                    extra["hpScale"] = round(MOB_HP[name] / hp_at(row, level), 5)
                seg.append(entry(row, ai_type(row), element, tier, **extra))
            if not seg:
                print(f"WARNING: vol{vol} segment {seg_idx} is empty")
            mob_segments.append(seg)
        # `mobs` stays the flattened union (requestSummon's fallback, the
        # balance harness's sampling, and every legacy reader).
        mobs = [m for seg in mob_segments for m in seg]

        elites = []
        for name in spec["elites"]:
            rows = [e for e in enemies
                    if e["name"] == name and e["isBoss"] and sane(e, hp_cap=None)]
            if not rows:
                print(f"WARNING: vol{vol} elite {name} has no sane boss row")
                continue
            themed = [e for e in rows if e["element"] == element] or rows
            row = min(themed, key=lambda e: abs(hp_at(e, level) - spec["eliteHp"]))
            elites.append(entry(row, "boss", element, tier, elite=True,
                                hpScale=round(spec["eliteHp"] / hp_at(row, level), 5)))

        boss_name = next(v["boss"]["name"] for v in volumes if v["vol"] == vol)
        rows = [e for e in enemies
                if e["name"] == boss_name and e["isBoss"] and sane(e, hp_cap=None)]
        if not rows:
            raise RuntimeError(f"vol{vol} boss {boss_name} has no sane row")
        # richest moveset first, then whichever HP the authored band has to move
        # least. The target is a *row-selection* target: the shipped bosses are
        # 200k-600k bodies and the 90-150 s 斩杀线 at the volume's playerLevel
        # needs 190k-450k, so hpScale lands near 1 and spec/04 §5's 「Boss 数值
        # 原样使用」 is nearly literal (it was hpScale 0.04 when the band said 8k).
        row = min(rows, key=lambda e: (-len(e["skillIds"]),
                                       abs(hp_at(e, level) - spec["bossHp"])))
        boss = entry(row, "boss", element, tier,
                     hpScale=round(spec["bossHp"] / hp_at(row, level), 5))

        out_volumes.append({
            "vol": vol, "element": element,
            "playerLevel": spec["playerLevel"], "level": level, "tier": tier,
            "boss": boss, "elites": elites, "mobs": mobs,
            "mobSegments": mob_segments,
        })
        print(f"  vol{vol} el{element} plv{spec['playerLevel']} lv{level} "
              f"tier{tier}: {len(mobs)} mobs "
              f"({'/'.join(str(len(s)) for s in mob_segments)} per segment), "
              f"{len(elites)} elites, boss {boss['name']} x{boss['hpScale']}")

    names = {m["name"] for v in out_volumes for m in v["mobs"]}
    names |= {e["name"] for v in out_volumes for e in v["elites"]}
    names |= {v["boss"]["name"] for v in out_volumes}
    print(f"encounters: {len(names)} distinct enemy names across 5 volumes")
    write_json("encounters.json", {"volumes": out_volumes})

    # 2788 enemy skills is 700 KB of parse time for the ~200 the 66 encounter
    # bodies actually cast, so prune the table down to what encounters.json
    # references (plus the confusion skill every enemy shares).
    used = {999999}
    for volume in out_volumes:
        for row in [volume["boss"], *volume["elites"], *volume["mobs"]]:
            used.update(row["skills"])
            child = row.get("splitInto")
            if child:
                used.update(child["skills"])
    table = json.loads((OUT / "skills-rl.json").read_text(encoding="utf-8"))
    table["enemy"] = {k: v for k, v in table["enemy"].items() if int(k) in used}
    table["skillCards"] = referenced_skill_cards(table)
    print(f"pruned enemy skills: {len(table['enemy'])} kept")
    write_json("skills-rl.json", table)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    build_cards()
    build_weapons()
    build_enemies()
    build_volumes()
    build_playable_roster()
    build_skills()
    build_encounters()
    from build_skill_playback import build
    build()
    print("\nbuild complete")


if __name__ == "__main__":
    if sys.argv[1:] == ["--skill-cards-only"]:
        refresh_skill_cards()
    else:
        main()
