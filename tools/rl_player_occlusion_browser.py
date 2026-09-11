"""Player self-depth, world occlusion, translated poses and roster head anchors.
Real WebGL pixels are compared against an unobstructed reference of each pose.
"""
import argparse
import functools
import hashlib
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "experience-resume"

SETUP = r"""async () => {
    const loader = await import('/site/core/loader.js');
    const actors = await import('/site/core/actor.js');
    const cards = await import('/site/core/cards.js');
    const meta = await import('/site/game/rl/meta.js');
    const {PLAYABLE_IDS, PLAYABLE_ROSTER} = await import('/site/game/rl/rosterids.js');
    const {createStageScene} = await import('/site/game/rl/view/scene.js');
    const {attachPlayerView} = await import('/site/game/rl/view/actorview.js');
    const {setCharacterPitch} = await import('/site/game/rl/view/tilt.js');
    const {createStateMachine, PLAYER_STATES} = await import('/site/game/rl/actorstate.js');
    const {THREE} = await loader.loadModules();
    const renderer = new THREE.WebGLRenderer({antialias:false, alpha:true, preserveDrawingBuffer:true});
    renderer.setClearColor(0,0);
    renderer.setSize(420,420); renderer.setPixelRatio(1);
    renderer.domElement.id = 'occlusion-audit';
    renderer.domElement.style.cssText = 'position:fixed;left:0;top:0;z-index:999999';
    document.body.appendChild(renderer.domElement);
    const stage = createStageScene(THREE, renderer), scene = stage.scene;
    scene.background = new THREE.Color('#152536');
    const camera = new THREE.OrthographicCamera(-1.5,1.5,2.3,-.7,.1,100);
    camera.position.set(0,0,12); camera.lookAt(0,0,0);
    const blocker = new THREE.Mesh(new THREE.BoxGeometry(6,.92,.15),
        new THREE.MeshBasicMaterial({color:'#b43279'}));
    blocker.position.set(0,.35,3);scene.add(blocker);blocker.visible=false;
    const bytes = new Uint8Array(420*420*4);
    function render(root, composited) {
        if(composited)stage.render(camera,root);else renderer.render(scene,camera);
        renderer.getContext().readPixels(0,0,420,420,renderer.getContext().RGBA,
            renderer.getContext().UNSIGNED_BYTE,bytes);
        return bytes.slice();
    }
    function pixel(data,x,y){return [...data.slice((y*420+x)*4,(y*420+x)*4+3)];}
    window.occlusion={THREE,actors,cards,meta,renderer,stage,scene,camera,blocker,render,pixel,
        attachPlayerView,setCharacterPitch,createStateMachine,PLAYER_STATES,roster:PLAYABLE_ROSTER};
    // Persisted IDs include legacy archive identities without a current card.
    // The rendered-roster gate must cover exactly the actual selectable cards.
    return [...PLAYABLE_IDS];
}"""

SYNTHETIC = r"""composited => {
    const a=occlusion,T=a.THREE;
    const root=new T.Group();a.scene.add(root);
    const front=new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({color:'#25f052'}));
    front.position.set(0,.8,.2);front.renderOrder=1;root.add(front);
    const back=new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({color:'#f02525'}));
    back.position.set(0,.8,0);back.renderOrder=2;root.add(back);
    a.blocker.visible=true;
    const isolated=a.pixel(a.render(root,composited),210,182);
    const outside=a.pixel(a.render(root,composited),100,182);
    const overlay=new T.Mesh(new T.PlaneGeometry(.2,.2),new T.MeshBasicMaterial({color:'#fff025'}));
    overlay.position.set(0,.6,-1);overlay.userData.rlOverlay=true;a.scene.add(overlay);
    const over=a.pixel(a.render(root,composited),210,182);
    root.removeFromParent();overlay.removeFromParent();a.blocker.visible=false;
    [front,back,overlay].forEach(n=>{n.geometry.dispose();n.material.dispose();});
    return {isolated,outside,over,restored:root.visible&&overlay.visible&&a.renderer.autoClear
        &&a.scene.background.getHexString()==='152536'};
}"""

ACTOR = r"""async ({id,composited,shot}) => {
    const a=occlusion,T=a.THREE,row=a.roster.find(c=>c.id===id);
    const c=a.cards.all().find(c=>c.id===id||c.evolvedId===id);
    if(!row||!c)throw Error('Missing current selectable card '+id);
    const actor=await a.actors.create({resourceId:row.resourceId,classId:row.class,
        headId:a.cards.headId(c,id===c.evolvedId),weapon:'default',skillId:row.resourceId});
    const unit={x:0,y:0,radius:.28,facing:Math.PI,card:c,sm:a.createStateMachine('idle',a.PLAYER_STATES),
        skills:{slots:[]},swingId:0};
    a.setCharacterPitch(0);
    const view=a.attachPlayerView(unit,actor,a.scene);view.sync(0);await Promise.resolve();
    const root=actor.object;
    const b=new T.Vector3(),h=new T.Vector3(),rows=[],anchorCandidates=[];
    root.traverse(node=>{const name=node.userData.name||node.name;
        if(name!=='Head'&&name!=='Head_root')return;
        const usedBy=[];root.traverse(mesh=>{if(!mesh.isSkinnedMesh)return;
            // A rig root can drive skinning through its children without being
            // a directly indexed bone (for example resource 150004 Head_root).
            const drives=mesh.skeleton.bones.some(bone=>{
                for(let parent=bone;parent;parent=parent.parent)if(parent===node)return true;
                return false;
            });
            if(drives)usedBy.push({name:mesh.name,visible:mesh.visible,direct:mesh.skeleton.bones.includes(node)});
        });
        anchorCandidates.push({name:node.name,semantic:name,uuid:node.uuid,parent:node.parent?.name,
            parentSemantic:node.parent?.userData.name||node.parent?.name,usedBy});
    });
    // GLBs can retain an unskinned duplicate rig. Measure the anchors that
    // actually deform the body/head, never whichever matching name is last.
    const bodies=anchorCandidates.filter(n=>n.semantic==='Head'&&n.parentSemantic==='Neck'&&n.usedBy.length);
    const heads=anchorCandidates.filter(n=>n.semantic==='Head_root'&&n.usedBy.length);
    if(bodies.length!==1||heads.length!==1)throw Error('Ambiguous skinned anchors: '+JSON.stringify(anchorCandidates));
    const bodyHead=root.getObjectByProperty('uuid',bodies[0].uuid),headRoot=root.getObjectByProperty('uuid',heads[0].uuid);
    const measuredAnchors={body:bodies[0].uuid,head:heads[0].uuid};
    let maxGap=0,nonFinite=0,worstGap=null;
    for(const name of ['idle','battle_run','attack','class_skill_1','class_skill_2','class_skill_3','damage','kirarajump_0']) {
        if(!actor.play(name,{fade:0,loop:false}))continue;
        const action=actor.mixer._actions.find(x=>x.getClip().name===name);
        for(let i=0;i<=60;i++) {
            actor.seek(action.getClip().duration*i/60);root.updateMatrixWorld(true);
            const gap=bodyHead.getWorldPosition(b).distanceTo(headRoot.getWorldPosition(h));
            if(!Number.isFinite(gap))nonFinite++;
            if(gap/2>maxGap){maxGap=gap/2;worstGap={name,fraction:i/60,
                body:bodyHead.getWorldPosition(b).toArray(),head:headRoot.getWorldPosition(h).toArray(),
                bodyParent:bodyHead.parent?.name,headParent:headRoot.parent?.name};}
        }
    }
    for(const [name,fraction] of [['idle',.3],['battle_run',.3],['battle_run',.7],['attack',.55],['class_skill_1',.45],['class_skill_1',.8]]) {
        for(const mirrored of [false,true]) {
            unit.facing=mirrored?0:Math.PI;view.sync(0);
            actor.play(name,{fade:0,loop:false});
            const action=actor.mixer._actions.find(x=>x.getClip().name===name);
            actor.seek(action.getClip().duration*fraction);
            const background=a.scene.background;a.scene.background=null;
            a.blocker.visible=false;const reference=a.render(root,composited);
            a.scene.background=background;
            a.blocker.visible=true;const blocked=a.render(root,composited);
            let silhouette=0,occluded=0;
            for(let i=0;i<reference.length;i+=4) {
                // A translucent edge SHOULD blend with different backgrounds.
                // Gate opaque character pixels, not that correct compositing.
                if(reference[i+3]<254)continue;
                silhouette++;
                if(Math.max(...[0,1,2].map(c=>Math.abs(reference[i+c]-blocked[i+c])))>15)occluded++;
            }
            rows.push({name,fraction,mirrored,silhouette,occluded});
        }
    }
    a.blocker.visible=false;
    const original=root.position.clone(),camera=a.camera.position.clone(),first=a.render(root,composited);
    let translationDiff=0;
    for(const [x,z]of [[24,18],[-15,30],[80,80]]) {
        root.position.copy(original).add(new T.Vector3(x,0,z));
        a.camera.position.copy(camera).add(new T.Vector3(x,0,z));
        const moved=a.render(root,composited);
        let diff=0;for(let i=0;i<moved.length;i++)if(Math.abs(moved[i]-first[i])>15)diff++;
        translationDiff=Math.max(translationDiff,diff);
    }
    root.position.copy(original);a.camera.position.copy(camera);
    let screenshot=null;
    if(shot){a.blocker.visible=true;a.render(root,composited);screenshot=a.renderer.domElement.toDataURL('image/png');}
    const materials=[];root.traverse(n=>{if(n.isMesh)(Array.isArray(n.material)?n.material:[n.material]).forEach(m=>materials.push(m));});
    const depthPreserved=materials.every(m=>m.depthTest);
    const result={id,rid:row.resourceId,name:c.nameZh||c.name,maxGap,worstGap,anchorCandidates,measuredAnchors,nonFinite,translationDiff,depthPreserved,rows,screenshot};
    a.blocker.visible=false;view.dispose();actor.dispose();return result;
}"""


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--baseline',action='store_true')
    parser.add_argument('--limit',type=int)
    parser.add_argument('--card',type=int)
    args=parser.parse_args()
    label='occlusion-before' if args.baseline else 'occlusion-after'
    OUT.mkdir(parents=True,exist_ok=True)
    sources=['site/game/rl/view/stagerender.js','site/game/rl/view/scene.js','site/game/rl/view/actorview.js',
        'site/game/rl/view/modelrules.js','site/game/rl/rosterids.js','site/core/actor.js','site/core/model-render-order.js','site/asset/gacha/cards.js']
    fingerprints=lambda:{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in sources}
    report={'complete':False,'checks':[],'actors':[],'errors':[],'baseline':args.baseline,'source_before':fingerprints()}
    def check(name,ok,detail=None):
        report['checks'].append({'name':name,'ok':bool(ok),'detail':detail})
        print(('PASS ' if ok else 'FAIL ')+name,flush=True)
    with Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
                page=browser.new_page(viewport={'width':1000,'height':700})
                page.on('pageerror',lambda e:report['errors'].append(str(e)))
                page.add_init_script('window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};')
                page.goto('http://127.0.0.1:%d/site/game/roguelike.html'%server.server_address[1],timeout=60000)
                page.wait_for_function('!!window.kirafanRL && !!window.kirafanGachaData',polling=50,timeout=60000)
                roster=page.evaluate(SETUP)
                if args.card is not None:
                    if args.card not in roster:raise ValueError('Card is not currently selectable')
                    roster=[args.card]
                report['roster']=roster
                proof=page.evaluate(SYNTHETIC,not args.baseline);report['synthetic']=proof
                check('玩家不受世界深度切割，仍保留内部前后遮挡',proof['isolated'][1]>200 and proof['isolated'][0]<90,proof)
                check('世界遮挡物仍正常绘制',proof['outside'][0]>100 and proof['outside'][2]>60,proof)
                check('危险与技能特效绘制在玩家前方',proof['over'][0]>200 and proof['over'][1]>200,proof)
                check('渲染后恢复场景与渲染器状态',proof['restored'])
                for i,id in enumerate(roster[:args.limit]):
                    row=page.evaluate(ACTOR,{'id':id,'composited':not args.baseline,'shot':i in (0,2,7,19,27,37)})
                    png=row.pop('screenshot',None)
                    if png:
                        import base64
                        (OUT/(label+'-'+str(row['rid'])+'.png')).write_bytes(base64.b64decode(png.split(',')[1]))
                    report['actors'].append(row)
                    check(str(row['rid'])+' 12姿态地面/身体遮挡像素',all(x['silhouette']>500 and x['occluded']<8 for x in row['rows']),row['rows'])
                    check(str(row['rid'])+' 8动作头身轨迹与世界平移',row['maxGap']<.035 and row['nonFinite']==0 and row['translationDiff']<30,row['maxGap'])
                    check(str(row['rid'])+' 保留角色自身深度检测',row['depthPreserved'])
                check('没有未捕获页面错误',not report['errors'],report['errors'])
                report['complete']=True
                browser.close()
        except Exception as error:
            report['failure']=repr(error)
            raise
        finally:
            server.shutdown();thread.join(timeout=5)
            report['source_after']=fingerprints()
            report['changed_during_run']=[name for name in sources if report['source_before'][name]!=report['source_after'][name]]
            report['status']='PASS' if report['complete'] and not report['errors'] and not report['changed_during_run'] and all(x['ok'] for x in report['checks']) else 'FAIL'
            (OUT/(label+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    return int(report['status']!='PASS' and not args.baseline)


if __name__=='__main__':raise SystemExit(main())
