"""Real touch pointers for continuous aim; fixed-step fixtures are not FPS evidence.

Room placement, health and enemy schedules are controlled. Attacks, movement,
multi-touch, menu and rotation use the page's real input path. --probe serves a
projector without the new right stick and must fail the same directional check.
"""
import argparse
import functools
import json
import math
import threading

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss
from rl_hit_alignment_browser import ROOT, SETUP, RESET, fingerprints

OUT = ROOT / '.codex-tmp' / 'continuous-aim'
CARDS = [14002001, 11012001, 23002001, 32002001, 32172001]


class Touches:
    def __init__(self, page):
        self.page = page
        self.cdp = page.context.new_cdp_session(page)
        self.points = {}

    def send(self, kind):
        self.cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': list(self.points.values())})

    def down(self, ident, x, y):
        self.points[ident] = {'id': ident, 'x': x, 'y': y, 'radiusX': 1, 'radiusY': 1, 'force': 1}
        self.send('touchStart')

    def move(self, ident, x, y):
        # Deliver a natural short drag rather than a zero-duration CDP swipe.
        # Simulation is paused separately, so this still tests a full gesture
        # completed before a single fixed-step input sample.
        old = dict(self.points[ident])
        for step in range(1, 5):
            self.page.wait_for_timeout(16)
            self.points[ident].update(x=old['x'] + (x-old['x'])*step/4,
                                      y=old['y'] + (y-old['y'])*step/4)
            self.send('touchMove')

    def up(self, ident):
        self.page.wait_for_timeout(16)
        ended = self.points.pop(ident)
        # CDP touchEnd identifies the contacts being released, unlike the
        # active-contact lists used by start/move. [] releases every contact.
        self.cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd',
                      'touchPoints': [ended] if self.points else []})

    def clear(self, cancel=False):
        if not self.points:
            return
        if not cancel:
            self.page.wait_for_timeout(16)
        self.points.clear()
        self.send('touchCancel' if cancel else 'touchEnd')

    def tap(self, selector, ident=9):
        if not self.points:
            self.page.locator(selector).tap()
            return
        self.page.locator(selector).scroll_into_view_if_needed()
        x, y = centre(self.page, selector)
        assert self.page.locator(selector).evaluate(
            '(node,p)=>node.contains(document.elementFromPoint(p.x,p.y))', {'x': x, 'y': y}), 'tap is covered: ' + selector
        self.down(ident, x, y)
        self.page.wait_for_timeout(40)
        self.up(ident)


def centre(page, selector):
    box = page.locator(selector).bounding_box()
    assert box, 'missing visible control: ' + selector
    return box['x'] + box['width'] / 2, box['y'] + box['height'] / 2


SNAPSHOT = """() => {
    const k=kirafanRL,p=k.world.player,a=k.input.state.aimStick,raw=window.aimRaw;
    const rect=k.renderer.domElement.getBoundingClientRect();
    const v=new hitT.Vector3(p.x,1,p.y).project(k.camera);
    const f=new hitT.Vector3(p.x+Math.cos(p.facing),1,p.y+Math.sin(p.facing)).project(k.camera).sub(v);
    const length=Math.hypot(f.x*rect.width,f.y*rect.height);
    const drawn={x:f.x*rect.width/length,y:-f.y*rect.height/length};
    const dx=raw?raw.x-raw.startX:0,dy=raw?raw.y-raw.startY:0,n=Math.hypot(dx,dy);
    return {position:{x:p.x,y:p.y},facing:p.facing,state:p.sm.state,swing:p.swingId,
        activeWindow:!!p.swingHits,aim:{...a},attack:k.input.state.attack,move:{...k.input.state.move},
        projected:drawn,raw,dot:n?(drawn.x*dx+drawn.y*dy)/n:null,
        touches:document.body.classList.contains('touch-on'),frozen:k.world.frozen};
}"""


def fixture(page, angle=0.413):
    result = page.evaluate(RESET, {'angle': angle, 'distance': 2.4})
    page.evaluate('kirafanRL.world.player.facing=2.95')
    return result


def endpoint(page, angle, origin, length=38):
    # The test chooses a WORLD angle, then projects it independently to screen.
    # Assertions compare the resulting facing to actual delivered client pixels,
    # not to a rounded eight-way expectation or a loose world-unit tolerance.
    direction = page.evaluate("""angle=>{const k=kirafanRL,p=k.world.player,r=k.renderer.domElement.getBoundingClientRect();
        const a=new hitT.Vector3(p.x,1,p.y).project(k.camera),
            b=new hitT.Vector3(p.x+Math.cos(angle),1,p.y+Math.sin(angle)).project(k.camera).sub(a);
        const x=b.x*r.width,y=-b.y*r.height,n=Math.hypot(x,y);return {x:x/n,y:y/n};}""", angle)
    return origin[0] + length * direction['x'], origin[1] + length * direction['y']


def hold_aim(page, touch, angle, tick_before_drag=False, length=38):
    origin = centre(page, '.touch-attack')
    touch.down(1, *origin)
    if tick_before_drag:
        advance(page, 1 / 60)
    touch.move(1, *endpoint(page, angle, origin, length))
    return origin


def clear_state(page):
    return page.evaluate("""()=>{const i=kirafanRL.input.state;return !i.attack&&!i.aimStick.active
        &&i.aimStick.x===0&&i.aimStick.y===0&&!document.querySelector('.touch-attack').classList.contains('aiming');}""")


def skill_directions(page, touch, card, directions, report, check):
    slots = page.evaluate("""()=>kirafanRL.world.player.skills.slots.map((s,index)=>s&&({index,
        id:s.id,delivery:s.delivery,damage:s.damage,ultimate:!!s.ultimate})).filter(s=>s&&!s.ultimate)""")
    page.evaluate("""()=>{window.aimSkillEvents=[];const w=kirafanRL.world,drain=w.drainEvents;
        w.drainEvents=function(){const events=drain.call(this);for(const e of events){
            if(e.type==='skill'||e.type==='playerShot'&&!e.normal)aimSkillEvents.push({type:e.type,
                slot:e.slot,skillId:e.skill?.id,pattern:e.pattern,bullets:e.bullets});}return events;};}""")

    def prepare(angle):
        arranged = fixture(page, angle)
        page.evaluate("""()=>{const k=kirafanRL,p=k.world.player;p.heldSkill.fill(false);
            for(const s of p.skills.slots)if(s)s.remaining=0;p.skillCards=[];
            k.step(0);aimSkillEvents.length=0;}""")
        return arranged

    def snapshot():
        row = page.evaluate(SNAPSHOT)
        row.update(page.evaluate("""()=>{const k=kirafanRL,p=k.world.player,shots=[];
            k.world.danmaku.forEach(b=>{if(b.side==='player')shots.push({skillId:b.skillId,
                angle:Math.atan2(b.vy,b.vx),pattern:b.pattern});});
            return {castOnly:p.castOnly,castSlot:p.castSlot,events:aimSkillEvents,shots};}"""))
        return row

    for slot in slots:
        for index in range(directions if slot['delivery'] == 'aimed' else 1):
            angle = index * math.tau / directions + .317
            arranged = prepare(angle)
            hold_aim(page, touch, angle)
            touch.tap('.hud-skill[data-slot="%d"]' % slot['index'])
            advance(page, 1 / 60)
            row = snapshot()
            label = '%d 技能%d 方向%d' % (card, slot['index'] + 1, index)
            casts = [event for event in row['events'] if event['type'] == 'skill']
            check('双指短按技能仅施放对应真实槽位 ' + label, row['castOnly']
                  and row['castSlot'] == slot['index'] and len(casts) == 1
                  and casts[0]['skillId'] == slot['id'] and row['position'] == arranged['player'], row)
            if slot['delivery'] == 'aimed':
                check('定向技能保留右杆连续方向 ' + label, row['dot'] > 1 - 1e-10, row)
            else:
                check('自身或周身技能不被强制定向 ' + label, row['facing'] == 2.95, row)
            shots = row['shots']
            if slot['damage']:
                if slot['delivery'] == 'aimed':
                    check('定向技能弹体速度与任意角度一致 ' + label, bool(shots)
                          and all(s['skillId'] == slot['id'] and abs(math.atan2(math.sin(s['angle'] - row['facing']),
                                  math.cos(s['angle'] - row['facing']))) < 1e-10 for s in shots), shots)
                else:
                    vectors = [(math.cos(s['angle']), math.sin(s['angle'])) for s in shots]
                    check('全体技能仍保留原周身弹幕而非单方向 ' + label, len(shots) == 12
                          and math.hypot(sum(v[0] for v in vectors), sum(v[1] for v in vectors)) < 1e-10, shots)
            else:
                check('非伤害技能不凭空生成攻击弹体 ' + label, not shots, shots)
            touch.clear()
            advance(page, .7)
            if slot['damage'] and slot['delivery'] == 'aimed':
                check('真实手机定向技能命中所瞄准的敌人 ' + label,
                      any(hit['targetId'] == arranged['target']['id'] for hit in page.evaluate('hitEvents')))
            check('技能施放后输入不残留或追加普攻 ' + label, clear_state(page)
                  and page.evaluate('kirafanRL.world.player.swingId') == row['swing'])
            row.update(card=card, slot=slot, direction=index)
            report['skills'].append(row)

        if slot['delivery'] == 'aimed':
            # Real recovery buffer: choose a new bearing after the basic hit
            # window, then tap the skill while the attack finger is still held.
            prepare(2.173)
            origin = hold_aim(page, touch, 2.173 - math.pi)
            advance(page, .3)
            touch.move(1, *endpoint(page, 2.173, origin))
            touch.tap('.hud-skill[data-slot="%d"]' % slot['index'])
            advance(page, .14)
            row = snapshot()
            check('普攻恢复期缓冲技能使用新的右杆方向 %d 技能%d' % (card, slot['index'] + 1),
                  row['castOnly'] and row['castSlot'] == slot['index'] and row['dot'] > 1 - 1e-10
                  and len([e for e in row['events'] if e['type'] == 'skill']) == 1, row)
            touch.clear()
            advance(page, .7)


def edge_cases(page, touch, report, check):
    fixture(page)
    # No simulation tick between touch down/move/up: both the attack and its
    # final direction must survive until one and the same fixed step sees them.
    hold_aim(page, touch, 0.413)
    touch.clear()
    before = page.evaluate(SNAPSHOT)
    advance(page, 1 / 60)
    after = page.evaluate(SNAPSHOT)
    check('一次逻辑步采样前的完整拖放保留攻击及连续角度', before['attack'] and before['aim']['active']
          and after['state'] == 'attack' and after['dot'] > 1 - 1e-10
          and clear_state(page), {'before': before, 'after': after})
    advance(page, .6)
    check('短拖放只触发一次，不残留连击', page.evaluate('kirafanRL.world.player.swingId') == after['swing'])

    fixture(page)
    origin = hold_aim(page, touch, -1.173, True)
    advance(page, 8 / 60)
    first = page.evaluate(SNAPSHOT)
    touch.move(1, *endpoint(page, 2.413, origin))
    advance(page, 1 / 60)
    locked = page.evaluate(SNAPSHOT)
    check('已打开伤害窗口的攻击不随拖动扫向另一侧', first['activeWindow']
          and locked['swing'] == first['swing'] and locked['facing'] == first['facing'], [first, locked])
    for _ in range(50):
        advance(page, 1 / 60)
        if page.evaluate('kirafanRL.world.player.swingId') != first['swing']:
            break
    next_swing = page.evaluate(SNAPSHOT)
    check('按住连击的下一击使用新方向', next_swing['swing'] == first['swing'] + 1
          and next_swing['dot'] > 1 - 1e-10, next_swing)
    touch.clear()
    advance(page, .6)
    check('松开攻击后连击停止且指针释放', clear_state(page)
          and page.evaluate('kirafanRL.world.player.swingId') == next_swing['swing'])

    fixture(page)
    origin = hold_aim(page, touch, math.pi + .143, length=130)
    advance(page, 1 / 60)
    row = page.evaluate(SNAPSHOT)
    check('手指拖出按钮后仍捕获同一指针并持续瞄准', row['attack'] and row['aim']['active']
          and row['dot'] > 1 - 1e-10, row)
    # A second finger starting on the same button cannot become the aim owner.
    original_aim = row['aim']
    second = centre(page, '.touch-attack')
    touch.down(2, second[0] - 12, second[1] + 10)
    touch.move(2, second[0] - 12, second[1] - 30)
    check('第二根攻击手指不能劫持瞄准', page.evaluate('({...kirafanRL.input.state.aimStick})') == original_aim)
    touch.up(2)
    check('释放非所有者手指不能中断攻击', page.evaluate('kirafanRL.input.state.attack&&kirafanRL.input.state.aimStick.active'))
    touch.clear(cancel=True)
    advance(page, .6)
    check('浏览器触控取消清除攻击、角度和指示环', clear_state(page))

    fixture(page)
    zone = page.locator('.touch-zone').bounding_box()
    left = (zone['x'] + min(110, zone['width'] * .35), zone['y'] + zone['height'] * .6)
    touch.down(2, *left)
    touch.move(2, left[0] + 50, left[1])
    start = page.evaluate('({x:kirafanRL.world.player.x,y:kirafanRL.world.player.y})')
    advance(page, 2 / 60)
    moved = page.evaluate('({x:kirafanRL.world.player.x,y:kirafanRL.world.player.y})')
    origin = hold_aim(page, touch, 2.173, True)
    advance(page, 1 / 60)
    row = page.evaluate(SNAPSHOT)
    check('双指时左杆移动与右杆任意角度攻击互不劫持', moved['x'] > start['x']
          and row['move']['x'] > 0 and abs(row['move']['y']) < 1e-8
          and row['dot'] > 1 - 1e-10, row)
    touch.up(1)
    advance(page, .65)
    row2 = page.evaluate(SNAPSHOT)
    check('右指释放后左杆继续有效且攻击不粘连', not row2['attack'] and not row2['aim']['active']
          and row2['move']['x'] > 0 and row2['position']['x'] > row['position']['x'], row2)
    touch.clear()
    advance(page, 1 / 60)
    check('最后一指释放后移动回零', page.evaluate('kirafanRL.input.state.move.x===0&&kirafanRL.input.state.move.y===0'))

    fixture(page)
    origin = hold_aim(page, touch, 2.13)
    advance(page, 1 / 60)
    page.evaluate("""()=>{const b=document.querySelector('.touch-attack');b.releasePointerCapture(aimRaw.id);}""")
    touch.move(1, origin[0] - 40, origin[1] - 20)
    advance(page, 1 / 60)
    check('丢失指针捕获后取消旧指针，不能继续隐形攻击', clear_state(page))
    touch.clear()

    fixture(page)
    hold_aim(page, touch, .67)
    advance(page, 1 / 60)
    page.evaluate("window.dispatchEvent(new Event('blur'))")
    check('失焦事件清空触控所有权和锁存输入', clear_state(page))
    touch.clear()

    fixture(page)
    hold_aim(page, touch, .53)
    advance(page, 1 / 60)
    menu = centre(page, '.hud-pause')
    touch.down(9, *menu)
    touch.move(9, menu[0] - 100, menu[1] + 80)
    touch.up(9)
    advance(page, 1 / 60)
    check('第二指拖出菜单后释放不误暂停', not page.evaluate('kirafanRL.world.frozen')
          and page.evaluate('kirafanRL.input.state.attack'))
    touch.down(9, *menu)
    touch.clear(cancel=True)
    advance(page, 1 / 60)
    check('第二指菜单手势被取消不打开菜单或残留攻击', not page.evaluate('kirafanRL.world.frozen') and clear_state(page))

    fixture(page)
    hold_aim(page, touch, .63)
    advance(page, 1 / 60)
    touch.down(9, *menu)
    touch.move(9, menu[0] + 1, menu[1])
    page.evaluate("""()=>{const b=document.querySelector('.hud-pause'),event=aimEventTrace.findLast(
        e=>e.type==='pointerdown'&&String(e.target).includes('hud-pause'));b.releasePointerCapture(event.id);}""")
    touch.move(9, menu[0] + 2, menu[1])
    touch.up(9)
    check('菜单丢失指针捕获后释放不误暂停', not page.evaluate('kirafanRL.world.frozen'))
    touch.tap('.hud-pause')
    advance(page, 1 / 60)
    check('取消旧菜单指针后新的次指仍可打开菜单', page.evaluate('kirafanRL.world.frozen') and clear_state(page))
    page.evaluate("document.querySelector('.hud-pause').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}))")
    check('兼容补发的click不会把次指打开的菜单再关闭', page.evaluate('kirafanRL.world.frozen'))
    touch.clear()
    touch.tap('#menu-resume')
    advance(page, .6)

    fixture(page)
    hold_aim(page, touch, .73)
    advance(page, 1 / 60)
    touch.tap('.hud-pause')
    advance(page, 1 / 60)
    paused = page.evaluate(SNAPSHOT)
    check('第二指开菜单立即冻结并清除攻击指针', paused['frozen'] and clear_state(page), paused)
    touch.clear()
    touch.tap('#menu-resume')
    advance(page, .8)
    check('菜单恢复不重放旧连击', not page.evaluate('kirafanRL.world.frozen') and clear_state(page)
          and page.evaluate('kirafanRL.world.player.swingId') == paused['swing'])

    for key in ['Enter', 'Space']:
        page.locator('.hud-pause').focus()
        page.keyboard.press(key)
        advance(page, 1 / 60)
        check('菜单原生键盘激活仅切换一次且不触发战斗 ' + key, page.evaluate('kirafanRL.world.frozen')
              and clear_state(page) and not page.evaluate('kirafanRL.input.state.dodge'))
        touch.tap('#menu-resume')
        advance(page, .6)

    fixture(page)
    hold_aim(page, touch, -2.17)
    advance(page, 1 / 60)
    old_swing = page.evaluate('kirafanRL.world.player.swingId')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.locator('#landscape-guard').wait_for(state='visible')
    advance(page, .7)
    check('转竖屏立即暂停并取消正在拖动的攻击', page.evaluate('kirafanRL.world.frozen') and clear_state(page))
    touch.clear()
    page.screenshot(path=str(OUT / 'portrait-guard.png'))
    page.set_viewport_size({'width': 844, 'height': 390})
    page.locator('#landscape-guard').wait_for(state='hidden')
    advance(page, .8)
    check('横屏恢复无旧指针、无额外连击', not page.evaluate('kirafanRL.world.frozen') and clear_state(page)
          and page.evaluate('kirafanRL.world.player.swingId') == old_swing)

    fixture(page)
    hold_aim(page, touch, 1.27)
    advance(page, 1 / 60)
    page.keyboard.down('KeyD')
    advance(page, 1 / 60)
    row = page.evaluate(SNAPSHOT)
    check('切换键盘输入清理触控所有权而不留下攻击', not row['touches'] and clear_state(page), row)
    page.keyboard.up('KeyD')
    touch.clear()
    # A real new touch, not a direct HUD mode setter, restores touch chrome.
    touch.down(8, 600, 190)
    touch.up(8)
    advance(page, .5)

    fixture(page)
    hold_aim(page, touch, 1.73)
    advance(page, 1 / 60)
    page.evaluate("""()=>{const k=kirafanRL;k.world.enterRoom(k.world.room.id);k.step(0);}""")
    check('重新装配房间时立即清理攻击指针', clear_state(page))
    touch.clear()
    page.wait_for_function('kirafanRL.pending===0&&!kirafanRL.roomLoading&&!kirafanRL.world.frozen', polling=50, timeout=60000)
    advance(page, .5)
    check('装配恢复后无隐藏攻击', clear_state(page))

    # Re-entering a visited room legitimately removed the old enemy array.
    # This last boundary needs a live player/gesture, not a combat target.
    hold_aim(page, touch, 2.53)
    advance(page, 1 / 60)
    page.evaluate("""()=>{const k=kirafanRL,p=k.world.player;p.dead=true;p.sm.force('dead');k.step(0);}""")
    check('死亡状态清理攻击指针和方向环', clear_state(page))
    touch.clear()
    report['edges_complete'] = True


def controller_lifecycle(page, touch, report, check):
    page.evaluate("""async()=>{const {createAttackAim}=await import('/site/game/rl/ui/attackaim.js');
        const button=document.createElement('button');button.id='aim-controller-test';button.textContent='input fixture';
        button.style.cssText='position:fixed;left:400px;top:160px;width:120px;height:80px;z-index:99999;touch-action:none';
        document.body.append(button);window.aimUnit={state:{aimStick:{x:0,y:0,active:false},pointer:{active:false}},
            attack:false,presses:0};window.aimController=createAttackAim(button,aimUnit,{
            press(){aimUnit.attack=true;aimUnit.presses++;},lift(){aimUnit.attack=false;},cancel(){aimUnit.attack=false;}});}""")
    page.locator('#aim-controller-test').focus()
    page.keyboard.down('Enter')
    check('独立攻击控制器保留Enter按下语义', page.evaluate('aimUnit.attack&&aimUnit.presses===1'))
    page.keyboard.up('Enter')
    check('独立攻击控制器保留Enter释放语义', page.evaluate('!aimUnit.attack'))
    origin = centre(page, '#aim-controller-test')
    touch.down(7, *origin)
    touch.move(7, origin[0] - 50, origin[1] - 20)
    check('独立控制器销毁前确有活动捕获和瞄准', page.evaluate('aimUnit.attack&&aimUnit.state.aimStick.active'))
    page.evaluate('aimController.dispose()')
    check('销毁立即取消输入并移除方向标记', page.evaluate("""!aimUnit.attack&&!aimUnit.state.aimStick.active
        &&aimUnit.state.aimStick.x===0&&aimUnit.state.aimStick.y===0
        &&document.querySelector('#aim-controller-test').children.length===0"""))
    touch.clear()
    touch.down(7, *origin)
    touch.move(7, origin[0] + 40, origin[1] + 15)
    touch.clear()
    check('销毁后再次真实触摸不再触发旧监听', page.evaluate('aimUnit.presses===2&&!aimUnit.attack&&!aimUnit.state.aimStick.active'))
    page.evaluate("document.querySelector('#aim-controller-test').remove()")
    report['controller_complete'] = True


def run_case(browser, base, card, directions, probe, report, check):
    context = browser.new_context(viewport={'width': 844, 'height': 390}, is_mobile=True, has_touch=True)
    context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
        localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
    page = context.new_page()
    page.on('pageerror', lambda e: report['errors'].append(str(e)))
    touch = Touches(page)
    if probe:
        source = (ROOT / 'site/game/rl/main.js').read_text(encoding='utf8')
        needle = 'const stick = input.state.aimStick;'
        assert source.count(needle) == 1
        def replace_projector(route):
            report['probe_requests'].append(route.request.url)
            route.fulfill(content_type='text/javascript', body=source.replace(needle, 'const stick = {active:false};'))
        # The page uses a version query. An exact *.js route silently missed it.
        page.route('**/rl/main.js*', replace_projector)
    try:
        page.goto(base + '/site/game/roguelike.html?volume=1&seed=28121', wait_until='load', timeout=60000)
        if probe:
            check('负对照确实替换了唯一入口模块', len(report['probe_requests']) == 1, report['probe_requests'])
        page.locator('.roster-card').filter(has=page.locator('img.art[src$="/%d.webp"]' % card)).tap(timeout=60000)
        page.wait_for_function('kirafanRL?.world?.player&&kirafanRL.pending===0', polling=50, timeout=60000)
        dismiss(page)
        page.touchscreen.tap(600, 190)
        page.evaluate(SETUP, False)
        page.wait_for_function('kirafanRL.pending===0&&!kirafanRL.roomLoading&&!kirafanRL.world.frozen', polling=50, timeout=60000)
        advance(page, .8)
        page.evaluate("""()=>{window.aimRaw=null;window.aimEventTrace=[];
            for(const type of ['pointerdown','pointerup','pointercancel','lostpointercapture','click'])
                window.addEventListener(type,e=>{aimEventTrace.push({type,target:e.target.className,
                    id:e.pointerId,primary:e.isPrimary,x:e.clientX,y:e.clientY,time:e.timeStamp});
                    if(aimEventTrace.length>80)aimEventTrace.shift();},true);
            window.addEventListener('pointerdown',e=>{if(e.target.closest?.('.touch-attack')&&!aimRaw?.down)
                aimRaw={id:e.pointerId,startX:e.clientX,startY:e.clientY,x:e.clientX,y:e.clientY,down:true};});
            window.addEventListener('pointermove',e=>{if(e.pointerId===aimRaw?.id){aimRaw.x=e.clientX;aimRaw.y=e.clientY;}});
            for(const type of ['pointerup','pointercancel'])window.addEventListener(type,e=>{if(e.pointerId===aimRaw?.id)aimRaw.down=false;});
        }""")
        heights = [5.5, 9, 13] if card == CARDS[0] else [9]
        for height in heights:
            touch.tap('.hud-pause')
            page.locator('#menu-cam').fill(str(int(height * 10)))
            touch.tap('#menu-resume')
            for index in range(directions):
                angle = index * math.tau / directions + .137
                arranged = fixture(page, angle)
                hold_aim(page, touch, angle, tick_before_drag=True)
                advance(page, 1 / 60)
                row = page.evaluate(SNAPSHOT)
                row.update(card=card, height=height, direction=index, requested=angle)
                check('手机站定连续瞄准且投影与真实拖动同向 %d %.1f %d' % (card, height, index),
                      row['aim']['active'] and row['attack'] and row['dot'] > 1 - 1e-10
                      and row['position'] == arranged['player'], row)
                if height == 9 and index in (1, directions // 2):
                    page.screenshot(path=str(OUT / ('touch-%d-%d.png' % (card, index))))
                touch.clear()
                advance(page, .5)
                hits = page.evaluate('hitEvents')
                row['hits'] = hits
                check('手机任意角度实际命中目标且释放输入 %d %.1f %d' % (card, height, index),
                      any(h['targetId'] == arranged['target']['id'] for h in hits) and clear_state(page), hits)
                report['aim'].append(row)
        if not probe:
            skill_directions(page, touch, card, directions, report, check)
        if card == CARDS[0] and not probe:
            edge_cases(page, touch, report, check)
            controller_lifecycle(page, touch, report, check)
        report['cards'].append(card)
    except Exception:
        report['failure_state'] = page.evaluate(SNAPSHOT) if page.evaluate('!!window.aimRaw') else None
        report['input_trace'] = page.evaluate('window.aimEventTrace||[]')
        page.screenshot(path=str(OUT / ('probe-failure.png' if probe else 'failure.png')))
        raise
    finally:
        touch.clear()
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--card', type=int)
    parser.add_argument('--directions', type=int, default=16)
    parser.add_argument('--probe', action='store_true')
    args = parser.parse_args()
    if not 4 <= args.directions <= 360 or args.card is not None and args.card not in CARDS:
        parser.error('use 4..360 directions and a supported current card')
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'complete': False, 'probe': args.probe, 'probe_requests': [], 'checks': [], 'errors': [],
              'cards': [], 'aim': [], 'skills': [], 'source_before': fingerprints()}

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
            for card in [args.card] if args.card else CARDS:
                run_case(browser, 'http://127.0.0.1:%d' % server.server_address[1], card,
                         args.directions, args.probe, report, check)
            check('连续角度触控验收无未处理页面异常', not report['errors'], report['errors'])
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
        (OUT / ('touch-probe.json' if args.probe else 'touch.json')).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()
