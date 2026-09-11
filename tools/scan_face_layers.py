"""Validate the viewer's face-layer rules against every converted model.

Mirrors the classifier and preset resolution in models.js so all 2128 models can
be checked without a browser. Reports two failure classes:

  unclassified - an expression layer the viewer would leave permanently visible
  no-selection - a preset that resolves to nothing, leaving the slot blank
"""
import collections
import gzip
import json
import pathlib
import re
import struct
import sys

OVERLAY = re.compile(
    r"^(?:cry|namida|tere|cheek|cheeck|sen|shade|shadow|blue|bule|aozame|pale"
    r"|angry|sad|shy|question|black|red|text)(?:\d|_|$)"
)
KIND = re.compile(r"^(eyebrow|mouth|eye)(.*)$")
# Layers that are part of the head itself and stay visible.
STRUCTURAL = re.compile(
    r"^(?:face|backhead|backhair|ahoge|horn|tuno|tsuno|hair|accessor|head_accessor|kazari"
    r"|ear|nose|hokuro|mole|glass|mask|hat|ribon|ribbon|band|tail|wing|halo|gantai|back_)",
    re.IGNORECASE,
)

PRESETS = {
    "normal": {"eye": ["eye_A_1", "eye_A"], "eyebrow": ["eyebrow_A"], "mouth": ["mouth_A", "mouth_B"]},
    "angry": {
        "eye": ["eye_J", "eye_F", "eye_D_2", "eye_A_1", "eye_A"],
        "eyebrow": ["eyebrow_E", "eyebrow_D", "eyebrow_A"],
        "mouth": ["mouth_I", "mouth_C_2", "mouth_C", "mouth_E"],
    },
    "sad": {
        "eye": ["eye_G", "eye_E", "eye_D", "eye_A_1", "eye_A"],
        "eyebrow": ["eyebrow_D", "eyebrow_C", "eyebrow_A"],
        "mouth": ["mouth_G", "mouth_H", "mouth_B"],
    },
    "surprised": {
        "eye": ["eye_F", "eye_B_1", "eye_B", "eye_D_2", "eye_A_1", "eye_A"],
        "eyebrow": ["eyebrow_D_2", "eyebrow_D", "eyebrow_A"],
        "mouth": ["mouth_C", "mouth_C_2", "mouth_D"],
    },
}


def canonical(part: str) -> str:
    lowered = re.sub(r"^(?:eyebrrow|eyeblow)", "eyebrow", part.lower())
    match = KIND.match(lowered)
    if not match:
        return lowered
    rest = re.sub(r"([a-z])(\d)", r"\1_\2", match.group(2).lstrip("_"))
    return f"{match.group(1)}_{rest}" if rest else match.group(1)


def classify(part: str) -> str:
    key = canonical(part)
    if re.match(r"^eyebrow(?:_|$)", key):
        return "eyebrow"
    if re.match(r"^eye(?:_|$)", key):
        return "eye"
    if re.match(r"^mouth(?:_|$)", key):
        return "mouth"
    if OVERLAY.match(key):
        return "overlay"
    return ""


def fallback(available: dict[str, str], kind: str) -> str:
    """Mirror fallbackFacePart: neutral-looking part for non-letter inventories."""
    if not available:
        return ""
    for preference in ("default", "normal", "open", "wait", "a"):
        wanted = f"{kind}_{preference}"
        if wanted in available:
            return available[wanted]
        variants = sorted(k for k in available if k.startswith(wanted + "_"))
        if variants:
            return available[variants[0]]
    return available[sorted(available)[0]]


def resolve(available: dict[str, str], candidates: list[str]) -> str:
    for candidate in candidates:
        key = canonical(candidate)
        if key in available:
            return available[key]
        prefix = key + "_"
        numbered = sorted(k for k in available if k.startswith(prefix) and k[len(prefix):].isdigit())
        if numbered:
            return available[numbered[0]]
    return ""


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
    residue = collections.Counter()
    residue_example: dict[str, str] = {}
    blank = collections.Counter()
    blank_example: dict[str, str] = {}
    scanned = 0
    models_with_residue = 0
    models_with_blank = 0

    for directory in sorted(root.iterdir()):
        model = directory / "model.glb.gz"
        if not model.exists():
            continue
        try:
            doc = json_chunk(model)
        except Exception as error:  # noqa: BLE001 - report and keep scanning
            print(f"READFAIL {directory.name}: {error}")
            continue
        if not doc:
            continue
        scanned += 1
        available: dict[str, dict[str, str]] = {"eye": {}, "eyebrow": {}, "mouth": {}, "overlay": {}}
        local_residue = []
        for node in doc.get("nodes", []):
            name = node.get("name") or ""
            if not name.lower().startswith("l30_"):
                continue
            part = name[4:]
            kind = classify(part)
            if kind:
                available[kind][canonical(part)] = part
            elif not STRUCTURAL.match(part):
                local_residue.append(part)
        if local_residue:
            models_with_residue += 1
            for part in local_residue:
                residue[part] += 1
                residue_example.setdefault(part, directory.name)

        local_blank = []
        for preset, slots in PRESETS.items():
            for kind, candidates in slots.items():
                if not available[kind]:
                    continue
                chosen = resolve(available[kind], candidates)
                if not chosen:
                    chosen = resolve(available[kind], PRESETS["normal"][kind]) or fallback(available[kind], kind)
                if not chosen:
                    local_blank.append(f"{preset}.{kind}")
        if local_blank:
            models_with_blank += 1
            for entry in local_blank:
                blank[entry] += 1
                blank_example.setdefault(entry, directory.name)

    print(f"scanned {scanned} models")
    print(f"\nmodels with permanently visible expression layers: {models_with_residue}")
    for part, count in residue.most_common(25):
        print(f"  {count:5d}  {part:<26} e.g. {residue_example[part]}")
    print(f"\nmodels where a preset slot resolves to nothing: {models_with_blank}")
    for entry, count in blank.most_common(25):
        print(f"  {count:5d}  {entry:<26} e.g. {blank_example[entry]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
