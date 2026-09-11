"""Real input/confirmation for equipment skill rules; not a loot-rate/balance test.

Named ground candidates, one controlled shop entry, room routing and starting coin
are fixtures. Equipment is applied only by the real pickup/purchase transaction.
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
from rl_gadget_contract_browser import offer_drop, enter
from rl_persistence_browser import inject_quota
from rl_decisions_browser import frame_fits, expand_comparison
from rl_feedback_experience_browser import readability

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/equipment-skills'
FILES = ['site/game/rl/' + name for name in ['equipment.js', 'skills.js', 'world.js', 'main.js',
    'weaponcatalog.js', 'gadgets.js', 'runschema.js', 'profileschema.js']]
FILES += ['site/game/rl/ui/' + name for name in ['equipmentskills.js', 'equipmentbrief.js', 'decisions.js', 'hud.js',
    'skilltooltip.js', 'theme.css', 'infocard.js']]
FILES += ['site/asset/rl/' + name for name in ['weapons-rl.json', 'skills-rl.json', 'cards-rl.json']]


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def state(page):
    return page.evaluate("""()=>{const w=kirafanRL.world,p=w.player,s=p.skills;
        return {items:p.equipment,ids:s.slots.map(x=>x.id),normal:s.normal.id,
            sources:s.slots.map((_,i)=>s.sourceFor(i)),gauge:s.gauge,coin:w.coin,
            cooldown:s.slots.map(x=>x.remaining)};}""")


def tap(page, locator):
    locator.scroll_into_view_if_needed()
    box = locator.bounding_box()
    if not box:
        raise AssertionError('触控目标没有可见边界')
    page.touchscreen.tap(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    advance(page)


def reopen_drop(page):
    page.evaluate("""()=>{const w=kirafanRL.world;w.player.x=contractDrop.x-2.4;
        w.player.y=contractDrop.y;contractDrop.offered=false;}""")
    page.keyboard.down('d'); advance(page, .75); page.keyboard.up('d')
    page.wait_for_selector('#rl-equipment-choice[open]')


def summary_layout(page):
    return page.locator('#rl-equipment-choice').evaluate('''dialog=>{
        const summary=dialog.querySelector(':scope > .comparison-summary'),scroll=dialog.querySelector('.comparison-scroll');
        if(!summary)return {exists:false};
        const before=summary.getBoundingClientRect(),old=scroll.scrollTop;
        scroll.scrollTop=scroll.scrollHeight;
        const after=summary.getBoundingClientRect(),name=summary.querySelector('.comparison-summary-name');
        const visible=after.top>=0&&after.left>=0&&after.right<=innerWidth&&after.bottom<=innerHeight;
        const result={exists:true,visible,fixed:Math.abs(before.top-after.top)<.5,
            content:scroll.clientHeight,scrolled:scroll.scrollTop>0,
            noOverflow:summary.scrollWidth<=summary.clientWidth+1&&name.scrollHeight<=name.clientHeight+1};
        scroll.scrollTop=old;return result;
    }''')


def menu_equipment(page):
    press(page, 'Escape')
    page.locator('#menu-equipment').click()
    page.wait_for_selector('#rl-equipment-collection[open]')


def run(page, base, check, report):
    page.goto(base + '?volume=1&floor=13&seed=176', wait_until='load', timeout=60000)
    page.wait_for_selector('.roster-card', timeout=60000)
    page.locator('.roster-card').filter(has=page.locator('img[src$="/22002001.webp"]')).click()
    ready(page)
    original = state(page)
    check('正常选角无装备，技能采用角色原招', original['items'] == [] and all(x is None for x in original['sources']))

    partial = {'slot': 'amulet', 'rarity': 'epic', 'affixes': ['12002011']}
    offer_drop(page, partial)
    dialog = page.locator('#rl-equipment-choice')
    check('默认简述只列实际改动，完整对照需要展开',
          dialog.locator('.equipment-more').get_attribute('open') is None
          and '技能 3' in dialog.locator('.equipment-brief').inner_text()
          and not dialog.locator('.equipment-skill-comparison').is_visible())
    expand_comparison(page)
    skill3 = dialog.locator('.equipment-skill-change[data-skill-slot="2"]')
    check('拾取前明确显示技能3前后名称、效果和基础冷却', skill3.count() == 1
          and skill3.locator('[data-skill-id="120020113"]').count() == 1
          and '基础冷却' in skill3.inner_text() and '自身' in skill3.inner_text()
          and '护符 · 附加词条 1' in skill3.inner_text())
    check('空位不移位，技能2与R在比较中明确保留', dialog.locator('.equipment-skill-change[data-skill-slot="1"]').count() == 0
          and '技能 2' in dialog.locator('.equipment-skill-unchanged').inner_text()
          and 'R 必杀' in dialog.locator('.equipment-skill-unchanged').inner_text())
    check('桌面比较与固定确认按钮完整可见', frame_fits(page, '#rl-equipment-choice')
          and frame_fits(page, '#equipment-confirm'))
    summary = dialog.locator(':scope > .comparison-summary')
    check('候选概要先说明装备名称、槽位和当前装备', summary.count() == 1
          and summary.locator('.comparison-summary-name').inner_text() == '史诗 · 护符'
          and '护符槽' in summary.inner_text() and '当前未装备' in summary.inner_text())
    layout = summary_layout(page)
    check('滚动长技能对照时装备身份保持可见', all(layout.get(key) for key in ['exists','visible','fixed','scrolled','noOverflow'])
          and layout['content'] >= 100, layout)
    contrasts = readability(page, '#rl-equipment-choice .equipment-skill-source, #rl-equipment-choice .skill-cooldown, #rl-equipment-choice .comparison-summary-name, #rl-equipment-choice .comparison-summary-meta')
    check('技能来源和基础冷却文字对比度至少4.5', contrasts and all(row['ratio'] >= 4.5 for row in contrasts), contrasts)
    page.screenshot(path=str(OUT / 'partial-override-desktop.png'))
    before = state(page)
    check('查看对照未提前装配候选', before['ids'] == original['ids'] and before['items'] == [])
    page.locator('#equipment-keep').click()
    check('取消不改变装备、技能、冷却和量能', state(page) == before)
    reopen_drop(page)
    expand_comparison(page)
    durable = page.evaluate("localStorage.getItem('kirafan-rl:profile')")
    before = state(page)
    inject_quota(page); page.locator('#equipment-confirm').click()
    check('真实存储失败保留原技能、候选和可重试比较页', state(page) == before
          and page.evaluate("localStorage.getItem('kirafan-rl:profile')") == durable
          and '未提交' in dialog.locator('.decision-status').inner_text()
          and page.evaluate('contractDrop.items.length') == 1)
    page.set_viewport_size({'width': 568, 'height': 320})
    layout = summary_layout(page)
    check('320高保存失败仍可读错误、完整候选和至少100像素说明区',
          all(layout.get(key) for key in ['exists','visible','fixed','scrolled','noOverflow'])
          and layout['content'] >= 100 and frame_fits(page, '#equipment-confirm')
          and frame_fits(page, '#rl-equipment-choice > .decision-status'), layout)
    page.screenshot(path=str(OUT / 'save-failure-568x320.png'))
    page.set_viewport_size({'width': 1280, 'height': 840})
    page.evaluate('window.blockWrites=false'); page.locator('#equipment-confirm').click(); advance(page)
    equipped = state(page)
    check('确认后只替换正确槽位，来源与预览一致', equipped['ids'][1] == original['ids'][1]
          and equipped['ids'][2] == 120020113 and equipped['sources'][2]['slot'] == 'amulet'
          and equipped['ids'][0] == original['ids'][0])
    check('技能栏只为被改写的技能显示改字和可读来源', page.locator('.hud-skill[data-slot="2"]').get_attribute('data-overridden') == 'true'
          and page.locator('.hud-skill[data-slot="1"]').get_attribute('data-overridden') == 'false'
          and page.locator('.hud-skill[data-slot="2"] .hud-skill-origin').is_visible()
          and '护符' in page.locator('.hud-skill[data-slot="2"]').get_attribute('aria-label'))
    page.locator('.hud-skill[data-slot="2"]').hover()
    page.wait_for_selector('.hud-skill-tooltip:not([hidden])')
    check('悬停提示解释当前改技来源', '护符 · 附加词条 1' in page.locator('.skill-tooltip-source').inner_text())
    page.screenshot(path=str(OUT / 'skill-source-hud.png'))
    page.mouse.move(600, 250)
    page.wait_for_selector('.hud-skill-tooltip', state='hidden')
    page.locator('.hud-skill[data-slot="1"]').focus(); page.keyboard.press('Tab')
    check('键盘焦点也能读取改技来源', page.locator('.hud-skill[data-slot="2"]').evaluate('el=>el===document.activeElement')
          and page.locator('.skill-tooltip-source').is_visible()
          and '护符' in page.locator('.skill-tooltip-source').inner_text())
    page.keyboard.press('Escape'); advance(page)

    menu_equipment(page)
    current = page.locator('#rl-equipment-collection')
    check('当前装备页展示真实技能、来源和可展开的角色原招', current.locator('.equipment-skill-overview [data-skill-slot="2"]').get_attribute('data-skill-id') == '120020113'
          and current.locator('.equipment-original-skill').count() >= 1
          and '护符 · 附加词条 1' in current.locator('.equipment-skill-overview').inner_text())
    current.locator('.equipment-skill-rules > summary').first.click()
    check('规则展示固定优先级、空位和剩余冷却继承', '武器 > 护符 > 护甲 > 饰品' in current.inner_text()
          and '剩余冷却' in current.inner_text() and '不挪用' in current.inner_text())
    page.locator('#equipment-tab-content').evaluate('el=>el.scrollTop=0')
    page.screenshot(path=str(OUT / 'current-loadout-desktop.png'))
    page.locator('#equipment-tab-catalog').click()
    page.locator('input[aria-label="武器名称"]').fill('平泽')
    entry = page.locator('.weapon-entry').first
    entry.locator(':scope > summary').click()
    entry.locator('select').select_option('2200203')
    check('图鉴进化阶段展示原生具体改技和当前角色对照', entry.locator('.equipment-modifier[data-target="1"]').count() >= 1
          and '原生被动' in entry.inner_text()
          and entry.locator('.equipment-skill-change[data-skill-slot="1"] [data-skill-id="220020012"]').count() == 1)
    check('查看图鉴不装配武器', state(page)['items'] == equipped['items'])
    page.screenshot(path=str(OUT / 'catalog-stage.png'))
    current.get_by_role('button', name='返回', exact=True).click()
    page.locator('#menu-resume').click(); advance(page)

    enter(page, 'shop')
    page.evaluate("""()=>{const w=kirafanRL.world;w.coin=500;
        w.getShopOffer()[1]={item:{slot:'armor',rarity:'epic',affixes:['10022001']},price:120,bought:false};}""")
    press(page, 'KeyE'); page.wait_for_selector('#shop-panel[open]')
    page.locator('#shop-items [data-index="1"]').click()
    dialog = page.locator('#rl-equipment-choice')
    expand_comparison(page)
    candidate = dialog.locator('.comparison-columns > section').nth(1)
    check('购买前逐槽说明部分生效：护甲技能3被护符覆盖', candidate.locator('.equipment-modifier[data-target="2"][data-active="false"]').count() == 1
          and '被「护符 · 附加词条 1」覆盖' in candidate.inner_text()
          and dialog.locator('.equipment-skill-change[data-skill-slot="1"] [data-skill-id="100220012"]').count() == 1)
    page.screenshot(path=str(OUT / 'shop-partial-conflict.png'))
    for width, height in [(667, 375), (568, 320)]:
        page.set_viewport_size({'width': width, 'height': height})
        layout = summary_layout(page)
        check(str(width) + 'x' + str(height) + '购买页保留价格、完整候选和至少100像素说明区',
              all(layout.get(key) for key in ['exists','visible','fixed','scrolled','noOverflow'])
              and layout['content'] >= 100 and frame_fits(page, '#rl-equipment-choice')
              and frame_fits(page, '#equipment-confirm')
              and '120' in dialog.locator('.decision-status').inner_text(), layout)
        page.screenshot(path=str(OUT / ('shop-compact-' + str(width) + 'x' + str(height) + '.png')))
    page.set_viewport_size({'width': 1280, 'height': 840})
    before = state(page); page.locator('#equipment-keep').click()
    check('取消购买不扣钱或改变技能', state(page) == before)
    page.locator('#shop-items [data-index="1"]').click(); page.locator('#equipment-confirm').click(); advance(page)
    check('实际购买与逐槽预览相同，只扣费一次', state(page)['ids'][1:] == [100220012, 120020113]
          and state(page)['coin'] == 380 and page.evaluate('kirafanRL.world.getShopOffer()[1].bought'))
    press(page, 'Escape'); page.wait_for_selector('#shop-panel', state='hidden')
    check('Esc只退出商店，不误开暂停菜单或保留菜单按键', not page.locator('#menu-panel').is_visible()
          and page.evaluate('!kirafanRL.world.frozen && !kirafanRL.input.state.menu'))

    press(page, 'Digit3'); advance(page, .15)
    check('换装前通过真实按键施放旧技能进入冷却', state(page)['cooldown'][2] > 0)
    native = {'slot': 'weapon', 'rarity': 'legendary', 'catalogId': 2200203, 'affixes': ['10022001']}
    offer_drop(page, native)
    dialog = page.locator('#rl-equipment-choice')
    expand_comparison(page)
    candidate = dialog.locator('.comparison-columns > section').nth(1)
    check('武器原生改技优先于同件附加和其他装备，并逐项注明覆盖', candidate.locator('.equipment-modifier[data-target="1"][data-active="true"]').count() == 1
          and '被「武器 · 原生被动」覆盖' in candidate.inner_text()
          and dialog.locator('.equipment-skill-change[data-skill-slot="2"] [data-skill-id="220020013"]').count() == 1)
    check('熟练度说明只指向数值加成，不误称被覆盖词条也完整生效', '正向数值词条按 100%' in dialog.locator('.equipment-style').inner_text()
          and '词条完整生效' not in dialog.inner_text())
    before = state(page); page.locator('#equipment-confirm').click()
    after = state(page)
    check('实际原生换装与预览一致且不刷新按键冷却或量能', after['ids'][1:] == [220020012, 220020013]
          and after['cooldown'] == before['cooldown'] and after['gauge'] == before['gauge']
          and all(source['slot'] == 'weapon' and source['native'] for source in after['sources'][1:]))
    advance(page)

    page.set_viewport_size({'width': 844, 'height': 390})
    page.touchscreen.tap(420, 100); advance(page)
    tap(page, page.locator('.hud-pause')); tap(page, page.locator('#menu-equipment'))
    check('横屏触控装备页和返回操作完整可见', frame_fits(page, '#rl-equipment-collection')
          and page.locator('#rl-equipment-collection').get_by_role('button', name='返回', exact=True).is_visible()
          and page.evaluate('document.body.classList.contains("touch-on")'))
    metrics = page.locator('#rl-equipment-collection').evaluate("""el=>({
        button:el.querySelector(':scope > button').getBoundingClientRect().height,
        content:el.querySelector('#equipment-tab-content').clientHeight})""")
    check('触控返回按钮不过度占高，技能阅读区至少100像素', 44 <= metrics['button'] <= 60 and metrics['content'] >= 100, metrics)
    page.wait_for_timeout(180)
    page.screenshot(path=str(OUT / 'touch-loadout.png'))
    page.locator('#equipment-tab-content').evaluate('el=>el.scrollTop=el.scrollHeight')
    check('长装备说明可滚动且不产生横向溢出', page.locator('#equipment-tab-content').evaluate('el=>el.scrollTop>0&&el.scrollWidth<=el.clientWidth+1'))
    tap(page, page.locator('#rl-equipment-collection').get_by_role('button', name='返回', exact=True))
    tap(page, page.locator('#menu-resume'))
    binding = {'slot': 'armor', 'rarity': 'epic', 'gadgetId': 'binding', 'sealedSlot': 2, 'affixes': []}
    offer_drop(page, binding)
    page.touchscreen.tap(420, 24); advance(page)
    expand_comparison(page, touch=True)
    check('触控比较区分技能封印和技能替换，原生来源保持可读', frame_fits(page, '#rl-equipment-choice')
          and frame_fits(page, '#equipment-confirm')
          and page.locator('.equipment-skill-change[data-skill-slot="2"][data-change="seal"]').count() == 1
          and '武器 · 原生被动' in page.locator('.equipment-skill-change[data-skill-slot="2"]').inner_text())
    layout = summary_layout(page)
    check('横屏触控保留完整候选名称且不挤占技能阅读区', all(layout.get(key) for key in ['exists','visible','fixed','scrolled','noOverflow'])
          and layout['content'] >= 100
          and '缚技罗盘' in page.locator('.comparison-summary-name').inner_text(), layout)
    page.wait_for_timeout(180)
    page.screenshot(path=str(OUT / 'touch-seal-comparison.png'))
    page.set_viewport_size({'width': 568, 'height': 320})
    layout = summary_layout(page)
    check('320高触控比较保留完整名称、100像素说明区和44像素确认目标',
          all(layout.get(key) for key in ['exists','visible','fixed','scrolled','noOverflow'])
          and layout['content'] >= 100 and frame_fits(page, '#equipment-confirm')
          and page.locator('#equipment-confirm').bounding_box()['height'] >= 44, layout)
    page.screenshot(path=str(OUT / 'touch-seal-568x320.png'))
    tap(page, page.locator('#equipment-confirm'))
    check('触控确认后封印不改技能身份或生效来源', page.evaluate('kirafanRL.world.player.skills.isSealed(2)')
          and state(page)['ids'][2] == 220020013 and state(page)['sources'][2]['native'])
    page.reload(wait_until='load'); page.locator('#roster-continue').click(timeout=60000); ready(page)
    check('刷新续档重新解析同一来源与封印，不依赖UI临时状态', state(page)['ids'][1:] == [220020012, 220020013]
          and all(source['native'] for source in state(page)['sources'][1:])
          and page.evaluate('kirafanRL.world.player.skills.isSealed(2)'))
    report['final'] = state(page)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'before': fingerprints(), 'fixtures': [
        '第13层/房间路由', '无敌', '原作词条指定的地面候选', '一个120金币护甲货位与500起始金币']}

    def check(label, condition, detail=None):
        report['checks'].append({'label': label, 'ok': bool(condition), 'detail': detail})
        print(('PASS ' if condition else 'FAIL ') + label, flush=True)
        if not condition:
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
            page = context.new_page(); page.on('pageerror', lambda error: report['errors'].append(str(error)))
            try:
                run(page, 'http://127.0.0.1:%d/site/game/roguelike.html' % server.server_address[1], check, report)
                check('浏览器无未捕获错误', not report['errors'], report['errors'])
                check('验证期间产品文件未变化', report['before'] == fingerprints())
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
