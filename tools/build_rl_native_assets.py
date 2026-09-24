"""Export native battle effects and town landmarks, separately from ultimates.

Reads SkillList_PL -> SkillActionGraphics -> EffectListDB, not filename guesses.
Each EffectHandler is an independently animated scene, even in a shared bundle.
The source bundles stay in .codex-tmp; only GLB/timeline/manifest go on the site.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import json
import re
from pathlib import Path
import urllib.request
import UnityPy
from export_uniqueskill_scene import SceneExporter, pptr_id
from extract_uniqueskill_timeline import extract, read_scripts

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".codex-tmp" / "native-rl-bundles"
OUT = ROOT / "site" / "asset" / "rl" / "native"
CLASSES = ["fighter", "magician", "priest", "knight", "alchemist"]
ELEMENTS = ["fire", "water", "earth", "wind", "moon", "sun"]
BUILDINGS = ["100000", "110200", "110500", "110700", "111800", "112100",
             "112300", "113000", "113800", "114300", "114500", "114700",
             "120000", "120100", "120200", "120400", "120500"]
COMMON = ["ef_btl_recover_00", "ef_btl_recover_01", "ef_btl_barrier_00",
          "ef_btl_buff_line", "ef_btl_buff_ring", "ef_btl_debuff_line",
          "ef_btl_common_dead", "ef_btl_stun_occur", "ef_btl_dmg_single_00"]


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


def building_affiliations(source=None):
    """TownObjHandleBuild: resource = m_ResourceID * 100 + level - 1.

    Never infer a work from the building's appearance, volume or numeric
    ordering. The original title field is the only affiliation key.
    """
    candidates = [ROOT / "asset" / "rl" / "_raw" / "TownObjectList.json",
                  ROOT / ".codex-tmp" / "db" / "TownObjectList.json"]
    path = Path(source) if source else next((p for p in candidates if p.is_file()), None)
    if path is None or not path.is_file():
        raise FileNotFoundError("TownObjectList.json missing: run tools/fetch_database.py or use --town-table")
    rows = read(path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    resources = {}
    for row in rows:
        resource = row["m_ResourceID"]
        if resource in resources:
            raise ValueError(f"duplicate town resource {resource}")
        resources[resource] = row

    def resolve(key):
        match = re.fullmatch(r"bld_(\d{6})_(\d+)", key)
        if not match:
            raise ValueError(f"invalid town building key {key}")
        resource = int(match.group(1)) // 100
        if resource not in resources:
            raise ValueError(f"missing TownObjectListDB resource {resource}: {key}")
        row = resources[resource]
        return {"table": "TownObjectListDB", "tableSha256": digest,
                "objectId": row["m_ID"], "resourceId": resource,
                "titleType": row["m_TitleType"], "category": row["m_Category"],
                "name": row["m_ObjName"]}
    return resolve


def database():
    env = UnityPy.load(str(ROOT / ".codex-tmp" / "db" / "database.muast"))
    scripts = read_scripts(env)
    result = {}
    for obj in env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        data = obj.read_typetree()
        name = scripts.get(pptr_id(data.get("m_Script")))
        if name in ("SkillActionGraphics", "SkillActionPlan", "EffectListDB"):
            result.setdefault(name, []).append(data)
    return result


def convert(effect, graphics, element):
    # Star.SkillActionUtility.ConvertEffectID, including special motion/grade.
    if "ef_btl_" not in effect:
        return effect
    cls = CLASSES[max(0, graphics["m_SettingClassType"])]
    suffix = effect.split("_")[-1]
    if "_attack_" in effect:
        return f"ef_btl_{cls}_attack_{element}_{suffix}"
    if "_skill_" in effect:
        motion, grade = graphics["m_SettingMotionID"], graphics["m_SettingGrade"]
        return f"ef_btl_{cls}_skill_{motion:02}_{element}_{grade:02}_{suffix}"
    return effect


def download(row):
    dest = CACHE / Path(row["name"]).name
    if dest.exists() and dest.stat().st_size == row["size"] and dest.read_bytes().startswith(b"UnityFS"):
        return dest
    uri = f"https://bucket-{row['path'][-1]}-asset.kirafan.cn/{row['name']}"
    request = urllib.request.Request(uri, headers={"User-Agent": "Kirafan-native-export/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    if len(data) != row["size"] or not data.startswith(b"UnityFS"):
        raise ValueError(f"Invalid source bundle: {row['name']}")
    dest.write_bytes(data)
    return dest


class NativeExporter(SceneExporter):
    """Limit hierarchy and Msb state to one EffectHandler-owned subtree."""
    def __init__(self, bundle, root_go, timeline):
        super().__init__(bundle, timeline=timeline)
        root = self.transform_for_go[root_go]
        selected = set()
        def visit(pid):
            if pid in selected:
                return
            selected.add(pid)
            for child in self.transforms[pid].get("m_Children") or []:
                if pptr_id(child) in self.transforms:
                    visit(pptr_id(child))
        visit(root)
        self.transforms = {pid: data for pid, data in self.transforms.items() if pid in selected}
        self.transform_for_go = {go: pid for go, pid in self.transform_for_go.items() if pid in selected}
        handlers = []
        for obj in self.env.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            data = obj.read_typetree()
            if (self.scripts.get(pptr_id(data.get("m_Script"))) == "MsbHandler"
                    and pptr_id(data.get("m_GameObject")) in self.transform_for_go):
                handlers.append(data)
        if len(handlers) != 1:
            raise ValueError(f"{bundle.name}: expected one MsbHandler per effect, got {len(handlers)}")
        self.msb = handlers[0]


def save_scene(key, exporter, timeline, source):
    blob, stats = exporter.export()
    dest = OUT / "scene" / (key + ".glb.gz")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(gzip.compress(blob, mtime=0))
    entry = {"file": dest.relative_to(ROOT / "site").as_posix(), "compression": "gzip",
             "bytes": dest.stat().st_size, "source": source, **stats}
    if timeline:
        path = OUT / "timeline" / (key + ".json")
        write(path, timeline)
        entry["timeline"] = path.relative_to(ROOT / "site").as_posix()
        entry["duration"] = timeline["duration"]
    return entry


def export_effects(path, row, wanted):
    env = UnityPy.load(str(path))
    scripts = read_scripts(env)
    go = {o.path_id: o.read_typetree().get("m_Name") for o in env.objects if o.type.name == "GameObject"}
    transform = {}
    clips = {}
    handlers = []
    for obj in env.objects:
        if obj.type.name == "Transform":
            transform[pptr_id(obj.read_typetree().get("m_GameObject"))] = obj.path_id
        elif obj.type.name == "MonoBehaviour":
            data = obj.read_typetree()
            cls = scripts.get(pptr_id(data.get("m_Script")))
            if cls == "MeigeAnimClipHolder":
                clips[pptr_id(data.get("m_GameObject"))] = (data.get("m_MeigeAnimClip") or {}).get("m_Name")
            if cls == "EffectHandler":
                handlers.append(data)
    result = {}
    source = {"bundle": row["name"], "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    for data in handlers:
        root_go = pptr_id(data.get("m_GameObject"))
        key = data.get("m_EffectID") or go[root_go]
        if key not in wanted:
            continue
        name = clips.get(root_go)
        if not name:
            raise ValueError(f"{key}: missing original animation holder")
        timeline = extract(path, name, transform[root_go], allow_material_only=True)
        exporter = NativeExporter(path, root_go, timeline)
        result[key] = save_scene(key, exporter, timeline, {**source, "effect": key, "clip": name})
    return result


def export_trails(path):
    env = UnityPy.load(str(path))
    objects = {obj.path_id: obj for obj in env.objects}
    go = {obj.path_id: obj.read_typetree().get("m_Name") for obj in env.objects if obj.type.name == "GameObject"}
    trails = {}
    for obj in env.objects:
        if obj.type.name != "TrailRenderer":
            continue
        data = obj.read_typetree()
        element = go[pptr_id(data["m_GameObject"])]
        if element not in ELEMENTS:
            continue
        material = objects[pptr_id(data["m_Materials"][0])].read_typetree()
        textures = dict(material["m_SavedProperties"]["m_TexEnvs"])
        texture = objects[pptr_id(textures["_Texture_Albedo"]["m_Texture"])].read()
        dest = OUT / "texture" / ("trail_" + element + ".png")
        dest.parent.mkdir(parents=True, exist_ok=True)
        texture.image.save(dest)
        trails[element] = {"file": dest.relative_to(ROOT).as_posix(), "duration": data["m_Time"],
            "width": data["m_Parameters"]["widthMultiplier"], "source": {"bundle": "effect/btl_always.muast",
            "renderer": element, "material": material["m_Name"], "texture": texture.m_Name}}
    return trails


def retain_furniture(manifest, destination):
    """The room-prop exporter owns this namespace; a battle rebuild must not erase it."""
    if not destination.is_file():
        return manifest
    furniture = read(destination).get('furniture', {})
    for key, entry in furniture.items():
        if not re.fullmatch(r'goods_\d+', key) or entry.get('affiliation', {}).get('category') != 5:
            raise ValueError('Invalid room furniture entry: ' + key)
        for field in ('file', 'timeline'):
            if not entry.get(field):
                continue
            path = (ROOT / entry[field]).resolve()
            if not path.is_relative_to(OUT.resolve()) or not path.is_file():
                raise ValueError('Missing/unsafe room furniture output: ' + entry[field])
            if field == 'file' and path.stat().st_size != entry['bytes']:
                raise ValueError('Room furniture size differs from manifest: ' + key)
    if furniture:
        manifest['furniture'] = furniture
    return manifest


# eDmgEffectType (game-source Star/eDmgEffectType.cs) folded by
# SkillActionUtility.ConvertDmgEffectID: an enemy solve event with a damage
# effect plays ef_btl_dmg_enemy_attack_<kind>_<grade>.
ENEMY_DMG_KINDS = {0: "slash", 1: "blow", 2: "bite", 3: "claw"}


def export_enemy_attacks(assets):
    """The enemy attack visuals: 4 kinds x 3 grades, plus the skill->effect map.

    SkillActionPlan rows (database.muast) name the effect per enemy skill; the
    bundles are the original's ef_btl_dmg_enemy_attack_* scenes. Both are
    authored data, nothing is invented here.
    """
    db = database()
    wanted = {f"ef_btl_dmg_enemy_attack_{kind}_{grade:02d}"
              for kind in ENEMY_DMG_KINDS.values() for grade in range(3)}
    packs = {}
    for effect in sorted(wanted):
        name = "effect/" + effect + ".muast"
        if name not in assets:
            raise SystemExit("enemy attack bundle absent from the index: " + name)
        packs[name] = {effect}
    print(f"Enemy attack plan: {len(packs)} bundles", flush=True)
    with ThreadPoolExecutor(max_workers=6) as pool:
        paths = dict(zip(packs, pool.map(download, [assets[name] for name in packs])))
    effects = {}
    for index, (name, ids) in enumerate(packs.items()):
        effects.update(export_effects(paths[name], assets[name], ids))
        print(f"enemy effects {index + 1}/{len(packs)} {name}", flush=True)
    missing = wanted - effects.keys()
    if missing:
        raise SystemExit("enemy attack effects not found in their bundles: " + ", ".join(sorted(missing)))
    skills = {}
    for plan in db["SkillActionPlan"]:
        if not str(plan["m_ID"]).startswith("EN_"):
            continue
        for event in plan["m_evSolve"]:
            if not event["m_IsEnableDamageEffect"]:
                continue
            spec = event["m_DamageEffect"]
            kind = ENEMY_DMG_KINDS.get(spec["m_EffectType"])
            if not kind:
                continue
            grade = min(int(spec["m_Grade"]), 2)
            skills[plan["m_ID"]] = {"effect": f"ef_btl_dmg_enemy_attack_{kind}_{grade:02d}",
                                    "frame": event["m_Frame"]}
            break
    destination = OUT / "enemy-attacks.json"
    write(destination, {"version": 1,
                        "source": "SkillActionPlan m_evSolve / eDmgEffectType / ef_btl_dmg_enemy_attack_*",
                        "effects": effects, "skills": skills})
    print(f"Enemy attacks: {len(effects)} effects, {len(skills)} skills -> {destination}", flush=True)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enemy-attacks", action="store_true",
                        help="Export the enemy damage effects (slash/blow/bite/claw, 3 grades) and the skill->effect map")
    parser.add_argument("--building-affiliations-only", action="store_true",
                        help="Verify and attach original town ownership to existing prefabs; no downloads or scene rebuild")
    parser.add_argument("--town-table", type=Path,
                        help="Explicit original TownObjectList JSON; its byte hash is recorded in the manifest")
    args = parser.parse_args()
    if args.enemy_attacks:
        CACHE.mkdir(parents=True, exist_ok=True)
        assets = {row["name"]: row for row in read(ROOT / ".codex-tmp" / "assetBundle.json")}
        return export_enemy_attacks(assets)
    affiliation = building_affiliations(args.town_table)
    if args.building_affiliations_only:
        destination = OUT / ("sample-index.json" if args.sample else "index.json")
        manifest = read(destination)
        for key, entry in manifest["buildings"].items():
            entry["affiliation"] = affiliation(key)
        write(destination, manifest)
        print(f"Verified {len(manifest['buildings'])} original building affiliations", flush=True)
        return 0
    CACHE.mkdir(parents=True, exist_ok=True)
    assets = {row["name"]: row for row in read(ROOT / ".codex-tmp" / "assetBundle.json")}
    db = database()
    effect_rows = {r["m_EffectID"]: r for r in db["EffectListDB"][0]["m_Params"]}
    raw = read(ROOT / "asset" / "rl" / "_raw" / "SkillList_PL.json")
    skills = read(ROOT / "asset" / "rl" / "skills-rl.json")
    ids = set(skills["player"]) | {str(x["id"]) for x in skills["normalAttacks"].values()}
    skill_graphics = {str(r["m_ID"]): r["m_SAG"] for r in raw if str(r["m_ID"]) in ids}
    selected = set(skill_graphics.values()) - {"Empty", "dummy", ""}
    graphics, wanted, adaptations = {}, set(COMMON), []
    wanted.update(f"ef_btl_dmg_all_{el}_00" for el in ELEMENTS)
    by_graphic = {r["m_ID"]: r for r in db["SkillActionGraphics"]}
    def available(effect):
        pack = effect_rows.get(effect, {}).get("m_PackName") or effect
        return "effect/" + pack + ".muast" in assets
    for row in db["SkillActionGraphics"]:
        if row["m_ID"] not in selected:
            continue
        source_id = row["m_ID"]
        requested_effects = [convert(ev["m_EffectID"], row, el)
            for key, values in row.items() if key.startswith("m_evEffect") or key == "m_evTrailAttach"
            for ev in values if ev.get("m_EffectID") for el in ELEMENTS]
        if any(not available(effect) for effect in requested_effects):
            fallback = by_graphic.get(re.sub(r"_\d+$", "", source_id))
            if fallback:
                adaptations.append({"graphics": source_id, "fallback": fallback["m_ID"],
                    "reason": "Special character effects absent from supplied source index; use the native class graphic, not a fabricated effect."})
                row = fallback
        for element in ELEMENTS:
            events = []
            for kind in ("EffectPlay", "EffectAttach", "EffectProjectile_Straight",
                         "EffectProjectile_Parabola", "EffectProjectile_Penetrate", "TrailAttach"):
                for ev in row.get("m_ev" + kind) or []:
                    effect = convert(ev["m_EffectID"], row, element)
                    events.append({"kind": kind, "effect": effect, "frame": ev["m_Frame"],
                                   "target": ev.get("m_TargetPosType", 0),
                                   "locator": ev.get("m_TargetPosLocatorType", -1),
                                   "offset": ev.get("m_TargetPosOffset", {"x": 0, "y": 0})})
                    wanted.add(effect)
            graphics[source_id + ":" + element] = {"source": row["m_ID"], "events": events}
    packs = {}
    gaps = []
    for effect in sorted(wanted):
        source = effect_rows.get(effect, {})
        pack = source.get("m_PackName") or effect
        name = "effect/" + pack + ".muast"
        if name not in assets:
            gaps.append({"effect": effect, "reason": "source bundle absent", "bundle": name})
            continue
        packs.setdefault(name, set()).add(effect)
    building_names = [f"prefab/town/building/bld_{key}_0.muast" for key in BUILDINGS]
    if args.sample:
        names = {"effect/ef_btl_fighter_attack_fire_00.muast", "effect/ef_btl_magician_skill_01_fire_00.muast",
                 "effect/ef_btl_priest_skill_01_water_00.muast"}
        packs = {name: ids for name, ids in packs.items() if name in names}
        building_names = ["prefab/town/building/bld_110000_0.muast", "prefab/town/building/bld_120200_0.muast"]
        wanted = set().union(*packs.values())
        gaps = [gap for gap in gaps if gap["effect"] in wanted]
    requested = sorted(set(packs) | set(building_names))
    print(f"Native source plan: {len(requested)} bundles, {len(wanted)} effects", flush=True)
    with ThreadPoolExecutor(max_workers=6) as pool:
        paths = dict(zip(requested, pool.map(download, [assets[name] for name in requested])))
    effects, buildings = {}, {}
    for index, (name, ids) in enumerate(packs.items()):
        entries = export_effects(paths[name], assets[name], ids)
        effects.update(entries)
        for missing in ids - entries.keys():
            gaps.append({"effect": missing, "reason": "EffectHandler not found", "bundle": name})
        print(f"effects {index + 1}/{len(packs)} {name}: {len(entries)}", flush=True)
    for name in building_names:
        path = paths[name]
        key = path.stem
        exporter = SceneExporter(path, timeline={"channels": []})
        buildings[key] = save_scene(key, exporter, None,
            {"bundle": name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        buildings[key]["affiliation"] = affiliation(key)
        print("building " + key, flush=True)
    trails = export_trails(CACHE / "btl_always.muast") if (CACHE / "btl_always.muast").exists() else {}
    if len(trails) == 6:
        gaps = [gap for gap in gaps if gap["effect"] != "ef_btl_trail_alchemist"]
        adaptations.append({"effect": "ef_btl_trail_alchemist", "source": "ef_btl_trail / btl_always",
            "reason": "Native six-element TrailRenderer textures; realtime trail geometry replaces Unity TrailRenderer."})
    manifest = {"version": 1, "source": "Kirara Fantasia Unity bundles / SkillActionGraphics / EffectListDB",
                "note": "Native geometry, textures, material/UV tracks and emitter rules. Spatial delivery is adapted to realtime combat.",
                "skills": skill_graphics, "graphics": graphics, "effects": effects, "buildings": buildings,
                "trails": trails, "adaptations": adaptations, "gaps": gaps}
    destination = OUT / ("sample-index.json" if args.sample else "index.json")
    write(destination, retain_furniture(manifest, destination))
    print(f"Exported {len(effects)} effects, {len(buildings)} buildings; {len(gaps)} gaps", flush=True)
    if gaps:
        print(json.dumps(gaps, ensure_ascii=False), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
