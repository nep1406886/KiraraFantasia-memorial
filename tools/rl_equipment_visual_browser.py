"""Real browser regression for initial, equipped and removed weapon identity.

The normal roster entry is exercised; direct equipment edits below deliberately
isolate view ownership, not loot, combat statistics or persistence acceptance.
"""
import argparse
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".codex-tmp" / "equipment-visual"

SNAPSHOT = """() => {
    const k=window.kirafanRL,p=k.world.player,v=k.views.player,a=v.actor;
    return {card:p.card.id,classId:a.classId,ids:a.weaponResourceIds,
        parts:a.weaponParts.length,status:v.equipment.status,action:a.action,
        skills:a.actionNames.filter(n=>n==='skill'||n.startsWith('class_skill')),
        equipment:p.equipment};
}"""

EXERCISE = """async () => {
    const k=window.kirafanRL,p=k.world.player,v=k.views.player,a=v.actor;
    const data=await fetch('/site/asset/rl/weapons-rl.json').then(r=>r.json());
    const row=data.catalog.find(w=>w.charaId<0&&w.class!==p.card.class&&w.rare===3);
    const ids=[...new Set([row.resourceIdL,row.resourceIdR].filter(id=>id>0))];
    const item={slot:'weapon',rarity:'common',catalogId:row.id,affixes:[]};
    const beforeSkills=a.actionNames.filter(n=>n==='skill'||n.startsWith('class_skill'));
    p.equipment=[item]; await v.syncEquipment(); v.sync(0);
    const equipped={ids:a.weaponResourceIds,status:v.equipment.status,classId:a.classId,
        skills:a.actionNames.filter(n=>n==='skill'||n.startsWith('class_skill'))};
    p.equipment=[]; await v.syncEquipment(); v.sync(0);
    const removed={ids:a.weaponResourceIds,status:v.equipment.status,action:a.action};
    // Resolve the older action request last. It must not equip the old item.
    const original=a.loadWeaponActions.bind(a),pending=[];
    a.loadWeaponActions=cls=>new Promise((resolve,reject)=>pending.push({cls,resolve,reject}));
    p.equipment=[item]; const old=v.syncEquipment();
    p.equipment=[]; const current=v.syncEquipment();
    pending[1].resolve(await original(pending[1].cls)); await current;
    pending[0].resolve(await original(pending[0].cls)); await old; v.sync(0);
    a.loadWeaponActions=original;
    return {row:row.id,expectedIds:ids,beforeSkills,equipped,removed,
        race:{ids:a.weaponResourceIds,status:v.equipment.status,action:a.action}};
}"""


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--label',default='current')
    args=parser.parse_args()
    if not args.label.replace('-','').isalnum():
        parser.error('label must contain only letters, numbers or hyphens')
    OUT.mkdir(parents=True,exist_ok=True)
    truth={c['id']:c for c in json.loads((ROOT/'site/asset/rl/cards-rl.json').read_text(encoding='utf8'))['cards']}
    roster=json.loads((ROOT/'site/asset/rl/playable-roster.json').read_text(encoding='utf8'))['cards']
    cases=[next(c for c in roster if c['class']==cls and truth[c['id']].get('dedicatedWeapon')) for cls in range(5)]
    report={'checks':[],'cases':[],'errors':[]}
    def check(label,ok,detail=None):
        report['checks'].append({'label':label,'ok':bool(ok),'detail':detail})
        print(('PASS ' if ok else 'FAIL ')+label,flush=True)
    server=Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    base='http://127.0.0.1:%d'%server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
            report['browser']=browser.version
            for card in cases:
                context=browser.new_context(viewport={'width':1280,'height':840})
                context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
                    localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
                page=context.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
                try:
                    page.goto(base+'/site/game/roguelike.html?volume=1&seed=100926',wait_until='load',timeout=60000)
                    page.wait_for_selector('.roster-card',timeout=60000)
                    page.locator('.roster-card').filter(has=page.locator('img[src$="/%d.webp"]'%card['id'])).click()
                    page.wait_for_function('window.kirafanRL?.world?.player && window.kirafanRL.pending===0',polling=50,timeout=60000)
                    dismiss(page);advance(page,1/60)
                    page.evaluate('async()=>{await window.kirafanRL.views.player.equipmentReady;}')
                    initial=page.evaluate(SNAPSHOT)
                    expected=[1000+100*card['class']]
                    prefix=str(card['id'])+' '
                    check(prefix+'正常选角空装备使用职业默认武器',initial['equipment']==[] and initial['ids']==expected,initial)
                    check(prefix+'默认持械已挂载',initial['parts']>0 and initial['status']=='ready')
                    detail=page.evaluate(EXERCISE)
                    check(prefix+'跨职业装备挂载目录指定模型',detail['equipped']['ids']==detail['expectedIds'] and detail['equipped']['status']=='ready',detail['equipped'])
                    check(prefix+'装备不改变角色职业与技能',detail['equipped']['classId']==card['class'] and detail['equipped']['skills']==detail['beforeSkills'])
                    check(prefix+'卸下恢复职业默认武器和动作',detail['removed']['ids']==expected and detail['removed']['status']=='ready' and detail['removed']['action']=='idle',detail['removed'])
                    check(prefix+'迟到动作请求不能覆盖新装备',detail['race']['ids']==expected and detail['race']['status']=='ready',detail['race'])
                    report['cases'].append({'card':card,'initial':initial,**detail})
                    advance(page,1/60)
                    page.screenshot(path=str(OUT/(args.label+'-'+str(card['id'])+'.png')))
                finally:
                    context.close()
            browser.close()
        check('无未捕获页面异常',not report['errors'],report['errors'])
    finally:
        server.shutdown();worker.join(timeout=5);server.server_close()
        (OUT/(args.label+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    return int(any(not c['ok'] for c in report['checks']))

if __name__=='__main__':raise SystemExit(main())
