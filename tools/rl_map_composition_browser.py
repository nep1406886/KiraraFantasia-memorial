"""Original building identity, composed room layouts, and resource ownership.
Runs real GLBs and textures in Chromium; expected identities come from the
separately recorded original TownObjectListDB/TitleListDB evidence snapshot.
"""
import functools
import json
import threading
from pathlib import Path
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_navigation_browser import SETUP
from rl_result_browser import check

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp' / 'map-composition-audit'

IDENTITY = r"""async evidence => {
    const {roomBuildingKey}=await import('/site/game/rl/view/roomlandmarks.js');
    const index=await nav.native.loadNativeIndex();
    const checks=[],check=(name,ok)=>checks.push({name,ok:!!ok});
    for(const row of evidence.entries.filter(r=>r.exported)) {
        const data=index.buildings[row.resourceKey]?.affiliation;
        check('source metadata '+row.resourceKey,data&&data.titleType===row.titleType
            &&data.resourceId===row.resourceId&&data.objectId===row.objectId
            &&data.category===row.category&&data.name===row.nameJa
            &&data.tableSha256===evidence.source.townFileSha256);
        if(row.category===6) {
            for(let volume=1;volume<=5;volume++) check('exact work '+row.titleType+' volume '+volume,
                roomBuildingKey({type:'battle',workTitle:row.titleType},volume)===row.resourceKey);
        }
    }
    for(const row of evidence.entries.filter(r=>r.category===6&&!r.exported)) {
        check('missing work never borrows another building '+row.titleType,
            roomBuildingKey({type:'shop',workTitle:row.titleType},3)===null);
    }
    for(const value of ['',false,true,'0',{},[],0.5,-1,NaN,Infinity]) {
        check('invalid work id rejected '+String(value),roomBuildingKey({type:'shop',workTitle:value},1)===null);
    }
    for(let volume=1;volume<=5;volume++) for(const type of ['battle','chest','boss']) {
        check('unaffiliated wilderness has no work building '+volume+'/'+type,roomBuildingKey({type},volume)===null);
    }
    return checks;
}"""

BUILD = r"""async ({volume,floor,type,workTitle,seed=74061})=>{
    const a=nav;if(a.map)a.map.dispose();
    a.map=a.maps.createMapView(a.stage.scene,volume);a.map.setFloor(floor);
    await a.map.preloadVolume(volume,floor,{strict:true});
    a.stage.applyVolume(a.maps.volumeConfig(volume,floor));
    const room={id:1,type,seed};if(workTitle!==undefined)room.workTitle=workTitle;
    const candidate=await a.map.prepareRoom(room,undefined,['N','E','S','W'],{strict:true});
    const {layout,result,size}=candidate;
    const original=JSON.stringify(room),surface=candidate.group.getObjectByName('room-surface');
    const canvas=surface.material.map.image;
    const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let hash=2166136261,allOpaque=true;for(let i=0;i<data.length;i++){
        hash=Math.imul(hash^data[i],16777619)>>>0;if(i%4===3&&data[i]!==255)allOpaque=false;
    }
    const building=result.placements.find(p=>p.native);
    const obstacles=result.colliders.filter(b=>!building||b!==candidate.landmark.collider);
    const pathsClear=obstacles.every(b=>!layout.isProtected(b.x,b.y,Math.max(b.hw,b.hh)));
    const disjoint=result.colliders.every((b,i)=>result.colliders.every((c,j)=>i===j||
        Math.abs(b.x-c.x)>=b.hw+c.hw||Math.abs(b.y-c.y)>=b.hh+c.hh));
    const queue=[[size.w,size.h]],seen=new Set(),key=(x,y)=>x+','+y;
    for(let at=0;at<queue.length;at++){
        const [x,y]=queue[at],id=key(x,y);if(seen.has(id))continue;
        if(x<1||y<1||x>size.w*2-1||y>size.h*2-1)continue;
        if(result.colliders.some(b=>a.geometry.circleOverlapsRect(x/2,y/2,.45,b)))continue;
        seen.add(id);for(const [dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]])if(!seen.has(key(x+dx,y+dy)))queue.push([x+dx,y+dy]);
    }
    const reachable=[[size.w,1],[size.w,size.h*2-1],[1,size.h],[size.w*2-1,size.h]].every(([x,y])=>seen.has(key(x,y)));
    a.map.activateRoom(candidate);
    let grounded=true;
    for(const height of [5.5,13,9]){
        a.follow.setHeight(height);a.tilt.setCharacterPitch(a.follow.pitch());a.map.update(0);
        if(candidate.landmark){const min=new a.T.Box3().setFromObject(candidate.landmark.root,true).min.y;if(min<0||min>.02)grounded=false;}
    }
    a.unit.x=size.w/2;a.unit.y=size.h/2;a.follow.snap(a.unit.x,a.unit.y);
    a.tilt.setCharacterPitch(a.follow.pitch());a.view.sync(0);a.actor.seek(.2);a.map.update(0);
    a.stage.render(a.camera,a.actor.object);
    const report={volume,floor,type,workTitle,size,hash,pathsClear,disjoint,reachable,grounded,
        building:building||null,placements:result.placements.length,drawCalls:a.renderer.info.render.calls,
        surfacePixels:data.length/4,buildMs:result.buildMs,inputUnchanged:original===JSON.stringify(room),
        surfaceMatchesBounds:canvas.width===size.w*32&&canvas.height===size.h*32
            &&surface.geometry.parameters.width===size.w&&surface.geometry.parameters.height===size.h
            &&surface.position.x===size.w/2&&surface.position.z===size.h/2};
    report.surfaceBehindBuildings=allOpaque&&!surface.material.transparent&&surface.material.depthWrite
        &&surface.position.y>-.02&&surface.position.y<-.016;
    report.noTreeFragments=!result.placements.some(p=>/^tree[ABC][1-4]$/i.test(p.name));
    a.lastRoom=room;a.lastCandidate=candidate;
    return report;
}"""

LAYERING = r"""()=>{
    const a=nav,owner=a.lastCandidate,building=owner.landmark.root,surface=owner.group.getObjectByName('room-surface');
    const target=new a.T.WebGLRenderTarget(960,640),renderer=a.renderer,scene=a.stage.scene;
    const previous={target:renderer.getRenderTarget(),background:scene.background,alpha:renderer.getClearAlpha(),
        color:renderer.getClearColor(new a.T.Color()).clone(),autoClear:renderer.autoClear};
    const roots=scene.children.map(root=>[root,root.visible]);
    const children=owner.group.children.map(root=>[root,root.visible]);
    const read=()=>{renderer.render(scene,a.camera);const pixels=new Uint8Array(960*640*4);
        renderer.readRenderTargetPixels(target,0,0,960,640,pixels);return pixels;};
    a.follow.snap(owner.landmark.placement.x,owner.landmark.placement.y+1);
    try {
        renderer.setRenderTarget(target);renderer.autoClear=true;scene.background=null;renderer.setClearColor(0,0);
        roots.forEach(([root])=>{root.visible=root===owner.group||root.isLight;});
        children.forEach(([root])=>{root.visible=root===building;});
        const isolated=read();children.forEach(([root,visible])=>{root.visible=visible;});
        const actual=read();
        // Deliberately reintroduce the old render-queue bug. This must corrupt
        // facade pixels; the positive sample alone is not a useful control.
        surface.material.transparent=true;surface.material.needsUpdate=true;
        const broken=read();
        let mask=0,actualMismatch=0,brokenMismatch=0;
        for(let y=1;y<639;y++)for(let x=1;x<959;x++){
            const i=(y*960+x)*4;
            if([i-3840-4,i-3840,i-3840+4,i-4,i,i+4,i+3840-4,i+3840,i+3840+4]
                .some(at=>isolated[at+3]!==255))continue;
            mask++;
            const differs=sample=>Math.max(...[0,1,2].map(j=>Math.abs(sample[i+j]-isolated[i+j])))>4;
            if(differs(actual))actualMismatch++;
            if(differs(broken))brokenMismatch++;
        }
        return {mask,actualMismatch,brokenMismatch,intact:mask>500&&actualMismatch/mask<.05,
            negativeDetected:brokenMismatch>actualMismatch+500};
    } finally {
        surface.material.transparent=false;surface.material.needsUpdate=true;
        roots.forEach(([root,visible])=>{root.visible=visible;});children.forEach(([root,visible])=>{root.visible=visible;});
        renderer.setRenderTarget(previous.target);renderer.setClearColor(previous.color,previous.alpha);
        renderer.autoClear=previous.autoClear;scene.background=previous.background;target.dispose();
        a.follow.snap(a.unit.x,a.unit.y);a.stage.render(a.camera,a.actor.object);
    }
}"""

OWNERSHIP = r"""async()=>{
    const a=nav,current=a.map.group,old=a.lastCandidate;
    const candidate=await a.map.prepareRoom(a.lastRoom,undefined,['N','E','S','W'],{strict:true});
    const owned=[candidate.surfaceMaterial,candidate.surfaceTexture,candidate.group.getObjectByName('room-surface').geometry];
    const counts=[0,0,0];owned.forEach((r,i)=>r.addEventListener('dispose',()=>counts[i]++));
    const oldCounts=[0,0,0];[old.surfaceMaterial,old.surfaceTexture,old.group.getObjectByName('room-surface').geometry]
        .forEach((r,i)=>r.addEventListener('dispose',()=>oldCounts[i]++));
    const separate=candidate.surfaceMaterial!==old.surfaceMaterial&&candidate.surfaceTexture!==old.surfaceTexture;
    candidate.dispose();candidate.dispose();
    const afterDispose=counts.every(n=>n===1)&&oldCounts.every(n=>n===0)&&a.map.group===current;
    const replacement=await a.map.prepareRoom(a.lastRoom,undefined,['N','E','S','W'],{strict:true});
    a.map.activateRoom(replacement);
    const afterReplace=oldCounts.every(n=>n===1);
    // Poison only the in-memory source record. A mismatched affiliation must
    // fail preparation and release its native instance without replacing old.
    const index=await a.native.loadNativeIndex(),entry=index.buildings.bld_110200_0;
    const affiliation=entry.affiliation,refs=a.native.nativeCacheStats().refs,active=a.map.group;
    let mismatch=false;
    try{entry.affiliation={...affiliation,titleType:7};
        await a.map.prepareRoom({id:2,seed:2,type:'start',workTitle:0},undefined,['N'],{strict:true});
    }catch(e){mismatch=String(e).includes('归属不符')&&a.map.group===active&&a.native.nativeCacheStats().refs===refs;}
    finally{entry.affiliation=affiliation;}
    a.map.dispose();
    return {separate,afterDispose,afterReplace,mismatch,noReferences:a.native.nativeCacheStats().refs===0};
}"""


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    evidence=json.loads((ROOT/'docs/original-town-building-data.json').read_text(encoding='utf8'))
    report={'identity':[],'rooms':[],'works':[],'errors':[]}
    handler=functools.partial(NoCacheHandler,directory=str(ROOT))
    with Server(('127.0.0.1',0),handler) as server:
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
                page=browser.new_page(viewport={'width':960,'height':640})
                page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.route('**/composition-audit',lambda route:route.fulfill(content_type='text/html',body='<body style="margin:0"></body>'))
                base='http://127.0.0.1:%d'%server.server_address[1]
                page.goto(base+'/composition-audit');page.add_script_tag(url=base+'/site/asset/gacha/cards.js');page.evaluate(SETUP)
                report['identity']=page.evaluate(IDENTITY,evidence)
                for row in report['identity']:check(row['name'],row['ok'])
                contact=Image.new('RGB',(1600,4*239),'#efe9de');draw=ImageDraw.Draw(contact)
                for volume in range(1,6):
                    for seg,floor in enumerate([1,6,11,16]):
                        row=page.evaluate(BUILD,{'volume':volume,'floor':floor,'type':'battle'});report['rooms'].append(row)
                        check('composed V%d/F%d: paths, collision, source scope, frame budget'%(volume,floor),
                            row['pathsClear'] and row['disjoint'] and row['reachable'] and row['grounded']
                            and not row['building'] and row['inputUnchanged'] and row['drawCalls']<120
                            and row['surfaceBehindBuildings'] and row['noTreeFragments']
                            and row['surfacePixels']==1024*768 and row['surfaceMatchesBounds'] and row['buildMs']<1500,row)
                        shot=OUT/('v%d-f%d.png'%(volume,floor));page.locator('canvas').screenshot(path=str(shot))
                        with Image.open(shot) as image:contact.paste(image.resize((320,213)),((volume-1)*320,seg*239+25))
                        draw.text(((volume-1)*320+6,seg*239+6),'V%d / F%d'%(volume,floor),fill='#30352d')
                contact.save(OUT/'segments.png')
                first=page.evaluate(BUILD,{'volume':1,'floor':1,'type':'start'})
                second=page.evaluate(BUILD,{'volume':1,'floor':1,'type':'start'})
                check('same seed reproduces terrain pixels and placements',first['hash']==second['hash'] and first['placements']==second['placements'])
                page.locator('canvas').screenshot(path=str(OUT/'start.png'))
                report['layering']=page.evaluate(LAYERING)
                check('paving stays behind opaque facade pixels, including a broken-queue control',
                    report['layering']['intact'] and report['layering']['negativeDetected'],report['layering'])
                for row in evidence['entries']:
                    if row['category']!=6 or not row['exported']:continue
                    built=page.evaluate(BUILD,{'volume':1,'floor':1,'type':'start','workTitle':row['titleType']})
                    report['works'].append(built)
                    check('real work prefab '+row['resourceKey'],built['building']['name']==row['resourceKey']
                        and built['building']['titleType']==row['titleType'] and built['grounded']
                        and built['reachable'] and built['pathsClear'] and built['disjoint'] and built['surfaceMatchesBounds'],built)
                    page.locator('canvas').screenshot(path=str(OUT/('work-%d.png'%row['titleType'])))
                report['ownership']=page.evaluate(OWNERSHIP)
                for name,ok in report['ownership'].items():check('resource ownership '+name,ok)
                check('no browser exceptions',not report['errors'],report['errors'])
                browser.close()
        finally:
            server.shutdown();thread.join(timeout=5)
            (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')

if __name__=='__main__':main()
