"""Load and sample every mapped original cinematic with its real owner model.

This is an automated coverage gate, not a claim of frame-by-frame visual parity.
Detailed UI screenshots are produced separately by skill_render_browser.py.
"""
import argparse
import functools
import json
from pathlib import Path
import threading
import time

from playwright.sync_api import sync_playwright
from build_rl_data import load_table
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".codex-tmp/skill-render"

BOOT = r"""async () => {
    const loader=await import('/site/core/loader.js');
    const {THREE}=await loader.loadModules();
    const us=await import('/site/core/skillstage.js');
    const actors=await import('/site/core/actor.js');
    const renderer=new THREE.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});
    renderer.setSize(384,256);document.body.appendChild(renderer.domElement);
    const shaderErrors=[];
    renderer.debug.onShaderError=()=>shaderErrors.push('shader compilation failed');
    window.catalogTest={THREE,loader,us,actors,renderer,shaderErrors};
}"""

SAMPLE = r"""async config => {
    const {THREE,loader,us,actors,renderer,shaderErrors}=window.catalogTest;
    shaderErrors.length=0;
    let actor=null,loaded=null,stage=null;
    try {
        const timeline=await us.loadTimeline(config.sceneId);
        loaded=await us.loadScene(config.sceneId);
        actor=await actors.create({resourceId:config.model,skillId:config.sceneId,
            classId:config.classId,headId:config.headId,actions:false,stageMotion:true,weapon:'default'});
        if(actor.resourceId!==config.model || !actor.play('skill',{loop:false,fade:0})){
            throw Error('missing exact owner action: '+config.sceneId);
        }
        const action=actor.mixer._actions.find(a=>a.isRunning());
        if(!action || !action.getClip().tracks.length)throw Error('empty owner tracks');
        const row={...config,frames:timeline.frames,tracks:action.getClip().tracks.length,
            duration:action.getClip().duration,samples:[],layerMaterials:0};
        loaded.scene.traverse(n=>{
            for(const m of (Array.isArray(n.material)?n.material:[n.material])){
                if(!m?.userData.msb?.layerTexture)continue;
                row.layerMaterials++;
                if(!m.alphaMap || !n.geometry.getAttribute('uv1'))throw Error('unbound independent UV: '+n.name);
            }
        });
        stage=us.createStage({THREE,timeline,root:loaded.scene,object:actor.object,
            resourceId:config.sceneId,voices:{},sampleActor:s=>actor.seek(s),
            onReset:()=>{actor.setWeaponVisible(true);actor.faceAuto();},
            onEvent:e=>{if(e.event==='weaponVisible')actor.setWeaponVisible(!!e.args[0]);}
        });
        const gl=renderer.getContext(),pixels=new Uint8Array(384*256*4);
        for(const fraction of [.05,.25,.5,.75,.9]){
            const frame=(timeline.frames-1)*fraction;
            stage.seek(frame).play();stage.update(.1);stage.pause();stage.render(renderer);
            if(shaderErrors.length)throw Error(shaderErrors.join(';'));
            if(gl.getError()!==gl.NO_ERROR)throw Error('WebGL error');
            if(!renderer.info.render.calls)throw Error('no rendered geometry');
            let inFrame=0,pose=0;
            const bad=[];
            stage.root.traverse(n=>{
                if(!n.matrixWorld.elements.every(Number.isFinite))bad.push({node:n.name,
                    position:n.position.toArray(),quaternion:n.quaternion.toArray(),scale:n.scale.toArray(),
                    parent:n.parent?.name,parentScale:n.parent?.scale.toArray()});
                if(n.isBone && actor.object.getObjectById(n.id)){
                    const v=n.getWorldPosition(new THREE.Vector3()).project(stage.camera);
                    if(Math.abs(v.x)<=1 && Math.abs(v.y)<=1 && Math.abs(v.z)<=1)inFrame++;
                    pose+=n.position.x+2*n.position.y+3*n.position.z+5*n.quaternion.x+7*n.quaternion.y+11*n.quaternion.z;
                }
                for(const m of (Array.isArray(n.material)?n.material:[n.material])){
                    if(!m)continue;
                    if(!Number.isFinite(m.opacity))bad.push({material:m.name,opacity:m.opacity});
                    for(const t of [m.map,m.alphaMap])if(t && !t.matrix.elements.every(Number.isFinite))
                        bad.push({material:m.name,texture:t.name,uv:t.matrix.elements});
                }
            });
            if(bad.length || !stage.camera.projectionMatrix.elements.every(Number.isFinite))
                throw Error('non-finite scene at frame '+stage.frame+': '+JSON.stringify(bad.slice(0,6)));
            gl.readPixels(0,0,384,256,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
            let hash=2166136261,detail=0;
            for(let i=0;i<pixels.length;i+=16){
                hash=Math.imul(hash^pixels[i],16777619);
                hash=Math.imul(hash^pixels[i+1],16777619);
                hash=Math.imul(hash^pixels[i+2],16777619);
                if(Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])>12)detail++;
            }
            row.samples.push({frame:stage.frame,hash:hash>>>0,coloredSamples:detail,inFrameBones:inFrame,
                pose:Math.round(pose*1e5),calls:renderer.info.render.calls});
        }
        row.distinctFrames=new Set(row.samples.map(s=>s.hash)).size;
        row.distinctPoses=new Set(row.samples.map(s=>s.pose)).size;
        if(row.distinctFrames<2 || !row.samples.some(s=>s.coloredSamples>30))throw Error('blank or unchanged cinematic');
        return row;
    } finally {
        if(stage)stage.dispose();else if(loaded)loader.disposeObject(loaded.scene);
        if(actor)actor.dispose();
        renderer.renderLists.dispose();
    }
}"""


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('models',nargs='*',help='exact model IDs; defaults to all mapped cinematic models')
    parser.add_argument('--limit',type=int)
    parser.add_argument('--batch-size',type=int,default=24)
    args=parser.parse_args()
    playback=json.loads((ROOT/'site/asset/battle/skill-playback.json').read_text(encoding='utf-8'))['models']
    characters={str(r['m_ResourceID']):r for r in load_table('CharacterList.json')}
    wanted=args.models or sorted(rid for rid,row in playback.items() if row.get('ultimate',{}).get('sceneId'))
    if args.limit:wanted=wanted[:args.limit]
    report={'status':'RUNNING','requestedModels':len(wanted),'results':[],'failures':[],'errors':[],
            'scope':'Five sampled frames per model, exact scene/owner motion, real WebGL rendering; not full visual parity.'}
    OUT.mkdir(parents=True,exist_ok=True)
    report_path=OUT/'catalog-report.json'
    def save():report_path.write_text(json.dumps(report,ensure_ascii=False,indent=1),encoding='utf-8')
    save();started=time.monotonic()
    server=Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    base='http://127.0.0.1:%d'%server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
            try:
                context=browser.new_context(viewport={'width':400,'height':280})
                context.route('**/__skill_catalog__',lambda r:r.fulfill(content_type='text/html',body='<html><title>必杀目录检查</title><body></body></html>'))
                page=None
                for i,rid in enumerate(wanted):
                    if i%max(1,args.batch_size)==0:
                        if page:page.close()
                        page=context.new_page()
                        page.on('pageerror',lambda error:report['errors'].append(str(error)))
                        page.goto(base+'/__skill_catalog__');page.evaluate(BOOT)
                    raw=characters[rid]
                    config={'model':rid,'sceneId':playback[rid]['ultimate']['sceneId'],
                            'classId':raw['m_Class'],'headId':raw.get('m_HeadID',0)}
                    try:
                        row=page.evaluate(SAMPLE,config)
                        report['results'].append(row)
                    except Exception as error:
                        report['failures'].append({**config,'error':str(error)})
                        page.screenshot(path=str(OUT/f'catalog-fail-{rid}.png'))
                        print('FAIL',rid,str(error)[:300],flush=True)
                    if (i+1)%25==0 or i+1==len(wanted):
                        print(f"[{i+1}/{len(wanted)}] rendered={len(report['results'])} failures={len(report['failures'])}",flush=True)
                        save()
                report['uniqueScenes']=len({r['sceneId'] for r in report['results']})
                report['offscreenCandidates']=[r['model'] for r in report['results'] if not any(s['inFrameBones'] for s in r['samples'])]
                report['status']='FAIL' if report['failures'] or report['errors'] else 'PASS'
            finally:browser.close()
    except Exception as error:
        report['status']='FAIL';report['fatal']=repr(error)
        raise
    finally:
        report['elapsedSeconds']=round(time.monotonic()-started,1);save()
        server.shutdown();server.server_close();thread.join(timeout=5)
    if report['status']!='PASS':raise SystemExit(1)


if __name__=='__main__':
    main()
