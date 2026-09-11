#!/usr/bin/env python3
"""Cut asset/mv/manifest-mv.json out of the full manifest (§6.1.4).

asset/models/manifest.json is 994,688 bytes and describes 1,300-odd models. The
Metroidvania needs three protagonists, their weapons, their class actions and
whatever enemy models the rooms actually spawn -- a few dozen keys. Making a
phone parse a megabyte of JSON before the first room draws is the kind of cost
that does not show up in a draw-call budget but does show up on the clock.

One correction to the plan's arithmetic, since it changes what this file is
worth: §6.1.4 measures the full manifest at 758,595 B "每次开页固定成本" and
that was the *uncompressed* body (it is 758,294 B at HEAD; it has since grown to
994,688 B). GitHub Pages serves JSON gzipped, so on the wire the full manifest
is ~32 KB and this subset is ~3 KB -- a 29 KB saving, not a 758 KB one. What the
subset really buys is 986 KB of JSON the parser never walks, which is the half
of the cost that lands on a slow phone rather than a slow line.

Two things are folded in that the full manifest does not carry:

  drawCosts   the measured visible-mesh count per model (tools/mv_meshcount.py).
              core/mvstage.js budget() needs it to price a room at runtime, and
              computing it in the browser would mean parsing every GLB first --
              i.e. exactly the thing the budget exists to avoid.
  bytes       the compressed size of each file, so game/mv.js can drive the real
              progress bar §6.1.4 ② asks for instead of counting finished files.
              The three protagonists dominate the ~3.5 s wait, and they are not
              equal, so "3 of 12 files" would jump in ugly steps.

The output is regenerated, not hand-edited. --check exits 1 when it is stale.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import mv_meshcount as meshcount  # noqa: E402

FULL = os.path.join(ROOT, "asset", "models", "manifest.json")
OUT = os.path.join(ROOT, "asset", "mv", "manifest-mv.json")
MV_DIR = os.path.join(ROOT, "asset", "mv")

# Must match core/mvstage.js HEROES and tools/check_mv_budget.py.
HEROES = [
    ("kirara", "320005", 1, 0, "wpn_1100"),
    ("lamp", "320111", 3, 0, "wpn_1300"),
    ("arcive", "320801", 1, 0, "wpn_1100"),
]

# All 20 classActions in the full manifest carry exactly this list, so the
# compact form folds it away. Must match core/mvmanifest.js ACTION_ANIMS.
ACTION_ANIMS = ["idle", "attack", "class_skill_1", "class_skill_2", "class_skill_3"]

# Must match core/mvmanifest.js SEGMENTS.
SEGMENTS = [("model_pl_", "player"), ("model_en_", "enemy"), ("wpn_", "weapon")]


def segment_key(name):
    """"model_pl_320005" -> "model/player/model_pl_320005.muast" (keyOf's rule)."""
    for prefix, seg in SEGMENTS:
        if name.startswith(prefix):
            return "model/%s/%s.muast" % (seg, name)
    raise SystemExit("unknown model prefix: %s" % name)


def spawned_models():
    """Enemy model names the shipped rooms actually reference."""
    out = set()
    for name in sorted(os.listdir(MV_DIR)):
        if not re.match(r"^R\d\.json$", name):
            continue
        with open(os.path.join(MV_DIR, name), encoding="utf-8") as fh:
            data = json.load(fh)
        for room in (data.get("rooms") or {}).values():
            for spawn in room.get("spawns") or []:
                out.add(spawn["model"])
    return sorted(out)


def file_bytes(entry):
    """Size on the wire. The manifest path carries a ?v= cache-buster."""
    rel = entry["file"].split("?")[0]
    path = os.path.join(ROOT, rel)
    return os.path.getsize(path) if os.path.exists(path) else 0


def build():
    with open(FULL, encoding="utf-8") as fh:
        full = json.load(fh)

    models = {}
    costs = {}
    sizes = {}

    # The only fields core/loader.js and core/actor.js ever read off an entry
    # (grep: entry.animations, .compression, .depthWrite, .facial, .file,
    # .meshopt). `label` is the model-picker's Chinese description and
    # `expressions` is a picker flag -- 1.8 KB of the 32 entries between them,
    # and nothing in the game asks for either. Copying the whole entry "just in
    # case" is how a subset manifest grows back into the full one.
    KEEP = ("animations", "compression", "depthWrite", "facial", "file", "meshopt")

    def take(key, cost_key=None, facial=None, blanched=False):
        entry = full["models"].get(key)
        if not entry:
            raise SystemExit("not in manifest: %s" % key)
        models[key] = {k: entry[k] for k in KEEP if k in entry}
        name = key.split("/")[-1].replace(".muast", "")
        costs[name] = (meshcount.blanched_draws(name) if blanched
                       else meshcount.visible_draws(name, facial))
        sizes[name] = file_bytes(entry)
        return entry

    heroes = {}
    class_actions = {}
    for hid, resource, class_id, head_id, weapon in HEROES:
        key = "model/player/model_pl_%s.muast" % resource
        table = meshcount.facial_table_for(full, resource)
        entry = take(key, facial=table)
        take("model/weapon/%s.muast" % weapon)
        heroes[hid] = {
            "resourceId": resource, "classId": class_id, "headId": head_id,
            "weapon": weapon,
            # Body + weapon: what the hero costs while being the visible one.
            "draws": costs["model_pl_%s" % resource] + costs[weapon],
            "facial": entry.get("facial")
        }
        ck = "%d:%d" % (class_id, head_id)
        if ck in full.get("classActions", {}):
            class_actions[ck] = full["classActions"][ck]

    # Not every spawn is an enemy model. §4.7's B3 is 一位已白紙化的クリエメイト
    # with 玩家模型去色, i.e. a model_pl_ key, so the segment has to come from the
    # name -- the same rule core/mvmanifest.js keyOf applies. A hardcoded
    # "model/enemy/" prefix here raises "not in manifest" for that one spawn.
    #
    # Such a spawn is also priced differently from a hero: core/mvstage.js
    # blanchBody hides every face layer rather than resolving an expression, so
    # the body costs blanched_draws, not visible_draws(facial). Pricing it with a
    # face would charge the room for 17 draws it never issues.
    for name in spawned_models():
        key = segment_key(name)
        if name.startswith("model_pl_"):
            take(key, blanched=True)
        else:
            take(key)

    return {
        "version": full.get("version"),
        # Cut from asset/models/manifest.json by tools/build_mv_manifest.py.
        # Do not hand-edit; run the tool.
        "generator": "tools/build_mv_manifest.py",
        "heroes": heroes,
        "models": models,
        "classActions": class_actions,
        "facialActions": full.get("facialActions"),
        "drawCosts": costs,
        "bytes": sizes,
        # Everything the startup bar has to get through, so the bar can be a
        # fraction of bytes rather than a fraction of files.
        "preloadBytes": sum(sizes["model_pl_%s" % h[1]] + sizes[h[4]]
                            for h in HEROES)
    }


def stamp_of(path):
    """The ?v= cache-buster, which is the only part of a file path not derivable."""
    if "?v=" not in path:
        raise SystemExit("no ?v= stamp to fold: %s" % path)
    return int(path.split("?v=")[1])


def compact(readable):
    """The readable subset -> the shipped shape core/mvmanifest.js expands.

    Everything folded away here is checked to be constant first, so a model that
    does not fit the pattern stops the build instead of shipping a wrong path.
    A wrong path is a 404 at load time with nothing to point at it.
    """
    facial_stamps = set()
    models = {}
    for key, entry in readable["models"].items():
        name = key.split("/")[-1].replace(".muast", "")
        want = "site/asset/models/%s/model.glb.gz" % name
        got = entry["file"].split("?")[0]
        if got != want:
            raise SystemExit("path not derivable from key: %s -> %s" % (key, got))
        if entry.get("compression") != "gzip" or entry.get("depthWrite") is not True:
            raise SystemExit("model breaks the folded constants: %s" % key)
        if entry.get("meshopt"):
            raise SystemExit("model wants meshopt, which the compact form drops: %s" % key)
        row = [stamp_of(entry["file"]), 1 if entry.get("animations") else 0]
        if entry.get("facial"):
            facial_stamps.add(stamp_of(entry["facial"]))
            row.append(entry["facial"].split("/")[-1].split(".json")[0])
        models[name] = row

    actions = {}
    for key, entry in readable["classActions"].items():
        cid, hid = key.split(":")
        want = "site/asset/models/class-actions/class-%s/head-%s.glb.gz" % (cid, hid)
        if entry["file"].split("?")[0] != want:
            raise SystemExit("class action path not derivable: %s" % key)
        if entry.get("animations") != ACTION_ANIMS:
            raise SystemExit("class action clip names differ: %s" % key)
        if entry.get("compression") != "gzip" or entry.get("meshopt") is not True:
            raise SystemExit("class action breaks the folded constants: %s" % key)
        actions[key] = stamp_of(entry["file"])

    # One stamp for every facial file, including facialActions. They are written
    # by one tool in one pass, so they agree; if they ever stop agreeing, folding
    # them would silently point a hero at the wrong table.
    facial_stamps.add(stamp_of(readable["facialActions"]))
    if len(facial_stamps) != 1:
        raise SystemExit("facial stamps disagree, cannot fold: %s"
                         % sorted(facial_stamps))

    return {
        "version": readable["version"],
        # Expanded by core/mvmanifest.js. Do not hand-edit -- run the tool named
        # here. **The caller's name, not this file's.** compact() is shared:
        # tools/build_lb_manifest.py calls it too, and hardcoding this string
        # stamped asset/lb/manifest-lb.json as the Metroidvania's output. The
        # whole point of the field is to say which tool to re-run, so naming the
        # wrong one sends the reader to a tool that will not rebuild that file.
        "generator": readable.get("generator", "tools/build_mv_manifest.py"),
        "facialStamp": facial_stamps.pop(),
        "models": models,
        "actions": actions,
        "heroes": readable["heroes"],
        "drawCosts": readable["drawCosts"],
        "bytes": readable["bytes"],
        "preloadBytes": readable["preloadBytes"]
    }


# plans/metroidvania.md §6.1.4 asks for this file and predicts 「预计 < 8 KB」.
# Held as a gate rather than an estimate: this file is parsed before the first
# room draws, so a rise should have to be argued for instead of drifting.
#
# The three bosses spawn five enemy models the rooms had never referenced
# (32 -> 37 entries), which put the readable shape at 8,649 B -- 457 over. The
# models are needed, so the format gave instead of the target: `models` entries
# are stored compactly and core/mvmanifest.js expands them back (see COMPACT
# below). Same information, 37 entries, well under 8 KB.
LIMIT_BYTES = 8192


def expand(comp):
    """The inverse of compact(), mirroring core/mvmanifest.js expand().

    Here so main() can prove the round trip is lossless without a browser. Kept
    deliberately as a second implementation rather than a shared one: two
    independent readings of the format catch a typo that one shared reading
    would carry into both directions. tools/check_mv_manifest.py checks this
    against the JS module so the two cannot drift.
    """
    stamp = comp["facialStamp"]
    models = {}
    for name, row in comp["models"].items():
        segment = None
        for prefix, seg in SEGMENTS:
            if name.startswith(prefix):
                segment = seg
                break
        if segment is None:
            raise SystemExit("unknown model prefix: %s" % name)
        entry = {
            "animations": row[1] == 1,
            "compression": "gzip",
            "depthWrite": True,
            "file": "site/asset/models/%s/model.glb.gz?v=%d" % (name, row[0])
        }
        if len(row) > 2 and row[2]:
            entry["facial"] = "site/asset/models/facial/%s.json?v=%d" % (row[2], stamp)
        models["model/%s/%s.muast" % (segment, name)] = entry

    actions = {}
    for key, value in comp["actions"].items():
        cid, hid = key.split(":")
        actions[key] = {
            "animations": list(ACTION_ANIMS),
            "compression": "gzip",
            "file": "site/asset/models/class-actions/class-%s/head-%s.glb.gz?v=%d"
                    % (cid, hid, value),
            "meshopt": True
        }

    return {
        "version": comp["version"],
        "generator": comp["generator"],
        "models": models,
        "classActions": actions,
        "facialActions": "site/asset/models/facial/actions.json?v=%d" % stamp,
        "heroes": comp["heroes"],
        "drawCosts": comp["drawCosts"],
        "bytes": comp["bytes"],
        "preloadBytes": comp["preloadBytes"]
    }


def render(data):
    """Compact JSON, one line per top-level section.

    Pretty-printing this costs 1.4 KB in indentation alone (9,017 vs 7,621),
    which is a fifth of the budget spent on whitespace in a file only the loader
    reads. Breaking at the top level keeps a diff legible -- a changed enemy
    list shows as one changed line rather than one changed file.
    """
    parts = []
    for key in sorted(data):
        parts.append(" %s: %s" % (json.dumps(key),
                                  json.dumps(data[key], ensure_ascii=False,
                                             sort_keys=True,
                                             separators=(",", ":"))))
    return "{\n" + ",\n".join(parts) + "\n}\n"


def main():
    readable = build()
    data = compact(readable)

    # The round trip, before anything is written. compact() folds five fields
    # away per model; if any of them is not actually derivable the file ships a
    # path that 404s at load time, and the only symptom is a hero that never
    # appears. Comparing against the readable form is cheap and total.
    back = expand(data)
    for section in ("models", "classActions", "facialActions"):
        if back[section] != readable[section]:
            print("round trip lost %s" % section)
            return 1

    text = render(data)
    if "--check" in sys.argv:
        if not os.path.exists(OUT):
            print("missing: %s" % OUT)
            return 1
        with open(OUT, encoding="utf-8") as fh:
            if fh.read() != text:
                print("stale: %s (run tools/build_mv_manifest.py)" % OUT)
                return 1
        print("manifest-mv.json up to date")
        return 0
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    size = len(text.encode("utf-8"))
    full_size = os.path.getsize(FULL)
    readable_size = len(render(readable).encode("utf-8"))
    print("wrote %s: %d bytes (%d models), full manifest is %d bytes (%.2f%%)"
          % (os.path.relpath(OUT, ROOT), size, len(data["models"]), full_size,
             100.0 * size / full_size))
    print("compact form saves %d bytes over the readable one (%d)"
          % (readable_size - size, readable_size))
    print("preload %.1f MB across %d hero files"
          % (data["preloadBytes"] / 1048576.0, len(HEROES) * 2))
    if size > LIMIT_BYTES:
        print("OVER the %d byte target of 6.1.4 by %d" % (LIMIT_BYTES,
                                                          size - LIMIT_BYTES))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
