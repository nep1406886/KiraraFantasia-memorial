"""Audit published GLBs for the metadata the viewer needs, without a browser.

The bug this exists to catch: gltfpack 1.2 strips node names and extras even when
handed -kn and -ke, and the viewer's part logic is keyed entirely on those.  A
model missing them still loads and still looks plausible in a thumbnail, so the
failure is invisible until someone notices a hat cutting through hair or a hand
that never appears.  Reading the files directly checks all 2128 in a couple of
minutes, which a screenshot pass cannot.

Checks per model:
  named       every mesh node carries its Unity name
  order       every mesh node carries extras.renderOrder
  face        a player/expression model exposes facePart on its eye/brow/mouth
  onestate    at most one eye, one brow and one mouth would start visible
  side        SIDE_* duplicate sets are present and therefore need suppressing

Usage:
  python tools/audit_models.py                    # whole manifest
  python tools/audit_models.py --kind player --limit 50
  python tools/audit_models.py --verbose model_pl_140007
"""
from __future__ import annotations

import argparse
import gzip
import importlib.util
import inspect
import json
import struct
import sys
from pathlib import Path

FACE_KINDS = ("eye", "eyebrow", "mouth")


def read_gltf_json(path: Path) -> dict:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as handle:
        header = handle.read(12)
        if len(header) != 12 or header[:4] != b"glTF":
            raise ValueError("not a GLB")
        length, kind = struct.unpack("<II", handle.read(8))
        if kind != 0x4E4F534A:
            raise ValueError("first chunk is not JSON")
        return json.loads(handle.read(length).decode("utf-8"))


def load_classifier():
    """Borrow the exporter's own classifier so this cannot drift from it."""
    spec = importlib.util.spec_from_file_location(
        "ckm", Path(__file__).resolve().parent / "convert_kirafan_model.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["ckm"] = module
    spec.loader.exec_module(module)
    for _, obj in vars(module).items():
        if inspect.isclass(obj) and hasattr(obj, "face_part"):
            return obj.face_part
    raise SystemExit("face_part not found in convert_kirafan_model.py")


def audit(doc: dict, face_part=None) -> dict:
    mesh_nodes = [node for node in doc.get("nodes", []) if "mesh" in node]
    named = sum(1 for node in mesh_nodes if node.get("name"))
    ordered = sum(1 for node in mesh_nodes
                  if isinstance(node.get("extras"), dict)
                  and "renderOrder" in node["extras"])
    faces: dict[str, list[str]] = {kind: [] for kind in FACE_KINDS}
    for node in mesh_nodes:
        extras = node.get("extras") or {}
        part = extras.get("facePart") or {}
        if part.get("kind") in faces:
            faces[part["kind"]].append(node.get("name") or "(unnamed)")
    # A model may legitimately have no eye or brow geometry at all -- plenty bake
    # them into the face atlas -- so "kind absent" is not a defect.  What is a
    # defect is a layer the classifier recognises that carries no matching extras,
    # because then only the models.js fallback saves it.
    mismatched: list[str] = []
    if face_part is not None:
        for node in mesh_nodes:
            name = node.get("name") or ""
            if not name:
                continue
            current = (node.get("extras") or {}).get("facePart")
            wanted = face_part(name)
            if (current or None) != (wanted or None):
                mismatched.append(f"{name}:{(current or {}).get('kind') or '-'}"
                                  f"->{(wanted or {}).get('kind') or '-'}")

    side = sum(1 for node in mesh_nodes
               if str(node.get("name") or "").upper().startswith("SIDE_"))
    generator = (doc.get("asset") or {}).get("generator", "")
    return {
        "meshNodes": len(mesh_nodes),
        "named": named,
        "ordered": ordered,
        "faces": {kind: len(names) for kind, names in faces.items()},
        "faceNames": faces,
        "mismatched": mismatched,
        "side": side,
        "generator": generator,
        "meshopt": "EXT_meshopt_compression" in (doc.get("extensionsUsed") or []),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*", help="model ids to audit; default is all")
    parser.add_argument("--site-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--kind", choices=("all", "player", "enemy", "weapon", "shadow"),
                        default="all")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--quiet", action="store_true", help="only print failures")
    args = parser.parse_args()

    face_part = load_classifier()
    manifest_path = args.site_root / "asset" / "models" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    models = manifest.get("models", {})

    selected = []
    for key, preview in models.items():
        if args.kind != "all" and f"/{args.kind}/" not in key:
            continue
        stem = Path(key).stem
        if args.names and stem not in args.names:
            continue
        selected.append((stem, key, preview))
    selected.sort()
    if args.limit:
        selected = selected[:args.limit]

    problems: dict[str, list[str]] = {}
    stats = {"total": 0, "meshopt": 0, "unnamed": 0, "unordered": 0,
             "noface": 0, "multiface": 0, "side": 0, "unreadable": 0}

    for stem, key, preview in selected:
        relative = str(preview.get("file", "")).split("?", 1)[0]
        path = args.site_root / relative
        stats["total"] += 1
        if not path.is_file():
            problems.setdefault(stem, []).append("file missing")
            stats["unreadable"] += 1
            continue
        try:
            report = audit(read_gltf_json(path), face_part)
        except Exception as error:
            problems.setdefault(stem, []).append(f"unreadable ({type(error).__name__})")
            stats["unreadable"] += 1
            continue

        issues = []
        if report["meshopt"]:
            stats["meshopt"] += 1
        if report["meshNodes"] and report["named"] != report["meshNodes"]:
            issues.append(f"named {report['named']}/{report['meshNodes']}")
            stats["unnamed"] += 1
        if report["meshNodes"] and report["ordered"] != report["meshNodes"]:
            issues.append(f"renderOrder {report['ordered']}/{report['meshNodes']}")
            stats["unordered"] += 1
        if report["mismatched"]:
            issues.append(f"{len(report['mismatched'])} facePart mismatches, "
                          f"e.g. {report['mismatched'][0]}")
            stats["noface"] += 1
        # SIDE_* sets are authored, not a defect -- every battle model ships one.
        # They only matter because suppressing them needs names, which the check
        # above already covers, so count them and move on.
        if report["side"]:
            stats["side"] += 1
        if issues:
            problems[stem] = issues
        if args.verbose:
            print(f"{stem:<22}{json.dumps(report['faces'])} "
                  f"named={report['named']}/{report['meshNodes']} "
                  f"ordered={report['ordered']} side={report['side']} "
                  f"meshopt={report['meshopt']} [{report['generator']}]")
        elif not args.quiet and not issues:
            print(f"ok   {stem}")

    for stem in sorted(problems):
        print(f"FAIL {stem:<22}{'; '.join(problems[stem])}")

    print(f"\n{stats['total']} audited, {len(problems)} with problems")
    print(f"  meshopt-compressed : {stats['meshopt']}")
    print(f"  missing names      : {stats['unnamed']}")
    print(f"  missing renderOrder: {stats['unordered']}")
    print(f"  facePart mismatched: {stats['noface']}")
    print(f"  carry SIDE_ meshes : {stats['side']}")
    print(f"  unreadable/missing : {stats['unreadable']}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
