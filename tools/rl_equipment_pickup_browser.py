"""Compact pickup UX with real input and existing save transactions.

Fixed candidates/room/coin and invulnerability are fixtures. Manual fixed steps
make state comparisons deterministic; this is not a natural-frame performance test.
"""
import functools
import hashlib
import io
import json
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from PIL import Image, ImageColor
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import ready, advance
from rl_gadget_contract_browser import offer_drop, enter
from rl_equipment_skills_browser import reopen_drop
from rl_persistence_browser import inject_quota
from rl_decisions_browser import frame_fits

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/equipment-pickup'
FILES = ['site/game/rl/' + name for name in ['equipment.js', 'world.js', 'main.js', 'skills.js',
    'gadgets.js', 'ui/equipmentbrief.js', 'ui/equipmentskills.js', 'ui/decisions.js', 'ui/theme.css']]


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            if (ROOT / name).exists() else None for name in FILES}


def snapshot(page):
    return page.evaluate('''()=>{const w=kirafanRL.world,p=w.player;return {items:p.equipment,
        stats:p.base,hp:p.hp,coin:w.coin,skills:p.skills.describeLoadout(),gauge:p.skills.gauge,
        save:localStorage.getItem('kirafan-rl:profile'),drop:contractDrop.items};}''')


def brief_layout(page):
    return page.locator('#rl-equipment-choice').evaluate('''d=>{
        const scroll=d.querySelector('.comparison-scroll'),brief=d.querySelector('.equipment-brief');
        const box=scroll.getBoundingClientRect();
        const rows=brief?[...brief.querySelectorAll('p')]:[];
        return {text:brief?.innerText,scrollHeight:scroll.scrollHeight,height:scroll.clientHeight,
            atTop:scroll.scrollTop===0,rowsVisible:rows.length>0&&rows.every(el=>{const r=el.getBoundingClientRect();
                return r.top>=box.top-.5&&r.bottom<=box.bottom+.5&&el.scrollWidth<=el.clientWidth+1;}),
            actions:[...d.querySelectorAll('.decision-actions button')].map(b=>b.getBoundingClientRect().height)};
    }''')


def discard_fixture(page):
    page.locator('#equipment-keep').tap()
    # Remove only this declined fixture before staging another at the same
    # point; walking back would otherwise legitimately re-offer old loot.
    page.evaluate('''()=>{const drops=kirafanRL.world.drops,index=drops.indexOf(contractDrop);
        if(index>=0)drops.splice(index,1);}''')
    advance(page)


def run(page, base, check, report):
    page.goto(base + '?volume=1&floor=13&seed=176', wait_until='load', timeout=60000)
    page.wait_for_selector('.roster-card', timeout=60000)
    page.locator('.roster-card').filter(has=page.locator('img[src$="/22002001.webp"]')).click()
    ready(page)
    rhythm = {'slot': 'charm', 'rarity': 'rare', 'gadgetId': 'rhythm', 'affixes': []}
    offer_drop(page, rhythm)
    dialog = page.locator('#rl-equipment-choice')
    more = dialog.locator('.equipment-more')
    page.screenshot(path=str(OUT / 'first-pickup.png'))
    check('拾取默认是一张小卡，完整对照折叠', more.count() == 1
          and more.get_attribute('open') is None
          and dialog.locator('.equipment-brief').is_visible()
          and not dialog.locator('.comparison-stats').is_visible())
    check('默认直接说明普攻加速和减伤，不展示规则墙',
          '20%' in dialog.locator('.equipment-brief').inner_text()
          and '10%' in dialog.locator('.equipment-brief-cost').inner_text()
          and '普攻伤害' in dialog.locator('.equipment-brief-cost').inner_text()
          and '优先级' not in dialog.inner_text() and '原作属性' not in dialog.inner_text())
    check('两个主操作简短明确', page.locator('#equipment-keep').inner_text() == '不换'
          and page.locator('#equipment-confirm').inner_text() == '换上')
    before = snapshot(page)
    for width, height in [(1280, 840), (844, 390), (640, 360), (568, 320)]:
        page.set_viewport_size({'width': width, 'height': height})
        layout = brief_layout(page)
        check(str(width) + 'x' + str(height) + '默认无需滚动即可读收益、代价和操作',
              frame_fits(page, '#rl-equipment-choice') and frame_fits(page, '#equipment-confirm')
              and layout['atTop'] and layout['rowsVisible']
              and layout['scrollHeight'] <= layout['height'] + 1
              and all(size >= 44 for size in layout['actions']), layout)
        page.screenshot(path=str(OUT / ('rhythm-' + str(width) + 'x' + str(height) + '.png')))
    page.set_viewport_size({'width': 1280, 'height': 840})
    more.locator(':scope > summary').focus(); page.keyboard.press('Enter')
    check('键盘可展开完整技能、词条和数值对照', more.get_attribute('open') is not None
          and dialog.locator('.comparison-stats').is_visible()
          and dialog.locator('.equipment-skill-rules').is_visible())
    check('展开收起都不改装备、冷却、量能或存档', snapshot(page) == before)
    page.screenshot(path=str(OUT / 'details-desktop.png'))
    more.locator(':scope > summary').click()
    check('收起后回到小卡且焦点留在详情按钮', more.get_attribute('open') is None
          and more.locator(':scope > summary').evaluate('el=>el===document.activeElement')
          and snapshot(page) == before)
    page.locator('#equipment-keep').click()
    check('不换保留物品、装备和存档，并解除冻结', snapshot(page) == before
          and page.evaluate('!kirafanRL.world.frozen'))
    reopen_drop(page)
    check('再次拾取仍默认收起，不沿用上次阅读位置', more.get_attribute('open') is None
          and brief_layout(page)['atTop'])
    before = snapshot(page)
    inject_quota(page); page.locator('#equipment-confirm').click()
    check('存档失败仍保留候选和全部原状态，允许重试', snapshot(page) == before
          and not page.locator('#equipment-confirm').is_disabled()
          and '未提交' in dialog.locator('.decision-status').inner_text())
    page.set_viewport_size({'width': 568, 'height': 320})
    check('短横屏存档错误和重试按钮仍可读', frame_fits(page, '#equipment-confirm')
          and frame_fits(page, '#rl-equipment-choice > .decision-status')
          and brief_layout(page)['rowsVisible'])
    page.screenshot(path=str(OUT / 'save-error-568x320.png'))
    page.evaluate('window.blockWrites=false'); page.locator('#equipment-confirm').tap(); advance(page)
    check('触控确认后才装备并消费一次', page.evaluate('''()=>{const w=kirafanRL.world;
        return w.player.equipment.filter(i=>i.gadgetId==='rhythm').length===1&&contractDrop.items.length===0
            &&!w.frozen;}'''))
    page.reload(wait_until='load'); page.locator('#roster-continue').click(timeout=60000); ready(page)
    check('刷新续档保留同件装备，不依赖展开状态',
          page.evaluate('kirafanRL.world.player.equipment.some(i=>i.gadgetId==="rhythm")'))

    cases = [
        ({'slot': 'armor', 'rarity': 'epic', 'gadgetId': 'steady', 'affixes': []}, '不能暴击'),
        ({'slot': 'armor', 'rarity': 'epic', 'gadgetId': 'prism', 'affixes': []}, '有利属性'),
        ({'slot': 'armor', 'rarity': 'epic', 'gadgetId': 'binding', 'sealedSlot': 2, 'affixes': []}, '技能 3'),
        ({'slot': 'amulet', 'rarity': 'rare', 'gadgetId': 'reach', 'affixes': []}, '物防'),
    ]
    page.set_viewport_size({'width': 844, 'height': 390})
    for item, cost in cases:
        offer_drop(page, item)
        check(item['gadgetId'] + '关键代价不用展开即可看到', more.get_attribute('open') is None
              and cost in dialog.locator('.equipment-brief-cost').inner_text()
              and brief_layout(page)['rowsVisible'], {'layout': brief_layout(page),
                  'name': dialog.locator('.comparison-summary-name').inner_text(),
                  'cost': dialog.locator('.equipment-brief-cost').inner_text()})
        if item['gadgetId'] == 'binding':
            name = page.evaluate('kirafanRL.world.previewEquipment(contractDrop.items[0]).skillNames.candidate[2]')
            check('封印简述使用该角色真实技能名', name in dialog.locator('.equipment-brief-cost').inner_text())
            page.screenshot(path=str(OUT / 'binding-844x390.png'))
        discard_fixture(page)

    weapon = page.evaluate('''async()=>{const p=kirafanRL.world.player;
        const data=await fetch('/site/asset/rl/weapons-rl.json').then(r=>r.json());
        const row=data.catalog.find(r=>r.charaId<0&&r.class===p.card.class&&r.rare===4&&r.evolution===0);
        if(!row)throw Error('没有本职四星武器夹具');
        const item={slot:'weapon',rarity:'rare',catalogId:row.id,affixes:[]};
        const view=kirafanRL.world.previewEquipment(item);
        return {item,name:row.nameZh,icon:row.iconId,atk:Math.round((view.candidate.atk-view.current.atk)*10)/10};}''')
    offer_drop(page, weapon['item'])
    dialog.locator('.comparison-summary-icon').evaluate('img=>img.decode()')
    check('普通武器小卡显示原图、原名和净属性提升', weapon['name'] in dialog.locator('.comparison-summary-name').inner_text()
          and dialog.locator('.comparison-summary-icon').is_visible()
          and dialog.locator('.comparison-summary-icon').get_attribute('src').endswith('/%d.webp' % weapon['icon'])
          and ('物攻 +%g' % weapon['atk']) in dialog.locator('.equipment-brief').inner_text())
    for width, height in [(1280, 840), (640, 360)]:
        page.set_viewport_size({'width': width, 'height': height})
        layout = brief_layout(page)
        check(str(width) + '普通武器也无需读长表格即可确认', more.get_attribute('open') is None
              and layout['rowsVisible'] and layout['scrollHeight'] <= layout['height'] + 1
              and frame_fits(page, '#equipment-confirm'), layout)
        page.screenshot(path=str(OUT / ('weapon-' + str(width) + 'x' + str(height) + '.png')))
    discard_fixture(page)
    offer_drop(page, {'slot': 'armor', 'rarity': 'rare', 'affixes': ['invalid-test-affix']})
    check('损坏候选明确禁用确认，不给出虚假收益', page.locator('#equipment-confirm').is_disabled()
          and '数据不可用' in dialog.locator('.decision-status').inner_text()
          and dialog.locator('.equipment-brief').count() == 0
          and frame_fits(page, '#rl-equipment-choice'))
    discard_fixture(page)

    partial = {'slot': 'amulet', 'rarity': 'epic', 'affixes': ['12002011']}
    page.set_viewport_size({'width': 844, 'height': 390})
    offer_drop(page, partial)
    check('普通改技只列实际改变的按键，不罗列所有保留规则',
          '技能 3' in dialog.locator('.equipment-brief').inner_text()
          and 'R 必杀' not in dialog.inner_text() and '基础冷却' not in dialog.inner_text())
    page.screenshot(path=str(OUT / 'skill-change-844x390.png'))
    page.locator('#equipment-confirm').tap(); advance(page)
    enter(page, 'shop')
    page.evaluate('''()=>{const w=kirafanRL.world;w.coin=500;w.getShopOffer()[1]={
        item:{slot:'armor',rarity:'epic',affixes:['10022001']},price:120,bought:false};}''')
    page.keyboard.down('e'); advance(page); page.keyboard.up('e'); advance(page)
    page.wait_for_selector('#shop-panel[open]'); page.locator('#shop-items [data-index="1"]').tap()
    tap = page.evaluate('''()=>{const d=document.querySelector('#rl-equipment-choice'),
        b=document.querySelector('#shop-items [data-index="1"]'),r=d.getBoundingClientRect(),s=b.getBoundingClientRect();
        return {x:Math.ceil(r.left+8),y:Math.round(s.top+s.height/2),
            highlight:getComputedStyle(b).webkitTapHighlightColor,paper:getComputedStyle(d).backgroundColor};}''')
    picture = page.screenshot(path=str(OUT / 'shop-844x390.png'))
    tap['pixel'] = Image.open(io.BytesIO(picture)).convert('RGB').getpixel((tap['x'], tap['y']))
    check('触控打开购买页不把原生灰色高亮盖到新弹窗上',
          tap['highlight'] == 'rgba(0, 0, 0, 0)' and tap['pixel'] == ImageColor.getrgb(tap['paper']), tap)
    check('购买也默认简述，并显示真实价格和余额', more.get_attribute('open') is None
          and '120' in dialog.locator('.decision-status').inner_text()
          and '500' in dialog.locator('.decision-status').inner_text())
    check('被覆盖的改技不伪装成收益', '技能 2' in dialog.locator('.equipment-brief').inner_text()
          and '被覆盖' in dialog.locator('.equipment-brief').inner_text())
    page.locator('#equipment-confirm').tap(); advance(page)
    check('购买仍按原事务扣费一次并保留部分生效结果', page.evaluate('''()=>{const w=kirafanRL.world;
        return w.coin===380&&w.getShopOffer()[1].bought
            &&w.player.skills.slots[1].id===100220012&&w.player.skills.slots[2].id===120020113;}'''))
    page.locator('#shop-close').tap(); advance(page)
    downgrade = page.evaluate('''async()=>{const p=kirafanRL.world.player;
        const data=await fetch('/site/asset/rl/weapons-rl.json').then(r=>r.json());
        const rows=data.catalog.filter(r=>r.charaId<0&&r.class===p.card.class&&!(r.passiveId>0))
            .sort((a,b)=>a.max.atk-b.max.atk);
        if(rows.length<2||rows[0].max.atk===rows.at(-1).max.atk)throw Error('缺少高低属性武器夹具');
        return [rows.at(-1),rows[0]].map(r=>({slot:'weapon',rarity:'rare',catalogId:r.id,affixes:[]}));}''')
    offer_drop(page, downgrade[0]); page.locator('#equipment-confirm').tap(); advance(page)
    offer_drop(page, downgrade[1])
    check('只有属性下降时不误称属性没有变化',
          dialog.locator('.equipment-brief-benefit').inner_text() == '没有新增收益'
          and '物攻 −' in dialog.locator('.equipment-brief-cost').inner_text())
    page.screenshot(path=str(OUT / 'weaker-weapon-844x390.png'))
    discard_fixture(page)
    report['final'] = page.evaluate('({items:kirafanRL.world.player.equipment,coin:kirafanRL.world.coin})')


def main():
    global OUT
    if len(sys.argv) > 1:
        OUT = Path(sys.argv[1]).resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'before': fingerprints(),
              'fixtures': ['固定候选与第13层入口', '500金币商店货位', '无敌', '手动固定步长，非性能测量']}

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
            context.add_init_script('''window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
                if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',
                JSON.stringify({prologueSeen:true,tutorialSeen:true}));''')
            page = context.new_page(); page.on('pageerror', lambda error: report['errors'].append(str(error)))
            try:
                run(page, 'http://127.0.0.1:%d/site/game/roguelike.html' % server.server_address[1], check, report)
                check('浏览器没有未捕获异常', not report['errors'], report['errors'])
                check('验证期间产品源码保持一致', report['before'] == fingerprints())
            except BaseException:
                page.screenshot(path=str(OUT / 'failure.png'))
                raise
            finally:
                report['after'] = fingerprints()
                (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
                browser.close()
    finally:
        server.shutdown(); server.server_close(); worker.join(timeout=5)


if __name__ == '__main__':
    main()
