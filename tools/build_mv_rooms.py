"""Generate asset/mv/R0.json .. R7.json -- the room data for 《白紙の書架》.

Why a generator and not eight hand-written files: the map's correctness lives in
its *seams*, and a seam is two facing edges that have to agree. Typed by hand,
76 rooms x ~2 edges means ~150 chances to write one half and forget the other,
and every one of them is a room you can enter and not leave. Here a seam is
declared once, in LINKS, and both halves are emitted from that one declaration,
so reciprocity holds by construction rather than by proofreading.

core/rooms.js checkSeams() still checks it. That is not redundant: the check runs
against the JSON on disk, so it also catches a hand-edit made later, which is the
likelier failure once this script has run once.

Room geometry is deliberately plain -- a floor, some shelves, a pit or two. The
plan's phase 3 is about topology (which room connects to which, behind which
ability); the interesting platforming shapes come with phase 2's stage work,
against measured draw budgets. Writing elaborate rooms now would mean rewriting
them then.

Numbers that are not free choices:
  - jump reach (gap 3 tile, rise 2 tile) is measured, from tools/check_mv_move.py.
    Pits are cut to 3 so they are crossable; anything wider needs an ability and
    is marked as such.
  - enemy model keys are read out of asset/models/manifest.json, and `patrol`
    only ever gets a model whose manifest entry has animations: true. There are
    139 of those. Making one up here would produce a room that loads a T-pose.

Usage:  python tools/build_mv_rooms.py [--check]
        --check  writes nothing; reports whether the files on disk match.
"""

import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mv_meshcount as meshcount           # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "asset", "mv")
MANIFEST = os.path.join(ROOT, "asset", "models", "manifest.json")

# --- regions (plans/metroidvania.md 5.1) ----------------------------------

REGIONS = [
    # id,  name ja,       name zh,      element, act, bgm,          enter,  rooms
    ("R0", "灯の間", "举灯之间", None, "序", "mv_lamp", [], 8),
    ("R1", "陽の棚", "阳之书架", 5, 1, "mv_sun", [], 10),
    ("R2", "水の書庫", "水之书库", 1, 1, "mv_water", ["A1"], 9),
    ("R3", "炎の禁架", "炎之禁架", 0, 1, "mv_flame", ["A2"], 10),
    ("R4", "風の吹抜け", "风之中庭", 3, 2, "mv_wind", ["A3"], 8),
    ("R5", "土の堆積", "土之堆积", 2, 2, "mv_earth", ["A4"], 9),
    ("R6", "月の写本庫", "月之抄本库", 4, 2, "mv_moon", ["A5"], 9),
    ("R7", "白紙の頁", "白纸之页", None, "終", "mv_blank", ["A6"], 8),
]

# Where each ability lies -- named, not derived from the room count.
#
# Deriving it ("the last numbered room of the region") looked tidier and was
# wrong: R1's last numbered room is R1-10, which is the far end of the A6
# shortcut, so A1 ended up behind A6. The solvability search catches that, but
# only after the fact; naming the room means the map says what it means.
#
# Each ability sits at the end of its region's spine, just before the door to the
# next region. Three of those rooms are also boss rooms (5.1), so the ability
# reads as what the fight leaves behind.
PICKUPS = {
    "R1": ("R1-08", "A1"),
    "R2": ("R2-08", "A2"),      # B1 没被读过的页
    "R3": ("R3-08", "A3"),
    "R4": ("R4-07", "A4"),      # B2 白紙之兽 幼
    "R5": ("R5-08", "A5"),
    "R6": ("R6-08", "A6"),      # B3 失去颜色的某人
}

# --- seams ----------------------------------------------------------------
#
# One entry per connection: (roomA, sideA, roomB, ability_or_None).
# sideB is the opposite of sideA. The ability is written on BOTH halves: the
# return trip needs the same ability, not a different one, which is what 5.2's
# "no extra lock on the way back" means. An edge with no ability is open.

LINKS = []


def chain(region, shape, ability=None):
    """Spine inside one region. `shape` is one character per step: R, U or D.

    Was `chain(region, count)`, which only ever emitted R -- a left-to-right
    corridor. Measured on the map that produced: of 162 edge halves, 124 were
    L/R and 38 were U/D, and 51 of 77 rooms had exactly two exits. A
    Metroidvania's map is a climbable volume; that one was a long hallway with
    side rooms, which is the shape a corridor game has.

    The shape is written per region rather than derived, because which regions
    are vertical is a statement about the place: 風の吹抜け is named after an
    atrium, so its spine goes up and down more than it goes sideways.
    """
    for i, step in enumerate(shape, start=1):
        if step not in ("R", "U", "D"):
            raise SystemExit("chain(%s): bad step %r" % (region, step))
        LINKS.append(("%s-%02d" % (region, i), step,
                      "%s-%02d" % (region, i + 1), ability))


# Spines. Rooms 01..N of each region; the extra rooms hang off them.
#
# One character per step, so the shape's length is the room count minus one.
# The counts are unchanged from the corridor version (7/8/8/8/7/8/8/6 rooms) --
# this redistributes the same rooms into a volume rather than adding any.
chain("R0", "RRDRRR")       # 灯の間: level, then the drop that opens the game
chain("R1", "RURURRR")      # 陽の棚: light comes from above, so the spine climbs
chain("R2", "RDRDRRR")      # 水の書庫: water sinks; the archive descends
chain("R3", "RURRURR")      # 炎の禁架: fire climbs
chain("R4", "UURDDRR")      # 風の吹抜け: an atrium. Mostly vertical, by its name
chain("R5", "RDDRRDR")      # 土の堆積: down into the sediment
chain("R6", "RURDRUR")      # 月の写本庫: terraced, up and down in turn
chain("R7", "RURRD")        # 白紙の頁: the last climb, then a fall

# Cross-region: the 7-edge critical spine (5.2). Each leaves the last room of one
# region and arrives at the first of the next.
LINKS += [
    ("R0-07", "D", "R1-01", None),    # 序幕坠落: open, and it is a fall
    ("R1-08", "R", "R2-01", "A1"),    # dark stacks
    ("R2-08", "R", "R3-01", "A2"),    # crystal wall
    ("R3-08", "R", "R4-01", "A3"),    # hidden path
    ("R4-07", "R", "R5-01", "A4"),    # chasm
    ("R5-08", "R", "R6-01", "A5"),    # fast-blanching corridor
    ("R6-08", "R", "R7-01", "A6"),    # blanched floor
]

# Cross-region: the 5 shortcuts (5.2). These carry no progress -- 5.4 verified
# the game is still solvable with all of them removed -- so they are pure
# convenience, and each one opens a *previous* region up again.
LINKS += [
    ("R0-08", "D", "R5-09", "A4"),    # lift shaft, 灯の間 straight down to 土
    ("R1-09", "R", "R3-09", "A2"),    # break 陽 -> 炎 directly
    ("R2-09", "R", "R4-08", "A3"),    # hidden route behind the water archive
    ("R3-10", "R", "R6-09", "A5"),    # sealed express corridor
    ("R1-10", "R", "R7-07", "A6"),    # 灯 -> 白紙の頁, for the endgame
]

# The shortcut rooms have to hang off their own region's spine too, or they are
# islands reachable only from the far side.
LINKS += [
    ("R0-04", "U", "R0-08", None),
    ("R1-03", "U", "R1-09", None),
    ("R1-06", "U", "R1-10", None),
    ("R2-05", "D", "R2-09", None),
    ("R3-02", "U", "R3-09", None),
    ("R3-06", "D", "R3-10", None),
    ("R4-04", "U", "R4-08", None),
    ("R5-03", "U", "R5-09", None),
    ("R6-04", "D", "R6-09", None),
    ("R7-04", "U", "R7-07", None),
]

# Optional content (5.3). Reached from inside the region, behind an ability.
# These are rooms, not region edges, so they never appear in the region graph --
# which is the point: optional content must not carry progress.
LINKS += [
    ("R0-02", "U", "R0-alcove", "A1"),       # 暗龛, a 共読 fragment
    ("R1-05", "U", "R1-highshelf", "A4"),    # 高层书架
    ("R2-06", "D", "R2-deeproom", "A5"),     # 深室
    ("R3-05", "U", "R3-vault", "A3"),        # vault: A3 to see it, A2 to open the gate inside
    ("R5-06", "U", "R5-memory", "A6"),       # 记忆室
    ("R6-06", "U", "R6-memory", "A6"),
    ("R7-05", "U", "R7-08", None),           # the last approach
]

# 5.5 asks for 8-14 rooms per region and ~70 in total. An earlier pass added six
# more rooms to pad the counts and landed at 82 -- above the plan, and the padding
# rooms were dead ends hung off the spine with nothing in them. They are gone; the
# counts come out 9/11/10/11/8/10/10/8 = 77, every region inside 8-14.

OPPOSITE = {"L": "R", "R": "L", "U": "D", "D": "U"}

# --- rooms with a name rather than a number -------------------------------
#
# The optional rooms keep readable ids. core/rooms.js's ROOM_ID accepts
# R<n>-<alnum>, so "R0-alcove" is a legal id.

NAMED = {
    "R0-alcove": {"blanch": 0, "desk": False},
    "R1-highshelf": {"blanch": 1, "desk": False},
    "R2-deeproom": {"blanch": 2, "desk": False},
    "R3-vault": {"blanch": 2, "desk": False, "gate": "crystal"},
    "R5-memory": {"blanch": 3, "desk": False},
    "R6-memory": {"blanch": 3, "desk": False},
}

# 書桌 (save points): 1-2 per region, and 4.6 says they sit in blanch 0 rooms.
DESKS = {
    "R0": ["R0-01"],
    "R1": ["R1-01", "R1-07"],
    "R2": ["R2-01", "R2-07"],
    "R3": ["R3-01", "R3-07"],
    "R4": ["R4-01", "R4-06"],
    "R5": ["R5-01", "R5-07"],
    "R6": ["R6-01", "R6-07"],
    "R7": ["R7-01"],
}

# Gates inside rooms, by room id -> gate type. The type fixes what it needs
# (core/rooms.js checks the pair agrees), so only the type is written here.
GATES = {
    "R0-05": "dark",       # needs the lamp, in the prologue region, reachable later
    "R1-04": "bond",       # soft gate: opens on having read a 共読, never blocks
    "R2-04": "crystal",
    "R3-vault": "crystal",
    "R3-03": "hidden",
    "R4-05": "chasm",
    "R5-04": "fast",
    "R6-05": "fade",
    "R7-03": "bond",
}

# adv scripts, by room. Only rooms that actually open a scene get one; phase 5
# writes the scripts themselves and its gate checks these ids resolve.
SCRIPTS = {
    "R0-01": "mv_open",
    "R0-alcove": "mv_alcove",
    "R1-01": "mv_fall",
    # 3.4's act structure needs a scene where each of the three rejoins, and the
    # ability pickups are where those land: A1 is ランプ's lamp, A3 is きらら's
    # 絆視, and アルシーヴ arrives by the shaft below her own room (mv_lift).
    # Without these two the first act has no 归队 at all, and 3.6 samples 2 and 3
    # would have nowhere to play.
    "R1-08": "mv_lamp",        # A1 + ランプ と マッチ 归队 (3.6 sample 2)
    "R2-08": "mv_b1",          # B1 没被读过的页
    "R3-08": "mv_kirara",      # A3 + きらら 归队 (3.6 sample 3)
    "R4-07": "mv_b2",          # B2 白紙之兽 幼
    # Was R5-09, which is the 土 end of the R0-08 shortcut -- and 5.4's rule is
    # that shortcuts carry no progress. アルシーヴ joining the party is progress:
    # she is on stage in B3 and B4, both of which every route plays. Measured
    # with the room-level fixpoint in tools/mv_rooms_harness.mjs: R5-09 is
    # avoidable, R5-03 is not. R5-03 is the room directly under that shaft
    # (R5-03 U->R5-09 U->R0-08), so she still arrives from the lamp room's side.
    "R5-03": "mv_lift",
    "R6-08": "mv_b3",          # B3 失去颜色的某人
    "R7-08": "mv_b4",          # B4 白紙之兽

    # One scene at each region's entrance room. REGIONS carries a name for all
    # eight (「水の書庫」and so on) and nothing in the game ever said any of them
    # out loud -- the regions were labels on a table, not places. These are the
    # first room of each region on the spine, so they play once on the way in and
    # do not sit on a shortcut.
    "R2-01": "mv_dive",
    "R3-01": "mv_seal",
    "R4-01": "mv_atrium",
    "R5-01": "mv_silt",
    "R6-01": "mv_copy",
    "R7-01": "mv_edge",

    # 3.4 promises act 2 is where 白化 catches the party itself, and no scene
    # carried that -- the act title (R4-07) and its consequence (R6-08) were both
    # written, with the turn between them missing. R5-07 is on 土's spine, past
    # the region's own arrival scene and before 月.
    "R5-07": "mv_fade",

    # 5.3's optional rooms. They held a pickup and nothing to read, which makes
    # the detour a collection rather than 3.3's 「回头探索＝重读」. R0-alcove
    # already had one (mv_alcove); these are the other five.
    "R1-highshelf": "mv_high",
    "R2-deeproom": "mv_deep",
    "R3-vault": "mv_vault",
    "R5-memory": "mv_memory",
    "R6-memory": "mv_scribe",
}

# 4.7's B4 gets no health bar: the win condition is filling the blank, four
# readers in turn. The order and the ability each socket wants live in
# core/mvfill.js (ORDER / SOCKETS) -- written here it would be in two places and
# they would drift. This table only says *where* in the room the four sit.
#
# Placed against R7-08's own geometry, which geometry() emits as: floor y=0 with
# a doorway hole at x=3..4 (down to R7-05), a oneway shelf [4,3,4,1], a solid
# shelf [15,5,5,1], ceiling y=11, walls at x=0 and x=23.
#
#   arcive [8, 1]   floor, just past the doorway -- reachable the moment you land,
#                   because sealing is the thing you do before anything else.
#   match  [6, 3]   on the oneway shelf, entered from below. The dash that fills
#                   it is a horizontal move, so it needs a platform with run-up;
#                   the floor beside the doorway hole does not have any.
#   kirara [18, 6]  the room's high ground, at the top of the climb. She is the
#                   one who pulls the far side in, so her socket is the far side.
#   lamp   [21, 1]  floor, past the climb, the deepest corner from the entrance.
#                   Last reader, last place.
#
# The room's shelves are cut to carry these four: fill_room_shelves() replaces the
# generic pair, because the generic ones leave two sockets above the measured jump.
# tools/check_mv_fill.py walks the platform graph and asserts every socket is
# standable and reachable, rather than trusting this comment.
FILL_SOCKETS = {
    "R7-08": [
        {"owner": "arcive", "ability": "A5", "at": [8, 1]},
        {"owner": "match", "ability": "A2", "at": [6, 3]},
        {"owner": "kirara", "ability": "A4", "at": [18, 6]},
        {"owner": "lamp", "ability": "A6", "at": [21, 1]},
    ],
}

# --- enemy models ---------------------------------------------------------


# The most an enemy model may cost, in draw calls (= visible meshes; see
# tools/mv_meshcount.py). 6.1.3 caps a room at 160 draws, and after the visible
# protagonist (43-48), merged terrain (<=12) and HUD (<=20) there are ~80 left.
#
# 6.1.3's "6-14 meshes per enemy, ~10.4 draws each" is true of the 6 models it
# sampled and not true in general: measured across all 139 animated enemies the
# median is 32 and the maximum 129, and only 37 of them are <= 14. So the rule
# "<= 8 enemies per room" does not imply "<= 160 draws" -- eight median enemies
# are 256 draws on their own. Picking models by cost here is what makes the two
# rules agree; tools/check_mv_budget.py then prices every room and fails if one
# goes over, so a hand-edit cannot quietly reintroduce the gap.
MAX_ENEMY_DRAWS = 18


def enemy_pools():
    """Enemy models split by animation, filtered to ones that fit the budget.

    `patrol` needs a walk, so it may only draw from the animated set. The other
    behaviours stand still and may use the static set, which is where most of
    the 604 enemy models live. Reading this instead of hard-coding it means a
    manifest rebuild that drops a model shows up here, not as a blank spot in a
    room.
    """
    manifest = meshcount.load_manifest()
    animated, static = [], []
    for name in meshcount.enemy_keys(manifest):
        cost = meshcount.visible_draws(name)
        if cost > MAX_ENEMY_DRAWS:
            continue
        entry = manifest["models"]["model/enemy/%s.muast" % name]
        (animated if entry.get("animations") else static).append(name)
    if not animated or not static:
        raise SystemExit("no enemy models within %d draws" % MAX_ENEMY_DRAWS)
    return animated, static


# Behaviour mix per region. 4.4's four kinds; the counts stay small because
# 6.1.3's budget is per-room draw calls and enemies are the variable part.
BEHAVIOURS = ["patrol", "turret", "shard", "creamate"]

# Danmaku patterns a region is allowed to use, in the order they are introduced.
# A ladder, not a shuffle: region 1 teaches two shapes, and nothing new appears
# until the previous one has been seen in several rooms.
#
# Region 0 is the prologue and stays empty -- it has no spawns at all, and the
# lamp room is where the player learns to walk.
#
# The old code chose the pattern from `index % len(PATTERN_IDS)`, which sounds
# varied and was not: turrets only ever occupy spawn slot 0, 1 or 2, so only the
# first three ids were ever reachable. `wall` and `burst` never fired once in the
# shipped data, and every room resolved to a single role. Writing the pattern
# explicitly is also what lets core/mvdanmaku.js grow new ids without silently
# renumbering every turret already on the map.
REGION_PATTERNS = {
    1: ["ring", "aimed"],
    2: ["ring", "aimed", "spiral"],
    3: ["aimed", "spiral", "wall", "charge"],
    4: ["ring", "wall", "charge", "bloom"],
    5: ["spiral", "wall", "charge", "bloom", "burst"],
    6: ["ring", "aimed", "spiral", "charge", "bloom", "burst"],
    7: ["ring", "aimed", "spiral", "wall", "burst", "charge", "bloom"],
}

# Which role each pattern draws as. Duplicated from core/mvdanmaku.js on
# purpose; tools/check_mv_budget.py asserts the two agree, so a rename cannot
# quietly desync them.
PATTERN_ROLE = {
    "ring": "bullet", "aimed": "bullet", "wall": "bullet",
    "spiral": "spark", "burst": "burst",
    "charge": "glow", "bloom": "aura",
}

# Rooms with more than one turret start at region 4. Before that a room asks one
# question at a time.
MULTI_TURRET_FROM = 4

# The three boss rooms named in PICKUPS' comments (5.1's B1/B2/B3). Written out
# here because spawns_for needs to see them, and because a corridor and a boss
# room wanting different danmaku is a rule about the map, not about an index.
#
# These are the only rooms that get three turrets. Three distinct roles in a
# corridor would be a shooting gallery; in the room where the fight happens it is
# the fight. It is also what puts the 3-role draw path under real data instead of
# under a bullet somebody injected from the console.
BOSS_ROOMS = {
    "R2-08": "B1",      # 没被读过的页
    "R4-07": "B2",      # 白紙之兽 幼
    "R6-08": "B3",      # 失去颜色的某人
}

# B3's body is not from the enemy pool. 4.7 gives it 「玩家模型去色（从 685 卡里
# 选）」-- a *player* model with its colour taken -- and the enemy pool holds only
# model_en_ keys, so the generic boss line can never produce one.
#
# It lives here because it was previously a hand-edit to the generated JSON, and a
# hand-edit to generated data is lost the next time the generator runs. Measured:
# it was, on this rebuild. tools/check_mv_budget.py caught it (B3 came back as
# model_en_1800), and tools/check_mv_manifest.py and tools/check_mv_blanchbody.py
# both name model_pl_442201 in their pinned figures, which is how the original
# choice was recovered.
#
# Priced blanched (no l30_/l60_ face layers), which is what core/mvstage.js
# blanchBody actually draws.
BOSS_BODIES = {
    "B3": "model_pl_442201",
}


def region_of(room_id):
    """1 from "R1-04". 0 if it does not parse, which means the prologue."""
    try:
        return int(str(room_id).split("-")[0].lstrip("Rr"))
    except (ValueError, IndexError):
        return 0


# What a boss may reach for beyond its region's ladder. B1 sits in region 2,
# whose ladder is three patterns across only two roles -- so from the corridor
# vocabulary alone the fight cannot show a third thing. A boss introducing the
# shape the next region will teach is the ordinary way round: you meet it once
# under pressure, then again in the corridors.
BOSS_EXTRA = {
    "R2-08": ["charge"],            # glow, which region 3 goes on to use
    "R4-07": ["burst"],             # burst, which region 5 goes on to use
    "R6-08": ["burst", "wall"],     # the last fight may use anything
}


def turret_patterns(index, region, slots, boss=False, room_id=None):
    """Patterns for the turrets in one room, distinct in *role* where possible.

    Two turrets firing `ring` and `aimed` both draw as `bullet`, so the room
    looks like one turret twice over and costs one draw either way. Picking
    across role groups is what makes a second turret read as a second threat.
    """
    ladder = list(REGION_PATTERNS.get(region) or [])
    if not ladder or slots <= 0:
        return []
    chosen = []
    used_roles = set()
    # A boss takes its named patterns FIRST, not last.
    #
    # Appending them to the ladder made the table dead for two of three bosses:
    # the walk below stops as soon as it has `slots` distinct roles, and regions
    # 4 and 6 have wide enough ladders that it never reached the end. Measured in
    # the browser: R4-07 came out wall/charge/bloom and R6-08 ring/spiral/charge,
    # so `burst` -- the one role a boss was supposed to introduce -- never fired
    # in a boss room at all. Only R2-08 hit its extra, and only because region
    # 2's ladder is three patterns across two roles and simply ran out.
    if boss and room_id:
        for extra in BOSS_EXTRA.get(room_id) or []:
            role = PATTERN_ROLE[extra]
            if role in used_roles or len(chosen) >= slots:
                continue
            chosen.append(extra)
            used_roles.add(role)
    # Walk the ladder from a per-room offset so neighbouring rooms differ.
    #
    # The multiplier has to be coprime with every ladder length in use (2..7), or
    # the offset aliases and the region collapses onto one starting pattern.
    # Measured twice, because the obvious fixes are both wrong:
    #   * 3  -> region 2's ladder is 3 long, (index * 3) % 3 == 0 always, and all
    #           ten of its rooms came out `ring`.
    #   * 7  -> same fault one length up: region 7's ladder is 7 long, so
    #           (index * 7) % 7 == 0 always, and it came out `ring`/`spiral`.
    # 11 is divisible by none of 2, 3, 5, 7, so it is coprime with every length
    # from 2 to 7 and each ladder rotates through all of its entries.
    start = (index * 11) % len(ladder)
    for step in range(len(ladder)):
        pat = ladder[(start + step) % len(ladder)]
        role = PATTERN_ROLE[pat]
        if role in used_roles:
            continue
        chosen.append(pat)
        used_roles.add(role)
        if len(chosen) == slots:
            break
    # A region whose ladder has fewer roles than slots (region 1 is all bullet)
    # simply gets fewer turrets rather than two that look the same.
    return chosen


def spawns_for(index, region_element, animated, static, room_id, width):
    """Two or three enemies, chosen deterministically from the room index.

    Deterministic so re-running the generator does not churn the JSON, and so a
    diff means someone changed the map rather than the shuffle.

    Positions skip the pit. The first pass put one at x=16 in a room whose floor
    is cut from 15 to 18, i.e. an enemy standing on nothing.

    Turret count is capped at one below the enemy count so every room keeps at
    least one thing that walks. A room of nothing but turrets is a shooting
    gallery, and 4.4 wants the two kinds read against each other.
    """
    out = []
    count = 2 + (index % 2)
    region = region_of(room_id)
    boss = BOSS_ROOMS.get(room_id)
    hole = range(width // 2 - 1, width // 2 + 2) if room_id in PITS else range(0)

    # How many turrets this room wants, before the ladder gets a say.
    want = 1
    if region >= MULTI_TURRET_FROM and count >= 3:
        want = 2
    if boss:
        # Three roles at once, and enough slots to hold them. The boss room is
        # allowed to be all turret.
        want = 3
        count = max(count, 3)
    patterns = turret_patterns(index, region, want, boss=bool(boss),
                               room_id=room_id)

    # Which slots become turrets. Keeping the old (index + k) % 4 rhythm for the
    # non-turret slots means the patrol/shard/creamate mix is unchanged.
    turret_slots = []
    for k in range(count):
        if BEHAVIOURS[(index + k) % len(BEHAVIOURS)] == "turret":
            turret_slots.append(k)
    # Promote further slots until the room has as many turrets as the ladder
    # offered. Later slots first, so the leftmost enemy stays a walker.
    for k in range(count - 1, -1, -1):
        if len(turret_slots) >= len(patterns):
            break
        if k not in turret_slots:
            turret_slots.append(k)
    turret_slots = sorted(turret_slots)[:len(patterns)]

    for k in range(count):
        behaviour = BEHAVIOURS[(index + k) % len(BEHAVIOURS)]
        if k in turret_slots:
            behaviour = "turret"
        elif behaviour == "turret":
            # The ladder did not want this one (region 1-3, or no role left).
            # Fall back to the next kind rather than leaving a silent turret.
            behaviour = BEHAVIOURS[(index + k + 1) % len(BEHAVIOURS)]
            if behaviour == "turret":
                behaviour = "patrol"
        if behaviour == "patrol":
            model = animated[(index * 7 + k * 13) % len(animated)]
        else:
            model = static[(index * 11 + k * 29) % len(static)]
        x = 4 + k * 6
        while x in hole:
            x += 3
        spawn = {
            "model": model,
            "at": [x, 1],
            "behavior": behaviour,
            "element": region_element,
        }
        if behaviour == "turret":
            spawn["pattern"] = patterns[turret_slots.index(k)]
        out.append(spawn)

    # The boss body. One extra spawn, and the only one core/mvenemy.js gives a
    # health bar and a phase to. It is a separate spawn rather than a promoted
    # turret because the three turrets are what the phases *open* -- promoting
    # one would mean the fight loses a gun the moment it gets dangerous.
    #
    # It stands at the middle of the floor, which is where the room is widest and
    # where the three turrets can all reach. Costs one model draw in three rooms
    # of 77; measured headroom at the time of writing was 56 of 160.
    if boss:
        mid = width // 2
        while mid in hole:
            mid += 2
        out.append({
            # A named body wins over the pool. Only B3 has one (4.7's decoloured
            # クリエメイト); B1 and B2 are page-creatures and take enemy models.
            "model": BOSS_BODIES.get(boss,
                                     animated[(index * 5 + 3) % len(animated)]),
            "at": [mid, 1],
            "behavior": "boss",
            "element": region_element,
        })
    return out


# --- geometry -------------------------------------------------------------
#
# Coordinates are in the same unit as core/platformer.js bodies: compileRoom
# does not scale, so a solid [x,y,w,h] and a body position share one grid, and
# BODY = {w:0.62, h:1.7} means the walker is 1.7 units tall. TILE = 0.7 is the
# render scale and does not enter here. A doorway therefore has to be at least
# 2 units tall, not 1.

DOOR_H = 2      # L/R doorway height
DOOR_W = 2      # U/D doorway width

# The measured jump, mirrored from core/rooms.js REACH so the ladder is cut to
# the same numbers the checker walks it with. Written here rather than imported
# because this is Python and that is a JS module; tools/check_mv_rooms.py asserts
# the two agree, so a drift is caught rather than assumed away.
REACH_GAP = 3
REACH_RISE = 2

# Rooms whose floor is cut by a pit. The pit is exactly REACH.gap = 3 wide, so
# it is crossable -- and it is the one thing in this data that traverseGaps can
# actually fail on, which is what makes the "widen a pit" negative case real.
# A pit belongs in a hall. In a room that is climbed, the ladder spans the pit as
# a side effect -- rungs 6 wide with 3 between them cross a 3-wide hole -- so the
# pit stops being an obstacle and the room only *looks* like it has one.
#
# Measured: R1-02 became a shaft when the R1 spine folded upward, and widening its
# pit no longer made the room impassable. The "widen a pit" negative case reported
# DID NOT FAIL -- correctly: there was a way around. R1's pit moved to R1-08, a
# hall; R7-02 also became a shaft and R7's pit is dropped, since that region's set
# piece is the fill room (4.7) rather than a gap.
PITS = {"R1-08", "R2-02", "R3-04", "R4-03", "R5-02", "R6-03"}


def carve(span, holes):
    """Split [0, span) into segments, leaving out every [start, start+size) hole."""
    blocked = set()
    for start, size in holes:
        for v in range(start, start + size):
            blocked.add(v)
    segments, run = [], None
    for v in range(span):
        if v in blocked:
            if run is not None:
                segments.append((run, v - run))
                run = None
        elif run is None:
            run = v
    if run is not None:
        segments.append((run, span - run))
    return segments


def geometry(room_id, size, sides):
    """Walls, floor, ceiling and a shelf or two, with doorways left open.

    The doorways matter: an edge that says "you leave on the left at y=1" and a
    left wall that runs unbroken from y=1 to the ceiling disagree, and the
    disagreement would only show up when someone walks into it. Cutting the hole
    here keeps the collision data and the edge list saying the same thing.
    """
    w, h = size
    solid = []

    floor_holes = [(a, DOOR_W) for a in sides.get("D", [])]
    if room_id in PITS:
        floor_holes.append((w // 2 - 1, 3))       # exactly the measured reach
    for x0, span in carve(w, floor_holes):
        solid.append([x0, 0, span, 1])

    for x0, span in carve(w, [(a, DOOR_W) for a in sides.get("U", [])]):
        solid.append([x0, h - 1, span, 1])

    # Walls run between floor and ceiling: y = 1 .. h-1. A wall is one unit thick,
    # so the carved span is its *height* -- writing it into the width slot gave
    # [31, 3, 8, 8] in a 32-wide room, a slab reaching 7 units past the far edge.
    for side, x in (("L", 0), ("R", w - 1)):
        for y0, span in carve(h - 1, [(a, DOOR_H) for a in sides.get(side, [])]):
            if y0 == 0:
                y0, span = 1, span - 1           # the floor already fills y=0
            if span > 0:
                solid.append([x, y0, 1, span])

    # The last room's shelves are the four sockets' floor, so they are placed by
    # hand rather than by the generic rule. The generic pair -- [4,3,4,1,oneway]
    # and [w-9,5,5,1] -- puts two of FILL_SOCKETS out of reach: the measured jump
    # clears rise 2 (core/rooms.js REACH, from tools/check_mv_move.py), and from
    # the floor at y=1 the oneway's top is y=4 (rise 3) and the high shelf's top
    # is y=6 (rise 5). Both sockets would be visible, named on the HUD, and
    # unreachable -- which in a room you cannot leave until it is filled is not a
    # hard ending, it is a dead save.
    if room_id in FILL_SOCKETS:
        return solid + fill_room_shelves(room_id, size)

    # A room with a way out of the ceiling has to be climbable to that hole.
    # Reach is rise <= 2, so a 26-tall shaft with two shelves in it is a room you
    # fall into and cannot leave. The ladder is generated rather than typed
    # because its spacing is the measured reach, not a taste.
    #
    # The test is "is the ceiling further than one jump", not a height threshold.
    # `h > 14` looked safe and skipped R2-deeproom -- a 14x10 side room whose
    # ceiling door sits 8 units above a floor you can jump 2 from.
    if sides.get("U") and (h - 1) - 1 > REACH_RISE:
        return solid + climb_ladder(size, sides)

    # Shelves. In a pit room they sit high enough that they are not an alternative
    # to the jump -- otherwise widening the pit would still "pass" by way of a
    # convenient step, and the negative case would prove nothing.
    shelf_y = 5 if room_id in PITS else 3
    solid.append([4, shelf_y, 4, 1, "oneway"])
    solid.append([w - 9, shelf_y + 2, 5, 1])
    return solid


def climb_ladder(size, sides):
    """A zig-zag of shelves from the floor to the ceiling doorway.

    Reach is rise <= 2 and gap <= 3 (core/rooms.js REACH), so the rungs step up
    2 at a time and alternate sides. Landing on a rung and jumping to the next
    has to clear both numbers from *either* direction, since the player also
    comes back down this way.

    The top rung is placed under the U doorway: a ladder that ends two units to
    the side of the hole is a ladder that does not reach it, and
    tools/check_mv_rooms.py cannot see that -- traverseGaps() only walks left to
    right, so a vertical dead end reads as a passable room.
    """
    w, h = size
    rungs = []
    # Two columns with exactly REACH.gap (3) between them. Solved from the width
    # rather than picked: the interior is w-2 wide (walls at 0 and w-1), so
    # 2*span + 3 = w - 2.
    #
    # Measured: fixing span at 6 and pinning the right column to the wall left a
    # 4-tile gap in an 18-wide room (left 1..7, right 11..17), one past reach. 28
    # of 33 ceiling exits still came back unclimbable, all with reachedY=3 -- the
    # first rung was reachable and the second was not.
    span = max(3, (w - 5) // 2)
    left_x = 1
    right_x = min(w - 1 - span, left_x + span + REACH_GAP)
    # A slab's *top* is r[1] + r[3], and rise is measured between tops. The floor
    # slab is [0, 0, w, 1], so its top is y=1; a rung written at y=3 therefore has
    # its top at y=4, which is rise 3 from the floor and out of reach.
    #
    # Measured: the first version put rungs at 3, 5, 7... and every one of the 33
    # ceiling exits came back unclimbable with reachedY=1 -- the search never left
    # the floor. Rungs go on even rows so the tops land on 3, 5, 7..., each rise 2
    # from the one below.
    #
    # (The old decorative shelves have the same off-by-one -- [4, 3, 4, 1] tops at
    # y=4. They were never climbable either. It did not matter while nothing was
    # above them, and it is why traverseGaps() passed those rooms: the floor spans
    # the room, so it always found itself as the next platform going right.)
    y = 2
    i = 0
    # Stop below the ceiling: the last rung has to be reachable *from* the one
    # under it and leave standing room under the hole.
    while y <= h - 3:
        x = left_x if i % 2 == 0 else right_x
        rungs.append([x, y, span, 1])
        y += 2
        i += 1
    if not rungs:
        return rungs

    # A landing under EVERY ceiling doorway, not just the first. `at` is the
    # doorway's left edge and it is DOOR_W wide, so the landing has to cover
    # [at, at + DOOR_W) and sit within REACH_RISE of the ceiling.
    #
    # Measured: aligning only sides["U"][0] left the five rooms that have two
    # ceiling exits (R0-04, R3-02, R3-05, R5-03, R6-06) with their second door
    # unreachable -- reachedY was the ceiling itself, so the climb worked and
    # simply ended in the wrong column.
    top_y = rungs[-1][1]
    landing_y = h - 1 - REACH_RISE          # top lands at h-1-REACH_RISE+1
    for door in sorted(sides["U"]):
        # Centre a landing on the door, clamped inside the walls.
        x = max(1, min(w - 1 - span, door + DOOR_W // 2 - span // 2))
        # Already covered by a rung that is high enough? Then nothing to add.
        covered = any(r[0] <= door and door + DOOR_W <= r[0] + r[2]
                      and (h - 1) - (r[1] + r[3]) <= REACH_RISE for r in rungs)
        if covered:
            continue
        rungs.append([x, landing_y, span, 1])
        # The landing has to be reachable from the ladder. The topmost rung is at
        # top_y; if the landing is further than one rise above it, step the gap.
        rise = (landing_y + 1) - (top_y + 1)
        if rise > REACH_RISE:
            step_y = landing_y - REACH_RISE
            step_x = right_x if x == left_x else left_x
            rungs.append([step_x, step_y, span, 1])
    return rungs


def fill_room_shelves(room_id, size):
    """The climb for R7-08, cut so every socket is within one measured jump.

    Reach is rise <= 2 and gap <= 3 (core/rooms.js REACH). Read as a ladder from
    the floor, every step below clears both, and tools/check_mv_fill.py walks the
    platform graph and asserts it rather than trusting this docstring:

        floor      y=1, x=5..22   (the D doorway cuts x=3..4)
        oneway     y=3, x=5..8    rise 2 from the floor; マッチ's socket [6, 3]
        step       y=3, x=10..12  gap 2 from the oneway, level
        step       y=5, x=14..16  rise 2, gap 2
        shelf      y=6, x=17..20  rise 1, gap 1; きらら's socket [18, 6]

    The oneway is a oneway on purpose: it is the one socket filled by a dash, and
    a dash is horizontal, so it needs a platform you can be *standing on* with
    run-up in both directions. 4 wide gives x=5..8 -- land at 5, dash through 6,
    stop before the edge. Under a solid slab you would have to walk around it.
    """
    w, h = size
    if room_id != "R7-08":
        raise SystemExit("fill_room_shelves: no layout for %s" % room_id)
    return [
        [5, 2, 4, 1, "oneway"],     # top y=3
        [10, 2, 3, 1],              # top y=3
        [14, 4, 3, 1],              # top y=5
        [17, 5, 4, 1],              # top y=6
    ]


def blanch_for(region_id, room_id, index):
    """0..4. Save rooms are forced to 0 because 4.6 puts 書桌 in unblanched rooms."""
    if room_id in DESKS.get(region_id, []):
        return 0
    base = {"R0": 0, "R1": 0, "R2": 1, "R3": 1, "R4": 2, "R5": 2, "R6": 3, "R7": 4}
    return min(4, base[region_id] + (index % 2))


# --- assembly -------------------------------------------------------------

GATE_NEED = {"dark": "A1", "crystal": "A2", "hidden": "A3", "chasm": "A4",
             "fast": "A5", "fade": "A6", "bond": "G"}

# Where a gate's slab sits, and what kind of solid (if any) backs it. `crystal`
# and `fade` are also collision kinds, so those gates get a matching solid --
# the gate entry is what the player is told, the solid is what stops them.
GATE_KIND = {"crystal": "crystal", "fade": "fade"}


# How wide/tall a room is, by what it has to do. A room that is climbed needs
# height to climb in; a room that is only walked through does not.
#
# Was three rules on the id: NAMED -> 14x10, ids ending 02/06 -> 32x12, all the
# rest -> 24x12. Measured result: 55 of 77 rooms were the identical 24x12 and
# there were three distinct sizes in the whole game. The size carried no
# information, so every room looked like the last one.
#
# Now the size follows the room's own edges, which is the same principle the
# doorways already use: the geometry and the topology are one statement.
#   - both U and D: a shaft, tall and narrow, passed through vertically
#   - U only: climbed. Needs height for the ladder to reach the ceiling hole
#   - D only: fallen out of. Falling needs no ladder, so this one is wide and
#     shallow -- the drop is the exit, not an obstacle
#   - neither: a hall, wide and low
# The hall keeps 32x12 and 24x12 so the existing pit and shelf figures (measured
# against jump reach) still apply unchanged in those rooms.
#
# The up/down split is not cosmetic. Sizing both the same produced 42 rooms at an
# identical 20x18, which is the 55-identical-rooms problem again in a new number.
# Climbing and falling genuinely want different rooms, so they get them.
SHAFT = [16, 26]
CLIMB = [18, 22]
DROP = [28, 14]
HALL_LONG = [32, 12]
HALL = [24, 12]
SIDE_ROOM = [14, 10]


def room_size(room_id, sides=None):
    if room_id in NAMED:
        return list(SIDE_ROOM)              # side rooms are one screen
    up = bool(sides and sides.get("U"))
    down = bool(sides and sides.get("D"))
    if up and down:
        return list(SHAFT)
    if up:
        return list(CLIMB)
    if down:
        return list(DROP)
    return list(HALL_LONG) if room_id.endswith(("02", "06")) else list(HALL)


def collect_edges():
    """Turn LINKS into per-room edge lists, both halves, with `at` assigned.

    Two edges on the same side of the same room must not overlap, or the two
    doorways merge into one hole and the destinations become ambiguous. The `at`
    values are handed out in declaration order, spaced by the doorway size plus
    one, and checked against the room's own size at the end.
    """
    edges = {}
    used = {}
    for a, side_a, b, ability in LINKS:
        for src, side, dst in ((a, side_a, b), (b, OPPOSITE[side_a], a)):
            key = (src, side)
            k = used.get(key, 0)
            used[key] = k + 1
            at = (1 + 3 * k) if side in ("L", "R") else (3 + 5 * k)
            edges.setdefault(src, []).append({
                "side": side, "at": at, "to": "%s:%s" % (dst, OPPOSITE[side]),
            } if ability is None else {
                "side": side, "at": at, "to": "%s:%s" % (dst, OPPOSITE[side]),
                "ability": ability,
            })
    return edges


def build():
    animated, static = enemy_pools()
    edges = collect_edges()

    # Every room id that appears anywhere, grouped by region.
    by_region = {}
    for rid, name_ja, name_zh, element, act, bgm, enter, count in REGIONS:
        ids = ["%s-%02d" % (rid, i) for i in range(1, count + 1)]
        by_region[rid] = ids
    for room_id in NAMED:
        by_region[room_id.split("-")[0]].append(room_id)

    # Any room reached by a link but not declared above is a bug in LINKS, not
    # something to paper over by inventing the room.
    declared = {r for ids in by_region.values() for r in ids}
    referenced = set(edges)
    missing = sorted(referenced - declared)
    if missing:
        raise SystemExit("LINKS references undeclared rooms: %s" % ", ".join(missing))
    orphans = sorted(declared - referenced)
    if orphans:
        raise SystemExit("rooms with no seam at all: %s" % ", ".join(orphans))

    regions = {}
    for rid, name_ja, name_zh, element, act, bgm, enter, count in REGIONS:
        rooms = {}
        for index, room_id in enumerate(sorted(by_region[rid])):
            room_edges = sorted(edges[room_id], key=lambda e: (e["side"], e["at"]))
            sides = {}
            for e in room_edges:
                sides.setdefault(e["side"], []).append(e["at"])
            # Size after sides: the room's shape follows its own connections.
            size = room_size(room_id, sides)
            for e in room_edges:
                limit = size[1] if e["side"] in ("L", "R") else size[0]
                span = DOOR_H if e["side"] in ("L", "R") else DOOR_W
                if e["at"] + span > limit - 1:
                    raise SystemExit(
                        "%s: doorway %s@%d does not fit in %s" % (room_id, e["side"], e["at"], size))

            room = {
                "size": size,
                "blanch": blanch_for(rid, room_id, index),
                "solid": geometry(room_id, size, sides),
                "edges": room_edges,
            }

            gate_type = GATES.get(room_id)
            if gate_type:
                gx = size[0] // 2
                room["gate"] = [{"at": [gx, 1, 1, 4], "type": gate_type,
                                 "need": GATE_NEED[gate_type]}]
                kind = GATE_KIND.get(gate_type)
                if kind:
                    room["solid"].append([gx, 1, 1, 4, kind])

            if room_id in DESKS.get(rid, []):
                room["desk"] = [[3, 1]]
            if rid in PICKUPS and PICKUPS[rid][0] == room_id:
                room["pickup"] = [{"at": [size[0] - 6, 1], "ability": PICKUPS[rid][1]}]
            # 5.1's B1/B2/B3. Written on the room so the data says which fight
            # this is, rather than every reader re-deriving it from a room id.
            if room_id in BOSS_ROOMS:
                room["boss"] = BOSS_ROOMS[room_id]
            if rid != "R0":
                room["spawns"] = spawns_for(index, element, animated, static,
                                            room_id, size[0])
            if room_id in SCRIPTS:
                room["script"] = SCRIPTS[room_id]
            if room_id in FILL_SOCKETS:
                room["fill"] = [dict(s) for s in FILL_SOCKETS[room_id]]

            rooms[room_id] = room

        regions[rid] = {
            "id": rid,
            "name": {"ja": name_ja, "zh": name_zh},
            "element": element,
            "act": act,
            "bgm": bgm,
            "enter": enter,
            "rooms": rooms,
        }
    return regions


def main(argv):
    check = "--check" in argv
    regions = build()
    changed, total = [], 0
    for rid in sorted(regions):
        path = os.path.join(OUT, "%s.json" % rid)
        text = json.dumps(regions[rid], ensure_ascii=False, indent=1, sort_keys=True) + "\n"
        total += len(regions[rid]["rooms"])
        old = None
        if os.path.exists(path):
            with io.open(path, encoding="utf-8") as fh:
                old = fh.read()
        if old != text:
            changed.append(rid)
            if not check:
                with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
                    fh.write(text)
        print("  %s  %2d rooms%s" % (rid, len(regions[rid]["rooms"]),
                                     "" if old == text else ("  (would write)" if check else "  written")))
    print("\n%d regions, %d rooms" % (len(regions), total))
    if check and changed:
        print("out of date: %s" % ", ".join(changed))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
