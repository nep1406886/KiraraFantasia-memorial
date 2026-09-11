"""Mixed-size candidate ownership and real gameplay room entry, without mocks."""
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_navigation_browser import SETUP
from rl_result_browser import start, dismiss_dialogue, check

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp' / 'feedback-20260910' / 'roomsize'

MIXED = """async()=>{
    const a=nav,map=a.maps.createMapView(a.stage.scene,1);
    await map.preloadVolume(1,1,{strict:true});
    const types=['battle','chest','rest','boss','shop','start'];
    const candidates=await Promise.all(types.map((type,id)=>
        map.prepareRoom({type,id,seed:74061},undefined,['N','E','S','W'],{strict:true})));
    const checks=[];
    for(let i=0;i<candidates.length;i++){
        const c=candidates[i],s=a.roomSize(types[i]),surface=c.group.getObjectByName('room-surface');
        checks.push({name:'并发候选独立尺寸 '+types[i],ok:c.size===s&&c.layout.size===s
            &&surface.geometry.parameters.width===s.w&&surface.geometry.parameters.height===s.h
            &&surface.material.map.image.width===s.w*32&&surface.material.map.image.height===s.h*32
            &&surface.position.x===s.w/2&&surface.position.z===s.h/2});
    }
    map.activateRoom(candidates[0]);const active=map.group;
    candidates[1].dispose();
    checks.push({name:'丢弃小房候选不触及已激活大房',ok:map.group===active
        &&!candidates[0].disposed&&candidates[1].disposed});
    map.activateRoom(candidates[2]);
    checks.push({name:'大房提交小房后释放旧尺寸',ok:candidates[0].disposed
        &&map.group===candidates[2].group&&map.group.getObjectByName('room-surface').geometry.parameters.width===20});
    map.dispose();checks.push({name:'全部候选销毁后无原作实例泄漏',ok:a.native.nativeCacheStats().refs===0
        &&candidates.every(c=>c.disposed)});return checks;
}"""

SNAPSHOT = """()=>{
    const k=kirafanRL,w=k.world,p=w.player,room=w.dungeon.rooms.find(r=>r.id===w.roomId);
    const surface=k.mapview.group.getObjectByName('room-surface');
    const floor=document.querySelector('.minimap-floor'),local=document.querySelector('.minimap-local');
    return {type:room.type,roomId:w.roomId,width:w.width,height:w.height,player:[p.x,p.y],
        plane:[surface.geometry.parameters.width,surface.geometry.parameters.height],
        center:[surface.position.x,surface.position.z],pixels:[surface.material.map.image.width,surface.material.map.image.height],
        minimap:[+floor.getAttribute('width'),+floor.getAttribute('height')],viewBox:local.getAttribute('viewBox'),
        doors:w.roomDoors.map(d=>({side:d.side,at:d.at})),
        markers:[...document.querySelectorAll('.minimap-door')].map(n=>n.getAttribute('transform'))};
}"""

def main():
    OUT.mkdir(parents=True,exist_ok=True);report={'candidates':[], 'entries':[], 'errors':[]}
    with Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
                base='http://127.0.0.1:%d'%server.server_address[1]
                page=browser.new_page(viewport={'width':1280,'height':840})
                page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.route('**/mixed-size',lambda r:r.fulfill(content_type='text/html',body='<body></body>'))
                page.goto(base+'/mixed-size');page.add_script_tag(url=base+'/site/asset/gacha/cards.js');page.evaluate(SETUP)
                report['candidates']=page.evaluate(MIXED)
                for row in report['candidates']:check(row['name'],row['ok'])
                start(page,base+'/site/game/roguelike.html?seed=74061')
                rooms=page.evaluate('kirafanRL.world.dungeon.rooms.map(r=>({id:r.id,type:r.type}))')
                sampled=set()
                for room in rooms:
                    if room['type'] in sampled:continue
                    sampled.add(room['type'])
                    for side in ['N','E','S','W']:
                        page.evaluate("arg=>{kirafanRL.world.enterRoom(arg.id,arg.side);kirafanRL.step(0);}",{'id':room['id'],'side':side})
                        dismiss_dialogue(page)
                        page.wait_for_function("id=>kirafanRL.mapview.group?.name==='room:'+id&&!kirafanRL.world.frozen",arg=room['id'],timeout=40000)
                        page.evaluate('kirafanRL.step(0)')
                        row=page.evaluate(SNAPSHOT);row['entrySide']=side;report['entries'].append(row)
                        size=[32,24] if room['type'] in ('battle','boss') else [16,12] if room['type']=='chest' else [20,16]
                        w,h=size
                        expected={'N':[w/2,1.2],'E':[w-1.2,h/2],'S':[w/2,h-1.2],'W':[1.2,h/2]}[side]
                        check(room['type']+' '+side+' 世界/地面/纹理/小地图/入场一致',
                            [row['width'],row['height']]==size and row['plane']==size and row['minimap']==size
                            and row['center']==[w/2,h/2] and row['pixels']==[w*32,h*32]
                            and all(abs(x-y)<.02 for x,y in zip(row['player'],expected)),row)
                    page.screenshot(path=str(OUT/(room['type']+'.png')))
                check('真实种子覆盖全部六房型',sampled=={'start','battle','shop','rest','chest','boss'},sampled)
                check('没有页面异常',not report['errors'],report['errors']);browser.close()
        finally:
            server.shutdown();worker.join(timeout=5)
            (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')

if __name__=='__main__':main()
