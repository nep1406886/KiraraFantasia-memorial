"""Identity and reproducibility gates for original currency and authored equipment art."""
import hashlib
import json
import unittest
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageChops
import UnityPy
import fetch_rl_icons as build

ROOT = Path(__file__).resolve().parents[1]
DROP = ROOT / 'site/asset/img/rl/drop'
EQUIPMENT = ROOT / 'site/asset/img/rl/equipment'
EXPECTED = {'GemIcon': 'star', 'GoldIcon': 'coin', 'IconFrame': 'equipment-frame',
            'CMD_SkillSP': 'skill-special'}
TITLES = {'slot-weapon': '武器', 'slot-amulet': '护符', 'slot-armor': '护甲', 'slot-charm': '饰品',
          'gadget-rhythm': '轻击腕带', 'gadget-strider': '游走护符', 'gadget-reach': '延展刻印',
          'gadget-wide': '宽弧指环', 'gadget-aim': '瞄准饰章', 'gadget-sentry': '守望机关',
          'gadget-hunter': '巡猎罗盘', 'gadget-steady': '定心机关',
          'gadget-prism': '无相罗盘', 'gadget-binding': '缚技罗盘'}


class ItemArtTests(unittest.TestCase):
    def test_currency_and_skill_source_are_not_item_consumables(self):
        for sprite, filename in EXPECTED.items():
            with self.subTest(sprite=sprite):
                self.assertEqual(build.ATLAS_SPRITES.get(sprite), filename)
        self.assertNotIn('star-shard', getattr(build, 'ITEM_ICONS', {}).values())
        self.assertNotIn('star-shard', build.ATLAS_SPRITES.values())

    def test_currency_pixels_match_named_original_sprites(self):
        manifest = json.loads((DROP / 'provenance.json').read_text(encoding='utf8'))
        atlas = ROOT / '.cache/t22j_src/commonuiatlas.muast'
        self.assertEqual(manifest['source']['sha256'], hashlib.sha256(atlas.read_bytes()).hexdigest())
        seen = set()
        for obj in UnityPy.load(str(atlas)).objects:
            if obj.type.name != 'Sprite':
                continue
            sprite = obj.read()
            if sprite.m_Name not in EXPECTED:
                continue
            name = EXPECTED[sprite.m_Name] + '.webp'
            record = manifest['assets'][name]
            self.assertEqual(record['sprite'], sprite.m_Name)
            self.assertEqual(record['pathId'], str(obj.path_id))
            original = sprite.image.convert('RGBA')
            side = max(original.size)
            expected = Image.new('RGBA', (side, side))
            expected.paste(original, ((side - original.width) // 2, (side - original.height) // 2))
            expected = expected.resize((96, 96), Image.Resampling.LANCZOS)
            actual = Image.open(DROP / name).convert('RGBA')
            # Transparent RGB values may be normalised by lossless WebP.
            for background in ['black', 'white']:
                a = Image.new('RGBA', (96, 96), background); a.alpha_composite(actual)
                b = Image.new('RGBA', (96, 96), background); b.alpha_composite(expected)
                self.assertIsNone(ImageChops.difference(a, b).convert('RGB').getbbox(), name)
            seen.add(sprite.m_Name)
        self.assertEqual(seen, set(EXPECTED))

    def test_cursor_is_small_transparent_crystal_with_a_real_tip(self):
        manifest = json.loads((DROP / 'provenance.json').read_text(encoding='utf8'))
        cursor = manifest['cursor']; x, y = cursor['hotspot']
        self.assertEqual(cursor['sprite'], 'GemIcon')
        images = [Image.open(ROOT / path).convert('RGBA') for path in cursor['files']]
        self.assertEqual(len(images), 2)
        self.assertNotEqual(images[0].tobytes(), images[1].tobytes())
        for image in images:
            self.assertEqual(image.size, (32, 32))
            self.assertGreater(image.getpixel((x, y))[3], 127)
            self.assertEqual(image.getpixel((31, 31))[3], 0)
        self.assertLess(y, 6)
        self.assertLess(x, 12)
        css = (ROOT / 'css/kirara-cursor.css').read_text(encoding='utf8')
        self.assertIn(') %d %d,' % (x, y), css)
        self.assertIn('(pointer: fine)', css)
        self.assertIn('cursor: text', css)
        self.assertIn('cursor: not-allowed', css)

    def test_authored_icons_are_explicit_distinct_safe_vectors(self):
        hashes = set()
        for name, title in TITLES.items():
            with self.subTest(name=name):
                data = (EQUIPMENT / (name + '.svg')).read_bytes()
                svg = ET.fromstring(data)
                self.assertEqual(svg.attrib.get('viewBox'), '0 0 96 96')
                self.assertEqual(svg.find('{http://www.w3.org/2000/svg}title').text, title)
                self.assertIn('kirafan-timer original', data.decode('utf8'))
                for node in svg.iter():
                    self.assertNotIn(node.tag.rsplit('}', 1)[-1], ['script', 'foreignObject', 'image', 'text'])
                    self.assertFalse(any(k.endswith('href') or k.startswith('on') for k in node.attrib))
                hashes.add(hashlib.sha256(data).hexdigest())
        self.assertEqual(len(hashes), len(TITLES))


if __name__ == '__main__':
    unittest.main()
