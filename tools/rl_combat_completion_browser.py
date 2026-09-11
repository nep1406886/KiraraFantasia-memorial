"""Whole-group admission and exact-current-card cinematic browser acceptance.

Real keyboard input; manual simulation is not a performance measurement.
--probe disables only admission in the HTTP response (never on disk).
"""
import argparse
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, press, dismiss

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp/t30-completion"
PATTERNS = [("aimed", {"count": 3}, 3), ("fan", {"count": 5}, 5),
            ("ring", {"count": 12}, 12), ("spiral", {"arms": 3, "steps": 6}, 18),
            ("volley", {"count": 3}, 3), ("wave", {"count": 3}, 3),
            ("cross", {"count": 2}, 8), ("wall", {"count": 7}, 7)]
checks = []


def check(label, condition, detail=None):
    if not condition:
        raise AssertionError(label + ": " + str(detail))
    checks.append(label)
    print("PASS " + label, flush=True)


def open_card(browser, base, card_id, errors, route=None):
    context = browser.new_context(viewport={"width": 1280, "height": 840}, has_touch=True)
    context.add_init_script("""window.requestAnimationFrame=()=>0;
        window.cancelAnimationFrame=()=>{};
        localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    if route:
        route(page)
    page.goto(base + "/site/game/roguelike.html?volume=1&seed=300908", wait_until="load", timeout=60000)
    page.wait_for_selector(".roster-card", timeout=60000)
    page.locator(".roster-card").filter(has=page.locator('img[src$="/%d.webp"]' % card_id)).click()
    page.wait_for_function("window.kirafanRL?.world?.player && window.kirafanRL.pending===0", polling=100, timeout=60000)
    dismiss(page)
    advance(page, 1/60)
    check(str(card_id) + " 从正常选角进入实际卡片", page.evaluate("window.kirafanRL.world.player.card.id") == card_id)
    return context, page


def reserve(page, free):
    return page.evaluate("""free => {
        const k=window.kirafanRL,d=k.world.danmaku;
        d.clear();d.resetDropped();
        const count=d.capacity-free;
        d.emit('aimed',{x:1,y:1,angle:0},{count,speed:0,life:30,stepDelay:0,srcId:999999});
        // Pending fixture shots occupy capacity without obscuring the tested group.
        d.forEach(b=>b.delay=100);
        k.step(0);
        return d.active;
    }""", free)


def counters(page):
    return page.evaluate("""() => {
        const k=window.kirafanRL,d=k.world.danmaku,v=k.views.danmaku;
        let ready=0,native=0;d.forEach(b=>{if(b.delay===0){ready++;
            if(k.effects.projectileVisualReady(b))native++;}});
        return {active:d.active,ready,rejected:d.rejectedGroups,dropped:d.dropped,
            rendered:v.count+v.streakCount+native,generic:v.count+v.streakCount,native,
            work:k.world.player.skills.slots[1].remaining};
    }""")


def admission(browser, base, errors, probe):
    def route(page):
        source=(ROOT/"site/game/rl/danmaku.js").read_text(encoding="utf-8")
        needle="if (required > pool.free) {"
        assert source.count(needle)==1
        page.route("**/rl/danmaku.js", lambda request: request.fulfill(content_type="text/javascript",
            body="window.__admissionProbe=true;\n"+source.replace(needle,"if (false && required > pool.free) {")))
    context,page=open_card(browser,base,23002001,errors,route if probe else None)
    try:
        for pattern,mods,need in PATTERNS:
            occupied=reserve(page,need-1)
            made=page.evaluate("""([pattern,mods])=>{
                const k=window.kirafanRL,p=k.world.player;
                const made=k.world.danmaku.emit(pattern,{x:p.x,y:p.y,angle:0},{...mods,stepDelay:0,offset:1,side:'enemy'});
                k.step(0);return made;
            }""",[pattern,mods])
            seen=counters(page)
            if probe:
                check(pattern+" 负面对照检出半组弹", made==need-1 and seen['rendered']==need-1,seen)
                continue
            check(pattern+" 缺一格时逻辑整组拒绝",made==0 and seen['active']==occupied and seen['dropped']==need and seen['rejected']==1,seen)
            check(pattern+" 渲染未出现虚假半组",seen['rendered']==0 and seen['ready']==0,seen)
            reserve(page,need)
            page.evaluate("""([pattern,mods])=>{
                const k=window.kirafanRL,p=k.world.player;
                k.world.danmaku.emit(pattern,{x:p.x,y:p.y,angle:0},{...mods,stepDelay:0,offset:1,side:'enemy'});
                k.step(0);
            }""",[pattern,mods])
            seen=counters(page)
            check(pattern+" 刚好容纳时逻辑与显示均完整",seen['ready']==need and seen['rendered']==need and seen['rejected']==0,seen)
        if probe:
            check("负面对照确实加载修改响应",page.evaluate("window.__admissionProbe===true"))
            return
        occupied=reserve(page,11)
        press(page,"Digit2")
        seen=counters(page)
        check("真实技能输入消耗冷却但不产生半环",seen['work']>0 and seen['active']==occupied and seen['rendered']==0 and seen['rejected']==1,seen)
        advance(page,.6)
        page.evaluate("window.kirafanRL.world.player.skills.slots[1].remaining=0")
        reserve(page,12)
        press(page,"Digit2")
        seen=counters(page)
        check("空间恢复后真实技能输入发射完整十二弹",seen['work']>0 and seen['ready']==12 and seen['rendered']==12 and seen['rejected']==0,seen)
        advance(page,.25)
        page.screenshot(path=str(OUT/"complete-player-ring.png"))
    finally:
        context.close()


def scene_identity(browser,base,errors,fail_scene=False):
    requested=[]
    def route(page):
        page.on("request",lambda request: requested.append(request.url) if "/uniqueskill/scene/" in request.url or "/uniqueskill/timeline/" in request.url else None)
        if fail_scene:
            page.route("**/uniqueskill/scene/380004.glb.gz*",lambda request:request.fulfill(status=503,body="fixture missing scene"))
    context,page=open_card(browser,base,38002001,errors,route)
    label="缺场景回退" if fail_scene else "精确场景"
    try:
        page.evaluate("""()=>{
            const w=window.kirafanRL.world,p=w.player,art=w.encounter.mobs[0];
            window.__sceneTarget=w.spawnEnemy({x:p.x+4,y:p.y,hp:1000000,atk:1,def:0,mdef:0,
                model:art.model,nameZh:art.nameZh,shadowScale:art.shadowScale});
            window.__sceneTarget.actionTimer=1e9;p.iframes=1000;p.skills.addGauge(1e9);
        }""")
        advance(page,1/60)
        page.wait_for_function("window.kirafanRL.pending===0",polling=100,timeout=30000)
        press(page,"KeyR")
        page.wait_for_function("!window.kirafanRL.ultimate.loading",polling=100,timeout=60000)
        hp=page.evaluate("window.__sceneTarget.hp")
        check(label+" 真实必杀输入已结算伤害并扣量能",hp<1000000 and page.evaluate("window.kirafanRL.world.player.skills.gauge")==0,hp)
        check(label+" 只请求当前卡的380004场景和时间轴",any("/scene/380004.glb.gz" in url for url in requested) and any("/timeline/380004.json" in url for url in requested) and not any("380002" in url for url in requested),requested)
        if fail_scene:
            check("缺场景仍保留一次效果并解除冻结",page.evaluate("!window.kirafanRL.ultimate.stage && !window.kirafanRL.world.frozen"))
        else:
            check("精确演出实际装配并保留进化服装",page.evaluate("!!window.kirafanRL.ultimate.stage && window.kirafanRL.ultimate.actor.resourceId==='380004'"))
            for frame in (0,30,90):
                page.evaluate("frame=>{window.kirafanRL.ultimate.stage.seek(frame);window.kirafanRL.renderOnce()}",frame)
                check("演出采样不重放战斗效果 "+str(frame),page.evaluate("window.__sceneTarget.hp")==hp)
            page.screenshot(path=str(OUT/"mira-exact-380004.png"))
            page.locator(".rl-ultimate-skip").click()
            check("真实跳过释放演出与冻结",page.evaluate("!window.kirafanRL.ultimate.stage && !window.kirafanRL.world.frozen"))
        advance(page,.6)
        press(page,"KeyR")
        check(label+" 量能不足的重复输入不能二次结算",page.evaluate("window.__sceneTarget.hp")==hp and page.evaluate("!window.kirafanRL.ultimate.stage"))
        return {"mode":label,"hp":hp,"requests":requested}
    finally:
        context.close()


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--probe",action="store_true")
    args=parser.parse_args();OUT.mkdir(parents=True,exist_ok=True)
    server=Server(("127.0.0.1",0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    base="http://127.0.0.1:%d" % server.server_address[1]
    errors=[];scenes=[]
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(args=["--use-gl=angle","--enable-unsafe-swiftshader"])
            try:
                admission(browser,base,errors,args.probe)
                if not args.probe:
                    scenes=[scene_identity(browser,base,errors),scene_identity(browser,base,errors,True)]
                check("没有浏览器脚本异常",not errors,errors)
                name="probe.json" if args.probe else "browser.json"
                (OUT/name).write_text(json.dumps({"checks":checks,"browser":browser.version,"errors":errors,
                    "manualSimulation":True,"scenes":scenes},ensure_ascii=False,indent=2),encoding="utf-8")
                print("Completion browser: %d checks passed"%len(checks),flush=True)
            finally:
                browser.close()
    finally:
        server.shutdown();server.server_close();worker.join(timeout=2)


if __name__=="__main__":
    main()
