"""Real input and GPU placement checks for the shared combat plane.

Controlled room placement, target health and enemy scheduling are fixtures, not
balance evidence. Mouse input and normal attacks still traverse the actual page.
--observe records all mismatches and exits nonzero instead of stopping at first.
"""
import argparse
import functools
import hashlib
import json
import math
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss, press

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "hit-alignment"


def fingerprints():
    paths = (list((ROOT / "game/rl").rglob("*.js")) + list((ROOT / "game/rl").rglob("*.css"))
             + list((ROOT / "core").glob("*.js")) + [ROOT / "site/game/roguelike.html"])
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


SETUP = """async missing => {
    const k=kirafanRL,w=k.world,p=w.player;
    window.hitT=(await (await import('/site/core/loader.js')).loadModules()).THREE;
    try { await k.effects.prepare(p); } catch(error) { if(!missing)throw error; }
    const room=w.dungeon.rooms.find(r=>r.type==='battle');
    if(!room)throw Error('battle fixture missing');
    w.enterRoom(room.id);k.step(0);
    p.iframes=1e9;
    w.enemies.forEach(e=>e.actionTimer=1e9);
    window.hitEvents=[];window.impactRecords=[];
    const drain=w.drainEvents;w.drainEvents=function(){const events=drain.call(this);
        for(const e of events)if(e.type==='hit')hitEvents.push({targetId:e.target.id,side:e.target.kind,
            bullet:!!e.bullet,damage:e.damage,impact:e.impact?JSON.parse(JSON.stringify(e.impact)):null,
            target:{x:e.target.x,y:e.target.y,radius:e.target.radius}});return events;};
    const emit=k.effects.emitHitImpact;k.effects.emitHitImpact=function(...args){
        const result=emit.apply(this,args);impactRecords.push(result);return result;};
}"""

RESET = """({angle,distance}) => {
    const k=kirafanRL,w=k.world,p=w.player,e=w.enemies[0];
    if(!e)throw Error('target fixture missing');
    k.input.clear();w.danmaku.clear();k.effects.clear();w.hitStop=0;
    p.x=w.width/2;p.y=w.height/2;p.sm.force('idle');p.actionBuffer=null;p.castOnly=false;
    p.heldAttack=false;p.iframes=1e9;p.kx=p.ky=0;
    for(const [i,enemy] of w.enemies.entries()){
        enemy.x=i?2:p.x+Math.cos(angle)*distance;enemy.y=i?2:p.y+Math.sin(angle)*distance;
        enemy.hp=enemy.maxHp=1000000;enemy.dead=false;enemy.iframes=0;enemy.sm.force('idle');
        enemy.actionTimer=1e9;enemy.kx=enemy.ky=0;enemy.stun=enemy.stunTimer=0;
    }
    k.step(0);hitEvents.length=0;impactRecords.length=0;
    const rect=k.renderer.domElement.getBoundingClientRect();
    const point=new hitT.Vector3(e.x,1,e.y).project(k.camera);
    const screen={x:rect.left+(point.x+1)*rect.width/2,y:rect.top+(1-point.y)*rect.height/2};
    return {screen,target:{id:e.id,x:e.x,y:e.y,radius:e.radius},player:{x:p.x,y:p.y},
        visible:point.z>=-1&&point.z<=1&&point.x>-1&&point.x<1&&point.y>-1&&point.y<1};
}"""


def gameplay(browser, base, card, observe, report, check, missing=False, directions=8, angle_offset=0):
    context = browser.new_context(viewport={"width": 1280, "height": 840}, has_touch=False)
    context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
        localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
    page = context.new_page()
    page.on("pageerror", lambda error: report["errors"].append(str(error)))
    faults = []
    if missing:
        def refuse(route):
            faults.append(route.request.url)
            route.fulfill(status=503, body="injected original attack asset failure")
        page.route("**/ef_btl_*_attack_*.glb.gz", refuse)
    image_name = str(card) + ("-missing" if missing else "")
    try:
        page.goto(base + "/site/game/roguelike.html?volume=1&seed=28121", wait_until="load", timeout=60000)
        page.locator('.roster-card').filter(has=page.locator('img.art[src$="/%d.webp"]' % card)).click(timeout=60000)
        page.wait_for_function("kirafanRL?.world?.player&&kirafanRL.pending===0", polling=50, timeout=60000)
        dismiss(page)
        page.evaluate(SETUP, missing)
        page.wait_for_function("kirafanRL.pending===0&&!kirafanRL.roomLoading", polling=50, timeout=60000)
        advance(page, 1)
        profile = page.evaluate("kirafanRL.world.player.weaponProfile")
        check("真实选角与空装备职业保持一致 %d" % card, page.evaluate("kirafanRL.world.player.card.id") == card
              and page.evaluate("kirafanRL.world.player.equipment.length") == 0, profile)
        for height in [5.5, 9, 13]:
            press(page, "Escape")
            page.locator("#menu-cam").fill(str(int(height * 10)))
            page.locator("#menu-resume").click()
            for index in range(directions):
                angle = index * math.tau / directions + angle_offset
                fixture = page.evaluate(RESET, {"angle": angle, "distance": 2.4 if profile["kind"] == "projectile" else 2})
                check("测量点位于实际战场内 %d %.1f %d" % (card, height, index), fixture["visible"], fixture)
                page.mouse.move(fixture["screen"]["x"], fixture["screen"]["y"])
                page.mouse.down()
                page.evaluate("window.hitAimCamera=kirafanRL.camera.clone()")
                advance(page, 1 / 60)
                page.mouse.up()
                row = page.evaluate("""()=>{const k=kirafanRL,r=k.renderer.domElement.getBoundingClientRect(),
                    aim=k.world.aim,pointer=k.input.state.pointer,
                    v=aim?new hitT.Vector3(aim.x,1,aim.y).project(hitAimCamera):null;
                    const screen=q=>q?{x:r.left+(q.x+1)*r.width/2,y:r.top+(1-q.y)*r.height/2}:null;
                    return {aim,aim_screen:screen(v),pointer_screen:screen(pointer),
                        facing:k.world.player.facing,attack:k.world.player.sm.state};}""")
                row.update({"card": card, "height": height, "direction": index, "fixture": fixture})
                aim = row["aim"]
                row["aim_error"] = math.hypot(aim["x"] - fixture["target"]["x"], aim["y"] - fixture["target"]["y"]) if aim else None
                # Chromium mouse client coordinates may be integer pixels. Test
                # exact reprojection to the dispatched pointer, not a fixed
                # world tolerance that spuriously fails when zooming out.
                row["projection_error_px"] = math.hypot(row["aim_screen"]["x"] - row["pointer_screen"]["x"],
                    row["aim_screen"]["y"] - row["pointer_screen"]["y"]) if aim else None
                check("真实鼠标瞄准与弹体显示平面一致 %d %.1f %d" % (card, height, index),
                      aim is not None and row["projection_error_px"] < 1e-5
                      and abs(row["aim_screen"]["x"] - fixture["screen"]["x"]) < 1.01
                      and abs(row["aim_screen"]["y"] - fixture["screen"]["y"]) < 1.01, row)
                expected_facing = math.atan2(aim['y'] - fixture['player']['y'], aim['x'] - fixture['player']['x']) if aim else None
                check("攻击朝向保留连续角度而不取整 %d %.1f %d" % (card, height, index),
                      expected_facing is not None and abs(math.atan2(math.sin(row['facing'] - expected_facing),
                      math.cos(row['facing'] - expected_facing))) < 1e-10, row)
                samples = []
                # Yield between actual steps so original effects can instantiate
                # during flight, rather than finishing an entire shot in one JS call.
                for tick in range(48):
                    advance(page, 1 / 60)
                    sample = page.evaluate("""()=>{const k=kirafanRL,shots=[];k.world.danmaku.forEach(b=>{
                        if(b.side==='player'&&b.delay<=0)shots.push(b);});
                        return {shots:shots.length,native:shots.filter(b=>k.effects.projectileVisualReady(b)).length,
                            fallback:k.views.danmaku.count+k.views.danmaku.streakCount};}""")
                    if sample["shots"]:
                        samples.append(sample)
                        if height == 9 and index == 0 and len(samples) == 2:
                            page.screenshot(path=str(OUT / ("observe-" if observe else "current-") / (image_name + "-flight.png")))
                if profile["kind"] == "projectile":
                    # Alchemist's original normal has caster EffectPlay/Attach,
                    # not projectile art. Its realtime thrown core stays generic;
                    # only magician/priest have a verified carried original here.
                    carried_original = profile["classId"] in (1, 2) and not missing
                    check("普攻飞行全程有且仅有一份弹体显示 %d %.1f %d" % (card, height, index),
                          bool(samples) and all(s["shots"] == s["native"] + s["fallback"] for s in samples)
                          and (any(s["native"] > 0 for s in samples) if carried_original else all(s["native"] == 0 for s in samples)), samples)
                hits = page.evaluate("hitEvents")
                row["hits"] = hits
                row["flight"] = samples
                check("实际普攻命中瞄准点而非脚后地面 %d %.1f %d" % (card, height, index),
                      any(hit["targetId"] == fixture["target"]["id"] for hit in hits), row)
                report["aim"].append(row)
                if height == 9 and index == 0:
                    page.screenshot(path=str(OUT / ("observe-" if observe else "current-") / (image_name + "-aim.png")))
        # Incoming enemy shot uses the same collision and presentation plane.
        page.evaluate(RESET, {"angle": 0, "distance": 3})
        incoming = page.evaluate("""()=>{const k=kirafanRL,w=k.world,p=w.player;
            p.iframes=0;w.danmaku.clear();k.effects.clear();impactRecords.length=0;hitEvents.length=0;
            w.danmaku.emit('aimed',{x:p.x-1.2,y:p.y,angle:0},{count:1,offset:0,side:'enemy',power:1,coef:1,
                radius:.18,speed:12,life:1,srcId:w.enemies[0].id});
            for(let i=0;i<30&&!hitEvents.length;i++)k.step(1/60);
            return {hits:hitEvents,expected:{x:p.x-p.radius,y:p.y},effects:k.effects.stats};}""")
        page.wait_for_function("impactRecords.some(record=>record?.instance)", polling=50, timeout=30000)
        incoming["placements"] = page.evaluate("""()=>impactRecords.filter(Boolean).map(r=>({
            x:r.instance?.root.position.x,height:r.instance?.root.position.y,y:r.instance?.root.position.z}))""")
        report["incoming"].append(incoming)
        point = incoming["hits"][0]["impact"] if incoming["hits"] else None
        check("玩家受击火花使用真实接触点而非当前脚点", point is not None
              and math.hypot(point["x"] - incoming["expected"]["x"], point["y"] - incoming["expected"]["y"]) < 1e-6
              and all(math.hypot(r["x"] - point["x"], r["y"] - point["y"]) < 1e-6 for r in incoming["placements"]), incoming)
        check("单次敌方碰撞只结算一次玩家受击", len(incoming["hits"]) == 1
              and incoming["hits"][0]["damage"] == 1, incoming)
        check("玩家受击火花与可见弹体同高", bool(incoming["placements"])
              and all(abs(r["height"] - 1) < 1e-6 for r in incoming["placements"]), incoming)
        advance(page, .06)
        page.screenshot(path=str(OUT / ("observe-" if observe else "current-") / (image_name + "-incoming.png")))
        if missing:
            check("原作素材确实失败且回退仍完成真实命中", bool(faults), faults)
        report["cases"].append({"card": card, "missing": missing, "profile": profile, "faults": faults})
    except Exception:
        page.screenshot(path=str(OUT / "failure.png"))
        raise
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--observe", action="store_true")
    parser.add_argument("--card", type=int, default=23002001)
    parser.add_argument("--all-classes", action="store_true")
    parser.add_argument("--missing", action="store_true")
    parser.add_argument("--directions", type=int, default=8)
    parser.add_argument("--angle-offset", type=float, default=0)
    args = parser.parse_args()
    if not 4 <= args.directions <= 360 or not math.isfinite(args.angle_offset):
        parser.error('directions must be 4..360 and angle-offset finite radians')
    (OUT / ("observe-" if args.observe else "current-")).mkdir(parents=True, exist_ok=True)
    if args.all_classes and args.missing:
        parser.error("Use --missing with one ranged --card, not melee class fixtures")
    report = {"complete": False, "checks": [], "cases": [], "aim": [], "incoming": [], "errors": [], "source_before": fingerprints()}

    def check(label, ok, detail=None):
        report["checks"].append({"label": label, "ok": bool(ok), "detail": detail})
        print(("PASS " if ok else "FAIL ") + label, flush=True)
        if not ok and not args.observe:
            raise AssertionError(label + ": " + str(detail))

    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])
            report["browser"] = browser.version
            for card in ([14002001, 23002001, 32002001, 11012001, 32172001] if args.all_classes else [args.card]):
                gameplay(browser, "http://127.0.0.1:%d" % server.server_address[1], card, args.observe, report, check,
                         args.missing, args.directions, args.angle_offset)
            check("命中对齐验证无未处理页面异常", not report["errors"], report["errors"])
            report["complete"] = True
            browser.close()
    except Exception as error:
        report["failure"] = str(error)
        raise
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()
        report["source_after"] = fingerprints()
        report["changed_during_run"] = [p for p in report["source_before"].keys() | report["source_after"].keys()
                                         if report["source_before"].get(p) != report["source_after"].get(p)]
        filename = "observe.json" if args.observe else "five-class.json" if args.all_classes else "missing.json" if args.missing else "report.json"
        (OUT / filename).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return int(any(not c["ok"] for c in report["checks"]))


if __name__ == "__main__":
    raise SystemExit(main())
