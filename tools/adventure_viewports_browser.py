"""Real desktop/mobile layout, input and rotation regression for the adventure."""
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance
from rl_ui_orientation_browser import settled

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/adaptive-review'
INIT = """window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',
JSON.stringify({prologueSeen:true,tutorialSeen:true}));"""

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server=Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    base='http://127.0.0.1:%d'%server.server_address[1]
    url=base+'/site/game/roguelike.html?seed=10926'
    report={'checks':[],'errors':[]}
    def check(name,ok,detail=None):
        report['checks'].append({'name':name,'ok':bool(ok),'detail':detail})
        print(('PASS ' if ok else 'FAIL ')+name,flush=True)
        if not ok:raise AssertionError(name+': '+str(detail))
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(channel='msedge',args=['--enable-unsafe-swiftshader'])
            for touch in [False,True]:
                context=browser.new_context(viewport={'width':390,'height':844},is_mobile=touch,has_touch=touch)
                context.add_init_script(INIT)
                page=context.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.goto(url);page.locator('.roster-card[data-card-id="32002001"]').click(timeout=60000)
                page.evaluate("async()=>{await document.fonts.ready;await document.querySelector('.rl-selected-art').decode();}")
                page.screenshot(path=str(OUT/('camp-'+str(touch)+'.png')))
                if touch:page.locator('#roster-start').tap()
                else:page.locator('#roster-start').click()
                settled(page,touch=touch)
                for width,height in [(320,568),(390,844),(600,900),(568,320),(844,390),(1024,768),(1440,900)]:
                    page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(100);advance(page,1/60)
                    bounds=page.evaluate("""()=>{const selectors=['#hud','#minimap','.hud-gauge',...Array.from({length:3},(_,i)=>`.hud-skill[data-slot="${i}"]`),
                        '.touch-attack','.touch-dodge','.touch-interact','.hud-pause'];
                        const boxes=selectors.map(s=>{const n=document.querySelector(s);if(!n||!n.getClientRects().length||getComputedStyle(n).visibility==='hidden')return null;
                            const r=n.getBoundingClientRect(),t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
                            return {s,x:r.x,y:r.y,w:r.width,h:r.height,inView:r.x>=-.5&&r.y>=-.5&&r.right<=innerWidth+.5&&r.bottom<=innerHeight+.5,
                                reachable:s==='#hud'||s==='#minimap'||n===t||n.contains(t)};}).filter(Boolean);
                        const overlaps=[];for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];
                            if(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>1&&Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>1)overlaps.push([a.s,b.s]);}
                        return {boxes,overlaps,frozen:kirafanRL.world.frozen,portraitGate:!!document.querySelector('#landscape-guard'),
                            bodyOverflow:document.documentElement.scrollWidth>innerWidth+1};}""")
                    label=('touch ' if touch else 'PC ')+str(width)+'x'+str(height)
                    check(label+' controls fit without overlap',not bounds['bodyOverflow'] and not bounds['overlaps'] and all(b['inView'] and b['reachable'] for b in bounds['boxes']),bounds)
                    check(label+' world remains active',not bounds['frozen'] and not bounds['portraitGate'])
                    page.screenshot(path=str(OUT/('battle-'+str(touch)+'-'+str(width)+'.png')))
                if touch:
                    page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100);advance(page,1/60)
                    zone=page.locator('.touch-zone').bounding_box();x=zone['x']+50;y=zone['y']+zone['height']*.55
                    cdp=context.new_cdp_session(page);before=page.evaluate('kirafanRL.world.player.x')
                    cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
                    cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+50,'y':y}]});advance(page,.2)
                    check('portrait joystick moves the actual player',page.evaluate('kirafanRL.world.player.x')>before)
                    page.set_viewport_size({'width':844,'height':390});page.wait_for_timeout(100)
                    check('rotation clears held input without freezing the world',page.evaluate('!kirafanRL.input.state.move.x&&!kirafanRL.input.state.move.y&&!kirafanRL.world.frozen'))
                    cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
                    page.locator('.hud-pause').tap();advance(page,1/60)
                    page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100)
                    check('rotation preserves the player-owned pause',page.locator('#menu-panel').is_visible() and page.evaluate('kirafanRL.world.frozen'))
                    page.locator('#menu-resume').tap();advance(page,1/60)
                    page.locator('.hud-skill[data-slot="1"]').tap();advance(page,1/60)
                    check('portrait touch skill activates actual cooldown',page.evaluate('kirafanRL.world.player.skills.slots[1].remaining>0'))
                    advance(page,1)
                    page.evaluate('kirafanRL.world.player.skills.addGauge(kirafanRL.world.player.skills.gaugeMax)');advance(page,1/60)
                    page.locator('.hud-gauge').tap();advance(page,1/60)
                    page.wait_for_function('!!kirafanRL.ultimate.stage&&!kirafanRL.ultimate.loading',polling=50,timeout=60000)
                    advance(page,.3);frame=page.evaluate('kirafanRL.ultimate.stage.frame')
                    page.set_viewport_size({'width':844,'height':390});page.wait_for_timeout(100);advance(page,.2)
                    check('ultimate scene continues once through rotation',page.evaluate('kirafanRL.ultimate.stage.frame')>frame)
                    page.locator('.rl-ultimate-skip').tap();advance(page,1/60)
                    check('ultimate closes with input and world restored',page.evaluate('!kirafanRL.ultimate.stage&&!kirafanRL.world.frozen'))
                else:
                    page.locator('.hud-skill[data-slot="1"]').hover();page.locator('.hud-skill-tooltip').wait_for(state='visible')
                    check('PC hover keeps the real skill description accessible',len(page.locator('.hud-skill-tooltip').inner_text())>20)
                    page.set_viewport_size({'width':600,'height':900});page.evaluate("document.body.style.zoom='1.5'");page.wait_for_timeout(100);advance(page,1/60)
                    check('150 percent zoom keeps menu reachable',page.locator('.hud-pause').bounding_box()['x']>=0)
                context.close()
            context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
            page=context.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
            page.goto(base+'/site/etowaria-defense/index.html?review=1')
            page.locator('#start-campaign:enabled').tap(timeout=60000)
            page.locator('[data-action="prepare"]').tap();page.locator('[data-action="deck-start"]').tap()
            page.locator('[data-action="brief-close"]').tap(timeout=60000)
            page.wait_for_function('__defense.campaign.view?.ready',timeout=60000)
            page.locator('.campaign-battle .seed-card[data-card="U01"]').tap()
            point=page.evaluate('__defenseReview.cellPoint(1,1)');page.touchscreen.tap(point['x'],point['y'])
            page.locator('[data-action="confirm-placement"]').tap()
            page.wait_for_function("[...__defense.campaign.view.battle.units.values()].some(u=>u.type==='U01'&&u.row===1&&u.col===1)",timeout=60000)
            check('TD portrait touch selects a cell and confirms actual deployment',True)
            page.locator('[data-action="start"]').tap();page.evaluate('__defenseReview.campaignStep(.2)')
            page.set_viewport_size({'width':844,'height':390});page.wait_for_timeout(100)
            check('TD touch battle continues after rotation',page.evaluate("__defense.campaign.view.battle.phase==='running'&&!__defense.campaign.view.battle.pauses.size"))
            page.locator('[data-action="pause"]').tap();page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100)
            check('TD rotation keeps manual pause intact',page.evaluate("__defense.campaign.view.battle.pauses.has('manual')"))
            page.screenshot(path=str(OUT/'td-touch-paused.png'));context.close()
            browser.close();check('no unhandled browser errors',not report['errors'],report['errors'])
    finally:
        (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        server.shutdown();worker.join(timeout=5);server.server_close()

if __name__=='__main__':main()
