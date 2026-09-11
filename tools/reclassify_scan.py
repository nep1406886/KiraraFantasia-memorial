"""List models whose facePart extras disagree with the current classifier.

The classifier was widened after part of the catalog had already been built (bare
"cheek"/"sen" overlays, the capitalised Eye_*/Eyebrrow_* sets, and the "eyebrrow"
with no variant suffix).  Rebuilding all 2128 models again to pick that up would
cost hours for a change that touches a few hundred, so compare what is on disk
against what the classifier would emit now and rebuild only the difference.

Only unpacked GLBs can be compared: a meshopt-compressed one has no node names
left, so there is nothing to check and it needs the full rebuild anyway.

Usage:
  python tools/reclassify_scan.py                # summary
  python tools/reclassify_scan.py --args         # --only flags for the rebuild
"""
from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from audit_models import read_gltf_json  # noqa: E402


def load_classifier():
    spec = importlib.util.spec_from_file_location(
        "ckm", ROOT / "tools" / "convert_kirafan_model.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["ckm"] = module
    spec.loader.exec_module(module)
    for _, obj in vars(module).items():
        if inspect.isclass(obj) and hasattr(obj, "face_part"):
            return obj.face_part
    raise SystemExit("face_part not found")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", type=Path,
                        help="write the stale bundle names to this file, one per line, "
                             "for build_model_catalog.py --names-from")
    parser.add_argument("--include-packed", action="store_true",
                        help="also list meshopt-packed models, which carry no names "
                             "to compare and so always need rebuilding")
    args = parser.parse_args()

    face_part = load_classifier()
    manifest = json.loads((ROOT / "asset" / "models" / "manifest.json")
                          .read_text(encoding="utf-8"))
    stale: list[str] = []
    packed: list[str] = []
    detail: dict[str, list[str]] = {}

    for key, preview in manifest.get("models", {}).items():
        path = ROOT / str(preview.get("file", "")).split("?", 1)[0]
        if not path.is_file():
            continue
        try:
            document = read_gltf_json(path)
        except Exception:
            continue
        if "EXT_meshopt_compression" in (document.get("extensionsUsed") or []):
            packed.append(key)
            continue
        changes = []
        for node in document.get("nodes", []):
            if "mesh" not in node:
                continue
            name = node.get("name") or ""
            if not name:
                continue
            current = (node.get("extras") or {}).get("facePart")
            wanted = face_part(name)
            if (current or None) != (wanted or None):
                changes.append(f"{name}: {(current or {}).get('kind')} -> "
                               f"{(wanted or {}).get('kind')}")
        if changes:
            stale.append(key)
            detail[key] = changes

    if args.write:
        names = sorted(stale + (packed if args.include_packed else []))
        args.write.write_text("\n".join(names) + "\n", encoding="utf-8")
        print(f"wrote {len(names)} names to {args.write}")
        return 0

    print(f"{len(stale)} models need reclassifying, "
          f"{len(packed)} still meshopt-packed (need the full rebuild)")
    for key in sorted(stale)[:15]:
        print(f"  {Path(key).stem}: {len(detail[key])} layers, "
              f"e.g. {detail[key][0]}")
    if len(stale) > 15:
        print(f"  ... and {len(stale) - 15} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
