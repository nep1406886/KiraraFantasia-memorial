#!/usr/bin/env python3
"""Export the とっておき effect scene of a uniqueskill bundle to GLB.

This is the geometry companion to tools/extract_uniqueskill_timeline.py. That
script produces the schedule (what moves, when, and which events fire); this
one produces the thing being scheduled: the effect meshes, their materials and
textures, and the node hierarchy the timeline addresses by name.

Scope, and why it is smaller than it sounds:

  The effect scene is 86 static MeshRenderers of flat textured geometry -- no
  skinning, no morph targets.  Everything that gives it motion lives in the
  animation, which is already extracted.  So the GLB here is genuinely just
  meshes plus materials, and the hard part is not geometry but carrying the
  MsbHandler state that the animation *starts from*.

  That state is the reason this script exists rather than reusing the model
  converter.  MsbHandler holds each object's render stage/order and initial
  mesh colour, and each material's initial diffuse, blend mode and UV
  transform.  An animation channel that writes texOffsetUV.x is an offset from
  the authored value, not from zero, and a material with eBlendMode_Add is a
  glow rather than a flat sprite.  Drop that state and the scene still plays,
  but every scrolling texture starts in the wrong place and every additive
  effect renders as an opaque card.  It is emitted into glTF `extras`, which
  GLTFLoader surfaces as `userData`, so core/uniqueskill.js can read it back
  without a side-channel file.

  Particle emitters (m_MsbParticleEmitterArray) are exported as rules in scene
  `extras`, not as geometry.  An earlier version of this script skipped them on
  the grounds that they are Meige's own emitter stack with no three.js
  equivalent.  That was measured and is too strong: across all 177 scenes, 2394
  of 2828 emitters (85%) are plain billboards, the four common emission shapes
  cover 2770 of them, and every single one resolves to a texture that
  add_materials already exports.  What has no equivalent is Meige's *renderer*,
  not its rule -- the rule is a fully specified spawn description (count, size
  and speed ranges, emission shape, life, gravity, rotation, blink, UV sheet).

  Skipping them also had a cost that was invisible from inside this script.
  Each emitter hangs off a parent MeshRenderer that carries a ~10 cm quad
  wearing the particle's own additive sprite, and add_meshes exported it like
  any other renderer.  No meshVisibility channel ever names those nodes, so all
  2826 of them sat lit for the whole skill: a scatter of stuck bright dots
  where the particles should have been.  The nodes themselves must stay, since
  the emitter's spawn transform is a `ptcl:`-prefixed child of them and the
  timeline animates the parent, so only the mesh is withheld.

  Indexing is by position in m_MsbParticleEmitterArray, which is what a
  peActive channel's p[0] refers to, and each channel's name is the parent
  renderer's GameObject.  Both are recorded so the runtime can bind either way.

Coordinate convention matches tools/convert_kirafan_model.py exactly: Unity is
left-handed and glTF is right-handed, so positions reflect X, quaternions
become (x, -y, -z, w), triangle winding reverses, and V flips to 1 - v.  The
timeline extractor applies the same reflection, so the two halves land in one
space.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import struct
import sys
from pathlib import Path
from typing import Any

import numpy as np
import UnityPy
from PIL import Image
from UnityPy.helpers.MeshHelper import MeshHandler

COMPONENT_FLOAT = 5126
COMPONENT_UNSIGNED_SHORT = 5123
COMPONENT_UNSIGNED_INT = 5125
TARGET_ARRAY_BUFFER = 34962
TARGET_ELEMENT_ARRAY_BUFFER = 34963

ALPHA_TEST_REF = 0.01


def normalized_vertex_colors(values) -> np.ndarray:
    """UnityPy exposes Color32 as byte integers, not normalized floats."""
    source = np.asarray(values)
    colors = source.astype(np.float32)
    if np.issubdtype(source.dtype, np.integer):
        colors /= 255.0
    if not np.isfinite(colors).all() or np.any(colors < 0) or np.any(colors > 1):
        raise ValueError("vertex colors must fit glTF's normalized [0,1] range")
    return colors

# Marker prefix on external image URIs. core/uniqueskill.js rewrites these
# through THREE.LoadingManager.setURLModifier; nothing resolves them as real
# relative paths.
TEXTURE_URI_PREFIX = "us_tex/"


def needs_layer_texture(state: dict, channels: list, name: str) -> bool:
    """A baked RGBA image is valid only when both layers sample the same UV."""
    textures = state.get("textures", [])
    base = next((t for t in textures if t.get("type", 0) == 0 and t.get("layer", 0) == 0), None)
    layer = next((t for t in textures if t.get("type", 0) == 0 and t.get("layer", 0) == 1), None)
    if not base or not layer:
        return False
    if (layer.get("layerBlendMode"), layer.get("layerBlendModeAlpha")) != (6, 5):
        return True
    for key in ("coverageUV", "translationUV", "offsetUV", "rotateUV"):
        if base.get(key) != layer.get(key):
            return True
    signatures = [{}, {}]
    for channel in channels:
        params = channel.get("p", [0, 0, 0])
        if channel.get("name") == name and channel.get("target", "").startswith("tex") and params[1] == 0 and params[2] in (0, 1):
            signatures[params[2]][(channel["target"], channel.get("comp", 0))] = channel["keys"]
    return signatures[0] != signatures[1]

# MeigeUtility.RenderStageToRenderQueue: stage * 125 + order % 125, with a +1
# once the stage reaches eRenderStage_Alpha.
RENDER_STAGE_ALPHA = 21
RENDER_STAGE_SPAN = 125

# MeigeShaderUtility.m_blendComponent, indexed by eBlendMode. Recorded as the
# engine's own (op, src, dst) so the runtime can pick a three.js blending mode
# without this script having to guess which one is closest.
BLEND_MODES = {
    0: ("none", "add", "one", "zero"),
    1: ("std", "add", "srcAlpha", "oneMinusSrcAlpha"),
    2: ("add", "add", "srcAlpha", "one"),
    3: ("sub", "revSub", "srcAlpha", "one"),
    4: ("negative", "add", "oneMinusDstColor", "oneMinusSrcAlpha"),
    5: ("srcOne", "add", "one", "zero"),
    6: ("dstOne", "add", "zero", "one"),
    7: ("mul", "add", "dstColor", "zero"),
    8: ("custom", "add", "srcAlpha", "oneMinusSrcAlpha"),
}


def pptr_id(value: Any) -> int:
    if not value:
        return 0
    if isinstance(value, dict):
        return int(value.get("m_PathID") or 0)
    return int(getattr(value, "path_id", 0) or 0)


def r4(value: Any) -> float:
    return round(float(value or 0.0), 4)


def vec3(value: Any, reflect_x: bool = False) -> list[float]:
    x, y, z = float(value["x"]), float(value["y"]), float(value["z"])
    return [r4(-x if reflect_x else x), r4(y), r4(z)]


def quat_reflected(value: Any) -> list[float]:
    # Reflecting X negates the axis components perpendicular to it.
    return [r4(value["x"]), r4(-value["y"]), r4(-value["z"]), r4(value["w"])]


class GlbBuilder:
    """Minimal glTF 2.0 binary writer.

    Deliberately a copy of the one in tools/convert_kirafan_model.py rather
    than an import: that file belongs to the model-conversion work and is
    edited independently, and a shared import would couple the two scripts'
    release cycles for about a hundred lines of buffer bookkeeping.
    """

    def __init__(self) -> None:
        self.binary = bytearray()
        self.document: dict[str, Any] = {
            "asset": {"version": "2.0",
                      "generator": "kirafan uniqueskill scene exporter"},
            "scene": 0,
            "scenes": [{"nodes": []}],
            "nodes": [],
            "meshes": [],
            "materials": [],
            "textures": [],
            "images": [],
            "samplers": [{"magFilter": 9729, "minFilter": 9987,
                          "wrapS": 10497, "wrapT": 10497}],
            "bufferViews": [],
            "accessors": [],
            "extensionsUsed": ["KHR_materials_unlit"],
        }
        self.accessor_cache: dict[tuple[Any, ...], int] = {}
        self.image_cache: dict[bytes, int] = {}

    def align(self, alignment: int = 4) -> None:
        while len(self.binary) % alignment:
            self.binary.append(0)

    def add_view(self, payload: bytes, target: int | None = None) -> int:
        self.align()
        offset = len(self.binary)
        self.binary.extend(payload)
        view: dict[str, Any] = {"buffer": 0, "byteOffset": offset,
                                "byteLength": len(payload)}
        if target is not None:
            view["target"] = target
        self.document["bufferViews"].append(view)
        return len(self.document["bufferViews"]) - 1

    def add_accessor(self, values: np.ndarray, component_type: int,
                     accessor_type: str, target: int | None = None,
                     include_bounds: bool = False) -> int:
        values = np.ascontiguousarray(values)
        payload = values.tobytes()
        key = (component_type, accessor_type, target, include_bounds,
               int(values.shape[0]),
               hashlib.blake2b(payload, digest_size=16).digest())
        cached = self.accessor_cache.get(key)
        if cached is not None:
            return cached
        view = self.add_view(payload, target)
        accessor: dict[str, Any] = {
            "bufferView": view,
            "componentType": component_type,
            "count": int(values.shape[0]),
            "type": accessor_type,
        }
        if include_bounds:
            shaped = values.reshape(values.shape[0], -1)
            accessor["min"] = shaped.min(axis=0).astype(float).tolist()
            accessor["max"] = shaped.max(axis=0).astype(float).tolist()
        self.document["accessors"].append(accessor)
        index = len(self.document["accessors"]) - 1
        self.accessor_cache[key] = index
        return index

    def add_png(self, image: Image.Image, name: str,
                shared: dict[str, bytes] | None = None) -> int:
        """Add a texture, either embedded or as a shared external file.

        Effect textures repeat heavily across scenes -- a character's two 5*
        forms are separate bundles with nearly the same art, and 42% of the
        embedded PNG payload across all 177 scenes is duplicate bytes.  When
        `shared` is given the PNG is content-addressed into it and referenced
        by URI instead, which is the difference between a 142 MiB and an 89 MiB
        download for identical pixels.
        """
        stream = io.BytesIO()
        image.save(stream, format="PNG", optimize=True)
        payload = stream.getvalue()
        digest = hashlib.blake2b(payload, digest_size=16).hexdigest()
        key = digest.encode()
        cached = self.image_cache.get(key)
        if cached is not None:
            return cached
        if shared is None:
            entry = {"name": name, "mimeType": "image/png",
                     "bufferView": self.add_view(payload)}
        else:
            shared[digest] = payload
            # Resolved by the runtime's LoadingManager, because a GLB served
            # from a blob: URL has no base path to resolve a relative URI
            # against.
            entry = {"name": name, "mimeType": "image/png",
                     "uri": TEXTURE_URI_PREFIX + digest + ".png"}
        self.document["images"].append(entry)
        image_index = len(self.document["images"]) - 1
        self.document["textures"].append({"sampler": 0, "source": image_index})
        texture_index = len(self.document["textures"]) - 1
        self.image_cache[key] = texture_index
        return texture_index

    def to_bytes(self) -> bytes:
        self.align()
        self.document["buffers"] = [{"byteLength": len(self.binary)}]
        json_payload = json.dumps(self.document, ensure_ascii=False,
                                  separators=(",", ":")).encode("utf-8")
        while len(json_payload) % 4:
            json_payload += b" "
        binary_payload = bytes(self.binary)
        total = 12 + 8 + len(json_payload) + 8 + len(binary_payload)
        out = bytearray()
        out += struct.pack("<4sII", b"glTF", 2, total)
        out += struct.pack("<I4s", len(json_payload), b"JSON")
        out += json_payload
        out += struct.pack("<I4s", len(binary_payload), b"BIN\0")
        out += binary_payload
        return bytes(out)


def render_queue(stage: int, order: int) -> int:
    base = stage * RENDER_STAGE_SPAN + (order % RENDER_STAGE_SPAN)
    return base + 1 if stage >= RENDER_STAGE_ALPHA else base


# MeigeParticleEmitter enums. Both orderings were checked against the data
# rather than assumed: for every emitter, the sub-struct of m_particleTypeParam
# / m_emitionParam holding nonzero values is the one the index names
# (.codex-tmp/pe_enum.py). Note cylinder is 7, not 6 -- index 6 appears
# nowhere, and the only two emitters with emitionType 7 populate m_cylinder.
PARTICLE_TYPES = {0: "billboard", 1: "point", 2: "line", 3: "polyline",
                  4: "confetti", 5: "ribbon"}
EMISSION_TYPES = {0: "point", 1: "box", 2: "planeQuad", 3: "planeCircle",
                  4: "sphere", 5: "torus", 7: "cylinder"}
# 0 = seconds, 1 = distance travelled. Height exists in the struct but no
# emitter selects it.
LIFESPAN_TYPES = {0: "time", 1: "distance", 2: "height"}


def value_range(node: Any) -> list[float]:
    """Meige wraps every randomised scalar as {m_Min:{m_Value}, m_Max:{...}}."""
    node = node or {}
    lo = (node.get("m_Min") or {}).get("m_Value", 0.0)
    hi = (node.get("m_Max") or {}).get("m_Value", 0.0)
    return [r4(lo), r4(hi)]


def nonzero_range(node: Any) -> bool:
    return any(v != 0.0 for v in value_range(node))


def emitter_rule(rule: dict[str, Any]) -> dict[str, Any]:
    """The subset of m_Rule the runtime needs, in compact keys.

    Everything omitted is omitted because no emitter in any of the 177 scenes
    uses it, not because it looked unimportant (.codex-tmp/pe_flags.py):
    collisionType, LifeScaleType, billboard RotateType and frameSpeedScale are
    single-valued across all 2828 emitters, and tail, light and locators are
    unset everywhere. m_UsingPathMoveFlg is live on 11 emitters and is recorded
    as a bare flag so the runtime can tell it is ignoring something.
    """
    type_param = rule.get("m_particleTypeParam") or {}
    emit_param = rule.get("m_emitionParam") or {}
    ptype = int(rule.get("m_particleType", 0))
    etype = int(rule.get("m_emitionType", 0))
    ltype = int(rule.get("m_lifeSpanType", 0))
    life_param = rule.get("m_LifeSpanParam") or {}

    out: dict[str, Any] = {
        "num": int(rule.get("m_particleNum", 0)),
        "type": PARTICLE_TYPES.get(ptype, str(ptype)),
        "emit": EMISSION_TYPES.get(etype, str(etype)),
        "rate": r4(rule.get("m_incidentNumberPerSec", 0)),
        "rateRandom": r4(rule.get("m_incidentRandomLevel", 0)),
        "speed": value_range(rule.get("m_speedRange")),
        "lifeScale": value_range(rule.get("m_lifeScaleRange")),
        "hdr": r4(rule.get("m_HDR_Factor", 1)),
        "alphaScale": r4(rule.get("m_AlphaScale", 1)),
        "lifeType": LIFESPAN_TYPES.get(ltype, str(ltype)),
        # Fades the particle out over its life. Two thirds of emitters set it,
        # and without it every particle pops out at full brightness.
        "lifeAlpha": bool(rule.get("m_lifeSpanAlpha", 0)),
        # Local means the particle stays in the emitter's frame, so it follows
        # the node as the timeline animates it; world means it is released.
        "local": bool(rule.get("m_isLocalTrans", 0)),
        "randomDir": bool(rule.get("m_isRandomEmitDir", 0)),
    }

    if ltype == 1:
        out["life"] = value_range(
            (life_param.get("m_Distance") or {}).get(
                "m_lifeSpanDistanceMaxRange"))
    else:
        out["life"] = value_range(
            (life_param.get("m_Time") or {}).get("m_lifeSpanSecRange"))

    if ptype == 0:
        billboard = type_param.get("m_billboard") or {}
        out["width"] = value_range(billboard.get("m_widthRange"))
        out["height"] = value_range(billboard.get("m_heightRange"))
    elif ptype == 1:
        out["size"] = value_range(
            (type_param.get("m_point") or {}).get("m_sizeRange"))
    elif ptype == 4:
        confetti = type_param.get("m_confetti") or {}
        out["width"] = value_range(confetti.get("m_widthRange"))
        out["height"] = value_range(confetti.get("m_heightRange"))
    elif ptype in (2, 3, 5):
        key = {2: "m_line", 3: "m_polyLine", 5: "m_ribbon"}[ptype]
        strip = type_param.get(key) or {}
        if ptype == 2:
            out["width"] = [r4(strip.get("m_width", 0))] * 2
        else:
            out["width"] = value_range(strip.get("m_topWidthRange"))
            out["endWidth"] = value_range(strip.get("m_endWidthRange"))
        out["joints"] = int(strip.get("m_jointNum", 0))

    shape: dict[str, Any] = {}
    if etype == 0:
        shape["angle"] = value_range(
            (emit_param.get("m_point") or {}).get("m_angleRange"))
    elif etype == 1:
        box = emit_param.get("m_box") or {}
        shape["width"] = value_range(box.get("m_widthRange"))
        shape["height"] = value_range(box.get("m_heightRange"))
        shape["depth"] = value_range(box.get("m_depthRange"))
    elif etype == 2:
        quad = emit_param.get("m_planeQuad") or {}
        shape["width"] = value_range(quad.get("m_widthRange"))
        shape["height"] = value_range(quad.get("m_heightRange"))
    elif etype == 3:
        shape["radius"] = value_range(
            (emit_param.get("m_planeCircle") or {}).get("m_radiusRange"))
    elif etype == 4:
        sphere = emit_param.get("m_sphere") or {}
        shape["angle"] = value_range(sphere.get("m_angleRange"))
        shape["radius"] = value_range(sphere.get("m_radiusRange"))
    elif etype == 5:
        torus = emit_param.get("m_torus") or {}
        shape["angle"] = value_range(torus.get("m_angleRange"))
        shape["bigRadius"] = r4(torus.get("m_bigRadiusRange", 0))
        shape["radius"] = value_range(torus.get("m_smallRadiusRange"))
    elif etype == 7:
        cylinder = emit_param.get("m_cylinder") or {}
        shape["radius"] = value_range(cylinder.get("m_RadiusRange"))
        shape["height"] = value_range(cylinder.get("m_HeightRange"))
    if shape:
        out["shape"] = shape

    gravity = rule.get("m_gravityDir") or {}
    if nonzero_range(rule.get("m_gravityForceRange")) or any(
            r4(gravity.get(k, 0)) for k in "xyz"):
        # Same X reflection as every other vector in this file.
        out["gravity"] = {"dir": vec3(gravity, reflect_x=True),
                          "force": value_range(
                              rule.get("m_gravityForceRange"))}

    if rule.get("m_UsingAccelerationFlg"):
        accel = rule.get("m_AccelerationComponent") or {}
        out["accel"] = {"a": value_range(accel.get("m_accelerationRange")),
                        "drag": value_range(accel.get("m_dragForceRange"))}

    if rule.get("m_UsingRotationFlg"):
        rot = rule.get("m_RotationComponent") or {}
        out["rot"] = {
            "start": value_range(rot.get("m_rotRange")),
            "speed": value_range(rot.get("m_rotSpeedRange")),
            "accel": value_range(rot.get("m_rotAccelerationRange")),
            "drag": value_range(rot.get("m_rotDragForceRange")),
            "anchor": value_range(rot.get("m_rotAnchorOffsetRange")),
        }

    if rule.get("m_UsingBlinkFlg"):
        out["blink"] = value_range(
            (rule.get("m_BlinkComponent") or {}).get("m_blinkSpanSecRange"))

    uv_rect = rule.get("m_uvRect_TopBlock") or {}
    blocks = int(rule.get("m_uvBlockNum", 1))
    if blocks > 1 or any(r4(uv_rect.get(k, 0)) not in (0.0, 1.0)
                         for k in ("x", "y", "width", "height")):
        out["uv"] = {"rect": [r4(uv_rect.get("x", 0)), r4(uv_rect.get("y", 0)),
                              r4(uv_rect.get("width", 1)),
                              r4(uv_rect.get("height", 1))],
                     "blocks": blocks}
    if rule.get("m_UsingUVAnimationFlg"):
        anim = rule.get("m_UVAnimationComponent") or {}
        out["uvAnim"] = {
            "type": int(anim.get("m_uvAnimeType", 0)),
            "switchSec": value_range(anim.get("m_switchBlockSecRange")),
            "randomStart": bool(anim.get("m_randomStartBlockFlg", 0)),
        }

    if rule.get("m_UsingColorCurveFlg"):
        curves = []
        for curve in ((rule.get("m_ColorCurveComponent") or {})
                      .get("m_pColorCurveArray") or []):
            stops = []
            for stop in curve.get("m_Value") or []:
                c = stop.get("m_Value") or {}
                stops.append([r4(c.get("r", 1)), r4(c.get("g", 1)),
                              r4(c.get("b", 1)), r4(c.get("a", 1))])
            if stops:
                curves.append(stops)
        if curves:
            # m_Point is empty on every curve, so the stops are evenly spaced
            # over the particle's life and one curve is chosen per particle.
            out["colorCurves"] = curves

    if rule.get("m_UsingPathMoveFlg"):
        out["pathMove"] = True

    return out


class SceneExporter:
    def __init__(self, bundle: Path, shared_textures: dict[str, bytes] | None = None,
                 timeline: dict | None = None) -> None:
        self.bundle = bundle
        self.shared_textures = shared_textures
        self.env = UnityPy.load(str(bundle))
        self.builder = GlbBuilder()
        self.timeline = timeline
        self.mesh_handlers = {}
        self.independent_uv_materials: set[str] = set()
        self.uv_checked = False

        self.scripts = {o.path_id: o.read_typetree().get("m_ClassName")
                        for o in self.env.objects if o.type.name == "MonoScript"}
        self.go = {o.path_id: o.read_typetree()
                   for o in self.env.objects if o.type.name == "GameObject"}
        self.go_name = {pid: d.get("m_Name") for pid, d in self.go.items()}

        self.transforms: dict[int, dict] = {}
        self.transform_for_go: dict[int, int] = {}
        for o in self.env.objects:
            if o.type.name != "Transform":
                continue
            d = o.read_typetree()
            self.transforms[o.path_id] = d
            self.transform_for_go[pptr_id(d.get("m_GameObject"))] = o.path_id

        self.node_for_transform: dict[int, int] = {}
        self.msb = self.read_msb_handler()

    def read_msb_handler(self) -> dict[str, Any]:
        for o in self.env.objects:
            if o.type.name != "MonoBehaviour":
                continue
            d = o.read_typetree()
            if self.scripts.get(pptr_id(d.get("m_Script"))) == "MsbHandler":
                return d
        return {}

    # --- hierarchy ------------------------------------------------------

    def add_hierarchy(self) -> None:
        """Emit one glTF node per Transform, preserving parentage.

        Curve paths in the timeline are relative to the UniqueSkill(Clone)
        root, and the player binds by leaf name, so what matters here is that
        every name survives and local transforms stay correct.
        """
        order = sorted(self.transforms)
        for pid in order:
            d = self.transforms[pid]
            name = self.go_name.get(pptr_id(d.get("m_GameObject"))) or ""
            node: dict[str, Any] = {"name": name}
            t = vec3(d["m_LocalPosition"], reflect_x=True)
            r = quat_reflected(d["m_LocalRotation"])
            s = vec3(d["m_LocalScale"])
            if t != [0.0, 0.0, 0.0]:
                node["translation"] = t
            if r != [0.0, 0.0, 0.0, 1.0]:
                node["rotation"] = r
            if s != [1.0, 1.0, 1.0]:
                node["scale"] = s
            self.builder.document["nodes"].append(node)
            self.node_for_transform[pid] = len(self.builder.document["nodes"]) - 1

        for pid in order:
            d = self.transforms[pid]
            children = [self.node_for_transform[pptr_id(c)]
                        for c in (d.get("m_Children") or [])
                        if pptr_id(c) in self.node_for_transform]
            if children:
                self.builder.document["nodes"][self.node_for_transform[pid]]["children"] = children

        roots = [self.node_for_transform[pid] for pid in order
                 if pptr_id(self.transforms[pid].get("m_Father")) not in self.node_for_transform]
        self.builder.document["scenes"][0]["nodes"] = roots

    # --- materials ------------------------------------------------------

    def texture_images(self) -> dict[str, Image.Image]:
        images: dict[str, Image.Image] = {}
        for o in self.env.objects:
            if o.type.name != "Texture2D":
                continue
            try:
                tex = o.read()
                images[tex.m_Name] = tex.image
            except Exception:
                continue
        return images

    def msb_material_state(self) -> dict[str, dict]:
        """Authored per-material state, keyed by material name.

        MabAnimNodeHandler resolves tex*/matColor channels through
        GetMsbMaterialHandlerByName, so name is the join key the runtime uses
        too.
        """
        state: dict[str, dict] = {}
        for entry in self.msb.get("m_MsbMaterialHandlerArray") or []:
            src = entry.get("m_Src") or {}
            diffuse = src.get("m_Diffuse") or {}
            textures = []
            for tex in src.get("m_Texture") or []:
                cov = tex.get("m_CoverageUV") or {}
                trans = tex.get("m_TranslationUV") or {}
                off = tex.get("m_OffsetUV") or {}
                textures.append({
                    "name": tex.get("m_Name"),
                    "type": int(tex.get("m_eType", 0)),
                    "layer": int(tex.get("m_Layer", 0)),
                    "coverageUV": [r4(cov.get("x", 1)), r4(cov.get("y", 1))],
                    "translationUV": [r4(trans.get("x")), r4(trans.get("y"))],
                    "offsetUV": [r4(off.get("x")), r4(off.get("y"))],
                    "rotateUV": r4(tex.get("m_RotateUV")),
                    "layerBlendMode": int(tex.get("m_LayerBlendMode", 0)),
                    "layerBlendModeAlpha": int(tex.get("m_LayerBlendModeAlpha", 0)),
                })
            blend = int(src.get("m_BlendMode", 1))
            name, op, bsrc, bdst = BLEND_MODES.get(blend, BLEND_MODES[1])
            state[entry.get("m_Name")] = {
                "diffuse": [r4(diffuse.get("r", 1)), r4(diffuse.get("g", 1)),
                            r4(diffuse.get("b", 1)), r4(diffuse.get("a", 1))],
                "blendMode": blend,
                "blend": {"name": name, "op": op, "src": bsrc, "dst": bdst},
                "alphaTestRef": r4(src.get("m_AlphaTestRefValue", ALPHA_TEST_REF)),
                "textures": textures,
            }
        return state

    def add_materials(self) -> dict[int, int]:
        """One glTF material per Unity Material, carrying its MsbHandler state.

        The RGB and alpha channels ship as separate Texture2D objects
        (<name>_rgb and <name>_a). Bake only equivalent UVs; otherwise retain the
        raw second texture and its authored blend rule for the runtime shader.
        """
        images = self.texture_images()
        msb_state = self.msb_material_state()
        result: dict[int, int] = {}

        for o in self.env.objects:
            if o.type.name != "Material":
                continue
            material = o.read()
            name = material.m_Name

            tex_entries: dict[str, Any] = {}
            for key, env_tex in material.m_SavedProperties.m_TexEnvs:
                key_name = key if isinstance(key, str) else key.name
                if env_tex.m_Texture:
                    try:
                        tex_entries[key_name] = env_tex.m_Texture.read()
                    except Exception:
                        continue

            rgb_tex = tex_entries.get("_Texture_Albedo")
            if rgb_tex is None and tex_entries:
                rgb_tex = next(iter(tex_entries.values()))

            state = msb_state.get(name, {})
            channels = (getattr(self, "timeline", None) or {}).get("channels", [])
            separate = (name in getattr(self, "independent_uv_materials", set())
                        or needs_layer_texture(state, channels, name))
            image = None
            if rgb_tex is not None:
                image = rgb_tex.image.convert("RGBA")
                base = rgb_tex.m_Name
                # Many effects share a 2x2 white RGB texture but have distinct
                # full-size masks. Msb's alpha layer is authoritative.
                alpha_layer = next((layer for layer in state.get("textures", [])
                                    if layer.get("layer") == 1
                                    and layer.get("layerBlendModeAlpha") == 5), None)
                alpha_name = alpha_layer["name"] if alpha_layer else (
                    base[:-4] + "_a" if base.endswith("_rgb") else base + "_a")
                alpha_img = images.get(alpha_name)
                alpha_channel = "A"
                packed = tex_entries.get("_Texture_AlbedoLayer")
                if not alpha_layer and packed is not None and packed.m_Name.endswith("_compa"):
                    # This shipped shader samples its bound mask's green channel
                    # with TEXCOORD0. A _compa texture has an opaque A channel.
                    shader = material.m_Shader.read().object_reader.read_typetree()
                    shader_name = (shader.get("m_ParsedForm") or {}).get("m_Name")
                    if shader_name != "MeigeExt/FakeMeigeShader" or separate:
                        raise ValueError(f"unsupported packed alpha shader/UV: {name}: {shader_name}")
                    alpha_img = packed.image
                    alpha_channel = "G"
                    state["packedAlpha"] = {"texture": packed.m_Name, "channel": "g",
                                            "binding": "_Texture_AlbedoLayer", "shader": shader_name}
                if alpha_img is not None and not separate:
                    alpha = alpha_img.convert("RGBA").getchannel(alpha_channel)
                    size = (max(image.width, alpha.width), max(image.height, alpha.height))
                    if image.size != size:
                        image = image.resize(size, Image.Resampling.BILINEAR)
                    if alpha.size != size:
                        alpha = alpha.resize(size, Image.Resampling.BILINEAR)
                    image.putalpha(alpha)
            if image is None:
                image = Image.new("RGBA", (2, 2), (255, 255, 255, 255))

            texture_index = self.builder.add_png(image, name, self.shared_textures)
            if separate:
                layer = next(t for t in state["textures"] if t["type"] == 0 and t["layer"] == 1)
                layer_image = images.get(layer["name"])
                if layer_image is None:
                    raise ValueError(f"missing texture layer {name}: {layer['name']}")
                layer_index = self.builder.add_png(layer_image.convert("RGBA"), name + ":layer", self.shared_textures)
                state["layerTexture"] = {"index": layer_index, "texCoord": 1}
            blend = state.get("blend", {"name": "std", "op": "add",
                                        "src": "srcAlpha",
                                        "dst": "oneMinusSrcAlpha"})
            # Everything in an effect scene composites; the blend mode in
            # extras is what actually decides how, so glTF alphaMode is set to
            # BLEND for anything that is not the engine's opaque mode.
            opaque = blend["name"] in ("none", "srcOne")
            entry: dict[str, Any] = {
                "name": name,
                "doubleSided": True,
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": texture_index},
                    "metallicFactor": 0,
                    "roughnessFactor": 1,
                },
                "extensions": {"KHR_materials_unlit": {}},
                "extras": {"msb": state} if state else {},
            }
            if opaque:
                entry["alphaMode"] = "MASK"
                entry["alphaCutoff"] = state.get("alphaTestRef", ALPHA_TEST_REF)
            else:
                entry["alphaMode"] = "BLEND"
            self.builder.document["materials"].append(entry)
            result[o.path_id] = len(self.builder.document["materials"]) - 1
        return result

    # --- meshes ---------------------------------------------------------

    def mesh_handler(self, obj):
        if obj.path_id not in self.mesh_handlers:
            handler = MeshHandler(obj.read())
            handler.process()
            self.mesh_handlers[obj.path_id] = handler
        return self.mesh_handlers[obj.path_id]

    def find_independent_uv_materials(self):
        """The original layered shader reads TEXCOORD1, not TEXCOORD0 twice."""
        if self.uv_checked:
            return
        states = self.msb_material_state()
        layered = {name for name, state in states.items() if len(state["textures"]) > 1}
        material_names = {o.path_id: o.read().m_Name for o in self.env.objects if o.type.name == "Material"}
        meshes = {o.path_id: o for o in self.env.objects if o.type.name == "Mesh"}
        mesh_by_go = {}
        for obj in self.env.objects:
            if obj.type.name == "MeshFilter":
                data = obj.read_typetree()
                mesh_by_go[pptr_id(data["m_GameObject"])] = pptr_id(data["m_Mesh"])
        for obj in self.env.objects:
            if obj.type.name != "MeshRenderer":
                continue
            data = obj.read_typetree()
            names = {material_names.get(pptr_id(ref)) for ref in data.get("m_Materials", [])} & layered
            mesh = meshes.get(mesh_by_go.get(pptr_id(data["m_GameObject"])))
            if not names or not mesh:
                continue
            handler = self.mesh_handler(mesh)
            if handler.m_UV1 and handler.m_UV0 != handler.m_UV1:
                self.independent_uv_materials.update(names)
        self.uv_checked = True

    def msb_object_state(self) -> dict[str, dict]:
        state: dict[str, dict] = {}
        for entry in self.msb.get("m_MsbObjectHandlerArray") or []:
            src = entry.get("m_Src") or {}
            color = src.get("m_MeshColor") or {}
            stage = int(src.get("m_eRenderStage", 0))
            order = int(src.get("m_RenderOrder", 0))
            state[entry.get("m_Name")] = {
                "meshColor": [r4(color.get("r", 1)), r4(color.get("g", 1)),
                              r4(color.get("b", 1)), r4(color.get("a", 1))],
                "visible": bool(src.get("m_bVisibility", 1)),
                "renderStage": stage,
                "renderOrderBase": order,
                "renderOrder": render_queue(stage, order),
                "halfVertexColor": bool(src.get("m_bHalfVertexColor", 0)),
                "hdrFactor": r4(src.get("m_HDRFactor", 1)),
                "billboard": int(src.get("m_eBillboardType", 0)),
            }
        return state

    # --- particle emitters ----------------------------------------------

    def add_emitters(self, materials: dict[int, int]) -> tuple[int, set[int]]:
        """Emit spawn rules into scene extras; report the cards to withhold.

        Returns the emitter count and the set of GameObject ids whose mesh
        add_meshes must skip -- the placeholder quads described in the module
        docstring. The nodes stay; only their `mesh` is never assigned.
        """
        emitters_by_id = {}
        for o in self.env.objects:
            if o.type.name != "MonoBehaviour":
                continue
            d = o.read_typetree()
            if self.scripts.get(pptr_id(d.get("m_Script"))) == "MeigeParticleEmitter":
                emitters_by_id[o.path_id] = d

        renderer_go: dict[int, int] = {}
        renderer_materials: dict[int, list] = {}
        for o in self.env.objects:
            if o.type.name != "MeshRenderer":
                continue
            d = o.read_typetree()
            renderer_go[o.path_id] = pptr_id(d.get("m_GameObject"))
            renderer_materials[o.path_id] = d.get("m_Materials") or []

        entries: list[dict[str, Any]] = []
        suppress: set[int] = set()

        for index, slot in enumerate(
                self.msb.get("m_MsbParticleEmitterArray") or []):
            emitter = emitters_by_id.get(pptr_id(slot.get("m_ParticleEmitter")))
            if emitter is None:
                continue

            renderer_id = pptr_id(slot.get("m_ParentRenderer"))
            parent_go = renderer_go.get(renderer_id)
            # The peActive channel is named after the parent renderer's
            # GameObject, so this is the runtime's join key.
            parent_name = self.go_name.get(parent_go) if parent_go else None

            # m_MsbMaterialHandler on the slot is zeroed on every emitter, with
            # an empty texture list; the sprite comes from the parent
            # renderer's material, which add_materials has already exported.
            material_index = None
            material_name = None
            for ref in renderer_materials.get(renderer_id) or []:
                candidate = materials.get(pptr_id(ref))
                if candidate is not None:
                    material_index = candidate
                    material_name = (self.builder.document["materials"]
                                     [candidate].get("name"))
                    break

            emitter_go = pptr_id(emitter.get("m_GameObject"))
            transform_id = self.transform_for_go.get(emitter_go)
            node_index = (self.node_for_transform.get(transform_id)
                          if transform_id is not None else None)

            entry: dict[str, Any] = {
                "index": index,
                "name": parent_name or "",
                "node": node_index,
                "rule": emitter_rule(emitter.get("m_Rule") or {}),
                # m_isActive is 0 on essentially every emitter; the timeline's
                # peActive channel is what turns them on.
                "active": bool(emitter.get("m_isActive", 0)),
            }
            if material_index is not None:
                entry["material"] = material_index
            if material_name:
                # The index is the glTF truth, but GLTFLoader does not expose
                # the material array, and now that the placeholder card is
                # withheld the material may not reach any surviving mesh. The
                # name lets the runtime find it either way.
                entry["materialName"] = material_name
            entries.append(entry)

            if parent_go is not None:
                suppress.add(parent_go)

        if entries:
            scene = self.builder.document["scenes"][0]
            extras = scene.setdefault("extras", {})
            extras["emitters"] = entries
        return len(entries), suppress

    def add_meshes(self, materials: dict[int, int],
                   suppress: set[int] | None = None) -> int:
        suppress = suppress or set()
        obj_state = self.msb_object_state()
        mesh_by_go: dict[int, int] = {}
        for o in self.env.objects:
            if o.type.name != "MeshFilter":
                continue
            d = o.read_typetree()
            mesh_by_go[pptr_id(d.get("m_GameObject"))] = pptr_id(d.get("m_Mesh"))

        mesh_objects = {o.path_id: o for o in self.env.objects
                        if o.type.name == "Mesh"}
        added = 0

        for o in self.env.objects:
            if o.type.name != "MeshRenderer":
                continue
            d = o.read_typetree()
            go_id = pptr_id(d.get("m_GameObject"))
            transform_id = self.transform_for_go.get(go_id)
            mesh_id = mesh_by_go.get(go_id)
            if transform_id is None or not mesh_id or mesh_id not in mesh_objects:
                continue
            # A particle emitter's parent renderer: the mesh is a placeholder
            # card, and the real output is the emitter rule. The node still has
            # to exist, since the emitter's spawn transform is its child.
            if go_id in suppress:
                continue

            mesh = mesh_objects[mesh_id].read()
            handler = self.mesh_handler(mesh_objects[mesh_id])
            if not handler.m_Vertices:
                continue

            positions = np.asarray([(-x, y, z) for x, y, z in handler.m_Vertices],
                                   dtype=np.float32)
            attributes = {
                "POSITION": self.builder.add_accessor(
                    positions, COMPONENT_FLOAT, "VEC3", TARGET_ARRAY_BUFFER, True)
            }
            if handler.m_Normals:
                normals = np.asarray([(-x, y, z) for x, y, z in handler.m_Normals],
                                     dtype=np.float32)
                attributes["NORMAL"] = self.builder.add_accessor(
                    normals, COMPONENT_FLOAT, "VEC3", TARGET_ARRAY_BUFFER)
            if handler.m_UV0:
                uvs = np.asarray([(u, 1.0 - v) for u, v in handler.m_UV0],
                                 dtype=np.float32)
                attributes["TEXCOORD_0"] = self.builder.add_accessor(
                    uvs, COMPONENT_FLOAT, "VEC2", TARGET_ARRAY_BUFFER)
            # Vertex colours drive several effect materials, so they cannot be
            # dropped the way they can for character models.
            if getattr(handler, "m_Colors", None):
                colors = normalized_vertex_colors(handler.m_Colors)
                if colors.ndim == 2 and colors.shape[1] == 4:
                    attributes["COLOR_0"] = self.builder.add_accessor(
                        colors, COMPONENT_FLOAT, "VEC4", TARGET_ARRAY_BUFFER)

            triangles = handler.get_triangles()[0]
            dtype = np.uint16 if len(positions) <= 65535 else np.uint32
            component = (COMPONENT_UNSIGNED_SHORT if dtype == np.uint16
                         else COMPONENT_UNSIGNED_INT)
            indices = np.asarray([(c, b, a) for a, b, c in triangles],
                                 dtype=dtype).reshape(-1)
            index_accessor = self.builder.add_accessor(
                indices, component, "SCALAR", TARGET_ELEMENT_ARRAY_BUFFER)

            material_index = 0
            for ref in d.get("m_Materials") or []:
                candidate = materials.get(pptr_id(ref))
                if candidate is not None:
                    material_index = candidate
                    break

            state_material = self.builder.document["materials"][material_index].get("extras", {}).get("msb", {})
            if state_material.get("layerTexture"):
                # Retain the existing shared-UV path when no explicit second
                # channel is stored; zero UVs erase masks (e.g. Yuno's sun).
                layer_uv = handler.m_UV1 or handler.m_UV0 or [(0, 0)] * len(positions)
                uv1 = np.asarray([(u, 1.0 - v) for u, v in layer_uv], dtype=np.float32)
                attributes["TEXCOORD_1"] = self.builder.add_accessor(
                    uv1, COMPONENT_FLOAT, "VEC2", TARGET_ARRAY_BUFFER)

            name = self.go_name.get(go_id) or mesh.m_Name
            state = obj_state.get(name, {})
            extras = {"msb": state} if state else {}
            if state.get("renderOrder") is not None:
                extras["renderOrder"] = state["renderOrder"]

            self.builder.document["meshes"].append({
                "name": name,
                "primitives": [{"attributes": attributes,
                                "indices": index_accessor,
                                "material": material_index}],
                "extras": extras,
            })
            node = self.builder.document["nodes"][self.node_for_transform[transform_id]]
            node["mesh"] = len(self.builder.document["meshes"]) - 1
            if extras:
                node["extras"] = extras
            added += 1
        return added

    def export(self) -> tuple[bytes, dict]:
        if self.timeline is None:
            from extract_uniqueskill_timeline import extract
            self.timeline = extract(self.bundle)
        self.find_independent_uv_materials()
        self.add_hierarchy()
        materials = self.add_materials()
        # Emitters first: add_meshes needs to know which renderers are emitter
        # placeholders before it decides what to export.
        emitters, suppress = self.add_emitters(materials)
        meshes = self.add_meshes(materials, suppress)
        stats = {
            "nodes": len(self.builder.document["nodes"]),
            "meshes": meshes,
            "materials": len(self.builder.document["materials"]),
            "textures": len(self.builder.document["images"]),
            "emitters": emitters,
            "cardsWithheld": len(suppress),
            "layeredMaterials": sum(bool(m.get("extras", {}).get("msb", {}).get("layerTexture"))
                                    for m in self.builder.document["materials"]),
        }
        return self.builder.to_bytes(), stats


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site-root", type=Path, default=Path("."))
    p.add_argument("--bundle-dir", type=Path,
                   default=Path(".codex-tmp/facial-build/animations"))
    p.add_argument("--models", type=Path,
                   default=Path("site/asset/uniqueskill/timeline-index.json"),
                   help="only export models present in this index")
    p.add_argument("--only", action="append", default=None,
                   help="resource ID; repeatable")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--embed-textures", action="store_true",
                   help="embed PNGs in each GLB instead of sharing them "
                        "(larger, but each GLB is self-contained)")
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def texture_totals(site_root: Path, scenes: dict) -> tuple[int, int]:
    """Count the referenced closure, including scenes a partial build retained."""
    textures: set[Path] = set()
    for entry in scenes.values():
        path = site_root / entry["file"]
        payload = path.read_bytes()
        if entry.get("compression") == "gzip":
            payload = gzip.decompress(payload)
        length = struct.unpack_from("<I", payload, 12)[0]
        gltf = json.loads(payload[20:20 + length])
        for image in gltf.get("images", []):
            uri = image.get("uri", "")
            if uri.startswith("us_tex/"):
                textures.add((site_root / "site/asset/uniqueskill/texture" / uri.removeprefix("us_tex/")).resolve())
            elif uri and not uri.startswith("data:"):
                textures.add((path.parent / uri).resolve())
    return len(textures), sum(path.stat().st_size for path in textures)


def main() -> None:
    # Only when run as a script: the console codepage mangles the Japanese
    # mesh names otherwise. Doing it at import time would close the caller's
    # stdout when this module is imported by a test.
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    args = parse_args()
    models = json.loads(args.models.read_text(encoding="utf-8"))
    wanted = set(args.only) if args.only else set(models)

    bundles: list[tuple[str, Path]] = []
    for mid in sorted(wanted):
        path = args.bundle_dir / f"uniqueskill_pl_{mid}_0.muast"
        if path.exists():
            bundles.append((mid, path))
    if args.limit:
        bundles = bundles[:args.limit]
    if not bundles:
        print("no bundles matched")
        return

    out_dir = args.site_root / "asset" / "uniqueskill" / "scene"
    tex_dir = args.site_root / "asset" / "uniqueskill" / "texture"
    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

    shared: dict[str, bytes] | None = None if args.embed_textures else {}
    manifest: dict[str, Any] = {}
    total_raw = total_gz = 0
    failures: list[tuple[str, str]] = []

    for i, (mid, path) in enumerate(bundles, 1):
        try:
            payload, stats = SceneExporter(path, shared).export()
        except Exception as exc:                      # per-model, not fatal
            failures.append((mid, f"{type(exc).__name__}: {exc}"))
            print(f"[{i}/{len(bundles)}] {mid} FAILED {type(exc).__name__}: {exc}")
            continue
        packed = gzip.compress(payload, 9, mtime=0)
        destination = out_dir / f"{mid}.glb.gz"
        if destination.exists():
            previous = destination.read_bytes()
            if gzip.decompress(previous) == payload:
                packed = previous
        total_raw += len(payload)
        total_gz += len(packed)
        manifest[mid] = {
            "file": f"site/asset/uniqueskill/scene/{mid}.glb.gz",
            "compression": "gzip",
            "bytes": len(packed),
            **stats,
        }
        if not args.dry_run:
            destination.write_bytes(packed)
        print(f"[{i}/{len(bundles)}] {mid}  nodes={stats['nodes']} "
              f"meshes={stats['meshes']} mats={stats['materials']} "
              f"tex={stats['textures']} pe={stats['emitters']} "
              f"{len(packed)/1024:.0f} KiB")

    # Shared textures are written once, named by content digest, so the 42% of
    # PNG bytes that repeat across scenes are downloaded once and then served
    # from the HTTP cache for every scene that reuses them.
    tex_bytes = 0
    if shared:
        tex_bytes = sum(len(v) for v in shared.values())
        if not args.dry_run:
            tex_dir.mkdir(parents=True, exist_ok=True)
            existing = {p.name for p in tex_dir.glob("*.png")}
            for digest, payload in shared.items():
                name = f"{digest}.png"
                if name not in existing:              # content-addressed: never changes
                    (tex_dir / name).write_bytes(payload)

    # A targeted rebuild must preserve scenes outside the requested subset.
    index_path = out_dir.parent / "scene-index.json"
    if (args.only or args.limit) and index_path.exists():
        previous = json.loads(index_path.read_text(encoding="utf-8"))
        manifest = {**previous.get("scenes", {}), **manifest}
    texture_count = len(shared or {})
    if not args.dry_run:
        texture_count, tex_bytes = texture_totals(args.site_root, manifest)
    index = {
        "textureDir": "site/asset/uniqueskill/texture/" if texture_count else None,
        "textureCount": texture_count,
        "textureBytes": tex_bytes,
        "scenes": manifest,
    }
    if not args.dry_run and manifest:
        index_path.write_text(
            json.dumps(index, ensure_ascii=False, indent=1) + "\n",
            encoding="utf-8")

    print(f"\n{len(manifest)} scenes, {total_raw/1048576:.2f} MiB raw, "
          f"{total_gz/1048576:.2f} MiB gzip")
    if shared is not None:
        print(f"{len(shared)} shared textures, {tex_bytes/1048576:.2f} MiB "
              f"(total download {(total_gz + tex_bytes)/1048576:.2f} MiB)")
    if failures:
        print(f"{len(failures)} failed:")
        for mid, why in failures[:20]:
            print(f"  {mid}: {why}")


if __name__ == "__main__":
    main()
