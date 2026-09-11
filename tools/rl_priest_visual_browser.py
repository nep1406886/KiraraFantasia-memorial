"""Priest normal attacks must carry original EffectPlay art, not a generic oval.

Adapting the authored caster effect to a travelling world projectile is explicit;
these checks retain the existing trajectory and never change damage semantics.
"""
import argparse
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_projectile_visual_browser import SETUP, NATIVE_GEOMETRY

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.codex-tmp'/'priest-visual'

PIXELS="""() => {
    const a=audit,hidden=[];
    a.scene.traverse(n=>{if(n.isInstancedMesh||n.name.startsWith('pe:'))hidden.push([n,n.visible]);});
    hidden.forEach(([n])=>n.visible=false);a.renderer.render(a.scene,a.camera);
    const gl=a.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
    const bytes=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    let pixels=0;for(let i=0;i<bytes.length;i+=4)if(Math.abs(bytes[i]-bytes[0])
        +Math.abs(bytes[i+1]-bytes[1])+Math.abs(bytes[i+2]-bytes[2])>30)pixels++;
    hidden.forEach(([n,visible])=>n.visible=visible);return pixels;
}"""

def main():
    p=argparse.ArgumentParser();p.add_argument('--label',default='current');args=p.parse_args()
    if not args.label.replace('-','').isalnum():p.error('invalid label')
    OUT.mkdir(parents=True,exist_ok=True);report={'checks':[],'elements':[],'errors':[]}
    def check(label,ok,detail=None):
        report['checks'].append({'label':label,'ok':bool(ok),'detail':detail});print(('PASS ' if ok else 'FAIL ')+label,flush=True)
    server=Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    base='http://127.0.0.1:%d'%server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
            def create_page(fail=False):
                page=browser.new_page(viewport={'width':800,'height':600})
                page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.route('**/priest-audit.html',lambda r:r.fulfill(content_type='text/html',body='<html><body style="margin:0"><div id="stage"></div></body></html>'))
                if fail:page.route('**/ef_btl_priest_attack_*.glb.gz',lambda r:r.fulfill(status=503,body='injected missing priest effect'))
                page.goto(base+'/priest-audit.html')
                page.evaluate(SETUP,{'cap':8,'preload':True})
                page.evaluate("""async()=>{audit.unit.card.class=2;audit.unit.weaponProfile={classId:2,kind:'projectile'};
                    audit.unit.skills.normal.id=3;try{await audit.fx.prepare(audit.unit)}catch(e){}}""")
                return page
            page=create_page()
            for element in range(6):
                page.evaluate("""element=>{const a=audit;a.fx.clear();a.bullets.clear();a.unit.element=element;
                    for(let i=0;i<8;i++)a.fire(i*Math.PI/4,{element,skillId:3});
                    a.list().forEach((b,i)=>b.x=(i-3.5)*.7);a.render(0);}""",element)
                page.wait_for_function('audit.fx.stats.loaded===audit.fx.stats.active',timeout=30000)
                page.evaluate('audit.render(.12)')
                state=page.evaluate('audit.state()');geometry=page.evaluate(NATIVE_GEOMETRY)
                pixels=page.evaluate(PIXELS)
                prefix='属性'+str(element)+' '
                check(prefix+'八方向使用原作牧师特效且不叠画通用弹',state['native']==8 and state['generic']==0,state)
                check(prefix+'八条原作主光线产生可辨识像素（不计装饰粒子）',pixels>800,pixels)
                check(prefix+'原作效果跟随真实轨迹与相机投影',all(r.get('ready') and r['centreError']<1e-6 and r['alignment']>.99999 for r in geometry),geometry)
                report['elements'].append({'element':element,'state':state,'geometry':geometry,'pixels':pixels})
                page.evaluate('audit.render(0)');page.screenshot(path=str(OUT/(args.label+'-'+str(element)+'.png')))
            state=page.evaluate("""()=>{const a=audit;a.fx.clear();a.bullets.clear();a.fx.emitSlash(a.unit);return a.fx.stats;}""")
            check('原作牧师普攻不在施法者和弹体上重复创建同一效果',state['active']==0,state)
            page.evaluate('audit.fx.dispose();audit.view.dispose()')
            page.wait_for_function('audit.native.nativeCacheStats().refs===0',timeout=30000)
            check('释放后实例引用归零',page.evaluate('audit.native.nativeCacheStats().refs')==0)
            page.close()
            page=create_page(True)
            page.evaluate('audit.fire(0,{skillId:3});audit.render(.1)')
            page.wait_for_timeout(150)
            state=page.evaluate('audit.render(.1);audit.state()')
            check('原作素材失败时保留可见回退，不隐藏真实弹体',state['native']==0 and state['generic']==1,state)
            page.close();browser.close()
        check('无未捕获页面异常',not report['errors'],report['errors'])
    finally:
        server.shutdown();worker.join(timeout=5);server.server_close()
        (OUT/(args.label+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    return int(any(not x['ok'] for x in report['checks']))

if __name__=='__main__':raise SystemExit(main())
