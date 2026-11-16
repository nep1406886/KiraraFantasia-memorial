"""Real-page checks for run evolution, recovery and responsive touch controls.

Uses isolated browser storage. Eligibility fixtures only skip elapsed time and
room clears; all model, payment, persistence and interaction paths remain real.
Run: python tools/adventure_evolution_browser.py
"""
import functools, json, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, str(ROOT / 'tools'))
from serve import Server, NoCacheHandler
OUT = ROOT / '.codex-tmp/run-growth'
OUT.mkdir(exist_ok=True)
SIZES = [(1440,900),(390,844),(320,568),(844,390),(568,320)]

def shot(page, name):
    page.screenshot(path=str(OUT / (name+'.png')))

def ready_rl(page):
    page.wait_for_function('() => window.kirafanRL?.views.player && !window.kirafanRL.roomLoading', timeout=90000)
    for _ in range(60):
        skip = page.locator('#dialogue-skip')
        if skip.is_visible(): skip.click()
        tutorial = page.locator('[data-action="tutorial-skip"]')
        if tutorial.is_visible(): tutorial.click()
        if page.evaluate('() => !kirafanRL.world.frozen'): return
        page.wait_for_timeout(200)
    shot(page, 'rl-frozen')
    raise AssertionError('RL stayed frozen: '+page.locator('body').inner_text()[-2000:])

def main():
    report = {'errors': [], 'checks': []}
    server = Server(('127.0.0.1',0), functools.partial(NoCacheHandler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    def check(name, value):
        assert value, name
        report['checks'].append(name); print('PASS '+name,flush=True)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel='msedge',headless=True,args=['--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width':1440,'height':900})
            page = context.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.goto(base+'/site/etowaria-defense/index.html?review=1',wait_until='load')
            page.wait_for_function('() => window.__defense?.snapshot().ready',timeout=60000)
            page.locator('#open-roster').click()
            check('默认显示五星与特别换装157张',page.locator('.companion-card:not([hidden])').count()==157)
            page.locator('.companion-remove').first.click()
            check('单击移除伙伴',page.evaluate('() => __defense.snapshot().party.length')==5)
            page.locator('.companion-add[aria-pressed="false"]').first.click()
            check('单击加入伙伴',page.evaluate('() => __defense.snapshot().party.length')==6)
            replacement = page.locator('.companion-add[aria-pressed="false"]').first.get_attribute('data-add')
            page.locator(f'[data-add="{replacement}"]').click()
            check('满员后明确选择替换对象',page.locator('#party-cancel').is_visible())
            page.locator('.companion-slot-preview').nth(2).click()
            check('替换指定槽位',page.evaluate('() => __defense.snapshot().party[2]')==replacement)
            page.locator('#companion-search').fill('不存在的伙伴')
            check('空搜索反馈',page.locator('#companion-empty').is_visible())
            page.locator('#companion-search').fill('')
            for width,height in SIZES:
                page.set_viewport_size({'width':width,'height':height}); page.wait_for_timeout(160)
                shot(page,f'companions-{width}x{height}')
                check(f'伙伴页无水平溢出 {width}x{height}', page.evaluate('() => document.documentElement.scrollWidth<=innerWidth'))
                check(f'出发按钮可见 {width}x{height}',page.locator('#roster-enter').is_visible())
            page.set_viewport_size({'width':1440,'height':900})
            for _ in range(6): page.locator('.companion-remove').first.click()
            check('空队伍禁用出发',page.locator('#roster-enter').is_disabled())
            page.locator('#restore-party').click(); page.locator('#roster-back').click()
            page.locator('#start-campaign').click(); page.locator('[data-action="prepare"]').click()
            page.locator('[data-action="deck-start"]').click()
            page.wait_for_function('() => __defense.campaign?.view?.ready || document.querySelector("#campaign-screen dialog[open] [data-role=error-text]")',timeout=90000)
            check('巡守载入完成',page.evaluate('() => !!__defense.campaign?.view?.ready'))
            if page.locator('[data-action="brief-close"]').is_visible(): page.locator('[data-action="brief-close"]').click()
            # Fixture only accelerates eligibility; actual view, button, model, payment and effects paths run unchanged.
            result = page.evaluate('''async () => { const v=__defense.campaign.view; v.battle.resource=999;
                await v.select('U01'); const result=await v.deployCell(0,1);
                v.battle.phase='running';v.battle.time=21;v.battle.enemies.clear();v.notify();return result; }''')
            check('巡守真实模型部署',result.get('ok'))
            page.locator('[data-action="evolution"]').click()
            for width,height in SIZES:
                page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(120)
                shot(page,f'td-evolution-{width}x{height}')
            page.set_viewport_size({'width':1440,'height':900})
            before = page.evaluate('() => {const v=__defense.campaign.view;return {coin:v.battle.resource,rid:[...v.models.values()][0].actor.resourceId,cost:v.battle.evolutionQuote("U01").cost};}')
            evolved_id=page.evaluate('() => __defense.campaign.view.unitData("U01").forms.evolved.resourceId')
            blocked=f'**/model_pl_{evolved_id}/model.glb.gz*'
            page.route(blocked,lambda route:route.abort())
            page.locator('[data-action="evolve-run"]').click()
            page.wait_for_function('() => document.querySelector(".run-evolution-status").textContent.includes("操作未完成")')
            check('巡守模型失败不扣费、不替换旧模型',page.evaluate('(b) => {const v=__defense.campaign.view;return v.battle.resource===b.coin && !v.battle.evolved.has("U01") && [...v.models.values()][0].actor.resourceId===b.rid;}',before))
            page.unroute(blocked)
            page.locator('[data-action="evolve-run"]').click()
            page.wait_for_function('() => !document.querySelector(".run-evolution[open]")',timeout=90000)
            after = page.evaluate('() => {const v=__defense.campaign.view;return {coin:v.battle.resource,rid:[...v.models.values()][0].actor.resourceId,evolved:v.battle.evolved.has("U01"),paused:v.battle.pauses.size};}')
            check('巡守进化扣费与模型现场切换',after['coin']==before['coin']-before['cost'] and after['rid']!=before['rid'] and after['evolved'])
            check('巡守进化后解除暂停',after['paused']==0)
            page.evaluate('() => __defenseReview.campaignStep(.3)');shot(page,'td-evolved')
            page.close()

            page = context.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
            page.goto(base+'/site/game/roguelike.html?seed=42',wait_until='load')
            page.wait_for_selector('#roster-start',timeout=60000);page.locator('#roster-start').click();ready_rl(page)
            before = page.evaluate('() => {const r=kirafanRL;return {rid:r.views.player.actor.resourceId,evolved:r.world.player.evolved};}')
            check('冒险新局使用基础形态',not before['evolved'])
            page.evaluate('''() => {const w=kirafanRL.world;w.floor=2;w.coin=100;w.player.hp=Math.floor(w.player.maxHp*.6);
                for(const e of w.enemies)e.dead=true;}''')
            page.locator('.hud-evolution').click();page.wait_for_selector('.run-evolution[open]')
            for width,height in SIZES:
                page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(120)
                shot(page,f'rl-evolution-{width}x{height}')
            page.set_viewport_size({'width':1440,'height':900})
            evolved_id=page.evaluate('() => {const id=kirafanRL.world.player.card.id;return kirafanGachaData.cards.find(c=>c.id===id || c.evolvedId===id).evolvedResourceId;}')
            blocked=f'**/model_pl_{evolved_id}/model.glb.gz*'
            page.route(blocked,lambda route:route.abort())
            page.locator('[data-action="evolve-run"]').click()
            page.wait_for_function('() => document.querySelector(".run-evolution-status").textContent.includes("操作未完成")')
            check('冒险模型失败不扣费、不替换旧模型',page.evaluate('(b) => kirafanRL.world.coin===100 && !kirafanRL.world.player.evolved && kirafanRL.views.player.actor.resourceId===b.rid',before))
            page.unroute(blocked)
            page.evaluate('() => {window.restoreStorageWrite=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException("test quota","QuotaExceededError");};}')
            page.locator('[data-action="evolve-run"]').click()
            page.wait_for_function('() => document.querySelector(".run-evolution-status").textContent.includes("保存失败")')
            check('冒险存储失败不扣费、不提升能力',page.evaluate('(b) => kirafanRL.world.coin===100 && !kirafanRL.world.player.evolved && kirafanRL.views.player.actor.resourceId===b.rid',before))
            page.evaluate('() => {Storage.prototype.setItem=window.restoreStorageWrite;delete window.restoreStorageWrite;}')
            page.locator('[data-action="evolve-run"]').click()
            page.wait_for_function('() => !document.querySelector(".run-evolution[open]")',timeout=90000)
            after = page.evaluate('() => {const r=kirafanRL,p=r.world.player;return {rid:r.views.player.actor.resourceId,evolved:p.evolved,coin:r.world.coin,ratio:p.hp/p.maxHp,paused:r.world.frozen,equipment:r.views.player.equipment};}')
            check('冒险进化扣费与模型现场切换',after['coin']==40 and after['rid']!=before['rid'] and after['evolved'])
            check('冒险装备与生命比例保留',after['equipment']['status']=='ready' and .58<after['ratio']<=.6)
            check('冒险进化后恢复操作',not after['paused'])
            page.wait_for_timeout(350);shot(page,'rl-evolved')
            page.reload(wait_until='load');page.wait_for_selector('#roster-continue',timeout=60000)
            page.locator('#roster-continue').click();ready_rl(page)
            check('冒险续档保留进化模型与金币',page.evaluate('(rid) => kirafanRL.world.player.evolved && kirafanRL.views.player.actor.resourceId===rid && kirafanRL.world.coin===40',after['rid']))
            touch_context=browser.new_context(storage_state=context.storage_state(),viewport={'width':390,'height':844},has_touch=True,is_mobile=True)
            phone=touch_context.new_page();phone.on('pageerror',lambda e:report['errors'].append(str(e)))
            phone.goto(base+'/site/game/roguelike.html?seed=42',wait_until='load');phone.locator('#roster-continue').click();ready_rl(phone)
            page.close()
            for width,height in [(390,844),(320,568),(844,390),(568,320)]:
                phone.set_viewport_size({'width':width,'height':height});phone.wait_for_timeout(160)
                shot(phone,f'rl-touch-{width}x{height}')
                check(f'触屏进化入口可点 {width}x{height}',phone.locator('.hud-evolution').evaluate('el => {const r=el.getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}'))
                phone.locator('.hud-evolution').tap();phone.wait_for_selector('.run-evolution[open]')
                check(f'触屏已进化不能重复扣费 {width}x{height}',phone.locator('[data-action="evolve-run"]').is_disabled())
                phone.get_by_role('button',name='返回战场',exact=True).tap()
            phone.set_viewport_size({'width':390,'height':844});phone.wait_for_timeout(100)
            zone=phone.locator('.touch-zone').bounding_box();x=zone['x']+zone['width']*.5;y=zone['y']+zone['height']*.5
            initial=phone.evaluate('() => ({x:kirafanRL.world.player.x,y:kirafanRL.world.player.y})')
            cdp=touch_context.new_cdp_session(phone)
            cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
            cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+40,'y':y}]})
            phone.wait_for_timeout(450);cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
            check('进化续档后的摇杆可以移动',phone.evaluate('(p) => Math.hypot(kirafanRL.world.player.x-p.x,kirafanRL.world.player.y-p.y)>.1',initial))
            check('松手后摇杆输入归零',phone.evaluate('() => !kirafanRL.input.state.move.x && !kirafanRL.input.state.move.y'))
            phone.locator('.touch-attack').tap();phone.wait_for_timeout(100)
            check('触屏攻击不会卡住暂停',phone.evaluate('() => !kirafanRL.world.frozen'))
            check('无未捕获脚本错误',not report['errors'])
            browser.close()
    except Exception:
        print(json.dumps(report,ensure_ascii=False),flush=True)
        raise
    finally:
        server.shutdown();(OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__': main()
