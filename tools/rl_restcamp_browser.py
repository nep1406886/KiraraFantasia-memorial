"""Native campsite in real gameplay, walkability, animation and candidate ownership."""
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import ready, advance, new_page
from rl_recovery_browser import press
from rl_room_assets_browser import pause_with_storage
from rl_navigation_browser import SETUP

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/restcamp'
FILES = ['site/game/rl/main.js', 'site/game/rl/world.js', 'site/game/rl/restcamp.js', 'site/game/rl/view/mapview.js',
         'site/game/rl/view/roomlayout.js', 'site/game/rl/view/roomsurface.js', 'site/game/rl/view/restcampview.js',
         'site/game/rl/view/roomprops.js', 'site/game/rl/view/nativeassets.js', 'site/asset/rl/native/index.json']

ANIMATION = """()=>{const rows=[];kirafanRL.mapview.restCamp.object.traverse(n=>{
    if(n.isMesh)rows.push([n.name,n.visible,n.position.toArray(),n.scale.toArray(),n.quaternion.toArray(),n.material.opacity]);
});return JSON.stringify(rows);}"""
RESOURCES = """()=>{const w=kirafanRL.world,p=w.player;return JSON.stringify([p.hp,w.coin,p.equipment,p.skills.gauge]);}"""


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def boot(browser, base, errors):
    context, page = new_page(browser, errors)
    page.goto(base + '/site/game/roguelike.html?volume=1&floor=9&seed=260903', wait_until='load', timeout=60000)
    page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]')).click(timeout=60000)
    ready(page)
    return context, page


def enter_rest(page):
    page.evaluate("""()=>{const k=kirafanRL,w=k.world,room=w.dungeon.rooms.find(r=>r.type==='rest');
        if(!room)throw Error('缺少自然营地');w.enterRoom(room.id);k.step(1/60);}""")


def walk_axis(page, key, axis, target):
    page.keyboard.down(key)
    try:
        page.evaluate("""({axis,target})=>{const k=kirafanRL,p=k.world.player,direction=Math.sign(target-p[axis]);
            for(let i=0;i<300&&direction*(target-p[axis])>.08;i++)k.step(1/60);}""", {'axis': axis, 'target': target})
    finally:
        page.keyboard.up(key); advance(page)


def inspect_camp(page):
    return page.evaluate("""async()=>{
        const k=kirafanRL,w=k.world,c=k.mapview.restCamp,{circleOverlapsRect}=await import('/site/game/rl/geometry.js');
        if(!c)return null;
        const props=c.object.children.filter(n=>n.name.startsWith('room-prop:'));
        const queue=[[w.width,w.height]],seen=new Set();
        for(let at=0;at<queue.length;at++){
            const [x,y]=queue[at],key=x+','+y;if(seen.has(key)||x<1||y<1||x>w.width*2-1||y>w.height*2-1)continue;
            if(w.roomColliders.some(b=>circleOverlapsRect(x/2,y/2,.45,b)))continue;
            seen.add(key);for(const [dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]])if(!seen.has((x+dx)+','+(y+dy)))queue.push([x+dx,y+dy]);
        }
        const targets=[[w.width,1],[w.width,w.height*2-1],[1,w.height],[w.width*2-1,w.height],
            [Math.round(w.npc.x*2),Math.round(w.npc.y*2)]];
        const {THREE}=await (await import('/site/core/loader.js')).loadModules();
        return {keys:props.map(p=>p.name),sources:c.placements.map(p=>p.source),
            colliders:c.colliders.every(b=>w.roomColliders.some(r=>JSON.stringify(r)===JSON.stringify(b))),
            accessible:targets.every(([x,y])=>seen.has(x+','+y)),ground:props.map(p=>new THREE.Box3().setFromObject(p,true).min.y),
            npc:[w.npc.x,w.npc.y],drawCalls:k.renderer.info.render.calls};
    }""")


OWNERSHIP = """async()=>{
    const a=nav,room={id:1,type:'rest',seed:217};a.map=a.maps.createMapView(a.stage.scene,1);
    await a.map.buildRoom(room,undefined,['N','E','S','W'],{strict:true});
    const old=a.map.group,oldCamp=a.map.restCamp,baseline=a.native.nativeCacheStats().refs;
    const one=await a.map.prepareRoom({...room,id:2},undefined,['N','E','S','W'],{strict:true});
    const two=await a.map.prepareRoom({...room,id:3},undefined,['N','E','S','W'],{strict:true});
    const firstMesh=root=>{let found;root.traverse(n=>{if(!found&&n.isMesh)found=n;});return found;};
    const original=firstMesh(oldCamp.object),draft=firstMesh(one.restCamp.object);
    const independent=original.material!==draft.material&&original.material.map!==draft.material.map;
    const opacity=original.material.opacity;draft.material.opacity=.123;
    const untouched=original.material.opacity===opacity;
    let disposals=0;original.geometry.addEventListener('dispose',()=>disposals++);
    one.dispose();one.dispose();
    const discarded=a.map.group===old&&a.native.nativeCacheStats().refs===baseline+4&&disposals===0;
    a.map.activateRoom(two);
    const activated=a.map.group===two.group&&a.native.nativeCacheStats().refs===baseline&&disposals===0;
    let grounded=true;
    for(const height of [5.5,13,9]){
        a.follow.setHeight(height);a.tilt.setCharacterPitch(a.follow.pitch());a.map.update(0);
        for(const prop of a.map.restCamp.object.children.filter(n=>n.name.startsWith('room-prop:'))){
            const y=new a.T.Box3().setFromObject(prop,true).min.y;if(y<0||y>.025)grounded=false;
        }
    }
    a.map.dispose();a.map.dispose();
    return {independent,untouched,discarded,activated,grounded,released:a.native.nativeCacheStats().refs===0&&disposals===0};
}"""


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
    base = 'http://127.0.0.1:%d' % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            context, page = boot(browser, base, report['errors'])
            before = page.evaluate(RESOURCES); enter_rest(page); ready(page)
            camp = inspect_camp(page); report['camp'] = camp
            check('自然营地包含原作篝火、烤架与灯具，不依赖随机图块', camp is not None
                  and camp['keys'] == ['room-prop:goods_1041', 'room-prop:goods_1044', 'room-prop:goods_1072']
                  and all(s.startswith('prefab/room/goods/') for s in camp['sources']), camp)
            check('布景没有额外发奖、回血或换装备', page.evaluate(RESOURCES) == before)
            check('物件接地，底座碰撞与地图一致，四向门和访客都可达', camp['colliders'] and camp['accessible']
                  and all(0 <= y < .025 for y in camp['ground']), camp)
            walk_axis(page, 's', 'y', 13.4); walk_axis(page, 'd', 'x', 11.2); advance(page, .35)
            check('从房间中央真实走到访客旁，不被营地或散景封路', page.evaluate(
                'Math.hypot(kirafanRL.world.player.x-11.2,kirafanRL.world.player.y-13.4)<.2'))
            page.screenshot(path=str(OUT / 'camp-desktop.png'))
            press(page, 'Escape'); paused = page.evaluate(ANIMATION); advance(page, 1)
            check('菜单暂停时原作火焰与烟雾时间轴不推进', page.evaluate('kirafanRL.world.frozen') and page.evaluate(ANIMATION) == paused)
            press(page, 'Escape'); advance(page, .22)
            check('继续后同一营地动画恢复，不重新装配物件', page.evaluate(ANIMATION) != paused
                  and page.evaluate('kirafanRL.scene.children.filter(n=>n.name.startsWith("room:")).length===1'))
            page.set_viewport_size({'width': 844, 'height': 390}); page.touchscreen.tap(8, 8); advance(page, .3)
            check('手机横屏保留营地画面与正常触控', page.evaluate('!kirafanRL.world.frozen&&!document.body.classList.contains("landscape-required")'))
            page.screenshot(path=str(OUT / 'camp-touch.png'))
            page.locator('.touch-interact').tap(); advance(page); page.wait_for_selector('#rl-supply-choice[open]')
            check('营地触控仍进入四选一事件，不自动消费', page.locator('#rl-supply-choice .room-event-option').count() == 4
                  and page.evaluate(RESOURCES) == before)
            page.keyboard.press('Escape'); advance(page)
            page.wait_for_selector('#rl-supply-choice', state='hidden')
            page.set_viewport_size({'width': 1280, 'height': 840}); advance(page)
            walk_axis(page, 'd', 'x', 13.75)
            page.keyboard.down('w'); advance(page, .6); page.keyboard.up('w'); advance(page)
            check('实际移动会停在篝火底座外，不穿过火焰', page.evaluate(
                'kirafanRL.world.player.y>12.7&&kirafanRL.world.player.y<13.1'))
            baseline = page.evaluate('async()=>{const n=await import("/site/game/rl/view/nativeassets.js");window.nativeAssets=n;return n.nativeCacheStats().refs;}')
            for _ in range(3):
                page.evaluate('kirafanRL.world.enterRoom(kirafanRL.world.dungeon.start);kirafanRL.step(1/60)'); ready(page)
                enter_rest(page); ready(page)
            check('重进三次只有一套营地，原作引用没有增长', page.evaluate('nativeAssets.nativeCacheStats().refs') == baseline
                  and page.evaluate('kirafanRL.scene.getObjectByName("native-rest-camp").children.filter(n=>n.name.startsWith("room-prop:")).length===3'))
            context.close()

            context, page = boot(browser, base, report['errors'])
            held, requests = [], []
            def hold_first(route):
                requests.append(route.request.url)
                if len(requests) == 1: held.append(route)
                else: route.continue_()
            page.route('**/goods_1044.glb.gz', hold_first)
            refs = page.evaluate('async()=>{window.nativeAssets=await import("/site/game/rl/view/nativeassets.js");window.oldMap=kirafanRL.mapview.group;return nativeAssets.nativeCacheStats().refs;}')
            enter_rest(page)
            for _ in range(600):
                if held: break
                page.wait_for_timeout(50)
            check('烤架真实请求挂起时保留旧地图并暂停世界', len(held) == 1
                  and page.evaluate('kirafanRL.world.frozen&&kirafanRL.mapview.group===oldMap'))
            pause_with_storage(page)
            page.wait_for_function('n=>nativeAssets.nativeCacheStats().refs===n', arg=refs, polling=50, timeout=10000)
            check('取消营地装配释放已完成篝火、灯具和建筑引用', page.evaluate('nativeAssets.nativeCacheStats().refs') == refs)
            page.locator('#room-load-retry').click(); ready(page)
            check('营地重试不等待旧烤架请求，可以独立恢复', len(requests) >= 2 and len(held) == 1
                  and page.evaluate('!!kirafanRL.mapview.restCamp&&!kirafanRL.world.frozen'))
            page.evaluate('window.winningCamp=kirafanRL.mapview.restCamp;window.winningRefs=nativeAssets.nativeCacheStats().refs')
            held.pop().continue_(); page.wait_for_timeout(600)
            check('迟到烤架不会替换已显示营地或增加活跃引用', page.evaluate(
                'kirafanRL.mapview.restCamp===winningCamp&&nativeAssets.nativeCacheStats().refs===winningRefs&&!kirafanRL.world.frozen'))
            context.close()

            page = browser.new_page(viewport={'width': 960, 'height': 640})
            page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.route('**/camp-ownership', lambda r: r.fulfill(content_type='text/html', body='<body style="margin:0"></body>'))
            page.goto(base + '/camp-ownership'); page.add_script_tag(url=base + '/site/asset/gacha/cards.js'); page.evaluate(SETUP)
            report['ownership'] = page.evaluate(OWNERSHIP)
            for name, ok in report['ownership'].items(): check('营地候选所有权 '+name, ok)
            check('没有未捕获页面错误', not report['errors'], report['errors'])
            report['after'] = fingerprints(); check('验证期间产品源文件未改变', report['before'] == report['after'])
            browser.close()
    finally:
        server.shutdown(); worker.join(timeout=5)
        report['after'] = fingerprints()
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()
