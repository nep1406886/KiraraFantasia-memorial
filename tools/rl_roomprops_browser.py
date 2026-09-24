"""Original furniture pixels, shrine composition, animation and failure ownership."""
import functools
import hashlib
import json
import threading
from pathlib import Path
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_navigation_browser import SETUP
from rl_result_browser import check

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.codex-tmp'/'feedback-20260910'/'roomprops'

PROP="""async key=>{
    const a=nav;if(a.prop)a.prop.dispose();
    const {createRoomProp}=await import('/site/game/rl/view/roomprops.js');
    a.prop=await createRoomProp(a.T,key,{height:2.2,maxWidth:2.5});a.stage.scene.add(a.prop.root);
    a.unit.x=2.1;a.unit.y=1;a.follow.snap(.7,.8);a.view.sync(0);a.prop.update(.2);
    a.stage.render(a.camera,a.actor.object);
    const root=a.prop.root,box=new a.T.Box3().setFromObject(root,true),before=[];
    root.traverse(n=>{if(n.isMesh)before.push([n.name,n.visible,n.position.toArray(),n.scale.toArray(),n.material.opacity]);});
    a.prop.update(.28);const after=[];
    root.traverse(n=>{if(n.isMesh)after.push([n.name,n.visible,n.position.toArray(),n.scale.toArray(),n.material.opacity]);});
    const roots=a.stage.scene.children.map(n=>[n,n.visible]);
    roots.forEach(([n])=>{n.visible=n===root;});a.renderer.render(a.stage.scene,a.camera);
    const gl=a.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight,bytes=new Uint8Array(w*h*4);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    let pixels=0;for(let i=0;i<bytes.length;i+=4)if(Math.abs(bytes[i]-bytes[0])+Math.abs(bytes[i+1]-bytes[1])+Math.abs(bytes[i+2]-bytes[2])>30)pixels++;
    roots.forEach(([n,v])=>n.visible=v);a.stage.render(a.camera,a.actor.object);
    return {key,pixels,ground:box.min.y,height:box.max.y-box.min.y,hasTimeline:!!a.prop.entry.timeline,
        animated:JSON.stringify(before)!==JSON.stringify(after),refs:a.native.nativeCacheStats().refs};
}"""

SHRINE="""async()=>{
    const a=nav;if(a.prop){a.prop.dispose();a.prop=null;}
    a.map=a.maps.createMapView(a.stage.scene,1);await a.map.buildRoom({id:1,type:'battle',seed:74061},undefined,['N','E'],{strict:true});
    const {attachAltarView}=await import('/site/game/rl/view/interactview.js');
    const altar={x:16,y:12,used:false};a.shrine=await attachAltarView(altar,a.stage.scene);
    a.unit.x=18.1;a.unit.y=13;a.follow.snap(16.8,12.3);a.view.sync(0);a.shrine.update(.2);
    a.stage.render(a.camera,a.actor.object);
    return {name:a.shrine.object.name,keys:a.shrine.object.children.map(n=>n.name),
        refs:a.native.nativeCacheStats().refs};
}"""

OUTLINE="""({background,dt})=>{
    const a=nav,root=a.prop.root;a.prop.update(dt);
    const visible=[];root.traverseVisible(n=>{if(n.isMesh&&/^obj_/.test(n.name)&&n.material.opacity>.08)visible.push(n);});
    visible.sort((x,y)=>y.material.opacity-x.material.opacity);
    const mesh=visible[0];if(!mesh)throw Error('没有可测量的原作动画帧');
    const states=[];a.stage.scene.traverse(n=>{if(n.isMesh)states.push([n,n.visible]);});
    states.forEach(([n])=>n.visible=n===mesh);
    const oldBackground=a.stage.scene.background;a.stage.scene.background=new a.T.Color(background);
    a.renderer.render(a.stage.scene,a.camera);
    const gl=a.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
    const data=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,data);
    const position=mesh.geometry.attributes.position,v=new a.T.Vector3();
    let x0=w,y0=h,x1=0,y1=0;
    for(let i=0;i<position.count;i++){
        v.fromBufferAttribute(position,i).applyMatrix4(mesh.matrixWorld).project(a.camera);
        const x=(v.x+1)*w/2,y=(v.y+1)*h/2;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
    }
    x0=Math.ceil(x0)+1;y0=Math.ceil(y0)+1;x1=Math.floor(x1)-1;y1=Math.floor(y1)-1;
    if(x0<0||y0<0||x1>=w||y1>=h)throw Error('轮廓样本被画面裁切');
    let painted=0,total=0;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const i=(y*w+x)*4;total++;
        if(Math.abs(data[i]-data[0])+Math.abs(data[i+1]-data[1])+Math.abs(data[i+2]-data[2])>9)painted++;
    }
    states.forEach(([n,visible])=>n.visible=visible);a.stage.scene.background=oldBackground;
    return {mesh:mesh.name,background,painted,total,coverage:painted/total};
}"""

def main():
    OUT.mkdir(parents=True,exist_ok=True);report={'props':[],'outlines':[],'errors':[]}
    evidence=json.loads((ROOT/'docs/data/original-room-prop-data.json').read_text(encoding='utf8'))
    index=json.loads((ROOT/'site/asset/rl/native/index.json').read_text(encoding='utf8'))
    for entry in evidence['entries']:
        asset=index['furniture'][entry['key']]
        check('原作身份与落盘哈希 '+entry['key'],entry['sha256']==hashlib.sha256((ROOT/'.codex-tmp/native-rl-bundles'/Path(entry['bundle']).name).read_bytes()).hexdigest()
            and asset['affiliation']['tableSha256']==evidence['source']['sha256'] and entry['accessId']==500000+entry['objectId'])
    with Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
                base='http://127.0.0.1:%d'%server.server_address[1]
                page=browser.new_page(viewport={'width':960,'height':640})
                page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.route('**/roomprops',lambda r:r.fulfill(content_type='text/html',body='<body style="margin:0"></body>'))
                page.goto(base+'/roomprops');page.add_script_tag(url=base+'/site/asset/gacha/cards.js');page.evaluate(SETUP)
                contact=Image.new('RGB',(1600,238),'#eee5d5');draw=ImageDraw.Draw(contact)
                for i,entry in enumerate(evidence['entries']):
                    row=page.evaluate(PROP,entry['key']);report['props'].append(row)
                    check('原作物件真实像素与接地 '+entry['key'],row['pixels']>1000 and -.001<=row['ground']<.03 and row['refs']==1,row)
                    if row['hasTimeline']:check('原作动画不是静态截图 '+entry['key'],row['animated'],row)
                    shot=OUT/(entry['key']+'.png');page.locator('canvas').screenshot(path=str(shot))
                    with Image.open(shot) as im:contact.paste(im.resize((320,213)),(i*320,25))
                    draw.text((i*320+5,5),entry['key'],fill='#333333')
                    if entry['key'] in ('goods_1041','goods_1044'):
                        for color in ('#172437','#f0e8d8'):
                            for frame,dt in enumerate((.11,.17,.29)):
                                outline=page.evaluate(OUTLINE,{'background':color,'dt':dt});report['outlines'].append({'key':entry['key'],**outline})
                                check('火焰/烟雾真实轮廓不是不透明矩形 '+entry['key']+' '+color+' '+str(frame),
                                      outline['painted']>20 and outline['total']>100 and .015<outline['coverage']<.8,outline)
                                page.locator('canvas').screenshot(path=str(OUT/(entry['key']+'-outline-'+color[1:]+'-'+str(frame)+'.png')))
                contact.save(OUT/'contact.png')
                report['shrine']=page.evaluate(SHRINE)
                check('祭坛使用四件原作物件而不是星形绿块',report['shrine']['name']=='native-shrine'
                    and sorted(report['shrine']['keys'])==['room-prop:goods_1072','room-prop:goods_1072','room-prop:goods_1083','room-prop:goods_1147'],report['shrine'])
                page.locator('canvas').screenshot(path=str(OUT/'shrine.png'))
                check('消费只隐藏书册且释放不泄漏',page.evaluate("""()=>{
                    const a=nav;a.shrine.altar.used=true;a.shrine.update(0);
                    const children=a.shrine.object.children,ok=children.filter(n=>n.visible).length===3;
                    a.shrine.dispose();a.shrine.dispose();a.map.dispose();return ok&&a.native.nativeCacheStats().refs===0;
                }"""))
                page.close()
                page=browser.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.route('**/prop-failure',lambda r:r.fulfill(content_type='text/html',body='<body></body>'))
                page.route('**/goods_1072.glb.gz',lambda r:r.fulfill(status=503,body='injected'))
                page.goto(base+'/prop-failure')
                check('组合部分失败释放其他已成功物件',page.evaluate("""async()=>{
                    const {THREE}=await (await import('/site/core/loader.js')).loadModules();
                    const props=await import('/site/game/rl/view/roomprops.js'),native=await import('/site/game/rl/view/nativeassets.js');
                    try{await props.createPropArrangement(THREE,[{key:'goods_1147'},{key:'goods_1072'}]);return false;}
                    catch(e){return native.nativeCacheStats().refs===0;}
                }"""))
                check('无未捕获页面异常',not report['errors'],report['errors']);browser.close()
        finally:
            server.shutdown();worker.join(timeout=5)
            (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')

if __name__=='__main__':main()
