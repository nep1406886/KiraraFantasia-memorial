"""Rebuild playable cards from original tables; --card-art fills missing native art."""
import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'
DATA = SITE / 'etowaria-defense/data'
RAW = SITE / 'asset/rl/_raw'
CLASSES = ['战士', '魔法使', '僧侣', '骑士', '炼金术士']
ELEMENTS = ['炎', '水', '土', '风', '月', '阳']
ADDITIONS = [
    ('U88', 18012001, '索妮娅', '爱杀宝贝'),
    ('U89', 22012001, '秋山澪（情人节）', '轻音少女'),
    ('U90', 30022001, '天天座理世', '请问您今天要来点兔子吗？'),
    ('U91', 23032001, '犬山葵', '摇曳露营△'),
    ('U92', 23022001, '大垣千明', '摇曳露营△'),
    ('U93', 24012001, '恋塚小梦', 'Comic Girls'),
    ('U94', 24032001, '胜木翼（七夕）', 'Comic Girls'),
    ('U95', 12042001, '佐仓慈', '学园孤岛'),
]


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--card-art', action='store_true')
    args = parser.parse_args()
    catalogue = read(DATA / 'units.json')
    gacha = json.loads((SITE / 'asset/gacha/cards.js').read_text(encoding='utf-8').split('window.kirafanGachaData = ', 1)[1].strip().rstrip(';'))['cards']
    identities = {cid: card for card in gacha for cid in [card['id'], card.get('evolvedId')] if cid}
    cards = {row['m_CharaID']: row for row in read(RAW / 'CharacterList.json')}
    skills = {row['m_ID']: row for row in read(RAW / 'SkillList_PL.json')}
    content = {row['m_ID']: row['m_Datas'] for row in read(RAW / 'SkillContentList_PL.json')}
    original = read(SITE / 'asset/models/manifest.json')
    playback = read(SITE / 'asset/battle/skill-playback.json')['cards']
    voices = read(SITE / 'asset/rl/voices.json')
    scenes = read(SITE / 'asset/uniqueskill/scene-index.json')['scenes']
    manifest = read(DATA / 'models.json')
    units = {row['id']: row for row in catalogue['units']}
    extra = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        "import {COMPANIONS} from './site/etowaria-defense/data/companions.js'; console.log(JSON.stringify(COMPANIONS));"],
        cwd=ROOT, encoding='utf-8'))
    for uid, cid, name, work in [*ADDITIONS, *(row[:4] for row in extra)]:
        units.setdefault(uid, {'id': uid, 'cardId': cid, 'name': name, 'shortName': name.split('（')[0], 'work': work})
    if args.card_art:
        from concurrent.futures import ThreadPoolExecutor
        import fetch_images
        fetch_images.OUT_ROOT = SITE / 'asset/img/rl'
        jobs = []
        roster = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
            "import {PLAYABLE_IDS} from './site/game/rl/rosterids.js'; console.log(JSON.stringify(PLAYABLE_IDS));"],
            cwd=ROOT, encoding='utf-8'))
        selected = [unit['cardId'] for unit in units.values()] + roster
        for cid in sorted({cid for selected_id in selected for cid in
                           [identities[selected_id]['id'], identities[selected_id].get('evolvedId')] if cid}):
            for kind, asset in [('card', 'characard'), ('icon', 'charaicon')]:
                rel = f'charauiresource/{asset}/{asset}_{cid}'
                jobs.append(dict(id=cid, file=f'{kind}/{cid}.webp', rel=rel,
                                 url=fetch_images.s1_url(rel), crop_w=512 if kind == 'card' else None))
        with ThreadPoolExecutor(max_workers=4) as pool:
            for result in pool.map(fetch_images.download_job, jobs):
                print(f"Card {result['id']}: {'cached' if result['skipped'] else 'converted'}", flush=True)
    for uid, work in [('U25', '满溢的水果挞'), ('U26', '孤独摇滚！'), ('U27', '街角魔族'), ('U28', 'NEW GAME!')]:
        units[uid]['work'] = work
    for uid, name in [('U26', '后藤一里'), ('U38', '小路绫（情人节）'), ('U41', '宇治松千夜'), ('U87', '相川千穗（温泉）')]:
        units[uid]['name'] = name
    units['U87']['shortName'] = '千穗'
    for unit in units.values():
        # Costs and tactical roles have one authority: UNIT_RULES in campaign.js.
        unit.pop('role', None)
        unit.pop('plannedCost', None)
        card = cards[unit['cardId']]
        identity = identities[unit['cardId']]
        unit['rarity'] = identity['rarity']
        unit['seasonal'] = '【' in identity['name']
        unit['forms'] = {}
        for name, form_id in [('base', identity['id']), ('evolved', identity.get('evolvedId'))]:
            if not form_id:
                continue
            form = cards[form_id]
            frid, fcls = form['m_ResourceID'], form['m_Class']
            unit['forms'][name] = dict(cardId=form_id, resourceId=frid, headId=form['m_HeadID'],
                card=f'asset/img/rl/card/{form_id}.webp', icon=f'asset/img/rl/icon/{form_id}.webp')
            for kind, key in [('models', f'model/player/model_pl_{frid}.muast'),
                              ('classActions', f"{fcls}:{form['m_HeadID']}"), ('skillActions', str(frid))]:
                entry = original[kind][key]
                if not (SITE / entry['file'].split('?')[0]).is_file():
                    raise ValueError(f'Missing form asset: {key}')
                manifest.setdefault(kind, {})[key] = entry
        rid, cid, cls = card['m_ResourceID'], card['m_CharaID'], card['m_Class']
        unit.update(resourceId=rid, originalName=card['m_Name'], classId=cls, className=CLASSES[cls],
                    elementId=card['m_Element'], elementName=ELEMENTS[card['m_Element']],
                    headId=card['m_HeadID'], displayScale=card['m_DispScale'],
                    icon=f'asset/img/rl/icon/{cid}.webp',
                    card=f'asset/img/rl/card/{cid}.webp' if (SITE / f'asset/img/rl/card/{cid}.webp').is_file() else None,
                    voice=voices.get(str(rid)), ultimateScene=scenes.get(str(rid)))
        unit['skills'] = [dict(id=sid, name=skills[sid]['m_SkillName'], detail=skills[sid]['m_SkillDetail'],
                              graphics=skills[sid]['m_SAG'], effects=content[sid])
                          for sid in [card['m_CharaSkillID'], *card['m_ClassSkillIDs']]]
        for kind, keys in [('models', [f'model/player/model_pl_{rid}.muast', f'model/weapon/wpn_{1000 + cls * 100}.muast']),
                           ('classActions', [f"{cls}:{card['m_HeadID']}"]), ('skillActions', [str(rid)])]:
            for key in keys:
                entry = original[kind][key]
                if not (SITE / entry['file'].split('?')[0]).is_file():
                    raise ValueError(f'Missing {kind}: {key}')
                manifest.setdefault(kind, {})[key] = entry
        if str(cid) not in playback:
            raise ValueError(f'Missing playback: {cid}')
        if not (SITE / unit['icon']).is_file():
            raise ValueError(f'Missing portrait: {cid}')
    catalogue['units'] = list(units.values())
    catalogue['phase'] = 'memorial-campaign'
    write(DATA / 'units.json', catalogue)
    write(DATA / 'models.json', manifest)
    write(DATA / 'playback.json', {str(unit['cardId']): playback[str(unit['cardId'])] for unit in units.values()})
    print(f'Refreshed {len(units)} cards with exact skills, models and playback.')


if __name__ == '__main__':
    main()
