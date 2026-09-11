#!/usr/bin/env python3
"""Extract the とっておき cinematic timeline out of a uniqueskill bundle.

The bundle is a whole cut-scene, not just a motion.  Two systems drive it and
both have to be read, because neither one alone is the animation:

  Unity AnimationClip "UniqueSkill@Take 001"
      TRS curves for the camera, the effect meshes and the locators.
      Cubic Hermite with Unity's per-second tangents.

  MeigeAnimClip (MonoBehaviour MeigeAnimClipHolder, same name)
      Everything Unity has no channel for: mesh visibility, mesh alpha,
      scrolling UVs, particle-emitter enable, orthographic zoom -- plus
      m_AnimEvArray, the frame-stamped gameplay events.  Keys are in FRAMES
      and carry unscaled derivatives, so they are a different curve format
      from the Unity ones above and are kept separate here.

The Signal_* GameObjects in the scene are inert markers: nothing references
them by name in the decompiled engine and no curve touches them.  The real
timing lives in m_AnimEvArray, decoded here against
BattleUniqueSkillBaseObjectHandler.eAnimEvent.

Output is one JSON per model under asset/uniqueskill/timeline/.  Geometry is
NOT emitted -- that is the scene GLB's job; this file is the schedule that
drives it.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import sys
from pathlib import Path

import UnityPy

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

CLIP_NAME = "UniqueSkill@Take 001"

# Meige/eAnimTargetType.cs -- the enum is contiguous from 0, so these are the
# literal m_TargetType values seen in the bundles.
TARGET = {
    3: "matColor", 4: "texCoverageUV", 5: "texTranslationUV", 6: "texRotateUV",
    7: "texOffsetUV", 8: "focalLength", 9: "meshVisibility", 11: "peActive",
    12: "meshColor", 25: "matColor.r", 26: "matColor.g", 27: "matColor.b",
    28: "matColor.a", 33: "meshColor.r", 34: "meshColor.g", 35: "meshColor.b",
    36: "meshColor.a", 61: "camOrthoSize",
}

# BattleUniqueSkillBaseObjectHandler.eAnimEvent -- the only consumer wired to
# this clip's notifier (BattleUniqueSkillBaseObjectHandler.cs:40).
EVENT = {
    101: "fadeIn", 102: "fadeOut",
    110: "tgtSingleOnOff", 111: "tgtAllOnOff", 112: "tgtOnOff",
    120: "mySingleOnOff", 121: "myAllOnOff", 122: "myOnOff",
    130: "damageAnim", 140: "weaponVisible",
    150: "meshColorTgtSingleChange", 151: "meshColorTgtSingleRevert",
    152: "meshColorTgtAllChange", 153: "meshColorTgtAllRevert",
    160: "meshColorMySingleChange", 161: "meshColorMySingleRevert",
    162: "meshColorMyAllChange", 163: "meshColorMyAllRevert",
    170: "meshColorSelfChange", 171: "meshColorSelfRevert",
    180: "shadowVisibleOwner", 181: "shadowVisibleTgtAll", 182: "shadowVisibleMyAll",
}

# Some scene clips also carry id 1, which is CharacterAnim's facial event
# (CharacterAnim.cs:434 -> SetFacial).  CharacterAnim only subscribes to the
# character's OWN model sets, never to this scene's notifier, so these events
# reach BattleUniqueSkillBaseObjectHandler, miss every case in its switch, and
# do nothing.  They are emitted for completeness and flagged inert so the
# runtime does not invent an expression change the game never played -- the
# real facial track is the one on owner_body@skill.
INERT_EVENTS = {1: "setFacial"}

# Meige/eAnimControlType.cs
CTRL = {0: "linear", 1: "bool", 2: "constant", 3: "cubic"}

# MsbCameraHandler.UpdateCamera: orthographicSize = m_OrthographicsSize / 354
ORTHO_DIVISOR = 354.0
BUNDLE_RE = re.compile(r"uniqueskill_pl_(\d+)_0\.muast$")


def r4(v: float) -> float:
    """Trim float32 noise so the JSON stays small and diffable."""
    if v is None:
        return 0.0
    if isinstance(v, bool):
        return float(v)
    if math.isinf(v) or math.isnan(v):
        return 0.0
    return round(float(v), 4)


def vec(d: dict | None, keys: str = "xyz") -> list[float]:
    d = d or {}
    return [r4(d.get(k, 0.0)) for k in keys]


# Unity is left-handed; glTF is right-handed. tools/convert_kirafan_model.py
# resolves that by reflecting the X axis -- positions get -x, quaternions
# become (x, -y, -z, w), vertices get -x. The timeline has to land in the same
# space as the GLB it drives, so the identical reflection is applied here
# rather than in the browser: it is asset data, and doing it once at build time
# beats doing it per frame at runtime.
#
# Scale is a diagonal matrix, so C*S*C leaves it unchanged and it is passed
# through untouched.
def reflect_t(v: list[float]) -> list[float]:
    return [r4(-v[0]), v[1], v[2]]


def reflect_r(v: list[float]) -> list[float]:
    return [v[0], r4(-v[1]), r4(-v[2]), v[3]]


def reflect(v: list[float], kind: str) -> list[float]:
    if kind == "t":
        return reflect_t(v)
    if kind == "r":
        return reflect_r(v)
    return v


def read_scripts(env) -> dict[int, str]:
    return {o.path_id: o.read_typetree().get("m_ClassName")
            for o in env.objects if o.type.name == "MonoScript"}


def unity_keys(curve: dict, comps: str, fps: float, kind: str) -> list[list]:
    """One Unity TRS curve -> [[frame, *value, *inSlope, *outSlope], ...].

    Times are converted to frames so every channel in the output file shares
    one clock.  Tangents are per-second in Unity, so they are divided by fps
    to stay correct against a frame-based t.  Slopes are dropped entirely when
    every one of them is zero, which is the common case and halves the file.

    Values and slopes both go through the X reflection, since a derivative of a
    reflected coordinate is the reflected derivative.
    """
    keys = (curve or {}).get("m_Curve") or []
    out = []
    any_slope = False
    for k in keys:
        val = reflect(vec(k.get("value"), comps), kind)
        ins = reflect([r4(v / fps) for v in
                       ((k.get("inSlope") or {}).get(c, 0.0) for c in comps)], kind)
        outs = reflect([r4(v / fps) for v in
                        ((k.get("outSlope") or {}).get(c, 0.0) for c in comps)], kind)
        if any(ins) or any(outs):
            any_slope = True
        out.append([r4(k.get("time", 0.0) * fps), val, ins, outs])
    if not any_slope:
        return [[k[0], k[1]] for k in out]
    return out


def meige_keys(component_curve: dict) -> list[list]:
    """One MabCurve -> [[frame, value, ctrl, leftDeriv, rightDeriv], ...].

    Frames and derivatives are already in Meige's own units here; the runtime
    evaluates these with MabCurve.CalcValue semantics, not Unity's.
    """
    out = []
    any_deriv = False
    for k in component_curve.get("m_KeyDatas") or []:
        ld, rd = r4(k.get("m_LeftDerivative")), r4(k.get("m_RightDerivative"))
        if ld or rd:
            any_deriv = True
        out.append([r4(k.get("m_Frame")), r4(k.get("m_Value")),
                    int(k.get("m_CtrlType", 0)), ld, rd])
    if not any_deriv:
        return [[k[0], k[1], k[2]] for k in out]
    return out


def scene_tree(env) -> tuple[dict, dict]:
    """Transform hierarchy as {pathID: node} plus {name: pathID}."""
    go_name = {o.path_id: o.read_typetree().get("m_Name")
               for o in env.objects if o.type.name == "GameObject"}
    tf = {}
    for o in env.objects:
        if o.type.name != "Transform":
            continue
        d = o.read_typetree()
        tf[o.path_id] = {
            "go": (d.get("m_GameObject") or {}).get("m_PathID"),
            "name": go_name.get((d.get("m_GameObject") or {}).get("m_PathID")),
            "parent": (d.get("m_Father") or {}).get("m_PathID") or 0,
            "children": [c.get("m_PathID") for c in (d.get("m_Children") or [])],
            "t": vec(d.get("m_LocalPosition")),
            "r": vec(d.get("m_LocalRotation"), "xyzw"),
            "s": vec(d.get("m_LocalScale")),
        }
    return tf, {n["name"]: pid for pid, n in tf.items()}


def node_paths(tf: dict, root_id: int | None = None) -> dict[int, str]:
    """Slash path of every transform, matching Unity curve `path` strings.

    Curve paths are relative to the clip's own root (the UniqueSkill(Clone)
    node), so the prefix up to and including it is stripped.
    """
    full = {}

    def walk(pid, prefix):
        n = tf.get(pid)
        if not n:
            return
        path = f"{prefix}/{n['name']}" if prefix else n["name"]
        full[pid] = path
        for c in n["children"]:
            walk(c, path)

    for pid, n in tf.items():
        if not n["parent"] or n["parent"] not in tf:
            walk(pid, "")
    root = full.get(root_id) if root_id is not None else next(
        (p for p in full.values() if p.endswith("UniqueSkill(Clone)")), None)
    if root:
        cut = len(root) + 1
        return {pid: (p[cut:] if p.startswith(root + "/") else
                      ("" if p == root else p)) for pid, p in full.items()
                if root_id is None or p == root or p.startswith(root + "/")}
    return full


def extract(path: Path, clip_name: str = CLIP_NAME, root_id: int | None = None,
            allow_material_only: bool = False) -> dict:
    env = UnityPy.load(path.read_bytes())
    scripts = read_scripts(env)
    tf, by_name = scene_tree(env)
    paths = node_paths(tf, root_id)
    selected_go = {tf[pid]["go"] for pid in paths}
    rel = {p: pid for pid, p in paths.items() if p}

    unity_clip = None
    for o in env.objects:
        if o.type.name == "AnimationClip":
            d = o.read_typetree()
            if d.get("m_Name") == clip_name:
                unity_clip = d
                break
    if unity_clip is None:
        if not allow_material_only:
            raise ValueError(f"{path.name}: no {clip_name!r} AnimationClip")
        # Some battle impact cards animate only Meige UV/visibility channels.
        # A Meige holder is still mandatory below; never borrow another root's TRS.
        unity_clip = {}

    meige = None
    handler = None
    for o in env.objects:
        if o.type.name != "MonoBehaviour":
            continue
        d = o.read_typetree()
        cls = scripts.get((d.get("m_Script") or {}).get("m_PathID"))
        if cls == "MeigeAnimClipHolder":
            mac = d.get("m_MeigeAnimClip") or {}
            if mac.get("m_Name") == clip_name:
                meige = mac
        elif cls == "MsbHandler" and (root_id is None or
                (d.get("m_GameObject") or {}).get("m_PathID") in selected_go):
            handler = d
    if meige is None:
        raise ValueError(f"{path.name}: no MeigeAnimClip {clip_name!r}")

    fps = float(meige.get("m_BaseFPS") or unity_clip.get("m_SampleRate") or 30.0)
    frames = int(meige.get("m_NumOfKeyframe") or 0)
    duration = float(meige.get("m_AnimTimeBySec") or (frames / fps if fps else 0.0))

    out: dict = {
        "fps": fps,
        "frames": frames,
        "duration": r4(duration),
        "clip": clip_name,
        "nodes": {},
        "trs": {},
        "channels": [],
        "events": [],
        "locators": {},
        "camera": {},
    }
    if root_id is not None:
        out["rootName"] = tf[root_id]["name"]

    # Rest pose of everything the clip can touch, so the runtime can build the
    # scene graph without the GLB having to agree on ordering.
    for p, pid in sorted(rel.items()):
        n = tf[pid]
        parent = paths.get(n["parent"], "")
        out["nodes"][p] = {"parent": parent, "t": reflect_t(n["t"]),
                           "r": reflect_r(n["r"]), "s": n["s"]}
        if n["name"].startswith("loc_"):
            out["locators"][n["name"]] = p

    # Unity TRS curves.
    for key, kind, comps in (("m_PositionCurves", "t", "xyz"),
                             ("m_RotationCurves", "r", "xyzw"),
                             ("m_ScaleCurves", "s", "xyz")):
        for c in unity_clip.get(key) or []:
            cpath = c.get("path") or ""
            keys = unity_keys(c.get("curve"), comps, fps, kind)
            if len(keys) < 1:
                continue
            out["trs"].setdefault(cpath, {})[kind] = keys

    # Meige channels: everything Unity cannot express.
    for nh in meige.get("m_AnimNodeHandlerArray") or []:
        tgt = nh.get("m_Target") or {}
        ttype = int(tgt.get("m_TargetType", -1))
        name = TARGET.get(ttype)
        if name is None:
            continue
        comp = 0
        for curve in nh.get("m_Curves") or []:
            for cc in curve.get("m_ComponentCurves") or []:
                keys = meige_keys(cc)
                if not keys:
                    comp += 1
                    continue
                ch = {
                    "target": name,
                    "type": ttype,
                    "name": tgt.get("m_TargetName"),
                    "comp": comp,
                    "p": [int(tgt.get("m_Param0", 0)), int(tgt.get("m_Param1", 0)),
                          int(tgt.get("m_Param2", 0))],
                    "keys": keys,
                }
                out["channels"].append(ch)
                comp += 1

    # Frame-stamped gameplay events.
    for ev in meige.get("m_AnimEvArray") or []:
        params = [int(x) for x in (ev.get("m_iParam") or [])]
        if not params:
            continue
        rec = {
            "frame": r4(ev.get("m_Frame")),
            "id": params[0],
            "event": EVENT.get(params[0]) or INERT_EVENTS.get(params[0])
            or f"unknown{params[0]}",
            "args": params[1:],
        }
        if params[0] not in EVENT:
            rec["inert"] = True
        out["events"].append(rec)
    out["events"].sort(key=lambda e: (e["frame"], e["id"]))

    # Camera: base projection from MsbHandler, path from the tree.
    cams = (handler or {}).get("m_MsbCameraHandlerArray") or []
    if cams:
        cam = cams[0]
        src = cam.get("m_Src") or {}
        hier = cam.get("m_HierarchyName")
        out["camera"] = {
            "node": paths.get(by_name.get(hier), hier),
            "orthographic": int(cam.get("m_ProjectionType", 1)) == 1,
            "orthoSize": r4(src.get("m_OrthographicsSize")),
            "orthoDivisor": ORTHO_DIVISOR,
            "focalLength": r4(src.get("m_FocalLength")),
            "apertureWidth": r4(src.get("m_ApartureWidth")),
            "apertureHeight": r4(src.get("m_ApartureHeight")),
            "near": 0.1,
            "far": 200.0,
            # MsbCameraHandler hard-sets Quaternion.Euler(0, 180, 0) for the
            # orthographic path and ignores the animated rotation curve
            # entirely.  That 180 is a Unity number and does not survive the
            # trip to glTF unchanged:
            #
            #   * The X reflection above maps a 180-degree turn about Y to
            #     itself (the axis negates, the rotation does not).
            #   * Unity cameras look down +Z; glTF and three.js look down -Z.
            #     Reconciling that is another 180 about Y.
            #
            # The two compose to 360, so the camera's rotation in glTF space is
            # identity.  Checked against the basis vectors rather than guessed:
            # Unity screen-right (-1,0,0) reflects to (+1,0,0), up stays
            # (0,1,0), view direction stays (0,0,-1) -- which is precisely an
            # unrotated three.js camera, and the image is not mirrored.
            "fixedEulerY": 0.0,
            "unityEulerY": 180.0,
        }
    return out


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site-root", type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument("--bundle-dir", type=Path,
                   default=Path(".codex-tmp/facial-build/animations"),
                   help="directory of cached uniqueskill_pl_*_0.muast")
    p.add_argument("--models", type=Path, default=Path(".codex-tmp/five-star-models.json"),
                   help="restrict to the model ids in this JSON map")
    p.add_argument("--only", action="append", help="just this model id (repeatable)")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--indent", type=int, default=0,
                   help="pretty-print with this indent (default: compact)")
    p.add_argument("--dry-run", action="store_true", help="report, write nothing")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    site_root = args.site_root.resolve()
    out_dir = site_root / "asset" / "uniqueskill" / "timeline"

    bundles = {}
    for f in sorted(args.bundle_dir.glob("uniqueskill_pl_*_0.muast")):
        m = BUNDLE_RE.search(f.name)
        if m:
            bundles[m.group(1)] = f

    wanted = set(bundles)
    if args.models and args.models.is_file():
        table = json.loads(args.models.read_text(encoding="utf-8"))
        wanted &= set(table)
    if args.only:
        wanted &= set(args.only)
    ids = sorted(wanted)
    if args.limit:
        ids = ids[:args.limit]
    if not ids:
        raise SystemExit("no bundles matched")

    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    index, failed, total = {}, [], 0
    for i, mid in enumerate(ids, 1):
        try:
            data = extract(bundles[mid])
        except Exception as exc:
            failed.append((mid, repr(exc)))
            print(f"[{i}/{len(ids)}] {mid}: FAILED {exc}")
            continue
        blob = json.dumps(data, ensure_ascii=False,
                          separators=(",", ":") if not args.indent else None,
                          indent=args.indent or None)
        if not args.dry_run:
            (out_dir / f"{mid}.json").write_text(blob, encoding="utf-8")
        total += len(blob.encode("utf-8"))
        index[mid] = {
            "frames": data["frames"],
            "fps": data["fps"],
            "duration": data["duration"],
            "channels": len(data["channels"]),
            "events": len(data["events"]),
            "trs": len(data["trs"]),
        }
        print(f"[{i}/{len(ids)}] {mid}: {data['frames']}f "
              f"{data['duration']:.2f}s  trs={len(data['trs'])} "
              f"ch={len(data['channels'])} ev={len(data['events'])} "
              f"{len(blob) / 1024:.1f} KiB")

    if not args.dry_run:
        index_path = out_dir.parent / "timeline-index.json"
        if (args.only or args.limit) and index_path.exists():
            index = {**json.loads(index_path.read_text(encoding="utf-8")), **index}
        index_path.write_text(
            json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    print(f"\n{len(index)} timelines, {total / 1024 / 1024:.2f} MiB total, "
          f"mean {total / max(len(index), 1) / 1024:.1f} KiB")
    if failed:
        print(f"{len(failed)} failed:")
        for mid, err in failed[:10]:
            print(f"  {mid}: {err}")


if __name__ == "__main__":
    main()
