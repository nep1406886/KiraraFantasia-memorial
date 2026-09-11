"""Actual missing enemy and held chest/native requests during room assembly."""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import advance
from rl_room_transition_browser import settled, fingerprints, STATE

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/room-assets'


def boot(browser, base, errors):
    context = browser.new_context(viewport={'width': 1280, 'height': 840})
    context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
        localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
    page = context.new_page(); page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '/site/game/roguelike.html?volume=1&floor=9&seed=260903', wait_until='load', timeout=60000)
    page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]')).click(timeout=60000)
    settled(page)
    return context, page


def pause_with_storage(page):
    page.locator('#save-status-open').click()
    page.locator('#storage-close').click()
    page.wait_for_selector('#room-load-status[data-phase="failed"]')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'before': fingerprints()}

    def check(label, ok, detail=None):
        report['checks'].append({'label': label, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        if not ok:
            raise AssertionError(label + ': ' + str(detail))

    manifest = json.loads((ROOT / 'site/asset/models/manifest.json').read_text(encoding='utf8'))
    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    base = 'http://127.0.0.1:%d' % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            context, page = boot(browser, base, report['errors'])
            model = page.evaluate("""()=>{const w=kirafanRL.world;window.sourceMap=kirafanRL.mapview.group;
                w.enterRoom(w.dungeon.boss);return w.enemies[0].model;}""")
            pattern = '**/' + manifest['models'][model]['file']
            failed = []

            def unavailable(route):
                failed.append(route.request.url); route.fulfill(status=503, body='injected unavailable model')

            page.route(pattern, unavailable); advance(page)
            page.wait_for_selector('#room-load-status[data-phase="failed"]', timeout=40000)
            before = page.evaluate(STATE)
            check('真实敌人模型503必须阻止战斗，不只是输出警告', len(failed) > 0 and page.evaluate('kirafanRL.world.frozen')
                  and page.evaluate('kirafanRL.mapview.group===sourceMap'), failed)
            advance(page, 2)
            check('看不见的敌人不能在加载失败期间攻击或推进动作', page.evaluate(STATE) == before)
            page.screenshot(path=str(OUT / 'enemy-unavailable.png'))
            page.unroute(pattern, unavailable); retried = []
            page.on('request', lambda r: retried.append(r.url) if r.url.endswith(manifest['models'][model]['file']) else None)
            page.locator('#room-load-retry').click(); settled(page)
            check('敌人资源恢复后真实重新请求并显示全部敌人', len(retried) > 0
                  and page.evaluate('kirafanRL.views.enemies.length===kirafanRL.world.enemies.length'))
            check('重试不重生成逻辑敌人、金币或奖励', json.loads(before)['enemies'][0][0] == json.loads(page.evaluate(STATE))['enemies'][0][0]
                  and json.loads(before)['claims'] == json.loads(page.evaluate(STATE))['claims'])

            # An unresolved model request must not force the retry to wait for it.
            chest_pattern = '**/' + manifest['models']['model/enemy/model_en_14202.muast']['file']
            held, requests = [], []

            def hold_first(route):
                requests.append(route.request.url)
                if len(requests) == 1:
                    held.append(route)
                else:
                    route.continue_()

            page.route(chest_pattern, hold_first)
            page.evaluate("""async()=>{await (await import('/site/core/loader.js')).clearModelCache();const w=kirafanRL.world;
                window.beforeChest=kirafanRL.mapview.group;w.enterRoom(w.dungeon.rooms.find(r=>r.type==='chest').id);kirafanRL.step(1/60);}""")
            for _ in range(600):
                if held: break
                page.wait_for_timeout(50)
            check('宝箱实际请求被挂起，地图不能先于交互物揭幕', len(held) == 1
                  and page.evaluate('kirafanRL.world.frozen && kirafanRL.mapview.group===beforeChest'))
            pause_with_storage(page); page.locator('#room-load-retry').click(); settled(page)
            check('宝箱重试绕过旧挂起请求，恢复无需先放行旧请求', len(requests) >= 2 and len(held) == 1
                  and page.evaluate('!kirafanRL.world.chest.opened && !kirafanRL.world.frozen'))
            page.evaluate("""()=>{const s=kirafanRL.scene;window.winner=s.children.length;window.lateAdds=0;
                const add=s.add;s.add=function(...objects){lateAdds+=objects.length;return add.apply(this,objects);};}""")
            held.pop().continue_()
            page.wait_for_function('lateAdds>=2', polling=50, timeout=30000)
            check('迟到宝箱和阴影立即释放，不留下重叠交互物', page.evaluate('kirafanRL.scene.children.length===winner && !kirafanRL.world.frozen'))
            context.close()

            # The book is not a preloaded floor asset. Its three companion props
            # are already ready, so cancellation must release their partial refs.
            context, page = boot(browser, base, report['errors'])
            books, pending_books = [], []

            def hold_book(route):
                books.append(route.request.url)
                if len(books) == 1:
                    pending_books.append(route)
                else:
                    route.continue_()

            page.route('**/goods_1083.glb.gz', hold_book)
            baseline = page.evaluate("""async()=>{window.nativeAssets=await import('/site/game/rl/view/nativeassets.js');
                const w=kirafanRL.world,{createRandom,hash32}=await import('/site/game/rl/random.js');
                const room=w.dungeon.rooms.find(r=>r.type==='battle'&&createRandom((r.seed^hash32('altar'))>>>0)()<.35);
                if(!room)throw Error('缺少自然祭坛');const refs=nativeAssets.nativeCacheStats().refs;
                w.enterRoom(room.id);kirafanRL.step(1/60);return refs;}""")
            for _ in range(600):
                if pending_books: break
                page.wait_for_timeout(50)
            check('祭坛书册真实请求挂起，整个房间保持暂停', len(pending_books) == 1 and page.evaluate('kirafanRL.world.frozen'))
            pause_with_storage(page)
            page.wait_for_function('refs=>nativeAssets.nativeCacheStats().refs===refs', arg=baseline, polling=50, timeout=10000)
            check('取消挂起组合立即释放已成功的雕像和灯具引用', page.evaluate('nativeAssets.nativeCacheStats().refs') == baseline)
            page.locator('#room-load-retry').click(); settled(page)
            check('原作书册重试独立请求成功且四件祭坛齐全', len(books) >= 2
                  and page.evaluate("kirafanRL.scene.getObjectByName('native-shrine')?.children.length===4"))
            page.evaluate("""async()=>{const {THREE}=await (await import('/site/core/loader.js')).loadModules();
                window.winnerRefs=nativeAssets.nativeCacheStats().refs;window.winner=kirafanRL.scene.children.length;
                window.lateDisposals=0;const dispose=THREE.BufferGeometry.prototype.dispose;
                THREE.BufferGeometry.prototype.dispose=function(){lateDisposals++;return dispose.call(this);};}""")
            pending_books.pop().continue_()
            page.wait_for_function('lateDisposals>0', polling=50, timeout=30000)
            check('旧原作请求只释放旧几何，不删除新缓存或场景', page.evaluate('nativeAssets.nativeCacheStats().refs===winnerRefs && kirafanRL.scene.children.length===winner && !kirafanRL.world.frozen'))
            page.screenshot(path=str(OUT / 'altar-recovered.png'))
            context.close()
            context = browser.new_context()
            page = context.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.route('**/native-cancel-test', lambda route: route.fulfill(content_type='text/html', body='<body></body>'))
            timelines = []
            page.route('**/native/timeline/goods_1072.json', lambda route: timelines.append(route))
            page.goto(base + '/native-cancel-test')
            page.evaluate("""async()=>{const loader=await import('/site/core/loader.js'),m=await loader.loadModules();
                const parse=m.GLTFLoader.prototype.parse;window.partialDisposals=0;
                m.GLTFLoader.prototype.parse=function(data,path,loaded,failed){return parse.call(this,data,path,result=>{
                    window.partialScene=result.scene;const geometries=new Set();result.scene.traverse(n=>{if(n.geometry)geometries.add(n.geometry);});
                    window.partialGeometryCount=geometries.size;geometries.forEach(g=>g.addEventListener('dispose',()=>partialDisposals++));loaded(result);
                },failed);};window.nativeAssets=await import('/site/game/rl/view/nativeassets.js');
                window.cancelledResult=null;nativeAssets.acquireNative('furniture','goods_1072')
                    .then(i=>{i.dispose();window.cancelledResult='unexpected success';},()=>{window.cancelledResult='cancelled';});}""")
            page.wait_for_function('window.partialGeometryCount>0', polling=50, timeout=30000)
            check('原作模型已解析但动画时间轴仍被真实请求挂起', len(timelines) == 1
                  and page.evaluate('cancelledResult===null && partialDisposals===0'))
            page.evaluate('nativeAssets.retryNativeRequests()')
            page.wait_for_function('cancelledResult!==null', polling=50, timeout=10000)
            check('取消部分加载立即释放已解析几何，不等待动画请求', page.evaluate('cancelledResult==="cancelled" && partialDisposals===partialGeometryCount'))
            timelines.pop().continue_(); page.wait_for_timeout(300)
            check('迟到时间轴不重复释放或重新发布旧模板', page.evaluate('partialDisposals===partialGeometryCount && nativeAssets.nativeCacheStats().refs===0'))
            check('没有未捕获页面异常', not report['errors'], report['errors'])
            report['after'] = fingerprints(); check('验证期间产品源文件未改变', report['before'] == report['after'])
            context.close(); browser.close()
    finally:
        server.shutdown(); worker.join(timeout=5)
        report['after'] = fingerprints()
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()
