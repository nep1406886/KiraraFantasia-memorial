"""Build the authoritative expression tables the model viewer reads.

The game does not pick expressions by guessing which eye/mouth letter looks
right.  Every character ships anim/player/meigeac_{base}@facial.muast, a
MeigeAnimClip that CharacterAnim.SetFacial uses as a lookup table: the facial
ID is treated as a *frame number*, and for each eAnimTarget_MeshVisibility
node -- one per model layer, addressed by name -- the last keyframe whose
m_Frame <= facialID decides whether that layer is visible.

The action clips then author which facial ID they want.  A MabAnimEvent whose
m_iParam[0] == 1 calls SetFacial(m_iParam[1], m_iParam[2]), so "which face
goes with which motion" is authored data too, including the frame it changes
on.  m_iParam[2] is an override set ID resolved through CharacterFacialDB for
the two characters that need a different face than everyone else.

Facial IDs are grouped into one block per head direction.  Only one block is
ever visible at a time and the shipped GLBs carry geometry for L30 alone, so
an ID from another block is mapped to the L30 state at the same position in
its own block.

Outputs, both consumed by models.js:
  asset/models/facial/{base}.json   per-character states and ID lookup
  asset/models/facial/actions.json  action -> [[frame, facialID, overrideSet]]
and a "facial" key added to every player entry in asset/models/manifest.json.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import UnityPy  # noqa: E402

from build_model_catalog import asset_url, download, load_asset_index  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "asset" / "models" / "manifest.json"
OUTPUT_DIR = ROOT / "asset" / "models" / "facial"

DATABASE = "database/database.muast"
# tools/build_class_action_catalog.py ships these same four bundles.
ANIMATION_BUNDLES = (
    "anim/player/common_menu_body.muast",
    "anim/player/common_battle_body.muast",
    "anim/player/common_menu_head_0.muast",
    "anim/player/common_battle_head_0.muast",
)

# Meige/eAnimTargetType.cs counts from eAnimTarget_Invalid = -1.
MESH_VISIBILITY = 9
# CharacterAnim.OnMeigeAnimEvent dispatches facials on m_iParam[0] == 1.
FACIAL_EVENT = 1
# CharacterDefine.FACIAL_NUM
FACIAL_NUM = 100
# CharacterDefine.FACIAL_ID_DEFAULT / FACIAL_ID_BLINK / FACIAL_ID_ABNORMAL_BATTLE,
# indexed by CharacterDefine.eDir.  The second entry of each pair addresses the
# L30 block, which is the one the shipped models carry.
FACIAL_ID_DEFAULT = (0, 45)
FACIAL_ID_BLINK = ((0, 18), (45, 54))
FACIAL_ID_ABNORMAL_BATTLE = (6, 48)
FACIAL_ID_DEFAULT_L30 = FACIAL_ID_DEFAULT[1]
FACIAL_ID_BLINK_L30 = FACIAL_ID_BLINK[1][1]
FACIAL_ID_ABNORMAL_L30 = FACIAL_ID_ABNORMAL_BATTLE[1]
# Only L30 geometry is exported, so that is the block every ID resolves into.
EXPORTED_BLOCK = "L30"

LAYER_PREFIX = re.compile(r"^([LR]\d+)_(.+)$")
PLAYER_MODEL = re.compile(r"^model/player/model_pl_(\d+)\.muast$")
# An authored facial state lights at least one face part, so an ID that lights
# none is not an expression: the clips also author a blank window that shows the
# head with no face on it, and past the last real keyframe the curves simply
# hold their final key.  Both leave the whole face off, which is what tells them
# apart from a real expression.
#
# No single part may be required.  Demanding a mouth loses killme_agiri's id48,
# a lone eye_D that is her deadpan face and the abnormal-battle face the game
# asks for by number; demanding an eye loses every expression acchikocchi_mayoi
# has, because her eyes are part of the face mesh rather than a layer.
# eyebrrow/eyeblow are the game's own misspellings, not typos here, and the
# matching is case-insensitive because newgame_hazime and sakura_yuzu capitalise
# theirs (Eye_A, Eyebrrow_C).
FACE_LAYER = re.compile(
    r"(?i)^(?:eyebrow|eyebrrow|eyeblow|eyelid|eye|mouth|cheek|tere|cry|pale|nose)(?:_|\d|$)")
MOUTH_LAYER = re.compile(r"(?i)^mouth(?:_|\d|$)")
# The eye sub-frames inside one expression differ only by this suffix; that
# difference *is* the blink, so it is ignored when comparing two states.  The
# separator is optional: newgame_hazime writes Eye_A2 where everyone else writes
# eye_A_2.  Brows are left alone -- an Eyebrrow_C_1 is a companion piece drawn
# together with Eyebrrow_C, not an alternate frame of it.
EYE_SUBFRAME = re.compile(r"(?i)^(eye_[a-z]+?)_?\d+$")


def fetch(entry: dict[str, Any], destination: Path, attempts: int = 5) -> Path:
    """Download with retries: the asset CDN drops SSL connections under load."""
    for attempt in range(1, attempts + 1):
        try:
            return download(asset_url(entry), destination)
        except (urllib.error.URLError, OSError) as error:
            destination.with_suffix(destination.suffix + ".part").unlink(missing_ok=True)
            if attempt == attempts:
                raise
            print(f"    retry {attempt}/{attempts - 1} after {error}")
            time.sleep(min(2 ** attempt, 20))
    raise AssertionError("unreachable")


def read_monobehaviours(path: Path, wanted: set[str]) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    env = UnityPy.load(str(path))
    for item in env.objects:
        if item.type.name != "MonoBehaviour":
            continue
        try:
            script = item.read().m_Script.read().m_Name
            if script not in wanted:
                continue
            found[script] = item.read_typetree()
        except Exception:
            continue
    return found


def visibility_curves(path: Path) -> dict[str, list[tuple[int, int]]]:
    """Layer name -> sorted [(frame, visible)] from the facial clip."""
    curves: dict[str, list[tuple[int, int]]] = {}
    env = UnityPy.load(str(path))
    for item in env.objects:
        if item.type.name != "MonoBehaviour":
            continue
        try:
            if item.read().m_Script.read().m_Name != "MeigeAnimClipHolder":
                continue
            clip = item.read_typetree().get("m_MeigeAnimClip") or {}
        except Exception:
            continue
        for node in clip.get("m_AnimNodeHandlerArray") or []:
            target = node.get("m_Target") or {}
            if target.get("m_TargetType") != MESH_VISIBILITY:
                continue
            component = ((node.get("m_Curves") or [{}])[0].get("m_ComponentCurves")
                         or [{}])[0]
            keys = [(int(key["m_Frame"]), int(key["m_Value"]))
                    for key in component.get("m_KeyDatas") or []]
            if keys:
                curves[target.get("m_TargetName")] = sorted(keys)
    return curves


def visible_at(keys: list[tuple[int, int]], facial_id: int) -> bool:
    """CharacterAnim.SetFacial's exact rule: last key with frame <= id wins."""
    picked = 0
    for index, (frame, _value) in enumerate(keys):
        if frame <= facial_id:
            picked = index
            if frame == facial_id:
                break
    return keys[picked][1] == 1


def facial_blocks(curves: dict[str, list[tuple[int, int]]]) -> dict[int, tuple[str, frozenset[str]]]:
    """facialID -> (direction block, prefix-stripped visible layers).

    Only one direction block is ever lit at once, so an ID that lights several is
    past the authored range and merely holding stale keys.  An ID that lights no
    face part is not an expression either -- see FACE_LAYER.  Both are dropped
    rather than guessed at, which leaves the ID unmapped for the viewer.
    """
    resolved: dict[int, tuple[str, frozenset[str]]] = {}
    for facial_id in range(FACIAL_NUM):
        blocks: dict[str, set[str]] = {}
        for name, keys in curves.items():
            match = LAYER_PREFIX.match(name)
            if not match or not visible_at(keys, facial_id):
                continue
            blocks.setdefault(match.group(1), set()).add(match.group(2))
        if len(blocks) != 1:
            continue
        block, layers = next(iter(blocks.items()))
        if not any(FACE_LAYER.match(layer) for layer in layers):
            continue
        resolved[facial_id] = (block, frozenset(layers))
    return resolved


def expression_key(layers: frozenset[str], base: frozenset[str]) -> frozenset[str]:
    """Identify an expression so it can be compared across direction blocks.

    Two things have to come out of the comparison.  The head base is dropped,
    because it is genuinely different per direction -- a character with a side
    ponytail shows hair_side_R when facing left and hair_side_L when facing
    right, and comparing those would call every state a mismatch.  The eye
    sub-frame number is dropped too: the pair of frames inside one expression is
    what makes the blink, so they name the same face.
    """
    return frozenset(EYE_SUBFRAME.sub(r"\1", layer) for layer in layers - base)


def block_base_layers(resolved: dict[int, tuple[str, frozenset[str]]],
                      order: dict[str, list[int]]) -> dict[str, frozenset[str]]:
    """Per block, the layers every one of its states leaves switched on.

    That is the head base for that direction -- hair, face, backhead -- found by
    what does not move rather than by matching names, so a character who names
    a layer unusually is still read correctly.
    """
    everything = [layers for _block, layers in resolved.values()]
    fallback = frozenset.intersection(*everything) if everything else frozenset()
    base: dict[str, frozenset[str]] = {}
    for block, members in order.items():
        states = [resolved[facial_id][1] for facial_id in members]
        # One lone state cannot say what is constant, so it borrows the base
        # shared by the whole clip instead of declaring all of itself base.
        base[block] = (frozenset.intersection(*states)
                       if len(states) > 1 else fallback)
    return base


def build_character_table(path: Path) -> dict[str, Any] | None:
    """Turn one @facial bundle into the table models.js applies."""
    curves = visibility_curves(path)
    if not curves:
        return None
    resolved = facial_blocks(curves)
    order: dict[str, list[int]] = {}
    for facial_id in sorted(resolved):
        order.setdefault(resolved[facial_id][0], []).append(facial_id)
    exported = order.get(EXPORTED_BLOCK) or []
    if not exported:
        return None

    # Every block walks the same expression list, so an ID from another
    # direction is matched to the L30 state wearing the same face.
    #
    # Not every state exists in every direction, though: R30 authors a closed-eye
    # blink for more than one expression while L30 authors just the one, so a few
    # IDs have no L30 equivalent at all and no geometry to show for them.  Those
    # fall back to the L30 state sharing the most of their face, which keeps the
    # eyes and mouth right and gives up only on the odd eyebrow.  Position breaks
    # ties, scaled by the block's own length since R30 spends two IDs per
    # expression on the eye sub-frames that drive blinking.
    base = block_base_layers(resolved, order)
    # Collapse IDs that switch on exactly the same layers.  Past its last real
    # keyframe a block repeats its final state for the rest of the ID space, and
    # a few characters author one face twice; either way the duplicate would show
    # up in the viewer as a second button nobody can tell from the first.
    unique: list[frozenset[str]] = []
    seen: dict[frozenset[str], int] = {}
    for facial_id in exported:
        layers = resolved[facial_id][1]
        if layers not in seen:
            seen[layers] = len(unique)
            unique.append(layers)
    states = [sorted(layers) for layers in unique]
    keys = [expression_key(layers, base[EXPORTED_BLOCK]) for layers in unique]
    by_content: dict[frozenset[str], int] = {}
    for index, key in enumerate(keys):
        by_content.setdefault(key, index)

    ids: list[int] = []
    matched = Counter()
    for facial_id in range(FACIAL_NUM):
        entry = resolved.get(facial_id)
        if entry is None:
            ids.append(-1)
            continue
        if entry[0] == EXPORTED_BLOCK:
            # The exported block's own IDs already name their state exactly, so
            # they must not go through the content match: it drops the eye
            # sub-frame number, which would fold an ID onto its own blink twin
            # and leave that twin unreachable.
            matched["direct"] += 1
            ids.append(seen[entry[1]])
            continue
        wanted = expression_key(entry[1], base[entry[0]])
        exact = by_content.get(wanted)
        if exact is not None:
            matched["content"] += 1
            ids.append(exact)
            continue
        block_ids = order[entry[0]]
        position = block_ids.index(facial_id)
        # Scale by the block's authored length, not its absorbed one.  Past its
        # last real keyframe a block repeats its final state for the rest of the
        # ID space (achannel_miho's L60 runs to 40 that way), and counting those
        # repeats would land every tie-break early.
        real = len(block_ids)
        while real > 1 and resolved[block_ids[real - 1]][1] == resolved[block_ids[real - 2]][1]:
            real -= 1
        scaled = min(len(states) - 1, position * len(states) // real)
        matched["nearest"] += 1
        # Mouth agreement outranks position.  Mouth letters are allocated the
        # same way in every direction block, so a shared mouth is evidence the
        # two states are the same face; eye letters are allocated per block and
        # shift by one between them, so a shared eye is not.  newgame_hazime's
        # R30 id19 is "closed eye plus mouth_C" and L30 authored no blink of
        # mouth_C, which leaves a four-way tie that only the mouth can settle.
        wanted_mouth = {layer for layer in wanted if MOUTH_LAYER.match(layer)}
        ids.append(max(range(len(keys)),
                       key=lambda index: (len(wanted & keys[index]),
                                          bool(wanted_mouth & keys[index]),
                                          -len(wanted ^ keys[index]),
                                          -abs(index - scaled))))

    # Layers whose visibility never changes across the exported block are the
    # head base -- hair, face, backhead. Layers that are never on are leftovers
    # the atlas ships but this direction does not use; both are recorded so the
    # viewer can hide the second group instead of burning it onto every face.
    every = {name[len(EXPORTED_BLOCK) + 1:] for name in curves
             if name.startswith(EXPORTED_BLOCK + "_")}
    always_on = {layer for layer in every if all(layer in state for state in states)}
    never_on = {layer for layer in every if not any(layer in state for state in states)}
    varying = sorted(every - always_on - never_on)
    index_of = {layer: index for index, layer in enumerate(varying)}
    return {
        "layers": varying,
        "hide": sorted(never_on),
        "states": [sorted(index_of[layer] for layer in state if layer in index_of)
                   for state in states],
        "ids": ids,
        "default": ids[FACIAL_ID_DEFAULT_L30],
        "blink": ids[FACIAL_ID_BLINK_L30],
        "abnormal": ids[FACIAL_ID_ABNORMAL_L30],
        # Reported by --dry-run, not read by the viewer: a character resolving
        # mostly by position means its blocks disagree and the mapping is a guess.
        "_match": dict(matched),
        "_blocks": {block: len(members) for block, members in sorted(order.items())},
    }


def state_tags(ids: list[int], state_count: int,
               actions: dict[str, list[list[int]]]) -> list[list[str]]:
    """Per state, the evidence for what face it is.

    The letters in a layer name say nothing reliable -- eye_C is a different eye
    on every character, and the direction blocks do not even agree with each
    other -- so the states cannot be named by inspecting them.  The clips name
    them instead: CharacterDefine pins three IDs outright, and every action event
    asks for a face by number, so the state win_st_0 asks for is the winning face
    whatever it happens to look like.  The viewer turns these into labels.
    """
    tags: list[set[str]] = [set() for _ in range(state_count)]

    def tag(facial_id: int, name: str) -> None:
        if 0 <= facial_id < len(ids) and ids[facial_id] >= 0:
            tags[ids[facial_id]].add(name)

    for facial_id in FACIAL_ID_DEFAULT:
        tag(facial_id, "default")
    for _open_id, closed_id in FACIAL_ID_BLINK:
        # The pair is [open, closed]: CharacterAnim blinks by moving from the
        # first to the second, so only the second is the closed eye.  Tagging
        # both would call the resting face a blink.
        tag(closed_id, "blink")
    for facial_id in FACIAL_ID_ABNORMAL_BATTLE:
        tag(facial_id, "abnormal")
    for action, events in actions.items():
        # win_st_0 through win_st_4 all ask for the same face, so the family is
        # what carries the meaning; keeping each variant just repeats it.
        family = re.sub(r"_\d+$", "", action)
        for _frame, facial_id, _override in events:
            tag(facial_id, "action:" + family)
    # "default" is the resting face; an action that merely returns to it should
    # not rename it, or every state ends up labelled after some action.
    for entry in tags:
        if len(entry) > 1:
            entry.difference_update({t for t in entry if t.startswith("action:")}
                                    if "default" in entry else set())
    return [sorted(entry) for entry in tags]


def collect_action_events(paths: list[Path]) -> tuple[dict[str, list[list[int]]], int]:
    """Action name -> [[frame, facialID, overrideSetID]] from the motion clips.

    Clip names read "Common_body@battle_run"; the GLB exporter keeps only the
    part after the "@", which is what the viewer sees.  Several body variants
    (Common_body, Common_body_tight) carry the same action, so a conflict would
    make the choice arbitrary -- the caller is told when that happens.
    """
    events: dict[str, dict[str, list[list[int]]]] = {}
    fps = 30
    for path in paths:
        env = UnityPy.load(str(path))
        for item in env.objects:
            if item.type.name != "MonoBehaviour":
                continue
            try:
                if item.read().m_Script.read().m_Name != "MeigeAnimClipHolder":
                    continue
                tree = item.read_typetree()
            except Exception:
                continue
            clip = tree.get("m_MeigeAnimClip") or {}
            name = clip.get("m_Name") or tree.get("m_Name") or ""
            fps = int(clip.get("m_BaseFPS") or fps) or fps
            found = []
            for event in clip.get("m_AnimEvArray") or []:
                params = event.get("m_iParam") or []
                if len(params) < 3 or params[0] != FACIAL_EVENT:
                    continue
                found.append([int(event["m_Frame"]), int(params[1]), int(params[2])])
            if found:
                action = name.split("@", 1)[1] if "@" in name else name
                events.setdefault(action, {})[name] = sorted(found)

    merged: dict[str, list[list[int]]] = {}
    for action, variants in events.items():
        distinct = {json.dumps(value) for value in variants.values()}
        if len(distinct) > 1:
            print(f"  note: {action} has {len(distinct)} differing event sets; "
                  "using the first")
        merged[action] = next(iter(variants.values()))
    return merged, fps


def load_database(cache: Path) -> dict[str, Any]:
    """Model resource ID -> character, plus the facial override sets."""
    entries = load_asset_index()
    entry = next(e for e in entries if e["name"] == DATABASE)
    path = fetch(entry, cache / "database.muast")
    tables = read_monobehaviours(
        path, {"CharacterListDB", "NamedListDB", "CharacterFacialDB"})
    missing = {"CharacterListDB", "NamedListDB"} - set(tables)
    if missing:
        raise SystemExit(f"database.muast is missing {sorted(missing)}")

    base_by_named = {int(p["m_NamedType"]): str(p["m_ResouceBaseName"])
                     for p in tables["NamedListDB"].get("m_Params") or []}
    character: dict[int, tuple[int, str]] = {}
    for param in tables["CharacterListDB"].get("m_Params") or []:
        named = int(param["m_NamedType"])
        base = base_by_named.get(named)
        if base:
            character[int(param["m_ResourceID"])] = (named, base.lower())

    overrides: dict[int, dict[int, int]] = {}
    for param in tables.get("CharacterFacialDB", {}).get("m_Params") or []:
        for data in param.get("m_Datas") or []:
            facial = int(data["m_FacialID"])
            # CharacterFacialDB_Ext.GetOverrideFacialID: a zero result means no
            # override, so only positive IDs actually replace anything.
            if facial > 0:
                overrides.setdefault(int(data["m_TargetNamed"]), {})[
                    int(param["m_ID"])] = facial
    return {"character": character, "overrides": overrides, "entries": entries}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path,
                        default=ROOT / ".codex-tmp" / "facial-build",
                        help="where downloaded bundles are kept between runs")
    parser.add_argument("--limit", type=int, default=0,
                        help="only process this many characters (for a dry run)")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would change without writing anything")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cache = args.cache_dir
    cache.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    models = manifest.get("models") or {}
    database = load_database(cache)
    entries = database["entries"]
    by_name = {e["name"]: e for e in entries}

    # Which characters do the shipped player models actually need?  One facial
    # bundle serves every costume of the same character, so this collapses hard.
    wanted: dict[str, list[str]] = {}
    unmapped: list[str] = []
    for key in models:
        match = PLAYER_MODEL.match(key)
        if not match:
            continue
        found = database["character"].get(int(match.group(1)))
        if not found:
            unmapped.append(key)
            continue
        wanted.setdefault(found[1], []).append(key)

    print(f"{len(models)} models, {len(wanted)} distinct characters, "
          f"{len(unmapped)} player models with no database entry")

    actions, fps = collect_action_events(
        [fetch(by_name[name], cache / Path(name).name) for name in ANIMATION_BUNDLES])
    print(f"{len(actions)} actions carry facial events at {fps} fps")

    named_by_base = {base: named for named, base in
                     ((n, b) for n, b in database["character"].values())}
    written = 0
    skipped: list[str] = []
    tables: dict[str, dict[str, Any]] = {}
    for index, base in enumerate(sorted(wanted), 1):
        if args.limit and index > args.limit:
            break
        bundle = f"anim/player/meigeac_{base}@facial.muast"
        entry = by_name.get(bundle)
        if entry is None:
            skipped.append(f"{base}: no {bundle} in the asset index")
            continue
        try:
            path = fetch(entry, cache / Path(bundle).name)
            table = build_character_table(path)
        except Exception as error:
            skipped.append(f"{base}: {type(error).__name__}: {error}")
            continue
        if table is None:
            skipped.append(f"{base}: no {EXPORTED_BLOCK} visibility curves")
            continue
        named = named_by_base.get(base)
        character_overrides = database["overrides"].get(named or -1) or {}
        table["overrides"] = {str(set_id): table["ids"][facial]
                              for set_id, facial in sorted(character_overrides.items())
                              if 0 <= facial < FACIAL_NUM
                              and table["ids"][facial] >= 0}
        table["tags"] = state_tags(table["ids"], len(table["states"]), actions)
        table["version"] = 1
        tables[base] = table
        written += 1
        blocks = " ".join(f"{k}:{v}" for k, v in table["_blocks"].items())
        print(f"  [{index}/{len(wanted)}] {base}: {len(table['states'])} states, "
              f"{len(table['layers'])} switched layers, {len(table['hide'])} always hidden, "
              f"blocks {blocks}, {table['_match'].get('nearest', 0)} approximated"
              + (f", overrides {sorted(table['overrides'])}" if table["overrides"] else ""))

    for line in skipped:
        print(f"  skip {line}")

    approximated = sorted((t["_match"].get("nearest", 0), base)
                          for base, t in tables.items() if t["_match"].get("nearest"))
    if approximated:
        total = sum(count for count, _ in approximated)
        print(f"\n{total} IDs across {len(approximated)} characters have no exact "
              f"{EXPORTED_BLOCK} state and use the nearest face, worst: "
              + ", ".join(f"{b}({n})" for n, b in approximated[-5:]))

    if args.dry_run:
        print(f"\ndry run: {written} tables built, nothing written")
        return

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for base, table in tables.items():
        shipped = {k: v for k, v in table.items() if not k.startswith("_")}
        (OUTPUT_DIR / f"{base}.json").write_text(
            json.dumps(shipped, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")
    (OUTPUT_DIR / "actions.json").write_text(
        json.dumps({"version": 1, "fps": fps, "actions": actions},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")

    stamp = int(time.time())
    for base, keys in wanted.items():
        if base not in tables:
            continue
        for key in keys:
            models[key]["facial"] = f"site/asset/models/facial/{base}.json?v={stamp}"
    manifest["facialActions"] = f"site/asset/models/facial/actions.json?v={stamp}"
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")

    total = sum((OUTPUT_DIR / f"{base}.json").stat().st_size for base in tables)
    print(f"\nwrote {written} character tables ({total / 1024:.0f} KiB total) "
          f"+ actions.json, and tagged "
          f"{sum(len(keys) for base, keys in wanted.items() if base in tables)} "
          f"models in the manifest")


if __name__ == "__main__":
    main()
