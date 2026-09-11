"""Actual equip confirmation, model HTTP failure, explicit retry and disposal.

The deterministic drop is a fixture, not a test of drop probabilities. Equipment
acceptance, persistence, actor loading, menu input and network recovery are real.
"""
import functools
import hashlib
import json
import re
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.codex-tmp/equipment-recovery'


def fingerprints():
    files=['site/game/roguelike.html','site/game/rl/main.js','site/game/rl/world.js','site/game/rl/view/actorview.js',
           'site/game/rl/ui/hud.js','site/game/rl/ui/theme.css','site/core/actor.js','site/core/loader.js']
    return {f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files}


def snapshot(page):
    return page.evaluate("""()=>{const k=kirafanRL,p=k.world.player,v=k.views.player;return {
        items:p.equipment,base:p.base,hp:p.hp,coin:k.world.coin,gauge:p.skills.gauge,
        bytes:localStorage.getItem('kirafan-rl:profile'),status:v.equipment.status,
        ids:v.actor.weaponResourceIds,parts:v.actor.weaponParts.length,action:v.actor.action,
        classId:v.actor.classId,skills:v.actor.actionNames.filter(n=>n==='skill'||n.startsWith('class_skill'))};}""")


def settled(page,touch):
    page.wait_for_function('kirafanRL?.world?.player&&kirafanRL.pending===0',polling=50,timeout=60000)
    for _ in range(60):
        if not page.locator('#dialogue-box').is_visible():break
        n=page.locator('#dialogue-skip');n.tap() if touch else n.click();page.wait_for_timeout(30)
    advance(page,1/60)
    page.wait_for_function('kirafanRL.mapview.group?.userData.placements&&kirafanRL.interactPending===0',polling=50,timeout=60000)
    page.evaluate('async()=>{await kirafanRL.views.player.equipmentReady;}')
    advance(page,.8)


def choose_weapon(page,class_id):
    return page.evaluate("""async classId=>{const catalog=await fetch('/site/asset/rl/weapons-rl.json').then(r=>r.json()),
        manifest=await (await import('/site/core/loader.js')).loadManifest();
        const row=catalog.catalog.find(w=>w.charaId<0&&w.class===classId&&w.rare===3);
        if(!row)throw Error('无普通跨職武器夹具');
        const ids=[...new Set([row.resourceIdL,row.resourceIdR].filter(id=>id>0))];
        return {row,ids,files:ids.map(id=>manifest.models['model/weapon/wpn_'+id+'.muast'].file)};
    }""",class_id)


def pattern(base,files):
    return re.compile('(?:'+'|'.join(re.escape(base+'/'+f) for f in files)+r')(?:\?.*)?$')


def make_page(browser,base,errors,touch=False):
    context=browser.new_context(viewport={'width':844,'height':390} if touch else {'width':1280,'height':840},
                                is_mobile=touch,has_touch=touch)
    context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
        if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',
            JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
    page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(base+'/site/game/roguelike.html?volume=1&seed=10926',wait_until='load',timeout=60000)
    return context,page


def activate(page,selector,touch):
    node=page.locator(selector);node.tap() if touch else node.click()


def stale_model_case(page,base,check):
    # Direct equipment assignment and a held newer action promise isolate view
    # ownership. Model requests and candidate resource disposal remain real.
    older=choose_weapon(page,1);newer=choose_weapon(page,4);held=[]
    target=pattern(base,older['files']);page.route(target,lambda route:held.append(route))
    before=snapshot(page)
    page.evaluate("""args=>{const k=kirafanRL,v=k.views.player,a=v.actor;
        window.originalWeaponActions=a.loadWeaponActions.bind(a);
        a.loadWeaponActions=classId=>classId===args.newClass
            ? new Promise((resolve,reject)=>{window.finishNewActions=()=>originalWeaponActions(classId).then(resolve,reject);})
            : originalWeaponActions(classId);
        k.world.player.equipment=[{slot:'weapon',rarity:'common',catalogId:args.id,affixes:[]}];
        window.staleModel=v.syncEquipment();
    }""",{'id':older['row']['id'],'newClass':newer['row']['class']})
    for _ in range(200):
        if held:break
        page.wait_for_timeout(50)
    check('快速换装夹具确实先等待旧模型HTTP',bool(held))
    page.evaluate("""id=>{kirafanRL.world.player.equipment=[{slot:'weapon',rarity:'common',catalogId:id,affixes:[]}];
        window.nextModel=kirafanRL.views.player.syncEquipment();}""",newer['row']['id'])
    page.wait_for_function('typeof finishNewActions==="function"',polling=50)
    for route in held:route.continue_()
    page.unroute(target)
    page.evaluate('async()=>{await staleModel;}')
    stale=snapshot(page)
    check('旧模型迟到于新动作等待时不得覆盖上一已提交外观',stale['status']=='loading'
          and stale['ids']==before['ids'] and stale['parts']==before['parts'],stale)
    page.evaluate('async()=>{finishNewActions();await nextModel;kirafanRL.views.player.actor.loadWeaponActions=originalWeaponActions;kirafanRL.views.player.sync(0);}')
    current=snapshot(page)
    check('快速换装仅提交最新模型与普通动作且不修改档案',current['status']=='ready'
          and current['ids']==newer['ids'] and current['action']=='ext_4_idle' and current['bytes']==before['bytes'],current)


def equipped_case(browser,base,report,check,touch=False):
    prefix='手机横屏 ' if touch else '桌面 '
    context,page=make_page(browser,base,report['errors'],touch)
    try:
        hero=page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]'))
        hero.tap(timeout=60000) if touch else hero.click(timeout=60000)
        settled(page,touch);initial=snapshot(page);weapon=choose_weapon(page,0)
        check(prefix+'正常选角空装备为牧师默认杖',initial['items']==[] and initial['ids']==[1200] and initial['parts']>0,initial)
        faults=[];target=pattern(base,weapon['files'])
        def fail(route):faults.append(route.request.url);route.fulfill(status=503,body='model failure fixture')
        page.route(target,fail)
        page.evaluate("""id=>{const k=kirafanRL,w=k.world,p=w.player;window.modelDrop={x:p.x,y:p.y,
            items:[{slot:'weapon',rarity:'common',catalogId:id,affixes:[]}]};
            w.drops.push(modelDrop);w.events.push({type:'drop',drop:modelDrop,items:modelDrop.items,x:p.x,y:p.y});
            k.step(1/60);}""",weapon['row']['id'])
        activate(page,'#equipment-confirm',touch);advance(page,1/60)
        page.wait_for_function('kirafanRL.views.player.equipment.status==="error"',polling=50,timeout=60000)
        advance(page,1/60);failed=snapshot(page)
        check(prefix+'真实确认保存装备，但模型失败保留旧可用外观',bool(faults) and failed['items'][0]['catalogId']==weapon['row']['id']
              and failed['ids']==[1200] and failed['parts']>0 and json.loads(failed['bytes'])['run']['equipment']==failed['items'],failed)
        count=len(faults);advance(page,1)
        check(prefix+'相同失败状态60次更新不形成资源请求风暴',len(faults)==count)
        activate(page,'.hud-pause',touch);advance(page,1/60)
        check(prefix+'菜单明确显示外观失败和可执行重试',page.locator('#menu-equipment-model').is_visible()
              and page.locator('#menu-equipment-retry').is_visible()
              and '数值已生效' in page.locator('#menu-equipment-model').inner_text())
        page.screenshot(path=str(OUT/('failure-mobile.png' if touch else 'failure-desktop.png')))
        before=snapshot(page)
        activate(page,'#menu-equipment-retry',touch)
        page.wait_for_function('kirafanRL.views.player.equipment.status==="error"',polling=50,timeout=60000);advance(page,1/60)
        again=snapshot(page)
        check(prefix+'失败重试不重复装备、不改数值或持久字节',again['bytes']==before['bytes'] and again['base']==before['base']
              and again['items']==before['items'] and again['ids']==before['ids'] and len(faults)>count)
        page.unroute(target,fail)
        loading=[];page.route(target,lambda route:loading.append(route))
        activate(page,'#menu-equipment-retry',touch)
        for _ in range(200):
            if loading:break
            page.wait_for_timeout(50)
        check(prefix+'正在加载时重复重试复用同一请求并禁用按钮',bool(loading)
              and page.locator('#menu-equipment-retry').is_disabled()
              and page.evaluate('kirafanRL.views.player.retryEquipment()===kirafanRL.views.player.equipmentReady'))
        for route in loading:route.continue_()
        page.unroute(target)
        page.wait_for_function('kirafanRL.views.player.equipment.status==="ready"',polling=50,timeout=60000);advance(page,1/60)
        recovered=snapshot(page)
        check(prefix+'恢复网络后同装备键可重试成功且普通动作跟随目录',recovered['ids']==weapon['ids']
              and recovered['parts']>0 and recovered['action']=='ext_0_idle' and recovered['bytes']==before['bytes'],recovered)
        check(prefix+'重试不改变角色职业或技能身份',recovered['classId']==2 and recovered['skills']==initial['skills'])
        check(prefix+'成功后收起告警且焦点回到可见继续按钮',not page.locator('#menu-equipment-model').is_visible()
              and page.evaluate('document.activeElement.id==="menu-resume"'))
        page.reload(wait_until='load');activate(page,'#roster-continue',touch);settled(page,touch)
        restored=snapshot(page)
        check(prefix+'续档恢复真实目录模型与已确认装备',restored['ids']==weapon['ids'] and restored['items']==recovered['items']
              and restored['status']=='ready',restored)
        if not touch:
            stale_model_case(page,base,check)
            # Direct view assignment here isolates cancellation, not inventory
            # acceptance (already tested through the real confirmation above).
            late=choose_weapon(page,3);held=[];late_target=pattern(base,late['files'])
            page.route(late_target,lambda route:held.append(route))
            page.evaluate("""id=>{const k=kirafanRL;k.world.player.equipment=[{slot:'weapon',rarity:'common',catalogId:id,affixes:[]}];
                window.pendingModel=k.views.player.syncEquipment();}""",late['row']['id'])
            for _ in range(200):
                if held:break
                page.wait_for_timeout(50)
            check('模型销毁夹具具有真实未完成HTTP请求',bool(held))
            page.evaluate("""async()=>{const {THREE:T}=await (await import('/site/core/loader.js')).loadModules();
                window.originalGeometryDispose=T.BufferGeometry.prototype.dispose;window.disposedGeometry=[];
                T.BufferGeometry.prototype.dispose=function(){disposedGeometry.push(this.uuid);return originalGeometryDispose.call(this);};
                window.retiredView=kirafanRL.views.player;window.cancelledEquipCalls=0;
                const cancel=retiredView.actor.cancelEquip.bind(retiredView.actor);
                retiredView.actor.cancelEquip=()=>{cancelledEquipCalls++;return cancel();};
                retiredView.dispose();retiredView.dispose();retiredView.actor.dispose();
                window.disposedBeforeLate=disposedGeometry.length;}""")
            for route in held:route.continue_()
            page.unroute(late_target)
            released=page.evaluate("""async()=>{await pendingModel;const {THREE:T}=await (await import('/site/core/loader.js')).loadModules();
                T.BufferGeometry.prototype.dispose=originalGeometryDispose;return {lateDisposed:disposedGeometry.length-disposedBeforeLate,
                    cancellations:cancelledEquipCalls,
                    parts:retiredView.actor.weaponParts.length,parent:!!retiredView.actor.object.parent,
                    canPlay:retiredView.actor.play('idle')};}""")
            check('视图销毁后迟到模型释放几何且不复活演员',released['lateDisposed']>0 and released['parts']==0
                  and not released['parent'] and not released['canPlay'],released)
            check('重复销毁视图只撤销一次外观请求',released['cancellations']==1,released)
        report['cases'].append({'touch':touch,'weapon':weapon,'failed':failed,'recovered':recovered,'restored':restored})
    except Exception:
        page.screenshot(path=str(OUT/'last-failure.png'));raise
    finally:context.close()


def default_case(browser,base,report,check):
    context,page=make_page(browser,base,report['errors'])
    try:
        file=page.evaluate("""async()=>{const m=await (await import('/site/core/loader.js')).loadManifest();
            return m.models['model/weapon/wpn_1200.muast'].file;}""")
        target=pattern(base,[file]);faults=[]
        def fail(route):faults.append(route.request.url);route.fulfill(status=503,body='default model failure fixture')
        page.route(target,fail)
        page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]')).click(timeout=60000)
        settled(page,False);advance(page,1/60)
        check('默认武器缺资源也明确为失败，不冒充加载成功',bool(faults)
              and page.evaluate('kirafanRL.views.player.equipment.status==="error"&&kirafanRL.views.player.actor.weaponParts.length===0'))
        activate(page,'.hud-pause',False);advance(page,1/60)
        before=snapshot(page);page.unroute(target,fail)
        activate(page,'#menu-equipment-retry',False)
        page.wait_for_function('kirafanRL.views.player.equipment.status==="ready"',polling=50,timeout=60000);advance(page,1/60)
        after=snapshot(page)
        check('默认武器恢复网络后可重试，不凭空增加装备或改档',after['ids']==[1200] and after['parts']>0
              and after['items']==[] and after['bytes']==before['bytes'],after)
        # A direct view fixture covers unequip after an already-mounted weapon;
        # shared actor.equip(default) retains its tolerant compatibility API.
        # Start a fresh document with the default fetch blocked: a successful
        # earlier load is intentionally cached and would not hit HTTP again.
        page.route(target,fail);page.reload(wait_until='load')
        activate(page,'#roster-continue',False);settled(page,False)
        activate(page,'.hud-pause',False);advance(page,1/60)
        fallback_before=snapshot(page)
        check('卸装故障夹具在新页面确实没有默认资源缓存',fallback_before['status']=='error'
              and fallback_before['parts']==0,fallback_before)
        weapon=choose_weapon(page,0)
        page.evaluate("""async id=>{const k=kirafanRL;k.world.player.equipment=[{slot:'weapon',rarity:'common',catalogId:id,affixes:[]}];
            await k.views.player.syncEquipment();k.views.player.sync(0);}""",weapon['row']['id'])
        check('卸装失败夹具先挂载实际目录外观',snapshot(page)['ids']==weapon['ids'])
        fault_count=len(faults)
        page.evaluate('async()=>{kirafanRL.world.player.equipment=[];await kirafanRL.views.player.syncEquipment();}')
        advance(page,1/60);missing=snapshot(page)
        check('卸装默认资源失败保留旧外观但不误标成功',missing['status']=='error' and missing['ids']==weapon['ids']
              and missing['bytes']==fallback_before['bytes'] and len(faults)>fault_count,missing)
        page.unroute(target,fail);activate(page,'#menu-equipment-retry',False)
        page.wait_for_function('kirafanRL.views.player.equipment.status==="ready"',polling=50,timeout=60000);advance(page,1/60)
        restored=snapshot(page)
        check('卸装默认资源恢复后只切回默认模型与动作',restored['ids']==[1200] and restored['action']=='idle'
              and restored['items']==[] and restored['bytes']==fallback_before['bytes'],restored)
    finally:context.close()


def main():
    OUT.mkdir(parents=True,exist_ok=True);report={'checks':[],'cases':[],'errors':[],'source_before':fingerprints(),'complete':False}
    def check(label,ok,detail=None):
        report['checks'].append({'label':label,'ok':bool(ok),'detail':detail});print(('PASS ' if ok else 'FAIL ')+label,flush=True)
        if not ok:raise AssertionError(label+': '+str(detail))
    server=Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
            base='http://127.0.0.1:%d'%server.server_address[1]
            equipped_case(browser,base,report,check)
            equipped_case(browser,base,report,check,True)
            default_case(browser,base,report,check)
            check('外观故障与恢复无未处理页面异常',not report['errors'],report['errors'])
            report['complete']=True;browser.close()
    except Exception as error:report['failure']=str(error);raise
    finally:
        report['source_after']=fingerprints()
        report['changed_during_run']=[f for f in report['source_before'] if report['source_before'][f]!=report['source_after'][f]]
        (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
        server.shutdown();worker.join(timeout=5);server.server_close()


if __name__=='__main__':main()
