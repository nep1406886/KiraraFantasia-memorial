"""Real door movement and candidate/actor failure ownership during room reveal."""
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import ready, advance
from rl_recovery_browser import press

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/room-transition'
FILES = ['site/game/rl/main.js', 'site/game/rl/world.js', 'site/game/rl/ui/theme.css',
         'site/game/rl/ui/roomload.js', 'site/game/rl/view/mapview.js', 'site/game/rl/view/nativeassets.js', 'site/game/rl/view/interactview.js']
STATE = """()=>{const w=kirafanRL.world,p=w.player;return JSON.stringify({time:w.time,x:p.x,y:p.y,
    hp:p.hp,coin:w.coin,equipment:p.equipment,claims:w.getRoomClaims(),colliders:w.roomColliders,
    slots:p.skills.slots.map(s=>s.remaining),enemies:w.enemies.map(e=>[e.id,e.x,e.y,e.hp,e.sm.state,e.sm.stateTime])});}"""


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def settled(page):
    ready(page)
    page.wait_for_function('!kirafanRL.roomLoading && !kirafanRL.world.frozen', polling=50, timeout=30000)


def approach_door(page):
    return page.evaluate("""()=>{const w=kirafanRL.world,p=w.player,d=w.roomDoors[0];
        if(!d)throw Error('缺少门');p.x=d.at.x;p.y=d.at.y;
        if(d.side==='N')p.y=p.radius+.5;if(d.side==='S')p.y=w.height-p.radius-.5;
        if(d.side==='W')p.x=p.radius+.5;if(d.side==='E')p.x=w.width-p.radius-.5;
        p.sm.force('idle');return {key:{N:'w',S:'s',W:'a',E:'d'}[d.side],to:d.to};}""")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'before': fingerprints()}

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
                if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',
                    JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
            page = context.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.goto('http://127.0.0.1:%d/site/game/roguelike.html?volume=1&seed=26101' % server.server_address[1],
                      wait_until='load', timeout=60000)
            page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]')).click(timeout=60000)
            settled(page)
            page.evaluate("""()=>{const m=kirafanRL.mapview;window.oldRoomGroup=m.group;
                const build=m.buildRoom.bind(m),prepare=m.prepareRoom.bind(m);
                window.mapHooks={build,prepare};window.holdMap=true;
                // The legacy path holds before build; the corrected path holds a
                // real prepared candidate before activation. Neither publishes it.
                m.buildRoom=(...args)=>holdMap?new Promise(resolve=>{window.releaseMap=()=>resolve(build(...args));}):build(...args);
                m.prepareRoom=(...args)=>prepare(...args).then(c=>{window.preparedMap=c;
                    return holdMap?new Promise(resolve=>{window.releaseMap=()=>resolve(c);}):c;});
            }""")
            door = approach_door(page); page.keyboard.down(door['key']); advance(page, .6); page.keyboard.up(door['key'])
            page.wait_for_function('typeof releaseMap==="function"', polling=50, timeout=30000)
            check('真实移动过门后，新房间装配期间世界冻结', page.evaluate('kirafanRL.world.frozen'))
            check('地图未提交前保留旧候选并保持遮罩', page.evaluate("kirafanRL.mapview.group===oldRoomGroup && document.querySelector('#room-fade').classList.contains('on')"))
            before = page.evaluate(STATE); page.keyboard.down('d'); advance(page, 2); page.keyboard.up('d')
            check('加载期间移动、敌人、冷却、生命和碰撞均不推进', page.evaluate(STATE) == before)
            page.wait_for_timeout(350)
            check('慢加载不会靠固定300毫秒自行揭开旧地图', page.locator('#room-fade').evaluate('e=>Number(getComputedStyle(e).opacity)') == 1)
            page.screenshot(path=str(OUT / 'loading-held.png'))
            page.evaluate('holdMap=false;releaseMap()')
            page.wait_for_function('kirafanRL.mapview.group===preparedMap.group', polling=10, timeout=30000)
            check('资源提交后仍在揭幕期，不能立即行动', page.evaluate('kirafanRL.world.frozen'))
            samples = []
            for _ in range(8):
                samples.append(page.locator('#room-fade').evaluate('e=>Number(getComputedStyle(e).opacity)'))
                page.wait_for_timeout(50)
            check('揭幕透明度连续下降，而不是在装配事件里瞬间隐藏', all(a >= b for a, b in zip(samples, samples[1:]))
                  and any(0 < a < 1 for a in samples) and samples[-1] == 0, samples)
            settled(page)
            check('完成后保持目标房间，旧地图释放且没有遗留输入', page.evaluate("""to=>kirafanRL.world.roomId===to
                && !oldRoomGroup.parent && kirafanRL.input.state.move.x===0 && kirafanRL.input.state.move.y===0""", door['to']))
            page.screenshot(path=str(OUT / 'room-ready.png'))
            # A failed map must be recoverable without re-entering its logic room.
            page.evaluate("""()=>{const k=kirafanRL,m=k.mapview,w=k.world;
                m.prepareRoom=()=>Promise.reject(new Error('injected room assembly failure'));
                w.enterRoom(w.dungeon.start);k.step(1/60);}""")
            page.wait_for_selector('#room-load-status[data-phase="failed"]', timeout=10000)
            before = page.evaluate(STATE)
            check('地图装配失败明确停留并提供重试与备份', page.evaluate('kirafanRL.world.frozen')
                  and page.locator('#room-load-retry').is_enabled() and page.locator('#room-load-storage').is_enabled())
            page.screenshot(path=str(OUT / 'loading-failed.png'))
            page.evaluate('()=>{kirafanRL.mapview.prepareRoom=mapHooks.prepare;}')
            page.locator('#room-load-retry').click(); settled(page)
            check('失败重试不重入逻辑房间或修改消费账本', json.loads(before)['claims'] == json.loads(page.evaluate(STATE))['claims'])
            # Invalidate one in-flight generation, then release it behind the winner.
            page.evaluate("""()=>{const k=kirafanRL,m=k.mapview,w=k.world;
                window.lateReleased=0;let first=true;
                m.prepareRoom=(...args)=>mapHooks.prepare(...args).then(c=>{
                    if(!first)return c;first=false;window.lateMap=c;const dispose=c.dispose.bind(c);
                    c.dispose=()=>{lateReleased++;dispose();};return new Promise(resolve=>{window.releaseLate=()=>resolve(c);});});
                w.enterRoom(w.dungeon.rooms.find(r=>r.type==='shop').id);k.step(1/60);}""")
            page.wait_for_function('typeof releaseLate==="function"', polling=50, timeout=30000)
            page.evaluate('kirafanRL.world.enterRoom(kirafanRL.world.dungeon.start);kirafanRL.step(1/60)')
            settled(page)
            page.evaluate('window.winningMap=kirafanRL.mapview.group;window.winningCollision=JSON.stringify(kirafanRL.world.roomColliders);releaseLate()')
            page.wait_for_function('lateReleased===1', polling=50, timeout=10000)
            check('迟到地图只释放自己，不替换当前房间或碰撞', page.evaluate("kirafanRL.mapview.group===winningMap && JSON.stringify(kirafanRL.world.roomColliders)===winningCollision && !lateMap.group.parent && !kirafanRL.world.frozen"))
            page.evaluate("""()=>{const k=kirafanRL,m=k.mapview,w=k.world;
                window.timeoutReleased=0;let first=true;
                m.prepareRoom=(...args)=>mapHooks.prepare(...args).then(c=>{if(!first)return c;first=false;
                    const dispose=c.dispose.bind(c);c.dispose=()=>{timeoutReleased++;dispose();};
                    return new Promise(resolve=>{window.releaseTimedOut=()=>resolve(c);});});
                w.enterRoom(w.dungeon.rooms.find(r=>r.type==='shop').id);k.step(1/60);}""")
            page.wait_for_function('typeof releaseTimedOut==="function"', polling=50, timeout=30000)
            before = page.evaluate(STATE)
            page.wait_for_selector('#room-load-status[data-phase="failed"]', timeout=25000)
            check('实际20秒超时明确暂停且保持世界未变', '20秒' in page.locator('#room-load-status').inner_text()
                  and page.evaluate(STATE) == before and page.evaluate('kirafanRL.world.frozen'))
            page.locator('#room-load-retry').click(); settled(page)
            page.evaluate('window.winningMap=kirafanRL.mapview.group;releaseTimedOut()')
            page.wait_for_function('timeoutReleased===1', polling=50, timeout=10000)
            check('超时重试不等旧候选且迟到结果无法再次揭幕', page.evaluate('kirafanRL.mapview.group===winningMap && !kirafanRL.roomLoading && !kirafanRL.world.frozen'))
            page.evaluate("""()=>{const k=kirafanRL,m=k.mapview,w=k.world;
                m.prepareRoom=(...args)=>mapHooks.prepare(...args).then(c=>new Promise(resolve=>{window.releaseHidden=()=>resolve(c);}));
                w.enterRoom(w.dungeon.start);k.step(1/60);}""")
            page.wait_for_function('typeof releaseHidden==="function"', polling=50, timeout=30000)
            page.evaluate("""()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
                document.dispatchEvent(new Event('visibilitychange'));}""")
            check('后台事件立即中止房间装配而非悄悄开始战斗', page.locator('#room-load-status').get_attribute('data-phase') == 'failed'
                  and page.evaluate('kirafanRL.world.frozen'))
            page.evaluate("""()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));
                kirafanRL.mapview.prepareRoom=mapHooks.prepare;releaseHidden();}""")
            page.wait_for_timeout(400)
            check('回到前台不会自动重试或恢复过期装配', page.evaluate('kirafanRL.roomLoading?.phase==="failed" && kirafanRL.world.frozen'))
            page.emulate_media(reduced_motion='reduce')
            page.locator('#room-load-retry').click(); settled(page)
            check('减少动态效果不破坏装配、揭幕与冻结终态', page.locator('#room-fade').evaluate('e=>getComputedStyle(e).opacity') == '0'
                  and page.evaluate('kirafanRL.mapview.group.name==="room:"+kirafanRL.world.roomId'))
            check('没有未捕获页面异常', not report['errors'], report['errors'])
            report['after'] = fingerprints(); check('验证期间源文件未改变', report['after'] == report['before'])
            context.close(); browser.close()
    finally:
        server.shutdown(); worker.join(timeout=5)
        report['after'] = fingerprints()
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()
