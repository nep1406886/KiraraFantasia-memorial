"""Recheck the three source-audited tree assemblies against the Unity bundle.

python tools/rl_mapkit_source_audit.py --write-evidence
python tools/rl_mapkit_source_audit.py

Requires the same local UnityPy/numpy dependencies as build_mapkit.py.
Evidence records raw Unity values, not exported/glTF coordinates.
"""
import argparse
import gzip
import hashlib
import json
import struct

import numpy as np

from build_mapkit import Bundle, CACHE, OUT_DIR, OUT_JSON, ROOT, pptr_id, vec3

EVIDENCE = ROOT / "docs/data/original-map-tree-data.json"


def read_glb(path):
    raw = gzip.decompress(path.read_bytes())
    magic, version, length = struct.unpack_from("<III", raw)
    assert (magic, version, length) == (0x46546C67, 2, len(raw))
    size, kind = struct.unpack_from("<II", raw, 12)
    assert kind == 0x4E4F534A
    doc = json.loads(raw[20:20 + size])
    bin_size, bin_kind = struct.unpack_from("<II", raw, 20 + size)
    assert bin_kind == 0x004E4942
    return doc, raw[28 + size:28 + size + bin_size]


def accessor(doc, blob, index):
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    assert acc["componentType"] == 5126 and acc["type"] == "VEC3"
    offset = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride", 12)
    return np.array([struct.unpack_from("<fff", blob, offset + i * stride)
                     for i in range(acc["count"])])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-evidence", action="store_true")
    args = parser.parse_args()
    source = CACHE / "questmap_1011.muast"
    bundle = Bundle(source)
    transforms = {bundle.name_of(t): t for t in bundle.transforms.values()}
    clips = {}
    for obj in bundle.env.objects:
        if obj.type.name != "AnimationClip":
            continue
        clip = obj.read_typetree()
        if clip["m_Name"] in ("QuestMapObj_2@idle", "QuestMapObj_2@appear"):
            clips[clip["m_Name"].split("@")[1]] = clip
    idle = clips["idle"]
    first = {}
    for curves, field in (("m_PositionCurves", "position"),
                           ("m_RotationCurves", "rotation"),
                           ("m_ScaleCurves", "scale")):
        for curve in idle[curves]:
            keys = curve["curve"]["m_Curve"]
            if not keys:
                continue
            assert keys[0]["time"] == 0
            first.setdefault(curve["path"], {})[field] = dict(keys[0]["value"])
    data = {"schema": 1, "verifiedAt": "2026-09-08",
            "source": {"bundle": ".cache/mapkit/questmap_1011.muast",
                       "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                       "biome": 2, "coordinateSpace": "Unity source (before X reflection)",
                       "idleClip": idle["m_Name"], "appearClip": clips["appear"]["m_Name"]},
            "assemblies": []}
    index = json.loads(OUT_JSON.read_text(encoding="utf-8"))
    entries = {e["name"]: e for e in index["entries"] if e["biome"] == "1011_2"}
    checks = 0
    for letter in "ABC":
        unit = "tree" + letter
        parts = [unit + str(i) for i in range(1, 5)]
        entry = entries[unit]
        assert entry["sourceParts"] == parts and entry["pose"] == "idle:0"
        assert not any(part in entries for part in parts), "fragments must not remain placeable"
        doc, blob = read_glb(OUT_DIR / "1011_2" / entry["file"])
        nodes = {n["name"]: n for n in doc["nodes"]}
        mesh_names = {n["name"] for n in doc["nodes"] if "mesh" in n}
        assert mesh_names == {"QuestMapObj_2_" + part for part in parts}
        assert len(doc["meshes"]) == 4 and len(doc["animations"]) == 2
        assembly = {"unit": unit, "parts": []}
        points = []
        for part in parts:
            name = "QuestMapObj_2_" + part
            t = transforms[name]
            parent = bundle.name_of(bundle.transforms[pptr_id(t.m_Father)])
            assert parent == "QuestMapObj_2(Clone)"
            raw = {"part": part, "node": name, "parent": parent,
                   "localPosition": vec3(t.m_LocalPosition),
                   "localRotation": [getattr(t.m_LocalRotation, k) for k in "xyzw"],
                   "localScale": vec3(t.m_LocalScale), "idleAtZero": first[name]}
            assembly["parts"].append(raw)
            authored = first[name]
            pos = [authored["position"][k] for k in "xyz"]
            pos[0] *= -1
            rot = [authored.get("rotation", dict(zip("xyzw", raw["localRotation"])))[k]
                   for k in "xyzw"]
            rot[1] *= -1
            rot[2] *= -1
            rot = np.asarray(rot) / np.linalg.norm(rot)
            scale = [authored["scale"][k] for k in "xyz"]
            node = nodes[name]
            assert np.allclose(node["translation"], pos, atol=1e-7)
            assert np.allclose(node["rotation"], rot, atol=1e-7)
            assert node["scale"] == scale
            # Independently reconstruct the XY card bounds from the GLB's
            # reflected quaternion. These trees rotate only around Z.
            assert abs(rot[0]) < 1e-8 and abs(rot[1]) < 1e-8
            z, w = rot[2:]
            matrix = np.array([[1-2*z*z, -2*z*w, 0], [2*z*w, 1-2*z*z, 0], [0, 0, 1]])
            primitive = doc["meshes"][node["mesh"]]["primitives"][0]
            vertices = accessor(doc, blob, primitive["attributes"]["POSITION"])
            points.append((vertices * scale) @ matrix.T + pos + nodes[unit]["translation"])
            checks += 4
        points = np.concatenate(points)
        extent = points.max(axis=0) - points.min(axis=0)
        assert abs(points[:, 1].min()) < 0.00006
        assert np.allclose(entry["footprint"], [round(v, 1) for v in extent[:2]])
        assert extent[1] > 1.3, "complete tree must include trunk and top canopy"
        data["assemblies"].append(assembly)
        checks += 7
    if args.write_evidence:
        EVIDENCE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        assert json.loads(EVIDENCE.read_text(encoding="utf-8")) == data, "source evidence drifted"
    print(f"PASS: {checks} assembly/source/bounds checks; 12 raw nodes recorded")


if __name__ == "__main__":
    main()
