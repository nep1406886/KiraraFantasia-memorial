"""A battle-assets rebuild preserves the independently exported room furniture."""
import copy
import json
import unittest
from unittest.mock import patch
import build_rl_native_assets as builder


class FurnitureManifestTest(unittest.TestCase):
    def test_shipped_furniture_survives_battle_rebuild(self):
        path = builder.OUT / 'index.json'
        before = json.loads(path.read_text(encoding='utf8'))
        rebuilt = {'effects': {'new-effect': {}}, 'buildings': {}}
        result = builder.retain_furniture(rebuilt, path)
        self.assertEqual(result['furniture'], before['furniture'])
        self.assertEqual(result['effects'], {'new-effect': {}})

    def test_dangling_or_outside_paths_are_not_silently_carried(self):
        path = builder.OUT / 'index.json'
        data = json.loads(path.read_text(encoding='utf8'))
        for target in ['missing.glb.gz', '../outside.glb.gz']:
            broken = copy.deepcopy(data)
            broken['furniture']['goods_1072']['file'] = target
            with patch.object(builder, 'read', return_value=broken):
                with self.assertRaises(ValueError):
                    builder.retain_furniture({}, path)


if __name__ == '__main__':
    unittest.main()
