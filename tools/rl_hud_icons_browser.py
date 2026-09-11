"""Battle action art, accessible input and responsive layout on the real page."""
import functools
import json
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss
from rl_ui_polish_browser import fingerprints

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.codex-tmp'/'hud-actions'

LAYOUT="""() => {
    const rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};};
    const skills=[...document.querySelectorAll('.hud-skill:not(.hud-hidden)')];
    const selectors=['.hud-skillbar','.hud-gauge','.touch-attack','.touch-dodge','.touch-interact','#minimap'];
    const areas=selectors.map(s=>{const n=document.querySelector(s);return {s,...rect(n),visible:getComputedStyle(n).display!=='none'};})
        .filter(r=>r.visible&&r.w>0&&r.h>0);
    const overlaps=[];for(let i=0;i<areas.length;i++)for(let j=i+1;j<areas.length;j++){
        const a=areas[i],b=areas[j];if(a.x<b.x+b.w-1&&b.x<a.x+a.w-1&&a.y<b.y+b.h-1&&b.y<a.y+a.h-1)overlaps.push([a.s,b.s]);}
    return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,touch:document.body.classList.contains('touch-on'),
        skills:skills.map(n=>({tag:n.tagName,label:n.getAttribute('aria-label'),name:n.querySelector('.hud-skill-name')?.textContent,
            art:n.querySelector('.hud-skill-icon')?.style.getPropertyValue('--skill-art'),...rect(n)})),
        gauge:{...rect(document.querySelector('.hud-gauge')),tag:document.querySelector('.hud-gauge').tagName},areas,overlaps};
}"""

def main():
    OUT.mkdir(parents=True,exist_ok=True);report={'checks':[],'layouts':[],'errors':[],'source_before':fingerprints()}
    def check(label,ok,detail=None):
        report['checks'].append({'label':label,'ok':bool(ok),'detail':detail});print(('PASS ' if ok else 'FAIL ')+label,flush=True)
    server=Server(('127.0.0.1',0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    base='http://127.0.0.1:%d'%server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(args=['--use-gl=angle','--enable-unsafe-swiftshader'])
            context=browser.new_context(viewport={'width':1280,'height':840},has_touch=True)
            context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
                localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
            page=context.new_page();page.on('pageerror',lambda e:report['errors'].append(str(e)))
            page.goto(base+'/site/game/roguelike.html?volume=1&seed=10926',wait_until='load',timeout=60000)
            page.wait_for_selector('.roster-card',timeout=60000)
            page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]')).click()
            page.wait_for_function('window.kirafanRL?.world?.player && window.kirafanRL.pending===0',polling=50,timeout=60000)
            dismiss(page);advance(page,1/60)
            art=page.evaluate("""async()=>{
                const {equipmentIcon}=await import('/site/game/rl/ui/decisions.js');
                const {skillArt}=await import('/site/game/rl/ui/skillart.js');
                const urls=['weapon','amulet','armor','charm'].map(slot=>equipmentIcon({slot,rarity:'common',affixes:[]}));
                for(const type of [3,4,5,6,7])urls.push(skillArt({skillType:type},0).url);
                const images=await Promise.all(urls.map(url=>new Promise(resolve=>{const im=new Image();im.onload=()=>resolve({url,width:im.naturalWidth});im.onerror=()=>resolve({url,width:0});im.src=url;})));
                return {images,empty:equipmentIcon(null),invalid:equipmentIcon({slot:'weapon',catalogId:-999})};
            }""")
            report['art']=art
            check('四装备槽与五种原作技能图标均可解码，改编装备独立目录',
                  all(r['width']>0 for r in art['images'])
                  and all('/equipment/' in r['url'] for r in art['images'][:4])
                  and all('/drop/skill-' in r['url'] for r in art['images'][4:]),art)
            check('空槽和损坏目录引用不伪装成有效装备',art['empty'] is None and art['invalid'] is None)
            for width,height,touch in [(1280,840,False),(812,375,True),(844,390,True),(915,412,True),(932,430,True),(1280,840,False)]:
                page.set_viewport_size({'width':width,'height':height})
                if touch:page.touchscreen.tap(width/2,200)
                else:page.keyboard.press('Shift')
                advance(page,1/60)
                row=page.evaluate(LAYOUT);report['layouts'].append(row)
                tag=str(width)+'x'+str(height)+(' touch' if touch else ' mouse')
                check(tag+' 两技能有图标名称和可访问按钮',len(row['skills'])==2 and all(s['tag']=='BUTTON' and s['name'] and 'skill-' in (s['art'] or '') and s['label'] for s in row['skills']),row['skills'])
                check(tag+' 技能与必杀触控目标不小于44像素',all(s['w']>=44 and s['h']>=44 for s in row['skills']) and row['gauge']['h']>=44 and row['gauge']['w']>=44,row['gauge'])
                check(tag+' 无横向溢出或战斗控件重叠',row['scroll']<=width and not row['overlaps'],row)
                check(tag+' 触控模式与真实输入一致',row['touch']==touch)
                page.screenshot(path=str(OUT/(str(width)+'x'+str(height)+('-touch' if touch else '-mouse')+'.png')))
            for width,height in [(375,812),(390,844),(412,915),(430,932)]:
                page.set_viewport_size({'width':width,'height':height})
                page.locator('#landscape-guard').wait_for(state='visible')
                check(str(width)+' 触屏竖屏暂停并保留横屏与备份入口',
                      page.evaluate('kirafanRL.world.frozen') and page.locator('#landscape-fullscreen').is_visible()
                      and page.locator('#save-status-open').is_visible())
            page.set_viewport_size({'width':1280,'height':840});page.locator('#landscape-guard').wait_for(state='hidden')
            advance(page,1/60)
            page.evaluate("""()=>{const k=kirafanRL,w=k.world,p=w.player,art=w.encounter.mobs[0];
                w.spawnEnemy({x:p.x+4,y:p.y,hp:1000000,atk:1,def:0,mdef:0,model:art.model,nameZh:art.nameZh,shadowScale:art.shadowScale}).actionTimer=1e9;
                p.iframes=1000;p.hp=Math.max(1,Math.floor(p.maxHp/2));p.skills.slots.slice(1).forEach(s=>s.remaining=0);}""")
            advance(page,1/60)
            page.locator('.hud-skill[data-slot="1"]').click();advance(page,1/60)
            check('桌面鼠标点击技能进入真实冷却',page.evaluate('kirafanRL.world.player.skills.slots[1].remaining>0'))
            advance(page,.8)
            page.locator('.hud-skill[data-slot="2"]').focus();page.keyboard.press('Enter');advance(page,1/60)
            check('焦点按钮Enter激活技能且不漏到全局操作',page.evaluate('kirafanRL.world.player.skills.slots[2].remaining>0 && !kirafanRL.input.state.dodge'))
            page.evaluate('kirafanRL.world.player.skills.addGauge(10000)');advance(page,1/60)
            check('满量能显示明确就绪与技能名',page.locator('.hud-gauge-readout').inner_text()=='就绪' and bool(page.locator('.hud-gauge-name').inner_text()))
            page.screenshot(path=str(OUT/'cooldown-ready.png'))
            context.close();browser.close()
        check('无未捕获页面异常',not report['errors'],report['errors'])
    finally:
        server.shutdown();worker.join(timeout=5);server.server_close()
        report['source_after']=fingerprints()
        report['changed_during_run']=[f for f in report['source_before'] if report['source_before'][f]!=report['source_after'][f]]
        (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    return int(any(not x['ok'] for x in report['checks']))

if __name__=='__main__':raise SystemExit(main())
