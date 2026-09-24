"""Read-only catalogue census. Writes only new defense research documents.

This reports evidence coverage, never certifies an untested character as playable.
No guessed card IDs, weapon IDs, evolution edges, or costume names.
"""
import json
from pathlib import Path
from hashlib import sha256
from collections import Counter

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
OUT = ROOT / "docs/etowaria-defense/research"


def read(relative):
    path = ROOT / relative
    data = path.read_bytes()
    return json.loads(data), {"path": relative, "sha256": sha256(data).hexdigest()}


def exists(file):
    return bool(file and (SITE / file.split("?")[0]).is_file())


def main():
    sources = []
    tables = {}
    for name in ["NamedList", "CharacterList", "CharacterEvolutionList", "WeaponList", "CharacterWeaponList"]:
        tables[name], source = read(f"site/asset/rl/_raw/{name}.json")
        sources.append(source)
    overrides, source = read("site/asset/game/_raw/CharacterWeaponOverride.json")
    sources.append(source)
    manifest, source = read("site/asset/models/manifest.json")
    sources.append(source)
    playable, source = read("site/etowaria-defense/data/units.json")
    sources.append(source)
    voices, source = read("site/asset/rl/voices.json")
    sources.append(source)
    scene_index, source = read("site/asset/uniqueskill/scene-index.json")
    sources.append(source)
    current = {unit["cardId"]: unit for unit in playable["units"]}
    cards = tables["CharacterList"]
    names = {row["m_NamedType"]: row for row in tables["NamedList"]}
    weapons = {row["m_ID"]: row for row in tables["WeaponList"]}
    links = {row["m_CharaID"]: row for row in tables["CharacterWeaponList"]}
    evolutions = tables["CharacterEvolutionList"]
    records = []
    for card in cards:
        cid, rid = card["m_CharaID"], card["m_ResourceID"]
        model = manifest["models"].get(f"model/player/model_pl_{rid}.muast") or {}
        action = manifest["classActions"].get(f"{card['m_Class']}:{card['m_HeadID']}") or {}
        skill_action = manifest.get("skillActions", {}).get(str(rid)) or {}
        scene = scene_index["scenes"].get(str(rid)) or {}
        voice = voices.get(str(rid)) or {}
        link = links.get(cid)
        weapon = weapons.get(link["m_WeaponID"]) if link else None
        records.append({
            "cardId": cid, "namedType": card["m_NamedType"], "resourceId": rid,
            "originalCardName": card["m_Name"],
            "originalFullName": names.get(card["m_NamedType"], {}).get("m_FullName"),
            "verifiedDisplayNameZh": current.get(cid, {}).get("name"),
            "classId": card["m_Class"], "elementId": card["m_Element"],
            "rarityRaw": card["m_Rare"], "headId": card["m_HeadID"], "bodyId": card["m_BodyID"],
            "voiceLabel": card["m_CRILabel"], "costumeLabel": None,
            "costumeNote": "voiceLabel is evidence, not an approved costume title",
            "skillIds": [card["m_CharaSkillID"], *card["m_ClassSkillIDs"]],
            "evolvesTo": sorted({edge["m_DestCharaID"] for edge in evolutions if edge["m_SrcCharaID"] == cid}),
            "evolvesFrom": sorted({edge["m_SrcCharaID"] for edge in evolutions if edge["m_DestCharaID"] == cid}),
            "dedicatedWeapon": None if not weapon else {"unlock": link, "weaponId": weapon["m_ID"],
                "name": weapon["m_WeaponName"], "classId": weapon["m_ClassType"], "controlType": weapon["m_ControllType"],
                "resourceIdL": weapon["m_ResourceID_L"], "resourceIdR": weapon["m_ResourceID_R"],
                "equipableCardId": weapon["m_EquipableCharaID"]},
            "coverage": {"modelListed": bool(model), "modelOnDisk": exists(model.get("file")),
                "facialListed": bool(model.get("facial")), "facialOnDisk": exists(model.get("facial")),
                "classActionsOnDisk": exists(action.get("file")), "skillActionsOnDisk": exists(skill_action.get("file")),
                "cardArtOnDisk": exists(f"asset/img/rl/card/{cid}.webp"),
                "iconOnDisk": exists(f"asset/img/rl/icon/{cid}.webp"),
                "ultimateSceneOnDisk": exists(scene.get("file")), "voiceMapped": bool(voice.get("cues")),
                "voiceAllMappedCuesOnDisk": bool(voice.get("cues")) and all(exists("audio/voice/" + file) for file in voice["cues"].values())},
            "status": "current-observer-card" if cid in current else "catalogue-only-unverified",
            "playableInFirstThree": cid in [16002001, 17002001, 30002001, 10002001]
        })
    weapon_records = []
    for weapon in weapons.values():
        resources = sorted({value for value in [weapon["m_ResourceID_L"], weapon["m_ResourceID_R"]] if value > 0})
        weapon_records.append({"weaponId": weapon["m_ID"], "originalName": weapon["m_WeaponName"],
            "classId": weapon["m_ClassType"], "resourceIdL": weapon["m_ResourceID_L"], "resourceIdR": weapon["m_ResourceID_R"],
            "controlType": weapon["m_ControllType"], "animationType": weapon["m_ClassAnimType"],
            "evolvedCount": weapon["m_EvolvedCount"], "equipableCardId": weapon["m_EquipableCharaID"],
            "skillId": weapon["m_SkillID"], "passiveSkillId": weapon["m_PassiveSkillID"],
            "models": [{"resourceId": rid, "onDisk": exists((manifest["models"].get(f"model/weapon/wpn_{rid}.muast") or {}).get("file"))} for rid in resources]})
    summary = {
        "date": "2026-09-25", "method": "Local source-table snapshot and file existence; NOT all-character visual/gameplay acceptance",
        "sources": sources,
        "counts": {"identityRows": len(names), "cardRows": len(cards), "distinctModelResourceIds": len({row['resourceId'] for row in records}),
            "weaponRows": len(weapons), "characterWeaponLinks": len(tables["CharacterWeaponList"]), "evolutionRows": len(evolutions),
            "weaponOverrideRows": len(overrides), "weaponModelEntries": sum(key.startswith("model/weapon/") for key in manifest["models"]),
            "currentObserverCards": len(current), "currentBattleCards": 4},
        "coverageByCardRow": {key: sum(row["coverage"][key] for row in records) for key in records[0]["coverage"]},
        "classDistribution": dict(Counter(row["classId"] for row in records)),
        "examples": {name: [row for row in records if row["namedType"] == identity] for name, identity in [("本田珠辉",46),("保登心爱",116)]},
        "weaponOverrides": overrides,
        "limits": ["Record counts include evolutions, rarities and alternate classes; not 1281 unique people",
            "Shared model resources do not imply identical card skills or weapons",
            "Manifest/file existence is not visual verification", "Voice labels do not alone establish costume names",
            "CharacterWeaponOverride describes animation/effect overrides, not default equipment"]
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for file, data in [("full-roster-census.json", summary), ("full-roster-cards.json", records), ("full-roster-weapons.json", weapon_records)]:
        (OUT / file).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"counts": summary["counts"], "coverageByCardRow": summary["coverageByCardRow"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
