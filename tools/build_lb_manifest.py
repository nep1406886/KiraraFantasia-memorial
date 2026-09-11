#!/usr/bin/env python3
"""Cut asset/lb/manifest-lb.json out of the full manifest.

Same job as tools/build_mv_manifest.py, different cast. plans/labyrinth.md
§6.1 says to reuse what exists rather than rewrite it, so this file reuses that
tool's compact()/expand() rather than restating the format -- and core/lbcost.js
reads the result through core/mvmanifest.js, the same expander the Metroidvania
uses. The format is not Metroidvania-specific; only the header of that module
says so.

What differs, and why it is not a copy:

  six heroes, not three   plans/labyrinth.md §4.2. Five classes are covered, and
                          they come from core/lbstat.js ROSTER, which is checked
                          against the real gacha cards -- so this tool reads the
                          roster out of the JS instead of restating it. A second
                          hand-written copy of six (resourceId, classId, headId)
                          triples is a copy that can disagree with the gate.

  enemies from a table    The Metroidvania reads which enemies to ship out of
                          its room JSON. The Labyrinth has no room JSON -- rooms
                          are dug at runtime from a seed (core/lbmaze.js), so
                          which enemies appear is not knowable from data on
                          disk. It comes from core/lbcost.js ENEMY_MODELS,
                          which is also where the draw budget reads it, so the
                          two cannot disagree.

  no preload of all six   The Metroidvania shows three heroes in one room and
                          preloads all three. Here exactly one hero is in play
                          for a whole run, so preloadBytes is the *heaviest*
                          single hero plus one volume's enemies: what the bar
                          actually has to get through in the worst case.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import mv_meshcount as meshcount  # noqa: E402
import build_mv_manifest as mvm  # noqa: E402

FULL = os.path.join(ROOT, "asset", "models", "manifest.json")
OUT = os.path.join(ROOT, "asset", "lb", "manifest-lb.json")
ROSTER_JS = os.path.join(ROOT, "core", "lbstat.js")
# The cost tables used to live in core/lbstage.js. They moved to core/lbcost.js
# so that node-side callers (core/lbroom.js, and the budget gate) can read them
# without importing the renderer's `loader`/`actor` -- those touch fetch and the
# DOM and die outside a browser. lbstage.js re-exports them, so the game is
# unaffected; only this parse had to follow the file.
COST_JS = os.path.join(ROOT, "core", "lbcost.js")

# The class-default weapon id, from core/actor.js CLASS_WEAPON_BASE/STEP.
# Restated here rather than parsed because it is two numbers that have not moved
# since the loader was written -- but if a hero's weapon 404s, look here first.
CLASS_WEAPON_BASE = 1000
CLASS_WEAPON_STEP = 100


def read_roster():
    """(id, resourceId, classId, headId) for each of core/lbstat.js ROSTER.

    Parsed out of the JS rather than restated. The roster's numbers are the real
    card data and tools/check_lb_stat.py checks them against asset/gacha/cards.js
    -- a copy here would be a second place for them to be wrong, and it would be
    the copy that decides which model ships.
    """
    with open(ROSTER_JS, encoding="utf-8") as fh:
        text = fh.read()
    start = text.index("export const ROSTER")
    body = text[start:text.index("\n];", start)]
    out = []
    for chunk in re.finditer(
            r'id:\s*"([a-z]+)",\s*resourceId:\s*"(\d+)",[^}]*?'
            r'classId:\s*(\d+),\s*elementId:\s*(\d+),\s*headId:\s*(\d+)',
            body, re.S):
        out.append((chunk.group(1), chunk.group(2),
                    int(chunk.group(3)), int(chunk.group(5))))
    if len(out) != 6:
        raise SystemExit("expected 6 roster entries, parsed %d -- "
                         "site/core/lbstat.js ROSTER shape changed" % len(out))
    return out


def read_enemy_models():
    """{kind: [model names]} from core/lbcost.js ENEMY_MODELS.

    Parsed for the same reason as the roster: core/lbcost.js budget() prices
    rooms off this table, so shipping a different set than it prices would make
    the budget gate green while the game 404s.
    """
    with open(COST_JS, encoding="utf-8") as fh:
        text = fh.read()
    start = text.index("export const ENEMY_MODELS")
    body = text[start:text.index("\n};", start)]
    out = {}
    for kind_match in re.finditer(r"(\w+):\s*\[(.*?)\]", body, re.S):
        kind = kind_match.group(1)
        names = re.findall(r'id:\s*"([a-z_0-9]+)"', kind_match.group(2))
        if names:
            out[kind] = names
    if sorted(out) != ["adept", "boss", "swarm"]:
        raise SystemExit("expected swarm/adept/boss in ENEMY_MODELS, got %s"
                         % sorted(out))
    return out


def read_declared_costs():
    """{model: draws} as core/lbcost.js ENEMY_MODELS *claims*.

    The table in the JS is hand-written, so it rots. build() compares it against
    the GLBs and stops on a mismatch: the point of a measured table is that it
    was measured, and a stale one is worse than none because the budget gate
    keeps passing while the room it prices has changed.
    """
    with open(COST_JS, encoding="utf-8") as fh:
        text = fh.read()
    start = text.index("export const ENEMY_MODELS")
    body = text[start:text.index("\n};", start)]
    return {m.group(1): int(m.group(2)) for m in
            re.finditer(r'id:\s*"([a-z_0-9]+)",\s*draws:\s*(\d+)', body)}


def read_declared_hero_draws():
    """{heroId: draws} as core/lbcost.js HERO_DRAWS claims. Same reason."""
    with open(COST_JS, encoding="utf-8") as fh:
        text = fh.read()
    start = text.index("export const HERO_DRAWS")
    body = text[start:text.index("\n};", start)]
    return {m.group(1): int(m.group(2)) for m in
            re.finditer(r"(\w+):\s*(\d+)", body)}


def build():
    with open(FULL, encoding="utf-8") as fh:
        full = json.load(fh)

    roster = read_roster()
    by_kind = read_enemy_models()
    enemies = sorted({name for names in by_kind.values() for name in names})

    models = {}
    costs = {}
    sizes = {}
    # Same field list as build_mv_manifest: everything core/loader.js and
    # core/actor.js actually read off an entry, and nothing else.
    KEEP = ("animations", "compression", "depthWrite", "facial", "file", "meshopt")

    def take(key, facial=None):
        entry = full["models"].get(key)
        if not entry:
            raise SystemExit("not in manifest: %s" % key)
        models[key] = {k: entry[k] for k in KEEP if k in entry}
        name = key.split("/")[-1].replace(".muast", "")
        costs[name] = meshcount.visible_draws(name, facial)
        sizes[name] = mvm.file_bytes(entry)
        return entry

    heroes = {}
    class_actions = {}
    for hid, resource, class_id, head_id in roster:
        table = meshcount.facial_table_for(full, resource)
        entry = take("model/player/model_pl_%s.muast" % resource, facial=table)
        weapon = "wpn_%d" % (CLASS_WEAPON_BASE + class_id * CLASS_WEAPON_STEP)
        take("model/weapon/%s.muast" % weapon)
        heroes[hid] = {
            "resourceId": resource, "classId": class_id, "headId": head_id,
            "weapon": weapon,
            "draws": costs["model_pl_%s" % resource] + costs[weapon],
            "facial": entry.get("facial"),
            # What the loading bar has to get through for *this* hero. One hero
            # is in play for a whole run, so the bar is per-hero, not a total.
            "bytes": sizes["model_pl_%s" % resource] + sizes[weapon]
        }
        ck = "%d:%d" % (class_id, head_id)
        if ck in full.get("classActions", {}):
            class_actions[ck] = full["classActions"][ck]
        else:
            raise SystemExit("no class actions for %s (class %d head %d) -- "
                             "the hero would load with no idle clip"
                             % (hid, class_id, head_id))

    still = []
    for name in enemies:
        entry = take("model/enemy/%s.muast" % name)
        if not entry.get("animations"):
            still.append(name)
    # A static enemy model slides across the floor without moving a limb. Only
    # 139 of the 604 enemy models carry clips, and the small file size of the
    # other 465 makes them look like the cheap pick -- they are cheap because the
    # animation is not in them. Caught here rather than in review: the game runs
    # fine with them (core/lbstage.js only builds a mixer when clips exist), so
    # nothing else would ever complain.
    if still:
        raise SystemExit("these ENEMY_MODELS entries have no animation: %s"
                         % still)

    # The declared tables must match the GLBs. This is the whole reason the
    # numbers are allowed to live in the JS at all.
    declared = read_declared_costs()
    wrong = {n: (declared[n], costs[n]) for n in declared
             if n in costs and declared[n] != costs[n]}
    if wrong:
        raise SystemExit(
            "site/core/lbcost.js ENEMY_MODELS draws are stale: %s "
            "(declared, measured)" % json.dumps(wrong, sort_keys=True))
    hero_declared = read_declared_hero_draws()
    hero_wrong = {h: (hero_declared[h], heroes[h]["draws"]) for h in heroes
                  if h in hero_declared and hero_declared[h] != heroes[h]["draws"]}
    if hero_wrong:
        raise SystemExit(
            "site/core/lbcost.js HERO_DRAWS are stale: %s (declared, measured)"
            % json.dumps(hero_wrong, sort_keys=True))
    missing = sorted(set(costs) - set(declared)
                     - {"model_pl_%s" % r[1] for r in roster}
                     - {"wpn_%d" % (CLASS_WEAPON_BASE + r[2] * CLASS_WEAPON_STEP)
                        for r in roster})
    if missing:
        raise SystemExit("shipped but not priced in ENEMY_MODELS: %s" % missing)

    # The worst single run: heaviest hero + a boss room's models. Not the sum of
    # all six heroes -- only one is ever in play, and a bar that counts bytes
    # nobody waits for sits at 40%% when the game is ready.
    heaviest = max(heroes.values(), key=lambda h: h["bytes"])
    # A boss room is one boss model plus one swarm model: the six swarm bodies
    # are clones of a single GLB, so they cost six draws but one download.
    # Multiplying the bytes by six (the first version of this line) overstated
    # the bar by 660 KB and would have had it sit at 60%% when the room was ready.
    boss_room = max(sizes[n] for n in by_kind["boss"]) \
        + max(sizes[n] for n in by_kind["swarm"])

    return {
        "version": full.get("version"),
        "generator": "tools/build_lb_manifest.py",
        "heroes": heroes,
        "models": models,
        "classActions": class_actions,
        "facialActions": full.get("facialActions"),
        "drawCosts": costs,
        "bytes": sizes,
        "preloadBytes": heaviest["bytes"] + boss_room,
        # Which model belongs to which tier, so game/laby.js does not restate
        # ENEMY_MODELS a third time.
        "enemyTiers": by_kind
    }


# Same gate as the Metroidvania's, same reason: this file is parsed before the
# first room draws. Six heroes and 18 enemies is twice the cast, so the target is
# twice the size. Held as a gate, not an estimate -- a rise should be argued for.
LIMIT_BYTES = 16384


def main():
    readable = build()
    data = mvm.compact(readable)
    # compact() returns a fixed set of keys (it is the Metroidvania's shape).
    # The tier table rides along; core/mvmanifest.js passes unknown keys through
    # untouched, so nothing there has to learn about it.
    data["enemyTiers"] = readable["enemyTiers"]

    # Prove the round trip before writing. A wrong path here is a 404 at load
    # time with nothing in the page to point at it.
    back = mvm.expand(data)
    for key, entry in readable["models"].items():
        got = back["models"].get(key)
        if not got:
            raise SystemExit("round trip lost %s" % key)
        for field in ("file", "animations", "compression", "depthWrite", "facial"):
            if entry.get(field) != got.get(field):
                raise SystemExit("round trip changed %s.%s: %r -> %r"
                                 % (key, field, entry.get(field), got.get(field)))

    text = mvm.render(data)
    if "--check" in sys.argv:
        if not os.path.exists(OUT):
            print("missing: %s" % OUT)
            return 1
        with open(OUT, encoding="utf-8") as fh:
            if fh.read() != text:
                print("stale: %s (run tools/build_lb_manifest.py)" % OUT)
                return 1
        print("up to date: %s" % os.path.relpath(OUT, ROOT))
        return 0

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    size = len(text.encode("utf-8"))
    print("wrote %s: %d bytes (%d models), full manifest is %d bytes (%.2f%%)"
          % (os.path.relpath(OUT, ROOT), size, len(data["models"]),
             os.path.getsize(FULL), 100.0 * size / os.path.getsize(FULL)))
    print("hero draws (model + weapon): %s"
          % ", ".join("%s %d" % (h, readable["heroes"][h]["draws"])
                      for h in sorted(readable["heroes"])))
    print("worst-case preload %.2f MB (heaviest hero + a boss room)"
          % (readable["preloadBytes"] / 1048576.0))
    if size > LIMIT_BYTES:
        print("OVER the %d byte target by %d" % (LIMIT_BYTES, size - LIMIT_BYTES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
