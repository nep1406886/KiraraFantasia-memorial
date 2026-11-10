"""Actual multitouch ownership, interruption and menu recovery regression."""
import argparse
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance
from rl_ui_orientation_browser import INIT, settled

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/touch-lifecycle'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--baseline',action='store_true');args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    report={'checks':[],'errors':[]}
    def check(name,ok,detail=None):
        report['checks'].append({'name':name,'ok':bool(ok),'detail':detail})
        print(('PASS ' if ok else 'FAIL ')+name,flush=True)
    with Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(channel='msedge',args=['--enable-unsafe-swiftshader'])
                context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
                context.add_init_script(INIT)
                page=context.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.goto('http://127.0.0.1:%d/site/game/roguelike.html?seed=10926'%server.server_address[1])
                page.locator('.roster-card[data-card-id="32002001"]').tap(timeout=60000)
                page.locator('#roster-start').tap();settled(page,True)
                page.evaluate('''()=>{const w=kirafanRL.world;w.enemies=[];w.roomColliders=[];
                    w.player.x=w.width/2;w.player.y=w.height/2;document.querySelector('.touch-zone').addEventListener('pointerdown',e=>window.stickPointer=e.pointerId);}''')
                cdp=context.new_cdp_session(page)
                page.evaluate("""()=>{window.touchTrace=[];for(const type of ['pointerdown','pointerup','pointercancel','lostpointercapture','click'])
                    window.addEventListener(type,e=>touchTrace.push({type,id:e.pointerId,primary:e.isPrimary,target:e.target.className}),true);}""")
                active=set()
                def touch(kind,points):
                    if kind in ['touchEnd','touchCancel'] and not active:return
                    cdp.send('Input.dispatchTouchEvent',{'type':kind,'touchPoints':points})
                    if kind=='touchStart':active.update(p['id'] for p in points)
                    elif kind=='touchCancel' or kind=='touchEnd' and not points:active.clear()
                    elif kind=='touchEnd':active.difference_update(p['id'] for p in points)
                def at(selector,id):
                    b=page.locator(selector).bounding_box()
                    return {'x':b['x']+b['width']/2,'y':b['y']+b['height']/2,'id':id}
                def clean():
                    touch('touchEnd',[]);page.evaluate("window.dispatchEvent(new Event('blur'))");advance(page,1/60)
                first=at('.touch-zone',1);moved={**first,'x':first['x']+45}
                touch('touchStart',[first]);touch('touchMove',[moved]);advance(page,.1)
                check('真实摇杆拖动产生移动',page.evaluate('kirafanRL.input.state.move.x>0'))
                page.evaluate("document.querySelector('.touch-zone').releasePointerCapture(stickPointer)")
                touch('touchMove',[{**moved,'x':moved['x']+1}])
                page.wait_for_timeout(80)
                check('捕获丢失立即停止摇杆并收起摇杆图形',page.evaluate("!kirafanRL.input.state.move.x&&document.querySelector('.touch-knob').classList.contains('hud-hidden')"),page.evaluate('touchTrace'))
                clean()
                touch('touchStart',[first]);touch('touchMove',[moved]);advance(page,.1)
                second=at('.hud-pause',2)
                touch('touchStart',[moved,second]);touch('touchEnd',[second]);advance(page,1/60)
                opened=page.locator('#menu-panel').is_visible()
                check('按住摇杆时第二指能打开菜单',opened,page.evaluate('touchTrace'))
                if not opened:
                    clean();page.locator('.hud-pause').tap();advance(page,1/60)
                check('菜单打开即清除移动和攻击',page.evaluate('!kirafanRL.input.state.move.x&&!kirafanRL.input.state.move.y&&!kirafanRL.input.state.attack'))
                if opened:touch('touchMove',[{**moved,'x':moved['x']+3}]);advance(page,.1)
                check('旧手指在菜单内移动不能重新写入游戏移动',page.evaluate('!kirafanRL.input.state.move.x&&!kirafanRL.input.state.move.y'))
                # Standard DOM button requires releasing the old gesture first.
                clean();page.locator('#menu-resume').tap();advance(page,.1)
                check('继续后没有残余移动',page.evaluate('!kirafanRL.world.frozen&&!kirafanRL.input.state.move.x&&!kirafanRL.input.state.move.y'))
                touch('touchStart',[first]);touch('touchMove',[moved]);advance(page,.1)
                touch('touchCancel',[])
                check('系统取消手势后停止且可以重新操作',page.evaluate('!kirafanRL.input.state.move.x&&!kirafanRL.input.state.move.y'))
                # Rest room isolates an actual interaction from proximity gates.
                page.evaluate("kirafanRL.world.room.type='rest'");advance(page,1/60)
                first=at('.touch-attack',1);second=at('.touch-interact',2)
                touch('touchStart',[first]);advance(page,.1)
                touch('touchStart',[first,second]);touch('touchEnd',[second]);advance(page,1/60)
                check('按住攻击时第二指交互能打开休息选择',page.locator('.rl-decision[open]').count()==1)
                check('交互弹窗打开后旧攻击不残留',page.evaluate('!kirafanRL.input.state.attack&&!kirafanRL.input.state.aimStick.active'))
                touch('touchEnd',[])
                page.screenshot(path=str(OUT/('before.png' if args.baseline else 'after.png')))
                context.close()
                context=browser.new_context(viewport={'width':1280,'height':840});context.add_init_script(INIT)
                page=context.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.goto('http://127.0.0.1:%d/site/game/roguelike.html?seed=10926'%server.server_address[1])
                page.locator('.roster-card[data-card-id="32002001"]').click(timeout=60000)
                page.locator('#roster-start').click();settled(page)
                page.keyboard.down('d');advance(page,1/60);page.locator('.hud-pause').click();advance(page,1/60)
                page.keyboard.down('d');advance(page,1/60)
                check('暂停后按键自动重复不能恢复旧移动',page.evaluate('!kirafanRL.input.state.move.x'))
                page.locator('#menu-resume').click();advance(page,1/60);page.keyboard.down('d');advance(page,1/60)
                check('继续后仍需松开再按才重新移动',page.evaluate('!kirafanRL.input.state.move.x'))
                page.keyboard.up('d');page.keyboard.down('d');advance(page,1/60)
                check('重新按键可以正常移动',page.evaluate('kirafanRL.input.state.move.x===1'))
                page.keyboard.up('d');page.keyboard.down('Escape');advance(page,1/60)
                page.keyboard.down('Escape');advance(page,1/60)
                check('长按Escape不会反复开关菜单',page.locator('#menu-panel').is_visible())
                page.keyboard.up('Escape');advance(page,1/60);page.keyboard.down('Escape');advance(page,1/60);page.keyboard.up('Escape')
                check('第二次独立Escape可以继续游戏',not page.locator('#menu-panel').is_visible())
                context.close();browser.close()
            check('没有未处理浏览器异常',not report['errors'],report['errors'])
        finally:
            server.shutdown();worker.join(timeout=5)
            (OUT/('before.json' if args.baseline else 'after.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    return int(not args.baseline and any(not c['ok'] for c in report['checks']))

if __name__=='__main__':raise SystemExit(main())
