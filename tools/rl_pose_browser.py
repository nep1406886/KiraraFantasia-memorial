"""Audit real five-star rigs through in-place actions and live cross-class switches.

No meshes or clips are stubbed. Owns a port-0 server and one browser at a time.
The body Head and the independently animated Head_root must remain coincident.
"""
import argparse
import base64
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp' / 'pose-audit'

SETUP = r"""async () => {
    const actors = await import('/site/core/actor.js');
    const cards = await import('/site/core/cards.js');
    const loader = await import('/site/core/loader.js');
    const {THREE:T} = await loader.loadModules();
    const {PLAYABLE_ROSTER:roster} = await import('/site/game/rl/rosterids.js');
    const renderer = new T.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});
    renderer.setSize(480,480); renderer.setPixelRatio(1);
    const scene = new T.Scene(); scene.background = new T.Color('#23394b');
    scene.add(new T.AmbientLight(0xffffff,2));
    const camera = new T.OrthographicCamera(-1.4,1.4,2.35,-.45,.1,100);
    camera.position.set(0,0,10);camera.lookAt(0,0,0);
    window.audit={actors,cards,loader,T,roster,renderer,scene,camera};
    return roster.map(r=>r.id);
}"""

ACTOR = r"""async ({id,crossClass}) => {
    const a=audit,{T}=a,row=a.roster.find(r=>r.id===id);
    const card=a.cards.all().find(c=>c.id===id||c.evolvedId===id);
    if(!card)throw new Error('missing card '+id);
    const headId=a.cards.headId(card,id===card.evolvedId);
    const actor=await a.actors.create({resourceId:row.resourceId,classId:row.class,
        headId,skillId:row.resourceId,weapon:'default'});
    const root=actor.object;root.scale.setScalar(2);a.scene.add(root);
    const semantic=n=>n.userData.name||n.name;
    const used=new Set();root.traverse(n=>{if(n.isSkinnedMesh)n.skeleton.bones.forEach(b=>used.add(b));});
    const nodes=[];root.traverse(n=>nodes.push(n));
    const candidates=nodes.filter(n=>semantic(n)==='Head'&&semantic(n.parent)==='Neck');
    const body=candidates.find(n=>used.has(n))||candidates[0];
    const heads=nodes.filter(n=>semantic(n)==='Head_root');
    const head=heads.find(n=>used.has(n))||heads[0];
    if(!body||!head)throw new Error('missing head anchors '+id);
    const bodyRoot=nodes.find(n=>semantic(n)==='root'&&used.has(n))||nodes.find(n=>semantic(n)==='root');
    const b=new T.Vector3(),h=new T.Vector3(),results=[];let worst={gap:0},screenshot=null,from=null;
    function sample(name,phase,time){
        root.updateMatrixWorld(true);body.getWorldPosition(b);head.getWorldPosition(h);
        const gap=b.distanceTo(h)/2;
        if(!Number.isFinite(gap))throw new Error('non-finite pose '+id);
        if(gap>worst.gap){
            worst={gap,name,from,phase,time,body:[...b],head:[...h],root:[...bodyRoot.position],
                actions:actor.mixer._actions.filter(a=>a.isScheduled()).map(a=>({name:a.getClip().name,
                    time:a.time,weight:a.getEffectiveWeight(),paused:a.paused}))};
            if(gap>.035){a.renderer.render(a.scene,a.camera);screenshot=a.renderer.domElement.toDataURL('image/png');}
        }
        return gap;
    }
    async function check(name){
        if(!actor.play(name,{fade:0,loop:false}))throw new Error('missing action '+name);
        const action=actor.mixer._actions.find(x=>x.getClip().name===name),duration=action.getClip().duration;
        let max=0;
        for(let i=0;i<=48;i++){actor.seek(duration*i/48);max=Math.max(max,sample(name,'seek',duration*i/48));}
        results.push({name,max});
    }
    try{
        for(const name of ['idle','battle_run','attack','class_skill_1','class_skill_2','class_skill_3','damage','kirarajump_0'])
            if(actor.actionNames.includes(name))await check(name);
        // Async action registration happens while the current actor is posed, not at bind.
        if(crossClass)for(let cls=0;cls<5;cls++){
            actor.play('battle_run',{fade:0});actor.update(.37);
            const names=await actor.loadWeaponActions(cls);
            await check(names.idle);await check(names.attack);
            for(const name of [names.idle,names.attack,'damage','battle_run','class_skill_1',names.attack]){
                from=actor.action;actor.play(name,{fade:.055,loop:false});
                for(let i=0;i<28;i++){actor.update(1/120);sample(name,'transition',i/120);}
            }
        }
        const bindings=new Map();
        for(const action of actor.mixer._actions)for(const track of action.getClip().tracks){
            const dot=track.name.lastIndexOf("."),node=T.PropertyBinding.findNode(root,track.name.slice(0,dot));
            if(!node)throw new Error("unbound track "+track.name);
            const key=node.uuid+track.name.slice(dot);
            if(!bindings.has(key))bindings.set(key,new Set());
            bindings.get(key).add(track.name);
        }
        const bindingAliases=[...bindings.values()].filter(keys=>keys.size>1).map(keys=>[...keys]);
        return {id,rid:row.resourceId,classId:row.class,headId,worst,results,screenshot,bindingAliases,
            anchorCounts:{body:candidates.length,head:heads.length}};
    }finally{actor.dispose();}
}"""


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--baseline',action='store_true')
    parser.add_argument('--cross-class',action='store_true')
    parser.add_argument('ids',nargs='*',type=int)
    args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    label='before' if args.baseline else 'after'
    report={'actors':[],'errors':[],'baseline':args.baseline,'crossClass':args.cross_class}
    with Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
                page=browser.new_page()
                page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.route('**/pose-audit.html',lambda route:route.fulfill(content_type='text/html',body='<html><body></body></html>'))
                page.goto('http://127.0.0.1:%d/pose-audit.html'%server.server_address[1])
                page.add_script_tag(url='/site/asset/gacha/cards.js')
                ids=page.evaluate(SETUP)
                for id in args.ids or ids:
                    row=page.evaluate(ACTOR,{'id':id,'crossClass':args.cross_class})
                    png=row.pop('screenshot',None)
                    if png:(OUT/f'{label}-{id}.png').write_bytes(base64.b64decode(png.split(',')[1]))
                    report['actors'].append(row)
                    worst=row['worst'];ok=worst['gap']<.035 and not row['bindingAliases']
                    print(('PASS' if ok else 'FAIL')+' '+str(id)+' aliases='+str(len(row['bindingAliases']))+' '+json.dumps(worst,ensure_ascii=False),flush=True)
                browser.close()
        finally:
            server.shutdown();thread.join(timeout=5)
            (OUT/(label+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    failed=bool(report['errors']) or any(r['worst']['gap']>=.035 or r['bindingAliases'] for r in report['actors'])
    return int(failed and not args.baseline)


if __name__=='__main__':raise SystemExit(main())
