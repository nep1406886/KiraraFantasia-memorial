"""Browser regression for both memorial adventures, using isolated local saves.

Requires Playwright and Chromium (or --channel msedge). Uses a no-cache server;
screenshots and a machine-readable report stay in .codex-tmp/adventure-review.
Battle completion uses the existing deterministic defense driver without changing
resources or health. The RL result check explicitly injects a lethal projectile.
"""
import argparse
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/adventure-review'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--channel', default=None)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'failed_requests': []}

    def check(label, condition, detail=None):
        report['checks'].append({'label': label, 'ok': bool(condition), 'detail': detail})
        print(('PASS ' if condition else 'FAIL ') + label, flush=True)
        if not condition:
            raise AssertionError(f'{label}: {detail}')

    def watch(page):
        page.on('pageerror', lambda error: report['errors'].append(str(error)))
        page.on('response', lambda response: report['failed_requests'].append(
            f'{response.status} {response.url}') if response.status >= 400 else None)

    def shot(page, name):
        page.wait_for_timeout(500)
        page.evaluate('''async()=>{await document.fonts.ready;await Promise.all(
            [...document.images].filter(img=>{const r=img.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<innerHeight&&r.bottom>0;})
                .map(img=>img.decode().catch(()=>{})));}''')
        page.screenshot(path=str(OUT / (name + '.png')))

    def fits(page, selector):
        return page.locator(selector).evaluate('''el => {
            const r=el.getBoundingClientRect(); return r.left>=-1 && r.right<=innerWidth+1
                && el.scrollWidth<=el.clientWidth+1;
        }''')

    def animated(page, selector, moving=True):
        node = page.locator(selector)
        page.wait_for_timeout(100)
        before = node.evaluate('e=>e.getAnimations().map(a=>a.currentTime)')
        page.wait_for_timeout(350)
        after = node.evaluate('e=>e.getAnimations().map(a=>a.currentTime)')
        if not moving and not after:
            return True
        return bool(before) and len(before) == len(after) and all(
            (b-a > 200) if moving else abs(b-a) < 1 for a,b in zip(before,after))

    def dismiss(page, touch=False):
        for _ in range(100):
            skip = page.locator('#dialogue-skip')
            if skip.is_visible():
                skip.tap() if touch else skip.click()
                page.wait_for_timeout(80)
            else:
                page.wait_for_timeout(150)
                if not skip.is_visible():
                    return
        raise AssertionError('dialogue did not finish')

    def ready(page, touch=False):
        page.wait_for_function('''()=>{const k=window.kirafanRL; return k?.world?.player
            && k.pending===0 && k.interactPending===0 && !k.roomLoading
            && k.mapview.group?.name==='room:'+k.world.roomId;}''', timeout=60000)
        dismiss(page, touch=touch)
        page.wait_for_function('!kirafanRL.world.frozen', timeout=20000)

    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel=args.channel, args=['--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width':1440, 'height':900})
            # Skip the separate controls tutorial, but leave the prologue unread.
            context.add_init_script("if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',JSON.stringify({tutorialSeen:true}));")
            page = context.new_page(); watch(page)
            rl = base + '/site/game/roguelike.html?seed=10926'
            page.goto(rl)
            page.locator('.roster-card').first.wait_for(timeout=60000)
            check('营地展示41位同行者', page.locator('.roster-card').count() == 41)
            check('新档营地没有提前播放序章', not page.locator('#dialogue-skip').is_visible()
                  and page.evaluate('!JSON.parse(localStorage.getItem("kirafan-rl:profile")).meta.prologueSeen'))
            search = page.get_by_role('searchbox', name='搜索角色、作品或职业')
            search.fill('不存在的伙伴')
            check('搜索空结果有说明', page.locator('.rl-roster-empty').is_visible())
            search.fill('志摩')
            check('按名字搜索同行者', page.locator('.roster-card:visible').count() == 1)
            page.locator('.roster-card:visible').click()
            check('选卡只预览，明确出发才开局', page.locator('#roster-start').is_visible()
                  and '志摩' in page.locator('#roster-start').inner_text())
            search.fill('')
            page.locator('#roster-guide').click()
            check('冒险指南可展开', page.locator('#roster-guide-content').is_visible())
            page.locator('#roster-guide').click()
            check('桌面营地不横向溢出', fits(page, '#roster-overlay'))
            shot(page, 'rl-camp-desktop')
            page.locator('#roster-details').click()
            check('人物技能可查看', page.locator('#rl-charcard').is_visible())
            page.keyboard.press('Tab')
            check('人物详情键盘焦点保留在弹层', page.evaluate('!!document.activeElement.closest("#rl-charcard")'))
            page.keyboard.press('Escape')
            check('退出人物详情恢复入口焦点', page.locator('#roster-details').evaluate('e=>e===document.activeElement'))
            page.locator('#roster-start').focus(); page.keyboard.press('Enter')
            page.locator('#dialogue-skip').wait_for(timeout=60000)
            check('成功出发后播放并记录序章', page.evaluate('JSON.parse(localStorage.getItem("kirafan-rl:profile")).meta.prologueSeen'))
            ready(page)
            check('进入所选角色的真实战斗', '志摩' in page.locator('.hud-player-name').inner_text())
            check('角色头像正常载入', page.locator('.hud-player-portrait').evaluate('e=>e.complete&&e.naturalWidth>0'))
            page.evaluate('()=>{const k=kirafanRL,s=k.world.player.skills;s.addGauge(s.gaugeMax);k.step(1/60);}')
            check('必杀就绪的辉光与扫光实际播放（充能夹具）', animated(page,'.hud-gauge'))
            shot(page, 'rl-battle-desktop')
            before = page.evaluate('({x:kirafanRL.world.player.x,y:kirafanRL.world.player.y})')
            page.keyboard.down('d'); page.wait_for_timeout(400); page.keyboard.up('d')
            check('键盘移动有效', page.evaluate('kirafanRL.world.player.x') != before['x'])
            page.locator('.hud-pause').click()
            check('菜单打开后世界暂停', page.locator('#menu-panel').is_visible() and page.evaluate('kirafanRL.world.frozen'))
            check('菜单暂停也冻结战斗界面动画', animated(page,'.hud-gauge',False))
            shot(page, 'rl-menu-desktop')
            page.locator('#menu-resume').click()
            page.wait_for_function('!kirafanRL.world.frozen')
            card_id = page.evaluate('kirafanRL.world.player.card.id')
            page.reload()
            page.locator('#roster-continue').wait_for(timeout=60000)
            page.locator('#roster-continue').click(); ready(page)
            check('刷新后继续同一角色存档', page.evaluate('kirafanRL.world.player.card.id') == card_id)
            page.evaluate('''()=>{const k=kirafanRL,w=k.world,p=w.player;p.iframes=0;
                w.danmaku.emit('aimed',{x:p.x-3,y:p.y,angle:0},{side:'enemy',power:999999999,coef:1,count:1,speed:10,life:4});
                for(let i=0;i<120&&!p.dead;i++)k.step(1/60);}''')
            dismiss(page)
            page.locator('#rl-result').wait_for(timeout=20000)
            check('力竭后显示结算（致命弹幕夹具）', page.locator('#rl-result').get_attribute('data-outcome') == 'defeat')
            shot(page, 'rl-result-desktop')
            context.close()

            mobile = browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
            mobile.add_init_script("localStorage.setItem('kirafan-rl:meta',JSON.stringify({tutorialSeen:true,prologueSeen:true}));")
            page = mobile.new_page(); watch(page); page.goto(rl)
            page.locator('#roster-start').wait_for(timeout=60000)
            shot(page, 'rl-camp-portrait')
            check('手机竖屏可浏览营地', not page.locator('#landscape-guard').is_visible() and fits(page, '#roster-overlay'),
                  page.locator('#roster-overlay').evaluate('e=>({width:e.clientWidth,scroll:e.scrollWidth,overflow:[...e.querySelectorAll("*")].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>n.className)})'))
            page.locator('#roster-storage').tap()
            check('手机营地可打开存档', page.locator('#rl-storage').is_visible())
            page.locator('#storage-close').tap()
            page.locator('#roster-start').tap()
            ready(page, touch=True)
            check('手机竖屏可直接开始冒险', not page.locator('#landscape-guard').is_visible() and page.evaluate('!kirafanRL.world.frozen'))
            page.set_viewport_size({'width':844,'height':390}); ready(page, touch=True)
            check('旋转后可继续游戏', not page.locator('#landscape-guard').is_visible())
            shot(page, 'rl-battle-landscape')
            page.set_viewport_size({'width':390,'height':844})
            page.wait_for_timeout(100)
            check('战斗中旋转回竖屏仍可操作', not page.locator('#landscape-guard').is_visible() and page.evaluate('!kirafanRL.world.frozen'))
            mobile.close()

            context = browser.new_context(viewport={'width':1440,'height':900})
            page = context.new_page(); watch(page)
            defense = base + '/site/etowaria-defense/index.html?review=1'
            page.goto(defense); page.locator('#start-campaign:enabled').wait_for(timeout=60000)
            check('标题人物浮动随实际时间推进', animated(page,'.watch-kirara'))
            page.emulate_media(reduced_motion='reduce')
            check('系统减少动态效果关闭装饰动画',page.locator('.watch-kirara').evaluate('e=>e.getAnimations().length===0'))
            page.emulate_media(reduced_motion='no-preference')
            shot(page, 'defense-title-desktop')
            page.locator('#start-campaign').click()
            page.locator('.campaign-selection').wait_for(state='visible')
            check('巡守地图一次显示一章', page.locator('.campaign-chapter-group:visible').count() == 1,
                  page.locator('.campaign-chapter-group:visible').all_inner_texts())
            page.locator('[data-chapter-nav="2"]').click()
            check('可以预览锁定章节，不能越过解锁条件', page.locator('[data-action="prepare"]').is_disabled())
            page.locator('[data-chapter-nav="endless"]').click()
            check('无尽巡守始终可进入', page.locator('[data-action="prepare"]').is_enabled())
            page.locator('[data-chapter-nav="1"]').click()
            button_box = page.locator('[data-action="prepare"]').bounding_box()
            check('桌面选关出发按钮在首屏', button_box['y'] + button_box['height'] <= 900)
            shot(page, 'defense-map-desktop')
            page.locator('[data-action="prepare"]').click()
            search = page.get_by_role('searchbox', name='搜索布阵卡牌')
            search.fill('志摩')
            check('编队可按伙伴搜索', page.locator('.deck-card:visible').count() >= 1
                  and all('志摩' in text for text in page.locator('.deck-card:visible').all_inner_texts()))
            page.locator('.deck-options summary').click()
            page.locator('.deck-filters button').filter(has_text='设施').click()
            check('职业与名字联合筛选提供空态', page.locator('.deck-empty').is_visible())
            search.fill(''); page.locator('.deck-options summary').click()
            page.locator('.deck-filters button').filter(has_text='全部').click()
            check('筛选不改变已选8张布阵卡', page.locator('.deck-chosen-chip').count() == 8)
            check('完整编队包含167张原作人物卡',page.locator('.deck-card[data-card^="U"]').count()==167)
            work = page.get_by_role('combobox', name='按作品筛选卡牌')
            title = page.evaluate('''()=>{window.deckReview={card:document.querySelector('[data-card="U01"]'),
                image:document.querySelector('[data-card="U01"] img'),choice:[...__defense.campaign.deckChoice]};
                return __defense.campaign.unit('U01').work;}''')
            work.select_option(title)
            page.locator('.deck-options-panel > button').click()
            page.locator('.deck-card[data-card="U01"]').click()
            page.locator('.deck-card[data-card="U01"]').click()
            check('切换卡牌复用图片节点并保留作品筛选、顺序与存档',page.evaluate('''()=>{
                const c=__defense.campaign,r=window.deckReview;
                return r.card===document.querySelector('[data-card="U01"]')
                    &&r.image===r.card.querySelector('img')&&c.deckWork===c.unit('U01').work
                    &&JSON.stringify(c.deckChoice)===JSON.stringify(r.choice)
                    &&JSON.stringify(c.save.deck)===JSON.stringify(r.choice)
                    &&[...document.querySelectorAll('.deck-card:not([hidden])')].every(b=>c.unit(b.dataset.card)?.work===c.deckWork);
            }'''))
            page.locator('.deck-options summary').click()
            work.select_option('全部作品')
            page.locator('.deck-options-panel > button').click()
            check('每张人物完整卡面可解码',page.evaluate('''async()=>{const cards=__defense.campaign.catalogue.units;
                return (await Promise.all(cards.map(c=>new Promise(resolve=>{const img=new Image();
                    img.onload=()=>resolve(img.naturalWidth>100);img.onerror=()=>resolve(false);
                    img.src=new URL('../'+c.card,location.href).href;})))).every(Boolean);}'''))
            check('桌面卡片首行含名字与战术完整可见',page.locator('.deck-grid').evaluate('''e=>{
                const r=e.getBoundingClientRect(),c=e.querySelector('.deck-card').getBoundingClientRect();return c.bottom<=r.bottom;}'''))
            check('编队卡片文字与头像不重叠', page.locator('.deck-card').first.evaluate('''e=>{
                const a=e.querySelector('.seed-art').getBoundingClientRect(),n=e.querySelector('.seed-name').getBoundingClientRect();
                return (n.left>=a.right || n.top>=a.bottom) && n.width>60;}'''))
            shot(page, 'defense-deck-desktop')
            page.locator('[data-action="deck-start"]').click()
            page.locator('[data-role="brief-dialog"]').wait_for(state='visible', timeout=60000)
            check('新手步骤文本宽度正常', page.locator('.opening-steps span').first.evaluate('e=>e.getBoundingClientRect().width>150'))
            shot(page, 'defense-brief-desktop')
            page.locator('[data-action="brief-close"]').click()
            page.wait_for_function('window.__defense.snapshot().campaign.battle?.ready', timeout=60000)
            page.evaluate("async()=>{const {createCampaignDriver}=await import('./tests/campaign-driver.js');window.driver=createCampaignDriver();}")
            check('初始战场有部署指引', page.locator('.board-guide').is_visible())
            check('通过真实界面部署应援台', page.evaluate("driver.deploy('F01',1,0)"))
            check('通过真实界面部署同伴', page.evaluate("driver.deploy('U01',1,1)"))
            shot(page, 'defense-setup-desktop')
            page.locator('[data-action="start"]').click()
            page.locator('[data-action="pause"]').click()
            t = page.evaluate('driver.state().battle.time')
            page.evaluate('__defenseReview.campaignStep(5)')
            check('巡守暂停冻结战斗时间', page.evaluate('driver.state().battle.time') == t)
            check('巡守暂停也冻结应援图标动画',animated(page,'.crea-icon',False))
            shot(page, 'defense-pause-desktop')
            page.locator('[data-action="resume"]').click()
            for _ in range(14):
                state = page.evaluate('driver.run(30)')
                if state['phase'] != 'running':
                    break
            check('真实部署并通关第一关', state['phase'] == 'won', state)
            page.locator('[data-role="result-dialog"]').wait_for(state='visible')
            shot(page, 'defense-result-desktop')
            page.locator('[data-action="result-map"]').click()
            page.reload(); page.locator('#start-campaign:enabled').wait_for(timeout=60000)
            page.locator('#start-campaign').click()
            check('通关记录刷新后保留', page.locator('.journey-progress').inner_text().startswith('已守住 1 / 32'))
            context.close()

            mobile = browser.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True)
            page = mobile.new_page(); watch(page); page.goto(defense)
            page.locator('#start-campaign:enabled').wait_for(timeout=60000)
            check('巡守标题页适配手机', fits(page, '.title-screen'))
            shot(page, 'defense-title-portrait')
            page.locator('#start-campaign').tap()
            page.locator('.campaign-selection').wait_for(state='visible')
            check('巡守地图适配手机', fits(page, '.campaign-map'))
            shot(page, 'defense-map-portrait')
            page.locator('[data-action="prepare"]').tap()
            check('编队面板适配手机', fits(page, '.deck-picker'))
            check('手机编队出发按钮始终在首屏',page.locator('[data-action="deck-start"]').evaluate('e=>e.getBoundingClientRect().bottom<=innerHeight'))
            shot(page, 'defense-deck-portrait')
            page.locator('.deck-grid').evaluate('e=>{e.scrollTop=e.scrollHeight;}')
            check('手机能滚到最后一张卡且出发按钮不遮挡',page.locator('.deck-card').last.evaluate('''e=>{
                const r=e.getBoundingClientRect(),g=e.closest('.deck-grid').getBoundingClientRect();
                return r.bottom<=g.bottom+1&&r.top>=g.top-1&&g.bottom<=document.querySelector('[data-action="deck-start"]').getBoundingClientRect().top;
            }'''))
            for width,height in [(568,320),(844,390)]:
                page.set_viewport_size({'width':width,'height':height})
                page.locator('.deck-grid').evaluate('e=>{e.scrollTop=0;}')
                check(f'{width}×{height}横屏可同时浏览完整卡片、说明与出发按钮',page.evaluate('''()=>{
                    const q=s=>document.querySelector(s),g=q('.deck-grid').getBoundingClientRect(),
                        c=q('.deck-card').getBoundingClientRect(),b=q('[data-action="deck-start"]').getBoundingClientRect(),
                        d=q('.deck-detail').getBoundingClientRect();
                    return c.top>=g.top&&c.bottom<=g.bottom&&g.bottom<=d.top&&d.height>0
                        &&b.top>=0&&b.bottom<=innerHeight&&d.bottom<=innerHeight&&g.right<=innerWidth;
                }'''))
                shot(page, f'defense-deck-landscape-{width}')
                page.locator('.deck-grid').evaluate('e=>{e.scrollTop=e.scrollHeight;}')
                check(f'{width}×{height}横屏可完整查看最后一张卡',page.locator('.deck-card').last.evaluate('''e=>{
                    const r=e.getBoundingClientRect(),g=e.closest('.deck-grid').getBoundingClientRect();return r.top>=g.top-1&&r.bottom<=g.bottom+1;
                }'''))
            page.locator('[data-action="deck-start"]').tap()
            page.locator('[data-action="brief-close"]').tap(timeout=60000)
            page.wait_for_function('window.__defense.snapshot().campaign.battle?.ready', timeout=60000)
            check('横屏巡守战场无横向溢出', fits(page, '.campaign-battle'))
            shot(page, 'defense-battle-landscape')
            page.set_viewport_size({'width':390,'height':844})
            page.wait_for_timeout(100)
            check('巡守竖屏保持战场与返回操作可用', fits(page,'.campaign-battle') and page.locator('.battle-head [data-action="leave"]').is_visible() and page.evaluate('!__defense.campaign.view.battle.pauses.size'))
            mobile.close()
            check('所有画面无脚本异常', not report['errors'], report['errors'])
            check('所有资源请求成功', not report['failed_requests'], report['failed_requests'])
            browser.close()
    finally:
        server.shutdown(); server.server_close()
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
