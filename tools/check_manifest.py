"""Check the model manifest is internally consistent and lost nothing.

Several tools write into asset/models/manifest.json: build_model_catalog.py owns
the per-model file and flags, build_facial_table.py adds each character's "facial"
pointer, and the class-action and skill-action builders own their own top-level
keys.  A builder that replaces a whole sub-dict instead of merging into it silently
drops the others -- a full rebuild once wiped the "facial" pointer from 1221
entries, which left every character loading a guessed expression instead of its
authored table, with nothing failing loudly to show it.

So verify what the file claims actually holds:
  * every referenced path exists on disk
  * a model flagged meshopt really carries the compression extension, and one not
    flagged really does not
  * "expressions" agrees with whether the GLB has face layers
  * no per-model key present in git HEAD has gone missing

Usage:
  python tools/check_manifest.py
  python tools/check_manifest.py --baseline .codex-tmp/manifest-head.json
"""
from __future__ import annotations

import argparse
import collections
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from audit_models import read_gltf_json  # noqa: E402

MANIFEST = ROOT / "asset" / "models" / "manifest.json"


def git_baseline() -> dict | None:
    """Read the committed manifest, or None when there is no commit to compare."""
    result = subprocess.run(
        ["git", "show", "HEAD:asset/models/manifest.json"],
        capture_output=True, cwd=ROOT)
    if result.returncode != 0 or not result.stdout:
        return None
    return json.loads(result.stdout.decode("utf-8"))


def collect_paths(node, found: list[str]) -> None:
    """Gather every asset-relative path the manifest references, at any depth."""
    if isinstance(node, str):
        if node.startswith("site/asset/"):
            found.append(node.split("?", 1)[0])
    elif isinstance(node, dict):
        for value in node.values():
            collect_paths(value, found)
    elif isinstance(node, list):
        for value in node:
            collect_paths(value, found)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path,
                        help="compare against this manifest instead of git HEAD")
    parser.add_argument("--skip-glb", action="store_true",
                        help="skip reading every GLB (much faster, less thorough)")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    problems: list[str] = []

    # 1. Every referenced path resolves.
    paths: list[str] = []
    collect_paths(manifest, paths)
    missing = sorted({p for p in paths if not (ROOT / p).is_file()})
    for path in missing[:10]:
        problems.append(f"missing file: {path}")
    if len(missing) > 10:
        problems.append(f"...and {len(missing) - 10} more missing files")
    print(f"{len(set(paths))} referenced paths, {len(missing)} missing")

    # 2. Flags match the files.
    models = manifest.get("models", {})
    if not args.skip_glb:
        flag_bad = 0
        expr_bad = 0
        for key, preview in models.items():
            path = ROOT / str(preview.get("file", "")).split("?", 1)[0]
            if not path.is_file():
                continue
            try:
                document = read_gltf_json(path)
            except Exception as error:
                problems.append(f"{key}: unreadable ({type(error).__name__})")
                continue
            packed = "EXT_meshopt_compression" in (document.get("extensionsUsed") or [])
            if bool(preview.get("meshopt")) != packed:
                flag_bad += 1
                if flag_bad <= 5:
                    problems.append(f"{key}: meshopt flag "
                                    f"{bool(preview.get('meshopt'))} but file {packed}")
            has_face = any(
                (node.get("extras") or {}).get("facePart")
                for node in document.get("nodes", []) if "mesh" in node)
            if has_face and not preview.get("expressions"):
                expr_bad += 1
                if expr_bad <= 5:
                    problems.append(f"{key}: has face layers but expressions is false")
        print(f"{len(models)} models checked, {flag_bad} meshopt flag mismatches, "
              f"{expr_bad} expression flag mismatches")

    # 3. No per-model key regressed against the baseline.
    baseline = (json.loads(args.baseline.read_text(encoding="utf-8"))
                if args.baseline else git_baseline())
    if baseline is None:
        print("no baseline available, skipping the regression comparison")
    else:
        before = collections.Counter()
        after = collections.Counter()
        for preview in baseline.get("models", {}).values():
            before.update(preview.keys())
        for preview in models.values():
            after.update(preview.keys())
        for name, count in sorted(before.items()):
            if after[name] >= count:
                continue
            # "meshopt" is conditional on gltfpack being available, so it legitimately
            # disappears when a rebuild runs without it -- and step 2 above already
            # proved the flag matches what each file actually carries, which is the
            # property that matters.  Every other key is unconditional, so losing one
            # means a builder replaced a dict it should have merged into.
            if name == "meshopt" and not args.skip_glb:
                print(f"note: 'meshopt' went from {count} entries to {after[name]}, "
                      f"consistent with the files (built without gltfpack)")
                continue
            problems.append(f"per-model key '{name}' dropped from {count} "
                            f"entries to {after[name]}")
        lost = set(baseline.get("models", {})) - set(models)
        if lost:
            problems.append(f"{len(lost)} models disappeared, e.g. {sorted(lost)[:3]}")
        for name in ("classActions", "facialActions", "skillActions", "rarity", "visibility"):
            was, now = baseline.get(name), manifest.get(name)
            if was and not now:
                problems.append(f"top-level key '{name}' was dropped")
            elif isinstance(was, dict) and isinstance(now, dict) and len(now) < len(was):
                problems.append(f"top-level '{name}' shrank "
                                f"from {len(was)} to {len(now)} entries")
        print("compared against baseline: "
              f"{len(baseline.get('models', {}))} models, keys {dict(before)}")

    for problem in problems:
        print(f"FAIL {problem}")
    print(f"\n{'PASS -- manifest is consistent' if not problems else f'{len(problems)} problems'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
