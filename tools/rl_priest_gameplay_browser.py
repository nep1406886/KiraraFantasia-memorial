"""Real roster/input -> priest projectile -> original line -> lifetime cleanup.

No direct bullet emission or character/stat substitution. Six current playable
cards provide the six actual elements. Pixel differences isolate the authored
line on the real stage; decorative particles cannot satisfy the visual gate.
"""
import argparse
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/priest-gameplay'
# Exact current card/element pairs, independent of presentation routing.
CASES = [(19002001,0),(12002001,1),(24002001,2),(33012001,3),(35002001,4),(32002001,5)]

STATE = """()=>{const k=kirafanRL,shots=[];k.world.danmaku.forEach(b=>{
    if(b.side==='player')shots.push({id:b.spawnId,skill:b.skillId,element:b.element,
        life:b.life,x:b.x,y:b.y,normal:b.normalContext?.classId,ready:k.effects.projectileVisualReady(b)});
});return {shots,effects:k.effects.stats,generic:k.views.danmaku.count+k.views.danmaku.streakCount,
    action:k.world.player.sm.state,swing:k.world.player.swingId,frozen:k.world.frozen,
    roomLoading:k.roomLoading,touchDisabled:document.querySelector('.touch-attack').getAttribute('aria-disabled')};}"""

LINE_PIXELS = """()=>{const k=kirafanRL,lines=[],particles=[];
    for(const root of k.scene.children.filter(n=>n.userData.rlOverlay&&!n.isInstancedMesh&&!n.isPoints)){
        root.traverse(n=>{if(n.isMesh&&n.name.endsWith('_line'))lines.push([n,n.visible]);
            if(n.name.startsWith('pe:'))particles.push([n,n.visible]);});
    }
    particles.forEach(([n])=>n.visible=false);
    const gl=k.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
    const read=()=>{k.renderOnce();const data=new Uint8Array(w*h*4);
        gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;};
    const before=read();lines.forEach(([n])=>n.visible=false);const after=read();
    let pixels=0;for(let i=0;i<before.length;i+=4){if(Math.abs(before[i]-after[i])
        +Math.abs(before[i+1]-after[i+1])+Math.abs(before[i+2]-after[i+2])>20)pixels++;}
    lines.forEach(([n,v])=>n.visible=v);particles.forEach(([n,v])=>n.visible=v);k.renderOnce();
    return {pixels,lines:lines.length,visibleLines:lines.filter(([,v])=>v).length};}"""


def fingerprints():
    files = ['site/game/rl/main.js','site/game/rl/world.js','site/game/rl/skills.js','site/game/rl/danmaku.js','site/game/rl/input.js',
             'site/game/rl/ui/attackaim.js','site/game/rl/ui/theme.css',
             'site/game/rl/weaponprofile.js','site/game/rl/ui/hud.js','site/game/rl/ui/orientation.js',
             'site/game/rl/view/actorview.js','site/game/rl/view/skillvfx.js','site/game/rl/view/danmakuview.js',
             'site/game/rl/view/effectcatalog.js','site/game/rl/view/nativeassets.js','site/core/actor.js',
             'site/asset/rl/native/index.json','site/asset/rl/playable-roster.json']
    return {f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files}


def run_case(browser, base, card, element, touch, fail, report, check):
    name = str(card) + (' 触控' if touch else ' 键盘') + (' 资源故障' if fail else '')
    context = browser.new_context(viewport={'width':844,'height':390} if touch else {'width':1280,'height':840},
                                  is_mobile=touch, has_touch=touch)
    context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
        localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
    page = context.new_page(); page.on('pageerror', lambda e:report['errors'].append(str(e)))
    faults = []
    if fail:
        def missing(route):
            faults.append(route.request.url);route.fulfill(status=503,body='injected priest asset failure')
        page.route('**/ef_btl_priest_attack_*.glb.gz', missing)
    try:
        page.goto(base+'/site/game/roguelike.html?volume=1&seed=10926',wait_until='load',timeout=60000)
        hero = page.locator('.roster-card').filter(has=page.locator('img[src$="/%d.webp"]'%card))
        hero.tap(timeout=60000) if touch else hero.click(timeout=60000)
        page.wait_for_function('kirafanRL?.world?.player&&kirafanRL.pending===0',polling=50,timeout=60000)
        for _ in range(60):
            if not page.locator('#dialogue-box').is_visible():break
            button=page.locator('#dialogue-skip');button.tap() if touch else button.click()
            page.wait_for_timeout(30)
        advance(page,1/60)
        page.wait_for_function('kirafanRL.mapview.group?.userData.placements&&kirafanRL.interactPending===0',polling=50,timeout=60000)
        page.evaluate('async()=>{try{await kirafanRL.effects.prepare(kirafanRL.world.player);}catch(_){}}')
        # Model pending==0 is not the room-reveal commit. With rAF disabled,
        # step once AFTER reveal so the HUD can publish its enabled state too.
        page.wait_for_function('kirafanRL.pending===0&&!kirafanRL.roomLoading&&!kirafanRL.world.frozen',polling=50,timeout=60000)
        advance(page,2)
        initial = page.evaluate("""async()=>{const k=kirafanRL,p=k.world.player;
            window.priestNative=await import('/site/game/rl/view/nativeassets.js');
            return {id:p.card.id,element:p.element,classId:p.weaponProfile.classId,items:p.equipment,
                weapons:k.views.player.actor.weaponResourceIds,refs:priestNative.nativeCacheStats().refs,
                cached:k.effects.stats.cached};}""")
        check(name+' 真实选角保持牧师身份与职业默认杖',initial['id']==card and initial['element']==element
              and initial['classId']==2 and initial['items']==[] and initial['weapons']==[1200],initial)
        if touch:page.locator('.touch-attack').tap()
        else:page.keyboard.down('KeyJ')
        advance(page,1/60)
        if not touch:page.keyboard.up('KeyJ')
        first = None
        for _ in range(40):
            advance(page,1/60);state=page.evaluate(STATE)
            if state['shots']:first=state;break
        check(name+' 真实普攻短按只发出一枚本属性普通弹',first is not None and len(first['shots'])==1
              and first['shots'][0]['element']==element and first['shots'][0]['skill']==3
              and first['shots'][0]['normal']==2,first)
        page.wait_for_function('kirafanRL.effects.stats.loaded>0||kirafanRL.effects.stats.errors.length>0',polling=50,timeout=30000)
        samples=[];pixels=[]
        for step in range(60):
            advance(page,1/60);state=page.evaluate(STATE);samples.append(state)
            if not state['shots']:break
            if step in (3,10,18,27):pixels.append({'step':step,**page.evaluate(LINE_PIXELS)})
            if step==10:page.screenshot(path=str(OUT/(str(card)+('-touch' if touch else '-keyboard')+('-failed' if fail else '')+'.png')))
        live=[s for s in samples if s['shots']]
        check(name+' 一次输入贯穿完整寿命且不重复发射',len(live)>=24 and all(len(s['shots'])==1
              and s['shots'][0]['id']==first['shots'][0]['id'] for s in live) and not samples[-1]['shots'],
              {'liveFrames':len(live),'last':samples[-1]})
        if fail:
            check(name+' 素材故障时真实弹体全寿命保留通用可见回退',bool(faults) and all(s['generic']==1
                  and not s['shots'][0]['ready'] for s in live),{'faults':faults,'liveFrames':len(live)})
        else:
            check(name+' 原作光线就绪后全寿命不叠画通用弹或施法者副本',
                  all(s['generic']==0 and s['shots'][0]['ready'] and s['effects']['active']==1 for s in live),live[:2])
            check(name+' 多个寿命阶段都有实际主光线像素，排除装饰粒子',
                  len(pixels)==4 and all(p['lines']>0 and p['pixels']>10 for p in pixels),pixels)
        advance(page,.3)
        end=page.evaluate(STATE)
        refs=page.evaluate('priestNative.nativeCacheStats().refs')
        check(name+' 自然到期后无活动弹体或跟随者，额外引用仅为有界离场缓存',
              not end['shots'] and end['generic']==0 and end['effects']['active']==0
              and 0<=end['effects']['cached']<=8
              and refs-end['effects']['cached']==initial['refs']-initial['cached'],
              {'state':end,'refs':refs,'baseline':initial['refs']})
        page.evaluate('kirafanRL.effects.clear()')
        check(name+' 换房清理后离场缓存和所有原作特效引用归零',
              page.evaluate('kirafanRL.effects.stats.cached===0&&kirafanRL.effects.stats.active===0')
              and page.evaluate('priestNative.nativeCacheStats().refs')==initial['refs']-initial['cached'])
        report['cases'].append({'name':name,'initial':initial,'samples':samples,'pixels':pixels,'faults':faults})
    except Exception:
        report['failure_state']=page.evaluate(STATE)
        page.screenshot(path=str(OUT/'failure.png'));raise
    finally:context.close()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--card',type=int);args=parser.parse_args()
    cases=[c for c in CASES if args.card is None or c[0]==args.card]
    if not cases:parser.error('card must be a current six-element acceptance fixture')
    OUT.mkdir(parents=True,exist_ok=True)
    report={'checks':[],'cases':[],'errors':[],'source_before':fingerprints(),'complete':False}
    def check(label,ok,detail=None):
        report['checks'].append({'label':label,'ok':bool(ok),'detail':detail})
        print(('PASS ' if ok else 'FAIL ')+label,flush=True)
        if not ok:raise AssertionError(label+': '+str(detail))
    server=Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    base='http://127.0.0.1:%d'%server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
            report['browser']=browser.version
            for card,element in cases:run_case(browser,base,card,element,False,False,report,check)
            if args.card is None:
                run_case(browser,base,32002001,5,True,False,report,check)
                run_case(browser,base,19002001,0,False,True,report,check)
            check('全部真实牧师输入场景无未处理页面异常',not report['errors'],report['errors'])
            report['complete']=True;browser.close()
    except Exception as error:
        report['failure']=str(error);raise
    finally:
        report['source_after']=fingerprints()
        report['changed_during_run']=[f for f in report['source_before'] if report['source_before'][f]!=report['source_after'][f]]
        (OUT/('report-'+str(args.card)+'.json' if args.card else 'report.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        server.shutdown();worker.join(timeout=5);server.server_close()


if __name__=='__main__':main()
