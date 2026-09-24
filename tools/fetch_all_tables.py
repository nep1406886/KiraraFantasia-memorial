# Pull the full kirafan database into asset/game/_raw/ for the offline game
# reimplementation.
#
#   python tools/fetch_all_tables.py
#
# Unlike tools/fetch_database.py (which serves the roguelike and pins 21 tables),
# this fetches every table the offline game's data pipeline needs. Sources are
# the same verified mirrors:
#
#   S4  gitlab.com/kirafan/database    /-/raw/master/database/<Table>.json
#   S5  gitlab.com/kirafan/translations /-/raw/master/trans/<Table> <Field>.csv
#
# _raw/ is a fetch-cache intermediate, gitignored. build_game_data.py turns it
# into the shipped asset/game/*.json tables; after that this never needs to run
# again (the mirrors are not load-bearing, spec/03 §3).
#
# Discipline per spec/03 §3: resume (existing non-zero file is skipped),
# User-Agent kirafan-timer-advbg/1.0, 5 attempts with exponential backoff,
# JSON validated on first pull so a truncated table cannot poison the build.

from __future__ import annotations

import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "site" / "asset" / "game" / "_raw"

DATABASE_RAW = "https://gitlab.com/kirafan/database/-/raw/master/database/"
TRANSLATIONS_RAW = "https://gitlab.com/kirafan/translations/-/raw/master/trans/"

HTTP_HEADERS = {"User-Agent": "kirafan-timer-advbg/1.0"}

# ---------------------------------------------------------------------------
# Tables the offline game reads at runtime, grouped by subsystem.
# Every entry is a real file on the mirror (verified via the GitLab tree API,
# 2026-09-24, 402 total tables). GachaList and FieldPartyList are server-side
# only (not on the mirror) -- gacha draws are derived from GachaItemLabelList +
# CharacterList, and the field-party schedule from TownObjectList.
# ---------------------------------------------------------------------------

CHARACTER = [
    "CharacterList.json",             # 1281: six-stat truth, class, element, growth id, skill ids
    "CharacterParamGrowthList.json",  # 100: Lv1-100 x 5 growth curves
    "CharacterLimitBreakList.json",   # 15: limit-break steps
    "CharacterEvolutionList.json",    # 694: evolution chains
    "CharacterWeaponList.json",       # 162: chara -> dedicated weapon
    "CharacterWeaponOverride.json",
    "CharacterExp.json",              # exp-to-level curve
    "CharacterFacial.json",           # facial expression mapping
    "CharacterFlavorText.json",       # character bio / flavor
    "CharacterIllustOffset.json",     # illust anchor offsets
    "CharacterOverride.json",
    "CharacterQuestList.json",        # chara -> quest appearance
    "ClassList.json",                 # 5: class base weapon / normal-attack skill
    "NamedList.json",                 # 246: profiles / formalStatus
]

BATTLE = [
    "BattleDefine.json",              # buff/abnormal/element/coefficient tables
    "BattleAIDataList.json",          # enemy AI patterns
    "BattleRandomStatusChange.json",
    "BattleStatusRatioByHp.json",
    "QuestEnemyList.json",            # 2068: enemy Init/Max six-stat truth, skill ids
    "EnemyResourceList.json",         # 604: enemy model key, boss flag, voice sheet
    "SkillList_PL.json",              # 2906: player skills
    "SkillContentList_PL.json",       # 2905: player skill effect args
    "SkillList_WPN.json",             # 232: weapon skills
    "SkillContentList_WPN.json",
    "SkillList_EN.json",              # enemy skills: name/recast/SAP-SAG
    "SkillContentList_EN.json",
    "SkillList_CARD.json",            # autonomous skill-card load factors
    "SkillContentList_CARD.json",
    "SkillList_MST.json",             # master orb skills
    "SkillContentList_MST.json",
    "PassiveSkillList_WPN.json",      # 162: final-evolution passives (affix pool)
    "PassiveSkillList_PL.json",
    "PassiveSkillList_EN.json",
    "PassiveSkillList_ABL.json",
    "EffectList.json",                # visual effect definitions
    "SkillLvCoef.json",
    "SkillExp.json",
    "SkillActionConverts_SAG.json",
    "SkillActionConverts_SAP.json",
    "SkillContentAndEffectCombi.json",
]

GACHA = [
    "GachaCutInList.json",            # gacha cut-in scenes
    "GachaItemLabelList.json",        # rarity/label probabilities
]

WEAPON = [
    "WeaponList.json",                # 845: weapon identity, stages, four flat stats
    "WeaponRecipeList.json",          # crafting recipes
    "WeaponEvolutionList.json",       # weapon evolution
    "WeaponExp.json",                 # weapon exp
    "WeaponSkillUpItems.json",
]

QUEST = [
    "QuestLibraryList.json",          # chapters + 37 work libraries
    "QuestList.json",                 # quest definitions
    "QuestWaveList.json",             # waves per quest
    "QuestWaveRandomList.json",
    "QuestWaveDrops.json",            # drop tables
    "QuestADVTrigger.json",           # ADV triggers mid-quest
    "QuestMapResourceList.json",
    "QuestMapSDPosition.json",
    "EventQuestDropExt.json",
    "EventQuestUISetting.json",
]

ITEM = [
    "ItemList.json",                  # all items (currency, materials, equipment)
    "FieldItemDropList.json",
    "PackageItemList.json",
    "PackageItemContents.json",
]

TOWN_ROOM = [
    "TownObjectList.json",            # town resources + field-party schedule
    "TownObjectLevelUp.json",
    "TownObjectBuff.json",
    "TownObjectBuildSubCode.json",
    "TownShopList.json",
    "RoomList.json",
    "RoomObjectList.json",
    "RoomObjectFilterCategory.json",
    "RoomShopList.json",
    "RoomEnvEffect.json",
    "ContentRoomPreset_0000.json",
    "ContentRoomPreset_0001.json",
    "ContentRoomPreset_0002.json",
    "ContentRoomPreset_0003.json",
    "ContentRoomPreset_0004.json",
    "ContentRoomPreset_0005.json",
    "ContentRoomPreset_0006.json",
    "ContentRoomPreset_0007.json",
    "ContentRoomPreset_0008.json",
    "ContentRoomPreset_0009.json",
    "ContentRoomPreset_0010.json",
    "ContentRoomPreset_0011.json",
    "ContentRoomPreset_0012.json",
    "ContentRoomPreset_0013.json",
    "ContentRoomPreset_0014.json",
    "ContentRoomPreset_0015.json",
    "ContentRoomPreset_0016.json",
    "ContentRoomPreset_0017.json",
    "ContentRoomPreset_0018.json",
    "ContentRoomPreset_0019.json",
    "ContentRoomPreset_0020.json",
    "ContentRoomPreset_0021.json",
    "ContentRoomPreset_0022.json",
    "ContentRoomPreset_0023.json",
    "ContentRoomPreset_0024.json",
    "ContentRoomPreset_0025.json",
    "ContentRoomPreset_0026.json",
    "ContentRoomPreset_0027.json",
    "ContentRoomPreset_0028.json",
    "ContentRoomPreset_0029.json",
    "ContentRoomPreset_0030.json",
    "ContentRoomPreset_0031.json",
    "ContentRoomPreset_0032.json",
    "ContentRoomPreset_0033.json",
    "ContentRoomPreset_0035.json",
    "ContentRoomPreset_0036.json",
    "ContentRoomPreset_0037.json",
]

ADV = [
    "ADVList.json",                   # dialogue lines
    "ADVLibraryList.json",            # ADV libraries (story chunks)
    "OriginalCharaLibraryList.json",  # original-character libraries
]

MASTERORB = [
    "MasterOrbList.json",
    "MasterOrbBuffs.json",
    "MasterRank.json",
]

SOUND = [
    "SoundBgmList.json",
    "SoundHomeBgmList.json",
    "SoundSeList.json",
    "SoundVoiceList.json",
    "SoundVoiceControllList.json",
    "SoundCueList.json",
    "SoundCueSheet.json",
]

MISC = [
    "SceneInfoList.json",             # scene definitions
    "TitleList.json",                 # work IDs + display names
    "MoviePlayList.json",
    "PopUpStateIconList.json",
    "RetireTipsList.json",
    "NamedFriendshipExp.json",
    "WebDataList.json",
    "WordLibraryList.json",
    "AssetBundleDownloadList_Always.json",
    "AssetBundleDownloadList_First.json",
    "AchievementList.json",
    "ArousalLevels.json",
]

ALL_TABLES: list[str] = (
    CHARACTER + BATTLE + GACHA + WEAPON + QUEST + ITEM + TOWN_ROOM
    + ADV + MASTERORB + SOUND + MISC
)

# Translation CSVs (same set as fetch_database.py plus ADV).
TRANSLATIONS = [
    "QuestEnemyList m_CharaName.csv",
    "CharacterList m_Name.csv",
    "WeaponList m_WeaponName.csv",
    "ItemList m_Name.csv",
    "NamedList fullName.csv",
    "ADVLibraryList m_ListName.csv",
    "TitleList m_DisplayName.csv",
]


def fetch(url: str, attempts: int = 5) -> bytes:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers=HTTP_HEADERS)
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except (OSError, urllib.error.URLError) as error:
            last_error = error
            if attempt + 1 < attempts:
                time.sleep(min(8, 2 ** attempt))
    raise RuntimeError(f"unable to fetch {url}: {last_error}")


def pull(url: str, dest: Path) -> str:
    """Fetch url -> dest with resume. Returns 'skip'/'ok'."""
    if dest.exists() and dest.stat().st_size > 0:
        return "skip"
    data = fetch(url)
    dest.write_bytes(data)
    return "ok"


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    trans_dir = RAW / "trans"
    trans_dir.mkdir(parents=True, exist_ok=True)

    failures: list[str] = []
    fetched = 0
    skipped = 0

    for name in ALL_TABLES:
        dest = RAW / name
        status = pull(DATABASE_RAW + urllib.parse.quote(name), dest)
        if status == "ok":
            fetched += 1
        else:
            skipped += 1
        # validate JSON on first pull -- a truncated table would poison the build
        try:
            rows = json.loads(dest.read_text(encoding="utf-8-sig"))
            if not isinstance(rows, list):
                raise ValueError("not a JSON array")
            print(f"{status:5s} {name}  ({len(rows)} rows)")
        except (ValueError, json.JSONDecodeError) as error:
            failures.append(f"{name}: {error}")
            print(f"BAD   {name}  {error}")

    for name in TRANSLATIONS:
        dest = trans_dir / name
        status = pull(TRANSLATIONS_RAW + urllib.parse.quote(name), dest)
        text = dest.read_text(encoding="utf-8-sig")
        lines = [line for line in text.splitlines() if line.strip()]
        if len(lines) < 1:
            failures.append(f"{name}: empty")
            print(f"BAD   trans/{name}  (empty)")
        else:
            print(f"{status:5s} trans/{name}  ({len(lines) - 1} entries)")

    print(f"\n{fetched} fetched, {skipped} already present, {len(failures)} failed")
    if failures:
        print("FAILED:")
        for entry in failures:
            print(f"  {entry}")
        sys.exit(1)
    print("all tables landed in site/asset/game/_raw/")


if __name__ == "__main__":
    main()
