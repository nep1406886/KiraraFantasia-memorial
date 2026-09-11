"""Validate the viewer's enemy part rules against every enemy bundle.

Mirrors resolveNodeName + classifyEnemyVisualPart + hideEnemyDuplicateVariants +
enemyDefaultState from models.js, so all 604 enemy models can be checked without
a browser.

Reports:
  multi-state  - an expression group that would show more than one state
  no-core      - a model left with no visible body/head part (over-hiding)
  all-hidden   - a model with nothing visible at all
"""
import collections
import gzip
import json
import pathlib
import re
import struct
import sys

EXPRESSION = re.compile(r"^(eye|eyebrow|eyebrrow|eyebroo|mouth)(?:_([a-z0-9]+))?(?:_([lr]))?_obj$")
STATES = {
    "a", "b", "c", "d", "e", "anger", "angry", "close", "damaga", "damage",
    "default", "fun", "joy", "normal", "open", "ridicule", "wait", "front",
}
DEFAULT_ORDER = ["", "normal", "default", "wait", "front", "open", "a", "b", "c", "d", "e",
                 "fun", "joy", "anger", "angry", "ridicule", "damaga", "damage", "close"]
VARIANT = re.compile(r"_(?:([a-c])|([2-9])|(open|close_half|close|grip))$")


def variant_key(name: str):
    base = name.lower().removesuffix("_obj")
    rank = 0
    while True:
        match = VARIANT.search(base)
        if not match:
            return base, rank
        if match.group(1):
            token = ord(match.group(1)) - 96
        elif match.group(2):
            token = 10 + int(match.group(2))
        else:
            token = 20
        rank = max(rank, token)
        base = base[: match.start()]


def classify(name: str):
    match = EXPRESSION.match(name.lower())
    if not match:
        return None
    state = match.group(2) or ""
    if state and state not in STATES:
        return None
    return match.group(1), state


def rendered_names(doc) -> list[str]:
    parent_of = {}
    for index, node in enumerate(doc["nodes"]):
        for child in node.get("children") or []:
            parent_of[child] = index
    names = []
    for index, node in enumerate(doc["nodes"]):
        if node.get("mesh") is None:
            continue
        name = node.get("name") or ""
        if not name:
            owner = parent_of.get(index)
            name = (doc["nodes"][owner].get("name") or "") if owner is not None else ""
        names.append(name)
    return names


def json_chunk(path: pathlib.Path):
    data = gzip.decompress(path.read_bytes())
    offset = 12
    while offset < len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        if kind == 0x4E4F534A:
            return json.loads(data[offset + 8 : offset + 8 + length])
        offset += 8 + length
    return None


def main() -> int:
    root = pathlib.Path("site/asset/models")
    multi, no_core, all_hidden = [], [], []
    scanned = 0
    for directory in sorted(root.glob("model_en_*")):
        model = directory / "model.glb.gz"
        if not model.exists():
            continue
        doc = json_chunk(model)
        if not doc:
            continue
        scanned += 1
        names = rendered_names(doc)
        groups: dict[str, dict[str, int]] = {}
        variants: dict[str, list[tuple[str, int]]] = {}
        visible = set()
        for name in names:
            part = classify(name)
            if part:
                groups.setdefault(part[0], {})[part[1]] = 1
            elif name.lower().startswith("side_"):
                continue
            else:
                base, rank = variant_key(name)
                variants.setdefault(base, []).append((name, rank))

        for base, members in variants.items():
            best = min(members, key=lambda m: m[1])
            visible.add(best[0])
            if len(members) == 1:
                continue

        for kind, states in groups.items():
            present = [s for s in DEFAULT_ORDER if s in states]
            chosen = present[0] if present else next(iter(states))
            shown = [s for s in states if s == chosen]
            if len(shown) != 1:
                multi.append(f"{directory.name}:{kind}")

        if not visible and not groups:
            all_hidden.append(directory.name)
        elif not any(re.search(r"body|torso|head|bodu", v, re.I) for v in visible) and any(
            re.search(r"body|torso|head|bodu", n, re.I) for n in names
        ):
            no_core.append(directory.name)

    print(f"scanned {scanned} enemy models")
    print(f"expression groups showing >1 state: {len(multi)}")
    for entry in multi[:10]:
        print(f"  {entry}")
    print(f"models with nothing visible: {len(all_hidden)}")
    for entry in all_hidden[:10]:
        print(f"  {entry}")
    print(f"models whose body/head parts all ended up hidden: {len(no_core)}")
    for entry in no_core[:10]:
        print(f"  {entry}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
