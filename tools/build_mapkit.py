#!/usr/bin/env python3
"""Export the questmap bundles into the roguelike map kit (T03, spec/02 §2).

    python tools/build_mapkit.py
    python tools/build_mapkit.py --kit 1011_2   # rebuild only one verified kit

Input  .cache/mapkit/questmap_*.muast   (7 bundles, spec/03 S2)
Output asset/img/rl/mapkit/<kit>/<unit>.glb.gz   one GLB per thing-unit
       asset/img/rl/mapkit/<kit>/<atlas>.webp    merged rgb+a atlas, q82
       asset/rl/mapkit.json                      one entry per unit

Structure measured 2026-09-02 (all 7 bundles, UnityPy):

  MeshRoot_QuestMapObj_<b>            identity transform
    QuestMapObj_<b>(Clone)            identity; carries the Animation
      QuestMapObj_<b>_<thing>         static: MeshFilter+MeshRenderer
                                      skinned: SkinnedMeshRenderer
      root_QuestMapObj_<b>_<unit>     rig root shared by a unit's skinned parts
      p_QuestMapObj_<b>_<fx>          particles -- skipped

A "kit" is (bundle, biome index).  The same index in two bundles is different
content -- 1018's biome 1 is an underwater reef (SeaAnemone, StarFish) while
1011's is grassland -- so the bare index cannot key a kit and kit ids read
"<bundle>_<index>" ("1011_0").  questmap_1030 carries exactly 1011's content
(thing names, mesh names, texture names and vertex data all identical), so
kits are deduped by content signature and 1030 exports nothing.

A "unit" is the placement atom: a static thing, or all skinned parts hanging
off one rig root (tree_trunk + tree_leaf_front/back share
root_QuestMapObj_0_tree and tear apart if split).  A thing's `_edge` outline
shell groups with it and is then dropped -- the shell mechanic is unusable and
game/rl/view/mapview.js says why; grouping still has to run because a skinned
body's unit name is resolved through it.  GLBs are material-less geometry with
the atlas as a sibling file: each kit samples one rgb+a atlas pair, everything
is UV-atlased, which is why the mapkit contract's single `texture` field is
enough per entry.

Nodes keep their original GameObject names and local transforms (vertices in
mesh space, X reflected, (c,b,a) winding, v inverted -- the
convert_kirafan_model.py conventions), so the per-biome @idle/@appear clips
and their Meige visibility tracks map onto the exported nodes by path without
remapping.
The one authored addition is the unit root node, which carries the
recentring translation (XZ centre -> origin, minY -> 0) so mapview can drop
a unit at any grid point; footprint is the XY card extent in that same space,
computed in bind pose for skinned parts.
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert_kirafan_model import (  # noqa: E402
    COMPONENT_FLOAT,
    COMPONENT_UNSIGNED_SHORT,
    COMPONENT_UNSIGNED_INT,
    TARGET_ARRAY_BUFFER,
    TARGET_ELEMENT_ARRAY_BUFFER,
    GlbBuilder,
    KirafanExporter,
    pptr_id,
    quat,
    vec3,
    matrix4,
)

# reconfigure, not a second TextIOWrapper: a stray wrapper gets GC-closed and
# takes the shared buffer with it, which kills any later print in importing code
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "mapkit"
OUT_DIR = ROOT / "asset" / "img" / "rl" / "mapkit"
OUT_JSON = ROOT / "asset" / "rl" / "mapkit.json"

BUNDLES = ["questmap_1011", "questmap_1015", "questmap_1018", "questmap_1029",
           "questmap_1030", "questmap_1047", "questmap_1075"]

# MeigeAnimClip visibility-track target type (same constant as the model
# exporter): the @appear clips switch things on/off through it.
TARGET_TYPE_VISIBILITY = 9

# Explicit source-audited assemblies, not a naming heuristic across all kits.
# Each tree is four sibling meshes with authored inter-layer TRS and idle
# curves. Recentring those meshes separately discards the assembled silhouette.
# Evidence: docs/original-map-asset-evidence.md and its JSON snapshot.
VERIFIED_COMPOSITES = {
    "1011_2": {f"tree{letter}": tuple(f"tree{letter}{i}" for i in range(1, 5))
               for letter in "ABC"}
}


# ---------------------------------------------------------------------------
# bundle reading


class Bundle:
    def __init__(self, path: Path) -> None:
        self.name = path.stem
        self.env = UnityPy.load(str(path))
        self.transforms = {item.path_id: item.read()
                           for item in self.env.objects if item.type.name == "Transform"}
        self.material_textures: dict[int, tuple[str, str]] = {}   # pid -> (rgb, a)
        for item in self.env.objects:
            if item.type.name != "Material":
                continue
            material = item.read()
            rgb_name = alpha_name = ""
            for key, entry in material.m_SavedProperties.m_TexEnvs:
                key_name = key if isinstance(key, str) else key.name
                if not entry.m_Texture:
                    continue
                try:
                    tex_name = entry.m_Texture.read().m_Name
                except Exception:
                    continue
                if key_name == "_Texture_Albedo":
                    rgb_name = tex_name
                elif key_name == "_Texture_AlbedoLayer":
                    alpha_name = tex_name
            self.material_textures[item.path_id] = (rgb_name, alpha_name)
        self.render_orders, self.hidden_meshes = self.read_render_orders()

    def read_render_orders(self) -> tuple[dict[str, int], set[str]]:
        """Flatten MsbHandler's three draw keys (stage, order, hierarchy) --
        the same packing as convert_kirafan_model.py, which documents why the
        stage must be honoured as authored."""
        orders: dict[str, int] = {}
        hidden: set[str] = set()
        for item in self.env.objects:
            if item.type.name != "MonoBehaviour":
                continue
            try:
                behaviour = item.read()
                if behaviour.m_Script.read().m_Name != "MsbHandler":
                    continue
                for entry in item.read_typetree().get("m_MsbObjectHandlerArray", []):
                    source = entry["m_Src"]
                    stage = int(source.get("m_eRenderStage") or 0)
                    orders[entry["m_Name"]] = (stage * 1000000
                                               + int(source["m_RenderOrder"]) * 1000
                                               + max(0, int(entry.get("m_HieIndex", 0))))
                    if source.get("m_bVisibility") in (0, False):
                        hidden.add(entry["m_Name"])
            except Exception:
                continue
        return orders, hidden

    def name_of(self, transform: Any) -> str:
        return transform.m_GameObject.read().m_Name


# ---------------------------------------------------------------------------
# mesh primitive (convert_kirafan_model.py conventions, material-less)

# Mirror-fallback thresholds (fractions of the atlas footprint's pixels with
# alpha > 128): the authored footprint must be essentially empty -- the mesh
# would draw nothing at all -- before the mirrored one is taken instead, and
# the mirror must carry real art rather than a few pixels of a neighbour.
DEAD_MAX = 0.05
MIRROR_MIN = 0.10


def uv_footprint(uvs: np.ndarray, alpha: np.ndarray,
                 mirrored: bool = False) -> tuple[float, int]:
    """(opaque fraction, opaque pixel count) of the atlas under the mesh's UV
    bounding box.

    Unity uv v counts up from the texture's bottom and UnityPy hands the
    texture back top-down, so a mesh's art sits at atlas rows
    (1 - v) * H -- the authored footprint. `mirrored` measures rows v * H
    instead, which is where the footprint lands if the v axis is inverted.
    """
    height, width = alpha.shape
    u0, u1 = uvs[:, 0].min(), uvs[:, 0].max()
    v0, v1 = uvs[:, 1].min(), uvs[:, 1].max()
    if mirrored:
        top, bottom = v0 * height, v1 * height
    else:
        top, bottom = (1.0 - v1) * height, (1.0 - v0) * height
    x0, x1 = max(0, int(u0 * width)), min(width, int(u1 * width) + 1)
    y0, y1 = max(0, int(top)), min(height, int(bottom) + 1)
    if x1 <= x0 or y1 <= y0:
        return 0.0, 0
    region = alpha[y0:y1, x0:x1]
    opaque = int((region > 128).sum())
    return opaque / region.size, opaque


def choose_uv_mirror(uvs: np.ndarray, alpha: np.ndarray) -> tuple[bool, int, bool]:
    """Does this mesh need its v axis inverted?  Almost never (measured
    2026-09-02, all 7 bundles).

    There is exactly ONE v-convention in the data: every kit paints all its
    things with a single material (1018_0: 29 things share
    m_QuestMapObj_0_icon01), every _Texture_Albedo entry in all 7 bundles has
    m_Scale (1,1) and m_Offset (0,0), so the game's shader samples every mesh
    the same way and no mesh can be authored differently. Drawing all 1629
    meshes' UV boxes onto their atlas confirms it: under the authored
    convention every box bounds exactly one sprite; under the mirror nothing
    lines up (.cache/uv_boxes.py -- this used to be a per-mesh guess whose
    default was the mirror, which is how volume 1 came to render Base_Edge's
    cream cat-face sheet in place of Build's blue houses).

    1524 of the 1629 meshes carry real art under the authored convention and
    63 carry none in either. The remaining 42 -- 1029's hikari_* glows,
    1075's rebon_* ribbons and sibuki* splashes, 1075_3's crab parts,
    1011_2's flower3/flower4 -- have an empty authored footprint and real art
    in the mirror, which is what a runtime-animated UV track looks like from
    the outside. Nothing in the bundles says where those meshes' art is, so
    they take the mirror: it can only fire where the mesh would otherwise
    draw nothing, and a card in the wrong place is still less wrong than a
    hole in the crab.

    Returns (mirror, passable pixels under the chosen orientation, dead in
    both) -- the caller drops a unit whose every mesh is dead, since nothing
    in its footprint survives the alphaTest 0.5 material.
    """
    cov, passable = uv_footprint(uvs, alpha)
    if cov >= DEAD_MAX:
        return False, passable, False
    mirror_cov, mirror_pass = uv_footprint(uvs, alpha, mirrored=True)
    if mirror_cov >= MIRROR_MIN:
        return True, mirror_pass, False
    # neither orientation carries real art (a stray few pixels of a
    # neighbouring sprite don't count -- 1075_7's flower_4 sits next to real
    # art and still renders as nothing)
    return False, passable, passable == 0 and mirror_cov < MIRROR_MIN


def add_mesh_primitive(builder: GlbBuilder, mesh: Any, skinned: bool,
                       atlas_alpha: np.ndarray | None = None) -> dict | None:
    handler = MeshHandler(mesh)
    handler.process()
    if not handler.m_Vertices:
        return None
    positions = np.asarray([(-x, y, z) for x, y, z in handler.m_Vertices], dtype=np.float32)
    attributes: dict[str, Any] = {
        "POSITION": builder.add_accessor(positions, COMPONENT_FLOAT, "VEC3",
                                         TARGET_ARRAY_BUFFER, True)
    }
    if handler.m_Normals:
        normals = np.asarray([(-x, y, z) for x, y, z in handler.m_Normals], dtype=np.float32)
        attributes["NORMAL"] = builder.add_accessor(normals, COMPONENT_FLOAT, "VEC3",
                                                    TARGET_ARRAY_BUFFER)
    mirror_v = False
    uv_dead = False
    uv_passable = 0
    if handler.m_UV0:
        raw_uvs = np.asarray(handler.m_UV0, dtype=np.float32)
        if atlas_alpha is not None:
            mirror_v, uv_passable, uv_dead = choose_uv_mirror(raw_uvs, atlas_alpha)
        # glTF puts uv (0,0) at the texture's top-left and Unity at its
        # bottom-left, so v inverts on the way out -- the same one-liner
        # convert_kirafan_model.py uses for characters. mapview then loads the
        # atlas with flipY off, since the atlas is a sibling file and not a
        # glTF texture (GLTFLoader would have done that for an embedded one).
        uvs = (raw_uvs if mirror_v
               else np.stack([raw_uvs[:, 0], 1.0 - raw_uvs[:, 1]],
                             axis=1).astype(np.float32))
        attributes["TEXCOORD_0"] = builder.add_accessor(uvs, COMPONENT_FLOAT, "VEC2",
                                                        TARGET_ARRAY_BUFFER)
    joints_raw = None
    weights_raw = None
    if skinned:
        joints_raw = np.asarray(handler.m_BoneIndices, dtype=np.int64)
        weights_raw = np.asarray(handler.m_BoneWeights, dtype=np.float32)
        attributes["JOINTS_0"] = builder.add_accessor(
            joints_raw.astype(np.uint16), COMPONENT_UNSIGNED_SHORT, "VEC4",
            TARGET_ARRAY_BUFFER)
        attributes["WEIGHTS_0"] = builder.add_accessor(
            weights_raw, COMPONENT_FLOAT, "VEC4", TARGET_ARRAY_BUFFER)

    triangles = handler.get_triangles()[0]
    index_dtype = np.uint16 if len(positions) <= 65535 else np.uint32
    index_component = (COMPONENT_UNSIGNED_SHORT if index_dtype == np.uint16
                       else COMPONENT_UNSIGNED_INT)
    indices = np.asarray([(c, b, a) for a, b, c in triangles], dtype=index_dtype).reshape(-1)
    return {
        "attributes": attributes,
        "indices": builder.add_accessor(indices, index_component, "SCALAR",
                                        TARGET_ELEMENT_ARRAY_BUFFER),
        # raw arrays for the caller (bbox pass); stripped before the GLB write
        "_positions": positions,
        "_joints_raw": joints_raw,
        "_weights_raw": weights_raw,
        "_mesh_name": mesh.m_Name,
        "_uv_mirrored": mirror_v if handler.m_UV0 else None,
        "_uv_dead": uv_dead,
    }


# ---------------------------------------------------------------------------
# unit assembly


def trs_matrix(translation: list[float], rotation: list[float],
               scale: list[float]) -> np.ndarray:
    """Column-vector TRS matrix from glTF node values."""
    t = np.array(translation, dtype=np.float64)
    x, y, z, w = np.array(rotation, dtype=np.float64)
    n = np.sqrt(x * x + y * y + z * z + w * w)
    if n:
        x, y, z, w = x / n, y / n, z / n, w / n
    s = np.array(scale, dtype=np.float64)
    rot = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ], dtype=np.float64)
    m = np.eye(4)
    m[:3, :3] = rot * s[np.newaxis, :]
    m[:3, 3] = t
    return m


class UnitExport:
    """One placement atom: builds its own GLB with a recentring root node."""

    def __init__(self, name: str, bundle: Bundle,
                 scale_fix: dict[str, list[float]] | None = None,
                 pose: dict[str, dict] | None = None) -> None:
        self.bundle = bundle
        self.name = name
        self.scale_fix = scale_fix or {}
        self.pose = pose or {}
        self.builder = GlbBuilder()
        # node 0: the unit root; its translation is the recentring offset,
        # filled in once the bbox is known
        self.builder.document["nodes"].append({"name": name})
        self.builder.document["scenes"][0]["nodes"] = [0]
        self.path_map: dict[str, int] = {}      # (Clone)-relative path -> node
        self.node_local: dict[int, np.ndarray] = {}
        self.node_parent: dict[int, int] = {}
        self.node_local[0] = np.eye(4)
        self.node_parent[0] = None
        self.mesh_world: list[tuple[np.ndarray, np.ndarray]] = []  # (M, V)
        self.node_names: set[str] = set()
        self.has_skin = False

    def add_node(self, transform: Any, parent: int, path: str,
                 payload: dict | None = None, skin: dict | None = None) -> int:
        document = self.builder.document
        go_name = self.bundle.name_of(transform)
        scale = vec3(transform.m_LocalScale)
        override = self.scale_fix.get(path)
        if override is not None:
            # the serialized scale is the editor's dormant value and the clip
            # is the runtime truth: the game plays idle constantly, and
            # animation overrides TRS (see clip_scale_overrides). Covered
            # paths take the clip value wholesale.
            scale = override
        node: dict[str, Any] = {
            "name": go_name,
            "translation": vec3(transform.m_LocalPosition, reflect_x=True),
            "rotation": quat(transform.m_LocalRotation),
            "scale": scale,
        }
        # Verified multi-part cards use one coherent authored idle pose for
        # baking AND bounds. Mixing editor position with idle scale can pull
        # canopy layers apart and makes an animated clone float above its foot.
        node.update(self.pose.get(path, {}))
        if payload is not None:
            primitive = {"attributes": payload["attributes"],
                         "indices": payload["indices"]}
            document["meshes"].append({"name": payload["_mesh_name"],
                                       "primitives": [primitive]})
            node["mesh"] = len(document["meshes"]) - 1
            node["extras"] = {"renderOrder": self.bundle.render_orders.get(
                payload["_mesh_name"], 0)}
            if payload["_mesh_name"] in self.bundle.hidden_meshes:
                node["extras"]["msbVisible"] = False
        if skin is not None:
            node["skin"] = skin
            self.has_skin = True
        document["nodes"].append(node)
        index = len(document["nodes"]) - 1
        document["nodes"][parent].setdefault("children", []).append(index)
        self.path_map[path] = index
        self.node_local[index] = trs_matrix(node["translation"], node["rotation"],
                                            node["scale"])
        self.node_parent[index] = parent
        self.node_names.add(go_name)
        return index

    def node_world(self, index: int) -> np.ndarray:
        chain: list[int] = []
        current: int | None = index
        while current is not None:
            chain.append(current)
            current = self.node_parent.get(current)
        world = np.eye(4)
        for node_index in reversed(chain):
            world = world @ self.node_local[node_index]
        return world

    def record_static(self, node_index: int, positions: np.ndarray) -> None:
        self.mesh_world.append((self.node_world(node_index),
                                positions.astype(np.float64)))

    def record_skinned(self, positions: np.ndarray, joints: list[int],
                       inverse: np.ndarray, joint_ids: np.ndarray,
                       weights: np.ndarray) -> None:
        """Bind-pose skinning for the bbox: v' = sum(w_i * B_i @ I_i @ v)."""
        bone_world = np.stack([self.node_world(j) for j in joints])
        ba = bone_world @ inverse
        mats = ba[joint_ids]                                    # (N,4,4,4)
        w = weights[:, :, np.newaxis, np.newaxis].astype(np.float64)
        combined = (w * mats).sum(axis=1)                       # (N,4,4)
        verts = np.concatenate([positions.astype(np.float64),
                                np.ones((len(positions), 1))], axis=1)
        skinned = np.einsum("nij,nj->ni", combined, verts)
        self.mesh_world.append((np.eye(4), skinned[:, :3]))

    def finish(self, out_path: Path) -> dict[str, Any] | None:
        if not self.mesh_world:
            return None
        all_points = []
        for world, positions in self.mesh_world:
            verts = np.concatenate([positions, np.ones((len(positions), 1))], axis=1)
            all_points.append((world @ verts.T).T[:, :3])
        points = np.concatenate(all_points)
        mins, maxs = points.min(axis=0), points.max(axis=0)
        centre = (mins + maxs) / 2
        root = self.builder.document["nodes"][0]
        root["translation"] = [round(-centre[0], 4), round(-mins[1], 4),
                               round(-centre[2], 4)]
        self.builder.write(out_path)
        payload = out_path.read_bytes()
        out_path.unlink()
        # gzip.GzipFile with mtime=0 keeps the output byte-identical across
        # runs (what the same-seed-same-bytes discipline expects of assets)
        with open(str(out_path) + ".gz", "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as handle:
                handle.write(payload)
        # QuestMap things are 2.5D cards: flat quads in the XY plane facing
        # the fixed camera azimuth (measured across all 7 bundles -- only
        # 1015's stage eff_* backdrops have real Z depth). A ground footprint
        # in XZ would be ~0 for every card, so the placement-relevant pair is
        # [screen width, card height].
        return {
            "footprint": [round(maxs[0] - mins[0], 1), round(maxs[1] - mins[1], 1)],
        }


# ---------------------------------------------------------------------------
# clip conversion (position/rotation/scale channels + Meige visibility)


def convert_curve_vec3(value: dict[str, float]) -> list[float]:
    return [-float(value["x"]), float(value["y"]), float(value["z"])]


def convert_curve_quat(value: dict[str, float], normalize: bool = False) -> list[float]:
    result = [float(value["x"]), -float(value["y"]), -float(value["z"]), float(value["w"])]
    if normalize:
        length = np.sqrt(sum(c * c for c in result))
        if length:
            result = [c / length for c in result]
    return result


def add_clip_channels(builder: GlbBuilder, animation: dict, clip: dict,
                      path_map: dict[str, int]) -> int:
    """Add channels whose (Clone)-relative path hits this export's nodes.

    Returns the count of channels that actually vary. Constant channels are
    still exported -- a clip's authored pose can differ from the bind TRS, and
    playing the clip in-game sits the node at that pose -- but they are not
    animation: nearly every static thing's "idle" clip is just its bind pose
    restated, and counting those made every entry classify as animated.
    """
    varying = 0
    for curves, target_path, width in (
        (clip["m_PositionCurves"], "translation", 3),
        (clip["m_RotationCurves"], "rotation", 4),
        (clip["m_ScaleCurves"], "scale", 3),
    ):
        for entry in curves:
            node = path_map.get(entry["path"])
            keys = entry["curve"]["m_Curve"]
            if node is None or not keys:
                continue
            values = {tuple(key["value"].values()) for key in keys}
            if len(values) == 1:
                convert = (convert_curve_quat if width == 4
                           else convert_curve_vec3 if target_path == "translation"
                           else lambda v: [float(v[k]) for k in ("x", "y", "z")])
                single = (convert(keys[0]["value"], True) if width == 4
                          else convert(keys[0]["value"]))
                input_accessor = builder.add_accessor(
                    np.asarray([keys[0]["time"]], dtype=np.float32),
                    COMPONENT_FLOAT, "SCALAR", include_bounds=True)
                output_accessor = builder.add_accessor(
                    np.asarray([single], dtype=np.float32), COMPONENT_FLOAT, f"VEC{width}")
                animation["samplers"].append({"input": input_accessor,
                                              "output": output_accessor,
                                              "interpolation": "LINEAR"})
                animation["channels"].append(
                    {"sampler": len(animation["samplers"]) - 1,
                     "target": {"node": node, "path": target_path}})
                continue
            times = np.asarray([key["time"] for key in keys], dtype=np.float32)
            output: list[list[float]] = []
            for key in keys:
                if width == 4:
                    output.extend([convert_curve_quat(key["inSlope"]),
                                   convert_curve_quat(key["value"], True),
                                   convert_curve_quat(key["outSlope"])])
                else:
                    convert = (convert_curve_vec3 if target_path == "translation"
                               else lambda v: [float(v[k]) for k in ("x", "y", "z")])
                    output.extend([convert(key["inSlope"]), convert(key["value"]),
                                   convert(key["outSlope"])])
            input_accessor = builder.add_accessor(times, COMPONENT_FLOAT, "SCALAR",
                                                  include_bounds=True)
            output_accessor = builder.add_accessor(
                np.asarray(output, dtype=np.float32), COMPONENT_FLOAT, f"VEC{width}")
            animation["samplers"].append(
                {"input": input_accessor, "output": output_accessor,
                 "interpolation": "CUBICSPLINE"})
            animation["channels"].append(
                {"sampler": len(animation["samplers"]) - 1,
                 "target": {"node": node, "path": target_path}})
            varying += 1
    return varying


def load_visibility_tracks(clip: dict) -> dict[str, Any]:
    """{node name: 0 | 1 | [[frame, value], ...]} from a clip's Meige handlers."""
    tracks: dict[str, Any] = {}
    meige = clip.get("m_MeigeAnimClip")
    if not isinstance(meige, dict):
        return tracks
    for handler in meige.get("m_AnimNodeHandlerArray") or []:
        target = handler.get("m_Target") or {}
        if target.get("m_TargetType") != TARGET_TYPE_VISIBILITY:
            continue
        name = str(target.get("m_TargetName") or "")
        if not name:
            continue
        keys: list[list[float]] = []
        for curve in handler.get("m_Curves") or []:
            for component in curve.get("m_ComponentCurves") or []:
                for key in component.get("m_KeyDatas") or []:
                    keys.append([round(float(key["m_Frame"]), 3),
                                 1 if float(key["m_Value"]) >= 0.5 else 0])
        if not keys:
            continue
        keys.sort(key=lambda item: item[0])
        values = {value for _, value in keys}
        tracks[name] = keys[0][1] if len(values) == 1 else keys
    return tracks


# ---------------------------------------------------------------------------
# categories (placement rules for mapview; floors.json can override per room)


WATER_NAMES = re.compile(r"river|splash|water|sea|lake|pond|falls?$", re.I)
FLOOR_NAMES = re.compile(
    r"^(?:ground|base|carpet|grade|road|path|sand|snow|floor|area)$", re.I)
WALL_NAMES = re.compile(r"wall|fence|cliff|gate|piller|pillar|bridge", re.I)


def clip_scale_overrides(clips: dict[str, dict]) -> dict[str, list[float]]:
    """Real scales for nodes serialized at ~0 scale, from the idle/appear clips.

    1029/1047/1075 author mesh nodes with local scale 1e-12 (the editor's
    dormant state) and restore the real size through the clip's ScaleCurves --
    the game plays the clip, so it never sees the ~0. A GLB exported from the
    raw TRS would collapse those cards to a point for both the bbox and the
    bind pose, so the clip's values (per component, the largest magnitude any
    key reaches -- placement must fit the wave at its widest) become the node
    scale instead. Scale curves are not X-reflected (only translation is).
    """
    overrides: dict[str, list[float]] = {}
    for clip_name in ("idle", "appear"):
        clip = clips.get(clip_name)
        if clip is None:
            continue
        for entry in clip["m_ScaleCurves"]:
            keys = entry["curve"]["m_Curve"]
            if not keys:
                continue
            best = [0.0, 0.0, 0.0]
            for key in keys:
                value = key["value"]
                for i, axis in enumerate(("x", "y", "z")):
                    if abs(float(value[axis])) > abs(best[i]):
                        best[i] = float(value[axis])
            overrides.setdefault(entry["path"], best)
    return overrides


def classify(name: str, animated: bool) -> str:
    if animated:
        return "animated"
    if WATER_NAMES.search(name):
        return "water"
    if FLOOR_NAMES.match(name):
        return "floor"
    if WALL_NAMES.search(name):
        return "wall"
    return "prop"


def idle_pose(clip: dict | None) -> dict[str, dict]:
    """The first authored idle pose, using the same conversions as the clip.

    Used only by source-audited composites. All curves must begin at zero:
    silently substituting a later sample would not be a coherent pose.
    """
    if clip is None:
        return {}
    result: dict[str, dict] = {}
    for curves, target in (("m_PositionCurves", "translation"),
                            ("m_RotationCurves", "rotation"),
                            ("m_ScaleCurves", "scale")):
        for entry in clip[curves]:
            keys = entry["curve"]["m_Curve"]
            if not keys or abs(float(keys[0]["time"])) > 1e-6:
                continue
            value = keys[0]["value"]
            converted = (convert_curve_quat(value, True) if target == "rotation"
                         else convert_curve_vec3(value) if target == "translation"
                         else [float(value[k]) for k in ("x", "y", "z")])
            result.setdefault(entry["path"], {})[target] = converted
    return result


# ---------------------------------------------------------------------------
# path helpers


def path_of(bundle: Bundle, transform: Any, clone_id: int) -> str:
    """(Clone)-relative path: 'QuestMapObj_b_thing' or 'root_.../bone'."""
    names: list[str] = []
    current = transform
    while current is not None:
        if current.object_reader.path_id == clone_id:
            break
        names.append(bundle.name_of(current))
        current = bundle.transforms.get(pptr_id(current.m_Father))
    return "/".join(reversed(names))


def ensure_node(export: UnitExport, bundle: Bundle, transform: Any,
                clone_id: int) -> int:
    """Node for a transform, adding missing ancestors up to the unit root."""
    path = path_of(bundle, transform, clone_id)
    if not path:
        return 0
    if path in export.path_map:
        return export.path_map[path]
    father = bundle.transforms.get(pptr_id(transform.m_Father))
    parent = ensure_node(export, bundle, father, clone_id) if father is not None else 0
    return export.add_node(transform, parent, path)


def rig_key_of(bundle: Bundle, root_bone: Any, prefix: str) -> str | None:
    """Rig key for a skinned part's root bone. Usually the bone IS the rig
    root (root_<prefix>_<unit>), but 1015's biomes 3+ bind to a j_*_rotate
    joint nested inside it -- so walk ancestors until a root_ name appears."""
    current = root_bone
    while current is not None:
        name = bundle.name_of(current)
        if name.startswith(f"root_{prefix}_"):
            return name[len(f"root_{prefix}_"):]
        current = bundle.transforms.get(pptr_id(current.m_Father))
    return None


# ---------------------------------------------------------------------------
# per-kit build


def build_kit(bundle: Bundle, biome: int,
              output_dir: Path | None = None) -> tuple[dict, list[dict], set] | None:
    """(kit record, entries, content signature) or None if nothing to export."""
    prefix = f"QuestMapObj_{biome}"
    mesh_root = next((t for t in bundle.transforms.values()
                      if bundle.name_of(t) == f"MeshRoot_{prefix}"), None)
    if mesh_root is None:
        return None
    clone = None
    for child in mesh_root.m_Children:
        name = bundle.name_of(bundle.transforms[pptr_id(child)])
        if name.startswith(prefix) and "(" in name:
            clone = bundle.transforms[pptr_id(child)]
            break
    if clone is None:
        return None
    clone_id = clone.object_reader.path_id

    # -- things and rig roots under the (Clone) --------------------------------
    # Both can nest: 1015's rig roots sit under loc_QuestMapObj_<b> placement
    # nodes, and its biome 0/12 effect meshes sit two loc_ levels deep. Walk
    # the whole clone subtree for both (p_* / ptcl:* particle rigs stay
    # skipped, per the fx convention); their loc_ ancestors are preserved at
    # export time through ensure_node, so authored placement survives.
    things: dict[str, dict[str, Any]] = {}
    rigs: dict[str, Any] = {}
    stack = list(reversed(list(clone.m_Children)))  # depth-first, sibling order
    while stack:
        child_t = bundle.transforms.get(pptr_id(stack.pop()))
        if child_t is None:
            continue
        name = bundle.name_of(child_t)
        if name.startswith(("p_", "ptcl:")):
            continue
        if name.startswith(f"root_{prefix}_"):
            rigs.setdefault(name[len(f"root_{prefix}_"):], child_t)
        if name.startswith(f"{prefix}_"):
            go = child_t.m_GameObject.read()
            info: dict[str, Any] = {"transform": child_t, "mesh": None,
                                    "materials": [], "skinned": False,
                                    "root_bone": None, "renderer": None,
                                    "collider": False}
            for comp in go.m_Component:
                try:
                    component = comp.component.read()
                except Exception:
                    continue
                type_name = type(component).__name__
                if type_name == "MeshFilter" and component.m_Mesh:
                    info["mesh"] = component.m_Mesh.read()
                if type_name == "SkinnedMeshRenderer":
                    info["skinned"] = True
                    info["renderer"] = component
                    if component.m_Mesh:
                        info["mesh"] = component.m_Mesh.read()
                    if component.m_RootBone:
                        info["root_bone"] = component.m_RootBone.read()
                if type_name == "MeshRenderer":
                    info["renderer"] = component
                if type_name in ("MeshRenderer", "SkinnedMeshRenderer"):
                    info["materials"] = [pptr_id(mm) for mm in component.m_Materials]
                if type_name == "MeshCollider":
                    info["collider"] = True
            if info["mesh"] is not None:
                things[name[len(f"{prefix}_"):]] = info
        stack.extend(reversed(list(child_t.m_Children)))
    if not things:
        return None

    kit_id = f"{bundle.name.split('_')[1]}_{biome}"
    composites = VERIFIED_COMPOSITES.get(kit_id, {})
    composite_of = {}
    for unit, parts in composites.items():
        if any(part not in things for part in parts):
            raise ValueError(f"{kit_id}/{unit}: verified assembly is incomplete")
        if any(things[part]["skinned"] for part in parts):
            raise ValueError(f"{kit_id}/{unit}: verified static assembly changed")
        parents = {pptr_id(things[part]["transform"].m_Father) for part in parts}
        materials = {tuple(things[part]["materials"]) for part in parts}
        if len(parents) != 1 or len(materials) != 1:
            raise ValueError(f"{kit_id}/{unit}: source hierarchy/materials changed")
        composite_of.update({part: unit for part in parts})

    # -- unit grouping ----------------------------------------------------------
    # An _edge shell joins its body's unit when the body exists in this kit;
    # skinned parts join the unit named by their rig root. A skinned _edge
    # whose body is static joins the body's unit too (same rig falls out of
    # the root-bone lookup below only if the shell itself is skinned, so the
    # body check runs first).
    shell_meshes = [0]
    unit_of: dict[str, str] = {}

    units: dict[str, list[str]] = {}
    for thing, info in things.items():
        if thing.endswith("_edge") and thing[:-5] in things:
            unit = unit_of.get(thing[:-5], thing[:-5])
        elif info["skinned"] and info["root_bone"] is not None:
            unit = rig_key_of(bundle, info["root_bone"], prefix) or thing
        else:
            unit = composite_of.get(thing, thing)
        unit_of[thing] = unit
        units.setdefault(unit, []).append(thing)

    # ...and then it is dropped, because the outline mechanic is unusable: the
    # reasons are written out in game/rl/view/mapview.js, and that file excludes
    # the sibling `X_Edge` UNITS 1018_* ships by name. 1011_*/1047_*/1075_* hang
    # `X_edge` UNDER the body instead (1011_0 hangs tree_leaf_edge under the rig),
    # where no downstream name filter can reach it -- 1011_4's chair.glb.gz
    # shipped a flat green silhouette of the chair on top of the chair, and 66 of
    # 1548 units carried one. Grouping still runs first: the shell is how a
    # skinned body's unit name is resolved.
    for thing in [t for t, u in unit_of.items()
                  if t != u and t.lower().endswith("_edge")]:
        units[unit_of[thing]].remove(thing)
        del unit_of[thing]
        del things[thing]
        shell_meshes[0] += 1
    units = {unit: parts for unit, parts in units.items() if parts}
    if not things:
        return None

    # -- clips -------------------------------------------------------------------
    clips: dict[str, dict] = {}
    for item in bundle.env.objects:
        if item.type.name != "AnimationClip":
            continue
        tree = item.read_typetree()
        match = re.match(rf"^{prefix}@(idle|appear)$", tree["m_Name"])
        if match:
            clips[match.group(1)] = tree

    kit_dir = (output_dir or OUT_DIR) / kit_id
    kit_dir.mkdir(parents=True, exist_ok=True)

    # -- atlas: every mesh samples one rgb+a pair; merge to RGBA WebP -----------
    textures = {item.read().m_Name: item.read()
                for item in bundle.env.objects if item.type.name == "Texture2D"}
    atlas_files: dict[tuple[str, str], str] = {}
    # alpha channel of each assembled atlas, for choose_uv_mirror: the atlas
    # is the only ground truth for where a mesh's art actually is
    atlas_alpha: dict[str, np.ndarray] = {}
    for info in things.values():
        for material_id in info["materials"]:
            rgb, alpha = bundle.material_textures.get(material_id, ("", ""))
            if not rgb or (rgb, alpha) in atlas_files:
                continue
            image = textures[rgb].image.convert("RGB")
            if alpha:
                image.putalpha(KirafanExporter.fit_alpha(
                    textures[alpha].image.getchannel("A"), image.size))
            else:
                image.putalpha(255)
            filename = re.sub(r"\s+", "_", f"{re.sub(r'_rgb$', '', rgb)}.webp")
            buffer = io.BytesIO()
            image.save(buffer, format="WEBP", quality=82)
            (kit_dir / filename).write_bytes(buffer.getvalue())
            atlas_files[(rgb, alpha)] = filename
            # measure what the game will actually sample: WEBP quality 82 is
            # lossy on alpha too, and borderline pixels (~129) that the PIL
            # image keeps can fall under the alphaTest 0.5 cut once encoded
            # (4 stray pixels kept 1075_7's flower_4 -- an unused atlas slot
            # -- from being dropped as dead). Test the re-decoded atlas.
            atlas_alpha[filename] = np.asarray(Image.open(buffer).convert("RGBA"))[:, :, 3]
    if not atlas_files:
        return None
    # a unit's texture is the atlas its body samples (edges share it)
    unit_texture: dict[str, str] = {}
    for thing, info in things.items():
        for material_id in info["materials"]:
            pair = bundle.material_textures.get(material_id, ("", ""))
            if pair in atlas_files:
                unit_texture.setdefault(unit_of[thing], atlas_files[pair])
                break

    def thing_atlas_alpha(info: dict[str, Any]) -> np.ndarray | None:
        for material_id in info["materials"]:
            pair = bundle.material_textures.get(material_id, ("", ""))
            if pair in atlas_files:
                return atlas_alpha[atlas_files[pair]]
        return None

    # -- per-unit GLBs -------------------------------------------------------------
    entries: list[dict[str, Any]] = []
    signature: set[tuple[str, str]] = set()
    scale_fix = clip_scale_overrides(clips)
    mirrored_meshes = 0
    dropped_units: list[str] = []
    for unit in sorted(units):
        pose = idle_pose(clips.get("idle")) if unit in composites else None
        if unit in composites and any(
                path_of(bundle, things[part]["transform"], clone_id) not in (pose or {})
                for part in composites[unit]):
            raise ValueError(f"{kit_id}/{unit}: missing authored idle pose")
        export = UnitExport(unit, bundle, scale_fix, pose)
        idle_channels = 0
        payload_count = 0
        dead_count = 0

        for thing in sorted(units[unit]):
            info = things[thing]
            payload = add_mesh_primitive(export.builder, info["mesh"], info["skinned"],
                                         thing_atlas_alpha(info))
            if payload is None:
                continue
            payload_count += 1
            if payload.get("_uv_mirrored"):
                mirrored_meshes += 1
            if payload.get("_uv_dead"):
                dead_count += 1
            # clone-relative path + ancestors preserved: nested things (1015's
            # loc_ placement nodes) keep their authored TRS inside the unit
            path = path_of(bundle, info["transform"], clone_id)
            father = bundle.transforms.get(pptr_id(info["transform"].m_Father))
            parent = (ensure_node(export, bundle, father, clone_id)
                      if father is not None else 0)

            if info["skinned"] and info["root_bone"] is not None:
                rig_key = rig_key_of(bundle, info["root_bone"], prefix)
                rig_transform = rigs.get(rig_key) if rig_key else None
                if rig_transform is None:
                    continue        # no rig to bind to: skip, not guess
                # ensure_node adds the rig's ancestors too (1015 nests rigs
                # under loc_QuestMapObj_<b> placement nodes) so the rig keeps
                # its authored position relative to the thing nodes
                rig_root_node = ensure_node(export, bundle, rig_transform, clone_id)

                renderer = info["renderer"]
                joints = [ensure_node(export, bundle,
                                      bundle.transforms[pptr_id(bone)], clone_id)
                          for bone in renderer.m_Bones]
                inverse = np.asarray([matrix4(bp) for bp in info["mesh"].m_BindPose],
                                     dtype=np.float64)
                bind_accessor = export.builder.add_accessor(
                    np.asarray([m.T.reshape(-1) for m in inverse], dtype=np.float32),
                    COMPONENT_FLOAT, "MAT4")
                # glTF wants node.skin to be an index into document.skins;
                # the dict itself must be registered, not inlined
                export.builder.document["skins"].append({
                    "joints": joints, "inverseBindMatrices": bind_accessor,
                    "skeleton": rig_root_node})
                node = export.add_node(info["transform"], parent, path, payload,
                                       len(export.builder.document["skins"]) - 1)
                export.record_skinned(payload["_positions"], joints, inverse,
                                      payload["_joints_raw"], payload["_weights_raw"])
            else:
                node = export.add_node(info["transform"], parent, path, payload)
                export.record_static(node, payload["_positions"])

        # every mesh's atlas footprint is empty in both orientations: no
        # pixel survives the alphaTest 0.5 material, so the unit can only
        # ever render as nothing. Drop it rather than ship an invisible card
        # (21 units across 1047/1075/1011 measured 2026-09-02 -- unused
        # atlas slots the map author never drew art for).
        if payload_count and dead_count == payload_count:
            dropped_units.append(unit)
            continue

        # animations: only the channels that address this unit's nodes
        for clip_name in ("idle", "appear"):
            clip = clips.get(clip_name)
            if clip is None:
                continue
            animation = {"name": clip_name, "samplers": [], "channels": []}
            added = add_clip_channels(export.builder, animation, clip, export.path_map)
            if animation["channels"]:
                export.builder.document["animations"].append(animation)
                if clip_name == "idle":
                    idle_channels += added
        appear = clips.get("appear")
        if appear is not None:
            kept = {name: value for name, value in load_visibility_tracks(appear).items()
                    if name in export.node_names}
            if kept:
                extras = export.builder.document["asset"].setdefault("extras", {})
                extras["visibility"] = {
                    "source": "MeigeAnimClip target type 9; keys are stepped, "
                              "hold the last key",
                    "clip": "appear",
                    "tracks": kept,
                }

        bounds = export.finish(kit_dir / f"{unit}.glb")
        if bounds is None:
            continue
        animated = export.has_skin or idle_channels > 0
        entry = {
            "biome": kit_id,
            "name": unit,
            "category": classify(unit, animated),
            "file": f"{unit}.glb.gz",
            "texture": unit_texture.get(unit, next(iter(atlas_files.values()))),
            "footprint": bounds["footprint"],
        }
        if any(things[t]["collider"] for t in units[unit]):
            entry["collider"] = True
        if unit in composites:
            entry["sourceParts"] = list(composites[unit])
            entry["pose"] = "idle:0"
        entries.append(entry)
        # signature includes the texture: 1015's biomes 3-11 share one line
        # mesh but recolour it per biome, and geometry alone cannot tell a
        # recolour kit from a true duplicate (which is what caught 1030)
        for thing in units[unit]:
            signature.add((thing, things[thing]["mesh"].m_Name,
                           unit_texture.get(unit, "")))

    kit = {"biome": kit_id, "bundle": bundle.name, "index": biome,
           "atlas": sorted(set(atlas_files.values())), "units": len(entries),
           "uvMirrored": mirrored_meshes, "shells": shell_meshes[0],
           "dropped": dropped_units}
    if not entries:
        # nothing survived export (e.g. every thing is an unbindable skinned
        # part): the kit must not be registered, and its empty content
        # signature must not dedupe a later kit out of existence
        shutil.rmtree(kit_dir, ignore_errors=True)
        return None
    return kit, entries, signature


# ---------------------------------------------------------------------------


def rebuild_selected(kit_ids: list[str]) -> None:
    """Stage selected kits without deleting/rebuilding unrelated assets.

    The manifest is published last. Old, now-unreferenced unit files are left
    intact so an already-open page can still finish loading its old manifest.
    """
    selected = {}
    for kit_id in kit_ids:
        match = re.fullmatch(r"(\d+)_(\d+)", kit_id)
        if match is None or f"questmap_{match[1]}" not in BUNDLES:
            raise ValueError(f"unknown map kit: {kit_id}")
        selected[kit_id] = (f"questmap_{match[1]}", int(match[2]))
    document = json.loads(OUT_JSON.read_text(encoding="utf-8"))
    if any(kit_id not in {k["biome"] for k in document["kits"]} for kit_id in selected):
        raise ValueError("select an existing, non-deduplicated kit")
    CACHE.mkdir(parents=True, exist_ok=True)
    # TemporaryDirectory creates its own unique child of this resolved cache;
    # cleanup never targets the published mapkit or any caller-supplied path.
    with tempfile.TemporaryDirectory(prefix="build-selected-", dir=CACHE.resolve()) as temporary:
        staging = Path(temporary).resolve()
        if not staging.is_relative_to(CACHE.resolve()):
            raise ValueError("staging directory escaped the mapkit cache")
        replacements = []
        entries = []
        for kit_id, (bundle_name, biome) in selected.items():
            bundle = Bundle(CACHE / f"{bundle_name}.muast")
            result = build_kit(bundle, biome, staging)
            if result is None:
                raise ValueError(f"{kit_id}: no valid units; published kit retained")
            kit, built, _signature = result
            replacements.append(kit)
            entries.extend(built)
        for source in staging.rglob("*"):
            if not source.is_file():
                continue
            destination = OUT_DIR / source.relative_to(staging)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        by_kit = {kit["biome"]: kit for kit in replacements}
        document["kits"] = [by_kit.get(kit["biome"], kit) for kit in document["kits"]]
        document["entries"] = [entry for entry in document["entries"]
                               if entry["biome"] not in selected] + entries
        document["entries"].sort(key=lambda entry: (entry["biome"], entry["name"]))
        pending = OUT_JSON.with_suffix(".json.pending")
        pending.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")),
                           encoding="utf-8")
        pending.replace(OUT_JSON)
    print(f"Rebuilt {', '.join(selected)}: {len(entries)} units; other kits retained")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit", action="append", help="rebuild only this existing kit (repeatable)")
    args = parser.parse_args()
    if args.kit:
        rebuild_selected(args.kit)
        return
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    OUT_DIR.mkdir(parents=True)
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)

    all_entries: list[dict[str, Any]] = []
    kits: list[dict[str, Any]] = []
    seen_signatures: dict[frozenset, str] = {}
    duplicate_kits: list[tuple[str, str]] = []

    for bundle_name in BUNDLES:
        path = CACHE / f"{bundle_name}.muast"
        if not path.is_file():
            print(f"WARNING: {path} missing, skipped")
            continue
        bundle = Bundle(path)
        mesh_roots = sorted({int(m.group(1)) for t in bundle.transforms.values()
                             for m in [re.match(r"^MeshRoot_QuestMapObj_(\d+)$",
                                                bundle.name_of(t))] if m})
        for biome in mesh_roots:
            result = build_kit(bundle, biome)
            if result is None:
                continue
            kit, entries, signature = result
            key = frozenset(signature)
            if key in seen_signatures:
                duplicate_kits.append((kit["biome"], seen_signatures[key]))
                shutil.rmtree(OUT_DIR / kit["biome"], ignore_errors=True)
                continue
            seen_signatures[key] = kit["biome"]
            kits.append(kit)
            all_entries.extend(entries)
            line = (f"{kit['biome']}: {kit['units']} units, atlas {kit['atlas']}")
            if kit["uvMirrored"]:
                line += f", {kit['uvMirrored']} mirrored-UV meshes"
            if kit["shells"]:
                line += f", {kit['shells']} _edge shells dropped"
            if kit["dropped"]:
                line += f", dropped {len(kit['dropped'])} empty-atlas units: {kit['dropped']}"
            print(line)

    OUT_JSON.write_text(
        json.dumps({"kits": kits, "entries": all_entries}, ensure_ascii=False,
                   separators=(",", ":")), encoding="utf-8")
    total = sum(f.stat().st_size for f in OUT_DIR.rglob("*") if f.is_file())
    print(f"\nwrote {OUT_JSON.relative_to(ROOT)} ({OUT_JSON.stat().st_size/1024:.0f} KB), "
          f"{len(all_entries)} entries in {len(kits)} kits, "
          f"mapkit dir {total/1024/1024:.1f} MB")
    if duplicate_kits:
        print(f"duplicate kits skipped: {duplicate_kits}")


if __name__ == "__main__":
    main()
