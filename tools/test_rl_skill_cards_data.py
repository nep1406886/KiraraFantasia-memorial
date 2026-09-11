"""CARD generator contracts; authored-table checks require the fetch cache."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_rl_data as build


class SkillCardDataTests(unittest.TestCase):
    def source(self, args=None):
        return {"id": 123, "effects": [{"kind": 21, "target": 4,
                "args": [3, 10005] if args is None else args}]}

    def raw(self, filename):
        return [{"m_ID": 10005, "m_SkillName": "card", "m_SkillDetail": "",
                 "m_SkillType": 5, "m_Recasts": [0, 0, 0], "m_LoadFactors": [1, 1, 1]}] \
            if filename == "SkillList_CARD.json" else [{"m_ID": 10005, "m_Datas": [
                {"m_Type": 1, "m_Target": 4, "m_Args": [20]}]}]

    def test_invalid_reference_is_not_coerced_to_another_card(self):
        with patch.object(build, "load_table", side_effect=self.raw):
            for args in ([3, 10005.9], [3, "10005"], [3, True], [3, 0], [3, -1], [3]):
                with self.subTest(args=args), self.assertRaises(ValueError):
                    build.build_skill_cards([self.source(args)])

    def test_missing_row_or_content_fails_closed(self):
        for absent in ("SkillList_CARD.json", "SkillContentList_CARD.json"):
            with self.subTest(absent=absent), patch.object(build, "load_table",
                    side_effect=lambda name: [] if name == absent else self.raw(name)):
                with self.assertRaisesRegex(ValueError, "missing CARD.*10005"):
                    build.build_skill_cards([self.source()])

    def test_namespace_is_card_and_duplicate_refs_do_not_duplicate_payloads(self):
        with patch.object(build, "load_table", side_effect=self.raw) as load:
            result = build.build_skill_cards([self.source(), self.source()])
        self.assertEqual(list(result), ["10005"])
        self.assertEqual(result["10005"]["source"], "CARD")
        self.assertEqual(result["10005"]["effects"], [{"kind": 1, "target": 4, "args": [20]}])
        self.assertEqual({call.args[0] for call in load.call_args_list},
                         {"SkillList_CARD.json", "SkillContentList_CARD.json"})

    def test_field_only_refresh_preserves_every_other_field_and_is_idempotent(self):
        table = {"recastSeconds": .35, "turnSeconds": 2.8, "normalAttacks": {},
                 "player": {"123": self.source()}, "enemy": {"777": {"effects": []}},
                 "futureMetadata": {"retain": [1, 2, 3]}}
        with tempfile.TemporaryDirectory() as folder, patch.object(build, "OUT", Path(folder)), \
                patch.object(build, "ROOT", Path(folder)), \
                patch.object(build, "load_table", side_effect=self.raw):
            path = Path(folder) / "skills-rl.json"
            path.write_text(json.dumps(table), encoding="utf-8")
            (Path(folder) / "weapons-rl.json").write_text('{"childSkills":{}}', encoding="utf-8")
            build.refresh_skill_cards()
            first = path.read_bytes()
            result = json.loads(first)
            self.assertEqual({k: v for k, v in result.items() if k != "skillCards"}, table)
            self.assertEqual(list(result["skillCards"]), ["10005"])
            build.refresh_skill_cards()
            self.assertEqual(path.read_bytes(), first)

    def test_weapon_children_participate_in_reference_set(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(build, "OUT", Path(folder)), \
                patch.object(build, "load_table", side_effect=self.raw):
            (Path(folder) / "weapons-rl.json").write_text(
                json.dumps({"childSkills": {"123": self.source()}}), encoding="utf-8")
            self.assertEqual(list(build.referenced_skill_cards({})), ["10005"])

    def test_failed_refresh_does_not_touch_shipped_file(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(build, "OUT", Path(folder)), \
                patch.object(build, "load_table", return_value=[]):
            path = Path(folder) / "skills-rl.json"
            path.write_text(json.dumps({"player": {"123": self.source()}}), encoding="utf-8")
            before = path.read_bytes()
            (Path(folder) / "weapons-rl.json").write_text('{"childSkills":{}}', encoding="utf-8")
            with self.assertRaises(ValueError):
                build.refresh_skill_cards()
            self.assertEqual(path.read_bytes(), before)

    @unittest.skipUnless((build.RAW / "SkillList_CARD.json").exists()
                         and (build.RAW / "SkillContentList_CARD.json").exists(), "CARD fetch cache missing")
    def test_shipped_rows_are_exact_authored_projection(self):
        table = json.loads((build.OUT / "skills-rl.json").read_text(encoding="utf-8"))
        before = copy.deepcopy(table)
        result = build.referenced_skill_cards(table)
        self.assertEqual(table, before)
        self.assertEqual(result, table["skillCards"])
        rows = {r["m_ID"]: r for r in build.load_table("SkillList_CARD.json")}
        content = {r["m_ID"]: r for r in build.load_table("SkillContentList_CARD.json")}
        self.assertEqual(len(result), 34)
        for key, card in result.items():
            with self.subTest(card=key):
                raw = rows[int(key)]
                self.assertEqual(card["name"], raw["m_SkillName"])
                self.assertEqual(card["loadFactors"], raw["m_LoadFactors"])
                self.assertEqual(card["effects"], [{"kind": e["m_Type"], "target": e["m_Target"],
                    "args": e["m_Args"]} for e in content[int(key)]["m_Datas"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
