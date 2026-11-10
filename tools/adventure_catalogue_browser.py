"""Catalogue usability: real hit targets, focus, selection ownership and viewports."""
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/catalogue-review'
SIZES = [(320,568),(390,844),(600,900),(568,320),(844,390),(1024,768),(1440,900)]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    base = 'http://127.0.0.1:'+str(server.server_address[1])
    report = {'checks':[], 'errors':[], 'failed':[]}

    def check(name, ok, data=None):
        report['checks'].append({'name':name,'ok':bool(ok),'data':data})
        print(('PASS ' if ok else 'FAIL ')+name,flush=True)
        if not ok: raise AssertionError(name+': '+str(data))

    def watch(page):
        page.on('pageerror', lambda e: report['errors'].append(str(e)))
        page.on('response', lambda r: report['failed'].append(str(r.status)+' '+r.url) if r.status>=400 else None)

    def shot(page, name):
        page.evaluate('''async()=>{await document.fonts.ready;await Promise.all([...document.images]
            .filter(i=>{const r=i.getBoundingClientRect();return r.width&&r.height&&r.bottom>0&&r.top<innerHeight;})
            .map(i=>i.decode().catch(()=>{})));}''')
        page.screenshot(path=str(OUT/(name+'.png')))

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel='msedge',args=['--enable-unsafe-swiftshader'])
            ctx = browser.new_context(viewport={'width':320,'height':568},has_touch=True,is_mobile=True,reduced_motion='reduce')
            page = ctx.new_page();watch(page)
            page.goto(base+'/site/etowaria-defense/?review=1')
            page.locator('#start-campaign:enabled').tap(timeout=60000)
            page.locator('[data-action="prepare"]').tap()
            before = page.evaluate('__defense.campaign.save.export()')
            for w,h in SIZES:
                page.set_viewport_size({'width':w,'height':h})
                page.locator('.deck-grid').evaluate('e=>e.scrollTop=0')
                geometry = page.evaluate('''()=>{const grid=document.querySelector('.deck-grid').getBoundingClientRect(),
                    card=document.querySelector('.deck-card').getBoundingClientRect(),button=document.querySelector('[data-action="deck-start"]'),b=button.getBoundingClientRect();
                    return {height:grid.height,cardHeight:card.height,complete:card.top>=grid.top&&card.bottom<=grid.bottom,
                        start:b.bottom<=innerHeight&&b.left>=0&&button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),
                        overflow:document.documentElement.scrollWidth>innerWidth};}''')
                check('TD first complete card and departure reachable '+str(w),geometry['complete'] and geometry['start'] and not geometry['overflow'],geometry)
                shot(page,'td-catalogue-'+str(w))
                page.locator('.deck-options summary').tap()
                page.locator('.deck-options-panel > button').scroll_into_view_if_needed()
                check('TD filter confirmation fits '+str(w),page.locator('.deck-options-panel > button').evaluate('e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}'))
                page.locator('.deck-options-panel > button').tap()
                page.locator('.deck-grid').evaluate('e=>e.scrollTop=e.scrollHeight')
                check('TD final card fully reachable '+str(w),page.locator('.deck-card').last.evaluate('e=>{const r=e.getBoundingClientRect(),g=document.querySelector(".deck-grid").getBoundingClientRect();return r.top>=g.top-.5&&r.bottom<=g.bottom+.5;}'))
            page.set_viewport_size({'width':390,'height':844})
            search = page.get_by_role('searchbox',name='搜索布阵卡牌')
            search.fill('后藤')
            inspect = page.get_by_role('button',name='查看后藤一里的卡面与成长',exact=True)
            inspect.tap()
            check('TD inspect the requested off-team character without spending or changing the deck',page.locator('.card-form-dialog h2').inner_text()=='后藤一里' and page.evaluate('__defense.campaign.save.export()')==before)
            page.get_by_role('button',name='确认形态',exact=True).tap()
            check('TD closing inspection restores its actual opener',inspect.evaluate('e=>e===document.activeElement'))
            search.fill('');page.locator('.deck-options summary').tap()
            page.get_by_role('button',name='设施',exact=True).tap()
            page.get_by_label('按作品筛选卡牌').select_option('请问您今天要来点兔子吗？')
            page.locator('.deck-options-panel > button').tap()
            check('TD empty result preserves the existing team',page.locator('.deck-empty').is_visible() and page.evaluate('__defense.campaign.save.export()')==before)
            page.locator('.deck-options summary').tap();page.keyboard.press('Escape')
            check('TD Escape closes filters and keeps keyboard focus',page.locator('.deck-options').evaluate('e=>!e.open&&e.querySelector("summary")===document.activeElement'))
            page.locator('.deck-options summary').tap();page.get_by_role('button',name='全部',exact=True).tap()
            page.get_by_label('按作品筛选卡牌').select_option('全部作品')
            page.get_by_role('button',name='标准阵',exact=True).tap()
            check('TD preset button survives its own selection',page.get_by_role('button',name='标准阵',exact=True).evaluate('e=>e===document.activeElement'))
            page.locator('.deck-options-panel > button').tap()
            page.locator('.deck-chosen-chip').first.focus();page.keyboard.press('Enter')
            check('TD removing a chosen card preserves focus on its neighbour',page.evaluate('document.activeElement.classList.contains("deck-chosen-chip")'))
            ctx.close()

            for touch in [False,True]:
                ctx = browser.new_context(viewport={'width':390,'height':844},is_mobile=touch,has_touch=touch,reduced_motion='reduce')
                ctx.add_init_script("if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
                p = ctx.new_page();watch(p);p.goto(base+'/site/game/roguelike.html?seed=1211')
                p.locator('#roster-start').wait_for(timeout=60000)
                for w,h in SIZES:
                    p.set_viewport_size({'width':w,'height':h})
                    p.locator('.rl-roster-catalogue').evaluate('e=>e.scrollIntoView({block:"start"})')
                    p.locator('.rl-roster-grid').evaluate('e=>e.scrollTop=0')
                    geometry = p.evaluate('''()=>{const button=document.querySelector('#roster-start'),b=button.getBoundingClientRect(),
                        aside=document.querySelector('.rl-companion-preview'),image=aside.querySelector('img'),a=image.getBoundingClientRect(),r=aside.getBoundingClientRect();
                        return {start:b.top>=0&&b.bottom<=innerHeight&&button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),
                            art:a.left>=r.left&&a.right<=r.right&&getComputedStyle(image).objectFit==='contain',
                            overflow:document.querySelector('.rl-roster').scrollWidth>innerWidth,previewHeight:r.height};}''')
                    check('RL preview and current departure fit '+str(touch)+' '+str(w),geometry['start'] and geometry['art'] and not geometry['overflow'],geometry)
                    check('RL first card is unobscured '+str(touch)+' '+str(w),p.locator('.rl-roster-card').first.evaluate('e=>{const r=e.getBoundingClientRect(),b=document.querySelector(".rl-departure").getBoundingClientRect();return r.top>=0&&r.bottom<=b.top;}'))
                    if touch:shot(p,'rl-catalogue-'+str(w))
                    p.locator('.rl-roster-grid').evaluate('e=>e.scrollTop=e.scrollHeight')
                    check('RL last card is unobscured '+str(touch)+' '+str(w),p.locator('.rl-roster-card').last.evaluate('e=>{const r=e.getBoundingClientRect(),g=document.querySelector(".rl-roster-grid").getBoundingClientRect(),b=document.querySelector(".rl-departure").getBoundingClientRect();return r.top>=Math.max(0,g.top)&&r.bottom<=b.top;}'))
                p.set_viewport_size({'width':390,'height':844})
                target=p.locator('.roster-card[data-card-id="47002001"]')
                target.tap() if touch else target.click()
                check('RL selected card and launch bar identify the same companion '+str(touch),p.locator('.rl-current-companion strong').inner_text() in p.locator('#roster-start').inner_text() and target.get_attribute('aria-pressed')=='true')
                p.locator('.rl-current-companion').click()
                check('RL return to card details focuses its heading '+str(touch),p.locator('.rl-selected-copy h3').evaluate('e=>e===document.activeElement&&e.getBoundingClientRect().top>=0'))
                p.locator('.rl-growth-toggle').click()
                check('RL growth disclosure retains the full material and ability preview '+str(touch),p.locator('.evolution-requirements').is_visible() and p.locator('.evolution-stat').count()==3)
                p.locator('.rl-growth-toggle').click()
                p.get_by_role('searchbox').fill('no-such-companion')
                check('RL empty search retains the chosen departure '+str(touch),p.locator('.rl-roster-empty').is_visible() and p.locator('#roster-start').is_enabled())
                p.get_by_role('searchbox').fill('');p.locator('#roster-start').click()
                p.wait_for_function('!!window.kirafanRL?.world?.player',timeout=60000)
                check('RL chosen identity reaches the real adventure '+str(touch),p.evaluate('kirafanRL.world.player.card.id')==47002001)
                ctx.close()
            browser.close()
            check('no unhandled errors or failed resources',not report['errors'] and not report['failed'],{'errors':report['errors'],'failed':report['failed']})
    finally:
        (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        server.shutdown();worker.join(timeout=5);server.server_close()


if __name__=='__main__':main()
