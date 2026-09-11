"""Natural contract stock/camp, then labelled ground/combat fixtures and real input.

No direct equipment assignment. Room routing, coin, immortality and the stationary
combat target are fixtures; this is not a full-run balance or map traversal test.
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
from rl_persistence_browser import inject_quota
from rl_feedback_experience_browser import STATE, readability
from rl_decisions_browser import frame_fits, expand_comparison
from rl_hud_icons_browser import LAYOUT

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/gadget-contract'
FILES = ['site/game/rl/' + name + '.js' for name in ['main', 'world', 'gadgets', 'equipment', 'skills',
    'combat', 'danmaku', 'roomevents', 'runschema', 'profileschema', 'assistance', 'loot']]
FILES += ['site/game/rl/ui/' + name for name in ['hud.js', 'decisions.js', 'equipmentskills.js', 'equipmentbrief.js', 'skilltooltip.js', 'theme.css']]
FILES += ['site/asset/img/rl/equipment/gadget-' + name + '.svg' for name in ['steady', 'prism', 'binding']]


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def profile(page):
    return page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile'))")


def enter(page, room_type):
    room_id = page.evaluate("""type=>{const k=kirafanRL,w=k.world,r=w.dungeon.rooms.find(r=>r.type===type);
        if(!r)throw Error('缺少自然房间 '+type);w.enterRoom(r.id);k.step(1/60);return r.id;}""", room_type)
    ready(page)
    return room_id


def observe(page):
    page.evaluate("""()=>{const w=kirafanRL.world;window.contractEvents=[];
        window.contractObservedWorlds ||= new WeakSet();
        if(contractObservedWorlds.has(w))return;contractObservedWorlds.add(w);
        const drain=w.drainEvents.bind(w);
        w.drainEvents=()=>{const events=drain();for(const e of events)if(['skill','hit','nextCritical','ultimateSpent'].includes(e.type))
            contractEvents.push({type:e.type,slot:e.slot,crit:e.crit,damage:e.damage,hitFlag:e.hitFlag,
                action:e.action,attacker:e.attacker?.id,target:e.target?.id});return events;};}""")


def generated_item(page, gadget_id, sealed_slot=None):
    return page.evaluate("""async({id,slot})=>{const {rollGadget}=await import('/site/game/rl/gadgets.js');
        const {createRandom}=await import('/site/game/rl/random.js');
        for(let seed=0;seed<10000;seed++){const item=rollGadget(createRandom(seed),'guardian',13);
            if(item?.gadgetId===id&&(slot===null||item.sealedSlot===slot))return item;}
        throw Error('未生成要求的候选');}""", {'id': gadget_id, 'slot': sealed_slot})


def offer_drop(page, item):
    # Stage a real generated candidate outside pickup range, then walk into it.
    page.evaluate("""item=>{const k=kirafanRL,w=k.world,p=w.player;p.x=w.width/2-3;p.y=w.height/2;
        window.contractDrop={x:p.x+2.4,y:p.y,items:[item]};w.drops.push(contractDrop);
        w.events.push({type:'drop',drop:contractDrop,items:contractDrop.items,x:contractDrop.x,y:contractDrop.y});k.step(1/60);}""", item)
    page.keyboard.down('d'); advance(page, .75); page.keyboard.up('d')
    page.wait_for_selector('#rl-equipment-choice[open]')


def take_drop(page, item):
    offer_drop(page, item)
    page.locator('#equipment-confirm').click(); advance(page, .7)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'before': fingerprints(),
              'fixtures': ['第13层入口与房间路由', '500金币与无敌', '具名渠道生成后放到地面的装备', '静止高生命敌人']}

    def check(label, ok, detail=None):
        report['checks'].append({'label': label, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        if not ok:
            raise AssertionError(label + ': ' + str(detail))

    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1280, 'height': 840}, has_touch=True)
            context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
                if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',
                    JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
            page = context.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
            base = 'http://127.0.0.1:%d/site/game/roguelike.html' % server.server_address[1]
            page.goto(base + '?volume=1&floor=13&seed=1', wait_until='load', timeout=60000)
            page.wait_for_selector('.roster-card', timeout=60000)
            # Probe separate pure worlds using exactly the loaded catalogs. Do not
            # alter the game's RNG, stock, map or equipment to force a contract.
            selected = page.evaluate("""async()=>{
                const {createWorld}=await import('/site/game/rl/world.js'),{generateDungeon}=await import('/site/game/rl/dungeon.js');
                const {layoutSeedFor}=await import('/site/game/rl/runschema.js'),{restEventChoices}=await import('/site/game/rl/roomevents.js');
                const live=kirafanRL.world,level=live.encounter?.playerLevel||1;
                for(let seed=1;seed<=5000;seed++){
                    const d=generateDungeon(layoutSeedFor(seed,13),{roomsMin:6,roomsMax:9});
                    const shop=d.rooms.find(r=>r.type==='shop'),rest=d.rooms.find(r=>r.type==='rest');
                    if(!shop||!rest||restEventChoices(rest.seed,0,0,13).at(-1).item.gadgetId!=='prism')continue;
                    const w=createWorld({seed,floor:13,volume:1,tables:live.tables});
                    w.spawnPlayer({card:live.tables.stats.card(14002001),level});w.setDungeon(d);w.enterRoom(shop.id);
                    const stock=w.getShopOffer()[2];if(stock.item.gadgetId==='binding'&&stock.item.sealedSlot===2)
                        return {seed,level,shopId:shop.id,restId:rest.id,stock};
                }throw Error('未找到公开渠道产生的契约组合');}""")
            report['naturalSeed'] = selected
            page.goto(base + '?volume=1&floor=13&seed=' + str(selected['seed']), wait_until='load', timeout=60000)
            page.locator('.roster-card').filter(has=page.locator('img[src$="/14002001.webp"]')).click(timeout=60000)
            ready(page); observe(page)
            check('正常选角为空装备，不持有契约或专武', page.evaluate('kirafanRL.world.player.equipment.length===0'))
            shop_id = enter(page, 'shop'); page.evaluate('kirafanRL.world.coin=500'); press(page, 'KeyE')
            page.wait_for_selector('#shop-panel[open]')
            stock = page.evaluate('kirafanRL.world.getShopOffer()[2]')
            check('真实自然货架与独立种子探测相同，封印固定为技能3', stock == selected['stock'], stock)
            button = page.locator('#shop-items [data-index="2"]')
            skill_name = page.evaluate('kirafanRL.world.getShopQuote(2).preview.skillNames.candidate[2]')
            check('货架先显示具体被封技能、原价和独立罗盘图', skill_name in button.inner_text()
                  and '技能3' in button.inner_text() and '180 金币' in button.inner_text()
                  and button.locator('img').get_attribute('src').endswith('/gadget-binding.svg'))
            page.screenshot(path=str(OUT / 'natural-shop.png'))
            before = page.evaluate(STATE); button.click()
            check('封印代价默认可读，不必先读完整规则',
                  skill_name in page.locator('#rl-equipment-choice .equipment-brief-cost').inner_text()
                  and page.locator('#rl-equipment-choice .equipment-more').get_attribute('open') is None)
            expand_comparison(page)
            check('比较显示候选技能名与原作区别，未提前生效', skill_name in page.locator('#rl-equipment-choice .gadget-cost').inner_text()
                  and '外传机制装备' in page.locator('#rl-equipment-choice').inner_text()
                  and not page.evaluate('kirafanRL.world.player.skills.isSealed(2)') and page.evaluate(STATE) == before)
            check('桌面比较窗口完整落在屏幕内', frame_fits(page, '#rl-equipment-choice'))
            page.locator('#equipment-keep').click(); check('取消不扣费，不重抽封印槽', page.evaluate(STATE) == before)
            button.click(); durable = page.evaluate("localStorage.getItem('kirafan-rl:profile')")
            inject_quota(page); page.locator('#equipment-confirm').click()
            check('真实保存失败不封印、不扣费且不改持久记录', page.evaluate('profileAttempts') > 0
                  and page.evaluate(STATE) == before and page.evaluate("localStorage.getItem('kirafan-rl:profile')") == durable
                  and not page.evaluate('kirafanRL.world.player.skills.isSealed(2)'),
                  {'attempts': page.evaluate('profileAttempts'), 'unchanged': page.evaluate(STATE) == before,
                   'durableSame': page.evaluate("localStorage.getItem('kirafan-rl:profile')") == durable,
                   'sealed': page.evaluate('kirafanRL.world.player.skills.isSealed(2)')})
            page.evaluate('window.blockWrites=false'); page.locator('#equipment-confirm').click(); advance(page)
            saved = profile(page)['run']
            check('成功确认才一起保存封印、扣费与货位已售', saved['coin'] == 320
                  and saved['equipment'][0]['sealedSlot'] == 2
                  and next(c for c in saved['roomClaims'] if c['id'] == shop_id)['offer'][2]['bought'])
            page.locator('#shop-close').click(); advance(page)
            check('装上契约默认不启动自动操作', not page.evaluate('kirafanRL.world.assistance.enabled'))
            sealed = page.locator('.hud-skill[data-slot="2"]')
            check('技能3独立标记封印，技能2仍可用', sealed.get_attribute('data-sealed') == 'true'
                  and sealed.get_attribute('aria-disabled') == 'true' and sealed.locator('.hud-skill-secs').inner_text() == '封印'
                  and page.locator('.hud-skill[data-slot="1"]').get_attribute('aria-disabled') == 'false')
            press(page, 'Digit3'); advance(page, .6)
            check('真实键盘不能施放封印技能，也不消耗冷却', page.evaluate('!contractEvents.some(e=>e.type==="skill") && kirafanRL.world.player.skills.slots[2].remaining===0'))
            press(page, 'Digit2'); advance(page, .6)
            check('另一技能通过真实按键正常进入冷却', page.evaluate('contractEvents.some(e=>e.type==="skill"&&e.slot===1) && kirafanRL.world.player.skills.slots[1].remaining>0'))
            page.evaluate('kirafanRL.world.player.skills.addGauge(100000)'); advance(page)
            check('技能封印不封R必杀', page.locator('.hud-gauge').get_attribute('aria-disabled') == 'false')
            sealed.hover(); advance(page)
            check('禁用按钮仍能解释封印原因，不被全局隐藏', page.locator('.hud-skill-tooltip').is_visible()
                  and '替换护甲后解除' in page.locator('.skill-tooltip-state').inner_text())
            contrasts = readability(page, '.hud-skill-sealed .hud-skill-secs, .skill-tooltip-state')
            check('封印文字与原因对比度至少4.5', contrasts and all(r['ratio'] >= 4.5 for r in contrasts), contrasts)
            page.screenshot(path=str(OUT / 'sealed-desktop.png')); page.keyboard.press('Escape')
            press(page, 'Escape'); page.locator('#menu-equipment').click()
            check('当前装备面板显示同一技能名与固定封印', skill_name in page.locator('#rl-equipment-collection .gadget-cost').inner_text())
            page.keyboard.press('Escape'); page.locator('#menu-resume').click(); advance(page)
            page.reload(wait_until='load'); page.locator('#roster-continue').click(timeout=60000); ready(page); observe(page)
            check('真实刷新续档保留封印槽且不自动开战', page.evaluate('kirafanRL.world.player.skills.isSealed(2) && !kirafanRL.world.player.skills.isSealed(1) && !kirafanRL.world.assistance.enabled'))
            enter(page, 'shop')
            check('续档保留原货架封印值、原价及已售状态', page.evaluate('kirafanRL.world.getShopOffer()[2]')
                  == {**stock, 'bought': True})

            other = generated_item(page, 'binding', 1); report['groundVariant'] = other
            offer_drop(page, other)
            expand_comparison(page)
            names = page.evaluate('kirafanRL.world.player.skills.slots.map(s=>s.name)')
            costs = page.locator('#rl-equipment-choice .gadget-cost').all_inner_texts()
            check('步行拾取不同封印变体，比较两边展示各自技能名', len(costs) == 2
                  and names[2] in costs[0] and names[1] in costs[1]
                  and '技能3' in costs[0] and '技能2' in costs[1])
            page.set_viewport_size({'width': 844, 'height': 390})
            page.locator('#rl-equipment-choice h2').tap()
            check('横屏触控比较窗口与确认按钮可见', frame_fits(page, '#rl-equipment-choice')
                  and page.locator('#equipment-confirm').is_visible())
            page.screenshot(path=str(OUT / 'binding-touch-compare.png'))
            page.locator('#equipment-confirm').tap(); advance(page, .7)
            check('触控确认换封印槽，旧槽解除且新槽保存', page.evaluate('kirafanRL.world.player.skills.isSealed(1) && !kirafanRL.world.player.skills.isSealed(2)')
                  and profile(page)['run']['equipment'][0]['sealedSlot'] == 1)
            before_events = page.evaluate('contractEvents.filter(e=>e.type==="skill").length')
            box = page.locator('.hud-skill[data-slot="1"]').bounding_box()
            page.touchscreen.tap(box['x'] + box['width']/2, box['y'] + box['height']/2); advance(page, .6)
            check('真实触控点击封印按钮不施放或残留按键', page.evaluate('contractEvents.filter(e=>e.type==="skill").length') == before_events
                  and page.evaluate('!kirafanRL.input.state.skill[1]'))
            layout = page.evaluate(LAYOUT); report['touchLayout'] = layout
            check('横屏触控技能、必杀和移动操作区不重叠', not layout['overlaps'] and layout['scroll'] <= 844, layout)
            page.screenshot(path=str(OUT / 'sealed-touch.png'))

            page.set_viewport_size({'width': 1280, 'height': 840}); rest_id = enter(page, 'rest')
            press(page, 'KeyE'); page.wait_for_selector('#rl-supply-choice[open]')
            commission = page.evaluate("kirafanRL.world.getSupplyOffer().options.find(o=>o.id==='commission')")
            check('同一自然地图的营地给出无相契约与固定96金币修缮费', commission['item']['gadgetId'] == 'prism'
                  and commission['coinCost'] == 96 and '不利属性' in page.locator('#supply-commission').inner_text(), commission['item'])
            before = page.evaluate(STATE); page.locator('#supply-commission').click()
            check('营地预览不扣费且明示新取舍', page.evaluate(STATE) == before
                  and '克制增幅' in page.locator('.room-event-preview').inner_text())
            page.screenshot(path=str(OUT / 'natural-camp-contract.png'))
            page.locator('#room-event-confirm').click(); advance(page, .7)
            check('确认营地无相契约后解除技能封印，并只扣一次修缮费', page.evaluate('kirafanRL.world.player.gadgets.noAdvantage && !kirafanRL.world.player.skills.isSealed(1) && !kirafanRL.world.player.skills.isSealed(2)')
                  and profile(page)['run']['coin'] == 224 and profile(page)['run']['equipment'][0]['gadgetId'] == 'prism'
                  and any(c['id'] == rest_id and c['rested'] for c in profile(page)['run']['roomClaims']))

            for gid in ['prism', 'steady']:
                enter(page, 'shop' if gid == 'prism' else 'start')
                if gid == 'steady':
                    take_drop(page, generated_item(page, gid))
                observe(page)
                page.evaluate("""id=>{const k=kirafanRL,w=k.world,p=w.player,art=w.encounter.mobs[0];
                    p.x=w.width/2-3;p.y=w.height/2;p.skills.clearEffects();w.aim=null;w.rng=()=>0;
                    const advantage=[3,0,1,2,5,4][p.element];
                    window.contractTarget=w.spawnEnemy({x:p.x+(id==='prism'?4.4:1.5),y:p.y,hp:1000000,
                        atk:0,def:0,mdef:0,element:advantage,model:art.model,nameZh:art.nameZh,shadowScale:art.shadowScale});
                    contractTarget.actionTimer=1e9;p.iframes=1e9;k.step(1/60);}""", gid)
                ready(page); start_x = page.evaluate('kirafanRL.world.player.x')
                press(page, 'KeyH'); advance(page, 2.4)
                evidence = page.evaluate("""()=>{const k=kirafanRL,w=k.world,p=w.player,t=contractTarget;return {
                    enabled:w.assistance.enabled,x:p.x,y:p.y,
                    state:p.sm.state,stateTime:p.sm.stateTime,facing:p.facing,profile:p.weaponProfile,
                    assistance:{...w.assistance},aim:w.aim,frozen:w.frozen,roomLoading:k.roomLoading,
                    target:{id:t.id,x:t.x,y:t.y,hp:t.hp,iframes:t.iframes,dead:t.dead,radius:t.radius},
                    input:JSON.parse(JSON.stringify(k.input.state)),colliders:w.roomColliders,events:contractEvents,
                    hits:contractEvents.filter(e=>e.type==='hit'&&e.target===t.id)};}""")
                evidence['startX'] = start_x
                page.screenshot(path=str(OUT / (gid + '-combat.png')))
                check(gid + ' 通过真实开关自动攻击并执行对应契约', evidence['enabled'] and evidence['hits']
                      and all((not h['crit']) if gid == 'steady' else h['hitFlag'] == 0 for h in evidence['hits']), evidence)
                check(gid + ' 移动方式符合描述', abs(evidence['x'] - start_x) < 1e-6 if gid == 'steady'
                      else evidence['x'] > start_x + .8, evidence)
                press(page, 'KeyH')

            enter(page, 'shop')
            take_drop(page, {'slot': 'armor', 'rarity': 'common', 'affixes': []})
            check('正常替换护甲后全部契约无残留且自动化关闭', page.evaluate("""()=>{const p=kirafanRL.world.player;
                return !p.gadgets.noCrit&&!p.gadgets.noAdvantage&&!p.gadgets.sealedSlots.length
                    &&!kirafanRL.world.assistance.enabled&&p.base.critChance>0;}"""))
            page.reload(wait_until='load'); page.locator('#roster-continue').click(timeout=60000); ready(page)
            check('解除契约后的存档不会重新附加封印或禁暴', page.evaluate('!kirafanRL.world.player.gadgets.noCrit && !kirafanRL.world.player.gadgets.noAdvantage && kirafanRL.world.player.gadgets.sealedSlots.length===0'))
            check('没有未捕获页面异常', not report['errors'], report['errors'])
            report['after'] = fingerprints(); check('验证期间产品与图示源文件未变', report['before'] == report['after'])
            context.close(); browser.close()
    finally:
        server.shutdown(); worker.join(timeout=5); report['after'] = fingerprints()
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()
