"""Real GPU ground-area parity, bounded disposal, five bosses and phone HUD.

Manual stepping is a deterministic presentation audit, not an FPS benchmark.
"""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".codex-tmp" / "boss-choreography"

SETUP = r"""async () => {
    const {THREE:T}=await (await import('/site/core/loader.js')).loadModules();
    const {createEnemyTelegraphs}=await import('/site/game/rl/view/enemytelegraphs.js');
    const scene=new T.Scene();scene.background=new T.Color('#18232b');
    const renderer=new T.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});
    renderer.setSize(800,600);renderer.setPixelRatio(1);document.body.append(renderer.domElement);
    const camera=new T.OrthographicCamera(-10,10,7.5,-7.5,.1,100);
    camera.position.set(0,20,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
    const view=createEnemyTelegraphs(scene,T),world={player:{dead:false},enemies:[]};
    const render=()=>{scene.updateMatrixWorld(true);renderer.render(scene,camera)};
    const sample=(x,y)=>{const p=new T.Vector3(x,.035,y).project(camera),gl=renderer.getContext(),pixel=new Uint8Array(4);
        gl.readPixels(Math.floor((p.x+1)*400),Math.floor((p.y+1)*300),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];};
    render();const background=sample(0,0);
    const foreground=(x,y)=>sample(x,y).slice(0,3).reduce((n,c,i)=>n+Math.abs(c-background[i]),0)>20;
    const action=(shapes,stage='windup')=>Object.freeze({stage,age:.5,move:Object.freeze({warning:1}),
        shapes:Object.freeze(shapes.map(shape=>Object.freeze(shape)))});
    const show=(shapes,stage='windup')=>{const a=action(shapes,stage);
        world.enemies=[Object.freeze({dead:false,stunTimer:0,action:a})];view.sync(world);render();return a;};
    window.audit={T,scene,renderer,camera,view,world,render,sample,foreground,show,action};
}"""

AREA_PIXELS = r"""() => {
    const a=audit,rows=[];
    const rotate=(x,y,t)=>({x:x*Math.cos(t)-y*Math.sin(t),y:x*Math.sin(t)+y*Math.cos(t)});
    for(let i=0;i<8;i++) {
        const angle=i*Math.PI/4;
        const cases=[
            {shape:{kind:'disc',x:0,y:0,radius:2},inside:[[0,0],[1.9,0]],outside:[[2.1,0],[0,2.1]]},
            {shape:{kind:'annulus',x:0,y:0,inner:1,outer:3},inside:[[2,0],[2.9,0]],outside:[[0,0],[.9,0],[3.1,0]]},
            {shape:{kind:'sector',x:0,y:0,radius:4,angle,arc:Math.PI/2},inside:[[2,0],[3.8,0]],outside:[[0,2],[-.6,0],[4.1,0]]},
            {shape:{kind:'lane',x1:-2*Math.cos(angle),y1:-2*Math.sin(angle),x2:2*Math.cos(angle),y2:2*Math.sin(angle),radius:.6},
                inside:[[0,0],[2.4,.2]],outside:[[2.55,.4],[0,.7],[-2.55,-.4]]}
        ];
        for(const row of cases){const action=a.show([row.shape]);
            const inside=row.inside.map(([x,y])=>{const p=rotate(x,y,angle);return a.foreground(p.x,p.y)});
            const outside=row.outside.map(([x,y])=>{const p=rotate(x,y,angle);return a.foreground(p.x,p.y)});
            rows.push({kind:row.shape.kind,angle,inside,outside,
                sameArea:a.view.object.children[0].children[0].userData.enemyArea===action.shapes[0]});
        }
    }
    a.show([{kind:'lane',x1:0,y1:0,x2:0,y2:0,radius:.6}]);
    const zero={inside:a.foreground(0,0),outside:a.foreground(.7,0)};
    a.show([{kind:'disc',x:0,y:0,radius:2}]);
    const warning=a.sample(0,0);a.view.object.visible=false;a.render();
    const hidden=a.foreground(0,0);a.view.object.visible=true;a.render();const restored=a.foreground(0,0);
    a.show([{kind:'disc',x:0,y:0,radius:2}],'active');const active=a.sample(0,0);
    a.show([{kind:'disc',x:0,y:0,radius:2}],'recover');const recovering=a.foreground(0,0);
    return {rows,zero,hidden,restored,warning,active,recovering};
}"""

LIFETIME = r"""() => {
    const a=audit,resources=new Map(),memory=[],shapes=[];
    for(let i=0;i<3;i++)shapes.push({kind:'disc',x:(i-1)*3,y:0,radius:1});
    const track=()=>a.view.object.traverse(node=>{for(const resource of [node.geometry,node.material].flat()){
        if(!resource||resources.has(resource))continue;resources.set(resource,0);
        resource.addEventListener('dispose',()=>resources.set(resource,resources.get(resource)+1));
    }});
    a.world.enemies=[];a.view.sync(a.world);a.render();const baseline=a.renderer.info.memory.geometries;
    let maxCalls=0,maxGeometries=0;
    for(let i=0;i<40;i++){
        a.world.enemies=[{dead:false,stunTimer:0,action:a.action(shapes)},
            {dead:false,stunTimer:0,action:a.action(shapes.map(s=>({...s,y:3})))}];
        a.view.sync(a.world);a.render();track();
        maxCalls=Math.max(maxCalls,a.renderer.info.render.calls);
        maxGeometries=Math.max(maxGeometries,a.renderer.info.memory.geometries);
        if(a.view.count!==2||a.view.shapeCount!==6)throw Error('view budget mismatch');
        a.world.enemies[0].dead=true;a.world.enemies[1].stunTimer=1;
        a.view.sync(a.world);a.render();memory.push(a.renderer.info.memory.geometries);
    }
    a.show(shapes);track();a.view.dispose();a.view.dispose();a.view.sync(a.world);a.render();
    return {baseline,maxCalls,maxGeometries,memory,resources:resources.size,
        singleRelease:[...resources.values()].every(n=>n===1),detached:!a.view.object.parent,
        finalCount:a.view.count,finalGeometries:a.renderer.info.memory.geometries};
}"""

FRAME_DIFF = r"""() => {
    const k=kirafanRL,root=k.views.telegraphs.object,gl=k.renderer.getContext(),width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
    const capture=visible=>{root.visible=visible;k.renderOnce();const pixels=new Uint8Array(width*height*4);
        gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels};
    const on=capture(true),off=capture(false);root.visible=true;k.renderOnce();
    let changed=0;for(let i=0;i<on.length;i+=16)if(Math.abs(on[i]-off[i])+Math.abs(on[i+1]-off[i+1])+Math.abs(on[i+2]-off[i+2])>12)changed++;
    return {changed,width,height};
}"""


def dismiss_for_input(page,touch):
    if not touch:
        dismiss(page)
        return
    for _ in range(60):
        if not page.locator('#dialogue-box').is_visible():return
        page.locator('#dialogue-skip').tap()
        page.wait_for_timeout(30)
    raise AssertionError('touch dialogue did not close')


def gameplay(browser, base, volume, viewport, touch, report, check, floor=20):
    label="vol%d-floor%d-%dx%d" % (volume,floor,viewport["width"],viewport["height"])
    context=browser.new_context(viewport=viewport,has_touch=touch,is_mobile=touch)
    context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
        localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
    try:
        page=context.new_page();page.on("pageerror",lambda e:report["errors"].append(str(e)))
        page.on("console",lambda message:report["console"].append(label+": "+message.text)
            if message.type in ["warning","error"] and len(report["console"])<200 else None)
        page.goto(base+'/site/game/roguelike.html?seed=73061&volume=%d&floor=%d' % (volume,floor),wait_until="load",timeout=60000)
        page.wait_for_selector('.roster-card',timeout=60000)
        card=page.locator('.roster-card').filter(has=page.locator('img[src$="/14002001.webp"]'))
        if touch:card.tap()
        else:card.click()
        page.wait_for_function('window.kirafanRL?.world?.player && kirafanRL.pending===0',polling=100,timeout=60000)
        dismiss_for_input(page,touch)
        # With rAF held, boot has not consumed its foyer-room event yet.
        # Pump that frame before the explicit boss-room fixture transition.
        advance(page,1/60)
        page.evaluate("""()=>{const k=kirafanRL,w=k.world;window.__oldMap=k.mapview.group?.uuid;
            w.enterRoom(w.dungeon.rooms.find(r=>r.type==='boss').id);k.step(0);} """)
        dismiss_for_input(page,touch)
        page.wait_for_function('kirafanRL.pending===0 && kirafanRL.mapview.group && kirafanRL.mapview.group.uuid!==window.__oldMap',polling=100,timeout=60000)
        # The reveal fade runs on the real clock; boss dialogue is pumped only
        # after it. Wait for either the dialogue or the unfreeze, clear any
        # dialogue, then wait for the reveal freeze to actually release.
        page.wait_for_function("""() => !kirafanRL.world.frozen
            || document.getElementById('dialogue-box')?.checkVisibility() === true""",polling=100,timeout=60000)
        dismiss_for_input(page,touch)
        page.wait_for_function('!kirafanRL.world.frozen',polling=100,timeout=60000)
        page.evaluate("""()=>{const k=kirafanRL,w=k.world,e=w.enemies[0];
            w.player.x=e.x-3.2;w.player.y=e.y;w.player.iframes=0;e.actionTimer=1000000;
            k.input.clear();w.hitStop=0;k.step(1/60);} """)
        advance(page,.8)
        page.evaluate('kirafanRL.world.enemies[0].actionTimer=0')
        advance(page,1/60)
        advance(page,.35)
        snapshot=page.evaluate("""async()=>{const k=kirafanRL,w=k.world,e=w.enemies[0],bar=document.querySelector('#boss-bar');
            const {THREE:T}=await (await import('/site/core/loader.js')).loadModules();
            const project=u=>{const p=new T.Vector3(u.x,.035,u.y).project(k.camera);return {x:p.x,y:p.y}};
            const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
            const advice=bar.querySelector('.boss-counter');
            return {enemyId:e.enemyId,kind:e.kind,stage:e.action?.stage,count:k.views.telegraphs?.count,shapes:k.views.telegraphs?.shapeCount,
                label:e.action?.move.label,counter:e.action?.move.counter,readout:bar.querySelector('.boss-readout').textContent,
                advice:advice?.textContent,adviceVisible:!!advice&&!advice.hidden,bar:rect(bar),hud:rect(document.querySelector('#hud')),
                minimap:rect(document.querySelector('#minimap')),pause:rect(document.querySelector('.hud-pause')),
                stageBox:rect(document.querySelector('#stage')),overflow:advice.scrollWidth>advice.clientWidth+1,
                loadedModels:k.views.enemies.map(v=>({id:v.unit.enemyId,model:v.unit.model})),
                graphHidden:getComputedStyle(document.querySelector('.minimap-graph')).display==='none',
                touch:document.body.classList.contains('touch-on'),playerPoint:project(w.player),enemyPoint:project(e),
                rotationY:k.views.enemies.find(v=>v.unit===e)?.object.rotation.y,frozen:w.frozen};} """)
        report["gameplay"][label]=snapshot
        check(label+" 正常入口显示同源预警与原作敌人模型",snapshot.get("stage")=="windup" and snapshot.get("count")==1 and snapshot["shapes"]>0 and snapshot["rotationY"] is not None and abs(snapshot["rotationY"])<1e-9)
        check(label+" 招式名、剩余秒数与反制在血条可读",snapshot["label"] is not None and snapshot["label"] in snapshot["readout"] and snapshot["advice"]==snapshot["counter"] and snapshot["adviceVisible"] and not snapshot["overflow"])
        check(label+" 输入模式与真实鼠标或触摸一致",snapshot["touch"]==touch)
        check(label+" 近距离玩家与首领的脚下位置都在视野内",all(abs(snapshot[key]["x"])<.95 and abs(snapshot[key]["y"])<.95 for key in ["playerPoint","enemyPoint"]))
        diff=page.evaluate(FRAME_DIFF);snapshot["frameDiff"]=diff
        check(label+" 开关预警的真实帧缓冲存在区域差异",diff["changed"]>=40)
        box=snapshot["bar"];stage=snapshot["stageBox"]
        overlap=lambda other: min(box["right"],other["right"])-max(box["x"],other["x"])>1 and min(box["bottom"],other["bottom"])-max(box["y"],other["y"])>1
        check(label+" 首领面板不越界、不遮挡状态、小地图或暂停",box["x"]>=stage["x"]-1 and box["right"]<=stage["right"]+1 and box["bottom"]<=stage["bottom"] and not any(overlap(snapshot[key]) for key in ["hud","minimap","pause"]))
        if touch and viewport["height"]<=480:check(label+" 横屏首领战收起路线图，为角色保留画面",snapshot["graphHidden"])
        page.screenshot(path=str(OUT/(label+'-warning.png')))
        active=page.evaluate("""()=>{const k=kirafanRL,e=k.world.enemies[0];for(let i=0;i<180&&e.action?.stage!=='active';i++)k.step(1/60);
            return {stage:e.action?.stage,count:k.views.telegraphs.count};} """)
        check(label+" 执行阶段保留红色危险区域",active["stage"]=="active" and active["count"]==1)
        if volume==4 and not touch:page.screenshot(path=str(OUT/(label+'-active.png')))
        recovered=page.evaluate("""()=>{const k=kirafanRL,e=k.world.enemies[0];for(let i=0;i<180&&e.action?.stage!=='recover';i++)k.step(1/60);
            return {stage:e.action?.stage,count:k.views.telegraphs.count,readout:document.querySelector('.boss-readout').textContent};} """)
        check(label+" 恢复期立即撤去危险区域并显示反击窗口",recovered["stage"]=="recover" and recovered["count"]==0 and "破绽" in recovered["readout"])
        retired=page.evaluate("""()=>{const k=kirafanRL,e=k.world.enemies[0],view=k.views.enemies[0];
            k.world.enterRoom(k.world.dungeon.start);k.step(0);
            return {cancelled:e.action===null,count:k.views.telegraphs.count,detached:!!view&&!view.object.parent,
                graphHidden:getComputedStyle(document.querySelector('.minimap-graph')).display==='none'};} """)
        check(label+" 离房清除旧承诺和旧模型",retired["cancelled"] and retired["count"]==0 and retired["detached"])
        if touch and viewport["height"]<=480:check(label+" 离开首领战恢复路线图",not retired["graphHidden"])
    finally:
        context.close()


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    report={"checks":[],"errors":[],"gameplay":{},"console":[]}
    def check(name,ok):
        report["checks"].append({"name":name,"ok":bool(ok)})
        print(("PASS " if ok else "FAIL ")+name,flush=True)
    with Server(("127.0.0.1",0),functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(args=["--use-gl=angle","--enable-unsafe-swiftshader"])
                report["browser"]=browser.version
                page=browser.new_page(viewport={"width":800,"height":600})
                page.on("pageerror",lambda e:report["errors"].append(str(e)))
                page.route("**/enemy-telegraph-audit.html",lambda r:r.fulfill(content_type="text/html",body='<html><body style="margin:0"></body></html>'))
                base='http://127.0.0.1:%d' % server.server_address[1]
                page.goto(base+'/enemy-telegraph-audit.html');page.evaluate(SETUP)
                pixels=page.evaluate(AREA_PIXELS);report["pixels"]=pixels
                check("四类区域八方向实际像素与独立内外点一致",all(all(row["inside"]) and not any(row["outside"]) and row["sameArea"] for row in pixels["rows"]))
                check("零长度冲刺仍是可见圆端，不产生退化几何",pixels["zero"]["inside"] and not pixels["zero"]["outside"])
                check("关闭预警的负面对照确实被像素门禁拒绝",not pixels["hidden"] and pixels["restored"])
                check("预警橙色、执行红色、恢复无危险区域",pixels["warning"]!=pixels["active"] and not pixels["recovering"])
                page.evaluate("audit.show([{kind:'annulus',x:0,y:0,inner:2,outer:5}])")
                page.screenshot(path=str(OUT/'geometry-annulus.png'))
                lifetime=page.evaluate(LIFETIME);report["lifetime"]=lifetime
                check("双威胁六区域绘制有界，40次循环无GPU几何增长",lifetime["maxCalls"]<=12 and lifetime["maxGeometries"]-lifetime["baseline"]<=12 and all(n==lifetime["baseline"] for n in lifetime["memory"]))
                check("死亡、眩晕、重复销毁只释放私有资源一次",lifetime["singleRelease"] and lifetime["detached"] and lifetime["finalCount"]==0 and lifetime["finalGeometries"]==lifetime["baseline"])
                page.close()
                for volume in range(1,6):gameplay(browser,base,volume,{"width":1280,"height":840},False,report,check)
                # Touch runs stay landscape: the portrait gate legitimately
                # freezes the world and hides the roster, so a portrait phone
                # viewport can neither select nor fight.
                gameplay(browser,base,4,{"width":844,"height":390},True,report,check)
                gameplay(browser,base,4,{"width":844,"height":430},True,report,check)
                gameplay(browser,base,1,{"width":844,"height":390},True,report,check,floor=5)
                browser.close()
        except Exception as error:
            report["errors"].append(repr(error));print("ERROR "+repr(error),flush=True)
        finally:
            server.shutdown();worker.join(timeout=5)
            (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    check("浏览器无未处理脚本错误",not report["errors"])
    # Include the last check in the durable evidence too.
    (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    failed=sum(not row["ok"] for row in report["checks"])
    print("Boss browser: %d checks, %d failed" % (len(report["checks"]),failed),flush=True)
    return 1 if failed or report["errors"] else 0


if __name__=='__main__':
    raise SystemExit(main())
