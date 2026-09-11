"""Visual/semantic regressions for the shared original cinematic renderer."""
import argparse
import functools
import io
import json
from pathlib import Path
import re
import threading

import numpy as np
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
from check_models_viewer import boot
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".codex-tmp/skill-render"
MODELS = ["100003", "100103", "230001", "230002", "380003", "380004", "360003", "410003",
          "420003", "430003", "460001", "460002", "150003", "300003",
          "110107", "300206", "321401", "170205", "322001",
          "140503", "140504", "170009", "170010", "180105", "180106",
          "240103", "240104", "290103", "290104", "290203", "290204"]
STEP_FRAMES = {rid: frame for pair, frame in [
    (("140503", "140504"), 540), (("170009", "170010"), 503),
    (("180105", "180106"), 454.5), (("240103", "240104"), 380),
    (("290103", "290104"), 322), (("290203", "290204"), 390)
] for rid in pair}

SEMANTICS = r"""async () => {
    const {THREE} = await (await import('/site/core/loader.js')).loadModules();
    const us = await import('/site/core/uniqueskill.js');
    const root = new THREE.Group();
    const shared = new THREE.Texture();
    const original = [];
    const texture = {coverageUV:[1,1], translationUV:[0,0], offsetUV:[0,0], rotateUV:0};
    function mesh(name, color) {
        const material = new THREE.MeshBasicMaterial({map:shared});
        material.name=name; original.push(material);
        material.userData.msb={diffuse:[1,1,1,1], blend:{name:'std'}, textures:[texture]};
        const item = new THREE.Mesh(new THREE.PlaneGeometry(), material);
        item.name=name;
        item.userData.msb={meshColor:color, visible:true, renderStage:21, renderOrder:0};
        root.add(item); return item;
    }
    const a=mesh('a',[.5,.5,.5,.4]), b=mesh('b',[1,1,1,1]);
    const glow=mesh('glow',[.5,.5,.5,.4]);glow.userData.msb.hdrFactor=.5;
    const facing=new THREE.Group();facing.name='facing';facing.userData.msb={billboard:1};root.add(facing);
    const camera=new THREE.OrthographicCamera();camera.position.set(1,0,1);
    const motion=new THREE.Group();motion.name='motion';root.add(motion);
    us.applySceneState(root,THREE);
    const timeline={fps:30,frames:31,trs:{motion:{t:[[0,[0,0,0]],[30,[1,0,0]]]}},channels:[
        {name:'a',target:'matColor.a',keys:[[0,.5,2]]},
        {name:'a',target:'matColor.r',keys:[[0,.6,2]]},
        {name:'a',target:'texOffsetUV',comp:0,p:[0,0,0],keys:[[0,.25,2]]},
        {name:'b',target:'texOffsetUV',comp:0,p:[0,0,0],keys:[[0,.75,2]]}
    ]};
    const player=us.createPlayer({THREE,root,timeline,camera,audio:null});
    player.seek(7.5);
    const result={opacity:a.material.opacity, red:a.material.color.r,
        position:motion.position.x, independentMaps:a.material.map!==b.material.map,
        leftUV:a.material.map.matrix.elements[6], rightUV:b.material.map.matrix.elements[6]};
    result.hdrRed=glow.material.color.r;result.hdrAlpha=glow.material.opacity;
    result.facing=new THREE.Vector3(0,0,1).applyQuaternion(facing.quaternion).toArray();
    player.seek(20);player.seek(7.5);
    result.rewindOpacity=a.material.opacity;
    for(const m of [a,b,glow]){m.geometry.dispose();m.material.map.dispose();m.material.dispose();}
    original.forEach(m=>m.dispose()); shared.dispose();
    return result;
}"""

LAYERS = r"""async () => {
    const {THREE} = await (await import('/site/core/loader.js')).loadModules();
    const us = await import('/site/core/uniqueskill.js');
    const scene = new THREE.Scene();
    function data(rgba) {
        const t=new THREE.DataTexture(new Uint8Array(rgba),1,1);
        t.needsUpdate=true;return t;
    }
    const base=data([128,64,32,128]), layer=data([51,102,153,64]);
    const originals=[];
    function mesh(mode) {
        const material=new THREE.MeshBasicMaterial({map:base,alphaMap:layer});
        originals.push(material);material.name='layer-'+mode;
        material.userData.msb={diffuse:[1,1,1,1],blend:{name:'std'},layerTexture:{index:1},textures:[
            {type:0,layer:0,coverageUV:[1,1],offsetUV:[.1,.2]},
            {type:0,layer:1,coverageUV:[1,1],offsetUV:[.6,.3],layerBlendMode:mode,layerBlendModeAlpha:mode}
        ]};
        const m=new THREE.Mesh(new THREE.PlaneGeometry(2,2),material);
        m.userData.msb={meshColor:[1,1,1,1],renderStage:21,renderOrder:0};
        scene.add(m);return m;
    }
    const meshes=[0,1,2,3,4,5,6].map(mesh);
    us.applySceneState(scene,THREE);
    const a=meshes[0].material;
    const result={staticBase:a.map.matrix.elements.slice(6,8),staticLayer:a.alphaMap.matrix.elements.slice(6,8)};
    const player=us.createPlayer({THREE,root:scene,timeline:{fps:30,frames:31,channels:[
        {name:a.name,target:'texOffsetUV',comp:0,p:[0,0,1],keys:[[0,.75,2]]},
        {name:a.name,target:'texOffsetUV',comp:0,p:[0,0,0],keys:[[0,.25,2]]},
        {name:a.name,target:'texOffsetUV',comp:1,p:[0,0,1],keys:[[0,.35,2]]},
        {name:a.name,target:'texOffsetUV',comp:0,p:[0,1,0],keys:[[0,100,2]]}
    ]},audio:null});
    player.seek(12);player.seek(0);
    result.animatedBase=a.map.matrix.elements.slice(6,8);
    result.animatedLayer=a.alphaMap.matrix.elements.slice(6,8);
    const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setSize(4,4);
    const target=new THREE.WebGLRenderTarget(4,4);
    const camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=1;
    const shaderErrors=[];renderer.debug.onShaderError=(...args)=>shaderErrors.push('shader compilation failed');
    renderer.setRenderTarget(target);result.pixels=[];
    for(const selected of meshes){
        for(const m of meshes)m.visible=m===selected;
        selected.material.transparent=true;selected.material.blending=THREE.NoBlending;
        selected.material.toneMapped=false;renderer.render(scene,camera);
        const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(target,2,2,1,1,pixel);
        result.pixels.push(Array.from(pixel));
    }
    result.shaderErrors=shaderErrors;
    target.dispose();renderer.dispose();renderer.forceContextLoss();
    for(const m of meshes){m.geometry.dispose();m.material.map.dispose();m.material.alphaMap.dispose();m.material.dispose();}
    originals.forEach(m=>m.dispose());base.dispose();layer.dispose();
    return result;
}"""


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('models',nargs='*')
    args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    report={"status":"RUNNING","requested":args.models or MODELS,"models":[],"errors":[]}
    report_path=OUT/'visual-report.json'
    report_path.write_text(json.dumps(report),encoding='utf-8')
    server=Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    base='http://127.0.0.1:%d'%server.server_address[1]
    shots=[]
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
            try:
                context=browser.new_context(viewport={"width":1440,"height":960})
                manifest=json.loads((ROOT/'site/asset/models/manifest.json').read_text(encoding='utf-8'))
                playback=json.loads((ROOT/'site/asset/battle/skill-playback.json').read_text(encoding='utf-8'))['models']
                catalog=[{"name":key,"path":"bucket-a","size":1} for key in manifest['models']]
                context.route('https://database.kirafan.cn/assetBundle.json',lambda r:r.fulfill(json=catalog))
                context.route(re.compile(r'https://bucket-.*-asset\.kirafan\.cn/.*/index\.json'),lambda r:r.fulfill(status=503,body='offline fixture'))
                context.route(re.compile(r'https://asset\.kirafan\.cn/.*'),lambda r:r.fulfill(path=str(ROOT/'favicon.png'),content_type='image/png'))
                page=context.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
                for rid in args.models or MODELS:
                    boot(page,base,'model_pl_'+rid)
                    if 'semantics' not in report:
                        s=page.evaluate(SEMANTICS);report['semantics']=s
                        assert abs(s['opacity']-.2)<1e-6 and abs(s['red']-.3)<1e-6,s
                        assert abs(s['position']-.15625)<1e-6,s
                        assert s['independentMaps'] and abs(s['leftUV']-.25)<1e-6 and abs(s['rightUV']-.75)<1e-6,s
                        assert abs(s['rewindOpacity']-.2)<1e-6,s
                        assert abs(s['hdrRed']-1)<1e-6 and abs(s['hdrAlpha']-.4)<1e-6,s
                        assert np.allclose(s['facing'],[2**-.5,0,2**-.5]),s
                        print('PASS material/mesh composition, cubic zero tangents, independent UV matrices and rewind',flush=True)
                        layers=page.evaluate(LAYERS);report['layers']=layers
                        for key,expected in [('staticBase',[.1,-.2]),('staticLayer',[.6,-.3]),
                                             ('animatedBase',[.25,-.2]),('animatedLayer',[.75,.35])]:
                            assert np.allclose(layers[key],expected),(key,layers)
                        expected=[[109,74,62,160],[109,74,62,160],[141,90,70,192],
                                  [115,38,0,64],[6,6,5,32],[51,102,153,64],[128,64,32,128]]
                        assert np.max(np.abs(np.array(layers['pixels'])-np.array(expected)))<=1,layers
                        assert not layers['shaderErrors'],layers
                        print('PASS static/animated layer UV, V conversion and all seven blend equations in rendered pixels',flush=True)
                    page.locator('[data-model-action="skill"]').click()
                    page.wait_for_function('!!window.__rendererDebug?.cinematic()',polling=100,timeout=60000)
                    page.locator('#modelMotionToggle').click()
                    source=playback[rid]['ultimate']['sceneId']
                    frames=page.evaluate('window.__rendererDebug.cinematic().player.frames')
                    used=page.evaluate("window.__rendererDebug.clipInfo().find(c=>c.name==='skill' && c.active)")
                    expected=manifest['skillActions'][source]['file']
                    assert used and used['sourceFile']==expected,(rid,used,expected)
                    row={"model":rid,"scene":source,"actionFile":used['sourceFile'],"frames":frames,"samples":[]}
                    sample_frames=[40,200,round((frames-1)*.65),frames-2] if rid=='230001' else [round((frames-1)*f) for f in [.15,.4,.7,.95]]
                    if rid=='100003':sample_frames=[40,200,331,484]
                    if rid in STEP_FRAMES:
                        sample_frames=[round((frames-1)*.15),round((frames-1)*.4),STEP_FRAMES[rid],frames-2]
                    for frame in sample_frames:
                        page.locator('#modelTimeline').fill(str(round(frame/(frames-1)*1000)))
                        page.wait_for_timeout(50)
                        state=page.evaluate('''() => {
                            const c=window.__rendererDebug.cinematic();let badColors=0;const badNodes=[];
                            c.root.updateMatrixWorld(true);
                            c.root.traverse(n=>{const a=n.geometry?.getAttribute('color');
                                if(!n.matrixWorld.elements.every(Number.isFinite))badNodes.push(n.name);
                                if(a)for(const v of a.array){if(!Number.isFinite(v)||v<0||v>1)badColors++;}});
                            return {frame:c.player.frame,badColors,badNodes};
                        }''')
                        assert state['badColors']==0,(rid,state)
                        assert not state['badNodes'],(rid,state)
                        assert abs(state['frame']-frame)<1,(rid,state)
                        filename=f'model-{rid}-frame-{frame}.png'
                        image=Image.open(io.BytesIO(page.locator('#model3dCanvas').screenshot(path=str(OUT/filename)))).convert('RGB')
                        rgb=np.asarray(image)
                        white=float(np.all(rgb>245,axis=2).mean())
                        assert rgb.var()>100,(rid,frame,'blank canvas')
                        if rid=='230001' and frame==200:
                            assert white<.15,('regression: opaque overexposed wind',white)
                        if rid=='100003' and frame==331:
                            yellow=float(((rgb[:,:,0]>180)&(rgb[:,:,1]>120)&(rgb[:,:,2]<100)).mean())
                            assert yellow>.005,('regression: missing sun mask',yellow)
                        row['samples'].append({"frame":frame,"whiteFraction":round(white,4),"file":filename})
                        shots.append((rid,frame,image))
                    page.locator('[data-cinematic-toggle]').click()
                    assert page.evaluate('!window.__rendererDebug.cinematic()')
                    page.locator('[data-cinematic-toggle]').click()
                    page.wait_for_function('!!window.__rendererDebug.cinematic()',polling=100,timeout=60000)
                    report['models'].append(row)
                    print(f'PASS model {rid}: scene {source}, four rendered frames, toggle/replay',flush=True)
                assert not report['errors'],report['errors']
                report['status']='PASS'
            finally:
                browser.close()
    except Exception as exc:
        report['status']='FAIL';report['failure']=repr(exc)
        raise
    finally:
        report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        if shots:
            sheet=Image.new('RGB',(4*320,((len(shots)+3)//4)*240),'#191b21');draw=ImageDraw.Draw(sheet)
            for i,(rid,frame,image) in enumerate(shots):
                image.thumbnail((320,214));x=(i%4)*320;y=(i//4)*240
                sheet.paste(image,(x+(320-image.width)//2,y+24));draw.text((x+8,y+5),f'{rid} / frame {frame}',fill='white')
            sheet.save(OUT/'scene-contact.png')
            for start in range(0,len(shots),20):
                rows=min(5,(len(shots)-start+3)//4)
                sheet.crop((0,start//4*240,1280,(start//4+rows)*240)).save(
                    OUT/f'scene-contact-{start//20+1:02d}.png')
        server.shutdown();server.server_close();thread.join(timeout=5)


if __name__=='__main__':
    main()
