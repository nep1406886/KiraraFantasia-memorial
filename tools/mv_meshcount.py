"""Count how many draw calls a model costs, by reading the GLB. No browser.

plans/metroidvania.md 6.1.3 established the unit: with only 2 shader programs in
the scene but a different texture and renderOrder per mesh, three.js cannot batch,
so *visible mesh count == draw calls*. It measured that in headless chromium.

This gets the same number out of the file. A GLB is a 12-byte header followed by
chunks, the first of which is the glTF JSON, so the node list and mesh list are
readable with struct and gzip -- nothing three.js-specific. Visibility is the only
subtle part: core/actor.js applyFace() hides face layers (nodes named l30_*/l60_*)
that the facial table does not list in the current expression, and everything in
the table's `hide` array. Nothing else is ever hidden.

Cross-checked against 6.1.3's browser measurements, which counted the actor after
equip() so the weapon is included:

    model     computed here      6.1.3 measured
    320005    42 + 1 weapon = 43   43
    320111    46 + 2 weapon = 48   48
    320801    44 + 1 weapon = 45   45

Three for three. That is what makes a static budget gate worth having: it can run
in CI with no GPU, and it can price a room that has never been opened.
"""

import gzip
import io
import json
import os
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "asset", "models")

_cache = {}


def read_gltf(path):
    """Return the glTF JSON chunk of a .glb or .glb.gz."""
    opener = gzip.open if path.endswith(".gz") else io.open
    with opener(path, "rb") as fh:
        raw = fh.read()
    if raw[:4] != b"glTF":
        raise ValueError("%s is not a GLB" % path)
    length, = struct.unpack("<I", raw[12:16])
    kind = raw[16:20]
    if kind != b"JSON":
        raise ValueError("%s: first chunk is %r, expected JSON" % (path, kind))
    return json.loads(raw[20:20 + length].decode("utf-8"))


def _mesh_nodes(gltf):
    """Nodes that carry a mesh, with the name and primitive count of each.

    Primitives, not meshes: a mesh with two primitives is two draws. In this
    asset set they happen to be 1:1, but pricing by mesh would silently
    under-count if a future export merged differently.
    """
    out = []
    meshes = gltf.get("meshes", [])
    for node in gltf.get("nodes", []):
        if "mesh" not in node:
            continue
        prims = len(meshes[node["mesh"]].get("primitives", []))
        out.append((node.get("name") or "", prims))
    return out


def model_path(model_key):
    return os.path.join(MODELS, model_key, "model.glb.gz")


def total_draws(model_key):
    """Every mesh, visible or not. This is the memory-ish number, not the cost."""
    key = ("total", model_key)
    if key not in _cache:
        gltf = read_gltf(model_path(model_key))
        _cache[key] = sum(p for _, p in _mesh_nodes(gltf))
    return _cache[key]


def blanched_draws(model_key):
    """Draw calls a *decoloured* player model costs (§4.7 B3).

    core/mvstage.js blanchBody hides every l30_/l60_ layer instead of resolving
    one expression, because 白紙化した クリエメイト has no readable face. That is
    cheaper than any expression, so pricing this body with a facial table would
    over-charge the room by the size of one face -- 17 draws for the shipped B3.

    Over-charging is the safe direction for a budget, but it is still a wrong
    number, and §6.1.3's whole claim is that a room can be priced without a
    browser. A price that does not match what the browser draws is not that.
    """
    key = ("blanch", model_key)
    if key not in _cache:
        gltf = read_gltf(model_path(model_key))
        _cache[key] = sum(p for name, p in _mesh_nodes(gltf)
                          if name.lower()[:4] not in ("l30_", "l60_"))
    return _cache[key]


def visible_draws(model_key, facial_table=None):
    """Draw calls the model costs on screen.

    Without a facial table, every mesh is visible -- which is the case for enemy
    and weapon models: they have no l30_/l60_ layers, so applyFace never touches
    them. With one, the face layers are resolved the way core/actor.js does it.
    """
    key = ("vis", model_key, id(facial_table) if facial_table else None)
    if key in _cache:
        return _cache[key]
    gltf = read_gltf(model_path(model_key))
    nodes = _mesh_nodes(gltf)
    if not facial_table:
        _cache[key] = sum(p for _, p in nodes)
        return _cache[key]

    layers = facial_table.get("layers", [])
    states = facial_table.get("states", [])
    hide = set(facial_table.get("hide", []))
    # `default` is a state index when present. Falling back to state 0 matches
    # what an actor shows before anything sets an expression.
    which = facial_table.get("default", 0)
    state = states[which] if isinstance(which, int) and which < len(states) else (states[0] if states else [])
    wanted = {layers[i] for i in state if i < len(layers)}

    count = 0
    for name, prims in nodes:
        low = name.lower()
        if low[:4] in ("l30_", "l60_"):
            layer = name[4:]
            if layer in hide:
                continue
            if layer in layers and layer not in wanted:
                continue
        count += prims
    _cache[key] = count
    return count


def load_manifest():
    with io.open(os.path.join(MODELS, "manifest.json"), encoding="utf-8") as fh:
        return json.load(fh)


def facial_table_for(manifest, resource_id):
    """The facial table a player model uses, or None."""
    entry = manifest["models"].get("model/player/model_pl_%s.muast" % resource_id)
    if not entry or not entry.get("facial"):
        return None
    rel = entry["facial"].split("?")[0]
    path = os.path.join(ROOT, rel.replace("/", os.sep))
    if not os.path.exists(path):
        return None
    with io.open(path, encoding="utf-8") as fh:
        return json.load(fh)


def enemy_keys(manifest, animated=None):
    """Enemy model names, optionally filtered on whether they have animations."""
    out = []
    for key, entry in manifest["models"].items():
        if "/enemy/" not in key:
            continue
        if animated is not None and bool(entry.get("animations")) != animated:
            continue
        out.append(key.split("/")[-1].replace(".muast", ""))
    return sorted(out)


def enemy_costs(manifest, animated=None):
    """{model_key: draw calls} for every enemy model."""
    return {k: visible_draws(k) for k in enemy_keys(manifest, animated)}


if __name__ == "__main__":
    import statistics
    manifest = load_manifest()
    print("protagonists (model + weapon = total, vs 6.1.3):")
    for rid, wpn, measured in (("320005", "wpn_1100", 43),
                               ("320111", "wpn_1300", 48),
                               ("320801", "wpn_1100", 45)):
        table = facial_table_for(manifest, rid)
        vis = visible_draws("model_pl_%s" % rid, table)
        w = visible_draws(wpn)
        print("  %s  %2d + %d = %2d   measured %d  %s"
              % (rid, vis, w, vis + w, measured,
                 "ok" if vis + w == measured else "MISMATCH"))
    costs = enemy_costs(manifest, animated=True)
    vals = sorted(costs.values())
    print("\nanimated enemies (%d): min %d  median %d  mean %.1f  max %d"
          % (len(vals), vals[0], statistics.median(vals),
             sum(vals) / len(vals), vals[-1]))
    print("  <= 14 draws: %d of %d" % (sum(1 for v in vals if v <= 14), len(vals)))
