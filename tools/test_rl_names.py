"""Display-name corrections must survive both a fresh build and a re-bake."""
import copy
import json
import unittest
from pathlib import Path

import rl_bake_profiles as profiles


class DisplayNameTests(unittest.TestCase):
    def test_fresh_and_previously_baked_names_are_canonical_and_idempotent(self):
        for spelling in ("後藤 ひとり", "后藤一里", "后藤 一里"):
            for card_id in (46002000, 46002001):
                with self.subTest(spelling=spelling, card_id=card_id):
                    card = {"id": card_id, "name": "後藤 ひとり",
                            "nameZh": spelling, "characterZh": spelling,
                            "skillIds": {"chara": 460020000}}
                    original = copy.deepcopy(card)
                    profiles.normalize_card_name(card)
                    self.assertEqual(card["characterZh"], "后藤 一里")
                    self.assertEqual(card["nameZh"], "后藤 一里")
                    self.assertEqual(card["id"], original["id"])
                    self.assertEqual(card["skillIds"], original["skillIds"])
                    first = copy.deepcopy(card)
                    profiles.normalize_card_name(card)
                    self.assertEqual(card, first)

    def test_other_names_and_card_titles_are_not_rewritten(self):
        for card in ({"name": "九条 カレン", "characterZh": "九条 可怜", "nameZh": "九条 可怜"},
                     {"name": "後藤 ひとり", "characterZh": "后藤一里", "nameZh": "后藤 一里【纪念】"}):
            expected = card["nameZh"]
            profiles.normalize_card_name(card)
            self.assertEqual(card["nameZh"], expected)

    def test_shipped_cards_and_profile_join_use_the_same_name(self):
        path = Path(profiles.OUT) / "cards-rl.json"
        cards = json.loads(path.read_text(encoding="utf-8"))["cards"]
        hitori = [card for card in cards if card["id"] in (46002000, 46002001)]
        self.assertEqual(len(hitori), 2)
        for card in hitori:
            self.assertEqual(card["characterZh"], "后藤 一里")
            self.assertEqual(card["nameZh"], "后藤 一里")
            self.assertEqual(card["profileZh"], profiles.PROFILE_ZH["后藤 一里"])


if __name__ == "__main__":
    unittest.main()
