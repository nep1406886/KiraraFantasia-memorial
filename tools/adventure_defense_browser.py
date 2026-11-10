"""New-card choreography and bounded native effects in the real campaign view.

The isolated review save uses a funded encounter fixture for presentation only;
economic viability is covered separately by defense_battle_contracts.mjs.
"""
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/defense-renewal'

SETUP = r"""async () => {
    const c=__defense.campaign;
    c.save.deck=['U88','U89','U90','U91','U92','U93','U94','U95'];
    await c.startLevel('endless',{skipCache:true});
    c.closeDialog('brief-dialog','brief');
    const v=c.view,b=v.battle;
    b.resource=5000;
    const positions=[[3,5],[4,5],[1,5],[2,5],[2,3],[0,1],[2,1],[4,1]],deployed=[];
    for(let i=0;i<8;i++){const id='U'+(88+i);v.select(id);
        deployed.push({id,...await v.deployCell(...positions[i])});}
    for(const unit of b.units.values())unit.hp-=Math.min(120,unit.hp*.2);
    window.auditEvents=[];const emit=b.emit.bind(b);
    b.emit=(type,detail={})=>{if(['unitAction','healed','unitHurt','enemyAttack','enemyHurt'].includes(type))
        auditEvents.push({type,unit:b.units.get(detail.id)?.type,source:b.units.get(detail.source)?.type,
            action:detail.action,protected:detail.protected,critical:detail.critical});emit(type,detail);};
    await Promise.all(['E01','E04','E10'].map(type=>v.loadEnemy(type)));
    for(let row=0;row<5;row++)b.spawn({type:row===2?'E10':'E04',row,x:6.2,wave:1,hpScale:3,summoned:true});
    v.consumeEvents();
    return {deployed,models:[...v.models.values()].filter(m=>m.unit?.id?.startsWith('U')).map(m=>m.unit.id)};
}"""

POOL = r"""async () => {
    const v=__defense.campaign.view,T=v.stage.THREE;
    const {NativeEffects}=await import('/site/etowaria-defense/render/native-effects.js');
    const scene=new T.Scene(),fx=new NativeEffects(v.stage.assets,scene);
    const unit=__defense.campaign.catalogue.units.find(u=>u.id==='U93');
    const name=fx.actionPlan(unit,'attack').events.find(e=>/Projectile/.test(e.kind)).effect;
    await fx.prepare([name],8);
    let alive=true;const point=new T.Vector3(1,1,1),from=point.clone(),slots=[];
    for(let i=0;i<100;i++){const slot=fx.emit(name,{from,position:()=>alive?point:null});if(slot)slots.push(slot);}
    fx.update(.1);point.x=4;fx.update(.1);
    const result={active:fx.active.size,native:slots.filter(s=>!s.fallback).length,
        fallback:fx.fallbacks.length,moving:slots.filter(s=>s.fallback).every(s=>s.wrapper.position.x===4)};
    alive=false;fx.update(.1);result.retired=fx.active.size===0&&slots.every(s=>!s.wrapper.visible);
    const resources=new Map();scene.traverse(n=>{for(const r of [n.geometry,n.material].flat()){
        if(r&&!resources.has(r)){resources.set(r,0);r.addEventListener('dispose',()=>resources.set(r,resources.get(r)+1));}}});
    fx.dispose();fx.dispose();
    result.detached=scene.children.length===0;result.singleRelease=[...resources.values()].every(n=>n===1);
    return result;
}"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'frames': []}
    def check(name, ok):
        report['checks'].append({'name': name, 'ok': bool(ok)})
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)
    with Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT))) as server:
        worker=threading.Thread(target=server.serve_forever, daemon=True);worker.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(channel='msedge', args=['--use-gl=angle','--enable-unsafe-swiftshader'])
                page=browser.new_page(viewport={'width':1440,'height':900})
                page.on('pageerror', lambda error: report['errors'].append(error.stack or str(error)))
                page.goto(f'http://127.0.0.1:{server.server_address[1]}/site/etowaria-defense/index.html?review=1')
                page.locator('#start-campaign:enabled').wait_for(timeout=60000)
                page.locator('#start-campaign').click()
                page.wait_for_function('()=>!!window.__defense?.campaign',timeout=30000)
                setup=page.evaluate(SETUP);report['setup']=setup
                check('八位新增伙伴均完成真实模型与特效准备',len(setup['models'])==8 and all(r['ok'] for r in setup['deployed']))
                page.wait_for_function('()=>{const v=__defense.campaign.view;return v.ready&&!v.loading&&!v.battle.pauses.size;}',timeout=60000)
                page.locator('[data-action="start"]').click()
                for index in range(40):
                    frame=page.evaluate('''()=>{const v=__defense.campaign.view;v.reviewStep(.5);
                        return {time:v.battle.time,active:v.stage.effects.active.size,
                            history:v.stage.effects.history.map(e=>e.effect),calls:v.stage.renderer.info.render.calls};}''')
                    report['frames'].append(frame)
                    if index in [5,17,29]:page.screenshot(path=str(OUT/f'new-party-{index}.png'))
                    page.wait_for_timeout(20)
                events=page.evaluate('auditEvents');report['events']=events
                acted={e.get('unit') for e in events if e['type']=='unitAction'}
                check('八位伙伴均执行自身战斗动作',all('U'+str(i) in acted for i in range(88,96)))
                check('千明真实治疗同伴并产生治疗特效',any(e['type']=='healed' and e.get('source')=='U92' for e in events))
                check('葵的邻近保护在受击时生效',any(e['type']=='unitHurt' and e.get('protected') for e in events))
                check('敌人实际攻击，周期强化产生会心',any(e['type']=='enemyAttack' for e in events) and any(e.get('critical') for e in events))
                check('周期技进度可见',page.locator('.skill-cycle:visible').count()>=3)
                check('战斗特效并发有界',max(r['active'] for r in report['frames'])<=72)
                pool=page.evaluate(POOL);report['pool']=pool
                check('满池以24个轮廓降级弹体，沿相同路径移动',pool['native']==8 and pool['fallback']==24 and pool['active']==32 and pool['moving'])
                check('弹体消失后回收，重复销毁只释放一次',pool['retired'] and pool['detached'] and pool['singleRelease'])
                page.set_viewport_size({'width':844,'height':390});page.wait_for_timeout(250)
                page.screenshot(path=str(OUT/'new-party-mobile.png'))
                check('手机横屏八卡编队不溢出',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                release=page.evaluate('''()=>{const c=__defense.campaign,a=c.view.stage.ambience,resources=[a.object.geometry,a.object.material],counts=[0,0];
                    resources.forEach((r,i)=>r.addEventListener('dispose',()=>counts[i]++));
                    const before=a.object.material.uniforms.time.value;a.update(0);const paused=before===a.object.material.uniforms.time.value;
                    a.update(.1,true);const reduced=!a.object.visible;c.showMap();a.dispose();
                    return {paused,reduced,detached:!a.object.parent,counts};}''')
                report['ambience']=release
                check('环境花瓣暂停、减动效和离场释放正确',release['paused'] and release['reduced'] and release['detached'] and release['counts']==[1,1])
                browser.close()
        except Exception as error:
            report['errors'].append(repr(error));print('ERROR '+repr(error),flush=True)
        finally:
            server.shutdown();worker.join(timeout=5)
    check('新增角色实机无脚本异常',not report['errors'])
    (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return int(any(not row['ok'] for row in report['checks']))


if __name__=='__main__':
    raise SystemExit(main())
