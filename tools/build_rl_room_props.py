"""Export verified RoomObjectList furniture as local native scenes.

RoomUtility.GetModelResourcePath maps category 5 to Goods/Goods_{id}.
Only the furniture namespace is updated; existing effects and town metadata
are preserved. Raw bundles are never runtime URLs.
"""
import argparse
import hashlib
import json
from pathlib import Path
from build_rl_native_assets import ROOT, CACHE, OUT, download, read, save_scene, write
from export_uniqueskill_scene import SceneExporter
from extract_uniqueskill_timeline import extract

SOURCE = 'https://gitlab.com/kirafan/database/-/raw/master/database/RoomObjectList.json'
SELECTED = {1041: '篝火', 1044: '便携烤架', 1072: '灯笼', 1083: '旅程书册', 1147: '大圣堂雕像'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--room-table', type=Path, required=True)
    args = parser.parse_args()
    raw = args.room_table.read_bytes()
    table = json.loads(raw.decode('utf-8-sig'))
    digest = hashlib.sha256(raw).hexdigest()
    assets = {r['name']: r for r in read(ROOT / '.codex-tmp' / 'assetBundle.json')}
    manifest = read(OUT / 'index.json')
    furniture = dict(manifest.get('furniture', {}))
    evidence = {'source': {'url': SOURCE, 'sha256': digest},
        'mapping': 'RoomUtility.GetModelResourcePath / category 5 Goods / DBAccessID = category * 100000 + ID',
        'adaptation': 'Original layered geometry and textures; placement and scale adapted to the realtime room. No claim of original gameplay events.',
        'entries': []}
    CACHE.mkdir(parents=True, exist_ok=True)
    for object_id, label in SELECTED.items():
        matches = [r for r in table if r['m_DBAccessID'] == 500000 + object_id]
        if len(matches) != 1 or matches[0]['m_Category'] != 5 or matches[0]['m_ID'] != object_id:
            raise ValueError('Ambiguous original room object: ' + str(object_id))
        row = matches[0]
        if row['m_TitleType'] != -1:
            raise ValueError('Work-specific furniture requires an explicit room affiliation')
        key = 'goods_' + str(object_id)
        bundle = 'prefab/room/goods/' + key + '.muast'
        path = download(assets[bundle])
        source = {'bundle': bundle, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        # These four exact holder names were inspected in the source bundles.
        # The statue is static; do not invent an animation when none is authored.
        timeline = None if object_id == 1147 else extract(path,
            'Goods_' + str(object_id) + '@event_001', allow_material_only=True)
        if timeline:
            source['clip'] = timeline['clip']
        entry = save_scene(key, SceneExporter(path, timeline=timeline or {'channels': []}), timeline, source)
        entry['affiliation'] = {'table': 'RoomObjectListDB', 'tableSha256': digest,
            'objectId': object_id, 'accessId': row['m_DBAccessID'], 'category': 5,
            'titleType': row['m_TitleType'], 'name': row['m_Name'], 'label': label,
            'initialHidden': row['m_initHideObjName']}
        furniture[key] = entry
        evidence['entries'].append({'key': key, **entry['affiliation'], **source,
            'file': entry['file'], 'bytes': entry['bytes']})
        print('EXPORTED ' + key + ' ' + label + ' ' + str(entry['bytes']), flush=True)
    manifest['furniture'] = furniture
    write(OUT / 'index.json', manifest)
    evidence_path = ROOT / 'docs' / 'original-room-prop-data.json'
    evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


if __name__ == '__main__':
    main()
