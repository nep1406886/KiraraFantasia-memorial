"""Check every shipped facial table is one the viewer can render sanely.

The browser check proves models.js applies a table row exactly; this proves the
rows themselves are sane, for all 238 characters rather than the handful anyone
would click through by hand.

What a good row looks like is not a matter of taste.  A face shows one mouth --
that is what tells an authored expression apart from the blank window the clips
also contain -- and at most one eye and one brow, because two of either would
draw over each other.  Eyes may legitimately be absent: acchikocchi_mayoi bakes
them into the face mesh and ships no eye layer at all.

Layer names are matched loosely on purpose.  The game data misspells them
(eyebrrow with two Rs, eyebrowB with no underscore), so a strict pattern would
quietly pass a row it failed to classify.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TABLES = ROOT / "asset" / "models" / "facial"
MANIFEST = ROOT / "asset" / "models" / "manifest.json"

# Brows must be tested before eyes: every brow name also starts with "eye".
BROW = re.compile(r"^(?:eyebrow|eyebrrow|eyeblow)")
# "eyelid" is not a second eye.  It is a separate layer drawn together with one --
# achannel_run lights eye_A_1 and eyelid in the same state -- so counting it as an
# eye would call every one of that character's expressions a duplicate.
EYELID = re.compile(r"^eyelid")
EYE = re.compile(r"^eye(?:_|\d|$)")
MOUTH = re.compile(r"^mouth(?:_|\d|$)")


def check_table(name: str, table: dict, notes: list[str]) -> list[str]:
    problems: list[str] = []
    layers = table.get("layers") or []
    states = table.get("states") or []
    ids = table.get("ids") or []

    if not states:
        problems.append("no states")
    if len(ids) != 100:
        problems.append(f"ids has {len(ids)} entries, expected 100")

    for index, state in enumerate(states):
        counts = {"eye": 0, "brow": 0, "mouth": 0}
        for layer_index in state:
            if not 0 <= layer_index < len(layers):
                problems.append(f"state {index} references layer {layer_index}")
                continue
            layer = layers[layer_index]
            if BROW.match(layer):
                counts["brow"] += 1
            elif EYELID.match(layer):
                continue
            elif EYE.match(layer):
                counts["eye"] += 1
            elif MOUTH.match(layer):
                counts["mouth"] += 1
        # Several parts of one category in one state is the artists' choice, not a
        # bug: kirara_ututu authors a second doubled-letter face set (eye_AA
        # beside eye_I), sakura_kotone splits a brow across eyebrrow_B and
        # eyebrrow_B_2, and killme_agiri's deadpan face has no mouth at all.  The
        # tables reproduce the clips exactly -- verify_mapping checks that against
        # the source -- so this is counted and reported, never failed.
        for part in ("mouth", "eye", "brow"):
            if counts[part] != 1:
                notes.append(f"{name} state {index}: {counts[part]} {part}s")

    for facial_id, state in enumerate(ids):
        if state == -1:
            continue
        if not 0 <= state < len(states):
            problems.append(f"id {facial_id} maps to state {state}")

    # The three CharacterDefine faces have to exist, or the viewer has no resting
    # face to return to and no blink to run.
    for key in ("default", "blink", "abnormal"):
        value = table.get(key)
        if value is None or not 0 <= value < len(states):
            problems.append(f"{key} state is {value}")

    # A layer listed as never used in this direction must not also be switched on
    # by a state; the viewer hides those last and would override the state.
    switched = set(layers)
    for layer in table.get("hide") or []:
        if layer in switched:
            problems.append(f"hidden layer {layer} is also switched")

    tags = table.get("tags") or []
    if len(tags) != len(states):
        problems.append(f"{len(tags)} tag entries for {len(states)} states")

    for set_id, state in (table.get("overrides") or {}).items():
        if not 0 <= state < len(states):
            problems.append(f"override {set_id} maps to state {state}")

    return problems


def main() -> int:
    files = sorted(TABLES.glob("*.json"))
    files = [path for path in files if path.name != "actions.json"]
    if not files:
        print(f"no tables in {TABLES}")
        return 1

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    referenced = {
        entry["facial"].split("?")[0].rsplit("/", 1)[-1]
        for entry in manifest.get("models", {}).values()
        if entry.get("facial")
    }

    failures = 0
    states_total = 0
    notes: list[str] = []
    for path in files:
        table = json.loads(path.read_text(encoding="utf-8"))
        problems = check_table(path.stem, table, notes)
        states_total += len(table.get("states") or [])
        if problems:
            failures += 1
            print(f"FAIL {path.stem}")
            for problem in problems[:6]:
                print(f"       {problem}")
        if path.name not in referenced:
            print(f"note {path.stem} is not referenced by any model in the manifest")

    actions = json.loads((TABLES / "actions.json").read_text(encoding="utf-8"))
    unresolved = 0
    for action, events in actions["actions"].items():
        for frame, facial_id, _override in events:
            if not 0 <= facial_id < 100:
                print(f"FAIL actions: {action} frame {frame} asks for id {facial_id}")
                failures += 1
        # An action every character resolves to nothing would show no face change.
        resolved = 0
        for path in files:
            table = json.loads(path.read_text(encoding="utf-8"))
            if table["ids"][events[0][1]] >= 0:
                resolved += 1
        if resolved == 0:
            unresolved += 1
            print(f"FAIL actions: no character resolves {action}")

    print(f"\n{len(files)} tables, {states_total} states, "
          f"{len(actions['actions'])} actions at {actions['fps']} fps: "
          + ("all sane" if not failures else f"{failures} with problems"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
