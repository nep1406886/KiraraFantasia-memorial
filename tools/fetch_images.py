#!/usr/bin/env python3
"""Download and convert T02's image set from S1 PNG links (spec/03 §2–3).

    python tools/fetch_images.py
    python tools/fetch_images.py --dry-run     # print the job list, fetch nothing
    python tools/fetch_images.py --category icon

Discipline (spec/03 §3): resume on existing non-zero files, User-Agent
`kirafan-timer-advbg/1.0`, 5 attempts with exponential backoff. urllib on this
host occasionally 500s the 2–4 MB `bg_menu_*` files that curl gets as 200, so
a failed urllib attempt is retried via curl before the next backoff.

Id sources (all local, no CDN index needed at runtime):

  card     volumes.json roster 40 cardIds — the ★5 card face via the
           same-name ladder (T22l: 34 of 40 reach a ★5, 6 top out at
           rare-4), written under the roster id as filename
  bust     same 40, cropped to 512 wide
  illust   same 40, falling back to the same-name ★5 card when the roster
           card has no charaillustfull (740 of 1281 exist; 6 of 40 have none)
  icon     CharacterList 1281 m_CharaID (codex)
  weapon   weapons-rl.json catalog: 224 family icons, including 62 generic weapons
  item     a 60-id seed of evergreen materials (seeds/orbs/buds/symbols/
           stamina/currency). Loot design is T10; this seed is the shop/
           HUD placeholder until then
  orig     OriginalCharaLibraryList 1–52, restricted to the 25 ids that
           appear in spec/05 (七贤者 / 真実の手 / 城镇 / 主线)
  ui       18 of the 19 bg_menu backgrounds, letterbox-trimmed and resized
           to 1600 wide. Six carry the spec/03 §2 role names, twelve are
           scene beds for the volumes and hub screens (see UI_PICKS)

Output: asset/img/rl/{card,illust,bust,icon,weapon,item,orig,ui}/*.webp
        asset/rl/images.json  [{id, category, file, w, h}, ...]
"""

from __future__ import annotations

import argparse
import collections
import io
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

try:
    from PIL import Image
except ImportError as error:  # pragma: no cover
    raise SystemExit("Pillow is required: pip install Pillow") from error

ROOT = Path(__file__).resolve().parent.parent
OUT_ROOT = ROOT / "asset" / "img" / "rl"
INDEX_PATH = ROOT / "asset" / "rl" / "images.json"
CACHE = ROOT / ".cache" / "rl-images"
LOCAL_INDEX = ROOT / ".codex-tmp" / "assetBundle.json"

HTTP_HEADERS = {"User-Agent": "kirafan-timer-advbg/1.0"}
S1 = "https://asset.kirafan.cn/texture//{path}.png"
WEBP_QUALITY = 82
BUST_WIDTH = 512
LETTERBOX_MAX_SUM = 90
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

# OriginalCharaLibraryList ids that spec/05 actually uses. Town NPCs (クレア/
# ポルカ/コルク/カンナ/ライネ), 七贤者, 真実の手, 主线 (きらら/ランプ/マッチ/
# うつつ/メディア/ソラ/アルシーヴ/ハイプリス). The other 27 are event extras
# (ナビっち, 暗黒冬将軍, メイド長, …) and stay off the budget.
ORIG_IDS = [
    1, 2, 3,          # きらら / ランプ / マッチ
    4, 5, 6, 7, 8,    # クレア / ポルカ / コルク / カンナ / ライネ
    9, 10,            # ソラ / アルシーヴ
    12, 13, 14, 15, 16, 17, 18,  # 七贤者
    38, 39, 40,       # うつつ / メディア / ハイプリス
    41, 42, 43, 44, 45, 46, 47, 48,  # 真実の手
]

# Evergreen ItemList ids that a HUD/shop can show before T10 names the loot
# table. Ids, names and m_Type below were read back out of
# .codex-tmp/ItemList.json (2026-09-02) rather than guessed — the icons alone
# are ambiguous (id 12 竜の大牙 reads as a cream pastry at 128², id 17
# 緑の水晶 as a plain gem). Event tickets and grade fruits stay out.
ITEM_IDS = [
    # 属性の小種 (type 0): 炎/風/土/水/月/陽
    2000, 2001, 2002, 2003, 2004, 2005,
    # 属性の小進化珠 (type 1): same six elements
    6000, 6001, 6002, 6003, 6004, 6005,
    # 職業のつぼみ (type 2) then 職業の果実 — せんし/ナイト/まほうつかい/
    # アルケミスト/そうりょ, in class order both times
    4000, 4001, 4002, 4003, 4004,
    4005, 4006, 4007, 4008, 4009,
    # type 3, two runs: 1–5 職業シンボル (same class order), then 6–20 汎用素材
    # (木の根 → 硬い石 → 古木の小枝 → 光輝岩 → 怪しい爪 → 銅の繊維 →
    # 竜の大牙 → ブロンズ塊 → 異界の鉱石 → 水晶のかけら → 角鋼 →
    # 緑の水晶 → ぷにぷに石 → 古びた琥珀 → ブラックストーン)
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    # スタミナ回復アイテム 小/中/大 (type 7)
    1000, 1001, 1002,
    # かけら・メダル (type 6) + エトワリウム (999 is type 8, not 6)
    998, 999, 9000, 9001, 9002, 9003, 9004,
    # クエストキー 銀/金/樹/虹 (type 4, the four evergreen ones)
    1003, 1004, 1009, 1010,
    # スキルアップパウダー（専用ぶき） (type 10)
    9005,
]

# Menu/scene backgrounds. All 19 `bg_menu_*` files were fetched to the PNG
# cache and looked at (contact sheet, 2026-09-02) before this list was written
# — the first pass picked them by mean-luma statistics and got them backwards:
# the family is not a set of paper washes, it is *scene art*, so com_01_25
# ("darkest") is in fact the 世界樹＋白の都＋花畑 hero image and com_01_00 is the
# エトワリア world map. Ids below are roles, `why` records what the art shows.
#
# The six spec/03 §2 role names (title/select/shop/settings/result/dark) plus
# twelve scene beds the volumes and hub screens need. bg_menu_com_02_11 is the
# only one of the 19 left out: it is the same inn bedroom as com_02_07 one stop
# darker, so it buys nothing.
#
# All of them carry a baked 204 px black letterbox top and bottom of the 2048²
# canvas (com_02_13 does not). `trim` strips it — a background with black bars
# in the middle of a full-bleed screen is a bug, not a look — and `crop_w`
# lands them at 1600 wide, which is ~270 KB each instead of 580 KB at 2048².
UI_PICKS = [
    # --- the six contracted roles (spec/03 §2) --------------------------
    {
        "id": "title",
        "bundle": "bg_menu_com_01_25",
        "why": "the 世界樹 with the white capital at its roots over a blue "
               "flower meadow, petals drifting — the single most iconic frame "
               "of the 19 and the only one that reads as a title card.",
    },
    {
        "id": "select",
        "bundle": "bg_menu_com_01_00",
        "why": "the エトワリア world map from above (世界樹 city centre, ocean, "
               "desert plateau, lighthouse village). A map is what a "
               "volume/character select should sit on.",
    },
    {
        "id": "shop",
        "bundle": "bg_menu_com_02_01",
        "why": "town market square: awnings, produce crates, fountain. Busy "
               "but low-contrast in the lower half, so item icons stay "
               "readable on top.",
    },
    {
        "id": "settings",
        "bundle": "bg_menu_com_02_04",
        "why": "drafting studio interior — tilted board, blueprints, tool "
               "shelves, pinned notes. A workbench is the right register for "
               "a settings panel.",
    },
    {
        "id": "result",
        "bundle": "bg_menu_com_01_16",
        "why": "river valley between steep green mountains with a hawk. Calm "
               "and wide; a post-run summary wants a still field, not a "
               "battle wash.",
    },
    {
        "id": "dark",
        "bundle": "bg_menu_btl_0001",
        "why": "ancient forest in teal gloom, gnarled roots, no sky — "
               "genuinely the darkest of the 19. Doubles as 卷三「贪食之森」's "
               "bed, which is why there is no separate scene_forest.",
    },
    # --- scene beds for the five volumes and the hub screens ------------
    {
        "id": "scene_sea",
        "bundle": "bg_menu_com_01_09",
        "why": "seaside town over a turquoise bay, jetty, white blossom. "
               "卷一「褪色之海」.",
    },
    {
        "id": "scene_sand",
        "bundle": "bg_menu_com_01_12",
        "why": "dune field with an oasis and a cliff-top sand city. "
               "卷二「沉眠之沙」.",
    },
    {
        "id": "scene_library",
        "bundle": "bg_menu_btl_0013",
        "why": "white-and-gold cathedral facade with twin spires, low camera. "
               "The 図書館 exterior / hub establishing shot.",
    },
    {
        "id": "scene_study",
        "bundle": "bg_menu_com_02_05",
        "why": "lamplit study with desk, birdcage and warm evening light — "
               "the camp interior between runs.",
    },
    {
        "id": "scene_store",
        "bundle": "bg_menu_com_02_03",
        "why": "apothecary/general store interior, shelves of labelled jars "
               "behind a counter. The item shop's inside.",
    },
    {
        "id": "scene_forge",
        "bundle": "bg_menu_com_02_02",
        "why": "blacksmith forge, furnace lit, tools on the wall. Equipment "
               "and 突破 screens.",
    },
    {
        "id": "scene_inn",
        "bundle": "bg_menu_com_02_07",
        "why": "inn bedroom, two beds, daylight through the curtains. Rest "
               "points and 休息点闲聊 (spec/05 §5 rest_*).",
    },
    {
        "id": "scene_train",
        "bundle": "bg_menu_com_02_06",
        "why": "training yard: stone wall, dirt ground, two straw dummies "
               "with red targets. The tutorial stage bed.",
    },
    {
        "id": "scene_town",
        "bundle": "bg_menu_com_02_13",
        "why": "town street at eye level, shopfronts and awning. The only one "
               "of the 19 with no letterbox. 城镇 dialogue.",
    },
    {
        "id": "scene_field",
        "bundle": "bg_menu_com_01_01",
        "why": "green pastoral hills, split-rail fence, village in the "
               "middle distance. Generic daytime overworld.",
    },
    {
        "id": "scene_village",
        "bundle": "bg_menu_btl_0018",
        "why": "autumn village from above, red roofs on golden fields. "
               "Volume-open establishing shot with a different season.",
    },
    {
        "id": "scene_room",
        "bundle": "bg_menu_btl_0011",
        "why": "sunlit interior room with a long table, desk and bookcase — "
               "the everyday-life register the 日常 4-koma casts need.",
    },
]
UI_WIDTH = 1600


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def roster_ids() -> list[int]:
    data = load_json(ROOT / "asset" / "rl" / "volumes.json")
    ids = [int(row["cardId"]) for row in data["roster"]]
    playable = ROOT / "asset" / "rl" / "playable-roster.json"
    if playable.exists():
        ids.extend(int(row["id"]) for row in load_json(playable)["cards"])
    return list(dict.fromkeys(ids))


def character_ids() -> list[int]:
    rows = load_json(ROOT / "asset" / "rl" / "_raw" / "CharacterList.json")
    return sorted({int(row["m_CharaID"]) for row in rows})


def weapon_ids() -> list[int]:
    data = load_json(ROOT / "asset" / "rl" / "weapons-rl.json")
    return sorted({int(row["iconId"]) for row in data["catalog"]})


def illust_fallback(roster: list[int]) -> dict[int, int | None]:
    """Map roster cardId -> an id that actually has a charaillustfull.

    Never substitute another card's costume or class under this card's ID.
    Missing full art stays absent; the UI can use the exact card/icon instead.
    """
    cards = load_json(ROOT / "asset" / "rl" / "cards-rl.json")["cards"]
    by_id = {int(c["id"]): c for c in cards}
    by_name: dict[str, list[dict]] = collections.defaultdict(list)
    for card in cards:
        by_name[card["name"]].append(card)
    have = bundle_set()
    out: dict[int, int | None] = {}
    for card_id in roster:
        card = by_id[card_id]
        if has_illust(card_id, have):
            out[card_id] = card_id
            continue
        out[card_id] = None
    return out


def card_star5(roster: list[int]) -> dict[int, int]:
    """Map roster cardId -> the same-name ★5 card's id (user feedback 12③:
    尽量使用角色的五星卡面).

    The ladder is the same one illust_fallback uses: highest rare first,
    evolved preferred, lowest id breaks ties — 34 of 40 reach a ★5 this way,
    the rest (6) top out at their own rare-4 roster card, which IS the pick,
    so their file simply re-fetches the same texture. The output file keeps
    the ROSTER id as its name (roster.js/infocard.js build the URL from the
    truth-table row id), so only the pixels change, never the key.

    No local-index existence gate here on purpose: the mirror index misses
    characard entries the CDN demonstrably serves (probed 200 on the roster's
    own ★5 rows), and a failed fetch leaves the shipped webp untouched,
    which is the correct fallback anyway.
    """
    cards = load_json(ROOT / "asset" / "rl" / "cards-rl.json")["cards"]
    by_id = {int(c["id"]): c for c in cards}
    by_name: dict[str, list[dict]] = collections.defaultdict(list)
    for card in cards:
        by_name[card["name"]].append(card)
    out: dict[int, int] = {}
    for card_id in roster:
        card = by_id[card_id]
        group = sorted(
            by_name[card["name"]],
            key=lambda c: (-int(c["rare"]), bool(c.get("evolved")), int(c["id"])),
        )
        out[card_id] = int(group[0]["id"])
    return out


def bundle_set() -> set[str]:
    if not LOCAL_INDEX.exists():
        return set()
    entries = load_json(LOCAL_INDEX)
    names = []
    for entry in entries:
        if isinstance(entry, str):
            names.append(entry)
        else:
            names.append(entry.get("name", ""))
    return set(names)


def has_illust(card_id: int, names: set[str]) -> bool:
    return (
        f"texture/charauiresource/charaillustfull/charaillust_full_{card_id}.muast"
        in names
    )


def s1_url(rel: str) -> str:
    return S1.format(path=rel)


def jobs_for(category: str | None) -> list[dict]:
    roster = roster_ids()
    jobs: list[dict] = []

    def add(cat, ident, rel, *, crop_w=None, filename=None, trim=False):
        if category and cat != category:
            return
        name = filename or f"{ident}.webp"
        jobs.append({
            "category": cat,
            "id": ident,
            "rel": rel,
            "url": s1_url(rel),
            "file": f"{cat}/{name}",
            "crop_w": crop_w,
            "trim": trim,
        })

    if category in (None, "card"):
        # The filename and original art must name the same unique card.
        for card_id in roster:
            add("card", card_id,
                f"charauiresource/characard/characard_{card_id}")
    if category in (None, "bust"):
        for card_id in roster:
            add("bust", card_id, f"charauiresource/bustfull/bustfull_{card_id}",
                crop_w=BUST_WIDTH)
    if category in (None, "illust"):
        fallback = illust_fallback(roster)
        for card_id in roster:
            pick = fallback[card_id]
            if pick is None:
                print(f"skip illust {card_id}: no charaillustfull in name group")
                continue
            add("illust", card_id,
                f"charauiresource/charaillustfull/charaillust_full_{pick}",
                filename=f"{card_id}.webp")
    if category in (None, "icon"):
        for chara_id in character_ids():
            add("icon", chara_id, f"charauiresource/charaicon/charaicon_{chara_id}")
    if category in (None, "weapon"):
        for weapon_id in weapon_ids():
            add("weapon", weapon_id, f"weaponicon/weaponicon_wpn_{weapon_id}")
    if category in (None, "item"):
        for item_id in ITEM_IDS:
            add("item", item_id, f"itemicon/itemicon_{item_id}")
    if category in (None, "orig"):
        for orig_id in ORIG_IDS:
            add("orig", f"illust_{orig_id}",
                f"originalcharacterillust/originalcharacterillust_{orig_id}",
                filename=f"illust_{orig_id}.webp")
            add("orig", f"icon_{orig_id}",
                f"originalcharactericon/originalcharactericon_{orig_id}",
                filename=f"icon_{orig_id}.webp")
    if category in (None, "ui"):
        for pick in UI_PICKS:
            add("ui", pick["id"], f"background/{pick['bundle']}",
                filename=f"{pick['id']}.webp", crop_w=UI_WIDTH, trim=True)
    return jobs


def fetch_bytes(url: str, attempts: int = 5) -> bytes:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers=HTTP_HEADERS)
            with urllib.request.urlopen(request, timeout=90) as response:
                data = response.read()
            if data.startswith(PNG_MAGIC):
                return data
            last_error = RuntimeError(f"not a PNG ({len(data)} bytes)")
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
            last_error = error
        # urllib 500s some of the 2–4 MB bg_menu files that curl gets as 200.
        curl_data = fetch_via_curl(url)
        if curl_data and curl_data.startswith(PNG_MAGIC):
            return curl_data
        if attempt + 1 < attempts:
            time.sleep(min(8, 2 ** attempt))
    raise RuntimeError(f"unable to fetch {url}: {last_error}")


def fetch_via_curl(url: str) -> bytes | None:
    try:
        result = subprocess.run(
            ["curl", "-sS", "-A", HTTP_HEADERS["User-Agent"],
             "--max-time", "90", url],
            capture_output=True, timeout=100,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def trim_letterbox(image: "Image.Image") -> "Image.Image":
    """Strip baked black bars from the top and bottom of a bg_menu canvas.

    The 2048² menu backgrounds hold ~2048×1640 of art centred in the canvas
    with a ~204 px bar above and below. The bars are not always pure black:
    measured over all 19 files, four of them (com_01_09/16/25, com_02_13) top
    out at channel-sum 75 (~25,25,25) instead of 0, so a `< 24` test misses
    them. `LETTERBOX_MAX_SUM = 90` catches all 19 and still clears btl_0013 —
    the one file with real art at row 0 — by a wide margin (its row 0 peaks at
    751). Sampling every 64th pixel is enough to spot a bar row. Refuses to
    trim more than half the height, so a legitimately dark image survives.
    """
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    step = max(1, width // 32)

    def black_row(y: int) -> bool:
        return all(sum(pixels[x, y]) < LETTERBOX_MAX_SUM
                   for x in range(0, width, step))

    top = 0
    while top < height and black_row(top):
        top += 1
    bottom = height - 1
    while bottom > top and black_row(bottom):
        bottom -= 1
    if bottom - top + 1 < height // 2:
        return image
    if top == 0 and bottom == height - 1:
        return image
    return image.crop((0, top, width, bottom + 1))


def convert(png_bytes: bytes, dest: Path, crop_w: int | None,
            trim: bool = False) -> tuple[int, int]:
    image = Image.open(io.BytesIO(png_bytes))
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.mode else "RGB")
    if trim:
        image = trim_letterbox(image)
    if crop_w and image.width > crop_w:
        height = max(1, round(image.height * (crop_w / image.width)))
        image = image.resize((crop_w, height), Image.Resampling.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest, "WEBP", quality=WEBP_QUALITY, method=4)
    return image.size


def download_job(job: dict) -> dict:
    dest = OUT_ROOT / job["file"]
    if dest.exists() and dest.stat().st_size and not job.get("force"):
        with Image.open(dest) as image:
            return {**job, "w": image.width, "h": image.height, "skipped": True}
    cache_png = CACHE / (job["rel"].replace("/", "_") + ".png")
    if cache_png.exists() and cache_png.stat().st_size:
        png = cache_png.read_bytes()
        if not png.startswith(PNG_MAGIC):
            png = None
    else:
        png = None
    if png is None:
        png = fetch_bytes(job["url"])
        cache_png.parent.mkdir(parents=True, exist_ok=True)
        part = cache_png.with_suffix(cache_png.suffix + ".part")
        part.write_bytes(png)
        part.replace(cache_png)
    width, height = convert(png, dest, job.get("crop_w"), job.get("trim", False))
    return {**job, "w": width, "h": height, "skipped": False}


def write_index(records: list[dict], category_order: list[str] | None = None) -> None:
    payload = [
        {"id": rec["id"], "category": rec["category"],
         "file": rec["file"], "w": rec["w"], "h": rec["h"],
         **({"source": rec["source"]} if rec.get("source") else {})}
        for rec in records
    ]
    if category_order:
        order = {name: index for index, name in enumerate(category_order)}
        payload.sort(key=lambda rec: order.get(rec["category"], len(order)))
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--category", choices=[
        "card", "illust", "bust", "icon", "weapon", "item", "orig", "ui",
    ])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--playable", action="store_true", help="only the current exact-card roster")
    parser.add_argument("--force", action="store_true", help="rebuild existing files from the exact source")
    args = parser.parse_args()

    jobs = jobs_for(args.category)
    if args.playable:
        selected = {row["id"] for row in load_json(ROOT / "site/asset/rl/playable-roster.json")["cards"]}
        jobs = [job for job in jobs if job["id"] in selected]
    for job in jobs:
        job["force"] = args.force
    print(f"{len(jobs)} jobs"
          + (f" (category={args.category})" if args.category else ""),
          flush=True)
    if args.dry_run:
        counts = collections.Counter(j["category"] for j in jobs)
        for cat, n in sorted(counts.items()):
            print(f"  {cat:8s} {n}")
        return 0

    records: list[dict] = []
    category_order = None
    if INDEX_PATH.exists() and args.category:
        records = load_json(INDEX_PATH)
        category_order = list(dict.fromkeys(r["category"] for r in records))

    fetched = skipped = failed = 0
    for i, job in enumerate(jobs, 1):
        try:
            rec = download_job(job)
        except Exception as error:
            failed += 1
            print(f"FAIL {job['file']}: {error}", flush=True)
            continue
        if rec["skipped"]:
            skipped += 1
        else:
            fetched += 1
            print(f"ok   {job['file']} {rec['w']}x{rec['h']}", flush=True)
        records = [r for r in records if (r["category"], r["id"]) != (rec["category"], rec["id"])]
        records.append({
            "id": rec["id"], "category": rec["category"],
            "file": rec["file"], "w": rec["w"], "h": rec["h"],
            "source": rec["rel"],
        })
        if i % 50 == 0:
            write_index(records, category_order)
            print(f"... {i}/{len(jobs)} fetched={fetched} skipped={skipped} failed={failed}",
                  flush=True)

    write_index(records, category_order)
    print(f"wrote {INDEX_PATH.relative_to(ROOT)} ({len(records)} entries); "
          f"fetched={fetched} skipped={skipped} failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
