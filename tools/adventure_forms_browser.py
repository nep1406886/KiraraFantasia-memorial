"""Paired original costumes, exact battle identity and GPU contact coverage."""
import json
import functools
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from rl_projectile_visual_browser import SETUP
from rl_hit_alignment_browser import Server, NoCacheHandler

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/forms-review'

PIXELS = r"""async () => {
    const a=audit,T=a.T,{weaponProfile,inWeaponReach}=await import('/site/game/rl/weaponprofile.js');
    const rows=[],target=new T.WebGLRenderTarget(800,600),old=a.renderer.getRenderTarget();
    a.scene.background=new T.Color('#262233');a.cameraAt(9);
    a.camera.left=-6;a.camera.right=6;a.camera.top=4.5;a.camera.bottom=-4.5;a.camera.updateProjectionMatrix();
    const read=()=>{a.scene.updateMatrixWorld(true);a.renderer.render(a.scene,a.camera);
        const pixels=new Uint8Array(800*600*4);a.renderer.readRenderTargetPixels(target,0,0,800,600,pixels);return pixels;};
    const at=(pixels,x,y)=>{const p=new T.Vector3(x,1,y).project(a.camera),sx=Math.round((p.x+1)*400),sy=Math.round((p.y+1)*300);
        let max=0;for(let yy=sy-2;yy<=sy+2;yy++)for(let xx=sx-2;xx<=sx+2;xx++){
            if(xx<0||xx>=800||yy<0||yy>=600)continue;const i=(yy*800+xx)*4;
            max=Math.max(max,pixels[i]+pixels[i+1]+pixels[i+2]);}return max;};
    a.renderer.setRenderTarget(target);
    try{
        for(const cls of [0,3])for(const [range,width] of [[1,1],[1.45,1.3]])for(let dir=0;dir<8;dir++){
            const profile=weaponProfile({class:cls});profile.range*=range;
            if(profile.arc)profile.arc*=width;if(profile.width)profile.width*=width;
            a.fx.clear();Object.assign(a.unit,{x:.35,y:-.2,swingId:dir+1,facing:dir*Math.PI/4,
                swingProfile:profile,weaponProfile:profile,sm:{state:'attack',stateTime:.18}});
            a.fx.emitSlash(a.unit);a.render(0);
            const blade=a.scene.getObjectByName('player-attack-reach');
            blade.visible=false;const quiet=read();blade.visible=true;const lit=read();
            const angle=a.unit.facing,d=profile.range*.88;
            const point={x:a.unit.x+Math.cos(angle)*d,y:a.unit.y+Math.sin(angle)*d,radius:.03};
            const outside={x:a.unit.x+Math.cos(angle)*(profile.range+.5),y:a.unit.y+Math.sin(angle)*(profile.range+.5),radius:.03};
            const gain=at(lit,point.x,point.y)-at(quiet,point.x,point.y);
            a.unit.x+=.4;a.unit.y+=.3;a.fx.update(0);const followed=blade.position.x===a.unit.x&&blade.position.z===a.unit.y;
            a.unit.x-=.4;a.unit.y-=.3;
            rows.push({cls,range,width,dir,gain,hit:inWeaponReach(a.unit,point,profile),
                outside:inWeaponReach(a.unit,outside,profile),followed});
        }
    }finally{a.renderer.setRenderTarget(old);target.dispose();a.fx.clear();}
    return rows;
}"""

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = 'http://127.0.0.1:'+str(server.server_address[1])
    report={'checks':[], 'errors':[], 'failed':[]}
    def check(name, ok, data=None):
        report['checks'].append({'name':name,'ok':bool(ok),'data':data})
        print(('PASS ' if ok else 'FAIL ')+name,flush=True)
        if not ok: raise AssertionError(name+': '+str(data))
    def watch(page):
        page.on('pageerror',lambda e:report['errors'].append(str(e)))
        page.on('console',lambda m:report['errors'].append(m.text) if m.type=='error' else None)
        page.on('response',lambda r:report['failed'].append(str(r.status)+' '+r.url) if r.status>=400 else None)
    def shot(page,name):
        page.evaluate('async()=>{await document.fonts.ready;await Promise.all([...document.images].filter(i=>{const r=i.getBoundingClientRect();return r.width&&r.height&&r.top<innerHeight&&r.bottom>0;}).map(i=>i.decode().catch(()=>{})));}')
        page.screenshot(path=str(OUT/(name+'.png')))
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(channel='msedge',args=['--enable-unsafe-swiftshader'])
            ctx=browser.new_context(viewport={'width':1440,'height':900})
            page=ctx.new_page();watch(page)
            page.goto(base+'/site/etowaria-defense/index.html?review=1')
            page.locator('#start-campaign:enabled').click(timeout=60000)
            page.locator('[data-action="prepare"]').click()
            counts=page.evaluate("""()=>{const c=__defense.campaign;return {
                all:c.catalogue.units.length,featured:[...document.querySelectorAll('.deck-card:not([hidden])')].filter(n=>n.dataset.card.startsWith('U')).length,
                before:JSON.stringify(c.deckChoice),id:c.unit('U01').cardId};}""")
            check('default roster contains 155 five-stars and two seasonal exceptions',counts['featured']==157,counts)
            page.locator('.deck-options summary').click()
            page.get_by_label('按卡牌星级筛选').select_option('all')
            check('legacy four-star collection remains available',page.locator('.deck-card:not([hidden])[data-card^="U"]').count()==167)
            page.get_by_label('按卡牌星级筛选').select_option('five')
            check('five-star filter is exact',page.locator('.deck-card:not([hidden])[data-card^="U"]').count()==155)
            page.locator('.deck-options-panel > button').click()
            page.evaluate("__defense.campaign.deckFocus='U01';__defense.campaign.showCardForms()")
            page.locator('.card-form-controls [data-form="evolved"]').click()
            check('locked evolution is a preview and cannot equip a new model',page.evaluate("__defense.campaign.unit('U01').appearance==='base'") and page.locator('[data-action="evolve-card"]').is_disabled())
            page.get_by_role('button',name='确认形态').click()
            # Reward fixture uses the real settlement reducer, not an evolved flag.
            page.evaluate("""async()=>{const c=__defense.campaign,{Battle}=await import('/site/etowaria-defense/sim/battle.js'),
                {LEVELS}=await import('/site/etowaria-defense/data/campaign.js');
                for(let n=0;n<3;n++){const b=new Battle(LEVELS[0],{deck:['U01']});b.phase='won';c.save.finish('form-reward-'+n,b);}
                c.showCardForms();}""")
            page.locator('[data-action="evolve-card"]').click()
            check('earned materials unlock permanent evolution through its real button',page.evaluate("__defense.campaign.save.evolutionQuote('U01').evolved&&__defense.campaign.save.evolutionQuote('U01').owned===0"))
            committed=page.evaluate('__defense.campaign.save.export()')
            page.locator('.evolution-result .evolution-skip').click()
            check('skipping evolution animation cannot spend or reward twice',page.evaluate('__defense.campaign.save.export()')==committed)
            for width,height in [(320,568),(390,844),(568,320),(1440,900)]:
                page.set_viewport_size({'width':width,'height':height})
                result=page.locator('.evolution-result')
                check('TD evolution result fits '+str(width)+'x'+str(height),result.evaluate('e=>e.scrollWidth<=e.clientWidth+1&&e.getBoundingClientRect().left>=0&&e.getBoundingClientRect().right<=innerWidth'))
                check('TD evolution confirmation is visible '+str(width),page.locator('.evolution-result .ad-button').evaluate('e=>e.getBoundingClientRect().bottom<=innerHeight'))
                shot(page,'td-evolution-result-'+str(width))
            page.locator('.evolution-result .ad-button').click()
            page.get_by_role('button',name='确认形态').click()
            for form in ['base','evolved']:
                page.evaluate("__defense.campaign.deckFocus='U01';__defense.campaign.showCardForms()")
                page.locator('.card-form-controls [data-form="'+form+'"]').click()
                state=page.evaluate("""()=>{const c=__defense.campaign,u=c.unit('U01'),i=document.querySelector('.card-form-art');return {
                    appearance:u.appearance,cardId:u.cardId,resourceId:u.resourceId,displayCardId:u.displayCardId,
                    choice:JSON.stringify(c.deckChoice),fit:getComputedStyle(i).objectFit,src:i.src};}""")
                check('TD '+form+' changes art and model without changing identity or deck',state['appearance']==form and state['cardId']==counts['id'] and state['choice']==counts['before'] and state['fit']=='contain',state)
                shot(page,'td-'+form)
                page.get_by_role('button',name='确认形态').click()
            page.evaluate("__defense.campaign.deckFocus='U01';__defense.campaign.showCardForms()")
            page.locator('.card-form-controls [data-form="base"]').click()
            for width,height in [(390,844),(844,390),(568,320)]:
                page.set_viewport_size({'width':width,'height':height})
                check('complete card modal fits '+str(width),page.locator('.card-form-dialog').evaluate('e=>e.scrollWidth<=e.clientWidth+1&&e.getBoundingClientRect().right<=innerWidth+1'))
                shot(page,'td-form-'+str(width))
            page.get_by_role('button',name='确认形态').click()
            for width,height in [(320,568),(390,844),(600,900),(844,390),(568,320),(1440,900)]:
                page.set_viewport_size({'width':width,'height':height})
                cards=page.evaluate("""async()=>{const list=[...document.querySelectorAll('.deck-card:not([hidden]) .deck-illustration')];
                    await Promise.all(list.map(i=>{i.loading='eager';return i.decode();}));return list.map(i=>{const r=i.getBoundingClientRect(),p=i.parentElement.getBoundingClientRect();
                        return {src:i.src,ok:i.naturalWidth>0&&r.left>=p.left&&r.right<=p.right+.1&&r.top>=p.top&&r.bottom<=p.bottom+.1&&getComputedStyle(i).objectFit==='contain'};});}""")
                check('decoded card artwork is fully inside its frame '+str(width)+'x'+str(height),all(c['ok'] for c in cards),{'cards':len(cards),'clipped':[c for c in cards if not c['ok']]})
                shot(page,'td-cards-'+str(width))
            page.set_viewport_size({'width':1440,'height':900})
            shot(page,'td-roster')
            page.locator('[data-action="deck-start"]').click()
            page.locator('[data-action="brief-close"]').click(timeout=60000)
            for _ in range(120):
                if page.evaluate('!!__defense.campaign.view?.ready'):
                    break
                page.wait_for_timeout(500)
            else:
                raise AssertionError('TD battle did not become ready')
            check('base card deploys through the real UI',page.evaluate("async()=>{const {createCampaignDriver}=await import('/site/etowaria-defense/tests/campaign-driver.js');return await createCampaignDriver().deploy('U01',0,1);}"))
            for _ in range(120):
                if page.evaluate("[...__defense.campaign.view.models.values()].some(m=>m.unit?.id==='U01')"):
                    break
                page.wait_for_timeout(500)
            else:
                raise AssertionError('TD U01 model did not load')
            actual=page.evaluate("[...__defense.campaign.view.models.values()].find(m=>m.unit?.id==='U01').unit")
            check('TD battlefield loads original base model',actual['resourceId']==160003 and actual['cardId']==16002001,actual['resourceId'])
            check('TD base appearance still carries earned evolution ability',page.evaluate("[...__defense.campaign.view.battle.units.values()].find(u=>u.type==='U01').evolved"))
            for width,height in [(320,568),(390,844),(600,900),(844,390),(568,320),(1440,900)]:
                page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(180)
                bounds=page.evaluate("""()=>{const c=__defense.campaign;return {paused:c.view.battle.pauses.has('orientation'),
                    areas:[...document.querySelectorAll('.battle-viewport,.battle-head,.battle-tools,.battle-seeds,.gear-tray')].filter(n=>n.getClientRects().length).map(n=>{const r=n.getBoundingClientRect();return {name:n.className,x:r.x,y:r.y,w:r.width,h:r.height,ok:r.x>=-.5&&r.y>=-.5&&r.right<=innerWidth+.5&&r.bottom<=innerHeight+.5};})};}""")
                check('TD battle fits and remains playable '+str(width)+'x'+str(height),not bounds['paused'] and all(r['ok'] and r['h']>0 for r in bounds['areas']),bounds)
                lane_error=page.evaluate("""()=>{const c=__defense.campaign,v=c.view;return Math.max(...c.laneNodes.map(({marker},row)=>{
                    const p=v.world(row,-.9).project(v.stage.camera);return Math.hypot(parseFloat(marker.style.left)-(p.x+1)*v.stage.width/2,
                        parseFloat(marker.style.top)-(1-p.y)*v.stage.height/2);}));}""")
                check('TD lane markers follow resized camera '+str(width)+'x'+str(height),lane_error<.5,lane_error)
                shot(page,'td-battle-'+str(width))
            scenes=page.evaluate("""async()=>{
                const {loadRuntimeAssets}=await import('/site/etowaria-defense/app/assets.js');
                const {createCinematic}=await import('/site/etowaria-defense/render/cinematic.js');
                const {withCardForm}=await import('/site/core/card-forms.js');
                const assets=await loadRuntimeAssets(),renderer=new assets.THREE.WebGLRenderer(),rows=[];
                renderer.setSize(640,480);
                try{for(const id of ['U01','U22'])for(const name of ['base','evolved']){
                    const unit=withCardForm(__defense.campaign.catalogue.units.find(u=>u.id===id),name);
                    const scene=await createCinematic(assets,unit,{playVoice(){},beginCinematic(){},endCinematic(){}});
                    try{for(let i=0;i<30;i++){scene.update(.1);scene.render(renderer);}
                        rows.push({id,name,resource:unit.resourceId,frame:scene.player.frame});
                    }finally{scene.dispose();}
                }}finally{renderer.dispose();}
                return rows;
            }""")
            check('both costumes keep the original ultimate scene and motion, including Mira',len(scenes)==4 and all(s['frame']>0 for s in scenes),scenes)
            page.evaluate("""async()=>{const c=__defense.campaign,snapshot=c.view.battle.serializeSetup();delete snapshot.evolved;
                const {saveFormPreference}=await import('/site/core/card-forms.js');saveFormPreference(c.unit('U01'),'evolved',c.formPreferences);
                c.save.storage.setItem(c.setupCacheKey(),JSON.stringify(snapshot));c.showMap();await c.startLevel(snapshot.level);}""")
            legacy=page.evaluate("""()=>{const c=__defense.campaign,u=[...c.view.battle.units.values()].find(u=>u.type==='U01'),
                actor=[...c.view.models.values()].find(m=>m.unit?.id==='U01').unit;
                return {evolved:u.evolved,appearance:actor.appearance,resource:actor.resourceId,camp:c.save.evolutionQuote('U01').evolved};}""")
            check('legacy TD setup keeps its original model and ability despite later camp evolution',legacy['camp'] and not legacy['evolved'] and legacy['appearance']=='base' and legacy['resource']==160003,legacy)
            ctx.close()
            for form in ['base','evolved']:
                ctx=browser.new_context(viewport={'width':1280,'height':840})
                ctx.add_init_script("if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',JSON.stringify({gems:100000,prologueSeen:true,tutorialSeen:true,evolution:{experience:{'14002001':3},evolved:[],pearls:[3,3,3,3,3,3]}}));")
                p=ctx.new_page();watch(p)
                p.goto(base+'/site/game/roguelike.html?seed=14')
                p.locator('.roster-card[data-card-id="14002001"]').click(timeout=60000)
                p.locator('.rl-growth-toggle').click()
                if form=='base':
                    p.locator('#roster-train').click();p.locator('#camp-character').select_option('14002001')
                    p.locator('#camp-target').fill('25');p.locator('#camp-train').click()
                    p.locator('#rl-camp-training').get_by_role('button',name='关闭',exact=True).click()
                    check('returning from real camp training refreshes evolution preview', 'Lv.25' in p.locator('.evolution-summary .evolution-caption').inner_text())
                p.locator('#roster-evolve').click()
                check('RL evolution purchase persists before starting '+form,p.locator('#roster-evolve').is_disabled() and p.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).meta.evolution.evolved.includes('14002001')"))
                p.emulate_media(reduced_motion='reduce')
                check('reduced motion disables the result animation',p.locator('.evolution-result .evolution-form').last.evaluate('e=>getComputedStyle(e).animationName==="none"'))
                check('RL growth comparison shows real starting level and stats',p.locator('.evolution-result .evolution-stat').count()==3 and 'Lv.' in p.locator('.evolution-result .evolution-caption').inner_text())
                expected_hp=int(p.locator('.evolution-result .evolution-stat dd').first.inner_text().split('→')[-1].strip())
                for width,height in [(390,844),(568,320),(1280,840)]:
                    p.set_viewport_size({'width':width,'height':height})
                    check('RL evolution result fits '+str(width)+'x'+str(height),p.locator('.evolution-result').evaluate('e=>e.scrollWidth<=e.clientWidth+1&&e.getBoundingClientRect().right<=innerWidth'))
                    check('RL evolution confirmation is visible '+str(width),p.locator('.evolution-result .ad-button').evaluate('e=>e.getBoundingClientRect().bottom<=innerHeight'))
                    shot(p,'rl-evolution-result-'+str(width))
                p.locator('.evolution-result .ad-button').click()
                p.emulate_media(reduced_motion='no-preference')
                p.locator('.rl-form-controls [data-form="'+form+'"]').click()
                shot(p,'rl-'+form)
                p.locator('#roster-start').click()
                for _ in range(120):
                    if p.evaluate('!!kirafanRL.world.player&&kirafanRL.pending===0&&!kirafanRL.roomLoading'):
                        break
                    p.wait_for_timeout(500)
                else:
                    raise AssertionError('RL player did not load')
                state=p.evaluate("""()=>{const k=kirafanRL,p=k.world.player;return {appearance:p.appearance,
                    display:p.displayCardId,id:p.card.id,resource:k.views.player.actor.resourceId,
                    saved:JSON.parse(localStorage.getItem('kirafan-rl:profile')).run.appearance};}""")
                check('RL '+form+' owns actual actor, portrait and persisted appearance',state['appearance']==form and state['saved']==form and state['id']==14002001 and state['display']==(14002000 if form=='base' else 14002001),state)
                check('evolution preview equals actual starting health '+form,p.evaluate('kirafanRL.world.player.maxHp')==expected_hp)
                # A later camp preference must not rewrite the costume in this saved run.
                p.evaluate("localStorage.setItem('kirafan.card-forms.v1',JSON.stringify({'14002000':'"+('evolved' if form=='base' else 'base')+"'}))")
                p.reload();p.locator('#roster-continue').click(timeout=60000)
                for _ in range(120):
                    if p.evaluate('!!kirafanRL.world.player&&kirafanRL.pending===0&&!kirafanRL.roomLoading'):
                        break
                    p.wait_for_timeout(500)
                else:
                    raise AssertionError('RL resumed player did not load')
                check('resume keeps saved '+form+' despite changed camp preference',p.evaluate('kirafanRL.world.player.appearance')==form)
                check('resume keeps earned ability '+form,p.evaluate('kirafanRL.world.player.evolved===true'))
                ctx.close()
            ctx=browser.new_context(viewport={'width':800,'height':600});p=ctx.new_page();watch(p)
            p.route('**/contact-probe.html',lambda r:r.fulfill(content_type='text/html',body='<div id="stage"></div>'))
            p.goto(base+'/contact-probe.html');p.evaluate(SETUP,{'cap':8,'preload':True})
            rows=p.evaluate(PIXELS)
            check('32 blade pixel cases cover actual hit area and follow movement',all(r['gain']>25 and r['hit'] and not r['outside'] and r['followed'] for r in rows),rows)
            p.evaluate("audit.unit.x=0;audit.unit.y=0;audit.unit.facing=0;audit.fx.emitSlash(audit.unit);audit.render(.01)")
            shot(p,'blade-coverage')
            ctx.close();browser.close()
        check('no browser or shader errors',not report['errors'],report['errors'])
        check('all requested assets exist',not report['failed'],report['failed'])
    finally:
        server.shutdown();worker.join(timeout=5);server.server_close()
        (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')

if __name__=='__main__':main()
