#!/usr/bin/env python3
"""Census which player models actually carry hand geometry, by weights not by name.

The bug this exists to catch: check_hands.py decides "this model has hands" by
matching mesh NAMES against HAND_PATTERN, and that question is wrong in both
directions.  model_pl_320801 (アルシーヴ) owns no mesh called "hand" at all, yet
908 of the 950 vertices in its mesh named "arm" are weighted to Hand_L/Hand_R and
the finger and thumb bones -- that mesh *is* the hands, and the name check calls
the model hand-less.  model_pl_320111 (ラム) does ship meshes named "hand" and
"hand_2", so for it the name check happens to agree, by luck rather than by
reason.  A name-keyed checker therefore silently drops every model of the first
kind from its denominator and reports a clean sweep over the subset it can see.

The question that survives contact with the data is: does any mesh have a
meaningful share of its vertices weighted to the hand, finger or thumb bones?
That is answerable straight off the published GLB, so this reads all 1255 player
models from disk instead of driving a browser.

Output: tools/hand_geometry_census.json, keyed by model dir name, plus a stdout
summary that includes the false-negative count of the old name-based check.

Usage:
  python tools/census_hand_geometry.py
  python tools/census_hand_geometry.py --force --jobs 12
  python tools/census_hand_geometry.py --limit 50
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures as futures
import gzip
import io
import json
import re
import struct
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from probe_arm_reach import HAND_BONE, TYPE_COUNT, COMPONENT, read_accessor  # noqa: E402

DEFAULT_OUT = ROOT / "tools" / "hand_geometry_census.json"

# Expression layers for the 30/60-degree head turns duplicate the face, never the
# hands, and there are ~11k of them across the set -- skipping them by prefix keeps
# the census about bodies and cuts the work substantially.
FACE_LAYER_RE = re.compile(r"^(?:L30|L60|R30|R60)_", re.I)
# The name test check_hands.py uses, reproduced here only so the census can report
# how often it would have been wrong.  It is never used to decide anything.
NAME_RE = re.compile(r"(?:^|_)hand(?:_|$)|(?:^|_)finger(?:_|$)", re.I)
# check_hands.py's own skip list, which differs from the face-layer skip above: it
# drops side_ and keeps L30_.  Reproduced verbatim so "would the old check have
# selected this model" is answered by the old rules, not by ours.
NAME_SKIP_RE = re.compile(r"^(?:side|l60|r30|r60)_", re.I)

WEIGHT_EPS = 0.01   # same floor as probe_arm_reach: below this a joint is noise
SHARE_MIN = 5.0     # percent of a mesh's vertices that must follow a hand bone


def read_glb_skin_prefix(path: Path) -> tuple[dict, bytes]:
    """Read the JSON chunk and only as much of the BIN chunk as the skin data needs.

    Textures and the position/normal/UV accessors sit past the joint and weight
    accessors in these bundles, so the tail of the buffer is dead weight for this
    question -- about 30% of it on average.  gzip cannot seek, but it does not have
    to: the JSON arrives first and says how far into the buffer the last JOINTS_0 or
    WEIGHTS_0 accessor reaches, so the same sequential handle can be stopped there.
    Byte offsets stay relative to the start of the BIN chunk, which is what
    read_accessor expects, so a truncated prefix is a drop-in for the whole chunk.
    """
    with gzip.open(path, "rb") as handle:
        header = handle.read(12)
        if len(header) != 12 or header[:4] != b"glTF":
            raise ValueError("not a GLB")
        gltf: dict | None = None
        binary = b""
        while True:
            chunk_header = handle.read(8)
            if len(chunk_header) < 8:
                break
            length, kind = struct.unpack("<II", chunk_header)
            if kind == 0x4E4F534A:  # JSON
                gltf = json.loads(handle.read(length).decode("utf-8"))
                handle.read(-length % 4)
            elif kind == 0x004E4942:  # BIN
                if gltf is None:
                    raise ValueError("BIN chunk precedes JSON chunk")
                need = min(length, skin_bytes_needed(gltf))
                binary = handle.read(need)
                break
            else:
                handle.read(length + (-length % 4))
        if gltf is None:
            raise ValueError("no JSON chunk")
    return gltf, binary


def skin_bytes_needed(gltf: dict) -> int:
    """Highest byte the joint/weight accessors touch, so the read can stop there."""
    end = 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            attrs = prim.get("attributes", {})
            for key in ("JOINTS_0", "WEIGHTS_0"):
                index = attrs.get(key)
                if index is None:
                    continue
                acc = gltf["accessors"][index]
                view = gltf["bufferViews"][acc["bufferView"]]
                per = TYPE_COUNT[acc["type"]]
                itemsize = np.dtype(COMPONENT[acc["componentType"]]).itemsize
                stride = view.get("byteStride") or per * itemsize
                base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
                end = max(end, base + max(acc["count"] - 1, 0) * stride + per * itemsize)
    return end


def hand_slots_of_skin(gltf: dict, node_names: list[str], skin_index: int) -> dict[int, str]:
    """Skin-local joint slots that are a hand, finger or thumb bone, slot -> bone name.

    JOINTS_0 stores indices into the skin's own joint list, not into the node array,
    so the bone names have to be resolved through skins[].joints before any weight
    can be attributed to a hand.
    """
    joints = gltf["skins"][skin_index]["joints"]
    return {slot: node_names[node]
            for slot, node in enumerate(joints)
            if any(key in node_names[node].lower() for key in HAND_BONE)}


def census_model(path: Path) -> dict:
    """Per-mesh hand-weight shares for one published model."""
    gltf, binary = read_glb_skin_prefix(path)
    nodes = gltf.get("nodes", [])
    node_names = [node.get("name", "") for node in nodes]

    # Which node carries which mesh, and therefore which skin the mesh is bound to.
    skin_of_mesh: dict[int, int] = {}
    for node in nodes:
        if "mesh" in node and "skin" in node:
            skin_of_mesh.setdefault(node["mesh"], node["skin"])

    hand_slots_cache: dict[int, dict[int, str]] = {}
    meshes: list[dict] = []
    bones_seen: set[str] = set()
    skipped_unskinned = 0

    for mesh_index, mesh in enumerate(gltf.get("meshes", [])):
        name = mesh.get("name", "")
        if FACE_LAYER_RE.match(name):
            continue
        skin_index = skin_of_mesh.get(mesh_index)
        if skin_index is None:
            skipped_unskinned += 1
            continue
        if skin_index not in hand_slots_cache:
            hand_slots_cache[skin_index] = hand_slots_of_skin(gltf, node_names, skin_index)
        hand_slots = hand_slots_cache[skin_index]
        if not hand_slots:
            continue

        total = 0
        hand_verts = 0
        mesh_bones: set[str] = set()
        for prim in mesh.get("primitives", []):
            attrs = prim.get("attributes", {})
            if "JOINTS_0" not in attrs or "WEIGHTS_0" not in attrs:
                continue
            joints = read_accessor(gltf, binary, attrs["JOINTS_0"])
            weights = read_accessor(gltf, binary, attrs["WEIGHTS_0"]).astype("f4")
            if weights.max(initial=0.0) > 1.5:
                # Integer weights arrive unnormalised; scale by the source type's max
                # rather than a hardcoded 65535, or a ubyte set collapses to zero and
                # the mesh reads as hand-less.
                raw = np.dtype(COMPONENT[gltf["accessors"][attrs["WEIGHTS_0"]]
                                         ["componentType"]])
                if raw.kind in "iu":
                    weights = weights / np.iinfo(raw).max

            slots = np.array(sorted(hand_slots), dtype=joints.dtype)
            mask = np.zeros(len(joints), dtype=bool)
            for column in range(joints.shape[1]):
                touched = np.isin(joints[:, column], slots)
                strong = touched & (weights[:, column] > WEIGHT_EPS)
                mask |= strong
                for slot in np.unique(joints[strong, column]):
                    mesh_bones.add(hand_slots[int(slot)])
            total += len(joints)
            hand_verts += int(mask.sum())

        if not total:
            continue
        share = 100.0 * hand_verts / total
        if share > SHARE_MIN:
            bones_seen |= mesh_bones
            meshes.append({
                "mesh": name,
                "verts": total,
                "hand_verts": hand_verts,
                "share": round(share, 1),
                "name_matches": bool(NAME_RE.search(name)),
                "bones": sorted(mesh_bones),
            })

    # Two different questions, and they disagree on real models.  name_check_would_find
    # asks whether the mesh that actually carries the hands is hand-named.  name_check
    # _selects replays the old check over every mesh name, so it also fires on meshes
    # that merely sound like hands: model_pl_170008 owns ball_hand_L/R, a held prop
    # weighted only to Fore_arm_*, and the old check picks the model up for that while
    # its real hands live in `arm`.  The second figure is the checker's true recall.
    all_names = [mesh.get("name", "") for mesh in gltf.get("meshes", [])]
    meshes.sort(key=lambda entry: -entry["share"])
    return {
        "verdict": "has_hand_geometry" if meshes else "no_hand_geometry",
        "meshes": meshes,
        # The whole point of the census: would the old name-keyed check have seen it?
        "name_check_would_find": any(entry["name_matches"] for entry in meshes),
        "name_check_selects": any(NAME_RE.search(name) and not NAME_SKIP_RE.match(name)
                                  for name in all_names),
        "hand_bones": sorted(bones_seen),
        "unskinned_meshes_skipped": skipped_unskinned,
    }


def worker(path_text: str) -> tuple[str, dict]:
    """Module-level so ProcessPoolExecutor can pickle it on win32 spawn."""
    path = Path(path_text)
    try:
        return path.parent.name, census_model(path)
    except Exception as error:  # noqa: BLE001 -- one bad bundle must not end the run
        return path.parent.name, {"error": f"{type(error).__name__}: {error}"}


def summarise(results: dict[str, dict]) -> None:
    with_hands = [name for name, row in results.items()
                  if row.get("verdict") == "has_hand_geometry"]
    without = [name for name, row in results.items()
               if row.get("verdict") == "no_hand_geometry"]
    errored = {name: row["error"] for name, row in results.items() if "error" in row}
    missed = sorted(name for name in with_hands
                    if not results[name].get("name_check_selects"))
    misattributed = sorted(name for name in with_hands
                           if results[name].get("name_check_selects")
                           and not results[name]["name_check_would_find"])

    print(f"\nplayer models examined:  {len(results)}")
    print(f"  has_hand_geometry:     {len(with_hands)}")
    print(f"  no_hand_geometry:      {len(without)}")
    print(f"  errored:               {len(errored)}")
    if with_hands:
        print(f"\nname-based check would MISS: {len(missed)} of {len(with_hands)} "
              f"({100.0 * len(missed) / len(with_hands):.1f}% false negative)")
        print(f"  first 20: {missed[:20]}")
        print(f"\nselected, but by a mesh that does not carry the hands: "
              f"{len(misattributed)} {misattributed[:20]}")

    carriers: collections.Counter[str] = collections.Counter()
    for row in results.values():
        for entry in row.get("meshes", []):
            carriers[entry["mesh"]] += 1
    print("\ntop 15 mesh names carrying hand weights:")
    for mesh, count in carriers.most_common(15):
        print(f"  {count:5d}  {mesh}")

    if errored:
        print("\nerrors:")
        for name, error in sorted(errored.items()):
            print(f"  {name}: {error}")


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--force", action="store_true",
                        help="re-examine models already present in the JSON")
    parser.add_argument("--jobs", type=int, default=0, help="0 picks a default")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    paths = sorted((ROOT / "asset" / "models").glob("model_pl_*/model.glb.gz"))
    if args.limit:
        paths = paths[:args.limit]

    results: dict[str, dict] = {}
    if args.out.is_file() and not args.force:
        results = json.loads(args.out.read_text(encoding="utf-8"))
    todo = [path for path in paths if args.force or path.parent.name not in results]
    print(f"{len(paths)} player models, {len(todo)} to examine "
          f"({len(paths) - len(todo)} already in {args.out.name})")

    if todo:
        done = 0
        with futures.ProcessPoolExecutor(max_workers=args.jobs or None) as pool:
            for name, row in pool.map(worker, [str(p) for p in todo], chunksize=8):
                results[name] = row
                done += 1
                if done % 200 == 0:
                    print(f"  ...{done}/{len(todo)}")
        args.out.write_text(json.dumps(results, indent=1, ensure_ascii=False,
                                       sort_keys=True), encoding="utf-8")
        print(f"wrote {args.out}")

    summarise(results)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
