"""Native asset/actor visual audit. Uses real loader, actor, Meige and GPU render."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "experience-rework"

SETUP = r"""async () => {
    const loader = await import('/site/core/loader.js');
    const actorModule = await import('/site/core/actor.js');
    const cards = await import('/site/core/cards.js');
    const {attachPlayerView} = await import('/site/game/rl/view/actorview.js');
    const {createStateMachine,PLAYER_STATES} = await import('/site/game/rl/actorstate.js');
    const {setCharacterPitch} = await import('/site/game/rl/view/tilt.js');
    const native = await import('/site/game/rl/view/nativeassets.js');
    const {createSkillVFX} = await import('/site/game/rl/view/skillvfx.js');
    const {decodeSkill} = await import('/site/game/rl/skills.js');
    const table = await fetch('/site/asset/rl/skills-rl.json').then(r=>r.json());
    const index = await native.loadNativeIndex();
    const {THREE} = await loader.loadModules();
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#dce7ec');
    const camera = new THREE.OrthographicCamera(-7.5,7.5,3.8,-1.4,.1,100);
    camera.position.set(0,0,10); camera.lookAt(0,0,0);
    const renderer = new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(1440,500); renderer.setPixelRatio(1); renderer.setClearColor('#dce7ec');
    renderer.domElement.style.cssText='position:fixed;left:0;top:0;z-index:999999;';
    renderer.domElement.id='native-audit'; document.body.appendChild(renderer.domElement);
    setCharacterPitch(0);
    const samples=[];
    for(let c=0;c<5;c++) {
        const card=cards.all().find(x=>x.class===c && x.rarity>=4);
        const actor=await actorModule.create({resourceId:card.resourceId,classId:c,
            headId:cards.headId(card,false),weapon:'default',skillId:card.resourceId});
        const donor=await loader.loadClassActions(c,cards.headId(card,false));
        const mounts=[];
        actor.object.traverse(n=>{const name=n.userData.name||n.name;
            if(/^(Loc_[LR]|Weapon_[LR]|(Hand|Arm)_[LR]_assist|Arm_accessories_[LR]\d+)$/.test(name)) {
                let d;donor.sourceRoot.traverse(x=>{if((x.userData.name||x.name)===name)d=x;});
                mounts.push({name,target:n.position.toArray(),donor:d&&d.position.toArray()});
            }
        });
        loader.disposeObject(donor.sourceRoot);
        const keys=Object.keys(table.player).filter(id=>(index.skills[id]||'').startsWith(['Fighter','Magician','Priest','Knight','Alchemist'][c]+'_cls'));
        const slots=[null, ...keys.slice(0,2).map(id=>decodeSkill(table.player[id],Number(id),.35))];
        const unit={x:(c-2)*2.8,y:0,radius:.28,facing:Math.PI,card:{class:c},element:c,
            sm:createStateMachine('idle',PLAYER_STATES),skills:{normal:{id:c+1},slots},swingId:0};
        const view=attachPlayerView(unit,actor,scene);view.sync(0);actor.update(0);
        samples.push({card,actor,view,unit,mounts});
    }
    const effects=createSkillVFX(scene,THREE,{camera});
    await Promise.all(samples.map(s=>effects.prepare(s.unit)));
    function render(){renderer.render(scene,camera);}
    function bounds(root){
        root.updateMatrixWorld(true);const box=new THREE.Box3(),v=new THREE.Vector3();
        root.traverse(n=>{if(!n.isMesh||!n.geometry)return;
            for(let p=n;p;p=p.parent)if(!p.visible)return;
            const a=n.geometry.attributes.position;if(!a)return;
            for(let i=0;i<a.count;i++){n.getVertexPosition(i,v);v.applyMatrix4(n.matrixWorld);box.expandByPoint(v);}
        });return {min:box.min.toArray(),max:box.max.toArray(),size:box.getSize(v).toArray()};
    }
    window.audit={THREE,scene,camera,renderer,samples,effects,render,bounds,native};
    render();return samples.map(s=>({rid:s.card.resourceId,classId:s.card.class,mounts:s.mounts,actions:s.actor.actionNames}));
}"""


def main():
    p=argparse.ArgumentParser();p.add_argument('--url',default='http://127.0.0.1:62857');p.add_argument('--label',default='native-before');cfg=p.parse_args()
    OUT.mkdir(parents=True,exist_ok=True);report={};shots=[]
    with sync_playwright() as pw:
        browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
        page=browser.new_page(viewport={'width':1440,'height':900});errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.add_init_script('window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};')
        page.goto(cfg.url+'/site/game/roguelike.html',wait_until='load',timeout=60000)
        page.wait_for_function('!!window.kirafanRL && !!window.kirafanGachaData',polling=50,timeout=60000)
        report['actors']=page.evaluate(SETUP)
        report['poses']=[]
        for name,frac in [('idle',.3),('battle_run',.3),('battle_run',.7),('class_skill_1',.3),('class_skill_1',.65),('class_skill_3',.4)]:
            row=page.evaluate(r"""({name,frac})=>{
                const a=window.audit;
                const poses=a.samples.map(s=>{
                    s.actor.play(name,{loop:false,fade:0});
                    const action=s.actor.mixer._actions.find(x=>x.getClip().name===name);
                    s.actor.seek(action.getClip().duration*frac);
                    return {rid:s.card.resourceId,bounds:a.bounds(s.actor.object),running:s.actor.mixer._actions.filter(x=>x.getEffectiveWeight()>1e-3&&x.enabled).length};
                });a.render();return {name,frac,poses};
            }""",{'name':name,'frac':frac})
            report['poses'].append(row)
            path=OUT/(cfg.label+'-'+name+'-'+str(frac)+'.png')
            page.locator('#native-audit').screenshot(path=str(path));shots.append((path,name+' '+str(frac)))
        report['effects']=[]
        for kind in ('normal','skill1','skill2'):
            page.evaluate(r"""kind=>{
                const a=window.audit;a.effects.clear();
                a.samples.forEach(s=>{
                    s.actor.play('idle',{fade:0});s.actor.seek(.2);
                    if(kind==='normal')a.effects.emitSlash(s.unit);
                    else a.effects.emitSkillCast(s.unit,s.unit.skills.slots[kind==='skill1'?1:2]);
                });
            }""",kind)
            page.wait_for_function('window.audit.effects.stats.loaded === window.audit.effects.stats.active',polling=20,timeout=45000)
            for t in (0.06,0.12):
                row=page.evaluate('dt=>{const a=window.audit;a.effects.update(dt);a.render();return a.effects.stats;}',t)
                report['effects'].append({'kind':kind,'time':t,'stats':row})
                path=OUT/(cfg.label+'-fx-'+kind+'-'+str(t)+'.png');page.locator('#native-audit').screenshot(path=str(path));shots.append((path,'FX '+kind+' '+str(t)))
            page.evaluate('audit.effects.update(5)')
        report['cleanup']=page.evaluate('()=>{audit.effects.clear();return {effects:audit.effects.stats,cache:audit.native.nativeCacheStats()};}')
        report['errors']=errors
        browser.close()
    (OUT/(cfg.label+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    contact=Image.new('RGB',(1440, len(shots)*274),'#f3f5f6');d=ImageDraw.Draw(contact)
    for i,(path,label) in enumerate(shots):
        d.text((12,i*274+4),label,fill='#203345');im=Image.open(path);im.thumbnail((1440,250));contact.paste(im,(0,i*274+24))
    contact.save(OUT/(cfg.label+'-contact.png'))
    print(json.dumps({'actors':[{'rid':x['rid'],'classId':x['classId']} for x in report['actors']],'cleanup':report['cleanup'],'errors':errors},ensure_ascii=False),flush=True)
    return int(bool(errors) or bool(report['cleanup']['effects']['errors']))

if __name__=='__main__':raise SystemExit(main())

