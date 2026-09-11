# Dump the kirafan database + translations into asset/rl/_raw/ (T01, spec/03 §3).
#
#   python tools/fetch_database.py
#
# Sources (verified 2026-09-02, spec/03 §1):
#   S4  gitlab.com/kirafan/database  /-/raw/master/database/<Table>.json
#   S5  gitlab.com/kirafan/translations  /-/raw/master/trans/<Table> <Field>.csv
#
# _raw/ is a fetch-cache intermediate, gitignored -- build_rl_data.py turns it
# into the shipped asset/rl/*.json tables, after which this never needs to run
# again (the whole point: the mirrors are not load-bearing).
#
# Discipline per spec/03 §3: resume (existing non-zero file is skipped),
# User-Agent kirafan-timer-advbg/1.0, 5 attempts with exponential backoff.

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
RAW = ROOT / "asset" / "rl" / "_raw"

DATABASE_RAW = "https://gitlab.com/kirafan/database/-/raw/master/database/"
TRANSLATIONS_RAW = "https://gitlab.com/kirafan/translations/-/raw/master/trans/"

HTTP_HEADERS = {"User-Agent": "kirafan-timer-advbg/1.0"}

# Tables read by the roguelike (spec/04 §1). CARD has its own ID namespace:
# asset/battle/skills.js cannot substitute for its effect arguments.
#
# 2026-09-02 (stage 3): SkillList_PL / SkillContentList_PL were added because
# the local asset/battle/skills.js turned out to carry name/detail/type/load
# but *no recast and no effect args* — and stage 3 needs exactly those two
# (cooldown = m_Recasts x 0.35s, spec/04 §4; skill coefficient = m_Args[0]/1000).
#
# Enemy skills live in their own pair, suffix _EN (not _ENEMY -- that 404s):
# QuestEnemyList.m_SkillIDs resolve in NEITHER _PL nor _WPN (0 of 2788 checked),
# so the danmaku pattern mapping needs SkillList_EN's m_SAP/m_SAG prefab names.
TABLES = [
    "CharacterList.json",             # 1281: six-stat truth, class, element, growth id
    "CharacterParamGrowthList.json",  # 100: Lv1-100 x 5 growth curves
    "CharacterLimitBreakList.json",   # 15: LB steps (+5 cap x4)
    "CharacterEvolutionList.json",    # 694: evolution chains
    "CharacterWeaponList.json",       # 162: chara -> dedicated weapon
    "WeaponList.json",                # 845: weapon identity, stages, four flat stats
    "SkillList_WPN.json",             # 232: weapon skills (recast/load/detail)
    "SkillContentList_WPN.json",      # 232: weapon skill effect args
    "PassiveSkillList_WPN.json",      # 162: final-evolution passives (affix pool)
    "SkillList_PL.json",              # 2906: player skills (recast/load/detail/name)
    "SkillContentList_PL.json",       # 2905: player skill effect args (coefficient)
    "SkillList_EN.json",              # enemy skills: name/recast/SAP-SAG prefab names
    "SkillContentList_EN.json",       # enemy skill effect args (danmaku pattern pick)
    "SkillList_CARD.json",            # autonomous skill-card load factors and names
    "SkillContentList_CARD.json",     # CARD payloads, never same-number PL/EN rows
    "QuestEnemyList.json",            # 2068: enemy Init/Max six-stat truth
    "EnemyResourceList.json",         # 604: enemy model key, boss flag, voice sheet
    "ClassList.json",                 # 5: class base weapon / normal-attack skill
    "NamedList.json",                 # 246: profiles / formalStatus
    "QuestLibraryList.json",          # chapters + 37 work libraries (volume split)
    "TownObjectList.json",            # town resource IDs and exact work ownership
    "TitleList.json",                 # work IDs and original display names
]

# The translation CSVs that exist in the repo (tree listing 2026-09-02); the
# enemy names are the one the plan calls out as load-bearing (289 rows).
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

    for name in TABLES:
        dest = RAW / name
        status = pull(DATABASE_RAW + urllib.parse.quote(name), dest)
        # validate JSON on first pull -- a truncated table would poison every
        # downstream build silently
        try:
            rows = json.loads(dest.read_text(encoding="utf-8-sig"))
            if not isinstance(rows, list) or not rows:
                raise ValueError("not a non-empty JSON array")
        except (ValueError, json.JSONDecodeError) as error:
            failures.append(f"{name}: {error}")
            print(f"BAD   {name}  {error}")
            continue
        print(f"{status:5s} {name}  ({len(rows)} rows)")

    for name in TRANSLATIONS:
        dest = trans_dir / name
        status = pull(TRANSLATIONS_RAW + urllib.parse.quote(name), dest)
        text = dest.read_text(encoding="utf-8-sig")
        lines = [line for line in text.splitlines() if line.strip()]
        if len(lines) < 10:
            failures.append(f"{name}: only {len(lines)} lines")
            print(f"BAD   {name}  ({len(lines)} lines)")
            continue
        print(f"{status:5s} trans/{name}  ({len(lines) - 1} entries)")

    if failures:
        print(f"\n{len(failures)} FAILED:")
        for entry in failures:
            print(f"  {entry}")
        sys.exit(1)
    print("\nall tables landed")


if __name__ == "__main__":
    main()
