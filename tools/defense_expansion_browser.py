"""Batch-load every new original card, then exercise native actions and effects.
Funded, stationary-enemy fixtures test presentation; real economy has its own harness.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.codex-tmp/defense-expansion'
SETUP='''async ids=>{
 const c=__defense.campaign;c.save.deck=ids;
 await c.startLevel('endless',{skipCache:true});c.closeDialog('brief-dialog','brief');
 const v=c.view,b=v.battle;b.resource=5000;
 for(let i=0;i<ids.length;i++){v.select(ids[i]);const result=await v.deployCell(i%5,i<5?5:3);if(!result.ok)throw Error(ids[i]+result.reason);}
 await v.loadEnemy('E01');
 window.auditEvents=[];const emit=b.emit.bind(b);
 b.emit=(type,detail={})=>{if(type==='unitAction')auditEvents.push({id:b.units.get(detail.id)?.type,action:detail.action});emit(type,detail);};
 b.start();for(let row=0;row<5;row++)for(const x of [4.2,6.2]){
  const e=b.spawn({type:'E01',row,x,wave:1,hpScale:1000,summoned:true});e.stunUntil=1000;
 }
 v.consumeEvents();return [...v.models.values()].filter(m=>m.unit?.id?.startsWith('U')).map(m=>m.unit.id);
}'''

def main():
 OUT.mkdir(parents=True,exist_ok=True);report={'batches':[],'errors':[]}
 with sync_playwright() as pw:
  browser=pw.chromium.launch(channel='msedge',args=['--enable-unsafe-swiftshader'])
  for start in range(96,168,8):
   page=browser.new_page(viewport={'width':1440,'height':900})
   page.on('pageerror',lambda error:report['errors'].append(str(error)))
   page.goto('http://127.0.0.1:8643/site/etowaria-defense/index.html?review=1')
   page.locator('#start-campaign:enabled').wait_for(timeout=60000);page.locator('#start-campaign').click()
   page.wait_for_function('()=>!!window.__defense?.campaign')
   ids=['U'+str(i) for i in range(start,start+8)]
   models=page.evaluate(SETUP,ids)
   peak=0
   for frame in range(64):
    page.wait_for_function('()=>{const v=__defense.campaign.view;return v.ready&&!v.loading&&!v.battle.pauses.size}',timeout=60000)
    state=page.evaluate('''()=>{const v=__defense.campaign.view;for(const u of v.battle.units.values())u.hp=Math.max(1,u.maxHp*.5);v.reviewStep(.5);
      return {effects:v.stage.effects.active.size,calls:v.stage.renderer.info.render.calls};}''')
    peak=max(peak,state['effects'])
    if frame==19:page.screenshot(path=str(OUT/f'cards-{start}.png'))
    page.wait_for_timeout(20)
   actions=page.evaluate('auditEvents');acted={a['id'] for a in actions if a.get('id')}
   history=page.evaluate('__defense.campaign.view.stage.effects.history.map(e=>e.effect)')
   row={'ids':ids,'models':models,'acted':sorted(acted),'effects':sorted(set(history)),'peakEffects':peak,
        'ok':set(ids)<=acted and set(ids)<=set(models) and bool(history) and peak<=72}
   report['batches'].append(row);print(('PASS ' if row['ok'] else 'FAIL ')+','.join(ids),flush=True)
   page.close()
  browser.close()
 (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
 print('Errors:',report['errors'],flush=True)
 return int(bool(report['errors']) or not all(r['ok'] for r in report['batches']))

if __name__=='__main__':raise SystemExit(main())
