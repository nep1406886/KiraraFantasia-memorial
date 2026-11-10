"""Isolate original melee scenes from fallback marks and measure their GPU pixels."""
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import Server, NoCacheHandler
from rl_projectile_visual_browser import SETUP

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.codex-tmp/native-blades'
MEASURE=r"""async()=>{
    const a=audit,T=a.T,{weaponProfile}=await import('/site/game/rl/weaponprofile.js');
    const target=new T.WebGLRenderTarget(800,600),rows=[];
    a.scene.background=new T.Color('#262233');a.renderer.setRenderTarget(target);
    function read(){a.scene.updateMatrixWorld(true);a.renderer.render(a.scene,a.camera);
        const out=new Uint8Array(800*600*4);a.renderer.readRenderTargetPixels(target,0,0,800,600,out);return out;}
    try{for(const cls of [0,3])for(const element of [0,1,2,3,4,5])for(const angle of [0,Math.PI/2,Math.PI,Math.PI*1.5]){
        a.fx.clear();Object.assign(a.unit,{card:{class:cls},element,skills:null,x:0,y:0,facing:angle,swingId:1,
            weaponProfile:weaponProfile({class:cls}),sm:{state:'attack',stateTime:.18}});
        a.unit.swingProfile=a.unit.weaponProfile;await a.fx.prepare(a.unit);a.fx.emitSlash(a.unit);
        for(let i=0;i<100&&a.fx.stats.loaded===0;i++)await new Promise(r=>setTimeout(r,10));
        a.render(.01);const blade=a.scene.getObjectByName('player-attack-reach');blade.visible=false;
        const roots=a.scene.children.filter(n=>n.userData.rlOverlay&&!n.isMesh&&!n.isInstancedMesh);
        const full=read();roots.forEach(n=>n.visible=false);const plain=read();roots.forEach(n=>n.visible=true);
        let pixels=0,sumX=0,sumY=0,minX=800,minY=600,maxX=0,maxY=0;
        for(let y=0;y<600;y++)for(let x=0;x<800;x++){const i=(y*800+x)*4;
            if(Math.abs(full[i]-plain[i])+Math.abs(full[i+1]-plain[i+1])+Math.abs(full[i+2]-plain[i+2])>25){
                pixels++;sumX+=x;sumY+=y;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
        const center=new T.Vector3(Math.cos(angle)*a.unit.weaponProfile.range*.5,1,Math.sin(angle)*a.unit.weaponProfile.range*.5).project(a.camera);
        rows.push({cls,element,angle,pixels,roots:roots.length,sources:a.fx.stats.sources,
            centerError:pixels?Math.hypot(sumX/pixels-(center.x+1)*400,sumY/pixels-(center.y+1)*300):999,
            bounds:[minX,minY,maxX,maxY]});
    }}finally{a.renderer.setRenderTarget(null);target.dispose();a.fx.clear();}
    return rows;
}"""

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    server=Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    report={'errors':[]}
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(channel='msedge',args=['--enable-unsafe-swiftshader'])
            page=browser.new_page(viewport={'width':800,'height':600});page.on('pageerror',lambda e:report['errors'].append(str(e)))
            page.route('**/blade-probe.html',lambda r:r.fulfill(content_type='text/html',body='<style>body{margin:0}</style><div id="stage"></div>'))
            page.goto('http://127.0.0.1:%d/blade-probe.html'%server.server_address[1]);page.evaluate(SETUP,{'cap':8,'preload':True})
            report['rows']=page.evaluate(MEASURE)
            for row in report['rows']:
                assert row['pixels']>40 and row['roots']>0 and row['centerError']<90,str(row)
            for cls in [0,3]:
                page.evaluate("""async cls=>{const a=audit,{weaponProfile}=await import('/site/game/rl/weaponprofile.js');
                    Object.assign(a.unit,{card:{class:cls},element:1,skills:null,x:0,y:0,facing:0,weaponProfile:weaponProfile({class:cls})});
                    a.unit.swingProfile=a.unit.weaponProfile;await a.fx.prepare(a.unit);a.fx.emitSlash(a.unit);}""",cls)
                page.wait_for_function('audit.fx.stats.loaded>0');page.evaluate('audit.render(.015)')
                page.screenshot(path=str(OUT/('native-'+str(cls)+'.png')));page.evaluate('audit.fx.clear()')
            assert not report['errors'],report['errors']
            report['passed']=len(report['rows']);print('PASS original animated blade GPU cases:',report['passed'])
            browser.close()
    finally:
        (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        server.shutdown();worker.join(timeout=5);server.server_close()

if __name__=='__main__':main()
