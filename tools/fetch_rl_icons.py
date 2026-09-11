# -*- coding: utf-8 -*-
"""Export original currency / skill / frame sprites and the site crystal cursor.

VariableIcon treats Gold/Gem separately from ItemList consumables. GoldIcon and
GemIcon are the currency art in CommonUIAtlas. Item 999 is weapon evolution
metal; item 100003 is event currency. Neither is used as a currency substitute.
The SP mark is the original CMD_SkillSP art, not a gem or evolution material.

Usage: python tools/fetch_rl_icons.py (Pillow and UnityPy required).
The cached source is reused; provenance records its hash and sprite path IDs.
"""
import hashlib
import json
from pathlib import Path
import urllib.request

UA = {"User-Agent": "kirafan-timer-advbg/1.0"}
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'site/asset/img/rl/drop'
CACHE = ROOT / '.cache/t22j_src'
CURSORS = ROOT / 'site/asset/img/ui'
ATLAS_URL = 'https://asset.kirafan.cn/uiatlas/commonuiatlas.muast'
ATLAS_SPRITES = {
    "GoldIcon": "coin",
    "GemIcon": "star",
    "IconFrame": "equipment-frame",
    "CMD_SkillSP": "skill-special",
    "CMD_SkillAttack": "skill-attack",
    "CMD_SkillMagic": "skill-magic",
    "CMD_SkillRecovery": "skill-recovery",
    "CMD_SkillBuff": "skill-buff",
    "CMD_SkillDeBuff": "skill-debuff",
    "SkillIconBackground": "skill-frame",
}


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read()


def square_icon(image):
    from PIL import Image
    side = max(image.size)
    square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return square.resize((96, 96), Image.Resampling.LANCZOS)


def cursor_images(gem):
    from PIL import Image, ImageFilter
    gem = gem.copy()
    gem.thumbnail((24, 28), Image.Resampling.LANCZOS)
    normal = Image.new('RGBA', (32, 32))
    normal.paste(gem, (3, 2))
    alpha = normal.getchannel('A')
    # The topmost solid crystal pixel is the pointer tip in both states.
    tip = next((x, y) for y in range(32) for x in range(32) if alpha.getpixel((x, y)) > 127)
    active = Image.new('RGBA', (32, 32), '#efc667')
    active.putalpha(alpha.filter(ImageFilter.MaxFilter(3)))
    active.alpha_composite(normal)
    return normal, active, tip


def main():
    import UnityPy
    CACHE.mkdir(parents=True, exist_ok=True)
    atlas = CACHE / 'commonuiatlas.muast'
    if not atlas.exists():
        atlas.write_bytes(fetch(ATLAS_URL))
    env = UnityPy.load(str(atlas))
    sprites = {}
    for obj in env.objects:
        if obj.type.name != "Sprite":
            continue
        sp = obj.read()
        if sp.m_Name in ATLAS_SPRITES:
            if sp.m_Name in sprites:
                raise RuntimeError('Ambiguous sprite: ' + sp.m_Name)
            sprites[sp.m_Name] = (sp.image.convert('RGBA'), str(obj.path_id))
    missing = set(ATLAS_SPRITES) - set(sprites)
    if missing:
        raise RuntimeError('Missing sprites: ' + ', '.join(sorted(missing)))
    # Resolve all sources before replacing any derived asset.
    OUT.mkdir(parents=True, exist_ok=True)
    CURSORS.mkdir(parents=True, exist_ok=True)
    manifest = {'source': {'url': ATLAS_URL, 'sha256': hashlib.sha256(atlas.read_bytes()).hexdigest()},
                'assets': {}}
    for sprite, name in ATLAS_SPRITES.items():
        image, path_id = sprites[sprite]
        # Leave the existing five skill silhouettes and their background encoding unchanged.
        lossless = name in {'coin', 'star', 'equipment-frame', 'skill-special'}
        square_icon(image).save(OUT / (name + '.webp'), 'WEBP', lossless=lossless, quality=90)
        manifest['assets'][name + '.webp'] = {'sprite': sprite, 'pathId': path_id,
            'originalSize': list(image.size), 'exportSize': [96, 96], 'lossless': lossless}
        print(name + '.webp <- ' + sprite)
    normal, active, tip = cursor_images(sprites['GemIcon'][0])
    files = []
    for image, name in [(normal, 'kirara-crystal.png'), (active, 'kirara-crystal-link.png')]:
        path = CURSORS / name
        image.save(path)
        files.append(path.relative_to(ROOT).as_posix())
    manifest['cursor'] = {'sprite': 'GemIcon', 'pathId': sprites['GemIcon'][1],
        'size': [32, 32], 'hotspot': list(tip), 'files': files}
    (OUT / 'provenance.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print('cursor hotspot:', tip)
    print("done")


if __name__ == "__main__":
    main()
