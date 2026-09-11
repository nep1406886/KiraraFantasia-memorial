#!/usr/bin/env python3
"""Build complete, paired cinematic assets from cached original bundles.

python tools/rl_fetch_us_bundles.py --all
python tools/build_skill_scene_catalog.py --all --jobs 4

Each worker parses one bundle. Only the parent publishes files and merges indexes,
so a failed scene cannot erase unrelated assets or advertise half a performance.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor, wait, FIRST_COMPLETED
import gc
import gzip
import json
from pathlib import Path
import struct

from export_uniqueskill_scene import SceneExporter, texture_totals, needs_layer_texture
from extract_uniqueskill_timeline import extract
from rl_fetch_us_bundles import ROOT, OUT_DIR, ROSTER, scene_ids

VERSION = 4


def read_json(path, default=None):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def write_changed(path: Path, data: bytes):
    if path.exists() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    temporary.write_bytes(data)
    temporary.replace(path)


def encode(value, pretty=False):
    return (json.dumps(value, ensure_ascii=False, indent=1 if pretty else None,
                       separators=None if pretty else (",", ":")) + "\n").encode("utf-8")


def validate_pair(timeline, payload):
    length = struct.unpack_from("<I", payload, 12)[0]
    document = json.loads(payload[20:20 + length])
    for material in document.get("materials", []):
        state = material.get("extras", {}).get("msb", {})
        layer = state.get("layerTexture")
        if layer and not 0 <= layer["index"] < len(document.get("textures", [])):
            raise ValueError("unbound texture layer: " + material["name"])
    for mesh in document.get("meshes", []):
        for primitive in mesh["primitives"]:
            material = document["materials"][primitive.get("material", 0)]
            if material.get("extras", {}).get("msb", {}).get("layerTexture") and "TEXCOORD_1" not in primitive["attributes"]:
                raise ValueError("missing independent UV: " + mesh.get("name", ""))
    nodes = {n.get("name") for n in document.get("nodes", [])}
    materials = {m.get("name") for m in document.get("materials", [])}
    missing = {p.split("/")[-1] for p in timeline.get("trs", {})} - nodes
    for channel in timeline.get("channels", []):
        target, name = channel.get("target", ""), channel.get("name")
        if target.startswith(("meshVisibility", "meshColor")) and name not in nodes:
            missing.add(str(name))
        if target.startswith(("matColor", "texCoverage", "texTranslation", "texOffset", "texRotate")) and name not in materials:
            missing.add(str(name))
    camera = (timeline.get("camera") or {}).get("node")
    if not camera or camera.split("/")[-1] not in nodes:
        missing.add("camera:" + str(camera))
    if missing:
        raise ValueError("unbound timeline targets: " + ", ".join(sorted(missing)))
    if not timeline.get("frames") or not timeline.get("fps"):
        raise ValueError("empty timeline")


def build_one(rid, bundle_dir, previous=None):
    bundle = Path(bundle_dir) / f"uniqueskill_pl_{rid}_0.muast"
    timeline = extract(bundle)
    textures = {}
    exporter = SceneExporter(bundle, textures, timeline=timeline)
    exporter.find_independent_uv_materials()
    requires_layer = bool(exporter.independent_uv_materials) or any(
        needs_layer_texture(state, timeline["channels"], name)
        for name, state in exporter.msb_material_state().items())
    previous = previous or {}
    old_file = ROOT / previous.get("file", "missing-scene")
    # Version 2 already fixed Color32. If neither source UVs nor authored
    # channels need a second layer, version 4 emits identical geometry/PNG.
    # Reuse that payload instead of recompressing all textures in the catalog.
    reuse = (previous.get("exporterVersion", 0) >= 2
             and not previous.get("layeredMaterials", 0)
             and not requires_layer and old_file.is_file())
    if reuse:
        packed = old_file.read_bytes()
        payload = gzip.decompress(packed)
        length = struct.unpack_from("<I", payload, 12)[0]
        document = json.loads(payload[20:20 + length])
        # An interrupted earlier build may have published the GLB just before
        # its index entry. Never reuse a layered payload using stale index stats.
        reuse = not any(m.get("extras", {}).get("msb", {}).get("layerTexture")
                        for m in document.get("materials", []))
    if reuse:
        stats = {key: previous[key] for key in ("nodes", "meshes", "materials", "textures", "emitters", "cardsWithheld")}
        stats["layeredMaterials"] = 0
    else:
        payload, stats = exporter.export()
        packed = gzip.compress(payload, compresslevel=9, mtime=0)
    del exporter
    validate_pair(timeline, payload)
    scene = {"file": f"site/asset/uniqueskill/scene/{rid}.glb.gz", "compression": "gzip",
             "bytes": len(packed), "exporterVersion": VERSION, **stats}
    timing = {"frames": timeline["frames"], "fps": timeline["fps"],
              "duration": timeline["duration"], "channels": len(timeline["channels"]),
              "events": len(timeline["events"]), "trs": len(timeline["trs"])}
    # UnityPy's object graphs contain cycles. Do not keep parsed bundles alive
    # until the next automatic collection during a thousand-scene build.
    gc.collect()
    return rid, packed, scene, timeline, timing, textures


def publish_indexes(scene_updates, timeline_updates):
    # Re-read at publication to retain entries outside this build's write set.
    scene_path = ROOT / "site/asset/uniqueskill/scene-index.json"
    timing_path = ROOT / "site/asset/uniqueskill/timeline-index.json"
    previous = read_json(scene_path, {"scenes": {}})
    scenes = {**previous.get("scenes", {}), **scene_updates}
    count, size = texture_totals(ROOT, scenes)
    write_changed(timing_path, encode({**read_json(timing_path, {}), **timeline_updates}, True))
    write_changed(scene_path, encode({**previous, "scenes": scenes,
        "textureDir": "site/asset/uniqueskill/texture/", "textureCount": count, "textureBytes": size}, True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--all", action="store_true")
    group.add_argument("--only", action="append", help="exact scene ID; repeatable")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    playback = read_json(ROOT / "site/asset/battle/skill-playback.json")
    existing = read_json(ROOT / "site/asset/uniqueskill/scene-index.json", {"scenes": {}})["scenes"]
    timings = read_json(ROOT / "site/asset/uniqueskill/timeline-index.json", {})
    wanted = set(args.only or scene_ids(playback, None if args.all else ROSTER))
    if args.all:
        wanted.update(existing)  # Repair older published scenes too, including legacy identities.
    if any(not rid.isdigit() for rid in wanted):
        parser.error("scene IDs must be numeric")
    def current(rid):
        entry = existing.get(rid, {})
        return entry.get("exporterVersion") == VERSION and rid in timings and (
            ROOT / f"site/asset/uniqueskill/scene/{rid}.glb.gz").is_file() and (
            ROOT / f"site/asset/uniqueskill/timeline/{rid}.json").is_file()
    todo = sorted(rid for rid in wanted if args.force or not current(rid))
    print(f"{len(wanted)} requested; {len(wanted)-len(todo)} current; {len(todo)} to build", flush=True)
    scenes, timelines, failures = {}, {}, {}
    report_path = ROOT / ".codex-tmp/skill-render/build-report.json"
    status = "RUNNING"
    write_changed(report_path, encode({"status": status, "exporterVersion": VERSION,
        "requested": len(wanted), "built": [], "failures": {}}, True))
    try:
        workers = max(1, min(8, args.jobs))
        with ProcessPoolExecutor(max_workers=workers) as pool:
            remaining = iter(todo)
            futures = {}
            def submit_next():
                rid = next(remaining, None)
                if rid is not None:
                    futures[pool.submit(build_one, rid, str(OUT_DIR), existing.get(rid))] = rid
            for _ in range(workers):
                submit_next()
            i = 0
            while futures:
                completed, _ = wait(futures, return_when=FIRST_COMPLETED)
                for future in completed:
                    requested_id = futures.pop(future)
                    try:
                        rid, packed, scene, timeline, timing, textures = future.result()
                        for digest, image in textures.items():
                            write_changed(ROOT / f"site/asset/uniqueskill/texture/{digest}.png", image)
                        write_changed(ROOT / f"site/asset/uniqueskill/timeline/{rid}.json", encode(timeline))
                        write_changed(ROOT / scene["file"], packed)
                        scenes[rid], timelines[rid] = scene, timing
                    except Exception as exc:
                        failures[requested_id] = f"{type(exc).__name__}: {exc}"
                        print(f"FAILED {requested_id}: {exc}", flush=True)
                    i += 1
                    if i % 25 == 0 or i == len(todo):
                        print(f"[{i}/{len(todo)}] built={len(scenes)} failed={len(failures)}", flush=True)
                        publish_indexes(scenes, timelines)
                    # Bound both running tasks and completed texture payloads.
                    # Submitting the whole catalog can retain gigabytes while
                    # the parent publishes an index, even after popping results.
                    submit_next()
        status = "FAIL" if failures else "PASS"
    except BaseException:
        status = "INTERRUPTED"
        raise
    finally:
        if scenes:
            publish_indexes(scenes, timelines)
        write_changed(report_path, encode({"status": status, "exporterVersion": VERSION,
            "requested": len(wanted), "built": sorted(scenes), "failures": failures}, True))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
