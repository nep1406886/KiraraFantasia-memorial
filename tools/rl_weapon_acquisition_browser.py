"""Five classes: real boss kill/loot -> comparison -> model -> saved continuation.

The seed, room routing, safe starting position, player invulnerability and killing
projectile are fixtures. No item, equipment array, loot RNG or model is assigned.
This checks identity/transactions, not natural difficulty or the drop distribution.
"""
import argparse
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import ready, advance, enter_guard, kill_guard, profile
from rl_recovery_browser import press
from rl_persistence_browser import inject_quota

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/weapon-acquisition'
FILES = ['site/game/rl/' + name for name in ['main.js', 'world.js', 'equipment.js', 'skills.js', 'loot.js',
    'weaponcatalog.js', 'weaponprofile.js', 'runschema.js', 'profileschema.js', 'view/actorview.js',
    'ui/decisions.js', 'ui/equipmentskills.js', 'ui/equipmentbrief.js', 'ui/theme.css']]
FILES += ['site/core/actor.js', 'site/core/loader.js', 'site/asset/rl/weapons-rl.json', 'site/asset/rl/cards-rl.json']


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def snapshot(page):
    return page.evaluate('''()=>{const k=kirafanRL,p=k.world.player,v=k.views.player,a=v.actor;
        return {card:p.card.id,classId:p.card.class,items:p.equipment,ids:a.weaponResourceIds,
            parts:a.weaponParts.length,attached:a.weaponParts.every(part=>!!part.parent),
            status:v.equipment.status,actorClass:a.classId,action:a.action,state:p.sm.state,
            style:p.weaponProfile.classId,skills:p.skills.slots.map(slot=>slot.id),normal:p.skills.normal.id,
            floor:k.world.floor,room:k.world.roomId};}''')


def settle_model(page):
    page.evaluate('async()=>{await kirafanRL.views.player.equipmentReady;}')
    advance(page)


def approach(page):
    page.evaluate('''()=>{const w=kirafanRL.world,d=w.drops.find(d=>d.items.some(item=>item.catalogId));
        if(!d)throw Error('真实掉落中没有原作武器');
        w.player.x=d.x-2;w.player.y=d.y;w.player.sm.force('idle');}''')
    page.keyboard.down('d'); advance(page, .8); page.keyboard.up('d')
    page.wait_for_selector('#rl-equipment-choice[open]', timeout=10000)


def resume(page):
    page.reload(wait_until='load')
    page.locator('#roster-continue').click(timeout=60000)
    ready(page); enter_guard(page); settle_model(page)


def run_case(browser, base, card, report, check):
    cls, card_id = card['class'], card['id']
    prefix = str(card_id) + ' '
    context = browser.new_context(viewport={'width': 1280, 'height': 840}, has_touch=True)
    context.add_init_script('''window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
        if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',
            JSON.stringify({prologueSeen:true,tutorialSeen:true}));''')
    page = context.new_page(); page.on('pageerror', lambda error: report['errors'].append(str(error)))
    try:
        page.goto(base + '?volume=1&floor=5&seed=28101', wait_until='load', timeout=60000)
        hero = page.locator('.roster-card').filter(has=page.locator('img[src$="/%d.webp"]' % card_id))
        hero.click(timeout=60000); ready(page); settle_model(page)
        initial = snapshot(page); default_ids = [1000 + 100 * cls]
        check(prefix + '正常选角空装备只挂载职业默认武器，不持有专武', initial['items'] == []
              and initial['ids'] == default_ids and initial['status'] == 'ready'
              and initial['parts'] > 0 and initial['attached'], initial)
        page.screenshot(path=str(OUT / ('class-%d-default.png' % cls)))
        enter_guard(page)
        page.evaluate('''()=>{const w=kirafanRL.world;w.player.x=3;w.player.y=3;
            window.acquisitionEvents=[];const drain=w.drainEvents.bind(w);
            w.drainEvents=()=>{const events=drain();for(const e of events)if(['hit','drop','pickup','floorClear'].includes(e.type))
                acquisitionEvents.push({type:e.type,died:e.died,damage:e.damage,target:e.target?.id,
                    items:e.items?structuredClone(e.items):undefined});return events;};}''')
        enemies = page.evaluate('kirafanRL.world.enemies.length')
        check(prefix + '击杀夹具面对实际生成的首领', enemies > 0)
        kill_guard(page)
        trace = page.evaluate('acquisitionEvents')
        check(prefix + '真实弹体命中死亡后才触发掉落，未自动装备或下层',
              len([e for e in trace if e['type'] == 'hit' and e.get('died')]) == enemies
              and any(e['type'] == 'drop' for e in trace)
              and snapshot(page)['items'] == [] and snapshot(page)['ids'] == default_ids
              and snapshot(page)['floor'] == 5, trace)
        generated = page.evaluate('''async()=>{const w=kirafanRL.world;
            const drop=w.drops.find(d=>d.items.some(item=>item.catalogId));
            if(!drop)throw Error('当前种子的真实首领掉落不是武器：'+JSON.stringify(w.drops));
            const item=drop.items.find(item=>item.catalogId),{weaponDefinition}=await import('/site/game/rl/weaponcatalog.js');
            const row=weaponDefinition(item),preview=w.previewEquipment(item);
            return {item,row,preview:{skills:preview.skills.candidate.slots.map(slot=>slot.id),
                normal:preview.skills.candidate.normal.id},ids:[...new Set([row.resourceIdL,row.resourceIdR].filter(id=>id>0))]};
        }''')
        check(prefix + '掉落身份来自原作目录而非预置候选', generated['item']['slot'] == 'weapon'
              and generated['item']['catalogId'] == generated['row']['id'] and bool(generated['ids']), generated)
        approach(page)
        dialog = page.locator('#rl-equipment-choice')
        image = dialog.locator('.comparison-summary-icon')
        image.evaluate('img=>img.decode()')
        check(prefix + '真实拾取比较使用该武器原图，确认前模型不变',
              image.get_attribute('src').endswith('/weapon/%d.webp' % generated['row']['iconId'])
              and image.is_visible() and image.evaluate('img=>img.naturalWidth>0')
              and snapshot(page)['items'] == [] and snapshot(page)['ids'] == default_ids)
        page.locator('#equipment-keep').click()
        check(prefix + '取消比较保留默认持械及未拾取战利品', snapshot(page)['items'] == []
              and snapshot(page)['ids'] == default_ids and page.evaluate('kirafanRL.world.drops.length>0'))
        resume(page)
        check(prefix + '取消后续档仍为默认武器，首领不复活、战利品仍可拿', snapshot(page)['items'] == []
              and snapshot(page)['ids'] == default_ids
              and page.evaluate('kirafanRL.world.enemies.length===0&&kirafanRL.world.drops.length>0'))
        approach(page)
        if cls == 2:
            before, durable = snapshot(page), page.evaluate("localStorage.getItem('kirafan-rl:profile')")
            inject_quota(page); page.locator('#equipment-confirm').click()
            check(prefix + '保存失败不预先换模型、不删真实武器，原字节保留', snapshot(page) == before
                  and page.evaluate("localStorage.getItem('kirafan-rl:profile')") == durable
                  and page.locator('#rl-equipment-choice').is_visible()
                  and page.evaluate('kirafanRL.world.drops.length>0'))
            page.evaluate('window.blockWrites=false')
            page.set_viewport_size({'width': 844, 'height': 390})
            page.locator('#equipment-confirm').tap()
        else:
            page.locator('#equipment-confirm').click()
        advance(page); settle_model(page)
        equipped = snapshot(page)
        check(prefix + '确认后真实目录模型/普攻职业/技能与比较一致', equipped['items'] == [generated['item']]
              and equipped['ids'] == generated['ids'] and equipped['style'] == generated['row']['class']
              and equipped['status'] == 'ready' and equipped['parts'] > 0 and equipped['attached']
              and equipped['actorClass'] == cls and equipped['skills'] == generated['preview']['skills']
              and equipped['normal'] == generated['preview']['normal'], equipped)
        check(prefix + '装备已持久化且仍在原首领房，不重复领取', profile(page)['run']['equipment'] == equipped['items']
              and equipped['floor'] == 5 and page.evaluate('kirafanRL.world.drops.length===0'))
        press(page, 'KeyJ')
        attack = snapshot(page)
        expected_action = 'attack' if generated['row']['class'] == cls else 'ext_%d_attack' % generated['row']['class']
        check(prefix + '真实普攻输入使用当前武器动作，角色职业不被替换', attack['state'] == 'attack'
              and attack['action'] == expected_action and attack['actorClass'] == cls, attack)
        advance(page, .7)
        page.screenshot(path=str(OUT / ('class-%d-equipped.png' % cls)))
        resume(page); restored = snapshot(page)
        check(prefix + '拾取后刷新恢复同一持械和技能，不重刷首领或掉落', restored['items'] == equipped['items']
              and restored['ids'] == equipped['ids'] and restored['skills'] == equipped['skills']
              and restored['status'] == 'ready' and restored['parts'] > 0
              and page.evaluate('kirafanRL.world.enemies.length===0&&kirafanRL.world.drops.length===0'), restored)
        report['cases'].append({'card': card, 'initial': initial, 'generated': generated,
                                'trace': trace, 'equipped': equipped, 'attack': attack, 'restored': restored})
    except BaseException:
        page.screenshot(path=str(OUT / ('class-%d-failure.png' % cls)))
        raise
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--class-id', type=int, choices=range(5))
    args = parser.parse_args(); OUT.mkdir(parents=True, exist_ok=True)
    truth = {row['id']: row for row in json.loads((ROOT / 'site/asset/rl/cards-rl.json').read_text(encoding='utf8'))['cards']}
    roster = json.loads((ROOT / 'site/asset/rl/playable-roster.json').read_text(encoding='utf8'))['cards']
    cases = [next(row for row in roster if row['class'] == cls and truth[row['id']].get('dedicatedWeapon'))
             for cls in range(5) if args.class_id is None or cls == args.class_id]
    report = {'checks': [], 'cases': [], 'errors': [], 'before': fingerprints(), 'complete': False,
              'fixtures': ['种子28101/第5层', '首领房路由和远处站位', '玩家无敌', '击杀弹体，未替换掉落RNG或物品']}
    def check(label, condition, detail=None):
        report['checks'].append({'label': label, 'ok': bool(condition), 'detail': detail})
        print(('PASS ' if condition else 'FAIL ') + label, flush=True)
        if not condition: raise AssertionError(label + ': ' + str(detail))
    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            report['browser'] = browser.version
            base = 'http://127.0.0.1:%d/site/game/roguelike.html' % server.server_address[1]
            for card in cases: run_case(browser, base, card, report, check)
            check('五职武器链路无页面脚本异常', not report['errors'], report['errors'])
            check('验证期间产品代码与原作数据均未变化', report['before'] == fingerprints())
            report['complete'] = True; browser.close()
    except BaseException as error:
        report['failure'] = str(error); raise
    finally:
        report['after'] = fingerprints()
        name = 'report.json' if args.class_id is None else 'class-%d.json' % args.class_id
        (OUT / name).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
        server.shutdown(); server.server_close(); worker.join(timeout=5)


if __name__ == '__main__': main()
