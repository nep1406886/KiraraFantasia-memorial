"""Find models whose hand geometry exists but does not reach the screen.

"Some hands are not rendered" can mean two very different things: the costume has
no hands modelled (long sleeves ending in a cuff, which is authentic), or the
hands are in the bundle and something hides or depth-rejects them.  Only the
second is a bug, and telling them apart needs the live scene, because visibility
is decided at load.

Selection is by BONE WEIGHT, not mesh name.  These exports name pieces by costume
region rather than by anatomy, so hand geometry routinely arrives under a name
that says nothing about hands: model_pl_320801's hands are a mesh called `arm`
(95.6% weighted to Hand_*/Middle_finger_*/Thumb_*), and model_pl_100101's are
called `armor_rope_3`.  An earlier version of this script matched names, and
tools/hand_geometry_census.json measures what that cost: of the 1218 player
models that carry hand geometry, only 467 have a mesh named for it -- the name
test misses 751, a 61.7% false-negative rate, and it silently drops them from the
denominator rather than failing them.  It has no false positives, so a name match
is still good evidence; it is just far too narrow to be the selector.

That is also where this docstring's old claim that "788 of 1255 player models
carry no hand mesh at all" came from: 1255 - 467.  It was the miss rate wearing a
costume.  Only 37 models genuinely have no hand geometry.

Usage:
  python tools/check_hands.py                     # every model with hand geometry
  python tools/check_hands.py --limit 60
  python tools/check_hands.py model_pl_100001
  python tools/check_hands.py --min-share 30      # loosen the bone-weight cutoff

Requires tools/hand_geometry_census.json (built by tools/census_hand_geometry.py).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from audit_models import read_gltf_json  # noqa: E402

# Kept only as corroborating evidence in the report -- a name match is reliable
# when it happens (zero false positives across 1255 models), it just misses 61.7%
# of real hand geometry, so it must not decide which meshes get checked.
HAND_PATTERN = r"(?:^|_)hand(?:_|$)|(?:^|_)finger(?:_|$)"
HAND_RE = re.compile(HAND_PATTERN, re.I)
# The duplicate side-facing set and non-exported head directions are meant to be
# suppressed, so they must not count as geometry that failed to reach the screen.
SKIP_RE = re.compile(r"^(?:side|l60|r30|r60)_", re.I)

CENSUS_PATH = ROOT / "tools" / "hand_geometry_census.json"
# A mesh has to be mostly hand to be judged as one.  Below this it is an arm or a
# sleeve that happens to include the wrist, and demanding it be visible would fail
# models that are correct.
DEFAULT_MIN_SHARE = 50.0

# The caller passes in the mesh names the census identified as hand geometry for
# this model, so the page never has to guess from a name.
PROBE = """(wanted) => {
  const root = window.__modelDebug;
  if (!root) return {error: 'no model root'};
  const want = new Set(wanted);
  const hands = [], all = [];
  root.traverse(node => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    const raw = (node.name || '');
    const name = raw.toLowerCase();
    // Skip the duplicate side-facing set and the non-exported head directions:
    // those are meant to be suppressed and would read as false positives.
    if (/^side_/.test(name) || /^(l60|r30|r60)_/.test(name)) return;
    // Every mesh name, so the caller can prove the viewer mounted the model it
    // asked for rather than falling back to its default one.
    all.push(raw);
    // three.js appends _1 to disambiguate duplicate names, so compare on the stem.
    const stem = raw.replace(/_\\d+$/, '');
    if (!want.has(raw) && !want.has(stem)) return;
    const material = node.material || {};
    hands.push({
      name: raw,
      visible: node.visible,
      // visible is per-node; a hidden ancestor still removes it from the frame.
      inScene: (() => { let n = node; while (n) { if (!n.visible) return false; n = n.parent; } return true; })(),
      order: node.renderOrder,
      opacity: material.opacity,
      transparent: !!material.transparent,
      alphaTest: material.alphaTest,
      depthWrite: !!material.depthWrite,
      namedForHands: /__HAND_RE__/.test(name)
    });
  });
  return {hands, all};
}""".replace("__HAND_RE__", HAND_PATTERN)


def load_census() -> dict:
    """Per-model hand geometry measured by bone weight, keyed by model id."""
    if not CENSUS_PATH.is_file():
        raise SystemExit(
            f"missing {CENSUS_PATH.relative_to(ROOT)}\n"
            "build it first: python tools/census_hand_geometry.py")
    return json.loads(CENSUS_PATH.read_text(encoding="utf-8"))


def hand_meshes(entry: dict, min_share: float) -> list[dict]:
    """The meshes in one census entry that are mostly hand, by bone weight."""
    return [m for m in (entry.get("meshes") or [])
            if m.get("share", 0) >= min_share and not SKIP_RE.match(m.get("mesh") or "")]


def sides_of(mesh: dict) -> set[str]:
    """Which hands a mesh carries, read from its bones rather than its name.

    One mesh often holds both: model_pl_320801's `arm` is weighted to Hand_L and
    Hand_R together, so a name-derived side would call it neither and skip it.
    """
    sides = set()
    for bone in mesh.get("bones") or []:
        lowered = bone.lower()
        if re.search(r"(?:^|_)l\d*(?:_|$)", lowered):
            sides.add("L")
        elif re.search(r"(?:^|_)r\d*(?:_|$)", lowered):
            sides.add("R")
    return sides


def expected_meshes(name: str) -> set[str]:
    """The mesh names the GLB on disk actually contains, minus the sets the probe skips.

    Used to prove the viewer mounted the requested model.  A name the viewer cannot
    resolve leaves it showing its default startup model, and probing that reports a
    cheerful pass for a model that was never loaded -- which is how a 120-model
    sweep once came back 120/120 with every single entry reporting the same two
    arm meshes.
    """
    path = ROOT / "asset" / "models" / name / "model.glb.gz"
    if not path.is_file():
        return set()
    try:
        document = read_gltf_json(path)
    except Exception:  # noqa: BLE001
        return set()
    return {node["name"] for node in document.get("nodes", [])
            if "mesh" in node and node.get("name") and not SKIP_RE.match(node["name"])}


def normalise(name: str) -> str:
    """Accept a manifest key, a bundle path or a bare id and return the bare id.

    Manifest keys are bundle paths ("model/player/model_pl_100001.muast"), so a list
    built from them has to be reshaped before it can go into the URL, or the folder
    and suffix get applied twice.
    """
    return Path(name).stem


def folder_for(name: str) -> str:
    if name.startswith("model_en_"):
        return "enemy"
    if name.startswith("wpn_"):
        return "weapon"
    return "player"


def models_with_hands(census: dict, min_share: float) -> list[str]:
    """Every model the census shows carrying hand geometry, whatever it is named.

    This is the fix for the 61.7% miss: the old version walked the GLBs looking
    for a mesh named like a hand, which drops 751 models that have hands under a
    costume-region name.
    """
    return sorted(mid for mid, entry in census.items()
                  if hand_meshes(entry, min_share))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*")
    parser.add_argument("--from", dest="from_file", type=Path,
                        help="read names from this file, one per line; manifest keys "
                             "and bare ids are both accepted")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--settle", type=float, default=7.0)
    parser.add_argument("--port", type=int, default=8642)
    parser.add_argument("--min-share", type=float, default=DEFAULT_MIN_SHARE,
                        help="percent of a mesh's vertices that must be weighted "
                             "to hand bones before it counts as hand geometry")
    args = parser.parse_args()

    census = load_census()
    names = [normalise(name) for name in args.names] \
        or models_with_hands(census, args.min_share)
    if args.from_file:
        names = [normalise(line.strip())
                 for line in args.from_file.read_text(encoding="utf-8").splitlines()
                 if line.strip() and not line.startswith("#")]
    if args.limit:
        names = names[:args.limit]
    print(f"checking {len(names)} models that carry hand geometry "
          f"(selected by bone weight >= {args.min_share:.0f}%)\n")

    failures = 0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            args=["--enable-unsafe-swiftshader", "--use-gl=swiftshader"])
        for index, name in enumerate(names, 1):
            census_entry = census.get(name)
            if census_entry is None:
                print(f"[{index}/{len(names)}] FAIL {name:<18} "
                      f"not in the census; rebuild tools/hand_geometry_census.json")
                failures += 1
                continue
            expected_hands = hand_meshes(census_entry, args.min_share)
            if not expected_hands:
                print(f"[{index}/{len(names)}] skip {name:<18} "
                      f"no mesh is >= {args.min_share:.0f}% hand by bone weight")
                continue

            page = browser.new_page(viewport={"width": 900, "height": 700})
            try:
                page.goto(f"http://localhost:{args.port}/site/models.html?debug=1"
                          f"#model/{folder_for(name)}/{name}.muast",
                          wait_until="load", timeout=60000)
                page.wait_for_function("() => !!window.__modelDebug", timeout=40000)
                time.sleep(args.settle)
                result = page.evaluate(PROBE, [m["mesh"] for m in expected_hands])
            except Exception as error:  # noqa: BLE001
                result = {"error": f"{type(error).__name__}: {error}"}
            page.close()

            if "error" in result:
                print(f"[{index}/{len(names)}] FAIL {name}: {result['error']}")
                failures += 1
                continue
            # Prove the right model is on screen before believing anything about it.
            wanted = expected_meshes(name)
            if not wanted:
                # No GLB on disk under this name, so there is nothing to compare
                # against and the viewer is showing its fallback.  Treat it as a
                # failure rather than probing whatever happens to be mounted.
                print(f"[{index}/{len(names)}] FAIL {name:<18} "
                      f"no model.glb.gz on disk for this name")
                failures += 1
                continue
            if wanted:
                got = set(result.get("all") or [])
                # three.js appends a disambiguating "_1" when two nodes would
                # otherwise share a name, so match on the stem rather than exactly:
                # the GLB's WPN_1002200_R arrives in the scene as WPN_1002200_R_1.
                stems = {re.sub(r"_\d+$", "", scene_name) for scene_name in got}
                if not (wanted & got or wanted & stems):
                    print(f"[{index}/{len(names)}] FAIL {name:<18} "
                          f"wrong model mounted: expected meshes like "
                          f"{sorted(wanted)[:2]}, got {sorted(got)[:2]}")
                    failures += 1
                    continue
            # Discovery selected this model because the census found hand geometry,
            # so a probe that finds none means the scene disagrees with the file --
            # not a model with nothing to check.  Without this an empty list leaves
            # `dark` empty and prints "ok 0/0", which is how six weapon-handle
            # enemies once counted as passes.
            if not result["hands"]:
                print(f"[{index}/{len(names)}] FAIL {name:<18} "
                      f"none of the census's hand meshes reached the scene; "
                      f"expected {[m['mesh'] for m in expected_hands][:3]}")
                failures += 1
                continue

            # Hands come in alternates just as face layers do -- model_en_13503 ships
            # hand_L_obj and hand_L_2_obj, model_en_13703 adds hand_drumming_L_obj
            # and finger_open_L_obj -- and only one of each set is meant to show.
            # So the test is not "every hand mesh is visible", which fails on every
            # correctly authored model; it is "each side that has hand geometry
            # renders at least one of it".  Sides come from the census's bone lists,
            # because one mesh can carry both hands and its name says neither.
            by_mesh = {m["mesh"]: m for m in expected_hands}
            lit_sides: set[str] = set()
            all_sides: set[str] = set()
            for mesh in expected_hands:
                all_sides |= sides_of(mesh)
            for entry in result["hands"]:
                mesh = by_mesh.get(entry["name"]) \
                    or by_mesh.get(re.sub(r"_\d+$", "", entry["name"]))
                opacity = entry["opacity"] if entry["opacity"] is not None else 1
                if mesh and entry["inScene"] and opacity >= 0.05:
                    lit_sides |= sides_of(mesh)

            dark = sorted(all_sides - lit_sides)
            if dark:
                failures += 1
                print(f"[{index}/{len(names)}] FAIL {name:<18} "
                      f"no visible hand on side(s): {', '.join(dark)}; "
                      f"census meshes {[m['mesh'] for m in expected_hands][:3]}")
            else:
                shown = sum(1 for h in result["hands"] if h["inScene"])
                sides = "".join(sorted(all_sides))
                # Flag the ones the old name-based checker would have skipped, so a
                # sweep shows how much of its coverage came from this fix.
                unnamed = [h["name"] for h in result["hands"] if not h["namedForHands"]]
                note = f" via {unnamed[0]}" if unnamed and shown else ""
                print(f"[{index}/{len(names)}] ok   {name:<18} "
                      f"{shown}/{len(result['hands'])} hand mesh(es) visible"
                      f"{f' sides={sides}' if sides else ''}{note}")
        browser.close()
    print(f"\n{len(names) - failures}/{len(names)} render their hands")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
