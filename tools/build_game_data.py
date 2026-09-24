# Merge the raw kirafan tables into runtime-ready JSON for the offline game.
#
#   python tools/build_game_data.py
#
# Input : site/asset/game/_raw/*.json   (fetch_all_tables.py output, gitignored)
# Output: site/asset/game/*.json        (shipped, runtime reads these directly)
#
# The offline game's data layer (rl-core/data/index.js) fetches these at boot
# and indexes them by primary key. This script does the join/prune work ONCE at
# build time so the runtime never touches the bulky raw tables (spec/03 §3:
# runtime reads only landed output, never hot-links the mirror).
#
# Design rules:
#   - Every output file is a { "<id>": { ... } } map keyed by the table's
#     primary key, so runtime lookups are O(1) and the harness can assert on
#     exact keys without re-deriving them from the raw array.
#   - Chinese display names are joined in from the translations CSVs so the UI
#     never carries a Japanese string as the player-facing label (spec/00 §6).
#   - A manifest.json is emitted last with the row count of every table so the
#     harness can verify nothing was silently truncated.

from __future__ import annotations

import csv
import io
import json
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "site" / "asset" / "game" / "_raw"
OUT = ROOT / "site" / "game" / "star" / "data"


def _trans_map(csv_name: str) -> dict[str, str]:
    """Load a translations CSV into {raw_name: zh_name}. Returns {} if absent."""
    path = RAW / "trans" / csv_name
    if not path.exists():
        return {}
    result: dict[str, str] = {}
    with path.open(encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        for row in reader:
            if len(row) >= 2:
                key = row[0].strip()
                val = row[1].strip()
                if key and val:
                    result[key] = val
    return result


def _index_by(rows: list[dict], key: str, keep: list[str] | None,
              name_field: str | None = None, name_map: dict[str, str] | None = None) -> dict[str, dict]:
    """Build an id-keyed dict, pruning to `keep` fields and joining zh names."""
    out: dict[str, dict] = {}
    for row in rows:
        raw_id = row.get(key)
        if raw_id is None:
            continue
        rid = str(raw_id)
        if keep is None:
            item = {k: v for k, v in row.items() if k != key}
        else:
            item = {k: row[k] for k in keep if k in row}
        if name_field and name_map is not None and name_field in row:
            raw_name = str(row.get(name_field, ""))
            item["nameZh"] = name_map.get(raw_name, raw_name)
        item["id"] = rid
        out[rid] = item
    return out


def load_raw(name: str) -> list[dict]:
    path = RAW / name
    if not path.exists():
        print(f"WARN  missing {name}")
        return []
    return json.loads(path.read_text(encoding="utf-8-sig"))


def emit(name: str, data: dict | list, manifest: dict[str, int]) -> None:
    """Write a table to OUT/<name>.json and record its size in the manifest.
    `data` may be an id-keyed dict (indexed tables) or a flat list (tables
    with no natural primary key)."""
    (OUT / f"{name}.json").write_text(
        json.dumps(data, ensure_ascii=False), encoding="utf-8")
    count = len(data)
    manifest[name] = count
    print(f"OK    {name}.json  ({count} entries)")


def build() -> dict[str, int]:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, int] = {}

    # -- character / class ---------------------------------------------------
    chara = load_raw("CharacterList.json")
    chara_names = _trans_map("CharacterList m_Name.csv")
    emit("character", _index_by(chara, "m_CharaID",
        ["m_ResourceID", "m_DedicatedAnimType", "m_HeadID", "m_BodyID",
         "m_DispScale", "m_Name", "m_NamedType", "m_Rare", "m_Class",
         "m_Element", "m_Cost", "m_GrowthTableID", "m_InitLv",
         "m_InitLimitLv", "m_InitHp", "m_InitAtk", "m_InitMgc", "m_InitDef",
         "m_InitMDef", "m_InitSpd", "m_InitLuck", "m_SkillLimitLv",
         "m_CharaSkillID", "m_ClassSkillIDs", "m_StunCoef",
         "m_AltItemID", "m_AltItemAmount", "m_LimitBreakRecipeID"],
        "m_Name", chara_names), manifest)

    emit("growth", load_raw("CharacterParamGrowthList.json"), manifest)
    emit("limitBreak", _index_by(load_raw("CharacterLimitBreakList.json"),
        "m_RecipeID", None), manifest)
    emit("evolution", _index_by(load_raw("CharacterEvolutionList.json"),
        "m_RecipeID", None), manifest)
    emit("characterWeapon", _index_by(load_raw("CharacterWeaponList.json"),
        "m_ID", None), manifest)
    emit("characterExp", load_raw("CharacterExp.json"), manifest)
    emit("characterFacial", _index_by(load_raw("CharacterFacial.json"),
        "m_ID", None), manifest)
    emit("class", load_raw("ClassList.json"), manifest)

    named = load_raw("NamedList.json")
    named_names = _trans_map("NamedList fullName.csv")
    emit("named", _index_by(named, "m_NamedType",
        ["m_TitleType", "m_ResouceBaseName", "m_NickName", "m_FullName",
         "m_BattleWinID"], "m_FullName", named_names), manifest)

    # -- battle / skills -----------------------------------------------------
    emit("battleDefine", load_raw("BattleDefine.json"), manifest)
    emit("battleAI", _index_by(load_raw("BattleAIDataList.json"),
        "m_ID", None), manifest)

    enemy = load_raw("QuestEnemyList.json")
    enemy_names = _trans_map("QuestEnemyList m_CharaName.csv")
    emit("enemy", _index_by(enemy, "m_ID",
        ["m_CharaName", "m_InitLv", "m_MaxLv", "m_InitHp", "m_MaxHp",
         "m_InitAtk", "m_MaxAtk", "m_InitMgc", "m_MaxMgc", "m_InitDef",
         "m_MaxDef", "m_InitMDef", "m_MaxMDef", "m_InitSpd", "m_MaxSpd",
         "m_Element", "m_SkillIDs", "m_DispScale"], "m_CharaName", enemy_names),
        manifest)
    emit("enemyResource", _index_by(load_raw("EnemyResourceList.json"),
        "m_ResourceID", None), manifest)

    for tag, raw in (
        ("skillPl", "SkillList_PL.json"),
        ("skillWpn", "SkillList_WPN.json"),
        ("skillEn", "SkillList_EN.json"),
        ("skillCard", "SkillList_CARD.json"),
        ("skillMst", "SkillList_MST.json"),
    ):
        emit(tag, _index_by(load_raw(raw), "m_ID", None), manifest)

    for tag, raw in (
        ("skillContentPl", "SkillContentList_PL.json"),
        ("skillContentWpn", "SkillContentList_WPN.json"),
        ("skillContentEn", "SkillContentList_EN.json"),
        ("skillContentCard", "SkillContentList_CARD.json"),
        ("skillContentMst", "SkillContentList_MST.json"),
    ):
        emit(tag, _index_by(load_raw(raw), "m_ID", None), manifest)

    for tag, raw in (
        ("passiveWpn", "PassiveSkillList_WPN.json"),
        ("passivePl", "PassiveSkillList_PL.json"),
        ("passiveEn", "PassiveSkillList_EN.json"),
        ("passiveAbl", "PassiveSkillList_ABL.json"),
    ):
        emit(tag, _index_by(load_raw(raw), "m_ID", None), manifest)

    emit("effect", _index_by(load_raw("EffectList.json"),
        "m_EffectID", None), manifest)
    emit("skillLvCoef", load_raw("SkillLvCoef.json"), manifest)
    emit("skillExp", _index_by(load_raw("SkillExp.json"), "m_ID", None), manifest)

    # -- gacha ---------------------------------------------------------------
    emit("gachaCutIn", load_raw("GachaCutInList.json"), manifest)
    emit("gachaItemLabel", _index_by(load_raw("GachaItemLabelList.json"),
        "m_ItemID", None), manifest)

    # -- weapon --------------------------------------------------------------
    weapon = load_raw("WeaponList.json")
    weapon_names = _trans_map("WeaponList m_WeaponName.csv")
    emit("weapon", _index_by(weapon, "m_ID",
        ["m_WeaponName", "m_WeaponType", "m_Element", "m_Class",
         "m_Stages", "m_SkillID", "m_PassiveSkillID", "m_DispScale",
         "m_IconID"], "m_WeaponName", weapon_names), manifest)
    emit("weaponRecipe", _index_by(load_raw("WeaponRecipeList.json"),
        "m_ID", None), manifest)
    emit("weaponEvolution", _index_by(load_raw("WeaponEvolutionList.json"),
        "m_RecipeID", None), manifest)
    emit("weaponExp", _index_by(load_raw("WeaponExp.json"), "m_ID", None), manifest)

    # -- quest ---------------------------------------------------------------
    emit("questLibrary", _index_by(load_raw("QuestLibraryList.json"),
        "id", None), manifest)
    emit("quest", _index_by(load_raw("QuestList.json"), "questID", None), manifest)
    emit("questWave", _index_by(load_raw("QuestWaveList.json"),
        "m_ID", None), manifest)
    emit("questWaveRandom", _index_by(load_raw("QuestWaveRandomList.json"),
        "m_ID", None), manifest)
    emit("questWaveDrops", _index_by(load_raw("QuestWaveDrops.json"),
        "m_ID", None), manifest)
    emit("questAdvTrigger", load_raw("QuestADVTrigger.json"), manifest)

    # -- item ----------------------------------------------------------------
    item = load_raw("ItemList.json")
    item_names = _trans_map("ItemList m_Name.csv")
    emit("item", _index_by(item, "m_ID",
        ["m_Name", "m_ItemType", "m_Rare", "m_IconID", "m_SellPrice",
         "m_StackSize", "m_Desc"], "m_Name", item_names), manifest)
    emit("fieldItemDrop", _index_by(load_raw("FieldItemDropList.json"),
        "m_ID", None), manifest)
    emit("packageItem", _index_by(load_raw("PackageItemList.json"),
        "id", None), manifest)
    emit("packageItemContents", _index_by(load_raw("PackageItemContents.json"),
        "id", None), manifest)

    # -- town / room ---------------------------------------------------------
    emit("townObject", _index_by(load_raw("TownObjectList.json"),
        "m_ID", None), manifest)
    emit("townObjectLevelUp", _index_by(load_raw("TownObjectLevelUp.json"),
        "m_ID", None), manifest)
    emit("townObjectBuff", _index_by(load_raw("TownObjectBuff.json"),
        "m_ID", None), manifest)
    emit("townShop", _index_by(load_raw("TownShopList.json"),
        "m_ID", None), manifest)
    emit("room", _index_by(load_raw("RoomList.json"), "m_ID", None), manifest)
    emit("roomObject", _index_by(load_raw("RoomObjectList.json"),
        "m_ID", None), manifest)
    emit("roomShop", _index_by(load_raw("RoomShopList.json"),
        "m_ID", None), manifest)

    # room presets are split into 38 small files, no single primary key;
    # merge into one flat array (runtime indexes by m_FloorID + m_Category).
    preset_list: list[dict] = []
    for p in sorted(RAW.glob("ContentRoomPreset_*.json")):
        preset_list.extend(json.loads(p.read_text(encoding="utf-8-sig")))
    emit("roomPreset", preset_list, manifest)

    # -- adv -----------------------------------------------------------------
    emit("adv", _index_by(load_raw("ADVList.json"), "m_AdvID",
        ["m_Category", "m_Title", "m_LibraryID", "m_NamedType", "m_CharaID",
         "m_PresentGemNum", "m_PresentMessageID"]), manifest)
    adv_lib = load_raw("ADVLibraryList.json")
    adv_lib_names = _trans_map("ADVLibraryList m_ListName.csv")
    emit("advLibrary", _index_by(adv_lib, "m_LibraryListID",
        ["m_Category", "m_Part", "m_ListName"], "m_ListName", adv_lib_names), manifest)
    emit("originalCharaLibrary", _index_by(
        load_raw("OriginalCharaLibraryList.json"), "m_ID", None), manifest)

    # -- master orb ----------------------------------------------------------
    emit("masterOrb", _index_by(load_raw("MasterOrbList.json"),
        "m_ID", None), manifest)
    emit("masterOrbBuffs", _index_by(load_raw("MasterOrbBuffs.json"),
        "m_ID", None), manifest)
    emit("masterRank", _index_by(load_raw("MasterRank.json"),
        "m_Rank", None), manifest)

    # -- sound ---------------------------------------------------------------
    emit("bgm", _index_by(load_raw("SoundBgmList.json"), "m_ID", None), manifest)
    # SoundHomeBgmList has no single primary key; emit as flat array
    emit("homeBgm", load_raw("SoundHomeBgmList.json"), manifest)
    emit("se", _index_by(load_raw("SoundSeList.json"), "m_ID", None), manifest)
    emit("voice", _index_by(load_raw("SoundVoiceList.json"),
        "m_ID", None), manifest)
    emit("voiceControll", _index_by(load_raw("SoundVoiceControllList.json"),
        "m_ID", None), manifest)
    emit("soundCue", load_raw("SoundCueList.json"), manifest)
    emit("soundCueSheet", load_raw("SoundCueSheet.json"), manifest)

    # -- misc ----------------------------------------------------------------
    emit("sceneInfo", _index_by(load_raw("SceneInfoList.json"),
        "m_SceneID", None), manifest)
    title = load_raw("TitleList.json")
    title_names = _trans_map("TitleList m_DisplayName.csv")
    emit("title", _index_by(title, "m_TitleType",
        ["m_Order", "m_DisplayName", "m_LimitBreakItemID", "m_Descript",
         "m_Playable", "m_BGName"], "m_DisplayName", title_names), manifest)
    emit("moviePlay", load_raw("MoviePlayList.json"), manifest)
    emit("popUpStateIcon", load_raw("PopUpStateIconList.json"), manifest)
    emit("retireTips", _index_by(load_raw("RetireTipsList.json"),
        "m_ID", None), manifest)
    emit("namedFriendshipExp", load_raw("NamedFriendshipExp.json"), manifest)
    emit("webData", _index_by(load_raw("WebDataList.json"),
        "m_ID", None), manifest)
    emit("wordLibrary", load_raw("WordLibraryList.json"), manifest)
    emit("achievement", _index_by(load_raw("AchievementList.json"),
        "id", None), manifest)
    emit("arousalLevel", _index_by(load_raw("ArousalLevels.json"),
        "m_ID", None), manifest)

    # -- manifest last -------------------------------------------------------
    (OUT / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nmanifest: {len(manifest)} tables, "
          f"{sum(manifest.values())} total entries")
    return manifest


if __name__ == "__main__":
    build()
