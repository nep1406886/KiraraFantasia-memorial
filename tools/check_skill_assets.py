"""Original skill texture masks, scene dependency closure and reproducible export."""
import gzip
import json
import struct
import numpy as np
from pathlib import Path
from types import SimpleNamespace as NS

from PIL import Image
from export_uniqueskill_scene import SceneExporter, texture_totals, normalized_vertex_colors

ROOT = Path(__file__).resolve().parents[1]


def masks():
    white = NS(m_Name="white_rgb", image=Image.new("RGBA", (2, 2), "white"))
    masks = {"white_a": Image.new("RGBA", (2, 2), (0, 0, 0, 255)),
             "star_mask": Image.new("RGBA", (64, 64), (0, 0, 0, 0)),
             "ring_mask": Image.new("RGBA", (32, 32), (0, 0, 0, 0))}
    masks["star_mask"].putpixel((10, 10), (255, 255, 255, 255))
    masks["ring_mask"].putpixel((20, 20), (255, 255, 255, 128))
    captured = {}

    def capture(image, name, shared):
        captured[name] = image.copy()
        return len(captured) - 1

    material_objects = []
    states = {}
    for index, name in enumerate(["star_mask", "ring_mask", "suffix_fallback"]):
        material = NS(m_Name=name, m_SavedProperties=NS(m_TexEnvs=[
            ("_Texture_Albedo", NS(m_Texture=NS(read=lambda: white)))]))
        material_objects.append(NS(type=NS(name="Material"), path_id=index,
                                   read=lambda material=material: material))
        states[name] = {"textures": [] if name == "suffix_fallback" else [
            {"name": name, "layer": 1, "layerBlendModeAlpha": 5}]}
    exporter = SceneExporter.__new__(SceneExporter)
    exporter.env = NS(objects=material_objects)
    exporter.shared_textures = {}
    exporter.texture_images = lambda: masks
    exporter.msb_material_state = lambda: states
    exporter.builder = NS(add_png=capture, document={"materials": []})
    exporter.add_materials()
    assert captured["star_mask"].size == (64, 64)
    assert captured["star_mask"].getpixel((0, 0))[3] == 0
    assert captured["star_mask"].getpixel((10, 10))[3] == 255
    assert captured["ring_mask"].size == (32, 32)
    assert captured["ring_mask"].getpixel((20, 20))[3] == 128
    assert captured["suffix_fallback"].size == (2, 2)
    assert captured["suffix_fallback"].getpixel((0, 0))[3] == 255
    print("PASS authored masks override the shared RGB name and retain resolution")


def scene_closure():
    index = json.loads((ROOT / "site/asset/uniqueskill/scene-index.json").read_text(encoding="utf-8"))
    scenes = index["scenes"]
    textures, size = texture_totals(ROOT, scenes)
    assert textures == index["textureCount"], (textures, index["textureCount"])
    assert size == index["textureBytes"], (size, index["textureBytes"])
    for rid, entry in scenes.items():
        payload = (ROOT / entry["file"]).read_bytes()
        assert len(payload) == entry["bytes"], rid
        glb = gzip.decompress(payload)
        length = struct.unpack_from("<I", glb, 12)[0]
        document = json.loads(glb[20:20+length])
        layered=sum(bool(m.get('extras',{}).get('msb',{}).get('layerTexture')) for m in document.get('materials',[]))
        assert layered==entry.get('layeredMaterials',0),(rid,'stale layer index',layered,entry.get('layeredMaterials'))
        for material in document.get('materials',[]):
            layer=material.get('extras',{}).get('msb',{}).get('layerTexture')
            if layer:assert 0<=layer['index']<len(document['textures']),(rid,material['name'])
        binary_offset = 20 + length + 8
        for mesh in document.get("meshes", []):
            for primitive in mesh["primitives"]:
                material=document['materials'][primitive.get('material',0)]
                if material.get('extras',{}).get('msb',{}).get('layerTexture'):
                    assert 'TEXCOORD_1' in primitive['attributes'],(rid,mesh['name'],'missing layer UV')
                color_index = primitive["attributes"].get("COLOR_0")
                if color_index is None:
                    continue
                accessor = document["accessors"][color_index]
                view = document["bufferViews"][accessor["bufferView"]]
                assert accessor["componentType"] == 5126, (rid, mesh["name"])
                colors = np.frombuffer(glb, dtype="<f4", count=accessor["count"] * 4,
                    offset=binary_offset + view.get("byteOffset", 0) + accessor.get("byteOffset", 0))
                assert np.isfinite(colors).all() and colors.min() >= 0 and colors.max() <= 1, (
                    rid, mesh["name"], "COLOR_0 outside glTF [0,1]", float(colors.min()), float(colors.max()))
        for emitter in document["scenes"][0].get("extras", {}).get("emitters", []):
            if emitter.get("material") is not None:
                assert emitter["material"] < len(document["materials"]), (rid, emitter["name"])
    print("PASS %d scenes, %d referenced textures, %.2f MiB; no missing dependency" %
          (len(scenes), textures, size/1048576))
    bundle = ROOT / ".codex-tmp/pe_bundles_named/uniqueskill_pl_100003_0.muast"
    if bundle.exists():
        payload, _ = SceneExporter(bundle, {}).export()
        actual = (ROOT / scenes["100003"]["file"]).read_bytes()
        assert gzip.compress(payload, 9, mtime=0) == actual
        print("PASS scene 100003 rebuild is byte-identical")
    else:
        print("SKIP original bundle not present: deterministic scene rebuild")


def playback_coverage():
    playback = json.loads((ROOT / "site/asset/battle/skill-playback.json").read_text(encoding="utf-8"))["models"]
    scenes = json.loads((ROOT / "site/asset/uniqueskill/scene-index.json").read_text(encoding="utf-8"))["scenes"]
    timelines = json.loads((ROOT / "site/asset/uniqueskill/timeline-index.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "site/asset/models/manifest.json").read_text(encoding="utf-8"))
    required = {str(row["ultimate"]["sceneId"]) for row in playback.values()
                if row.get("ultimate") and row["ultimate"].get("sceneId")}
    assert not required - set(scenes), ("missing scenes", sorted(required - set(scenes)))
    assert not required - set(timelines), ("missing timelines", sorted(required - set(timelines)))
    actions = manifest["skillActions"]
    assert not required - set(actions), ("missing owner motions", sorted(required - set(actions)))
    invalid = []
    for rid in sorted(required):
        entry = actions[rid]
        payload = (ROOT / entry["file"].split("?", 1)[0]).read_bytes()
        if entry.get("compression") == "gzip":
            payload = gzip.decompress(payload)
        length = struct.unpack_from("<I", payload, 12)[0]
        document = json.loads(payload[20:20+length])
        assert any(clip.get("name") == "skill" and clip.get("channels")
                   for clip in document.get("animations", [])), (rid, "empty owner motion")
        for clip in document.get('animations', []):
            if clip.get('name') != 'skill':
                continue
            for sampler in clip['samplers']:
                for field in ('input', 'output'):
                    accessor = document['accessors'][sampler[field]]
                    view = document['bufferViews'][accessor['bufferView']]
                    assert accessor['componentType'] == 5126, (rid, 'non-float animation')
                    assert 'EXT_meshopt_compression' not in view.get('extensions', {}), (rid, 'compressed animation requires decoding')
                    width = {'SCALAR':1, 'VEC2':2, 'VEC3':3, 'VEC4':4}[accessor['type']]
                    values = np.ndarray((accessor['count'], width), dtype='<f4', buffer=payload,
                        offset=28+length+view.get('byteOffset',0)+accessor.get('byteOffset',0),
                        strides=(view.get('byteStride', width*4), 4))
                    if not np.isfinite(values).all():
                        invalid.append((rid, field, sampler[field], 'non-finite owner motion'))
    assert not invalid, invalid
    generic = sum(bool(row.get("ultimate")) and not row["ultimate"].get("sceneId")
                  for row in playback.values())
    print(f"PASS {len(required)} original scenes have scene/timeline/owner-motion dependencies; "
          f"all owner-motion values/tangents finite; {generic} model identities use authored class actions")


if __name__ == "__main__":
    assert np.allclose(normalized_vertex_colors([[0, 1, 128, 255]]), [[0, 1/255, 128/255, 1]])
    assert np.allclose(normalized_vertex_colors([[0.0, 0.25, 0.5, 1.0]]), [[0, .25, .5, 1]])
    print("PASS byte colors normalize once; float colors remain unchanged")
    masks()
    scene_closure()
    playback_coverage()
