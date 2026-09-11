"""Real-GPU projectile ownership, direction, sizing and asset-failure checks."""
import argparse
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, press, dismiss
from rl_hit_alignment_browser import fingerprints

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".codex-tmp" / "projectile-visual"

SETUP = r"""async ({cap, preload}) => {
    const {THREE:T}=await (await import('/site/core/loader.js')).loadModules();
    const {createSkillVFX}=await import('/site/game/rl/view/skillvfx.js');
    const {createDanmakuView}=await import('/site/game/rl/view/danmakuview.js');
    const {createDanmaku}=await import('/site/game/rl/danmaku.js');
    const {setCharacterPitch}=await import('/site/game/rl/view/tilt.js');
    const native=await import('/site/game/rl/view/nativeassets.js');
    const scene=new T.Scene();scene.background=new T.Color('#dbe7e4');
    const renderer=new T.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});
    renderer.setSize(800,600);renderer.setPixelRatio(1);
    document.querySelector('#stage').append(renderer.domElement);
    const camera=new T.OrthographicCamera(-4,4,3,-3,.1,100);
    const cameraAt=height=>{camera.position.set(0,height,6.5);camera.lookAt(0,0,0);
        camera.updateMatrixWorld(true);setCharacterPitch(Math.atan2(height,6.5));};
    cameraAt(9);
    const fx=createSkillVFX(scene,T,{camera,maxEffects:cap});
    const unit={x:0,y:0,element:0,facing:0,card:{class:1},weaponProfile:{classId:1},
        skills:{normal:{id:2},slots:[null,null,null]}};
    const pending=fx.prepare(unit).catch(error=>error.message);
    await fx.ready;if(preload)await pending;
    const bullets=createDanmaku({capacity:32});
    const view=createDanmakuView(scene,T,{camera,capacity:32,
        projectileVisualReady:b=>!!fx.projectileVisualReady?.(b)});
    const list=()=>{const rows=[];bullets.forEach(b=>rows.push(b));return rows;};
    const fire=(angle=0,mods={})=>bullets.emit('aimed',{x:0,y:0,angle},
        {count:1,offset:0,side:'player',skillId:2,element:0,life:5,...mods});
    const render=dt=>{fx.syncProjectiles(bullets);fx.update(dt||0);view.sync(bullets);
        scene.updateMatrixWorld(true);renderer.render(scene,camera);};
    const state=()=>({active:bullets.active,generic:view.count+view.streakCount,
        native:list().filter(b=>fx.projectileVisualReady?.(b)).length,
        owned:list().map(b=>({id:b.spawnId,side:b.side,ready:!!fx.projectileVisualReady?.(b)})),
        effects:fx.stats,cache:native.nativeCacheStats()});
    window.audit={T,scene,camera,cameraAt,renderer,fx,unit,bullets,view,list,fire,render,state,native,
        createDanmaku,createDanmakuView};
    return state();
}"""

PIXELS = r"""() => {
    const a=audit,{T}=a,rows=[];a.fx.clear();a.bullets.clear();
    for(const half of [2.5,4.6,7])for(const dpr of [1,2]) {
        a.camera.top=half;a.camera.bottom=-half;a.camera.left=-half*4/3;a.camera.right=half*4/3;
        a.camera.updateProjectionMatrix();a.renderer.setPixelRatio(dpr);
        for(const pattern of ['aimed','ring'])for(const radius of [.12,.35,.65]) {
            a.bullets.clear();a.bullets.emit(pattern,{x:0,y:0,angle:0},
                {side:'enemy',count:pattern==='ring'?3:1,speed:0,radius,offset:0});a.render(0);
            const gl=a.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
            const data=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,data);
            const p=new T.Vector3(0,1,0).project(a.camera);
            const x=Math.floor((p.x+1)*w/2),y=Math.floor((p.y+1)*h/2);
            const dark=(x,y)=>data[(y*w+x)*4]<128 && data[(y*w+x)*4+1]<128;
            const ys=[],xs=[];for(let i=0;i<h;i++)if(dark(x,i))ys.push(i);
            for(let i=0;i<w;i++)if(dark(i,y))xs.push(i);
            rows.push({half,dpr,pattern,radius,want:radius*h/half,
                width:xs.length?xs.at(-1)-xs[0]+1:0,height:ys.length?ys.at(-1)-ys[0]+1:0,
                centre:ys.length?Math.abs((ys.at(-1)+ys[0]+1)/2-(p.y+1)*h/2):Infinity});
        }
    }
    a.renderer.setPixelRatio(1);a.camera.top=3;a.camera.bottom=-3;a.camera.left=-4;a.camera.right=4;
    a.camera.updateProjectionMatrix();a.bullets.clear();a.render(0);return rows;
}"""

NATIVE_GEOMETRY = r"""() => {
    const a=audit,{T}=a;
    const roots=a.scene.children.filter(n=>n.userData.rlOverlay&&!n.isInstancedMesh&&!n.isPoints)
        .sort((x,y)=>x.position.x-y.position.x);
    return a.list().sort((x,y)=>x.x-y.x).map((b,i)=>{
        const root=roots[i];if(!root)return {ready:false};
        const origin=new T.Vector3(b.x,1,b.y),p=origin.clone().project(a.camera);
        const aim=new T.Vector3(b.x+b.vx,1,b.y+b.vy).project(a.camera).sub(p).setZ(0).normalize();
        const drawn=new T.Vector3(-1,0,0).applyMatrix4(root.matrixWorld).project(a.camera)
            .sub(root.position.clone().project(a.camera)).setZ(0).normalize();
        return {ready:!!a.fx.projectileVisualReady?.(b),centreError:root.position.distanceTo(origin),
            alignment:drawn.dot(aim),element:b.element};
    });
}"""


def gameplay(browser,base,report,check,label):
    context=browser.new_context(viewport={"width":1280,"height":840},has_touch=False)
    context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
        localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
    try:
        page=context.new_page();page.on("pageerror",lambda e:report["errors"].append(str(e)))
        trace=report['scenarios']['gameplayTrace']=[]
        def snapshot(at):
            row=page.evaluate("""()=>{const k=window.kirafanRL,w=k?.world,p=w?.player;
                return {pending:k?.pending,roomLoading:k?.roomLoading,frozen:w?.frozen,
                    room:w?.room?.type,position:p?{x:p.x,y:p.y}:null,state:p?.sm.state,
                    attack:k?.input.state.attack,aim:k?.input.state.aimStick,shots:w?.danmaku.active,
                    effects:k?.effects.stats};}""")
            trace.append({'at':at,**row})
        page.goto(base+'/site/game/roguelike.html?seed=73061&volume=1',wait_until='load',timeout=60000)
        page.wait_for_selector('.roster-card',timeout=60000)
        page.locator('.roster-card').filter(has=page.locator('img[src$="/23002001.webp"]')).click()
        page.wait_for_function('window.kirafanRL?.world?.player && window.kirafanRL.pending===0',polling=100,timeout=60000)
        dismiss(page)
        snapshot('dismissed')
        page.evaluate("""async()=>{const k=window.kirafanRL,w=k.world;
            await k.effects.prepare(w.player);w.enemies=[];w.roomColliders=[];
            w.player.x=w.width/2;w.player.y=w.height/2;k.input.clear();k.step(0);}""")
        snapshot('fixture')
        # The first manual step drains roomEnter. Enemy model pending===0 is
        # not the room's commit/reveal boundary; input during it is discarded.
        page.wait_for_function('kirafanRL.pending===0&&!kirafanRL.roomLoading&&!kirafanRL.world.frozen',
                               polling=50,timeout=60000)
        snapshot('ready-for-input')
        advance(page,.8)
        snapshot('before-input')
        check('真实普攻前房间已完成装配与揭幕',not trace[-1]['frozen'] and trace[-1]['roomLoading'] is None)
        press(page,'KeyJ');advance(page,.3)
        snapshot('after-input')
        page.wait_for_function('window.kirafanRL.effects.stats.loaded>0',polling=100,timeout=30000)
        advance(page,1/60)
        row=page.evaluate("""()=>{const k=window.kirafanRL,bullets=[];
            k.world.danmaku.forEach(b=>{if(b.delay<=0)bullets.push(b)});
            return {shots:bullets.length,native:bullets.filter(b=>k.effects.projectileVisualReady?.(b)).length,
                generic:k.views.danmaku.count+k.views.danmaku.streakCount,effects:k.effects.stats};}""")
        report['scenarios']['gameplay']=row
        check('正常选角与真实普攻输入只绘制一次原作投射物',row['shots']>0 and row['native']==row['shots'] and row['generic']==0)
        page.screenshot(path=str(OUT/(label+'-gameplay.png')))
    except Exception:
        snapshot('failure')
        page.screenshot(path=str(OUT/(label+'-gameplay-failure.png')))
        raise
    finally:
        context.close()

GEOMETRY = r"""() => {
    const a=audit,{T}=a,rows=[];a.fx.clear();a.bullets.clear();
    for(const height of [5.5,9,13]) {
        a.cameraAt(height);
        for(const radius of [.12,.35,.65])for(let i=0;i<8;i++) {
            const angle=i*Math.PI/4;a.bullets.clear();
            a.fire(angle,{side:'enemy',radius});a.render(0);
            const b=a.list()[0],mesh=a.scene.getObjectByName('danmaku-streaks');
            const m=new T.Matrix4();mesh.getMatrixAt(0,m);
            const position=new T.Vector3(),q=new T.Quaternion(),scale=new T.Vector3();m.decompose(position,q,scale);
            const screen=v=>v.clone().project(a.camera);
            const origin=screen(new T.Vector3(b.x,1,b.y));
            const aim=screen(new T.Vector3(b.x+b.vx,1,b.y+b.vy)).sub(origin).setZ(0).normalize();
            const drawn=screen(new T.Vector3(1,0,0).applyMatrix4(m)).sub(screen(position)).setZ(0).normalize();
            rows.push({height,radius,angle,centreError:position.distanceTo(new T.Vector3(b.x,1,b.y)),
                width:scale.x,heightSize:scale.y,alignment:drawn.dot(aim)});
        }
    }
    a.bullets.clear();a.bullets.emit('ring',{x:0,y:0,angle:0},
        {side:'enemy',count:3,radius:.35,offset:0});a.render(0);
    let disc=null;
    if(a.view.object.isInstancedMesh) {
        const m=new T.Matrix4();a.view.object.getMatrixAt(0,m);
        const p=new T.Vector3(),q=new T.Quaternion(),s=new T.Vector3();m.decompose(p,q,s);
        disc={width:s.x,height:s.y};
    }
    return {rows,disc};
}"""

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--baseline",action="store_true")
    args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    label="before" if args.baseline else "after"
    report={"checks":[],"errors":[],"scenarios":{},"complete":False,"source_before":fingerprints()}
    def check(name,ok):
        report["checks"].append({"name":name,"ok":bool(ok)})
        print(("PASS " if ok else "FAIL ")+name,flush=True)
    with Server(("127.0.0.1",0),functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(args=["--use-gl=angle","--enable-unsafe-swiftshader"])
                def make_page(cap=8,preload=True,fail=False,held=None):
                    page=browser.new_page(viewport={"width":800,"height":600})
                    page.on("pageerror",lambda e:report["errors"].append(str(e)))
                    page.route("**/projectile-audit.html",lambda r:r.fulfill(content_type="text/html",body='<html><body style="margin:0"><div id="stage"></div></body></html>'))
                    target="**/ef_btl_magician_attack_fire_01.glb.gz"
                    if fail:page.route(target,lambda r:r.fulfill(status=503,body="injected missing asset"))
                    if held is not None:page.route(target,lambda r:held.append(r))
                    page.goto("http://127.0.0.1:%d/projectile-audit.html"%server.server_address[1])
                    page.evaluate(SETUP,{"cap":cap,"preload":preload})
                    return page
                page=make_page()
                geometry=page.evaluate(GEOMETRY);report["geometry"]=geometry
                check("弹体中心与实际判定中心一致",all(r["centreError"]<1e-6 for r in geometry["rows"]))
                check("三档视野与三种半径保持真实弹体尺寸",all(abs(r["width"]-4*r["radius"])<1e-6 and abs(r["heightSize"]-2*r["radius"])<1e-6 for r in geometry["rows"]))
                check("八方向拖尾与屏幕运动方向一致",all(r["alignment"]>.99999 for r in geometry["rows"]))
                check("圆形弹逐颗读取命中半径",geometry["disc"] is not None and abs(geometry["disc"]["width"]-.7)<1e-6 and abs(geometry["disc"]["height"]-.7)<1e-6)
                pixels=page.evaluate(PIXELS);report['pixels']=pixels
                check('实际像素在三档视野和两档像素密度下匹配命中直径',all(abs(r['width']-r['want'])<=max(2,r['want']*.05) and abs(r['height']-r['want'])<=max(2,r['want']*.05) and r['centre']<=1.5 for r in pixels))
                page.evaluate("audit.bullets.clear();audit.fire();audit.render(0)")
                page.wait_for_function("audit.fx.stats.loaded>0",timeout=30000)
                page.evaluate('audit.render(0)')
                state=page.evaluate('audit.state()')
                check('仅加载完成但尚未推进有效帧时保留回退',state['generic']==1 and state['native']==0)
                page.evaluate("audit.render(.1)")
                state=page.evaluate("audit.state()");report["scenarios"]["ready"]=state
                check("原作弹体就绪后不再叠画通用弹",state["native"]==1 and state["generic"]==0)
                page.screenshot(path=str(OUT/(label+"-native.png")))
                # The real class regression: the Alchemist catalogue has an
                # EffectAttach, not an EffectProjectile event. Before the fix
                # this exact setup fell back to the generic round bullet.
                page.evaluate(r"""async()=>{const a=audit;a.fx.clear();a.bullets.clear();
                    a.camera.top=3;a.camera.bottom=-3;a.camera.left=-4;a.camera.right=4;a.camera.updateProjectionMatrix();
                    a.unit.card.class=4;a.unit.weaponProfile={classId:4,kind:'projectile'};
                    a.unit.skills.normal={id:5};await a.fx.prepare(a.unit);
                    a.bullets.forEach(b=>b.radius=.5);a.fire(0,{skillId:5});
                    a.list()[0].radius=.5;a.render(.55);
                    a.camera.top=.9;a.camera.bottom=-.9;a.camera.left=-1.35;a.camera.right=1.35;
                    a.camera.updateProjectionMatrix();a.render(0);}""")
                page.wait_for_function("audit.fx.stats.loaded===1",timeout=30000)
                page.evaluate("audit.render(.1)")
                state=page.evaluate("audit.state()")
                check("炼金术师普攻使用原作投掷弹而非通用圆弹",
                      state["native"]==1 and state["generic"]==0
                      and state["effects"]["sources"]==["ef_btl_alchemist_attack_fire_01"])
                page.screenshot(path=str(OUT/(label+"-alchemist-native.png")))
                page.evaluate("""async()=>{const a=audit;a.unit.card.class=1;
                    a.unit.weaponProfile={classId:1,kind:'projectile'};a.unit.skills.normal={id:2};
                    await a.fx.prepare(a.unit);}""" )
                page.evaluate("audit.fx.clear();audit.render(.02)")
                page.wait_for_function("audit.fx.stats.loaded>0 || audit.fx.stats.active===0",timeout=30000)
                page.evaluate("audit.render(.1)")
                state=page.evaluate("audit.state()");report["scenarios"]["clear-live"]=state
                check("清理特效后活动弹仍可重新绑定",state["native"]==1 and state["generic"]==0)
                page.evaluate("audit.bullets.clear();audit.render(.02)")
                state=page.evaluate("audit.state()")
                check("弹体回收后原作跟随者退场，唯一引用是有界离场缓存",state["effects"]["active"]==0
                      and state["generic"]==0 and state["effects"]["cached"]==1 and state["cache"]["refs"]==1)
                page.evaluate('audit.fx.clear()')
                check("清场释放离场缓存与原作引用",page.evaluate('audit.fx.stats.cached===0&&audit.native.nativeCacheStats().refs===0'))
                report['nativeGeometry']=[]
                for element in range(6):
                    page.evaluate("""element=>{const a=audit;a.fx.clear();a.bullets.clear();
                        for(let i=0;i<8;i++)a.fire(i*Math.PI/4,{element});
                        a.list().forEach((b,i)=>b.x=(i-3.5)*.7);a.render(0);}""",element)
                    page.wait_for_function('audit.fx.stats.loaded===8',timeout=30000)
                    page.evaluate('audit.render(.1)')
                    report['nativeGeometry'].extend(page.evaluate(NATIVE_GEOMETRY))
                check('六属性原作效果在八方向中跟随实际弹体和相机投影',all(r['ready'] and r['centreError']<1e-6 and r['alignment']>.99999 for r in report['nativeGeometry']))
                page.evaluate('audit.fx.clear();audit.bullets.clear();audit.fire();audit.render(0)')
                page.wait_for_function('audit.fx.stats.loaded===1',timeout=30000)
                page.evaluate('audit.render(.1);window.oldBullet=audit.list()[0];audit.bullets.clear();audit.fire(Math.PI/2)')
                reused=page.evaluate('oldBullet===audit.list()[0] && !audit.fx.projectileVisualReady?.(audit.list()[0])')
                check('不清理特效直接复用池对象时旧生成编号不能接管新弹',reused)
                page.evaluate('audit.render(0)');page.wait_for_function('audit.fx.stats.loaded===1',timeout=30000)
                page.evaluate('audit.render(.1)')
                state=page.evaluate('audit.state()')
                check('直接池复用只留下新投射物的一个实例',state['native']==1 and state['generic']==0 and state['cache']['refs']==1)
                events=page.evaluate("""async()=>{const a=audit;a.fx.clear();a.bullets.clear();
                    const specs=[['emitPickup','ef_btl_buff_ring'],['emitBreak','ef_btl_dmg_single_00'],
                        ['emitBuff','ef_btl_buff_line'],['emitStun','ef_btl_stun_occur'],['emitCharge','ef_btl_buff_ring']];
                    const rows=[];for(const [method,effect] of specs){
                        const record=a.fx[method]?.(2,4);rows.push({method,effect,actual:record?.effect,finite:record?.x===2&&record?.y===4});}
                    a.fx.emitSkillCast(2,4);a.fx.emitNative('ef_btl_buff_line',NaN,4);
                    await Promise.resolve();return {rows,active:a.fx.stats.active};}""")
                report['events']=events
                check('拾取破坏增益眩晕与蓄力使用有意义的原作接口且拒绝无效坐标',all(r.get('actual')==r['effect'] and r['finite'] for r in events['rows']) and events['active']==5)
                batching=page.evaluate("""()=>{const a=audit;a.fx.clear();a.bullets.clear();a.render(0);
                    const pool=a.createDanmaku({capacity:1024}),view=a.createDanmakuView(a.scene,a.T,{capacity:1024,camera:a.camera});
                    pool.emit('ring',{x:0,y:0,angle:0},{count:512,speed:0});
                    pool.emit('aimed',{x:0,y:0,angle:0},{count:512,stepDelay:0,speed:0});
                    view.sync(pool);a.renderer.render(a.scene,a.camera);
                    const row={active:pool.active,drawn:view.count+view.streakCount,calls:a.renderer.info.render.calls};
                    view.dispose();view.dispose();return row;}""")
                report['batching']=batching
                check('满池一千零二十四弹完整绘制且只需两个批次',batching['active']==1024 and batching['drawn']==1024 and batching['calls']==2)
                page.evaluate("audit.view.dispose();audit.fx.dispose()")
                page.close()

                page=make_page(cap=1)
                page.evaluate("audit.fire(0);audit.fire(Math.PI/2);audit.render(0)")
                page.wait_for_function("audit.fx.stats.loaded>0",timeout=30000)
                page.evaluate("audit.render(.1)")
                state=page.evaluate("audit.state()");report["scenarios"]["capacity"]=state
                check("原作特效达到上限时未接管弹保留回退图形",state["native"]==1 and state["generic"]==1)
                page.close()

                page=make_page(fail=True)
                page.evaluate("audit.fire();audit.render(.02)")
                page.wait_for_function("audit.fx.stats.errors.some(x=>x.includes('ef_btl_magician_attack_fire_01'))",timeout=30000)
                page.evaluate("audit.render(.1)")
                state=page.evaluate("audit.state()");report["scenarios"]["missing"]=state
                check("原作资源失败时弹体仍可见且不虚报接管",state["generic"]==1 and state["native"]==0)
                page.close()

                held=[];page=make_page(preload=False,held=held)
                page.evaluate("audit.fire();audit.render(.02)")
                page.wait_for_timeout(100)
                state=page.evaluate("audit.state()");report["scenarios"]["pending"]=state
                check("原作资源尚未就绪时保留回退",bool(held) and state["generic"]==1 and state["native"]==0)
                page.evaluate("audit.fx.clear();audit.bullets.clear();audit.fire(Math.PI);audit.render(.02)")
                for route in held:route.continue_()
                page.wait_for_function("audit.fx.stats.loaded>0",timeout=30000)
                page.evaluate("audit.render(.1)")
                state=page.evaluate("audit.state()");report["scenarios"]["recycled"]=state
                check("迟到资源不复活旧弹且新池代正确接管",state["native"]==1 and state["generic"]==0 and state["effects"]["active"]==1)
                page.evaluate("audit.view.dispose();audit.fx.dispose();audit.bullets.clear()")
                state=page.evaluate("audit.state()")
                check("销毁后没有特效实例引用残留",state["cache"]["refs"]==0 and state["effects"]["active"]==0)
                page.close()
                gameplay(browser,'http://127.0.0.1:%d'%server.server_address[1],report,check,label)
                browser.close()
                check("无未捕获页面异常",not report["errors"])
                report['complete']=True
        finally:
            server.shutdown();thread.join(timeout=5)
            report['source_after']=fingerprints()
            report['changed_during_run']=[p for p in report['source_before'].keys() | report['source_after'].keys()
                if report['source_before'].get(p)!=report['source_after'].get(p)]
            (OUT/(label+".json")).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf8")
    return int(not args.baseline and any(not row["ok"] for row in report["checks"]))

if __name__=="__main__":raise SystemExit(main())
