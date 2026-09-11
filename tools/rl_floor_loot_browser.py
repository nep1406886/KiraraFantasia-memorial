"""Actual guard/boss hits, persistent loot and room-statue prayer (not an exit)."""
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_result_browser import dismiss_dialogue

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/floor-loot'
CHECKS = []


def check(label, ok, detail=None):
    CHECKS.append({'label': label, 'ok': bool(ok), 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + label, flush=True)
    if not ok:
        raise AssertionError(label + ': ' + str(detail))


def fingerprints():
    names = ['site/game/rl/main.js', 'site/game/rl/world.js', 'site/game/rl/loot.js', 'site/game/rl/runschema.js',
             'site/game/rl/profileschema.js', 'site/game/rl/ui/decisions.js', 'site/game/rl/ui/hud.js',
             'site/game/rl/ui/theme.css', 'site/asset/rl/cards-rl.json', 'site/game/rl/floorshrine.js',
             'site/game/rl/view/floorshrineview.js', 'site/game/rl/view/mapview.js', 'site/game/rl/view/roomlayout.js']
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in names}


def advance(page, seconds=1 / 60):
    page.evaluate('s=>{for(let t=0;t<s-1e-8;t+=1/60)kirafanRL.step(Math.min(1/60,s-t));}', seconds)


def ready(page):
    # With rAF disabled the queued first room event needs an explicit tick
    # before waiting for its asynchronous map/view construction.
    page.wait_for_function('window.kirafanRL?.world.player && kirafanRL.world.dungeon', polling=50, timeout=60000)
    advance(page)
    page.wait_for_function("""()=>{const k=window.kirafanRL;return k?.world.player && k.world.dungeon
        && k.pending===0 && k.interactPending===0 && !k.roomLoading && k.mapview.group?.name==='room:'+k.world.roomId;}""",
        polling=50, timeout=60000)
    dismiss_dialogue(page)
    advance(page)
    page.evaluate('kirafanRL.world.player.iframes=1e9')


def profile(page):
    return page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile'))")


def enter_guard(page):
    page.evaluate("""()=>{const k=kirafanRL,w=k.world;w.enterRoom(w.dungeon.boss,'N');k.step(1/60);
        w.enemies.forEach(e=>{e.actionTimer=1e9;});}""")
    ready(page)


def kill_guard(page):
    page.evaluate("""()=>{const k=kirafanRL,w=k.world;
        w.enemies.forEach(e=>{e.iframes=0;w.danmaku.emit('aimed',{x:e.x-3,y:e.y,angle:0},
            {side:'player',power:999999999,coef:1,count:1,speed:10,life:4});});
        for(let i=0;i<180 && w.enemies.some(e=>!e.dead);i++)k.step(1/60);
        if(w.enemies.some(e=>!e.dead))throw Error('必须通过真实弹体击杀');}""")
    dismiss_dialogue(page)
    advance(page, .25)


def resume(page):
    page.reload(wait_until='load')
    page.locator('#roster-continue').click(timeout=60000)
    ready(page)
    enter_guard(page)


def approach_loot(page):
    page.evaluate("""()=>{const w=kirafanRL.world,d=w.drops[0];if(!d)throw Error('缺少首领奖励');
        w.player.x=d.x-2;w.player.y=d.y;w.player.sm.force('idle');}""")
    page.keyboard.down('d')
    advance(page, .8)
    page.keyboard.up('d')
    page.wait_for_selector('#rl-equipment-choice[open]', timeout=10000)


def approach_shrine(page):
    # Stage outside interaction range, then exercise actual movement/collision.
    # The lateral route avoids walking across the guardian's centre-room loot.
    page.evaluate("""()=>{const w=kirafanRL.world,s=w.floorShrine;if(!s)throw Error('缺少雕像');
        w.player.x=s.x-1.65;w.player.y=s.y+4;w.player.sm.force('idle');}""")
    page.keyboard.down('w'); advance(page, .95); page.keyboard.up('w'); advance(page)
    check('正常移动可走到雕像旁', page.evaluate("""()=>{const w=kirafanRL.world,s=w.floorShrine;
        return Math.hypot(w.player.x-s.x,w.player.y-s.y)<=1.9;}"""))


def pray(page, touch=False):
    if touch:
        # Actual keyboard movement selects keyboard chrome. A first safe touch
        # switches the hybrid device back to touch controls, as a user would.
        page.touchscreen.tap(8, 8); advance(page)
        page.locator('.touch-interact').tap()
    else:
        page.keyboard.down('e'); advance(page); page.keyboard.up('e'); advance(page)
    try:
        page.wait_for_selector('#rl-floor-departure[open]', timeout=10000)
    except Exception as error:
        state = page.evaluate("""()=>({size:[innerWidth,innerHeight],portrait:document.body.classList.contains('landscape-required'),
            frozen:kirafanRL.world.frozen,near:kirafanRL.world.canCommuneAtShrine,
            interaction:kirafanRL.input.state.interact,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.id)})""")
        raise AssertionError('祈愿窗口未打开：' + json.dumps(state, ensure_ascii=False)) from error


def landscape_ready(page):
    page.set_viewport_size({'width': 1280, 'height': 840})
    # set_viewport_size does not await the window resize handler. In manual-rAF
    # tests, an immediate keydown can still be swallowed by the portrait gate.
    # Wait for actual application state; never force frozen/blocked to false.
    page.wait_for_function("""()=>!document.body.classList.contains('landscape-required')
        && !kirafanRL.world.frozen && !document.querySelector('dialog[open]')""", polling=50, timeout=10000)
    advance(page)


def new_page(browser, errors):
    context = browser.new_context(viewport={'width': 1280, 'height': 840}, has_touch=True)
    context.add_init_script("""window.requestAnimationFrame=()=>0;
        if(!localStorage.getItem('kirafan-rl:profile')&&!localStorage.getItem('kirafan-rl:meta'))
        localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    return context, page


def unclaimed_failure_recovery(browser, base, errors, recovery):
    """An unsuccessful prayer cannot consume loot, even across navigation."""
    context, page = new_page(browser, errors)
    label = '加载失败后' + ('返回选角' if recovery == 'return' else '刷新')
    evidence = {'recovery': recovery}
    try:
        page.goto(base + '?volume=1&floor=5&seed=28101', wait_until='load', timeout=60000)
        page.locator('.roster-card').first.click(timeout=60000); ready(page)
        enter_guard(page); kill_guard(page)
        approach_shrine(page); pray(page)
        # Persist already-earned room facts before sampling. The following
        # confirmation is an intent, not permission to delete unclaimed items.
        page.evaluate("window.dispatchEvent(new Event('pagehide'))")
        before = profile(page)
        before_raw = page.evaluate("localStorage.getItem('kirafan-rl:profile')")
        boss_id = page.evaluate('kirafanRL.world.roomId')
        claim = next(row for row in before['run']['roomClaims'] if row['id'] == boss_id)
        evidence['before'] = before
        check(label + '：祈愿前确有未拾取原始掉落且装备为空', bool(claim.get('drops'))
              and not before['run']['equipment'] and page.locator('.departure-loot li').count() > 0)
        page.evaluate("""()=>{const view=kirafanRL.mapview;window.unclaimedOldGroup=view.group;
            window.unclaimedPreloadCalls=0;view.preloadVolume=()=>{window.unclaimedPreloadCalls++;
                return Promise.reject(Error('unclaimed-loot preload failure'));};}""")
        page.locator('#floor-departure-confirm').click()
        page.wait_for_selector('#rl-floor-load[data-phase="failed"]', timeout=15000)
        evidence['failed'] = profile(page)
        check(label + '：真实预加载失败没有提前切层或替换旧地图', page.evaluate("""()=>{const k=kirafanRL;
            return unclaimedPreloadCalls===1&&k.world.floor===5&&k.world.frozen
                &&k.mapview.group===unclaimedOldGroup;}"""))
        check(label + '：失败后原始持久字节、残页与未拾取物品完全不变',
              page.evaluate("localStorage.getItem('kirafan-rl:profile')") == before_raw)
        page.screenshot(path=str(OUT / ('unclaimed-' + recovery + '-failed.png')))
        if recovery == 'return':
            page.locator('#floor-load-back').click()
        else:
            page.reload(wait_until='load')
        page.locator('#roster-continue').click(timeout=60000)
        ready(page); enter_guard(page)
        restored = page.evaluate("""()=>{const w=kirafanRL.world;return {floor:w.floor,coin:w.coin,
            exp:w.player.exp,equipment:w.player.equipment,alive:w.enemies.filter(e=>!e.dead).length,
            claim:w.getRoomClaims().find(row=>row.id===w.roomId),near:w.floorExitReady};}""")
        evidence['restored'] = restored
        check(label + '：续档不复活守卫，原始掉落逐项恢复且仍开放雕像', restored['floor'] == 5
              and restored['alive'] == 0 and restored['near'] and restored['claim'] == claim, restored)
        check(label + '：金币、经验、装备、残页和局编号不重复增加',
              restored['coin'] == before['run']['coin'] and restored['exp'] == before['run']['exp']
              and restored['equipment'] == before['run']['equipment']
              and profile(page)['runId'] == before['runId'] and profile(page)['meta'] == before['meta'])
        item = claim['drops'][0]['items'][0]
        approach_loot(page)
        page.locator('#equipment-confirm').click(); advance(page)
        picked = profile(page)
        evidence['picked'] = picked
        check(label + '：实际走近并确认后只装备原来的那件物品',
              picked['run']['equipment'] == [item] and page.evaluate('kirafanRL.world.drops.length===0')
              and picked['runId'] == before['runId'] and picked['meta'] == before['meta']
              and picked['run']['coin'] == before['run']['coin'] and picked['run']['exp'] == before['run']['exp'])
        resume(page)
        evidence['reloadedAfterPickup'] = profile(page)
        check(label + '：拾取后再刷新既不复制掉落，也不重复装备或发奖',
              profile(page)['run']['equipment'] == [item] and profile(page)['meta'] == before['meta']
              and page.evaluate('kirafanRL.world.drops.length===0&&kirafanRL.world.enemies.length===0'))
        page.screenshot(path=str(OUT / ('unclaimed-' + recovery + '-picked.png')))
    except BaseException as error:
        evidence['failure'] = repr(error)
        page.screenshot(path=str(OUT / ('unclaimed-' + recovery + '-failure.png')))
        raise
    finally:
        (OUT / ('unclaimed-' + recovery + '.json')).write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf8')
        context.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': CHECKS, 'errors': [], 'before': fingerprints()}
    with Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT))) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        page = None
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
                base = 'http://127.0.0.1:%d/site/game/roguelike.html' % server.server_address[1]
                context, page = new_page(browser, report['errors'])
                page.goto(base + '?volume=1&floor=5&seed=28101', wait_until='load', timeout=60000)
                hero = page.locator('.roster-card').filter(has=page.locator('img[src$="/46002001.webp"]'))
                hero.wait_for(timeout=60000)
                check('后藤 一里在实际选角卡片中保留姓与名空格', hero.locator('.who').inner_text() == '后藤 一里')
                hero.locator('.rl-roster-info').click()
                check('人物详情显示同一规范姓名', page.locator('#rl-charcard').get_by_text('后藤 一里', exact=True).count() == 1)
                page.screenshot(path=str(OUT / 'hitori-name.png'))
                page.locator('#rl-charcard .close-row button:not(.primary)').click()
                hero.click(); ready(page)
                check('战斗 HUD 姓名一致且没有改变角色编号', page.locator('.hud-player-name').inner_text() == '后藤 一里'
                      and page.evaluate('kirafanRL.world.player.card.id===46002001'))
                enter_guard(page)
                check('不再创建全局离层按钮，实际地图中存在原作雕像', page.locator('#hud-floor-exit').count() == 0
                      and page.evaluate("""()=>{const k=kirafanRL,v=k.mapview.floorShrine;
                        return v?.room===k.world.room&&v.shrine.key==='goods_1147'
                            &&v.placement.source==='prefab/room/goods/goods_1147.muast'
                            &&!!k.scene.getObjectByName('floor-shrine');}"""))
                approach_shrine(page)
                page.keyboard.down('e'); advance(page); page.keyboard.up('e'); advance(page)
                check('战斗中的雕像不可祈愿，按 E 不打开窗口', not page.locator('#rl-floor-departure').count()
                      and not page.evaluate('kirafanRL.world.canCommuneAtShrine'))
                page.screenshot(path=str(OUT / 'statue-dormant.png'))
                page.evaluate('kirafanRL.world.player.x=3;kirafanRL.world.player.y=3')
                kill_guard(page)
                advance(page, 3)
                check('守卫死亡后等待仍停留本层且可操作', page.evaluate("""()=>{const w=kirafanRL.world;
                    return w.floor===5&&!w.frozen&&w.floorExitReady&&w.drops.length>0
                        &&!document.getElementById('rl-floor-load')&&!document.getElementById('rl-result');}"""))
                check('没有自动装备首领奖励', page.evaluate('kirafanRL.world.player.equipment.length===0'))
                saved = profile(page)
                claim = next(c for c in saved['run']['roomClaims'] if c.get('cleared') and c.get('drops'))
                check('持久检查点记录首领清空和未拾取战利品', len(claim['drops']) > 0)
                page.keyboard.down('e'); advance(page); page.keyboard.up('e'); advance(page)
                check('清场后远处按 E 仍不能祈愿', not page.locator('#rl-floor-departure').count()
                      and not page.evaluate('kirafanRL.world.canCommuneAtShrine'))
                approach_shrine(page); advance(page, .8)
                check('清场后原作雕像缓亮并显示近距离祈愿提示', page.evaluate("""()=>{const v=kirafanRL.mapview.floorShrine;
                    return v.object.userData.ritualState==='nearby'&&v.object.userData.glow>.9;}""")
                      and page.locator('.floor-shrine-marker').is_visible())
                page.screenshot(path=str(OUT / 'statue-awake.png'))
                pray(page)
                check('雕像祈愿列出未拾取物品且默认未确认', page.locator('.departure-loot li').count() > 0
                      and not page.locator('#floor-departure-confirm').evaluate('el=>el===document.activeElement'))
                page.locator('#floor-departure-stay').click()
                check('取消离层保留全部战利品和层号', page.evaluate('kirafanRL.world.floor===5&&kirafanRL.world.drops.length>0'))
                resume(page)
                restored = page.evaluate("""()=>{const w=kirafanRL.world;return {coin:w.coin,enemies:w.enemies.length,
                    drops:w.getRoomClaims().find(c=>c.id===w.roomId).drops,ready:w.floorExitReady};}""")
                check('刷新后首领不复活、不重发金币，掉落逐项恢复', restored['enemies'] == 0
                      and restored['coin'] == saved['run']['coin'] and restored['drops'] == claim['drops'] and restored['ready'], restored)
                approach_loot(page)
                before_world = page.evaluate("JSON.stringify({items:kirafanRL.world.player.equipment,drops:kirafanRL.world.drops})")
                before_disk = page.evaluate("localStorage.getItem('kirafan-rl:profile')")
                page.evaluate("""()=>{window.lootWriteBlocked=true;const original=Storage.prototype.setItem;
                    Storage.prototype.setItem=function(key,value){if(window.lootWriteBlocked&&key==='kirafan-rl:profile')
                    throw new DOMException('loot quota test','QuotaExceededError');return original.call(this,key,value);};}""")
                page.locator('#equipment-confirm').click()
                check('真实保存失败不装备、不删物品且原持久字节不变',
                      page.evaluate("JSON.stringify({items:kirafanRL.world.player.equipment,drops:kirafanRL.world.drops})") == before_world
                      and page.evaluate("localStorage.getItem('kirafan-rl:profile')") == before_disk)
                check('保存失败后比较窗口保留且确认可重试', page.locator('#rl-equipment-choice').is_visible()
                      and page.locator('#equipment-confirm').is_enabled())
                page.evaluate('window.lootWriteBlocked=false')
                page.locator('#equipment-confirm').click(); advance(page)
                check('恢复保存后实际拾取成功并移除地面战利品', page.evaluate('kirafanRL.world.player.equipment.length===1&&kirafanRL.world.drops.length===0'))
                picked = profile(page)['run']['equipment']
                resume(page)
                check('拾取后再次刷新不复制物品或重刷首领', page.evaluate('kirafanRL.world.drops.length===0&&kirafanRL.world.enemies.length===0')
                      and profile(page)['run']['equipment'] == picked)
                approach_shrine(page)
                for width, height in [(375, 812), (390, 844), (430, 900), (844, 390), (1280, 840)]:
                    # The shared mobile orientation guard now requires landscape
                    # gameplay. An already-open decision must still resize safely.
                    landscape_ready(page)
                    pray(page)
                    page.set_viewport_size({'width': width, 'height': height}); advance(page)
                    page.wait_for_function("""()=>[...document.getElementById('rl-floor-departure').getAnimations({subtree:true})]
                        .every(a=>a.playState!=='running')""", polling=50, timeout=5000)
                    page.screenshot(path=str(OUT / ('departure-%d.png' % width)))
                    geometry = page.locator('#rl-floor-departure').evaluate("""d=>{const r=d.getBoundingClientRect();
                        return {fits:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
                            controls:[...d.querySelectorAll('button')].every(b=>{const r=b.getBoundingClientRect();
                            return r.height>=44&&r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight
                                &&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})};}""")
                    check('离层确认在 %d×%d 可读且按钮可操作' % (width, height), all(geometry.values()), geometry)
                    page.keyboard.press('Escape')
                    page.wait_for_selector('#rl-floor-departure', state='detached', timeout=10000)
                    advance(page)
                landscape_ready(page)
                page.evaluate("""()=>{const k=kirafanRL;window.oldLootGroup=k.mapview.group;window.oldPreload=k.mapview.preloadVolume;
                    k.mapview.preloadVolume=()=>Promise.reject(Error('loot descent load test'));}""")
                pray(page); page.locator('#floor-departure-confirm').click()
                page.wait_for_selector('#rl-floor-load[data-phase="failed"]', timeout=15000)
                check('主动下潜加载失败仍保留旧层和首领奖励检查点', page.evaluate('kirafanRL.world.floor===5&&kirafanRL.mapview.group===oldLootGroup&&kirafanRL.world.frozen')
                      and profile(page)['run']['equipment'] == picked)
                page.evaluate('kirafanRL.mapview.preloadVolume=window.oldPreload')
                page.locator('#floor-load-retry').click()
                page.wait_for_function('kirafanRL.world.floor===6&&!document.getElementById("rl-floor-load")', polling=50, timeout=60000)
                ready(page)
                check('重试下潜只推进一层，装备保留且旧层战利品记录清空', profile(page)['run']['floor'] == 6
                      and profile(page)['run']['equipment'] == picked and profile(page)['run']['roomClaims'] == [])
                context.close()

                for recovery in ['return', 'refresh']:
                    unclaimed_failure_recovery(browser, base, report['errors'], recovery)

                context, page = new_page(browser, report['errors'])
                page.goto(base + '?volume=1&floor=5&seed=28101', wait_until='load', timeout=60000)
                page.locator('.roster-card').first.click(timeout=60000); ready(page)
                enter_guard(page); kill_guard(page); approach_shrine(page)
                page.set_viewport_size({'width': 844, 'height': 390}); advance(page)
                pray(page, touch=True)
                check('横屏触控祈愿无需先拾取任何装备', page.locator('.departure-loot li').count() > 0
                      and page.evaluate('kirafanRL.world.player.equipment.length===0'))
                page.screenshot(path=str(OUT / 'statue-prayer-touch.png'))
                page.locator('#floor-departure-confirm').tap()
                page.wait_for_function('kirafanRL.world.floor===6&&!document.getElementById("rl-floor-load")', polling=50, timeout=60000)
                ready(page)
                check('未拾取也可经雕像前往下一层，不自动装备遗留物品', page.evaluate('kirafanRL.world.floor===6&&kirafanRL.world.player.equipment.length===0'))
                context.close()

                context, page = new_page(browser, report['errors'])
                page.goto(base + '?volume=1&floor=20&seed=28101', wait_until='load', timeout=60000)
                page.locator('.roster-card').first.click(timeout=60000); ready(page)
                enter_guard(page); kill_guard(page); advance(page, 2)
                check('最终首领死亡也保留可拾取阶段，不提前胜利结算', page.evaluate('kirafanRL.world.floorExitReady&&!kirafanRL.world.frozen&&kirafanRL.world.drops.length>0')
                      and profile(page)['run'] is not None and profile(page)['lastResult'] is None)
                approach_loot(page); page.locator('#equipment-confirm').click(); advance(page)
                approach_shrine(page); pray(page); page.locator('#floor-departure-confirm').click()
                dismiss_dialogue(page); advance(page)
                page.wait_for_selector('#rl-result[open]', timeout=15000)
                result = profile(page)['lastResult']
                check('最终拾取后明确完成本卷才产生一次胜利收据', result['outcome'] == 'victory'
                      and result['equipmentCount'] == 1 and profile(page)['run'] is None, result)
                page.screenshot(path=str(OUT / 'final-boss-result.png'))
                page.reload(wait_until='load'); page.wait_for_selector('#rl-result[open]', timeout=60000)
                check('刷新只恢复同一胜利收据，不重复结算或复活首领', profile(page)['lastResult'] == result and profile(page)['run'] is None)
                check('流程没有未捕获页面异常', not report['errors'], report['errors'])
                context.close(); browser.close()
        except Exception as error:
            report['failure'] = repr(error)
            try:
                if page and not page.is_closed():
                    page.screenshot(path=str(OUT / 'failure.png'))
            except Exception:
                pass  # Keep the original failure if Playwright already closed its loop.
            raise
        finally:
            report['after'] = fingerprints()
            report['changed_during_run'] = [name for name in report['before'] if report['before'][name] != report['after'][name]]
            (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            server.shutdown()


if __name__ == '__main__':
    main()
