"""Reproducible vector illustrations for the side story's authored equipment.
Native weapons keep their own original artwork; these are not claimed as native.
"""
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / 'site/asset/img/rl/equipment'
GEM = '<path d="m64 43 12 13-12 18-12-18Z" fill="url(#gem)"/><path d="m64 43-4 15 4 16 5-16Z" fill="#fff6fc" opacity=".6"/>'
RING = '<ellipse cx="64" cy="76" rx="27" ry="29" fill="none" stroke="url(#gold)" stroke-width="12"/><ellipse cx="64" cy="76" rx="27" ry="29" fill="none" stroke="#fff6d8" stroke-width="2"/>'
CLOAK = '<path d="m47 25-21 17-8 57 27 7 19-11 19 11 27-7-8-57-21-17Z" fill="url(#cloth)"/><path d="m48 27 16 14 16-14-4-9H52Z" fill="#fff1dd"/><path d="m48 42-7 53m39-53 7 53M64 48v42" fill="none" stroke="#fff8f2" opacity=".55"/><path d="m21 96 24 6 19-11 19 11 24-6" fill="none" stroke="url(#gold)" stroke-width="4"/>'
BOW = '<path d="M58 48 29 29q-14 20 1 40l29-9m11-12 29-19q14 20-1 40L69 60" fill="url(#cloth)"/><path d="m57 58-17 46 18-8 8 10 5-47m-1 0 22 44-2-19 15 1-31-32" fill="url(#cloth)"/><path d="m33 37 22 16-22 9m62-25L74 53l21 9" fill="none" stroke="#fff0e9" stroke-width="2"/>'
COMPASS = '<path d="M55 22v-8h18v8" fill="none" stroke="url(#gold)" stroke-width="6"/><circle cx="64" cy="65" r="40" fill="url(#gold)"/><circle cx="64" cy="65" r="33" fill="url(#ivory)"/><circle cx="64" cy="65" r="27" fill="none" stroke="#bb8c78" stroke-dasharray="2 5"/><path d="m64 30 8 35-8 35-8-35Z" fill="url(#gem)"/><path d="m29 65 35-8 35 8-35 8Z" fill="#d3b990"/><circle cx="64" cy="65" r="6" fill="#fff4db"/>'

# Each silhouette communicates its use at 44 px as well as in the item detail.
ART = {
 'rhythm': ('轻击腕带', '<path d="m30 38 27-12 37 13 4 45-28 18-39-19Z" fill="url(#cloth)"/><path d="m31 45 35 15 30-14M32 75l36 16 28-16" fill="none" stroke="url(#gold)" stroke-width="6"/><path d="m56 58 9 11 15-16" fill="none" stroke="#fff3e2" stroke-width="5"/>'),
 'strider': ('游走护符', '<path d="M48 18q-29 22-14 40m46-40q29 22 14 40" fill="none" stroke="url(#gold)" stroke-width="4"/><path d="M64 96C23 84 18 57 28 40q19 24 36 18 17 6 36-18c10 17 5 44-36 56Z" fill="url(#cloth)"/><path d="m29 48 18 17m-18-7 22 19m48-29L81 65m18-7L77 77" stroke="#fff4dc" fill="none"/>'+GEM),
 'reach': ('延展刻印', '<path d="M41 18q23 20 46 0M64 28v14" fill="none" stroke="url(#gold)" stroke-width="4"/><path d="m64 33 33 31-33 43-33-43Z" fill="url(#gold)"/><path d="m64 43 23 23-23 31-23-31Z" fill="url(#gem)"/><path d="m50 66 14-13 14 13m-14-13v33" stroke="#fff6e3" fill="none" stroke-width="3"/>'),
 'wide': ('宽弧指环', RING+'<path d="M31 49q33-38 66 0L82 61q-18-17-36 0Z" fill="url(#gold)"/>'+GEM),
 'aim': ('聚焦饰章', '<path d="m36 70-7 37 24-13 11 16 11-16 24 13-7-37" fill="url(#cloth)"/><circle cx="64" cy="54" r="33" fill="url(#gold)"/><circle cx="64" cy="54" r="25" fill="url(#gem)"/><circle cx="64" cy="54" r="12" fill="none" stroke="#fff8e5" stroke-width="3"/><path d="M64 25v17m0 24v17M35 54h17m24 0h17" stroke="#fff8e5" stroke-width="3"/>'),
 'sentry': ('守望机关', '<path d="m32 36 32-14 32 14v42l-32 30-32-30Z" fill="url(#gold)"/><path d="m41 43 23-11 23 11v31L64 96 41 74Z" fill="url(#cloth)"/><path d="M39 61q25-32 50 0-25 30-50 0Z" fill="#fff1dc"/><circle cx="64" cy="61" r="13" fill="url(#gem)"/><circle cx="64" cy="61" r="5" fill="#fff2dc"/>'),
 'hunter': ('巡猎罗盘',COMPASS),
 'steady': ('定心机关',COMPASS+'<path d="m40 73 24 17 24-17M64 80V48" fill="none" stroke="#7c5071" stroke-width="5"/>'),
 'prism': ('无相罗盘',COMPASS+'<path d="m64 34 24 29-24 29-24-29Z" fill="url(#gem)"/><path d="m64 34-7 29 7 29 8-29Z" fill="#fff7e9" opacity=".6"/>'),
 'binding': ('缚技罗盘',COMPASS+'<path d="m36 44 56 44m0-44L36 88" stroke="url(#gold)" stroke-width="8"/><rect x="51" y="55" width="26" height="26" rx="6" fill="url(#cloth)"/><circle cx="64" cy="66" r="4" fill="#fff5d9"/>'),
 'aegis': ('坚壁徽章','<path d="m64 19 38 14-4 43q-11 24-34 34-23-10-34-34l-4-43Z" fill="url(#gold)"/><path d="m64 29 28 11-3 32q-7 19-25 29-18-10-25-29l-3-32Z" fill="url(#cloth)"/><path d="M64 32v61m-22-40h44" stroke="#ffedcd" stroke-width="5"/>'+GEM),
 'kite': ('纸翼护符', '<path d="M28 25 64 40l36-15-7 40-29 38-29-38Z" fill="url(#ivory)"/><path d="M64 40v63M28 25l36 42 36-42" fill="none" stroke="url(#gold)" stroke-width="3"/><path d="m43 43 21 15 21-15-7 24-14 16-14-16Z" fill="url(#cloth)"/><path d="M64 104q-19 6-10 15" fill="none" stroke="#b37591" stroke-width="3"/>'),
 'comet': ('流星缎带', BOW+'<path d="m64 31 8 17 19 2-14 13 4 19-17-10-17 10 4-19-14-13 19-2Z" fill="url(#gold)"/><path d="m64 41 4 13 14 1-11 8 2 12-9-7-9 7 2-12-11-8 14-1Z" fill="url(#gem)"/>'),
 'cotton': ('旅人软披肩',CLOAK+'<path d="M47 31q17 11 34 0" fill="none" stroke="#e9c7bb" stroke-width="8"/><circle cx="64" cy="43" r="5" fill="url(#gold)"/>'),
 'ribbon': ('晨光发结',BOW+'<circle cx="64" cy="54" r="12" fill="url(#gold)"/><circle cx="64" cy="54" r="7" fill="url(#gem)"/>'),
 'leaf': ('新叶书签','<path d="M48 19h32v88L64 96l-16 11Z" fill="url(#cloth)"/><path d="M53 25h22v66l-11-5-11 5Z" fill="url(#ivory)"/><path d="M61 74q-27-25 8-39 23 26-8 39Z" fill="url(#gem)"/><path d="m59 78 11-38" fill="none" stroke="url(#gold)" stroke-width="3"/>'),
 'bloom': ('花庭斗篷',CLOAK+'<path d="m36 79 8 7-8 7-8-7Zm56 0 8 7-8 7-8-7Z" fill="url(#gold)"/>'+GEM),
 'bell': ('星灯风铃','<path d="M64 13v19m-8-12h16" fill="none" stroke="url(#gold)" stroke-width="3"/><path d="M39 65q2-34 25-34t25 34l7 9H32Z" fill="url(#gem)"/><ellipse cx="64" cy="74" rx="32" ry="7" fill="url(#gold)"/><path d="M64 77v15" stroke="url(#gold)" stroke-width="3"/><path d="m53 91 22-3-5 28-19-3Z" fill="url(#cloth)"/><path d="M49 55q5-17 15-17" fill="none" stroke="#fff8f1" stroke-width="4"/>'),
 'edge': ('蔷薇胸针', '<path d="m64 70 22 32 12-7-21-35M52 68 30 98l-6-18 22-24" fill="url(#gold)"/><path d="M64 21 78 32l20 3-1 21 8 18-19 12-12 20-20-9-20 1-3-23-12-16 15-16 10-20Z" fill="url(#cloth)"/><path d="m64 37 20 10 2 22-19 18-22-10-5-22Z" fill="url(#gem)"/><path d="m64 45 12 9-2 15-12 7-12-10 3-13Z" fill="none" stroke="#ffebdd" stroke-width="3"/>'),
 'petal': ('花守礼装',CLOAK+'<path d="m45 25 19 16 19-16m-43 70 24-37 24 37" fill="none" stroke="url(#gold)" stroke-width="5"/>'+GEM+'<circle cx="32" cy="85" r="3" fill="#fff9e5"/><circle cx="96" cy="85" r="3" fill="#fff9e5"/>'),
 'moon': ('月露怀表',COMPASS+'<circle cx="64" cy="65" r="26" fill="url(#gem)"/><path d="M72 43a22 22 0 1 0 14 34 21 21 0 0 1-14-34Z" fill="url(#ivory)"/><path d="m79 54 3 6 7 1-5 4 1 7-6-3-5 3 1-7-5-4 7-1Z" fill="url(#gold)"/>'),
 'solstice': ('映日花冠','<path d="M24 45 43 62 64 31 85 62l19-17-9 48H33Z" fill="url(#gold)"/><path d="m35 83 29-24 29 24-3 14H38Z" fill="url(#cloth)"/>'+GEM+'<path d="M36 91h56" stroke="#fff4d8" stroke-width="3"/><circle cx="25" cy="44" r="5" fill="url(#gem)"/><circle cx="103" cy="44" r="5" fill="url(#gem)"/>')
}

def render(name, shape, index):
    palettes=[('#e7a7c0','#a54c78','#f9d7e2','#ba779f'),('#b4bacf','#686c9b','#d5d4e9','#8482bb'),('#c7c3a1','#788b79','#dce6c6','#869d79')]
    light,dark,gem,gemdark=palettes[index%3]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
<title>{name}</title><metadata>Original vector illustration for Kirafan Timer's side story; not native game artwork.</metadata>
<defs>
<linearGradient id="gold" x2=".8" y2="1"><stop stop-color="#fff1ca"/><stop offset=".48" stop-color="#dcba7b"/><stop offset="1" stop-color="#9c7045"/></linearGradient>
<linearGradient id="cloth" x2="1" y2="1"><stop stop-color="{light}"/><stop offset="1" stop-color="{dark}"/></linearGradient>
<linearGradient id="gem" x2=".8" y2="1"><stop stop-color="#fff8f0"/><stop offset=".28" stop-color="{gem}"/><stop offset="1" stop-color="{gemdark}"/></linearGradient>
<linearGradient id="ivory" x2="1" y2="1"><stop stop-color="#fffcf2"/><stop offset="1" stop-color="#ded2bb"/></linearGradient>
<filter id="shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="4" stdDeviation="3" flood-color="#604456" flood-opacity=".25"/></filter>
</defs><g stroke="#826672" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" filter="url(#shadow)">{shape}</g>
<path d="m106 18 2 6 6 2-6 2-2 6-2-6-6-2 6-2ZM19 74l1 3 4 1-4 1-1 4-1-4-3-1 3-1Z" fill="#f9e5bc"/>
</svg>\n'''

if __name__ == '__main__':
    for i,(key,(name,shape)) in enumerate(ART.items()):
        (OUT/f'gadget-{key}.svg').write_text(render(name,shape,i),encoding='utf8')
    print(f'Wrote {len(ART)} equipment illustrations')
