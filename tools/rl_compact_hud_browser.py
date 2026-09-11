"""Short-landscape HUD with real equipment and explicitly staged status effects.

The game keeps its real layout, input and save paths. Manual simulation and the
long-lived buff fixture are layout evidence, not natural frame-time evidence.
"""
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import ready, advance
from rl_gadget_contract_browser import enter, generated_item, take_drop
from rl_feedback_experience_browser import STATE

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/ui-polish/compact'
FILES = ['site/game/roguelike.html', 'site/game/rl/ui/theme.css', 'site/game/rl/ui/hud.js', 'site/game/rl/main.js', 'site/game/rl/world.js']
LAYOUT = """()=>{
    const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
    const selectors=['#hud','#hint','.hud-skillbar','.hud-gauge','.touch-attack','.touch-dodge','.touch-interact','#minimap','#boss-bar'];
    const areas=selectors.map(s=>{const n=document.querySelector(s),c=getComputedStyle(n);
        return {s,...rect(n),visible:!n.hidden&&c.display!=='none'&&c.visibility!=='hidden'};})
        .filter(r=>r.visible&&r.w>0&&r.h>0);
    const overlaps=[];
    for(let i=0;i<areas.length;i++)for(let j=i+1;j<areas.length;j++){const a=areas[i],b=areas[j];
        if(a.x<b.x+b.w-1&&b.x<a.x+a.w-1&&a.y<b.y+b.h-1&&b.y<a.y+a.h-1)overlaps.push([a.s,b.s]);}
    return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,areas,overlaps};
}"""


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'layouts': [], 'errors': [], 'source_before': fingerprints(), 'complete': False}

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
                localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
            page = context.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.goto('http://127.0.0.1:%d/site/game/roguelike.html?volume=1&floor=13&seed=176' % server.server_address[1],
                      wait_until='load', timeout=60000)
            page.locator('.roster-card').filter(has=page.locator('img[src$="/14002001.webp"]')).click(timeout=60000)
            ready(page); enter(page, 'shop')
            take_drop(page, generated_item(page, 'binding', 1)); advance(page, 2)
            for crowded in [False, True]:
                if crowded:
                    page.evaluate("""()=>{const p=kirafanRL.world.player;
                        p.skills.applySelf({buffs:[{target:0,turns:100,atk:.15,mgc:.1,def:.2,mdef:.1,spd:.15,luck:.1}],
                            barrier:{cut:.5,hits:3}});p.nextCritical=true;p.healingLock=90;kirafanRL.step(1/60);}""")
                for width, height, touch in [(812,375,True),(844,390,True),(915,412,True),(932,430,True),
                                             (667,375,True),(640,360,True),(1280,440,False),(1280,840,False)]:
                    name = ('crowded' if crowded else 'contract') + '-%dx%d' % (width,height)
                    page.set_viewport_size({'width': width, 'height': height})
                    if touch: page.touchscreen.tap(width / 2, height / 2)
                    else: page.keyboard.press('Shift')
                    advance(page)
                    row = page.evaluate(LAYOUT)
                    report['layouts'].append({'name': name, **row})
                    page.screenshot(path=str(OUT / (name + '.png')))
                    check(name + ' 状态、提示、技能与触控区互不压盖', not row['overlaps'] and row['scroll'] <= width, row)
                    check(name + ' 核心读数和自动开关都在可视区', page.locator('#hp-display').is_visible()
                          and page.locator('#coin-display').is_visible() and page.locator('.hud-assist').is_visible()
                          and page.locator('.hud-assist').evaluate('(n)=>{const r=n.getBoundingClientRect();return r.height>=44&&r.y>=0&&r.bottom<=innerHeight;}'))
                    check(name + ' 契约与完整状态文字仍保留', '缚技契约' in page.locator('.hud-effects').inner_text()
                          and (not crowded or all(word in page.locator('.hud-effects').inner_text() for word in ['护盾','治疗封锁','技能恢复'])))
                if crowded:
                    page.set_viewport_size({'width': 844, 'height': 390}); page.touchscreen.tap(420,180); advance(page)
                    effect = page.locator('.hud-effects'); text = effect.inner_text(); before = page.evaluate(STATE)
                    box = effect.bounding_box(); session = context.new_cdp_session(page)
                    x, y = box['x'] + box['width']/2, box['y'] + box['height'] - 5
                    session.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':x,'y':y,'id':41}]})
                    for distance in [6,12,20,30,44,60]:
                        session.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':x,'y':y-distance,'id':41}]})
                        page.wait_for_timeout(20)
                    session.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]}); page.wait_for_timeout(150)
                    check('横屏长状态可真实触摸滚动，不改装备或资源', effect.evaluate('n=>n.scrollTop>0')
                          and effect.inner_text() == text and page.evaluate(STATE) == before)
                    check('滚动状态不误启动摇杆或技能', page.evaluate('!kirafanRL.input.state.attack&&!kirafanRL.input.state.skill.some(Boolean)&&!kirafanRL.input.state.move.x&&!kirafanRL.input.state.move.y'))
                    session.detach()
                    page.screenshot(path=str(OUT / 'status-scrolled-touch.png'))
            enter(page, 'boss')
            page.evaluate("""()=>{const w=kirafanRL.world;
                w.enemies.forEach(e=>e.actionTimer=1e9);w.player.iframes=1e9;
                w.player.skills.applySelf({buffs:[{target:0,turns:100,atk:.15,mgc:.1,def:.2,mdef:.1,spd:.15,luck:.1}],
                    barrier:{cut:.5,hits:3}});}""")
            advance(page, 2.2)
            check('真实层守卫启用同一首领HUD布局', page.locator('#boss-bar').is_visible()
                  and page.locator('#stage').evaluate("n=>n.classList.contains('boss-fight')"))
            for width, height in [(640,360),(667,375),(812,375),(844,390),(932,430)]:
                page.set_viewport_size({'width':width,'height':height});page.touchscreen.tap(width/2,height-100);advance(page)
                name = 'guardian-%dx%d' % (width,height); row = page.evaluate(LAYOUT)
                report['layouts'].append({'name':name,**row});page.screenshot(path=str(OUT/(name+'.png')))
                check(name+' 首领血条、状态、地图和技能互不压盖', not row['overlaps'], row)
            check('没有未捕获页面异常', not report['errors'], report['errors'])
            report['complete'] = True
            context.close(); browser.close()
    finally:
        server.shutdown(); worker.join(timeout=5); server.server_close()
        report['source_after'] = fingerprints()
        report['changed_during_run'] = [name for name in FILES if report['source_before'][name] != report['source_after'][name]]
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    if report['changed_during_run']:
        raise AssertionError('运行期间产品文件变化，需要稳定复验')


if __name__ == '__main__':
    main()
