"""Check that every extracted timeline channel binds to a name in its scene GLB.

A channel whose target name is missing from the GLB does not raise at runtime --
core/uniqueskill.js simply never writes it, which is indistinguishable from a
channel the original authored flat. So the only way to know the two halves of
the pipeline agree is to compare their name sets directly.

Checks, per resource ID:
  * every timeline.trs path's leaf name exists as a glTF node
  * every mesh channel's name exists as a node
  * every material channel's name exists as a material
  * the camera node named in MsbHandler.m_HierarchyName exists
  * shared texture URIs resolve to files on disk

Run:  python tools/check_uniqueskill_bind.py
"""

from __future__ import annotations

import gzip
import io
import json
import re
import struct
import sys
from pathlib import Path

MESH_TARGETS = re.compile(r"^mesh(Visibility|Color)")
MAT_TARGETS = re.compile(r"^(matColor|tex(Coverage|Translation|Offset|Rotate)UV)")
TEXTURE_URI_PREFIX = "us_tex/"


def read_glb_json(path: Path) -> dict:
    """Pull the JSON chunk out of a gzip'd GLB without a glTF library."""
    raw = gzip.decompress(path.read_bytes())
    magic, version, length = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF":
        raise ValueError(f"not a GLB: {magic!r}")
    if length != len(raw):
        raise ValueError(f"declared {length} bytes, holding {len(raw)}")
    chunk_len, chunk_type = struct.unpack_from("<I4s", raw, 12)
    if chunk_type != b"JSON":
        raise ValueError(f"first chunk is {chunk_type!r}, expected JSON")
    return json.loads(raw[20:20 + chunk_len].decode("utf-8"))


def main() -> int:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    root = Path(".")
    timeline_dir = root / "asset" / "uniqueskill" / "timeline"
    scene_dir = root / "asset" / "uniqueskill" / "scene"
    index_path = root / "asset" / "uniqueskill" / "scene-index.json"

    index = json.loads(index_path.read_text(encoding="utf-8"))
    scenes = index.get("scenes", index)
    tex_dir = root / (index.get("textureDir") or "site/asset/uniqueskill/texture/")

    ids = sorted(scenes)
    problems: list[str] = []
    totals = {"trs": 0, "mesh": 0, "mat": 0, "cam": 0, "tex": 0}
    missing_tex: set[str] = set()

    for i, mid in enumerate(ids, 1):
        glb = scene_dir / f"{mid}.glb.gz"
        timeline = json.loads((timeline_dir / f"{mid}.json").read_text(encoding="utf-8"))
        try:
            doc = read_glb_json(glb)
        except Exception as exc:
            problems.append(f"{mid}: GLB unreadable -- {exc}")
            continue

        nodes = {n.get("name") for n in doc.get("nodes", []) if n.get("name")}
        materials = {m.get("name") for m in doc.get("materials", []) if m.get("name")}

        bad: list[str] = []
        for path in timeline.get("trs", {}):
            totals["trs"] += 1
            if path.split("/")[-1] not in nodes:
                bad.append(f"trs {path}")

        for channel in timeline.get("channels", []):
            target = channel.get("target", "")
            name = channel.get("name")
            if MAT_TARGETS.match(target):
                totals["mat"] += 1
                if name not in materials:
                    bad.append(f"mat {name} ({target})")
            elif MESH_TARGETS.match(target):
                totals["mesh"] += 1
                if name not in nodes:
                    bad.append(f"mesh {name} ({target})")

        cam = (timeline.get("camera") or {}).get("node")
        if cam:
            totals["cam"] += 1
            if cam.split("/")[-1] not in nodes:
                bad.append(f"camera {cam}")

        for image in doc.get("images", []):
            uri = image.get("uri")
            if not uri:
                continue
            totals["tex"] += 1
            if not uri.startswith(TEXTURE_URI_PREFIX):
                bad.append(f"texture uri {uri}")
            elif not (tex_dir / uri[len(TEXTURE_URI_PREFIX):]).exists():
                missing_tex.add(uri)
                bad.append(f"texture missing {uri}")

        if bad:
            problems.append(f"{mid}: " + "; ".join(bad[:6])
                            + (f" (+{len(bad) - 6} more)" if len(bad) > 6 else ""))
        if i % 40 == 0 or i == len(ids):
            print(f"  {i}/{len(ids)} checked")

    print(f"\n{len(ids)} scenes")
    print(f"  {totals['trs']} TRS paths, {totals['mesh']} mesh channels, "
          f"{totals['mat']} material channels, {totals['cam']} cameras, "
          f"{totals['tex']} texture refs")
    if problems:
        print(f"\n{len(problems)} scenes with unbound names:")
        for line in problems[:25]:
            print("  " + line)
        return 1
    print("  all names bind")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
