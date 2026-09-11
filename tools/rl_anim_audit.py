# T22h animation audit: measure what each clip of every animated roster
# enemy model actually does, instead of trusting its name.
#
# The view layer (game/rl/view/enemyview.js) maps states onto clips by name:
# telegraph->charge_skill, skill->skill_0/skill_1, idle<->idle, damage, dead.
# That mapping was authored from clip NAMES. This tool decodes the GLB
# animation data directly (enemy models are plain float accessors -- no
# meshopt) and reports, per clip:
#   - duration and active (multi-keyframe) channel count
#   - cyclic error: how far the last frame's pose sits from the first --
#     a LoopRepeat clip with a large error snaps back every cycle
#   - translation ranges of the animated nodes (root motion proxy: which
#     nodes move, how far, in which axes)
# so semantic mismatches (a "charge_skill" that is a one-shot lunge, an
# "idle" that is not cyclic, a skill clip far longer than its state window)
# become numbers instead of eyeball claims.
#
# Roster source: asset/rl/encounters.json (walked for model paths), split by
# asset/models/manifest.json "animations". Run: python tools/rl_anim_audit.py
# Report cache: .cache/rl_anim_audit.json

import gzip
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TYPE_N = {"SCALAR": 1, "VEC3": 3, "VEC4": 4, "MAT4": 16}
COMP_S = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
COMP_F = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}


def read_accessor(gltf, bin_data, idx):
    acc = gltf["accessors"][idx]
    bv = gltf["bufferViews"][acc["bufferView"]]
    n = TYPE_N[acc["type"]] * acc["count"]
    fmt = "<" + COMP_F[acc["componentType"]] * n
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    values = struct.unpack_from(fmt, bin_data, start)
    width = TYPE_N[acc["type"]]
    return [list(values[i:i + width]) for i in range(0, len(values), width)]


def dist(a, b):
    return max(abs(x - y) for x, y in zip(a, b))


def quat_dist(a, b):
    # quaternion distance insensitive to the double-cover sign
    d = sum(x * y for x, y in zip(a, b))
    return 1.0 - abs(d)


def clip_stats(gltf, bin_data, anim, nodes):
    channels = []
    duration = 0.0
    for ch in anim["channels"]:
        s = anim["samplers"][ch["sampler"]]
        path = ch["target"]["path"]
        node = nodes.get(ch["target"]["node"], "?")
        times = [t[0] for t in read_accessor(gltf, bin_data, s["input"])]
        vals = read_accessor(gltf, bin_data, s["output"])
        if not times:
            continue
        duration = max(duration, times[-1])
        if len(times) < 2:
            continue  # a single-key channel is a constant, not motion
        if s.get("interpolation") == "CUBICSPLINE":
            body = [vals[3 * i + 1] for i in range(len(vals) // 3)]
        else:
            body = vals
        first, last = body[0], body[-1]
        cyclic = quat_dist(first, last) if path == "rotation" else dist(first, last)
        ranges = [
            [min(v[i] for v in body), max(v[i] for v in body)]
            for i in range(len(body[0]))
        ]
        channels.append({
            "node": node,
            "path": path,
            "cyclic": cyclic,
            "ranges": ranges,
        })
    active = channels
    cyclic_err = max([c["cyclic"] for c in active], default=0.0)
    # translation channels that actually translate (any axis > 5cm)
    movers = [
        {"node": c["node"], "ranges": [[round(r, 3) for r in ax] for ax in c["ranges"]]}
        for c in active
        if c["path"] == "translation" and any(ax[1] - ax[0] > 0.05 for ax in c["ranges"])
    ]
    return {
        "duration": round(duration, 3),
        "activeChannels": len(active),
        "cyclicError": round(cyclic_err, 4),
        "movers": movers,
    }


def load_glb(path):
    data = gzip.open(path, "rb").read()
    jlen = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + jlen])
    bin_start = 20 + jlen
    bin_len = struct.unpack("<I", data[bin_start:bin_start + 4])[0]
    bin_data = data[bin_start + 8:bin_start + 8 + bin_len]
    nodes = {i: n.get("name", "node%d" % i) for i, n in enumerate(gltf.get("nodes", []))}
    return gltf, bin_data, nodes


def main():
    with open(os.path.join(ROOT, "site/asset/rl/encounters.json"), encoding="utf-8") as f:
        enc = json.load(f)
    with open(os.path.join(ROOT, "site/asset/models/manifest.json"), encoding="utf-8") as f:
        man = json.load(f)["models"]

    models = set()

    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("model"), str):
                models.add(o["model"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(enc)
    animated = sorted(m for m in models if man.get(m, {}).get("animations"))

    report = {}
    for m in animated:
        path = os.path.join(ROOT, man[m]["file"].split("?")[0])
        gltf, bin_data, nodes = load_glb(path)
        report[m] = {
            a["name"]: clip_stats(gltf, bin_data, a, nodes)
            for a in gltf.get("animations", [])
        }

    os.makedirs(os.path.join(ROOT, ".cache"), exist_ok=True)
    with open(os.path.join(ROOT, ".cache/rl_anim_audit.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    # --- summary + flags -------------------------------------------------
    VOCAB = ["idle", "damage", "dead", "skill_0", "skill_1", "charge_skill"]
    TELEGRAPH, SKILL = 0.70, 0.45
    flags = 0
    print("model            clip          dur  cyc    channels movers")
    for m, clips in report.items():
        short = m.rsplit("_", 1)[-1]
        missing = [v for v in VOCAB if v not in clips]
        if missing:
            print("%-15s MISSING %s" % (short, ",".join(missing)))
            flags += 1
        for name in VOCAB:
            if name not in clips:
                continue
            s = clips[name]
            movers = ",".join(x["node"] for x in s["movers"]) or "-"
            print("%-15s %-12s %5.2f %6.3f  %3d      %s"
                  % (short, name, s["duration"], s["cyclicError"],
                     s["activeChannels"], movers))
        c = clips.get("charge_skill")
        if c and c["duration"] < TELEGRAPH and c["cyclicError"] > 0.05:
            print("  FLAG %s: charge_skill %0.2fs < telegraph %0.2fs and NOT cyclic -> loop snaps"
                  % (short, c["duration"], TELEGRAPH))
            flags += 1
        if "idle" in clips and clips["idle"]["cyclicError"] > 0.05:
            print("  FLAG %s: idle not cyclic (err %0.3f) -> LoopRepeat snaps"
                  % (short, clips["idle"]["cyclicError"]))
            flags += 1
        for name in ("skill_0", "skill_1"):
            if name in clips and clips[name]["duration"] > 2.0 * SKILL:
                print("  FLAG %s: %s %0.2fs >> skill window %0.2fs -> gesture truncated"
                      % (short, name, clips[name]["duration"], SKILL))
                flags += 1
        if "damage" in clips and clips["damage"]["duration"] > 2.0 * 0.35:
            print("  FLAG %s: damage %0.2fs >> flinch window 0.35s"
                  % (short, clips["damage"]["duration"]))
            flags += 1
    print("\n%d animated models, %d flags" % (len(report), flags))


if __name__ == "__main__":
    main()
