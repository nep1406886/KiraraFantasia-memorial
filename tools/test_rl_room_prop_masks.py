"""Compare published furniture pixels with the bound original compressed masks."""
import gzip
import io
import json
from pathlib import Path
import struct
import unittest

from PIL import Image, ImageChops
import UnityPy

ROOT = Path(__file__).resolve().parents[1]


def glb_images(key):
    payload = gzip.decompress((ROOT / 'site/asset/rl/native/scene' / (key + '.glb.gz')).read_bytes())
    length = struct.unpack_from('<I', payload, 12)[0]
    document = json.loads(payload[20:20 + length])
    binary = payload[28 + length:]
    result = {}
    for material in document['materials']:
        texture = document['textures'][material['pbrMetallicRoughness']['baseColorTexture']['index']]
        image = document['images'][texture['source']]
        view = document['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        with Image.open(io.BytesIO(binary[start:start + view['byteLength']])) as decoded:
            result[material['name']] = decoded.convert('RGBA')
    return result


class FurnitureMasks(unittest.TestCase):
    def compare(self, key, material_name):
        env = UnityPy.load(str(ROOT / '.codex-tmp/native-rl-bundles' / (key + '.muast')))
        material = next(o.read() for o in env.objects
                        if o.type.name == 'Material' and o.read().m_Name == material_name)
        textures = {name: binding.m_Texture.read() for name, binding in material.m_SavedProperties.m_TexEnvs}
        shader = material.m_Shader.read()
        self.assertEqual(shader.object_reader.read_typetree()['m_ParsedForm']['m_Name'], 'MeigeExt/FakeMeigeShader')
        # The shipped fragment program explicitly samples the green channel.
        self.assertRegex(shader.export(), r'texture(?:2D)?\(_Texture_AlbedoLayer, vs_TEXCOORD0\.xy\)\.y')
        mask = textures['_Texture_AlbedoLayer']
        self.assertTrue(mask.m_Name.endswith('_compa'))
        expected = mask.image.convert('RGBA').getchannel('G')
        self.assertEqual(expected.getextrema(), (0, 255))
        actual = glb_images(key)[material_name]
        self.assertEqual(actual.size, expected.size)
        self.assertIsNone(ImageChops.difference(expected, actual.getchannel('A')).getbbox(),
                          key + ': exported alpha must equal the bound source green channel')
        self.assertIsNone(ImageChops.difference(textures['_Texture_Albedo'].image.convert('RGB'),
                                               actual.convert('RGB')).getbbox(),
                          key + ': restoring alpha must not repaint the original RGB')

    def test_flame_uses_authored_mask_not_orange_card(self):
        self.compare('goods_1041', 'm_Goods_1041_anim')

    def test_logs_keep_the_original_transparent_outline(self):
        self.compare('goods_1041', 'm_Goods_1041')

    def test_grill_smoke_uses_authored_mask_not_grey_card(self):
        self.compare('goods_1044', 'm_Goods_1044')


if __name__ == '__main__':
    unittest.main()
