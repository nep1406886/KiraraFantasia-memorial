"""Real native statue ownership, retry, cancellation, frame rate and map access."""
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import fingerprints

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/floor-shrine-assets'

SETUP = """async()=>{
    const {THREE:T}=await (await import('/site/core/loader.js')).loadModules();
    const maps=await import('/site/game/rl/view/mapview.js');
    const native=await import('/site/game/rl/view/nativeassets.js');
    const {createWorld}=await import('/site/game/rl/world.js');
    const {circleOverlapsRect}=await import('/site/game/rl/geometry.js');
    const tilt=await import('/site/game/rl/view/tilt.js');
    const scene=new T.Scene(), map=maps.createMapView(scene,1);
    const room={id:1,type:'boss',seed:28101,enemies:[]};
    await map.buildRoom({id:0,type:'start',seed:28100},undefined,['N'],{strict:true});
    window.audit={T,maps,native,createWorld,circleOverlapsRect,tilt,scene,map,room};
    return {refs:native.nativeCacheStats().refs};
}"""

OWNERSHIP = """async()=>{
    const a=audit, results=[], check=(name,ok,detail)=>results.push({name,ok:!!ok,detail});
    const old=a.map.group, refs=a.native.nativeCacheStats().refs;
    const candidate=await a.map.prepareRoom(a.room,undefined,['N','E','S','W'],{strict:true});
    check('准备雕像不提前替换场景',a.map.group===old&&!candidate.group.parent);
    check('雕像与两盏原作灯具由候选持有',a.native.nativeCacheStats().refs===refs+3
        &&candidate.floorShrine.placement.source==='prefab/room/goods/goods_1147.muast');
    const other=await a.map.prepareRoom({...a.room,id:2},undefined,['N'],{strict:true});
    const material=v=>{let m;v.object.children[0].traverse(n=>{if(n.isMesh)m=n.material;});return m;};
    const m1=material(candidate.floorShrine),m2=material(other.floorShrine),before=m2.color.toArray();
    candidate.floorShrine.setState(true,true);candidate.floorShrine.update(.5);
    check('明暗只改本实例，不污染另一个雕像的材质',m1!==m2&&JSON.stringify(before)===JSON.stringify(m2.color.toArray()));
    other.dispose();other.dispose();
    check('未使用候选重复释放不泄漏',a.native.nativeCacheStats().refs===refs+3);
    a.map.activateRoom(candidate);
    check('激活后原地图释放，房内只有一个雕像',a.map.floorShrine===candidate.floorShrine
        &&a.scene.children.length===1&&a.native.nativeCacheStats().refs===3);
    for(const pitch of [Math.PI/6,Math.PI/4,Math.PI/3]){
        a.tilt.setCharacterPitch(pitch);a.map.update(0);
        const statue=a.map.floorShrine.object.children[0],box=new a.T.Box3().setFromObject(statue,true);
        check('不同视角雕像贴地且提示在顶端 '+pitch.toFixed(2),box.min.y>=-.001&&box.min.y<.03
            &&a.map.floorShrine.anchor.y>box.max.y&&a.map.floorShrine.anchor.z<=box.min.z);
    }
    a.map.dispose();check('地图释放归零所有雕像实例',a.native.nativeCacheStats().refs===0);
    const {createFloorShrineView}=await import('/site/game/rl/view/floorshrineview.js');
    check('非首领房不加载祈愿雕像',await createFloorShrineView(a.T,{type:'rest'})===null);
    const glows=[];
    for(const fps of [30,60,120]){
        const view=await createFloorShrineView(a.T,a.room);view.setState(true,false);
        for(let i=0;i<fps/2;i++)view.update(1/fps);
        const glow=view.object.userData.glow;glows.push(glow);view.dispose();
    }
    check('30/60/120 帧苏醒亮度一致且不瞬跳',Math.max(...glows)-Math.min(...glows)<1e-10
        &&glows.every(g=>g>.9&&g<1),glows);
    return results;
}"""

ACCESS = """async()=>{
    const a=audit, results=[];
    for(let volume=1;volume<=5;volume++){
        const map=a.maps.createMapView(a.scene,volume);
        for(const seed of [1,28101,74061]){
            const room={...a.room,seed},result=await map.buildRoom(room,undefined,['N','E','S','W'],{strict:true});
            const w=a.createWorld();w.spawnPlayer();
            w.setDungeon({start:0,boss:1,doors:[],rooms:[{id:0,type:'start',seed:0,enemies:[]},room]},[{id:1,cleared:true}]);
            w.enterRoom(1);w.setRoomColliders(result.colliders);
            const s=w.floorShrine,queue=[[32,24]],seen=new Set();let reachable=false;
            for(let at=0;at<queue.length;at++){
                const [x,y]=queue[at],key=x+','+y;if(seen.has(key))continue;
                if(x<1||y<1||x>63||y>47)continue;
                if(w.roomColliders.some(c=>a.circleOverlapsRect(x/2,y/2,.45,c)))continue;
                seen.add(key);
                if(Math.hypot(x/2-s.x,y/2-s.y)<=1.9)reachable=true;
                for(const [dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]])if(!seen.has((x+dx)+','+(y+dy)))queue.push([x+dx,y+dy]);
            }
            results.push({name:'原作布景保留雕像接近空间与四向道路 v'+volume+'/'+seed,
                ok:reachable&&['32,1','32,47','1,24','63,24'].every(k=>seen.has(k)),tiles:seen.size});
        }
        map.dispose();
    }
    results.push({name:'多卷房间反复装配无原作实例泄漏',ok:a.native.nativeCacheStats().refs===0});
    return results;
}"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'before': fingerprints()}

    def record(name, ok, detail=None):
        report['checks'].append({'name': name, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)
        if not ok:
            raise AssertionError(name + ': ' + str(detail))

    with Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT))) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
                base = 'http://127.0.0.1:%d/shrine-assets' % server.server_address[1]

                def new_page():
                    p = browser.new_page()
                    p.route('**/shrine-assets', lambda r: r.fulfill(content_type='text/html', body='<body></body>'))
                    p.on('pageerror', lambda e: report['errors'].append(str(e)))
                    p.goto(base); p.evaluate(SETUP)
                    return p

                page = new_page()
                for row in page.evaluate(OWNERSHIP) + page.evaluate(ACCESS):
                    record(row['name'], row['ok'], row.get('detail', row.get('tiles')))
                page.close()
                page = new_page()
                page.route('**/goods_1147.glb.gz', lambda r: r.fulfill(status=503, body='injected statue failure'))
                state = page.evaluate("""async()=>{const a=audit,old=a.map.group,refs=a.native.nativeCacheStats().refs;
                    try{await a.map.prepareRoom(a.room,undefined,['N'],{strict:true});return false;}
                    catch(e){return a.map.group===old&&a.map.floorShrine===null&&a.native.nativeCacheStats().refs===refs;}}
                """)
                record('雕像资源部分失败不发布隐形交互，保留旧景且释放成功灯具', state)
                page.unroute('**/goods_1147.glb.gz')
                record('失败缓存可重试恢复原作雕像', page.evaluate("""async()=>{const a=audit;
                    await a.map.buildRoom(a.room,undefined,['N'],{strict:true});const ok=!!a.map.floorShrine;
                    a.map.dispose();return ok&&a.native.nativeCacheStats().refs===0;}"""))
                page.close()
                page = new_page()
                page.evaluate("""()=>{const actual=window.fetch.bind(window);window.fetch=(url,...args)=>{
                    if(String(url).includes('goods_1147.glb.gz'))return new Promise(resolve=>{
                        window.statueHeld=true;window.releaseStatue=()=>resolve(actual(url,...args));});
                    return actual(url,...args);};
                    window.statueLoad=audit.map.prepareRoom(audit.room,undefined,['N'],{strict:true}).then(()=>false,()=>true);}
                """)
                page.wait_for_function('window.statueHeld', polling=50, timeout=60000)
                record('候选取消后迟到的雕像与灯具全部释放', page.evaluate("""async()=>{
                    audit.map.dispose();window.releaseStatue();const rejected=await window.statueLoad;
                    return rejected&&audit.map.group===null&&audit.native.nativeCacheStats().refs===0;}"""))
                record('没有未捕获页面异常', not report['errors'], report['errors'])
                browser.close()
        except Exception as error:
            report['failure'] = repr(error)
            raise
        finally:
            report['after'] = fingerprints()
            report['changed_during_run'] = [n for n in report['before'] if report['before'][n] != report['after'][n]]
            (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
            server.shutdown()


if __name__ == '__main__':
    main()
