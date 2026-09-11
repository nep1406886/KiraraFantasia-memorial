"""Publish original skill/action/scene identities without changing other game data.

python tools/build_skill_playback.py [--check]
"""
import json
import sys
from pathlib import Path

from build_rl_data import convert_skill, load_table, load_cards_js

ROOT = Path(__file__).resolve().parents[1]


def build(check=False):
    rows = {r["m_ID"]: r for r in load_table("SkillList_PL.json")}
    content = {r["m_ID"]: r["m_Datas"] for r in load_table("SkillContentList_PL.json")}
    characters = {r["m_CharaID"]: r for r in load_table("CharacterList.json")}
    path = ROOT / "site/asset/rl/skills-rl.json"
    table = json.loads(path.read_text(encoding="utf-8"))
    wanted = {int(k) for k in table["player"]}
    for card in load_cards_js():
        base = characters.get(card["id"])
        evolved = characters.get(card.get("evolvedId"))
        if base and evolved and base["m_CharaSkillID"] in wanted:
            wanted.add(evolved["m_CharaSkillID"])
            wanted.update(evolved["m_ClassSkillIDs"])
    for skill_id in sorted(wanted):
        if skill_id not in rows:
            continue
        converted = convert_skill(rows[skill_id], content.get(skill_id, []), enemy=False)
        existing = table["player"].get(str(skill_id))
        if existing is None:
            existing = dict(converted, id=skill_id)
            table["player"][str(skill_id)] = existing
        existing.update({key: converted[key] for key in ("sceneId", "action")})

    models, card_identities = {}, {}
    for character in characters.values():
        def identity(skill_id):
            row = rows.get(skill_id)
            if not row:
                return None
            converted = convert_skill(row, content.get(skill_id, []), enemy=False)
            return {"id": skill_id, "sceneId": converted["sceneId"], "action": converted["action"]}
        entry = {
            "cardId": character["m_CharaID"],
            "ultimate": identity(character["m_CharaSkillID"]),
            "skills": [identity(i) for i in character["m_ClassSkillIDs"]],
        }
        models[str(character["m_ResourceID"])] = entry
        card_identities[str(character["m_CharaID"])] = {
            **entry, "resourceId": character["m_ResourceID"],
        }
    outputs = {
        path: table,
        ROOT / "site/asset/battle/skill-playback.json": {
            "version": 2, "source": "CharacterList + SkillList_PL", "models": models,
            "cards": card_identities,
        },
    }
    for target, payload in outputs.items():
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        if check:
            if not target.exists() or json.loads(target.read_text(encoding="utf-8")) != payload:
                raise SystemExit("stale: " + str(target.relative_to(ROOT)))
        else:
            target.write_text(text, encoding="utf-8")
    print(f"skill playback: {len(models)} models; {len(card_identities)} exact cards; {len(table['player'])} player rows")


if __name__ == "__main__":
    build("--check" in sys.argv)
