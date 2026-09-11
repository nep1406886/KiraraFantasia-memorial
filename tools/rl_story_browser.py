"""T27 real story triggers, durable archive, no-reward replay and responsive UI.

Owns a port-0 server. --probe removes archiving in the served main module only
and proves the durable-record assertion detects that regression.
"""
import argparse
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "t27-story"
checks = []


def fingerprints():
    files = ['site/game/rl/main.js', 'site/game/rl/world.js', 'site/game/rl/story.js', 'site/game/rl/storycharacters.js',
             'site/game/rl/floorshrine.js', 'site/game/rl/view/mapview.js', 'site/game/rl/ui/decisions.js',
             'site/game/rl/ui/orientation.js', 'site/game/rl/ui/dialogue.js', 'site/game/rl/ui/codex.js',
             'site/game/rl/ui/story.css',
             'site/game/rl/meta.js', 'site/game/rl/save.js', 'site/asset/rl/dialogue/conditional.js',
             'site/asset/rl/dialogue/turns.js', 'site/asset/rl/dialogue/returns.js']
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in files}


def check(label, condition, detail=None):
    if not condition:
        raise AssertionError(label + ": " + str(detail))
    checks.append(label)
    print("PASS " + label, flush=True)


def profile(page):
    return page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile'))")


def seen(page, story):
    return story in (profile(page).get("meta") or {}).get("storySeen", [])


def press(page, key):
    page.keyboard.down(key)
    page.evaluate("window.kirafanRL.step(1/60)")
    page.keyboard.up(key)
    page.evaluate("window.kirafanRL.step(1/60)")


def dismiss(page, skip=False):
    for _ in range(60):
        if not page.locator("#dialogue-box").is_visible():
            return
        page.locator("#dialogue-skip" if skip else "#dialogue-box").click()
        page.wait_for_timeout(40)
    raise AssertionError("dialogue did not finish")


def ready(page):
    # Story/dialogue freezes are intentional; an in-flight room reveal is not
    # an interactable room even after enemy-model pending has reached zero.
    page.wait_for_function("window.kirafanRL?.world?.player && window.kirafanRL.pending === 0 && !window.kirafanRL.roomLoading", timeout=60000)


def enter(page, kind):
    page.evaluate("""kind => {
        const k=window.kirafanRL,w=k.world;
        const room=w.dungeon.rooms.find(r=>r.type===kind);
        if(!room) throw new Error('fixture room missing: '+kind);
        w.enterRoom(room.id); k.step(1/60);
        w.enemies.forEach(e=>{e.actionTimer=1e9;});
    }""", kind)
    ready(page)


def frozen_resources(page):
    return page.evaluate("""() => {
        const w=window.kirafanRL.world,p=w.player;
        return JSON.stringify({profile:localStorage.getItem('kirafan-rl:profile'),
            hp:p.hp,coin:w.coin,gauge:p.skills.gauge,equipment:p.equipment,claims:w.getRoomClaims()});
    }""")


def open_codex(page):
    press(page, "Escape")
    page.locator("#menu-codex").click()
    page.locator('.codex-tab[data-tab="stories"]').click()


def story_fits(page):
    return page.evaluate("""() => {
        const overlay=document.getElementById('codex-overlay'),close=document.getElementById('codex-close');
        const r=close.getBoundingClientRect(),detail=document.getElementById('codex-detail').getBoundingClientRect();
        return overlay.scrollWidth<=innerWidth && r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight
            && detail.top>=0 && detail.bottom<=innerHeight
            && close.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    }""")


def mobile_replay(browser, base, saved, errors):
    # Restore exactly the profile produced by the preceding real story flow.
    # This fixture does not grant any pages or mark an unread story as read.
    context = browser.new_context(viewport={'width':375,'height':812}, is_mobile=True, has_touch=True)
    context.add_init_script("localStorage.setItem('kirafan-rl:profile'," + json.dumps(saved) + " );")
    page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(base + '/site/game/roguelike.html', wait_until='load', timeout=60000)
        page.locator('#landscape-guard').wait_for(state='visible', timeout=60000)
        check('真实手机竖屏先保护游玩区，未读取也不会改已读记录',
              page.evaluate('kirafanRL.world.frozen') and seen(page, 'v1_turn_5'))
        page.set_viewport_size({'width':812,'height':375})
        page.locator('#landscape-guard').wait_for(state='hidden')
        page.locator('#roster-continue').tap(); ready(page)
        check('手机续档不重播已归档对白', not page.locator('#dialogue-box').is_visible())
        page.locator('.hud-pause').tap(); page.locator('#menu-codex').tap()
        page.locator('.codex-tab[data-tab="stories"]').tap()
        page.locator('[data-story-id="v1_turn_5"]').tap()
        before = frozen_resources(page)
        for width, height in [(812,375),(844,390),(915,412),(932,430),(1024,768)]:
            page.set_viewport_size({'width':width,'height':height})
            page.locator('[data-story-id="v1_turn_5"]').tap()
            check('手机横屏故事正文与关闭可达 %d×%d' % (width,height), story_fits(page))
            page.locator('.story-controls button').last.tap()
            check('手机横屏真实触控翻页不改变资源或已读字节 %d×%d' % (width,height), frozen_resources(page)==before)
            if width in (812,932): page.screenshot(path=str(OUT / ('stories-mobile-%d.png' % width)))
        page.set_viewport_size({'width':375,'height':812}); page.locator('#landscape-guard').wait_for(state='visible')
        check('阅读途中转竖屏仍保持冻结与档案', page.evaluate('kirafanRL.world.frozen') and frozen_resources(page)==before)
        page.set_viewport_size({'width':812,'height':375}); page.locator('#landscape-guard').wait_for(state='hidden')
        check('回横屏仍停在原图鉴，不误恢复战斗', page.locator('#codex-overlay').is_visible() and page.evaluate('kirafanRL.world.frozen'))
        page.locator('#codex-close').tap()
        check('手机关闭图鉴后正常恢复冒险', page.evaluate('!kirafanRL.world.frozen') and not page.locator('#menu-panel').is_visible())
    except Exception:
        page.screenshot(path=str(OUT / 'mobile-failure.png'))
        raise
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--trace-load",action="store_true",help="Record preload/prepare promise boundaries for diagnosis only.")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    errors = []
    report = {'checks': checks, 'errors': errors, 'source_before': fingerprints(), 'complete': False}
    page = None
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                               "--autoplay-policy=no-user-gesture-required"])
            context = browser.new_context(viewport={"width": 1280, "height": 840}, has_touch=False)
            context.add_init_script("""if (!localStorage.getItem('kirafan-rl:meta')) {
                localStorage.setItem('kirafan-rl:meta', JSON.stringify({prologueSeen:true,tutorialSeen:true}));
            }""")
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            pending_requests={};network_failures=[]
            page.on('request',lambda request:pending_requests.__setitem__(request,request.url))
            page.on('requestfinished',lambda request:pending_requests.pop(request,None))
            page.on('requestfailed',lambda request:(pending_requests.pop(request,None),
                network_failures.append({'url':request.url,'error':request.failure})))
            if args.probe:
                source = (ROOT / "site/game/rl/main.js").read_text(encoding="utf-8")
                assert source.count("meta.markStorySeen(nodeId);") == 1
                page.route("**/rl/main.js*", lambda route: route.fulfill(content_type="text/javascript",
                    body=source.replace("meta.markStorySeen(nodeId);", "void nodeId;")))
            page.goto(base + "/site/game/roguelike.html?volume=1&floor=5&seed=28101", wait_until="load")
            page.wait_for_selector(".roster-card", timeout=60000)
            if not args.probe:
                page.locator("#roster-codex").click()
                page.locator('.codex-tab[data-tab="stories"]').click()
                check("空档故事页默认只列已归档，不铺满无内容空卡",page.locator('.story-record').count()==0
                      and '还没有已归档的故事' in page.locator('#codex-overlay').inner_text())
                page.locator('#story-filter-all').click()
                check("旧存档图鉴有299个位置，但不自动解锁故事", page.locator(".story-record").count() == 299
                      and page.locator('.story-record[data-unlocked="true"]').count() == 0)
                page.locator('[data-story-id="v5_turn_15"]').click()
                check("未归档内容隐藏正文和剧透标题", "给下一行留个位置" not in page.locator("#codex-overlay").inner_text()
                      and "暂不可回看" in page.locator("#codex-detail").inner_text())
                page.keyboard.press("Escape")
                check("图鉴关闭焦点回到选角入口", page.evaluate("document.activeElement.id") == "roster-codex")
            page.locator(".roster-card").filter(has_text="志摩 凛").first.click()
            ready(page)
            page.wait_for_selector("#dialogue-skip")
            check("对白尚未结束时不提前归档", not seen(page, "v1_open"))
            page.locator("#dialogue-skip").focus()
            page.keyboard.down("Space")
            skip_input_blocked = page.evaluate("!window.kirafanRL.input.state.dodge")
            page.keyboard.up("Space")
            page.evaluate("window.kirafanRL.step(1/60)")
            dismiss(page, skip=True)
            if args.probe:
                check("负面对照：删除归档接线后，完成对白没有持久记录", not seen(page, "v1_open"))
                report['complete'] = True
                browser.close()
                return
            check("明确跳过卷头后归档一次", seen(page, "v1_open"))
            check("键盘激活跳过不把空格传给战斗闪避", skip_input_blocked)
            page.evaluate("window.kirafanRL.world.player.iframes=1e9")

            # Real supply command emits the NPC event; chatter is not itself a reward.
            enter(page, "rest")
            press(page, "e")
            page.wait_for_selector("#supply-gauge")
            page.locator("#supply-gauge").click()
            check("补给预览不提前消费或归档闲聊", not page.evaluate("window.kirafanRL.world.getSupplyOffer().used")
                  and not seen(page, "chatter_rin_missing"))
            page.locator("#room-event-confirm").click()
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_selector("#dialogue-skip")
            check("进化五星卡映射到凛的未收藏闲聊", page.evaluate("window.kirafanRL.world.player.card.id") == 23002001
                  and not seen(page, "chatter_rin_missing"))
            dismiss(page)
            check("完整读完条件闲聊后归档且补给已消费", seen(page, "chatter_rin_missing")
                  and page.evaluate("window.kirafanRL.world.getSupplyOffer().used"))

            # Test fixture gives the page through the actual meta command, not raw storage.
            page.evaluate("""async () => {
                const {createMeta}=await import('/site/game/rl/meta.js');
                const meta=createMeta();meta.read();meta.collectPage(23001000);
            }""")
            page.reload(wait_until="load")
            page.wait_for_selector("#roster-continue", timeout=60000)
            page.locator("#roster-continue").click()
            ready(page)
            enter(page, "rest")
            press(page, "e")
            page.wait_for_selector("#dialogue-skip")
            dismiss(page, skip=True)
            check("收藏条件变化后只选择已找回分支", seen(page, "chatter_rin_found"))
            check("同一闲聊不产生第二份补给", page.evaluate("window.kirafanRL.world.getSupplyOffer().used"))

            enter(page, "boss")
            before_seen = profile(page)["meta"]["storySeen"][:]
            page.evaluate("""() => {
                const k=window.kirafanRL,w=k.world;
                window.storyPreload=k.mapview.preloadVolume;
                k.mapview.preloadVolume=()=>Promise.reject(new Error('story preload failure'));
                w.enemies.forEach(e=>{
                    e.iframes=0;
                    w.danmaku.emit('aimed',{x:e.x-3,y:e.y,angle:0},
                        {side:'player',power:999999999,coef:1,count:1,speed:10,life:4});
                });
                for(let i=0;i<180 && w.enemies.some(e=>!e.dead);i++) k.step(1/60);
                if(w.enemies.some(e=>!e.dead)) throw new Error('guard did not die');
            }""")
            check("守卫击杀后先保留拾取时间，不自动下潜或归档转折",
                  page.evaluate("kirafanRL.world.floor===5&&kirafanRL.world.floorExitReady&&!kirafanRL.world.frozen")
                  and profile(page)["meta"]["storySeen"] == before_seen
                  and not page.locator('#rl-floor-load').count())
            page.wait_for_function('kirafanRL.mapview.floorShrine?.room===kirafanRL.world.room', timeout=60000)
            # Position fixture only: the real proximity gate, E input, dialog
            # cancel/confirm and transaction still own the actual departure.
            page.evaluate("""()=>{const k=kirafanRL,w=k.world,s=w.floorShrine;
                if(!s)throw Error('当前守卫房缺少离层雕像');
                w.player.x=s.x;w.player.y=s.y+1.3;k.step(1/60);}""")
            press(page, 'e'); page.locator('#rl-floor-departure').wait_for(state='visible')
            check("雕像祈愿预览不提前加载、发残页或归档",
                  page.evaluate('kirafanRL.world.floor===5&&kirafanRL.world.frozen')
                  and profile(page)["meta"]["storySeen"] == before_seen and not page.locator('#rl-floor-load').count())
            page.locator('#floor-departure-stay').click()
            check("取消祈愿可继续本层，转折仍未归档",
                  page.evaluate('kirafanRL.world.floor===5&&!kirafanRL.world.frozen') and not seen(page, 'v1_turn_5'))
            press(page, 'e'); page.locator('#floor-departure-confirm').click()
            page.wait_for_selector('#rl-floor-load[data-phase="failed"]', timeout=40000)
            check("下潜资源失败不播放或归档转折", profile(page)["meta"]["storySeen"] == before_seen
                  and page.evaluate("window.kirafanRL.world.floor") == 5
                  and not page.locator("#dialogue-box").is_visible())
            page.evaluate("""trace=>{const m=kirafanRL.mapview;window.storyLoadTrace=[];m.preloadVolume=storyPreload;
                if(!trace)return;
                for(const name of ['preloadVolume','prepareRoom']){const original=m[name];m[name]=function(...args){
                    storyLoadTrace.push({name,event:'start',time:performance.now()});
                    return original.apply(this,args).then(value=>{storyLoadTrace.push({name,event:'done',time:performance.now()});return value;},
                        error=>{storyLoadTrace.push({name,event:'error',error:error.message,time:performance.now()});throw error;});
                };}}""",args.trace_load)
            page.locator("#floor-load-retry").click()
            try:
                page.wait_for_function("window.kirafanRL.world.floor===6 && !document.getElementById('rl-floor-load')", timeout=60000)
            except Exception:
                # Capture while Playwright still owns the page; an outer
                # handler after its context closes cannot inspect the failure.
                report['descent_failure']=page.evaluate("""()=>{const k=kirafanRL,n=document.getElementById('rl-floor-load');return {
                    floor:k.world.floor,frozen:k.world.frozen,phase:n?.dataset.phase,loading:n?.textContent,
                    pending:k.pending,interactPending:k.interactPending,
                    trace:window.storyLoadTrace,
                    profile:JSON.parse(localStorage.getItem('kirafan-rl:profile')),
                    hint:document.getElementById('hint')?.textContent,status:document.getElementById('status')?.textContent};}""")
                page.screenshot(path=str(OUT/'descent-failure-live.png'))
                report['pending_requests']=list(pending_requests.values())
                report['network_failures']=network_failures[-30:]
                print(json.dumps(report['descent_failure'],ensure_ascii=False),flush=True)
                raise
            page.wait_for_selector("#dialogue-skip")
            check("第6层装配完成后触发第5层转折，期间战斗冻结", page.evaluate("window.kirafanRL.world.frozen")
                  and not seen(page, "v1_turn_5"))

            # Reload mid-dialogue: checkpoint resumes at the new floor and retries unarchived story.
            page.reload(wait_until="load")
            page.wait_for_selector("#roster-continue", timeout=60000)
            page.locator("#roster-continue").click()
            ready(page)
            page.wait_for_selector("#dialogue-skip")
            check("对白中刷新会补播未归档转折，不重播卷头", not seen(page, "v1_turn_5")
                  and page.evaluate("window.kirafanRL.world.floor") == 6)
            dismiss(page)
            check("转折读完写入持久归档", seen(page, "v1_turn_5"))
            page.reload(wait_until="load")
            page.wait_for_selector("#roster-continue", timeout=60000)
            page.locator("#roster-continue").click()
            ready(page)
            check("归档后再刷新不自动重播", not page.locator("#dialogue-box").is_visible()
                  and seen(page, "v1_turn_5"))

            open_codex(page)
            before=frozen_resources(page)
            check("有已读记录时默认列表只显示可回看的故事",page.locator('.story-record').count()==len(profile(page)['meta']['storySeen'])
                  and page.locator('.story-record.locked').count()==0)
            page.locator('#story-filter-all').click();page.locator('#story-filter-read').click()
            check("切换故事显示范围不改档案、资源或冻结",frozen_resources(page)==before and page.evaluate('kirafanRL.world.frozen'))
            page.locator('[data-story-id="chatter_rin_found"]').click()
            before = frozen_resources(page)
            for _ in range(5):
                page.locator(".story-controls button").last.click()
            check("反复回看不改变生命、金币、量能、消费记录或档案字节", frozen_resources(page) == before)
            check("故事回看期间世界持续冻结", page.evaluate("window.kirafanRL.world.frozen"))
            for width in (375, 390, 412, 430, 768, 1280):
                page.set_viewport_size({"width": width, "height": 844 if width < 768 else 840})
                page.locator('[data-story-id="v1_turn_5"]').click()
                check("桌面窄窗口故事界面边界与关闭可达 " + str(width), story_fits(page))
                check("桌面窄窗口下一句可点击 " + str(width), page.locator(".story-controls button").last.is_visible())
                page.locator(".story-controls button").last.click()
                if width in (390, 1280):
                    page.screenshot(path=str(OUT / ("stories-" + str(width) + ".png")))
            page.locator("#codex-close").focus()
            page.keyboard.press("Tab")
            check("Tab焦点留在图鉴内", page.evaluate("document.activeElement.closest('#codex-overlay') !== null"))
            page.keyboard.press("Shift+Tab")
            check("反向Tab回到关闭按钮", page.evaluate("document.activeElement.id") == "codex-close")
            page.keyboard.press("Escape")
            page.evaluate("window.kirafanRL.step(1/60)")
            check("关闭图鉴恢复冒险且不打开底层菜单", not page.locator("#codex-overlay").count()
                  and not page.evaluate("window.kirafanRL.world.frozen"))
            mobile_replay(browser, base, page.evaluate("localStorage.getItem('kirafan-rl:profile')"), errors)
            check("浏览器无未处理异常", not errors, errors)
            report['complete'] = True
            browser.close()
    except Exception as error:
        report['failure'] = str(error)
        if page and not page.is_closed():
            try:
                report['last_state'] = page.evaluate("""()=>{const k=window.kirafanRL;return {
                    floor:k?.world.floor,frozen:k?.world.frozen,room:k?.world.roomId,
                    shrineReady:k?.world.canCommuneAtShrine,pending:k?.pending,
                    loading:document.getElementById('rl-floor-load')?.textContent,
                    dialogue:document.getElementById('dialogue-box')?.textContent};}""")
                page.screenshot(path=str(OUT / 'failure.png'))
                print(json.dumps(report['last_state'], ensure_ascii=False), flush=True)
            except Exception as diagnostic_error:
                report['diagnostic_error'] = str(diagnostic_error)
        raise
    finally:
        report['source_after'] = fingerprints()
        report['changed_during_run'] = [name for name in report['source_before']
                                       if report['source_before'][name] != report['source_after'][name]]
        (OUT / ('probe-results.json' if args.probe else 'results.json')).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()


if __name__ == "__main__":
    main()
