"""GPU parity and bounded material ownership for repeated enemy warnings.

This uses deterministic render calls, not a natural-frame performance claim.
Run before/after with distinct labels; the original implementation must fail
the shader-reuse gate while still supplying independent pixel references.
"""
import argparse
import functools
import json
import re
import threading

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_boss_choreography_browser import ROOT, SETUP, AREA_PIXELS, LIFETIME
from rl_natural_frame_browser import fingerprints

OUT = ROOT / '.codex-tmp/telegraph-reuse'

REUSE = r"""async () => {
    const a=audit,gl=a.renderer.getContext(),width=gl.drawingBufferWidth,height=gl.drawingBufferHeight;
    const pixels=()=>{a.render();const bytes=new Uint8Array(width*height*4);
        gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return bytes;};
    const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
        .map(n=>n.toString(16).padStart(2,'0')).join('');
    const retire=()=>{a.world.enemies=[];a.view.sync(a.world);a.render();};
    const shapeCases=[
        {kind:'disc',x:0,y:0,radius:2},
        {kind:'annulus',x:0,y:0,inner:1,outer:3},
        {kind:'sector',x:0,y:0,radius:4,angle:.67,arc:1.42},
        {kind:'lane',x1:-2,y1:-1,x2:2,y2:1.3,radius:.6},
        {kind:'lane',x1:0,y1:0,x2:0,y2:0,radius:.6}
    ],parity=[];
    for(const [i,shape] of shapeCases.entries()) {
        retire();a.view.clear();a.render();
        a.show([shape]);const fresh=pixels();
        // Reuse must reset active red/opacity as well as changing geometry.
        a.show([{kind:'disc',x:4,y:2,radius:.7}],'active');
        retire();a.show([shape]);const reused=pixels();
        let differences=0;for(let j=0;j<fresh.length;j++)if(fresh[j]!==reused[j])differences++;
        parity.push({index:i,kind:shape.kind,differences,hash:await hash(fresh)});
    }
    retire();a.view.clear();a.render();
    const baseline={geometries:a.renderer.info.memory.geometries,programs:a.renderer.info.programs.length};
    const resources=new Map();
    function track() {a.view.object.traverse(node=>{
        for(const resource of [node.geometry,node.material].flat()) {
            if(!resource||resources.has(resource))continue;
            resources.set(resource,0);
            resource.addEventListener('dispose',()=>resources.set(resource,resources.get(resource)+1));
        }
    });}
    function pair(left='active',right='windup') {
        a.world.enemies=[
            {dead:false,stunTimer:0,action:a.action([{kind:'disc',x:-3,y:0,radius:1.5}],left)},
            {dead:false,stunTimer:0,action:a.action([{kind:'annulus',x:3,y:0,inner:.5,outer:1.7}],right)}
        ];
        a.view.sync(a.world);a.render();track();
    }
    pair();const activeLeft=a.sample(-3,0),warningRight=a.sample(4,0);
    let materials=[];a.view.object.traverse(node=>{if(node.material)materials.push(node.material);});
    const independent=new Set(materials).size===4;
    const firstIdentity=new Set(materials),beforeSwap=pixels();
    pair('windup','active');const warningLeft=a.sample(-3,0),activeRight=a.sample(4,0);
    pair();const restored=pixels();
    let restoreDiff=0;for(let i=0;i<restored.length;i++)if(restored[i]!==beforeSwap[i])restoreDiff++;
    const originalCreate=gl.createProgram,originalDelete=gl.deleteProgram;
    let creates=0,deletes=0,maxGeometries=0,maxMaterials=0,hiddenDraws=0;
    gl.createProgram=function(...args){creates++;return originalCreate.apply(this,args);};
    gl.deleteProgram=function(...args){deletes++;return originalDelete.apply(this,args);};
    try {
        for(let i=0;i<16;i++) {
            retire();hiddenDraws+=a.renderer.info.render.calls;
            pair(i%2?'windup':'active',i%2?'active':'windup');
            maxGeometries=Math.max(maxGeometries,a.renderer.info.memory.geometries);
            maxMaterials=Math.max(maxMaterials,[...resources].filter(([r,n])=>r.isMaterial&&n===0).length);
        }
        retire();hiddenDraws+=a.renderer.info.render.calls;
    } finally {gl.createProgram=originalCreate;gl.deleteProgram=originalDelete;}
    const idleMaterials=[...resources].filter(([r,n])=>r.isMaterial&&n===0).length;
    const identitiesReused=[...resources.keys()].filter(r=>r.isMaterial).every(r=>firstIdentity.has(r));
    const geometryRetired=[...resources].filter(([r])=>r.isBufferGeometry).every(([,n])=>n===1);
    const afterRetire={count:a.view.count,children:a.view.object.children.length,
        geometries:a.renderer.info.memory.geometries};
    a.view.clear();a.render();
    const afterClear={count:a.view.count,geometries:a.renderer.info.memory.geometries,
        programs:a.renderer.info.programs.length,allReleased:[...resources.values()].every(n=>n===1)};
    pair();const afterClearRebuilt=a.view.count===2;
    a.view.dispose();a.view.dispose();a.view.sync(a.world);a.render();
    return {parity,baseline,independent,activeLeft,warningRight,warningLeft,activeRight,restoreDiff,
        creates,deletes,maxGeometries,maxMaterials,hiddenDraws,idleMaterials,identitiesReused,
        geometryRetired,afterRetire,afterClear,afterClearRebuilt,resources:resources.size,
        final:{count:a.view.count,attached:!!a.view.object.parent,geometries:a.renderer.info.memory.geometries,
            programs:a.renderer.info.programs.length,allReleased:[...resources.values()].every(n=>n===1)}};
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--label', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_-]+', args.label):
        parser.error('bounded output label required')
    target = OUT / args.label
    target.mkdir(parents=True, exist_ok=True)
    if (target / 'report.json').exists():
        parser.error('use a new label to retain existing evidence')
    report = {'complete':False,'checks':[],'errors':[],'source_before':fingerprints()}
    def check(name, ok):
        report['checks'].append({'name':name,'ok':bool(ok)})
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)
    with Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
                page=browser.new_page(viewport={'width':800,'height':600})
                page.on('pageerror',lambda error:report['errors'].append(str(error)))
                page.route('**/telegraph-reuse.html',lambda route:route.fulfill(content_type='text/html',body='<html><body style="margin:0"></body></html>'))
                page.goto('http://127.0.0.1:%d/telegraph-reuse.html'%server.server_address[1])
                page.evaluate(SETUP)
                report['environment']=page.evaluate("""()=>{const gl=audit.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
                    return {renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),dpr:devicePixelRatio};}""")
                area=page.evaluate(AREA_PIXELS);report['areas']=area
                check('四类区域八方向的内外像素仍与判定形状一致',all(all(r['inside']) and not any(r['outside']) and r['sameArea'] for r in area['rows']))
                check('零长度线段、隐藏负对照与恢复期正确',area['zero']['inside'] and not area['zero']['outside'] and not area['hidden'] and area['restored'] and not area['recovering'])
                result=page.evaluate(REUSE);report['reuse']=result
                check('所有区域冷启动与复用逐字节像素一致',all(r['differences']==0 for r in result['parity']))
                check('两个同时存在的动作材质独立，切换阶段完整恢复',result['independent'] and result['activeLeft']!=result['warningLeft'] and result['warningRight']!=result['activeRight'] and result['restoreDiff']==0)
                check('预热后16轮双威胁不重复创建或删除着色器',result['creates']==0 and result['deletes']==0)
                check('活动和离场材质总量不超过两对且实际复用',result['maxMaterials']<=4 and result['idleMaterials']==4 and result['identitiesReused'])
                check('到期立即释放几何、无预警绘制或残留场景节点',result['geometryRetired'] and result['hiddenDraws']==0 and result['afterRetire']['count']==0 and result['afterRetire']['children']==0 and result['afterRetire']['geometries']==result['baseline']['geometries'])
                check('clear释放全部缓存及program且支持重新创建',result['afterClear']['allReleased'] and result['afterClear']['programs']==result['baseline']['programs'] and result['afterClearRebuilt'])
                check('重复销毁及销毁后同步无复活或重复释放',result['final']['allReleased'] and result['final']['count']==0 and not result['final']['attached'] and result['final']['programs']==result['baseline']['programs'] and result['final']['geometries']==result['baseline']['geometries'])
                page.evaluate(SETUP)
                lifetime=page.evaluate(LIFETIME);report['lifetime']=lifetime
                check('40轮双威胁六区域保持绘制预算且无GPU几何增长',lifetime['maxCalls']<=12 and lifetime['maxGeometries']-lifetime['baseline']<=12 and all(n==lifetime['baseline'] for n in lifetime['memory']))
                check('死亡眩晕及重复销毁只释放私有资源一次',lifetime['singleRelease'] and lifetime['detached'] and lifetime['finalCount']==0 and lifetime['finalGeometries']==lifetime['baseline'])
                check('浏览器没有未处理页面异常',not report['errors'])
                report['complete']=True
                browser.close()
        except Exception as error:
            report['failure']=repr(error)
            raise
        finally:
            server.shutdown();worker.join(timeout=5)
            report['source_after']=fingerprints()
            report['changed_during_run']=[name for name in report['source_before'] if report['source_before'][name]!=report['source_after'].get(name)]
            (target/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    return int(not report['complete'] or bool(report['errors']) or bool(report['changed_during_run']) or any(not row['ok'] for row in report['checks']))


if __name__=='__main__':raise SystemExit(main())
