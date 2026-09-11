"""Real hover/focus and mobile rotation gates. OS lock success uses labelled API fixtures."""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss, press
from rl_ui_polish_browser import fingerprints

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/ui-polish/interaction'
INIT = """window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
    if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',
        JSON.stringify({prologueSeen:true,tutorialSeen:true}));"""


def settled(page, touch=False):
    page.wait_for_function('kirafanRL?.world?.player && kirafanRL.pending===0', polling=50, timeout=60000)
    if touch:
        for _ in range(60):
            if not page.locator('#dialogue-box').is_visible(): break
            page.locator('#dialogue-skip').tap(); page.wait_for_timeout(30)
    else:
        dismiss(page)
    advance(page, 2)
    page.wait_for_function('!!kirafanRL.mapview.group?.userData.placements && kirafanRL.interactPending===0', polling=50, timeout=60000)
    page.wait_for_function('kirafanRL.pending===0&&!kirafanRL.roomLoading&&!kirafanRL.world.frozen', polling=50, timeout=60000)
    advance(page, 1/60)


def lock_lifecycle(browser, base, check, errors):
    # The browser cannot emulate an OS rotation lock. Isolate and label the API
    # fixture; viewport rotation and the real game's freeze are checked below.
    context = browser.new_context(viewport={'width':375,'height':812}, is_mobile=True, has_touch=True)
    context.route('**/__orientation_lifecycle', lambda route: route.fulfill(
        content_type='text/html', body='<meta name="viewport" content="width=device-width,initial-scale=1">'))
    page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '/__orientation_lifecycle')
    page.evaluate("""async()=>{
        const {createLandscapeGuard}=await import('/site/game/rl/ui/orientation.js');
        window.lockCalls={requested:[],unlocked:0,changes:[]};
        document.documentElement.requestFullscreen=async()=>{};
        Object.defineProperty(screen.orientation,'lock',{configurable:true,
            value:async value=>lockCalls.requested.push(value)});
        Object.defineProperty(screen.orientation,'unlock',{configurable:true,
            value:()=>lockCalls.unlocked++});
        window.newGuard=()=>createLandscapeGuard({onChange:value=>lockCalls.changes.push(value)});
        window.guard=newGuard();
    }""")
    result = page.evaluate("""()=>{guard.dispose();guard.dispose();window.dispatchEvent(new Event('resize'));
        return {...lockCalls,panel:!!document.getElementById('landscape-guard'),
            blocked:document.body.classList.contains('landscape-required')};}""")
    check('未取得方向锁的销毁不解锁其他所有者（接口夹具）',
          result['unlocked']==0 and result['changes']==[True,False] and not result['panel'] and not result['blocked'], result)
    page.evaluate('guard=newGuard()')
    page.locator('#landscape-fullscreen').tap()
    page.wait_for_function('!document.getElementById("landscape-fullscreen").disabled', polling=50)
    result = page.evaluate("""()=>{guard.dispose();guard.dispose();return {...lockCalls};}""")
    check('成功取得的方向锁仅释放一次，重复销毁安全（接口夹具）',
          result['requested']==['landscape'] and result['unlocked']==1
          and result['changes']==[True,False,True,False], result)
    page.evaluate("""()=>{Object.defineProperty(screen.orientation,'lock',{configurable:true,
        value:()=>new Promise(resolve=>window.finishLock=resolve)});guard=newGuard();}""")
    page.locator('#landscape-fullscreen').tap()
    page.wait_for_function('typeof window.finishLock==="function"', polling=50)
    page.evaluate('guard.dispose();finishLock()')
    page.wait_for_function('lockCalls.unlocked===2', polling=50)
    result = page.evaluate("""()=>{window.dispatchEvent(new Event('resize'));return {...lockCalls,
        panel:!!document.getElementById('landscape-guard'),blocked:guard.blocked};}""")
    check('异步方向锁在销毁后才成功时立即归还且不复活保护层（接口夹具）',
          result['unlocked']==2 and result['changes']==[True,False,True,False,True,False]
          and not result['panel'] and not result['blocked'], result)
    context.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'source_before': fingerprints()}

    def check(label, ok, detail=None):
        report['checks'].append({'label': label, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        if not ok: raise AssertionError(label + ': ' + str(detail))

    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    url = 'http://127.0.0.1:%d/site/game/roguelike.html?volume=1&seed=10926' % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            desktop = browser.new_context(viewport={'width':1280,'height':840})
            desktop.add_init_script(INIT)
            page = desktop.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.goto(url, wait_until='load', timeout=60000)
            page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]')).click(timeout=60000)
            settled(page)
            page.locator('.hud-skill[data-slot="1"]').hover()
            tip = page.locator('.hud-skill-tooltip')
            tip.wait_for(state='visible')
            expected = page.evaluate("""()=>{const s=kirafanRL.world.player.skills.slots[1];
                return {name:s.name,cooldown:Number(s.cooldown.toFixed(1)),heal:s.heal,buffs:s.buffs};}""")
            content = tip.inner_text()
            check('鼠标悬停显示技能名称、真实目标与基础冷却', expected['name'] in content and '技能 2' in content
                  and ('基础冷却 %s 秒' % expected['cooldown']) in content, content)
            check('悬停有中文效果简述而非只显示技能名', tip.locator('li').count() > 0
                  and any(k in content for k in ['回复','物攻','魔攻','护盾','伤害','恢复']), content)
            check('悬停不施放、不暂停且有可访问说明关联', page.evaluate("""()=>{
                const w=kirafanRL.world,i=kirafanRL.input.state,n=document.querySelector('.hud-skill[data-slot="1"]');
                return !w.frozen&&!i.attack&&!i.skill.some(Boolean)&&!i.ultimate&&!!n.getAttribute('aria-describedby');}"""))
            page.screenshot(path=str(OUT / 'skill-hover.png'))
            tip.hover(); page.wait_for_timeout(200)
            check('指针可移入说明卡阅读而不闪退', tip.is_visible())
            press(page, 'Escape'); advance(page, 1/60)
            check('Escape只收起说明而不打开菜单', not tip.is_visible() and not page.locator('#menu-panel').is_visible())
            page.mouse.move(600,300); page.keyboard.press('Tab')
            page.locator('.hud-skill[data-slot="2"]').focus()
            tip.wait_for(state='visible')
            check('键盘聚焦可查看第二个普通技能', '技能 3' in tip.inner_text())
            page.keyboard.press('Space'); advance(page, 1/60)
            check('查看说明后仍能空格施放且不触发闪避', page.evaluate('kirafanRL.world.player.skills.slots[2].remaining>0&&!kirafanRL.input.state.dodge'))
            press(page, 'Escape'); page.mouse.move(600,300)
            page.locator('.hud-skill[data-slot="2"]').hover(); tip.wait_for(state='visible')
            check('冷却中的按钮仍可悬停查看剩余秒数', '剩余 ' in tip.inner_text(), tip.inner_text())
            page.mouse.move(600,300); page.locator('.hud-gauge').hover(); tip.wait_for(state='visible')
            check('必杀悬停说明同时显示目标、效果和量能', 'R / 1' in tip.inner_text()
                  and '量能 ' in tip.inner_text() and tip.locator('li').count()>0, tip.inner_text())
            page.screenshot(path=str(OUT / 'ultimate-hover.png'))
            page.set_viewport_size({'width':390,'height':844}); advance(page, 1/60)
            check('桌面窄窗口不会误触发手机横屏限制', not page.locator('#landscape-guard').is_visible())
            page.mouse.move(180,250); page.locator('.hud-gauge').hover(); tip.wait_for(state='visible')
            bounds = tip.bounding_box()
            check('窄窗口说明卡不越过屏幕边界', bounds['x']>=0 and bounds['y']>=0
                  and bounds['x']+bounds['width']<=391 and bounds['y']+bounds['height']<=845, bounds)
            page.screenshot(path=str(OUT / 'narrow-desktop-tooltip.png'))
            # A closing overlay can expose a skill under a stationary pointer.
            # Browser-generated boundary events are not a request to read it.
            page.mouse.move(200,250); page.wait_for_timeout(180)
            page.evaluate("""()=>{const n=document.createElement('div');n.id='hover-hit-test-shield';
                n.style.cssText='position:fixed;inset:0;z-index:100000';document.body.appendChild(n);}""")
            anchor=page.locator('.hud-skill[data-slot="1"]').bounding_box()
            page.mouse.move(anchor['x']+anchor['width']/2,anchor['y']+anchor['height']/2)
            page.evaluate("document.getElementById('hover-hit-test-shield').remove()")
            page.wait_for_timeout(180)
            check('覆盖层消失不让静止鼠标自动弹技能卡（命中测试夹具）',not tip.is_visible())
            # Simulation rAF is held: step while Escape is down so the real
            # input edge is sampled, rather than testing an already-released key.
            press(page, 'Escape');advance(page,1/60)
            check('覆盖层消失后的第一次Escape仍可打开菜单',page.locator('#menu-panel').is_visible())
            page.locator('#menu-resume').click();advance(page,1/60)
            page.mouse.move(200,250);page.locator('.hud-skill[data-slot="1"]').hover()
            tip.wait_for(state='visible');press(page, 'Escape');advance(page,1/60)
            page.mouse.move(anchor['x']+anchor['width']/2+2,anchor['y']+anchor['height']/2)
            check('Escape关闭后在同一按钮内轻微移动不会立刻重开',not tip.is_visible())
            desktop.close()

            mobile = browser.new_context(viewport={'width':375,'height':812}, is_mobile=True, has_touch=True)
            mobile.add_init_script(INIT)
            page = mobile.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.goto(url, wait_until='load', timeout=60000)
            page.locator('#landscape-guard').wait_for(state='visible', timeout=60000)
            check('手机竖屏在选角前要求横屏', not page.locator('#roster-overlay').is_visible()
                  and page.evaluate('kirafanRL.world.frozen'))
            page.screenshot(path=str(OUT / 'portrait-required.png'))
            page.locator('#save-status-open').tap(); page.locator('#rl-storage').wait_for(state='visible')
            check('横屏要求不阻挡存档和备份', page.locator('#storage-export').is_visible())
            page.locator('#storage-close').tap()
            check('关闭备份后仍保留横屏保护', page.locator('#landscape-guard').is_visible())
            page.evaluate("""()=>{window.orientationCalls=[];
                document.documentElement.requestFullscreen=async()=>{orientationCalls.push('fullscreen');throw new DOMException('test denial','NotAllowedError');};
            }""")
            page.locator('#landscape-fullscreen').tap()
            page.wait_for_function("!document.getElementById('landscape-fullscreen').disabled", polling=50)
            check('全屏被拒绝时仍暂停且明确手动旋转（故障注入）',
                  page.evaluate("orientationCalls[0]==='fullscreen'&&kirafanRL.world.frozen")
                  and '请开启设备的自动旋转' in page.locator('.landscape-status').inner_text())
            page.evaluate("""()=>{
                document.documentElement.requestFullscreen=async()=>{orientationCalls.push('fullscreen-ok');};
                Object.defineProperty(screen.orientation,'lock',{configurable:true,value:async value=>orientationCalls.push(value)});
                Object.defineProperty(screen.orientation,'unlock',{configurable:true,value:()=>{}});
            }""")
            page.locator('#landscape-fullscreen').tap()
            page.wait_for_function("!document.getElementById('landscape-fullscreen').disabled", polling=50)
            check('方向锁成功回调不能代替实际横屏（接口夹具）',
                  page.evaluate("orientationCalls.includes('landscape')&&kirafanRL.world.frozen") and page.locator('#landscape-guard').is_visible())
            page.set_viewport_size({'width':812,'height':375})
            page.locator('#landscape-guard').wait_for(state='hidden')
            page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]')).tap(timeout=60000)
            settled(page, touch=True)
            check('旋转后才可正常选角和游玩', page.evaluate('!!kirafanRL.world.player&&!kirafanRL.world.frozen'))
            page.mouse.move(140,220)
            page.touchscreen.tap(600,200);page.wait_for_timeout(180)
            check('触控层出现在静止鼠标下方时不误切回键鼠',
                  page.evaluate('document.body.classList.contains("touch-on")')
                  and page.locator('.touch-attack').is_visible())
            page.screenshot(path=str(OUT / 'mobile-landscape.png'))
            cdp = mobile.new_cdp_session(page)
            start_x = page.evaluate('kirafanRL.world.player.x')
            cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':140,'y':220}]})
            cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':200,'y':220}]})
            advance(page,.15)
            movement = page.evaluate("""()=>({x:kirafanRL.world.player.x,move:kirafanRL.input.state.move,
                frozen:kirafanRL.world.frozen,touch:document.body.classList.contains('touch-on'),
                target:document.elementFromPoint(140,220)?.className})""")
            check('转屏前真实触控摇杆可移动', movement['x']>start_x, movement)
            page.set_viewport_size({'width':375,'height':812})
            page.locator('#landscape-guard').wait_for(state='visible')
            state = page.evaluate("""()=>{const w=kirafanRL.world,p=w.player,i=kirafanRL.input.state;
                return {x:p.x,y:p.y,hp:p.hp,gauge:p.skills.gauge,frozen:w.frozen,move:i.move,attack:i.attack,skill:i.skill};}""")
            check('竖屏即时冻结并清除未松开的输入', state['frozen'] and state['move']=={'x':0,'y':0}
                  and not state['attack'] and not any(state['skill']), state)
            cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
            page.keyboard.down('KeyJ'); advance(page,2); page.keyboard.up('KeyJ')
            after = page.evaluate("""()=>{const w=kirafanRL.world,p=w.player;return {x:p.x,y:p.y,hp:p.hp,gauge:p.skills.gauge};}""")
            check('竖屏等待和误按不会暗中战斗或移动', after=={k:state[k] for k in after}, after)
            page.set_viewport_size({'width':812,'height':375}); page.locator('#landscape-guard').wait_for(state='hidden')
            advance(page,1/60)
            check('回到横屏不残留移动或攻击', page.evaluate("""s=>{const w=kirafanRL.world,p=w.player,i=kirafanRL.input.state;
                return !w.frozen&&p.x===s.x&&p.y===s.y&&!i.attack&&!i.move.x&&!i.move.y; }""", state))
            page.locator('.hud-pause').tap(); advance(page,1/60)
            page.set_viewport_size({'width':375,'height':812}); page.locator('#landscape-guard').wait_for(state='visible')
            page.set_viewport_size({'width':812,'height':375}); page.locator('#landscape-guard').wait_for(state='hidden')
            check('转回横屏不会解除原有菜单暂停', page.locator('#menu-panel').is_visible() and page.evaluate('kirafanRL.world.frozen'))
            page.screenshot(path=str(OUT / 'landscape-menu.png'))
            page.locator('#menu-resume').tap(); advance(page,1/60)
            page.locator('.hud-skill[data-slot="1"]').tap(); advance(page,1/60)
            check('横屏触控技能仍即时响应且不弹出悬停卡', page.evaluate('kirafanRL.world.player.skills.slots[1].remaining>0')
                  and not page.locator('.hud-skill-tooltip').is_visible())
            page.mouse.move(600,200); page.locator('.hud-skill[data-slot="1"]').hover()
            page.locator('.hud-skill-tooltip').wait_for(state='visible')
            check('触屏设备接鼠标后只悬停就可查看说明，不需先点击',
                  page.evaluate('!document.body.classList.contains("touch-on")&&!kirafanRL.input.state.skill.some(Boolean)'))
            page.locator('.hud-pause').tap(); advance(page,1/60)
            check('混合指针回到触控时收起说明并保留正常菜单操作',
                  page.evaluate('document.body.classList.contains("touch-on")&&kirafanRL.world.frozen')
                  and not page.locator('.hud-skill-tooltip').is_visible() and page.locator('#menu-panel').is_visible())
            page.locator('#menu-resume').tap(); advance(page,1/60)

            # Only replenish the meter as a fixture; trigger the real scene via
            # the actual touch button and observe its own timeline and owner.
            advance(page,.8)  # Let the preceding skill's real recovery finish.
            check('必杀输入前角色已经结束普通技能动作', page.evaluate('kirafanRL.world.player.sm.state==="idle"'))
            page.evaluate('kirafanRL.world.player.skills.addGauge(kirafanRL.world.player.skills.gaugeMax)')
            advance(page,1/60); page.locator('.hud-gauge').tap(); advance(page,1/60)
            page.wait_for_function('!!kirafanRL.ultimate.stage&&!kirafanRL.ultimate.loading', polling=50, timeout=60000)
            advance(page,.3)
            cinematic = page.evaluate("""()=>{const k=kirafanRL,p=k.world.player;window.rotationScene=k.ultimate.stage;
                return {frame:k.ultimate.stage.frame,hp:p.hp,gauge:p.skills.gauge,x:p.x,y:p.y};}""")
            page.set_viewport_size({'width':375,'height':812}); page.locator('#landscape-guard').wait_for(state='visible')
            check('必杀演出在竖屏保护出现时立即暂停，不等下一逻辑帧',
                  page.evaluate('kirafanRL.ultimate.stage===rotationScene&&!rotationScene.player.playing'))
            press(page, 'Escape'); advance(page,2)
            stopped = page.evaluate("""()=>{const k=kirafanRL,p=k.world.player;return {frame:k.ultimate.stage?.frame,
                hp:p.hp,gauge:p.skills.gauge,x:p.x,y:p.y};}""")
            check('竖屏等待不推进必杀时间线、重复结算或误跳过', stopped==cinematic, stopped)
            page.set_viewport_size({'width':812,'height':375}); page.locator('#landscape-guard').wait_for(state='hidden')
            advance(page,.2)
            check('横屏从同一必杀帧继续，量能不重复扣除', page.evaluate("""s=>kirafanRL.ultimate.stage===rotationScene
                &&rotationScene.frame>s.frame&&rotationScene.player.playing&&kirafanRL.world.player.skills.gauge===s.gauge""", cinematic))
            page.locator('.rl-ultimate-skip').tap(); advance(page,1/60)

            advance(page,.8)  # The cinematic freeze also paused the world's cast recovery.
            check('再次必杀前已经退出演出且施放动作结束',
                  page.evaluate('!kirafanRL.ultimate.stage&&!kirafanRL.world.frozen&&kirafanRL.world.player.sm.state==="idle"'))
            held = []
            page.route('**/site/asset/uniqueskill/scene/*.glb.gz', lambda route: held.append(route))
            page.evaluate('kirafanRL.world.player.skills.addGauge(kirafanRL.world.player.skills.gaugeMax)')
            advance(page,1/60); page.locator('.hud-gauge').tap(); advance(page,1/60)
            for _ in range(200):
                if held: break
                page.wait_for_timeout(50)
            pending = page.evaluate("""()=>({loading:kirafanRL.ultimate.loading,stage:!!kirafanRL.ultimate.stage,
                state:kirafanRL.world.player.sm.state,input:kirafanRL.input.state.ultimate,
                gauge:kirafanRL.world.player.skills.gauge,frozen:kirafanRL.world.frozen})""")
            check('必杀资源延迟夹具确实处于加载中', bool(held) and pending['loading'] and not pending['stage'], pending)
            page.set_viewport_size({'width':375,'height':812}); page.locator('#landscape-guard').wait_for(state='visible')
            for route in held: route.continue_()
            page.unroute('**/site/asset/uniqueskill/scene/*.glb.gz')
            page.wait_for_function('!!kirafanRL.ultimate.stage&&!kirafanRL.ultimate.loading', polling=50, timeout=60000)
            check('竖屏期间迟到的必杀资源保持首帧暂停，不自动播放',
                  page.evaluate('kirafanRL.ultimate.stage.frame===0&&!kirafanRL.ultimate.stage.player.playing&&kirafanRL.world.frozen'))
            page.set_viewport_size({'width':812,'height':375}); page.locator('#landscape-guard').wait_for(state='hidden')
            advance(page,.1)
            check('迟到演出只在实际横屏后开始', page.evaluate('kirafanRL.ultimate.stage.frame>0&&kirafanRL.ultimate.stage.player.playing'))
            page.locator('.rl-ultimate-skip').tap(); advance(page,1/60)
            mobile.close()
            lock_lifecycle(browser, url.split('/game/')[0], check, report['errors'])
            browser.close()
        check('全部交互无未处理异常', not report['errors'], report['errors'])
    finally:
        report['source_after'] = fingerprints()
        report['changed_during_run'] = [f for f in report['source_before'] if report['source_before'][f] != report['source_after'][f]]
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
        server.shutdown(); worker.join(timeout=5); server.server_close()


if __name__ == '__main__': main()
