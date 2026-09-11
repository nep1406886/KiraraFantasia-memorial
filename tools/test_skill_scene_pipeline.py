"""Offline regression tests for the original-scene asset pipeline."""
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import build_skill_scene_catalog as catalog
from export_uniqueskill_scene import normalized_vertex_colors, needs_layer_texture
from convert_kirafan_model import finite_curve_keys
import rl_fetch_us_bundles as fetcher


class ScenePipelineTests(unittest.TestCase):
    def test_stationary_unity_step_has_finite_exact_tangents(self):
        keys = [dict(time=0, value={'x':1.,'y':2.}, inSlope={'x':0.,'y':3.}, outSlope={'x':float('inf'),'y':4.}),
                dict(time=1, value={'x':1.,'y':5.}, inSlope={'x':float('inf'),'y':6.}, outSlope={'x':0.,'y':7.})]
        clean = finite_curve_keys(keys)
        self.assertEqual(clean[0]['outSlope'], {'x':0.,'y':4.})
        self.assertEqual(clean[1]['inSlope'], {'x':0.,'y':6.})
        self.assertEqual(keys[0]['outSlope']['x'], float('inf'))
        self.assertIs(finite_curve_keys(clean), clean)
        keys[1]['value']['x'] = 3.
        with self.assertRaisesRegex(ValueError, 'changing stepped'):
            finite_curve_keys(keys)
        keys[0]['outSlope']['x'] = keys[1]['inSlope']['x'] = float('nan')
        with self.assertRaisesRegex(ValueError, 'invalid animation tangent'):
            finite_curve_keys(keys)

    def test_layer_baking_requires_identical_uv_and_blend(self):
        base={"type":0,"layer":0,"coverageUV":[1,1],"translationUV":[0,0],"offsetUV":[0,0],"rotateUV":0}
        layer={**base,"layer":1,"layerBlendMode":6,"layerBlendModeAlpha":5}
        state={"textures":[base,layer]}
        self.assertFalse(needs_layer_texture(state,[],"material"))
        channel={"name":"material","target":"texOffsetUV","comp":0,"p":[0,0,0],"keys":[[0,0,0],[30,1,0]]}
        self.assertTrue(needs_layer_texture(state,[channel],"material"))
        self.assertFalse(needs_layer_texture(state,[channel,{**channel,"p":[0,0,1]}],"material"))
        layer["offsetUV"]=[0,.25]
        self.assertTrue(needs_layer_texture(state,[],"material"))
        layer["offsetUV"]=[0,0];layer["layerBlendMode"]=4
        self.assertTrue(needs_layer_texture(state,[],"material"))

    def test_byte_and_float_color_domains(self):
        np.testing.assert_allclose(normalized_vertex_colors([[0,1,128,255]]),[[0,1/255,128/255,1]])
        np.testing.assert_allclose(normalized_vertex_colors([[0.,.25,.5,1.]]),[[0,.25,.5,1]])
        with self.assertRaises(ValueError):
            normalized_vertex_colors([[256,0,0,255]])
        with self.assertRaises(ValueError):
            normalized_vertex_colors([[float('nan'),0.,0.,1.]])

    def test_scene_identity_never_guesses_a_sibling(self):
        playback={"models":{
            "100000":{"cardId":1,"ultimate":{"sceneId":None}},
            "380003":{"cardId":2,"ultimate":{"sceneId":"380001"}},
            "460001":{"cardId":3,"ultimate":{"sceneId":"460001"}},
            "380004":{"cardId":4,"ultimate":{"sceneId":"380001"}},
        }}
        self.assertEqual(fetcher.scene_ids(playback,[1]),[])
        self.assertEqual(fetcher.scene_ids(playback,[2]),['380001'])
        self.assertEqual(fetcher.scene_ids(playback),['380001','460001'])
        playback['models']['380003']['ultimate']['sceneId']='../invalid'
        with self.assertRaises(ValueError):
            fetcher.scene_ids(playback)

    def test_truncated_cache_heals_and_complete_cache_is_reused(self):
        data=b'UnityFS-valid-payload'
        row={"name":"uniqueskill/uniqueskill_pl_123_0.muast","path":"bucket-a","size":len(data)}
        with tempfile.TemporaryDirectory(prefix='kirafan-skill-test-') as directory:
            root=Path(directory).resolve()
            file=root/'uniqueskill_pl_123_0.muast';file.write_bytes(b'UnityFS-truncated')
            with patch.object(fetcher,'OUT_DIR',root),patch.object(fetcher,'fetch_bytes',side_effect=[b'bad',data]) as download:
                self.assertEqual(fetcher.fetch_bundle('123',row),('123','downloaded'))
                self.assertEqual(file.read_bytes(),data)
                self.assertEqual(download.call_count,2)
                self.assertEqual(fetcher.fetch_bundle('123',row),('123','cached'))
                self.assertEqual(download.call_count,2)
            self.assertFalse(file.with_suffix('.muast.part').exists())

    def test_card_identity_preserves_scenes_for_shared_models(self):
        playback={"models":{"380004":{"cardId":38001001,"ultimate":{"sceneId":"380002"}}},
                  "cards":{
                      "38001001":{"cardId":38001001,"resourceId":380004,"ultimate":{"sceneId":"380002"}},
                      "38002001":{"cardId":38002001,"resourceId":380004,"ultimate":{"sceneId":"380004"}},
                  }}
        self.assertEqual(fetcher.scene_ids(playback,[38002001]),['380004'])
        self.assertEqual(fetcher.scene_ids(playback),['380002','380004'])
        self.assertEqual(playback['models']['380004']['ultimate']['sceneId'],'380002')

    def test_requested_card_missing_from_index_is_an_error(self):
        for playback in ({"models":{}},{"models":{},"cards":{}}):
            with self.assertRaisesRegex(ValueError,'missing card'):
                fetcher.scene_ids(playback,[38002001])

    def test_default_roster_is_the_generated_playable_card_set(self):
        rows=json.loads((fetcher.ROOT/'site/asset/rl/playable-roster.json').read_text(encoding='utf-8'))['cards']
        self.assertEqual(fetcher.ROSTER,[row['id'] for row in rows])
        self.assertEqual(len(set(fetcher.ROSTER)),41)

    def test_partial_indexes_preserve_other_scenes(self):
        with tempfile.TemporaryDirectory(prefix='kirafan-skill-index-') as directory:
            root=Path(directory).resolve();parent=root/'site/asset/uniqueskill';parent.mkdir(parents=True)
            (parent/'scene-index.json').write_text(json.dumps({"scenes":{"old":{"bytes":1}}}))
            (parent/'timeline-index.json').write_text(json.dumps({"old":{"frames":20}}))
            with patch.object(catalog,'ROOT',root),patch.object(catalog,'texture_totals',return_value=(3,100)):
                catalog.publish_indexes({'new':{'bytes':2}},{'new':{'frames':30}})
            self.assertEqual(set(json.loads((parent/'scene-index.json').read_text())['scenes']),{'old','new'})
            self.assertEqual(set(json.loads((parent/'timeline-index.json').read_text())),{'old','new'})

    def test_unbound_scene_is_not_accepted(self):
        doc=json.dumps({"nodes":[{"name":"camera"}],"materials":[]}).encode()
        payload=struct.pack('<4sIII4s',b'glTF',2,20+len(doc),len(doc),b'JSON')+doc
        timeline={"fps":30,"frames":20,"camera":{"node":"camera"},"trs":{},"channels":[]}
        catalog.validate_pair(timeline,payload)
        timeline['trs']['missing']={}
        with self.assertRaisesRegex(ValueError,'unbound'):
            catalog.validate_pair(timeline,payload)


if __name__=='__main__':
    unittest.main()
