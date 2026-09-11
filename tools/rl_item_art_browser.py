"""Original currency, explicit adapted gear, native cursor and actual UI/scene gates.

The visual assortment is a named fixture, not evidence for drop probabilities.
Approach/compare/cancel/equip and shop stock use the normal application paths.
Browser screenshots omit OS cursors; the cursor preview is labelled separately.
"""
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import ready, advance
from rl_recovery_browser import press

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/item-art'
FILES = ['index.html', 'site/models.html', 'site/gacha.html', 'site/game/roguelike.html', 'css/kirara-cursor.css',
         'site/game/rl/main.js', 'site/game/rl/world.js', 'site/game/rl/ui/decisions.js', 'site/game/rl/ui/theme.css',
         'site/game/rl/gadgets.js', 'site/game/rl/equipment.js', 'site/game/rl/ui/equipmentbrief.js', 'tools/fetch_rl_icons.py']


def fingerprints():
    paths = [ROOT / name for name in FILES]
    for directory in ['site/asset/img/rl/equipment', 'site/asset/img/rl/drop', 'site/asset/img/ui']:
        paths.extend(path for path in (ROOT / directory).glob('*') if path.is_file())
    return {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


CURSORS = """() => {
    const fixture=document.createElement('section');fixture.id='cursor-fixture';
    fixture.innerHTML='<button id="cursor-button"><span>操作</span></button><input id="cursor-text" type="search">'
        +'<button id="cursor-disabled" disabled>禁用</button><button id="cursor-aria" aria-disabled="true">禁用</button>'
        +'<div id="cursor-edit" contenteditable="true"><span>编辑</span></div><textarea id="cursor-area"></textarea>'
        +'<input id="cursor-range" type="range"><button id="cursor-busy" aria-busy="true">等待</button>'
        +'<div id="cursor-drag" draggable="true">拖动</div>'
        +'<div class="model-3d-canvas"><canvas id="cursor-rotate"></canvas></div>'
        +'<button id="cursor-zoom" class="draw-card-open">查看卡面</button>'
        +'<div class="model-action-strip"><button id="cursor-loading" class="is-loading">加载</button></div>'
        +'<button id="cursor-waiting" class="summon-button" disabled>召唤中</button>';
    document.body.appendChild(fixture);
    const result={fine:matchMedia('(pointer: fine)').matches,body:getComputedStyle(document.body).cursor};
    for(const id of ['button','text','disabled','aria','edit','area','range','busy','drag','rotate','zoom','loading','waiting'])
        result[id]=getComputedStyle(document.getElementById('cursor-'+id)).cursor;
    result.child=getComputedStyle(fixture.querySelector('button span')).cursor;
    fixture.remove();return result;
}"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'before': fingerprints()}

    def check(label, condition, detail=None):
        report['checks'].append({'label': label, 'ok': bool(condition), 'detail': detail})
        print(('PASS ' if condition else 'FAIL ') + label, flush=True)
        if not condition:
            raise AssertionError(label + ': ' + str(detail))

    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    base = 'http://127.0.0.1:%d' % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            # Styles-only checks of the other site entrypoints; no remote downloads
            # or unrelated timer/gacha/model scripts are needed for this contract.
            site = browser.new_context(java_script_enabled=False)
            site.route('**/*', lambda route: route.continue_() if route.request.url.startswith(base)
                       and route.request.resource_type in ['document', 'stylesheet'] else route.fulfill(status=204))
            for name in ['index.html', 'site/models.html', 'site/gacha.html']:
                page = site.new_page(); page.goto(base + '/' + name, wait_until='load', timeout=60000)
                data = page.evaluate(CURSORS)
                check(name + ' 正文与操作使用两态星彩石光标',
                      'kirara-crystal.png' in data['body'] and 'kirara-crystal-link.png' in data['button']
                      and data['child'] == data['button'], data)
                page.close()
            site.close()
            context = browser.new_context(viewport={'width': 1280, 'height': 840})
            context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
                localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
            page = context.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.goto(base + '/site/game/roguelike.html?volume=1&seed=10926', wait_until='load', timeout=60000)
            page.wait_for_selector('.roster-card', timeout=60000)
            cursors = page.evaluate(CURSORS); report['cursors'] = cursors
            check('游戏页使用同一原作晶体与热点', cursors['fine'] and 'kirara-crystal.png' in cursors['body']
                  and '6 3' in cursors['body'] and cursors['child'] == cursors['button'], cursors)
            check('文本、编辑区、禁用、等待和滑动光标保留语义',
                  all(cursors[key] == 'text' for key in ['text', 'edit', 'area'])
                  and all(cursors[key] == 'not-allowed' for key in ['disabled', 'aria'])
                  and cursors['busy'] == 'progress' and cursors['range'] == 'ew-resize'
                  and cursors['drag'] == 'grab', cursors)
            check('原有模型旋转、卡面放大和加载提示不被统一光标抹掉',
                  cursors['rotate'] == 'grab' and cursors['zoom'] == 'zoom-in'
                  and cursors['loading'] == 'progress' and cursors['waiting'] == 'wait', cursors)
            page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]')).click()
            ready(page)
            art = page.evaluate("""async()=>{
                const {equipmentIcon,equipmentName}=await import('/site/game/rl/ui/decisions.js');
                const {GADGETS,makeGadget}=await import('/site/game/rl/gadgets.js');
                const weapons=await (await fetch('/site/asset/rl/weapons-rl.json')).json();
                const native=weapons.catalog.find(r=>r.class===kirafanRL.world.player.card.class && r.evolution===0 && r.rare<5);
                const items=[...['weapon','amulet','armor','charm'].map(slot=>({slot,rarity:'common',affixes:[]})),
                    ...GADGETS.map(g=>makeGadget(g.id,undefined,g.sealSkill?1:undefined)),{slot:'weapon',rarity:'rare',catalogId:native.id,affixes:[]}];
                window.__itemArt={items,weapons,equipmentIcon,equipmentName};
                const images=await Promise.all(items.map(item=>new Promise(resolve=>{
                    const url=equipmentIcon(item,weapons),im=new Image();
                    im.onload=()=>{const c=document.createElement('canvas');c.width=c.height=96;const ctx=c.getContext('2d');
                        ctx.drawImage(im,0,0,96,96);const pixels=ctx.getImageData(0,0,96,96).data;
                        let solid=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>127)solid++;
                        resolve({url,name:equipmentName(item,weapons),width:im.naturalWidth,solid});};
                    im.onerror=()=>resolve({url,width:0});im.src=url;
                })));
                return {images,native,empty:equipmentIcon(null),invalid:equipmentIcon({slot:'weapon',catalogId:-999}),
                    badSlot:equipmentIcon({slot:'constructor',rarity:'common',affixes:[]}),
                    badGadget:equipmentIcon({slot:'armor',gadgetId:'../../escape',affixes:[]})};
            }""")
            report['art'] = art
            check('四槽、十机制与原作武器全部可解码且不是空白图块',
                  len(art['images']) == 15 and all(row['width'] > 0 and row['solid'] > 250 for row in art['images']), art['images'])
            check('非武器和机制不再冒用物品素材，原作武器仍按原编号',
                  all('/equipment/' in row['url'] for row in art['images'][:-1])
                  and art['images'][-1]['url'].endswith('/weapon/%s.webp' % art['native']['iconId']))
            check('空槽、无效武器、未知槽位和损坏机制不伪装成有效装备',
                  all(art[key] is None for key in ['empty', 'invalid', 'badSlot', 'badGadget']))
            check('必杀使用原作SP图案而非星彩石或进化金属',
                  'skill-special.webp' in page.locator('.hud-gauge-icon').evaluate('n=>getComputedStyle(n).backgroundImage'))
            # Separate labelled asset sheet: this is not an in-game HUD or an OS
            # cursor screenshot. The PNGs at the bottom show their native size.
            page.evaluate("""async rows=>{
                const sheet=document.createElement('section');sheet.id='item-art-sheet';
                sheet.style.cssText='position:fixed;left:16px;top:16px;width:650px;padding:24px;background:#fbf6e9;color:#504b48;z-index:99999;border:1px solid #d9cba9;border-radius:18px;font:13px/1.4 sans-serif';
                const heading=document.createElement('h2');heading.textContent='物品图示与来源核对';heading.style.cssText='margin:0 0 14px;font-size:20px';sheet.appendChild(heading);
                const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px 10px';
                const entries=[...rows.map((r,i)=>({url:r.url,name:r.name.replace(/^[^·]+· /,''),origin:i<rows.length-1?'外传 · 专用图示':'原作 · 武器图'})),
                    ...[['star','星彩石'],['coin','普通金币'],['skill-special','必杀 SP']].map(([file,name])=>({url:'/site/asset/img/rl/drop/'+file+'.webp',name,origin:'原作 · 公共图集'}))];
                for(const row of entries){const cell=document.createElement('div');cell.style.cssText='text-align:center;min-width:0';
                    const image=new Image();image.src=row.url;image.style.cssText='width:82px;height:82px;object-fit:contain';
                    const name=document.createElement('div');name.textContent=row.name;name.style.cssText='font-weight:600;font-size:12px';
                    const origin=document.createElement('div');origin.textContent=row.origin;origin.style.cssText='font-size:10px;color:#817765;margin-top:4px';
                    cell.append(image,name,origin);grid.appendChild(cell);}
                const cursor=document.createElement('div');cursor.style.cssText='margin-top:22px;border-top:1px solid #d9cba9;padding-top:14px;display:flex;align-items:center;gap:18px';
                const label=document.createElement('span');label.textContent='系统光标图样 · 32px 原尺寸';cursor.appendChild(label);
                for(const file of ['kirara-crystal.png','kirara-crystal-link.png']){const im=new Image();im.src='/site/asset/img/ui/'+file;
                    im.style.cssText='width:32px;height:32px;object-fit:contain';cursor.appendChild(im);}
                sheet.append(grid,cursor);document.body.appendChild(sheet);
                await Promise.all([...sheet.querySelectorAll('img')].map(im=>im.decode()));
            }""", art['images'])
            page.locator('#item-art-sheet').screenshot(path=str(OUT / 'asset-sheet.png'))
            page.locator('#item-art-sheet').evaluate('n=>n.remove()')
            # Named scene fixture, positioned outside the automatic offer radius.
            page.evaluate("""()=>{const k=kirafanRL,w=k.world,p=w.player;p.x=w.width/2;p.y=w.height/2;
                window.__equipmentBefore=JSON.stringify(p.equipment);
                window.__artDrops=__itemArt.items.map((item,i)=>{
                    const d={x:p.x-4.5+(i%6)*1.8,y:p.y-3-Math.floor(i/6)*2,items:[item]};
                    w.drops.push(d);w.events.push({type:'drop',x:d.x,y:d.y,items:d.items,drop:d});return d;});k.step(1/60);}""")
            page.wait_for_function("""()=>{let n=0;kirafanRL.scene.traverse(o=>{
                if(o.userData.weaponIcon&&o.children[0]?.material.map?.image?.width)n++;});return n===__itemArt.items.length;}""", polling=50, timeout=15000)
            advance(page, .3)
            markers = page.evaluate("""()=>{const rows=[];kirafanRL.scene.traverse(o=>{if(o.userData.weaponIcon)
                rows.push({icon:o.userData.weaponIcon,frame:o.material.map.image.src,color:o.children[0].material.color.getHexString(),
                    visible:o.children[0].visible});});return rows;}""")
            report['markers'] = markers
            check('地面使用原作通用装备框，全部图案保留原色且可见', len(markers) == 15
                  and all('equipment-frame.webp' in r['frame'] and r['color'] == 'ffffff' and r['visible'] for r in markers))
            check('显示新图标不自动装备或换层', page.evaluate('JSON.stringify(kirafanRL.world.player.equipment)===__equipmentBefore && kirafanRL.world.floor===1'))
            page.screenshot(path=str(OUT / 'ground-assortment.png'))
            # Approach a real entry; this is the same automatic comparison path
            # as natural loot, not a direct UI invocation or equipItem call.
            page.evaluate("""()=>{const p=kirafanRL.world.player,d=__artDrops[10];p.x=d.x;p.y=d.y-1.4;p.sm.force('idle');}""")
            page.keyboard.down('s'); advance(page, .23); page.keyboard.up('s')
            page.wait_for_selector('#rl-equipment-choice[open]')
            page.locator('#rl-equipment-choice .equipment-more > summary').click()
            text = page.locator('#rl-equipment-choice').inner_text()
            check('接近巡猎罗盘后展示独立图案、收益、代价与外传身份',
                  '巡猎罗盘' in text and '外传机制装备' in text and '25%' in text
                  and page.locator('#rl-equipment-choice .equipment-icon').get_attribute('src').endswith('/gadget-hunter.svg'), text)
            check('非武器比较不误报本职武器或跨职业加成', '本职武器' not in text and '跨职业持有' not in text)
            page.screenshot(path=str(OUT / 'compare-hunter.png'))
            page.locator('#equipment-keep').click(); advance(page)
            check('取消比较不装备也不消耗地面物品', page.evaluate('JSON.stringify(kirafanRL.world.player.equipment)===__equipmentBefore && __artDrops[10].items.length===1'))
            page.keyboard.down('w'); advance(page, .4); page.keyboard.up('w')
            page.keyboard.down('s'); advance(page, .4); page.keyboard.up('s')
            page.wait_for_selector('#rl-equipment-choice[open]')
            page.locator('#equipment-confirm').click(); advance(page)
            check('确认才持有机制装备，并通过正常保存事务写入', page.evaluate("""()=>{
                const w=kirafanRL.world,p=JSON.parse(localStorage.getItem('kirafan-rl:profile'));
                return w.player.equipment.some(e=>e.gadgetId==='hunter') && !w.drops.includes(__artDrops[10])
                    && JSON.stringify(p).includes('"gadgetId":"hunter"');}"""))
            # Normal seeded stock, real shop interaction and comparison.
            page.evaluate("""()=>{const k=kirafanRL,w=k.world,s=w.dungeon.rooms.find(r=>r.type==='shop');
                if(!s)throw Error('seed has no shop');w.coin=500;w.enterRoom(s.id,'S');k.step(1/60);}""")
            ready(page); press(page, 'e'); page.wait_for_selector('#shop-panel[open]')
            page.wait_for_function("""()=>[...document.querySelectorAll('#shop-panel img')].every(im=>im.complete&&im.naturalWidth)""", polling=50)
            stock = page.evaluate("""()=>kirafanRL.world.getShopOffer().map((row,i)=>{
                const button=document.querySelector('#shop-panel .shop-item[data-index="'+i+'"]');
                return {expected:__itemArt.equipmentIcon(row.item,__itemArt.weapons),src:button.querySelector('img')?.src,
                    width:button.querySelector('img')?.naturalWidth,text:button.textContent,gadget:!!row.item.gadgetId};})""")
            report['stock'] = stock
            check('正常商店货架使用同一物品身份与已加载图案', len(stock) == 3
                  and all(row['expected'] == row['src'] and row['width'] > 0 for row in stock), stock)
            page.screenshot(path=str(OUT / 'shop.png'))
            page.locator('#shop-panel .shop-item:not(:disabled)').first.click()
            page.wait_for_selector('#rl-equipment-choice[open]')
            check('商店比较图案与对应货架一致', page.locator('#rl-equipment-choice .comparison-columns section').last.locator('img').get_attribute('src') == stock[0]['src'])
            page.locator('#equipment-keep').click(); page.locator('#shop-close').click(); advance(page)
            # Explicitly fail one image request. Its text and frame must remain,
            # with no blank opaque equipment sprite or broken-image layout.
            missing = page.evaluate("""()=>{const {weapons,equipmentIcon}=__itemArt;
                const used=new Set([...__itemArt.items,...kirafanRL.world.getShopOffer().map(r=>r.item)].map(i=>equipmentIcon(i,weapons)));
                const row=weapons.catalog.find(r=>r.rare<5&&!used.has(equipmentIcon({slot:'weapon',catalogId:r.id},weapons)));
                return {item:{slot:'weapon',rarity:'rare',catalogId:row.id,affixes:[]},url:equipmentIcon({slot:'weapon',catalogId:row.id},weapons)};
            }""")
            page.route(missing['url'], lambda route: route.abort())
            page.evaluate("""fixture=>{const k=kirafanRL,w=k.world,p=w.player,item=fixture.item;window.__failedIcon=fixture.url;
                p.x=w.width/2;p.y=w.height/2;const d={x:p.x+2,y:p.y,items:[item]};window.__failedDrop=d;
                w.drops.push(d);w.events.push({type:'drop',x:d.x,y:d.y,items:d.items,drop:d});k.step(1/60);}""", missing)
            page.wait_for_timeout(200); advance(page)
            failed = page.evaluate("""()=>{let r=null;kirafanRL.scene.traverse(o=>{if(o.userData.weaponIcon===__failedIcon)
                r={frame:!!o.material.map.image?.width,icon:o.children[0].visible};});return r;}""")
            check('地面图案失败仍有边框，不显示空白方块', failed and failed['frame'] and not failed['icon'], failed)
            page.keyboard.down('d'); advance(page, .4); page.keyboard.up('d')
            page.wait_for_selector('#rl-equipment-choice[open]')
            page.wait_for_function("""()=>document.querySelector('#rl-equipment-choice .comparison-columns section:last-child img').hidden""", polling=50)
            check('图案失败时简述仍显示候选名称并可取消',
                  page.locator('#equipment-candidate-name').is_visible()
                  and page.locator('#equipment-keep').is_enabled())
            page.locator('#rl-equipment-choice .equipment-more > summary').click()
            check('比较图案失败仍可读名称、词条并取消', '原作属性' in page.locator('#rl-equipment-choice').inner_text()
                  and not page.locator('#rl-equipment-choice .comparison-columns section').last.locator('img').is_visible()
                  and page.locator('#equipment-keep').is_enabled())
            page.locator('#equipment-keep').click(); context.close()
            # A touch-only primary pointer keeps platform cursor semantics.
            touch = browser.new_context(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True,
                                        java_script_enabled=False)
            touch.route('**/*', lambda route: route.continue_() if route.request.resource_type in ['document', 'stylesheet'] else route.fulfill(status=204))
            page = touch.new_page(); page.goto(base + '/site/game/roguelike.html', wait_until='load')
            data = page.evaluate(CURSORS)
            check('纯触控不启用自定义鼠标', not data['fine'] and 'kirara-crystal' not in data['body'], data)
            touch.close()
            hidpi = browser.new_context(device_scale_factor=2, java_script_enabled=False)
            hidpi.route('**/*', lambda route: route.continue_() if route.request.resource_type in ['document', 'stylesheet'] else route.fulfill(status=204))
            page = hidpi.new_page(); page.goto(base + '/site/game/roguelike.html', wait_until='load')
            data = page.evaluate(CURSORS)
            check('二倍屏继续使用相同逻辑像素热点与系统光标文件', data['fine']
                  and 'kirara-crystal.png' in data['body'] and '6 3' in data['body'], data)
            hidpi.close(); browser.close()
        check('无未捕获页面异常', not report['errors'], report['errors'])
    finally:
        server.shutdown(); worker.join(timeout=5); server.server_close()
        report['after'] = fingerprints()
        report['changed_during_run'] = [name for name, sha in report['before'].items() if report['after'].get(name) != sha]
        report['checks'].append({'label': '验证期间源文件未变化', 'ok': not report['changed_during_run']})
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    return int(any(not row['ok'] for row in report['checks']))


if __name__ == '__main__':
    raise SystemExit(main())
