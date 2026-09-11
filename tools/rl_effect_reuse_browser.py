"""Original effects: bounded reuse, real shader programs/pixels and clear ownership.

This deterministic WebGL gate is not a natural-frame benchmark. The separate
rl_natural_frame_browser.py owns those measurements.
"""
import argparse
import functools
import hashlib
import json
import re
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/effect-reuse'
FILES = ['site/game/rl/view/skillvfx.js', 'site/game/rl/view/nativeassets.js', 'site/core/uniqueskill.js',
         'site/core/usparticle.js', 'site/core/usmaterial.js', 'site/game/rl/view/layers.js']
SETUP = r"""async () => {
    const {THREE:T} = await (await import('/site/core/loader.js')).loadModules();
    const {createSkillVFX} = await import('/site/game/rl/view/skillvfx.js');
    const native = await import('/site/game/rl/view/nativeassets.js');
    const scene = new T.Scene(); scene.background = new T.Color('#172331');
    const camera = new T.OrthographicCamera(-3,3,2.8,-1.7,.1,100);
    camera.position.set(0,0,10); camera.lookAt(0,0,0);
    const renderer = new T.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});
    renderer.setPixelRatio(1); renderer.setSize(640,480);document.body.appendChild(renderer.domElement);
    document.body.style.margin='0';
    const fx = createSkillVFX(scene,T,{camera,maxEffects:28});await fx.ready;
    const gl=renderer.getContext(), counts={created:0,deleted:0}, originalCreate=gl.createProgram, originalDelete=gl.deleteProgram;
    gl.createProgram=function(...args){counts.created++;return originalCreate.apply(this,args);};
    gl.deleteProgram=function(...args){counts.deleted++;return originalDelete.apply(this,args);};
    const effect='ef_btl_fighter_attack_moon_00';
    const config={kind:'cast',angle:.231,mirror:true,startFrame:9,duration:.25,combatPivot:true};
    async function spawn(key=effect,options={}) {
        const record=fx.emitNative(key,0,0,{...config,...options});
        if(!record)throw Error('Effect not admitted: '+key);
        const deadline=performance.now()+30000;
        while(!record.instance&&!record.closed&&performance.now()<deadline) await new Promise(r=>setTimeout(r,10));
        if(!record.instance)throw Error('Effect did not load: '+key);
        return record;
    }
    function render(dt=0){fx.update(dt);renderer.render(scene,camera);}
    function pixels(record){
        const hidden=[];record.instance.root.traverse(node=>{if(node.name.startsWith('pe:')){hidden.push([node,node.visible]);node.visible=false;}});
        renderer.render(scene,camera);const bytes=new Uint8Array(640*480*4);gl.readPixels(0,0,640,480,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
        for(const [node,visible]of hidden)node.visible=visible;
        return bytes;
    }
    function comparable(record){const nodes=[];record.instance.root.traverse(node=>{
        if(node.name==='usParticles'||node.name.startsWith('pe:'))return;
        const materials=node.isMesh?(Array.isArray(node.material)?node.material:[node.material]):[];
        nodes.push({name:node.name,visible:node.visible,p:node.position.toArray(),q:node.quaternion.toArray(),s:node.scale.toArray(),
            materials:materials.map(m=>({name:m.name,opacity:m.opacity,color:m.color?.toArray(),
                uv:m.map?.matrix.toArray(),alphaUV:m.alphaMap?.matrix.toArray()}))});});return nodes;}
    window.reuse={T,scene,camera,renderer,gl,counts,fx,native,effect,config,spawn,render,pixels,comparable};
}"""
RUN = r"""async () => {
    const a=reuse,checks=[],check=(label,ok,detail=null)=>checks.push({label,ok:!!ok,detail});
    const first=await a.spawn();a.render(.05);
    const reference=a.pixels(first), state=JSON.stringify(a.comparable(first));
    let painted=0;for(let i=0;i<reference.length;i+=4)if(reference[i]!==23||reference[i+1]!==35||reference[i+2]!==49)painted++;
    check('首个原作主刀光真实可见，不以粒子代替',painted>64,{painted});
    const initialPrograms=a.counts.created, firstRoot=first.instance.root.uuid;
    const firstParticle=first.particles?.liveCount()||0;
    a.render(.5);
    check('到期立即退场，离场资源可复用且不保留旧记录实例',a.fx.stats.active===0
        &&a.scene.children.length===0&&a.fx.stats.cached===1&&first.closed&&!first.instance,a.fx.stats);
    let created=0,maxPixels=0,statesEqual=true,particleRestarts=0,sameRoot=true,oldIsolated=true;
    const iterations=[];
    for(let i=0;i<16;i++){
        const before=a.counts.created, record=await a.spawn();
        const atStart=record.particles?.liveCount()||0;
        a.render(.05);const actual=a.pixels(record);
        let changed=0;for(let j=0;j<reference.length;j++)if(reference[j]!==actual[j])changed++;
        maxPixels=Math.max(maxPixels,changed);statesEqual&&=JSON.stringify(a.comparable(record))===state;
        sameRoot&&=record.instance.root.uuid===firstRoot;
        const live=record.particles?.liveCount()||0;if(atStart===0&&live>0)particleRestarts++;
        created+=a.counts.created-before;
        iterations.push({index:i,created:a.counts.created-before,changed,particles:live,atStart});
        a.render(.5);oldIsolated&&=record.closed&&!record.instance;
    }
    check('16次间歇重复普攻不重新创建着色器程序',created===0,{initialPrograms,created,iterations});
    check('复用同一离场资源但不复用旧记录或粒子寿命',sameRoot&&oldIsolated&&firstParticle>0&&particleRestarts===16,
        {sameRoot,oldIsolated,firstParticle,particleRestarts});
    check('重复播放主图形逐字节像素与TRS/UV/颜色相同',maxPixels===0&&statesEqual,{maxPixels,statesEqual});
    const turn=await a.spawn(a.effect,{angle:-1.7,mirror:false,stretchX:1.4,stretchY:.85});a.render(.14);a.render(.5);
    const restored=await a.spawn();a.render(.05);
    const afterTurn=a.pixels(restored);let turnDiff=0;
    for(let j=0;j<reference.length;j++)if(reference[j]!==afterTurn[j])turnDiff++;
    check('相反方向镜像及拉伸后恢复原形，没有旧方向或UV残留',turnDiff===0&&JSON.stringify(a.comparable(restored))===state,{turnDiff});
    const other=await a.spawn(a.effect,{angle:2.1});a.render(.02);
    const leftMaterials=[],rightMaterials=[];
    restored.instance.root.traverse(n=>{if(n.isMesh)leftMaterials.push(...(Array.isArray(n.material)?n.material:[n.material]));});
    other.instance.root.traverse(n=>{if(n.isMesh)rightMaterials.push(...(Array.isArray(n.material)?n.material:[n.material]));});
    const borrowedMaps=leftMaterials.flatMap(m=>[m.map,m.alphaMap]).filter(Boolean);
    check('并发同特效使用独立根、时间线、材质和动画UV',restored.instance.root!==other.instance.root
        &&restored.timeline!==other.timeline&&rightMaterials.every(m=>!leftMaterials.includes(m)
            &&![m.map,m.alphaMap].filter(Boolean).some(t=>borrowedMaps.includes(t))));
    a.render(.5);
    check('并发结束同键只缓存一份，不按出招次数增长',a.fx.stats.active===0&&a.fx.stats.cached===1
        &&a.native.nativeCacheStats().refs===1,{stats:a.fx.stats,cache:a.native.nativeCacheStats()});
    const variants=['fire','water','earth','wind','sun'].map(e=>'ef_btl_fighter_attack_'+e+'_00');
    const common=['ef_btl_recover_00','ef_btl_barrier_00','ef_btl_buff_line','ef_btl_buff_ring','ef_btl_dmg_single_00'];
    for(const key of [...variants,...common]){await a.spawn(key,{startFrame:undefined,duration:.35});a.render(.05);a.render(.5);}
    check('不同特效离场缓存有8份硬上限，多余项真实释放',a.fx.stats.cached===8
        &&a.fx.stats.active===0&&a.native.nativeCacheStats().refs===8,{stats:a.fx.stats,cache:a.native.nativeCacheStats()});
    a.fx.clear();a.fx.clear();
    check('换房式clear释放全部空闲/活跃原作引用且幂等',a.fx.stats.cached===0
        &&a.fx.stats.active===0&&a.native.nativeCacheStats().refs===0&&a.scene.children.length===0);
    const pending=a.fx.emitNative(a.effect,0,0,a.config);a.fx.clear();
    await new Promise(r=>setTimeout(r,20));
    check('clear后迟到请求不进入离场缓存或可见场景',pending.closed&&!pending.instance
        &&a.fx.stats.cached===0&&a.fx.stats.active===0&&a.native.nativeCacheStats().refs===0&&a.scene.children.length===0);
    await a.spawn();a.render(.05);a.fx.dispose();a.fx.dispose();
    check('销毁释放所有缓存/活跃实例且不能再次发射',a.native.nativeCacheStats().refs===0
        &&a.fx.stats.cached===0&&a.fx.stats.active===0&&a.fx.emitNative(a.effect,0,0)===null);
    return {checks,programs:a.counts};
}"""


def fingerprints():
    return {name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in FILES}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--label',default='current');args=parser.parse_args()
    if not re.fullmatch('[a-zA-Z0-9_-]+',args.label):parser.error('invalid label')
    target=OUT/args.label;target.mkdir(parents=True,exist_ok=True)
    if (target/'report.json').exists():parser.error('use a new label to preserve evidence')
    report={'complete':False,'checks':[],'errors':[],'source_before':fingerprints()}
    server=Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
            page=browser.new_page(viewport={'width':640,'height':480})
            page.on('pageerror',lambda e:report['errors'].append(str(e)))
            page.route('**/effect-reuse-check',lambda route:route.fulfill(content_type='text/html',body='<body></body>'))
            page.goto('http://127.0.0.1:%d/effect-reuse-check'%server.server_address[1])
            page.evaluate(SETUP)
            report.update(page.evaluate(RUN))
            for row in report['checks']:print(('PASS ' if row['ok'] else 'FAIL ')+row['label'],flush=True)
            report['complete']=True
            browser.close()
    except Exception as error:
        report['failure']=repr(error);raise
    finally:
        server.shutdown();worker.join(timeout=5);server.server_close()
        report['source_after']=fingerprints()
        report['changed_during_run']=[name for name in FILES if report['source_before'][name]!=report['source_after'][name]]
        (target/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    if report['errors'] or report['changed_during_run'] or any(not row['ok'] for row in report['checks']):
        raise SystemExit(1)


if __name__=='__main__':main()

