"""Navigation, real room assembly, native ownership and desktop/touch visual gates.
Owns a port-0 server; all model, texture, collision and UI modules are real.
"""
import functools
import json
import threading
from pathlib import Path
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_result_browser import start, check

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp' / 'navigation-audit'

MINIMAP = r"""async () => {
    const {createMinimap} = await import('/site/game/rl/view/minimap.js');
    const {createFollowCamera} = await import('/site/game/rl/view/camera.js');
    const {createBattleIndicators} = await import('/site/game/rl/view/battleindicators.js');
    const {THREE:T} = await (await import('/site/core/loader.js')).loadModules();
    const results=[], check=(name,ok)=>results.push({name,ok:!!ok});
    const container=document.createElement('div');document.body.appendChild(container);
    const map=createMinimap(container);
    const dungeon={rooms:[{id:1,x:0,y:0,type:'battle'},{id:2,x:0,y:-1,type:'boss'},
        {id:3,x:1,y:0,type:'shop'},{id:4,x:0,y:1,type:'rest'},{id:5,x:-1,y:0,type:'chest'},
        {id:6,x:0,y:-2,type:'chest'}],doors:[{a:1,b:2,side:'N'},{a:1,b:3,side:'E'},
        {a:1,b:4,side:'S'},{a:5,b:1,side:'E'},{a:2,b:6,side:'N'}]};
    const player={x:16,y:12,facing:0},enemy={id:2,x:20,y:12,kind:'boss'};
    const world={player,enemies:[enemy],dungeon,roomId:1,roomState:new Map([[1,{visited:true}]]),
        roomLocked:true,roomColliders:[{x:4,y:5,hw:1,hh:1}],previewUltimate:()=>null};
    map.update(world);
    check('all four actual doors, including a reverse edge, are drawn',
        [...container.querySelectorAll('.minimap-door')].map(n=>n.dataset.side).sort().join('')==='ENSW');
    check('locked doors have four cross marks',container.querySelectorAll('.minimap-door[data-locked="true"]').length===4);
    check('only the explored room exposes its type; distant rooms stay hidden',
        container.querySelectorAll('.minimap-room[data-type="unknown"]').length===4
        &&!container.querySelector('[data-room="6"]')&&!container.querySelector('.minimap-room[data-type="boss"]'));
    const marker=container.querySelector('[data-kind="player"]');
    const before=JSON.stringify(player);
    map.update(world,u=>u===player?{x:16.125,y:12}:u);
    check('player marker uses interpolation without replacing nodes or mutating logic',
        container.querySelector('[data-kind="player"]')===marker&&marker.getAttribute('transform').includes('16.13')&&before===JSON.stringify(player));
    world.roomLocked=false;enemy.dead=true;map.update(world);
    check('room clear opens the same doors and retires the dead enemy marker',
        container.querySelectorAll('.minimap-door[data-locked="false"]').length===4&&!container.querySelector('[data-kind="boss"]'));
    world.roomId=2;world.roomState.set(2,{visited:true});world.roomColliders=[];map.update(world);
    check('entering reveals the new frontier and discards old obstacles',
        !!container.querySelector('[data-room="6"]')&&container.querySelectorAll('.minimap-obstacles rect').length===0
        &&container.querySelectorAll('.minimap-door').length===2);
    world.dungeon={rooms:[{id:1,x:0,y:0,type:'start'}],doors:[]};world.roomId=1;world.roomState=new Map([[1,{visited:true}]]);map.update(world);
    check('new floor resets exploration even when room IDs repeat',container.querySelectorAll('.minimap-room').length===1&&!container.querySelector('.minimap-door'));
    for(const camera of [new T.PerspectiveCamera(34,16/9,.05,100),new T.OrthographicCamera(-4,4,4,-4,.05,100)]){
        camera.aspect=16/9;const follow=createFollowCamera(camera);follow.snap(16,12);
        const band=()=>1/camera.projectionMatrix.elements[5]/Math.sin(follow.pitch());
        follow.setHeight(5.5);const near=band();follow.setHeight(13);const far=band();
        check('raising '+camera.type+' expands ground view by at least half',far>near*1.5);
        camera.aspect=9/16;camera.updateProjectionMatrix();
        check('resize retains the height and correct portrait aspect',Math.abs(camera.right/camera.top-9/16)<1e-8);
        follow.setHeight(NaN);check('invalid height leaves the projection finite',camera.projectionMatrix.elements.every(Number.isFinite));
    }
    const overlays=createBattleIndicators(document.body,T);
    overlays.update(world,new T.PerspectiveCamera(),{domElement:{clientWidth:800,clientHeight:600}});
    check('combat viewport has no exit text overlays',!document.querySelector('.exit-marker,.exit-summary'));
    overlays.dispose();
    // Resize and inspect in one task: no RAF may repair the stale projection.
    const viewport=document.createElement('div');
    viewport.style.cssText='position:relative;width:800px;height:320px';document.body.appendChild(viewport);
    const projected=createBattleIndicators(viewport,T),camera=new T.OrthographicCamera(-5,5,2,-2,.05,100);
    camera.position.set(player.x,10,player.y);camera.up.set(0,0,-1);camera.lookAt(player.x,0,player.y);camera.updateMatrixWorld(true);
    projected.update({...world,player:{...world.player,skills:{ultimateReady:true}},
        previewUltimate:()=>({targets:[],self:true,description:'自身回复 / 增益'})},
        camera,{domElement:{clientWidth:800,clientHeight:320}});
    const target=viewport.querySelector('.ultimate-target'),transform=target?.style.transform;
    const bounds=target?.getBoundingClientRect();
    const targetX=bounds?bounds.x+bounds.width/2-viewport.getBoundingClientRect().x:NaN;
    viewport.style.width='180px';
    check('stale target projection cannot widen the viewport before the next render',
        target&&!target.hidden&&Math.abs(targetX-400)<.01&&target.style.transform===transform
        &&viewport.scrollWidth===viewport.clientWidth);
    projected.dispose();viewport.remove();return results;
}"""

SETUP = r"""async () => {
    const {THREE:T}=await (await import('/site/core/loader.js')).loadModules();
    const maps=await import('/site/game/rl/view/mapview.js');
    const {createStageScene}=await import('/site/game/rl/view/scene.js');
    const {createFollowCamera}=await import('/site/game/rl/view/camera.js');
    const tilt=await import('/site/game/rl/view/tilt.js');
    const geometry=await import('/site/game/rl/geometry.js');
    const native=await import('/site/game/rl/view/nativeassets.js');
    const {ROOM_SIZE:size,roomSize}=await import('/site/game/rl/dungeon.js');
    const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(960,640);renderer.setPixelRatio(1);document.body.replaceChildren(renderer.domElement);
    const stage=createStageScene(T,renderer),camera=new T.PerspectiveCamera(34,1.5,.05,100),follow=createFollowCamera(camera);
    tilt.setCharacterPitch(follow.pitch());
    const cards=await import('/site/core/cards.js'),card=cards.all().find(c=>c.id===10002001||c.evolvedId===10002001);
    const evolved=card.evolvedId===10002001;
    const actor=await (await import('/site/core/actor.js')).create({resourceId:evolved?card.evolvedResourceId:card.resourceId,
        classId:card.class,headId:cards.headId(card,evolved),weapon:'default'});
    const unit={x:16,y:12,facing:Math.PI,radius:.45,swingId:0,sm:{state:'idle',stateTime:0}};
    const view=(await import('/site/game/rl/view/actorview.js')).attachPlayerView(unit,actor,stage.scene);
    window.nav={T,maps,geometry,native,size,roomSize,renderer,stage,camera,follow,tilt,unit,actor,view,map:null};
}"""

ROOM = r"""async ({volume,type}) => {
    const a=nav;if(a.map)a.map.dispose();a.map=a.maps.createMapView(a.stage.scene,volume);
    await a.map.preloadVolume(volume,1,{strict:true});
    a.stage.applyVolume(a.maps.volumeConfig(volume));
    const room={id:1,type,seed:74061},result=await a.map.buildRoom(room,undefined,['N','E','S','W'],{strict:true});
    const size=a.roomSize(room);
    const landmark=result.placements.find(p=>p.native&&p.role!=='floor-shrine'),box=landmark&&result.colliders.find(b=>b.x===landmark.x&&b.y===landmark.y);
    const noOverlap=!box||result.colliders.every(b=>b===box||Math.abs(b.x-box.x)>=b.hw+box.hw||Math.abs(b.y-box.y)>=b.hh+box.hh);
    const queue=[[size.w,size.h]],seen=new Set(),key=(x,y)=>x+','+y;
    for(let at=0;at<queue.length;at++){
        const [x,y]=queue[at],id=key(x,y);if(seen.has(id))continue;
        if(x<1||y<1||x>2*size.w-1||y>2*size.h-1)continue;
        if(result.colliders.some(b=>a.geometry.circleOverlapsRect(x/2,y/2,.45,b)))continue;
        seen.add(id);for(const [dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]])if(!seen.has(key(x+dx,y+dy)))queue.push([x+dx,y+dy]);
    }
    const doors=[[size.w,1],[size.w,2*size.h-1],[1,size.h],[2*size.w-1,size.h]];
    const building=a.map.group.children.find(n=>n.name.startsWith('native-building:'));
    let grounded=true;
    for(const height of [5.5,13,9]) {
        a.follow.setHeight(height);a.tilt.setCharacterPitch(a.follow.pitch());a.map.update(0);
        if(building) {
            building.updateMatrixWorld(true);
            const bottom=new a.T.Box3().setFromObject(building,true).min.y;
            if(bottom<0 || bottom>.02)grounded=false;
        }
    }
    a.unit.x=landmark?landmark.x+3.7:size.w/2+3.7;a.unit.y=landmark?landmark.y+1.4:size.h/2+1.4;a.follow.snap(a.unit.x,a.unit.y);
    a.tilt.setCharacterPitch(a.follow.pitch());a.view.sync(0);a.actor.seek(.2);a.map.update(0);
    a.stage.render(a.camera,a.actor.object);
    return {volume,type,landmark,noOverlap,grounded,reachable:doors.every(([x,y])=>seen.has(key(x,y))),
        roomSize:size,drawCalls:a.renderer.info.render.calls,nativeRefs:a.native.nativeCacheStats().refs,hasBuilding:!!landmark,
        hasShrine:!!a.map.floorShrine&&a.map.floorShrine.room===room};
}"""


def native_faults(browser, base):
    page=browser.new_page()
    page.route('**/nav-native-audit',lambda route:route.fulfill(content_type='text/html',body='<body></body>'))
    page.goto(base+'/nav-native-audit')
    page.evaluate("""async()=>{
        const {THREE:T}=await (await import('/site/core/loader.js')).loadModules();
        const {createMapView}=await import('/site/game/rl/view/mapview.js');
        window.nativeProbe=await import('/site/game/rl/view/nativeassets.js');
        window.probeMap=createMapView(new T.Scene(),1);
        window.prepareNativeRoom=type=>probeMap.prepareRoom({id:1,type,seed:74061},undefined,['N'],{strict:true});
    }""")
    blocked='**/site/asset/rl/native/scene/bld_100000_0.glb.gz*'
    requests=[]
    def fail(route):requests.append(route.request.url);route.abort('failed')
    page.route(blocked,fail)
    failed=page.evaluate("""async()=>{try{await prepareNativeRoom('start');return false;}
        catch(_){return probeMap.group===null&&nativeProbe.nativeCacheStats().refs===0;}}""")
    check('native building failure cannot publish a partial map or retain an instance',failed and bool(requests))
    page.unroute(blocked,fail)
    check('native building failure can retry with a real decoded prefab',page.evaluate("""async()=>{
        probeMap.activateRoom(await prepareNativeRoom('start'));
        return !!probeMap.group&&nativeProbe.nativeCacheStats().refs===1;
    }"""))
    held=[];pattern='**/site/asset/rl/native/scene/bld_120400_0.glb.gz*'
    page.route(pattern,lambda route:held.append(route))
    page.evaluate("""()=>{window.lateNative=prepareNativeRoom('shop').then(c=>{c.dispose();return false;},()=>true);}""")
    for _ in range(150):
        if held:break
        page.wait_for_timeout(30)
    check('native disposal fixture has a genuinely pending request',bool(held))
    page.evaluate('probeMap.dispose()')
    page.unroute(pattern)
    for route in held:route.continue_()
    check('late native result is discarded and every reference is released',page.evaluate("""async()=>{
        return await lateNative&&probeMap.group===null&&nativeProbe.nativeCacheStats().refs===0;
    }"""))
    page.close()


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    report={'checks':[],'rooms':[],'errors':[]}
    with Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
                page=browser.new_page(viewport={'width':960,'height':640})
                page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.route('**/nav-audit',lambda route:route.fulfill(content_type='text/html',body='<body style="margin:0"></body>'))
                base='http://127.0.0.1:%d'%server.server_address[1]
                page.goto(base+'/nav-audit');page.add_style_tag(url=base+'/site/game/rl/ui/theme.css')
                report['checks']=page.evaluate(MINIMAP)
                for row in report['checks']:check(row['name'],row['ok'])
                page.add_script_tag(url=base+'/site/asset/gacha/cards.js');page.evaluate(SETUP)
                types=['start','battle','shop','rest','chest','boss']
                contact=Image.new('RGB',(1600,6*238),'#f7f3ea');draw=ImageDraw.Draw(contact)
                for volume in range(1,6):
                    for j,kind in enumerate(types):
                        row=page.evaluate(ROOM,{'volume':volume,'type':kind});report['rooms'].append(row)
                        expected = {'w':32,'h':24} if kind in ('battle','boss') else {'w':16,'h':12} if kind=='chest' else {'w':20,'h':16}
                        check('volume %d %s: correct bounds, reachable, correctly scoped landmark, bounded ownership'%(volume,kind),
                            row['roomSize']==expected and row['reachable'] and row['noOverlap'] and row['grounded']
                            and row['nativeRefs']==(1 if kind in ('start','shop','rest') else 3 if kind=='boss' else 0)
                            and row['hasShrine']==(kind=='boss')
                            and ((kind in ('start','shop','rest')) == row['hasBuilding']) and row['drawCalls']<120,row)
                        filename=OUT/('v%d-%s.png'%(volume,kind));page.locator('canvas').screenshot(path=str(filename))
                        with Image.open(filename) as shot:contact.paste(shot.resize((320,213)),((volume-1)*320,j*238+25))
                        draw.text(((volume-1)*320+8,j*238+6),'V%d / %s'%(volume,kind),fill='#2b2b33')
                contact.save(OUT/'room-contact.png')
                check('disposing the last room releases every native instance',page.evaluate('()=>{nav.map.dispose();return nav.native.nativeCacheStats().refs===0;}'))
                page.close()
                native_faults(browser,base)
                for width,height,touch in [(1280,800,False),(812,375,True),(844,390,True)]:
                    context=browser.new_context(viewport={'width':width,'height':height},has_touch=touch,is_mobile=touch)
                    game=context.new_page();game.on('pageerror',lambda e:report['errors'].append(str(e)))
                    game.add_init_script("""window.navigationPointers=[];for(const type of ['pointerover','pointermove','pointerdown'])
                        window.addEventListener(type,e=>{navigationPointers.push({type:e.type,pointer:e.pointerType,
                            touchSource:e.sourceCapabilities?.firesTouchEvents,movement:[e.movementX,e.movementY],
                            target:e.target.id||e.target.className,time:performance.now()});
                            if(navigationPointers.length>24)navigationPointers.shift();},true);""")
                    start(game,base+'/site/game/roguelike.html?seed=74061')
                    game.wait_for_function('window.kirafanRL?.views?.player && window.kirafanRL.mapview.group && !window.kirafanRL.world.frozen',timeout=40000)
                    game.wait_for_timeout(300)
                    # The shared start helper uses a mouse click. Exercise a
                    # real touch before checking the adaptive input chrome.
                    if touch:game.touchscreen.tap(width*.6,150)
                    game.evaluate('()=>{kirafanRL.world.player.iframes=0;kirafanRL.step(0);}')
                    proof=game.evaluate('''() => {
                        const k=kirafanRL,box=document.querySelector('#minimap').getBoundingClientRect();
                        const controls=[...document.querySelectorAll('.touch-attack,.touch-dodge,.touch-interact,.hud-pause,#hud')];
                        const overlaps=controls.filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0
                            &&Math.min(r.right,box.right)>Math.max(r.left,box.left)&&Math.min(r.bottom,box.bottom)>Math.max(r.top,box.top);}).map(el=>el.className||el.id);
                        return {visible:box.width>0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight,
                            overlaps,
                            doors:document.querySelectorAll('.minimap-door').length===k.world.roomDoors.length,
                            noExitText:!document.querySelector('.exit-summary,.exit-marker'),touch:document.body.classList.contains('touch-on'),
                            pointers:window.navigationPointers};
                    }''')
                    check('real game %d: minimap fits, doors agree, no exit text, correct input mode'%width,
                        proof['visible'] and not proof['overlaps'] and proof['doors'] and proof['noExitText'] and proof['touch']==touch,proof)
                    game.screenshot(path=str(OUT/('game-%d.png'%width)));context.close()
                check('no browser exceptions',not report['errors'],report['errors']);browser.close()
        finally:
            server.shutdown();thread.join(timeout=5)
            (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')

if __name__=='__main__':main()
