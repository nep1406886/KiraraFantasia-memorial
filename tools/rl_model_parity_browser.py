"""Compare battle actors with the shipped model viewer, using the same GLBs/poses.

The external catalogue is stubbed, never the meshes, materials or animations.
"""
import argparse
import base64
import functools
import json
import re
import threading
from pathlib import Path
from urllib.parse import quote

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp' / 'model-parity'

SETUP = r"""async rid => {
    const loader = await import('/site/core/loader.js');
    const {create} = await import('/site/core/actor.js');
    const cards = await import('/site/core/cards.js');
    const {attachPlayerView} = await import('/site/game/rl/view/actorview.js');
    const {createStageScene} = await import('/site/game/rl/view/scene.js');
    const {setCharacterPitch} = await import('/site/game/rl/view/tilt.js');
    const {THREE:T} = await loader.loadModules();
    // The viewer indexes shared resource IDs last-wins. Match its class/head
    // rather than comparing two different class-action packs on one body.
    const card = cards.all().findLast(c => String(c.resourceId) === rid || String(c.evolvedResourceId) === rid);
    if (!card) throw new Error('missing card ' + rid);
    const evolved = String(card.evolvedResourceId) === rid;
    const actor = await create({resourceId:rid, classId:card.class,
        headId:cards.headId(card, evolved), weapon:'none'});
    const renderer = new T.WebGLRenderer({antialias:false, alpha:true, preserveDrawingBuffer:true});
    renderer.setSize(480,480); renderer.setPixelRatio(1); renderer.setClearColor(0,0);
    const stage = createStageScene(T,renderer), scene = stage.scene;
    const unit = {x:0,y:0,facing:Math.PI,radius:.28,swingId:0,sm:{state:'idle',stateTime:0}};
    setCharacterPitch(0);
    const view = attachPlayerView(unit,actor,scene); view.sync(0); await Promise.resolve();
    const reference = window.__modelDebug;
    scene.add(reference);
    const camera = new T.OrthographicCamera(-1.25,1.25,2.15,-.35,.1,100);
    camera.position.set(0,0,10); camera.lookAt(0,0,0);
    // Both paths use the same texture filtering and output sampling in this comparison.
    for (const root of [reference,actor.object]) root.traverse(n => {
        if (!n.isMesh) return;
        for (const m of Array.isArray(n.material) ? n.material : [n.material]) {
            if (m.map) { m.map.anisotropy = 1; m.map.needsUpdate = true; }
            if (m.userData.weaponPart) n.visible = false;
        }
    });
    const table = await fetch('/site/asset/models/visibility.json').then(r=>r.json());
    const governed = new Set(table.nodes.map(n=>n.toLowerCase()));
    const visibility = root => {
        const rows = {};
        root.traverse(n=>{
            if (n.isMesh && governed.has(loader.resolveNodeName(n).toLowerCase()))
                rows[loader.resolveNodeName(n)] = n.visible;
        });
        return rows;
    };
    const state = root => {
        const rows=[];
        root.traverse(n=>{if(n.isMesh) for(const m of Array.isArray(n.material)?n.material:[n.material])
            rows.push([n.name,m.side,m.depthWrite,m.depthTest,m.alphaTest]);});
        return JSON.stringify(rows);
    };
    const render = root => {
        reference.visible = root === reference; actor.object.visible = root === actor.object;
        stage.render(camera,root);
        const gl=renderer.getContext(), data=new Uint8Array(480*480*4);
        gl.readPixels(0,0,480,480,gl.RGBA,gl.UNSIGNED_BYTE,data);
        return data;
    };
    window.parity = {T,actor,unit,view,reference,renderer,stage,camera,visibility,state,render};
    const referenceClass=window.__visDebug('idle',0,[]).modelClass;
    if(referenceClass!==card.class)throw new Error('reference class mismatch');
    return {classId:card.class, clips:window.__rendererDebug.clipInfo().map(c=>c.name)};
}"""

POSE = r"""({name,fraction,mirrored,shot}) => {
    const a=parity;
    const info=window.__rendererDebug.clipInfo().find(c=>c.name===name);
    if (!info) throw new Error('viewer clip missing: '+name);
    const time=info.duration*fraction;
    const referenceState=window.__visDebug(name,time,[]);
    a.unit.facing=mirrored?0:Math.PI; a.view.sync(0);
    if(!a.actor.play(name,{loop:false,fade:0}))throw new Error('actor clip missing: '+name);
    a.actor.seek(time);
    for(const root of [a.reference,a.actor.object]) {
        root.position.set(0,0,0); root.rotation.set(0,0,0); root.scale.set(mirrored?-2:2,2,2);
        root.updateMatrixWorld(true);
    }
    const want=a.visibility(a.reference), got=a.visibility(a.actor.object);
    const visibilityMismatch=Object.keys(want).filter(n=>want[n]!==got[n]);
    const reference=a.render(a.reference);
    const referenceShot=shot?a.renderer.domElement.toDataURL('image/png'):null;
    const actual=a.render(a.actor.object);
    const actualShot=shot?a.renderer.domElement.toDataURL('image/png'):null;
    const pose=root=>{
        const rows=new Map();
        root.traverse(n=>{if(n.isBone)rows.set(n.name,[...n.position,...n.quaternion,...n.scale]);});
        return rows;
    };
    const referencePose=pose(a.reference), actualPose=pose(a.actor.object);
    const poseDifferences=[...referencePose].filter(([n,v])=>actualPose.has(n)
        && v.some((x,i)=>Math.abs(x-actualPose.get(n)[i])>1e-5))
        .map(([name,reference])=>({name,reference,actual:actualPose.get(name)}));
    let pixels=0,different=0,error=0;
    const pixelSamples=[];
    // World Y -0.35 .. 0.50: the feet, without grading facial-expression clocks.
    for(let y=0;y<163;y++) for(let x=0;x<480;x++) {
        const i=(y*480+x)*4;
        if(Math.max(reference[i+3],actual[i+3])<16)continue;
        pixels++;
        const delta=Math.max(...[0,1,2,3].map(c=>Math.abs(reference[i+c]-actual[i+c])));
        if(delta>15){different++;if(pixelSamples.length<6)pixelSamples.push({x,y,want:[...reference.slice(i,i+4)],got:[...actual.slice(i,i+4)]});}
        error+=delta;
    }
    const before=a.state(a.actor.object);
    a.unit.facing=mirrored?Math.PI:0;a.view.sync(0);
    a.unit.facing=mirrored?0:Math.PI;a.view.sync(0);
    return {name,time,mirrored,want,got,visibilityMismatch,pixels,different,
        referenceActionCount:referenceState.scheduledActions,
        meanError:error/Math.max(1,pixels),mirrorRoundtrip:before===a.state(a.actor.object),
        referenceShot,actualShot,poseDifferences,pixelSamples};
}"""


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('models', nargs='*', default=['100000','230001','350001','400002'])
    args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    label='before' if args.baseline else 'after'
    manifest=json.loads((ROOT/'site/asset/models/manifest.json').read_text(encoding='utf8'))
    catalogue=[{'name':key,'path':'bucket-a','size':1} for key in manifest['models']]
    report={'checks':[],'models':[],'errors':[]}
    def check(name,ok):
        report['checks'].append({'name':name,'ok':bool(ok)})
        print(('PASS ' if ok else 'FAIL ')+name,flush=True)
    with Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
                context=browser.new_context(viewport={'width':1280,'height':900})
                context.route('https://database.kirafan.cn/assetBundle.json',lambda r:r.fulfill(json=catalogue))
                context.route(re.compile(r'https://bucket-.*-asset\.kirafan\.cn/.*/index\.json'),lambda r:r.fulfill(status=503,body='offline fixture'))
                context.route(re.compile(r'https://asset\.kirafan\.cn/.*'),lambda r:r.fulfill(path=str(ROOT/'favicon.png'),content_type='image/png'))
                page=context.new_page()
                page.on('pageerror',lambda e:report['errors'].append(str(e)))
                for rid in args.models:
                    key='model/player/model_pl_'+rid+'.muast'
                    page.goto('http://127.0.0.1:%d/site/models.html?debug=1&parity=%s#%s'%(server.server_address[1],rid,quote(key)),wait_until='domcontentloaded')
                    page.wait_for_function("rid=>window.__modelDebugFile?.includes('/model_pl_'+rid+'/') && document.querySelector('#model3dCanvas.is-ready')",arg=rid,timeout=60000)
                    page.wait_for_function("window.__rendererDebug.clipInfo().some(c=>c.name==='idle')",timeout=60000)
                    await_script='window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};'
                    page.evaluate(await_script)
                    if not page.evaluate('!!window.kirafanGachaData'):
                        page.add_script_tag(url='/site/asset/gacha/cards.js')
                    info=page.evaluate(SETUP,rid)
                    rows=[]
                    for name,fraction in [('idle',.3),('battle_run',.2),('battle_run',.7),('attack',.55),('damage',.3)]:
                        for mirrored in (False,True):
                            row=page.evaluate(POSE,{'name':name,'fraction':fraction,'mirrored':mirrored,'shot':name=='battle_run' and fraction==.2})
                            for field in ('referenceShot','actualShot'):
                                png=row.pop(field,None)
                                if png:
                                    (OUT/f'{label}-{rid}-{int(mirrored)}-{field}.png').write_bytes(base64.b64decode(png.split(',')[1]))
                            rows.append(row)
                    report['models'].append({'rid':rid,**info,'rows':rows})
                    check(rid+' 定格只有一个参考动作',all(r['referenceActionCount']==1 for r in rows))
                    check(rid+' 对应骨骼局部姿态一致',all(not r['poseDifferences'] for r in rows))
                    check(rid+' 动作可见性与观察工具一致',all(not r['visibilityMismatch'] for r in rows))
                    check(rid+' 脚部像素与观察工具一致',all(r['pixels']>100 and r['different']<=r['pixels']*.025 and r['meanError']<2 for r in rows))
                    check(rid+' 镜像往返不污染材质',all(r['mirrorRoundtrip'] for r in rows))
                check('无未捕获页面错误',not report['errors'])
                browser.close()
        finally:
            server.shutdown();thread.join(timeout=5)
            (OUT/(label+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    return int(not args.baseline and any(not c['ok'] for c in report['checks']))


if __name__=='__main__':
    raise SystemExit(main())
