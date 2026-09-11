# One-off diagnostic: parse the raw glb (bind pose, no runtime code) and
# report each mesh's model-space min Y, to compare against the live
# measurements (14304 local min -0.287, 11804 local min -0.170).
# Usage: python tools/rl_glb_bindmin.py model_en_14304 [model_en_11804 ...]
import gzip
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_glb_json(path):
    with gzip.open(path, "rb") as f:
        data = f.read()
    magic, version, length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "not glb"
    off = 12
    clen, ctype = struct.unpack_from("<II", data, off)
    assert ctype == 0x4E4F534A, "first chunk not JSON"
    js = json.loads(data[off + 8: off + 8 + clen].decode("utf-8"))
    return js


def node_local_matrix(node):
    if "matrix" in node:
        m = node["matrix"]
        # column-major -> rows
        return [[m[0], m[4], m[8], m[12]],
                [m[1], m[5], m[9], m[13]],
                [m[2], m[6], m[10], m[14]],
                [m[3], m[7], m[11], m[15]]]
    t = node.get("translation", [0, 0, 0])
    r = node.get("rotation", [0, 0, 0, 1])
    s = node.get("scale", [1, 1, 1])
    x, y, z, w = r
    rot = [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]
    return [
        [rot[0][0] * s[0], rot[0][1] * s[1], rot[0][2] * s[2], t[0]],
        [rot[1][0] * s[0], rot[1][1] * s[1], rot[1][2] * s[2], t[1]],
        [rot[2][0] * s[0], rot[2][1] * s[1], rot[2][2] * s[2], t[2]],
        [0, 0, 0, 1],
    ]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)]
            for i in range(4)]


def main() -> int:
    for name in sys.argv[1:]:
        path = ROOT / "asset" / "models" / name / "model.glb.gz"
        js = load_glb_json(path)
        nodes = js.get("nodes", [])
        meshes = js.get("meshes", [])
        accessors = js.get("accessors", [])
        # world matrix per node
        world = {}

        def walk(i, parent):
            n = nodes[i]
            loc = node_local_matrix(n)
            w = mat_mul(parent, loc) if parent else loc
            world[i] = w
            for c in n.get("children", []):
                walk(c, w)

        scene_nodes = js["scenes"][js.get("scene", 0)]["nodes"] \
            if js.get("scenes") else [i for i in range(len(nodes))]
        for i in scene_nodes:
            walk(i, None)

        rows = []
        for i, n in enumerate(nodes):
            if "mesh" not in n:
                continue
            w = world.get(i)
            if w is None:
                continue
            m = meshes[n["mesh"]]
            best = 1e9
            for prim in m.get("primitives", []):
                ai = prim.get("attributes", {}).get("POSITION")
                if ai is None:
                    continue
                acc = accessors[ai]
                mn = acc.get("min")
                mx = acc.get("max")
                if not mn or not mx:
                    continue
                for cx in (mn[0], mx[0]):
                    for cy in (mn[1], mx[1]):
                        for cz in (mn[2], mx[2]):
                            wy = w[1][0] * cx + w[1][1] * cy \
                                + w[1][2] * cz + w[1][3]
                            if wy < best:
                                best = wy
            if best < 1e8:
                rows.append((best, n.get("name", m.get("name", "?")), i, w))

        rows.sort()
        print("== %s  (%d mesh nodes)" % (name, len(rows)))
        for best, label, i, w in rows[:10]:
            # effective scale on Y along the chain
            sy = (w[1][1] ** 2 + w[1][0] ** 2 + w[1][2] ** 2) ** 0.5
            print("   %-30s minY=%+8.4f  nodeScaleY=%.3f" % (label, best, sy))
    return 0


if __name__ == "__main__":
    sys.exit(main())
