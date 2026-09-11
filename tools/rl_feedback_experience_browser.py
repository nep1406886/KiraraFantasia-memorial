"""Real acquisition/choice/input/save workflows. Seeded drops are fixtures, not direct equips."""
import functools
import hashlib
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss, press
from rl_persistence_browser import inject_quota
from rl_floor_loot_browser import ready, landscape_ready
from rl_decisions_browser import frame_fits, expand_comparison

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/experience'
STATE = """() => {const w=kirafanRL.world,p=w.player;return JSON.stringify({hp:p.hp,coin:w.coin,
    equipment:p.equipment,gauge:p.skills.gauge,claims:w.getRoomClaims()});}"""
FILES = ['site/game/rl/world.js', 'site/game/rl/main.js', 'site/game/rl/gadgets.js', 'site/game/rl/loot.js',
         'site/game/rl/roomevents.js', 'site/game/rl/assistance.js', 'site/game/rl/ui/decisions.js',
         'site/game/rl/ui/hud.js', 'site/game/rl/ui/theme.css', 'site/game/rl/ui/storage.js']


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def readability(page, selector):
    return page.locator(selector).evaluate_all("""nodes=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
        const ctx=canvas.getContext('2d');
        const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);
            return [...ctx.getImageData(0,0,1,1).data].map((n,i)=>i===3?n/255:n);};
        const blend=(a,b)=>[0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3]));
        const luma=c=>c.map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4)
            .reduce((v,n,i)=>v+n*[.2126,.7152,.0722][i],0);
        return nodes.filter(n=>n.getClientRects().length).map(n=>{
            const ancestors=[];for(let a=n;a;a=a.parentElement)ancestors.unshift(a);
            let bg=[255,255,255],opacity=1;for(const a of ancestors){const s=getComputedStyle(a);
                bg=blend(rgba(s.backgroundColor),bg);opacity*=Number(s.opacity);}
            const fg=rgba(getComputedStyle(n).color);fg[3]*=opacity;
            const a=luma(blend(fg,bg)),b=luma(bg);
            return {text:n.textContent,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
        });}""")


def acquire(page, item):
    # A generated candidate is staged on the ground; no equipment is assigned.
    page.evaluate("""item=>{const k=kirafanRL,w=k.world,p=w.player;p.x=w.width/2;p.y=w.height/2;
        window.currentDrop={x:p.x+2.5,y:p.y,items:[item]};w.drops.push(currentDrop);
        w.events.push({type:'drop',drop:currentDrop,items:currentDrop.items,x:currentDrop.x,y:currentDrop.y});
        k.step(1/60);p.x=currentDrop.x;k.step(1/60);}""", item)
    page.wait_for_selector('#rl-equipment-choice[open]')
    page.locator('#equipment-confirm').click(); advance(page, 1 / 60)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'layouts': [], 'before': fingerprints()}
    def check(label, ok, detail=None):
        report['checks'].append({'label': label, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        if not ok:
            raise AssertionError(label + ': ' + str(detail))
    with Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT))) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
                context = browser.new_context(viewport={'width': 1280, 'height': 840}, has_touch=True)
                context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
                    if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',
                    JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
                page = context.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
                # This floor-9 layout contains a naturally rolled altar; no prop is injected.
                page.goto('http://127.0.0.1:%d/site/game/roguelike.html?volume=1&floor=9&seed=260903' % server.server_address[1],
                          wait_until='load', timeout=60000)
                page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]')).click(timeout=60000)
                def settled():
                    ready(page)
                settled()
                check('正常选角后没有装备专武', page.evaluate('kirafanRL.world.player.equipment.length===0'))
                ids = page.evaluate("""async()=>{
                    const {rollLoot}=await import('/site/game/rl/loot.js'),{createRandom}=await import('/site/game/rl/random.js');
                    const {GADGETS}=await import('/site/game/rl/gadgets.js'),rng=createRandom(912),found={};
                    for(let i=0;i<1000;i++)for(const source of ['chest','elite','guardian'])
                        for(const item of rollLoot(rng,9,0,kirafanRL.world.player.card,{source}))if(item.gadgetId)found[item.gadgetId]=item;
                    window.mechanicDrops=found;return GADGETS.map(g=>g.id).filter(id=>found[id]);
                }""")
                check('第9层具名渠道生成八类机制候选（非概率抽样验收）', len(ids) == 8, ids)
                # Keep pathfinding gear last for the subsequent assistance checks.
                ids = [gid for gid in ids if gid != 'hunter'] + ['hunter']
                for gid in ids:
                    info = page.evaluate("""async id=>{
                        const k=kirafanRL,w=k.world,p=w.player,{gadgetDefinition}=await import('/site/game/rl/gadgets.js');
                        const {equipmentIcon}=await import('/site/game/rl/ui/decisions.js');
                        const item=mechanicDrops[id],g=gadgetDefinition(item);p.x=w.width/2;p.y=w.height/2;
                        window.currentDrop={x:p.x+2.5,y:p.y,items:[item]};w.drops.push(currentDrop);
                        w.events.push({type:'drop',drop:currentDrop,items:currentDrop.items,x:currentDrop.x,y:currentDrop.y});
                        k.step(1/60);return {name:g.name,icon:equipmentIcon(item),benefit:g.benefit,cost:g.cost};
                    }""", gid)
                    suffix = info['icon']
                    page.wait_for_function("""suffix=>kirafanRL.scene.children.some(n=>n.userData.weaponIcon?.endsWith(suffix)
                        && n.children[0]?.material.map.image?.width>0)""", arg=suffix, polling=50, timeout=30000)
                    page.evaluate('kirafanRL.world.player.x=currentDrop.x;kirafanRL.step(1/60)')
                    page.wait_for_selector('#rl-equipment-choice')
                    expand_comparison(page)
                    detail = page.locator('[data-gadget-id="%s"]' % gid).last.inner_text()
                    check(gid + ' 比较明确名称、收益和代价', all(s in detail for s in [info['name'], info['benefit'], info['cost']]), detail)
                    if gid == 'rhythm':
                        before = page.evaluate(STATE); page.keyboard.press('Escape')
                        check('取消机制装备不变更装备/面板/消费', page.evaluate(STATE) == before)
                        page.evaluate('kirafanRL.world.player.x-=3;kirafanRL.step(1/60);kirafanRL.world.player.x=currentDrop.x;kirafanRL.step(1/60)')
                    page.locator('#equipment-confirm').click(); advance(page, 1 / 60)
                    check(gid + ' 通过真实拾取提交且地面物品移除', page.evaluate("""id=>{
                        const w=kirafanRL.world;return w.player.equipment.some(i=>i.gadgetId===id)&&!w.drops.includes(currentDrop);
                    }""", gid))
                check('巡猎装配后默认关闭且显示开关', page.locator('.hud-assist').is_visible()
                      and page.locator('.hud-assist').get_attribute('aria-pressed') == 'false')
                page.screenshot(path=str(OUT / 'gadgets-equipped.png'))
                page.evaluate("""()=>{const w=kirafanRL.world,p=w.player,s=w.encounter.mobs[0];
                    window.target=w.spawnEnemy({x:p.x+1.3,y:p.y,hp:100000,atk:0,def:0,model:s.model,nameZh:s.nameZh});
                    target.actionTimer=1e9;target.summoned=true;p.iframes=1e9;}""")
                before = page.evaluate('target.hp'); advance(page, 1)
                check('不开启时不会自动攻击', page.evaluate('target.hp') == before)
                press(page, 'KeyH'); advance(page, 1)
                check('H 开启后产生真实普通攻击伤害', page.evaluate('target.hp') < before)
                x = page.evaluate('kirafanRL.world.player.x'); page.keyboard.down('KeyA'); advance(page, .15); page.keyboard.up('KeyA')
                check('自动化时手动移动优先', page.evaluate('kirafanRL.world.player.x') < x)
                press(page, 'Escape'); before = page.evaluate(STATE); advance(page, .3)
                check('菜单暂停不继续自动行动', page.evaluate(STATE) == before and page.evaluate('kirafanRL.world.frozen'))
                page.locator('#menu-resume').click()
                page.evaluate("""()=>{const k=kirafanRL,w=k.world;target.iframes=0;w.danmaku.clear();
                    w.danmaku.emit('aimed',{x:target.x-.6,y:target.y,angle:0},
                        {side:'player',power:999999999,coef:1,count:1,speed:10,life:3});
                    for(let i=0;i<120&&!target.dead;i++)k.step(1/60);
                    if(!target.dead)throw Error('测试目标必须通过真实伤害死亡');}""")
                for width, height, touch in [(1280, 840, False), (375, 812, True), (390, 844, True), (430, 932, True), (844, 390, True)]:
                    page.set_viewport_size({'width': width, 'height': height})
                    page.wait_for_function('portrait=>document.body.classList.contains("landscape-required")===portrait',
                                           arg=height > width, polling=50)
                    if height > width:
                        before = page.evaluate(STATE); advance(page, .3)
                        check('%sx%s 竖屏保护暂停自动行动' % (width, height), page.locator('#landscape-guard').is_visible()
                              and page.evaluate('kirafanRL.world.frozen') and page.evaluate(STATE) == before)
                        page.screenshot(path=str(OUT / ('portrait-%sx%s.png' % (width, height))))
                        continue
                    if touch: page.touchscreen.tap(8, 8)
                    else: page.keyboard.press('Shift')
                    advance(page, 1 / 60)
                    row = page.evaluate("""()=>{
                        const sels=['.hud-assist','.hud-pause','.hud-skillbar','.hud-gauge','.touch-attack','.touch-dodge','.touch-interact','#minimap'];
                        const areas=sels.map(s=>{const n=document.querySelector(s),r=n.getBoundingClientRect();return {s,x:r.x,y:r.y,w:r.width,h:r.height};})
                            .filter(r=>r.w&&r.h);const overlaps=[];
                        for(let i=0;i<areas.length;i++)for(let j=i+1;j<areas.length;j++){const a=areas[i],b=areas[j];
                            if(a.x<b.x+b.w-1&&b.x<a.x+a.w-1&&a.y<b.y+b.h-1&&b.y<a.y+a.h-1)overlaps.push([a.s,b.s]);}
                        const button=areas.find(a=>a.s==='.hud-assist'),node=document.querySelector('.hud-assist');
                        const hit=document.elementFromPoint(button.x+button.w/2,button.y+button.h/2);
                        return {width:innerWidth,height:innerHeight,areas,overlaps,reachable:node.contains(hit),
                            fits:areas.every(a=>a.x>=0&&a.y>=0&&a.x+a.w<=innerWidth+1&&a.y+a.h<=innerHeight+1),
                            target:button.w>=44&&button.h>=44,scroll:document.documentElement.scrollWidth};
                    }""")
                    report['layouts'].append(row)
                    check('%sx%s 机制开关不挤压技能/必杀/小地图' % (width, height), row['fits'] and row['target']
                          and row['reachable'] and not row['overlaps'] and row['scroll'] <= width, row)
                    page.screenshot(path=str(OUT / ('hud-%sx%s.png' % (width, height))))
                was = page.evaluate('kirafanRL.world.assistance.enabled')
                page.locator('.hud-assist').tap(); advance(page, 1 / 60)
                check('触控开关也能改变真实自动化状态', page.evaluate('kirafanRL.world.assistance.enabled') != was)
                origin = page.locator('#hp-display').evaluate("""n=>{const r=n.getBoundingClientRect();
                    return {x:r.x+r.width/2,y:r.y+r.height/2};}""")
                check('状态文字仍允许触控穿透到移动区', page.evaluate("""p=>document.elementFromPoint(p.x,p.y)
                    ?.classList.contains('touch-zone')""", origin))
                cdp = context.new_cdp_session(page)
                cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [origin]})
                cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{**origin, 'x': origin['x'] + 65}]})
                check('触控区仍产生右移意图', page.evaluate('kirafanRL.input.state.move.x') > .9)
                cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
                check('触控结束不遗留移动按键', page.evaluate('kirafanRL.input.state.move.x===0 && kirafanRL.input.state.move.y===0'))
                cdp.detach()
                landscape_ready(page)
                plain_armor = page.evaluate("""async()=>{const {rollLoot}=await import('/site/game/rl/loot.js');
                    const {createRandom}=await import('/site/game/rl/random.js');return rollLoot(createRandom(814),9,0,
                        kirafanRL.world.player.card,{source:'shop',slot:'armor'})[0];}""")
                acquire(page, plain_armor)
                rest_id = page.evaluate("""()=>{const k=kirafanRL,w=k.world,r=w.dungeon.rooms.find(r=>r.type==='rest');
                    w.enterRoom(r.id);w.coin=100;k.step(1/60);return r.id;}""")
                settled(); press(page, 'KeyE')
                page.wait_for_selector('#rl-supply-choice')
                check('营地真实入口显示四种互斥事件', page.locator('.room-event-option').count() == 4)
                contrasts = readability(page, '#rl-supply-choice .gadget-cost, #rl-supply-choice button:disabled span')
                check('营地代价与禁用原因对比度不低于4.5', contrasts and all(row['ratio'] >= 4.5 for row in contrasts), contrasts)
                commission = page.evaluate("kirafanRL.world.getSupplyOffer().options.find(o=>o.id==='commission')")
                fee = {'sentry': 54, 'hunter': 78, 'steady': 72}[commission['item']['gadgetId']]
                check('营地公开具体机关、固定修缮费与代价', commission['coinCost'] == fee
                      and commission['label'] in page.locator('#supply-commission').inner_text())
                before = page.evaluate(STATE); page.locator('#supply-commission').click()
                check('选择旧机关只预览，没有扣费', page.evaluate(STATE) == before)
                page.set_viewport_size({'width': 390, 'height': 844})
                check('已打开的营地选择在手机竖屏仍可阅读和取消', frame_fits(page, '#rl-supply-choice'))
                page.screenshot(path=str(OUT / 'camp-preview-390.png'))
                page.keyboard.press('Escape'); check('关闭事件后仍未消费', page.evaluate(STATE) == before)
                landscape_ready(page)
                press(page, 'KeyE'); page.locator('#supply-commission').click()
                durable = page.evaluate("localStorage.getItem('kirafan-rl:profile')")
                inject_quota(page); page.locator('#room-event-confirm').click()
                check('真实存储故障保持窗口和世界未变', page.locator('#rl-supply-choice').is_visible()
                      and page.evaluate(STATE) == before and page.evaluate("localStorage.getItem('kirafan-rl:profile')") == durable)
                check('失败后确认按钮可重试且明确未消费', page.locator('#room-event-confirm').is_enabled()
                      and '未消费' in page.locator('#rl-supply-choice .decision-status').inner_text())
                page.evaluate('window.blockWrites=false'); page.locator('#room-event-confirm').click(); advance(page, 1 / 60); dismiss(page)
                check('修缮费只扣一次且事件消费与装备同时落盘', page.evaluate("""fee=>{
                    const w=kirafanRL.world,s=JSON.parse(localStorage.getItem('kirafan-rl:profile')).run;
                    return w.coin===100-fee && s.coin===100-fee && JSON.stringify(s.equipment)===JSON.stringify(w.player.equipment)
                        && s.roomClaims.some(r=>r.supply==='commission'&&r.rested);
                }""", fee))
                saved = page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).run")
                page.reload(wait_until='load'); page.locator('#roster-continue').click(timeout=60000); settled()
                check('机制装备经真实续档保留，自动化不静默启动', page.evaluate('kirafanRL.world.player.equipment') == saved['equipment']
                      and not page.evaluate('kirafanRL.world.assistance.enabled'))
                page.evaluate('id=>{kirafanRL.world.enterRoom(id);kirafanRL.step(1/60)}', rest_id); settled()
                check('营地续档后不能重复领取', page.evaluate('kirafanRL.world.getSupplyOffer().used'))
                if page.evaluate("kirafanRL.world.player.equipment.some(i=>i.slot==='armor')"):
                    # Replace through pickup, not by bypassing duplicate-effect validation.
                    item = page.evaluate("async()=>{const {makeGadget}=await import('/site/game/rl/gadgets.js');return makeGadget('sentry');}")
                    acquire(page, item)
                battle_ids = page.evaluate("kirafanRL.world.dungeon.rooms.filter(r=>r.type==='battle').map(r=>r.id)")
                altar_id = None
                for rid in battle_ids:
                    page.evaluate('id=>{kirafanRL.world.enterRoom(id);kirafanRL.step(1/60)}', rid); settled()
                    if page.evaluate('!!kirafanRL.world.altar'):
                        altar_id = rid; break
                check('实际种子中存在祭坛', altar_id is not None, battle_ids)
                page.evaluate("""()=>{const k=kirafanRL,w=k.world,p=w.player;p.x=2;p.y=2;
                    w.enemies.forEach(e=>{e.actionTimer=1e9;e.iframes=0;w.danmaku.emit('aimed',
                        {x:e.x-.6,y:e.y,angle:0},{side:'player',power:999999999,coef:1,count:1,speed:10,life:3});});
                    for(let i=0;i<180&&w.enemies.some(e=>!e.dead);i++)k.step(1/60);
                    if(w.enemies.some(e=>!e.dead))throw Error('祭坛战斗必须通过真实伤害清场');
                    p.hp=p.maxHp;p.x=w.altar.x;p.y=w.altar.y+1.3;k.step(1/60);}""")
                settled(); page.wait_for_function("kirafanRL.scene.getObjectByName('native-shrine')?.children.length===4", polling=50, timeout=60000)
                advance(page, .2); page.screenshot(path=str(OUT / 'shrine-in-game.png'))
                press(page, 'KeyE'); page.wait_for_selector('#rl-altar-choice')
                oath_id = page.evaluate("kirafanRL.world.getAltarOffer().options.find(o=>o.id==='oath').item.gadgetId")
                check('第9层自然誓约在已开放机关中固定选择', oath_id in ['hunter', 'steady'], oath_id)
                before = page.evaluate(STATE); page.locator('#altar-oath').click()
                check('祭坛生命契约预览不扣生命或消耗书册', page.evaluate(STATE) == before)
                contrasts = readability(page, '#rl-altar-choice .gadget-cost')
                check('选中后的生命与能力代价仍保持4.5对比度', contrasts and all(row['ratio'] >= 4.5 for row in contrasts), contrasts)
                page.set_viewport_size({'width': 390, 'height': 844})
                check('生命契约的收益和代价在竖屏窗口内可阅读', frame_fits(page, '#rl-altar-choice'))
                page.screenshot(path=str(OUT / 'shrine-contract-390.png'))
                page.locator('.room-event-scroll').evaluate('n=>n.scrollTop=n.scrollHeight')
                page.screenshot(path=str(OUT / 'shrine-contract-details-390.png'))
                page.locator('#room-event-confirm').click(); advance(page, 1 / 60)
                check('原作祭坛确认后只隐藏书册并保留灯具', page.evaluate("""id=>{
                    const w=kirafanRL.world,s=kirafanRL.scene.getObjectByName('native-shrine');
                    return w.altar.used && s.children.filter(n=>n.visible).length===3
                        && w.player.equipment.some(i=>i.gadgetId===id);
                }""", oath_id))
                check('没有未捕获页面错误', not report['errors'], report['errors'])
                report['after'] = fingerprints()
                check('验证期间产品源文件未改变', report['before'] == report['after'])
                context.close(); browser.close()
        finally:
            report['after'] = fingerprints()
            server.shutdown(); worker.join(timeout=5)
            (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')

if __name__ == '__main__':
    main()
