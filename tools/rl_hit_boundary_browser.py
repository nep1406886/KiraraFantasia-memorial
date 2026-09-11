"""Player hit boundaries, moving contacts and real touch input on the game page.

Positions, enemy schedules and low-power shots are controlled fixtures. Movement,
attacks, dodge, menu and rotation use browser input; no damage function is mocked.
"""
import functools
import json
import math
import threading

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss
from rl_hit_alignment_browser import ROOT, OUT, SETUP, RESET, fingerprints


PIXELS = """() => {
    const k=kirafanRL,records=impactRecords.filter(r=>r?.instance&&!r.closed);
    const gl=k.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
    const read=()=>{k.renderOnce();const data=new Uint8Array(w*h*4);
        gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;};
    const centres=records.map(r=>new hitT.Vector3(r.x,1,r.y).project(k.camera));
    const before=read(),visibility=records.map(r=>r.instance.root.visible);
    records.forEach(r=>r.instance.root.visible=false);const after=read();
    let pixels=0,near=0,minX=w,minY=h,maxX=-1,maxY=-1;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
        const i=(y*w+x)*4;
        if(Math.abs(before[i]-after[i])+Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])<=20)continue;
        pixels++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
        if(centres.some(p=>Math.hypot(x-(p.x+1)*w/2,y-(p.y+1)*h/2)<12))near++;
    }
    records.forEach((r,i)=>r.instance.root.visible=visibility[i]);k.renderOnce();
    return {pixels,near,bounds:{minX,minY,maxX,maxY},records:records.length};
}"""


def start_move(page, touch, cdp, dx=1, dy=0):
    if touch:
        box = page.locator('.touch-zone').bounding_box()
        x, y = box['x'] + min(140, box['width'] * .45), box['y'] + box['height'] * .55
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x + 50 * dx, 'y': y + 50 * dy}]})
    else:
        page.keyboard.down('KeyD')


def stop_move(page, touch, cdp):
    if touch:
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    else:
        page.keyboard.up('KeyD')


def reset(page):
    page.evaluate(RESET, {'angle': 0, 'distance': 3})
    page.evaluate('kirafanRL.world.player.iframes=0')


def incoming(page, angle=0, moving=False, gap=0):
    return page.evaluate("""({angle,moving,gap})=>{const k=kirafanRL,w=k.world,p=w.player;
        const dx=Math.cos(angle),dy=Math.sin(angle),radius=.18;
        const x=moving?p.x+1.2:p.x-dx*1.2,y=moving?p.y:p.y-dy*1.2+gap;
        w.danmaku.emit('aimed',{x,y,angle},{count:1,offset:0,side:'enemy',radius,speed:moving?0:12,
            power:1,coef:1,life:2,srcId:w.enemies[0].id});k.step(0);
        return {hp:p.hp,player:{x:p.x,y:p.y,radius:p.radius},bullet:{x,y,radius},
            expected:moving?{x:x-radius,y}:{x:p.x-dx*p.radius,y:p.y-dy*p.radius}};}""",
        {'angle': angle, 'moving': moving, 'gap': gap})


def await_hit(page):
    for _ in range(40):
        advance(page, 1 / 60)
        if page.evaluate('hitEvents.length>0'):
            break
    return page.evaluate('hitEvents')


def inspect_impact(page):
    page.wait_for_function('impactRecords.some(r=>r?.instance)', polling=50, timeout=30000)
    advance(page, .06)
    placements = page.evaluate("""()=>impactRecords.filter(r=>r?.instance).map(r=>({
        x:r.instance.root.position.x,y:r.instance.root.position.z,height:r.instance.root.position.y}))""")
    return {'placements': placements, 'pixels': page.evaluate(PIXELS)}


def same_point(a, b):
    return a is not None and math.hypot(a['x'] - b['x'], a['y'] - b['y']) < 1e-6


def run_case(browser, base, touch, report, check):
    label = '手机横屏' if touch else '桌面'
    context = browser.new_context(viewport={'width': 844, 'height': 390} if touch else {'width': 1280, 'height': 840},
                                  is_mobile=touch, has_touch=touch)
    context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
        localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
    page = context.new_page()
    page.on('pageerror', lambda e: report['errors'].append(str(e)))
    cdp = context.new_cdp_session(page) if touch else None
    try:
        page.goto(base + '/site/game/roguelike.html?volume=1&seed=28121', wait_until='load', timeout=60000)
        hero = page.locator('.roster-card').filter(has=page.locator('img.art[src$="/32002001.webp"]'))
        hero.tap(timeout=60000) if touch else hero.click(timeout=60000)
        page.wait_for_function('kirafanRL?.world?.player&&kirafanRL.pending===0', polling=50, timeout=60000)
        dismiss(page)
        # Return to actual touch chrome after dismiss()'s mouse click helper.
        if touch:
            page.touchscreen.tap(600, 190)
        page.evaluate(SETUP, False)
        page.wait_for_function('kirafanRL.pending===0&&!kirafanRL.roomLoading', polling=50, timeout=60000)
        advance(page, 1)
        for index in range(8):
            reset(page)
            fixture = incoming(page, index * math.pi / 4)
            hits = await_hit(page)
            check(label + ' 八方向受击只结算一次 ' + str(index), len(hits) == 1 and hits[0]['damage'] == 1, hits)
            check(label + ' 首次接触在身体入射侧 ' + str(index), bool(hits) and same_point(hits[0]['impact'], fixture['expected']),
                  {'hits': hits, 'fixture': fixture})
            visual = inspect_impact(page)
            check(label + ' 原作受击火花在接触点显示 ' + str(index), bool(visual['placements'])
                  and all(same_point(p, fixture['expected']) and abs(p['height'] - 1) < 1e-6 for p in visual['placements'])
                  and visual['pixels']['pixels'] > 4 and visual['pixels']['near'] > 0, visual)
            report['incoming'].append({'mode': label, 'direction': index, 'fixture': fixture, 'hits': hits, **visual})
            if index in (0, 2):
                page.screenshot(path=str(OUT / ('touch' if touch else 'desktop') / ('impact-' + str(index) + '.png')))

        reset(page)
        fixture = incoming(page, moving=True)
        start_move(page, touch, cdp)
        hits = await_hit(page)
        stop_move(page, touch, cdp)
        check(label + ' 真实移动穿过慢弹仍被相对扫掠捕获', len(hits) == 1
              and hits[0]['target']['x'] > fixture['player']['x'] and same_point(hits[0]['impact'], fixture['expected']),
              {'fixture': fixture, 'hits': hits})
        visual = inspect_impact(page)
        check(label + ' 移动受击的异步火花不漂移到步末身体中心',
              all(same_point(p, fixture['expected']) for p in visual['placements']) and visual['pixels']['near'] > 0, visual)

        reset(page)
        radius = page.evaluate('kirafanRL.world.player.radius')
        fixture = incoming(page, gap=radius + .18 + .05)
        advance(page, .35)
        check(label + ' 身体边缘外擦过不被放大判定', page.evaluate('hitEvents.length===0&&impactRecords.length===0')
              and page.evaluate('kirafanRL.world.player.hp') == fixture['hp'])

        reset(page)
        start_move(page, touch, cdp)
        advance(page, 1 / 60)
        stop_move(page, touch, cdp)
        fixture = incoming(page)
        if touch:
            page.locator('.touch-dodge').tap()
        else:
            page.keyboard.down('Space')
        advance(page, 1 / 60)
        if not touch:
            page.keyboard.up('Space')
        advance(page, .2)
        dodge = page.evaluate("""()=>{const w=kirafanRL.world,p=w.player;return {hp:p.hp,state:p.sm.state,
            iframes:p.iframes,bullets:w.danmaku.active,hits:hitEvents.length,impacts:impactRecords.length};}""")
        check(label + ' 真实闪避输入保留无敌并穿过弹体，不吞弹或伪造火花', dodge['state'] == 'dodge'
              and dodge['iframes'] > 0 and dodge['hp'] == fixture['hp'] and dodge['bullets'] == 1
              and dodge['hits'] == dodge['impacts'] == 0, dodge)

        reset(page)
        fixture = incoming(page)
        menu = page.locator('.hud-pause')
        menu.tap() if touch else menu.click()
        paused = page.evaluate("""()=>{let b;kirafanRL.world.danmaku.forEach(x=>b={x:x.x,y:x.y,life:x.life});return b;}""")
        advance(page, 1)
        check(label + ' 菜单暂停不移动弹体也不后台受击', page.evaluate("""before=>{const w=kirafanRL.world;
            let b;w.danmaku.forEach(x=>b={x:x.x,y:x.y,life:x.life});return w.frozen&&JSON.stringify(b)===JSON.stringify(before)
                &&hitEvents.length===0&&impactRecords.length===0;}""", paused))
        resume = page.locator('#menu-resume')
        resume.tap() if touch else resume.click()
        check(label + ' 菜单恢复后原有弹体按原路径命中', len(await_hit(page)) == 1)

        if touch:
            reset(page)
            fixture = incoming(page)
            page.set_viewport_size({'width': 390, 'height': 844})
            page.locator('#landscape-guard').wait_for(state='visible')
            advance(page, 1)
            check('手机转竖屏时在飞弹体被冻结且无后台伤害', page.evaluate('kirafanRL.world.frozen&&hitEvents.length===0')
                  and page.evaluate('kirafanRL.world.player.hp') == fixture['hp'])
            page.set_viewport_size({'width': 844, 'height': 390})
            page.locator('#landscape-guard').wait_for(state='hidden')
            check('实际回到横屏后弹体恢复而非丢失或瞬间跨步', len(await_hit(page)) == 1)
            for index in range(8):
                fixture = page.evaluate(RESET, {'angle': index * math.pi / 4, 'distance': 2.4})
                start_move(page, True, cdp, math.cos(index * math.pi / 4), math.sin(index * math.pi / 4))
                advance(page, 1 / 60)
                stop_move(page, True, cdp)
                page.locator('.touch-attack').tap()
                advance(page, 1 / 60)
                facing = page.evaluate('kirafanRL.world.player.facing')
                angle_error = abs(math.atan2(math.sin(facing - index * math.pi / 4), math.cos(facing - index * math.pi / 4)))
                hits = await_hit(page)
                check('手机真实摇杆与普攻短按命中对应方向 ' + str(index), angle_error < .03
                      and any(h['targetId'] == fixture['target']['id'] for h in hits), {'error': angle_error, 'hits': hits})
    except Exception:
        page.screenshot(path=str(OUT / 'boundary-failure.png'))
        raise
    finally:
        context.close()


def main():
    for folder in ('desktop', 'touch'):
        (OUT / folder).mkdir(parents=True, exist_ok=True)
    report = {'complete': False, 'checks': [], 'incoming': [], 'errors': [], 'source_before': fingerprints()}

    def check(label, ok, detail=None):
        report['checks'].append({'label': label, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        if not ok:
            raise AssertionError(label + ': ' + str(detail))

    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            report['browser'] = browser.version
            for touch in (False, True):
                run_case(browser, 'http://127.0.0.1:%d' % server.server_address[1], touch, report, check)
            check('受击与触控场景无未处理页面异常', not report['errors'], report['errors'])
            report['complete'] = True
            browser.close()
    except Exception as error:
        report['failure'] = str(error)
        raise
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()
        report['source_after'] = fingerprints()
        report['changed_during_run'] = [p for p in report['source_before'].keys() | report['source_after'].keys()
                                       if report['source_before'].get(p) != report['source_after'].get(p)]
        (OUT / 'boundary.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
