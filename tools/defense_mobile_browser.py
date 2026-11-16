"""Exercise real touch scrolling, deployment and equipment at narrow viewports.

The funded setup only prepares models and removes cooldown waits. All gestures,
cell picking, confirmation, equipment and responsive layout paths remain real.
"""
import functools
import json
import sys
import threading
from pathlib import Path
from playwright.sync_api import sync_playwright
from serve import Server, NoCacheHandler

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/defense-mobile'
SIZES = [(390, 844), (320, 568), (844, 390), (568, 320), (768, 1024), (960, 600), (1440, 900)]

SETUP = """async () => {
    const c=__defense.campaign;
    c.save.deck=['F01','U01','U02','U03','U04','U05','U06','F13'];
    await c.startLevel('endless',{skipCache:true});
    c.closeDialog('brief-dialog','brief');
    const v=c.view,b=v.battle;b.resource=5000;
    for(const [id,row,col] of [['U01',1,1],['U02',2,1],['U03',3,1],['U04',4,1]]) {
        await v.select(id); const result=await v.deployCell(row,col);
        if(!result.ok)throw new Error(result.reason);
    }
    for(const u of b.units.values())u.hp*=.75;
    b.readyAt.clear();v.select(null);v.reviewStep(.1);v.notify();
}"""

REACHABLE = """el => {
    const r=el.getBoundingClientRect();
    return r.width>=30 && r.height>=35 && r.left>=0 && r.right<=innerWidth+1
        && r.top>=0 && r.bottom<=innerHeight+1
        && el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
}"""

CARD_CONTENT = """el => {
    const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();
    return r.left>=p.left-1 && r.right<=p.right+1 && r.top>=p.top-1 && r.bottom<=p.bottom+1
        && [...el.querySelectorAll('.seed-art,.seed-name,.seed-cost,.gear-chip-art,.gear-chip-name,.gear-chip-cost')]
        .every(child=>{const a=child.getBoundingClientRect();return a.width>0&&a.height>0&&a.left>=r.left-1
            &&a.right<=r.right+1&&a.top>=r.top-1&&a.bottom<=r.bottom+1;});
}"""

def gesture(page, cdp, start, end):
    cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':start[0],'y':start[1]}]})
    for step in range(1, 13):
        x=start[0]+(end[0]-start[0])*step/12
        y=start[1]+(end[1]-start[1])*step/12
        cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':x,'y':y}]})
        page.wait_for_timeout(25)
    cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
    page.wait_for_timeout(180)

def cell(page, row, col):
    return page.evaluate("""([row,col])=>{const v=__defense.campaign.view,p=v.world(row,col).project(v.stage.camera),
        r=v.stage.renderer.domElement.getBoundingClientRect();return [r.x+(p.x+1)*r.width/2,r.y+(1-p.y)*r.height/2];}""", [row,col])

def main():
    sys.stdout.reconfigure(encoding='utf-8')
    OUT.mkdir(parents=True, exist_ok=True)
    report={'checks':[],'errors':[]}
    def check(name, value):
        assert value, name
        report['checks'].append(name)
        print('PASS '+name, flush=True)
    with Server(('127.0.0.1',0), functools.partial(NoCacheHandler,directory=str(ROOT))) as server:
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(channel='msedge',headless=True,args=['--enable-unsafe-swiftshader'])
                context=browser.new_context(viewport={'width':390,'height':844},has_touch=True,is_mobile=True)
                page=context.new_page()
                page.on('pageerror',lambda error:report['errors'].append(str(error)))
                cdp=context.new_cdp_session(page)
                page.goto(f'http://127.0.0.1:{server.server_address[1]}/site/etowaria-defense/index.html?review=1')
                page.locator('#start-campaign:enabled').click(timeout=60000)
                page.wait_for_function('()=>!!window.__defense?.campaign')
                page.evaluate(SETUP)
                for width,height in SIZES:
                    page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(150)
                    check(f'页面无横向溢出 {width}×{height}',page.evaluate('document.documentElement.scrollWidth<=innerWidth'))
                    for selector in ['.seed-card','.gear-chip']:
                        for card in [page.locator(selector).first,page.locator(selector).last]:
                            card.scroll_into_view_if_needed()
                            check(f'首尾卡可触达且内容未裁切 {selector} {width}×{height}',card.evaluate(REACHABLE) and card.evaluate(CARD_CONTENT))
                    check(f'装备不与战场、操作栏重叠 {width}×{height}',page.evaluate("""()=>{
                        const g=document.querySelector('.gear-bank').getBoundingClientRect();
                        return g.height>=48&&['.battle-tools','.battle-viewport'].every(s=>{
                            const r=document.querySelector(s).getBoundingClientRect();
                            return g.right<=r.left||g.left>=r.right||g.bottom<=r.top||g.top>=r.bottom;});}"""))
                    check(f'状态条及技能条留在头顶 {width}×{height}',page.evaluate("""()=>[...__defense.campaign.view.models.values()].every(m=>{
                        const r=m.label.getBoundingClientRect(),parent=m.label.parentElement.getBoundingClientRect();
                        const head=parent.top+parseFloat(m.label.style.top);
                        return r.bottom<head&&[m.hpFill,m.skillCycle].every(e=>e.hidden||e.getBoundingClientRect().bottom<head);})"""))
                    page.locator('.seed-card').first.scroll_into_view_if_needed()
                    page.locator('.gear-chip').first.scroll_into_view_if_needed()
                    page.screenshot(path=str(OUT/f'field-{width}x{height}.png'))

                for width,height,row in [(390,844,3),(568,320,4)]:
                    page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(150)
                    bank=page.locator('.battle-bank')
                    bank.evaluate('(el)=>{el.scrollTop=0;el.scrollLeft=0;}')
                    area=bank.bounding_box();vertical=width>height
                    start=(area['x']+area['width']*.6,area['y']+area['height']*.75)
                    end=(start[0],start[1]-130) if vertical else (start[0]-120,start[1])
                    before=page.evaluate('()=>__defense.campaign.view.battle.units.size')
                    gesture(page,cdp,start,end)
                    check(f'沿卡栏滑动滚动且不误选、不部署 {width}×{height}',bank.evaluate('(el)=>el.scrollLeft>20||el.scrollTop>20') and page.evaluate('(n)=>{const v=__defense.campaign.view;return !v.selected&&v.battle.units.size===n;}',before))
                    gear=page.locator('.gear-bank');gear.evaluate('el=>el.scrollLeft=0')
                    area=gear.bounding_box();start=(area['x']+area['width']*.8,area['y']+area['height']/2)
                    gesture(page,cdp,start,(start[0]-150,start[1]))
                    check(f'装备列表可原生横滑 {width}×{height}',gear.evaluate('el=>el.scrollLeft>20'))
                    page.evaluate('()=>{const v=__defense.campaign.view;v.battle.readyAt.clear();v.notify();}')
                    seed=page.locator('.seed-card[data-card=F01]');seed.scroll_into_view_if_needed();seed.tap()
                    page.touchscreen.tap(*cell(page,row,0))
                    confirm=page.locator('[data-action=confirm-placement]')
                    check(f'部署确认、取消完整可点 {width}×{height}',confirm.evaluate(REACHABLE) and page.locator('[data-action=cancel-placement]').evaluate(REACHABLE))
                    page.screenshot(path=str(OUT/f'confirm-{width}x{height}.png'))
                    confirm.tap()
                    page.wait_for_function('(row)=>{const v=__defense.campaign.view;return !v.loading&&v.battle.occupancy.has(`${row}:0`);}',arg=row)
                    check(f'触屏确认实际部署 {width}×{height}',page.evaluate('(row)=>[...__defense.campaign.view.battle.units.values()].some(u=>u.row===row&&u.col===0&&u.type==="F01")',row))
                    host_row=2 if vertical else 1
                    gear_id=page.evaluate("""row=>{const c=__defense.campaign,v=c.view;return [...c.gearCards.keys()].find(id=>v.battle.canDeploy(id,row,1).ok);}""",host_row)
                    assert gear_id, '装备测试需要一位尚未佩戴的伙伴'
                    card=page.locator(f'.gear-chip[data-card="{gear_id}"]');card.scroll_into_view_if_needed();card.tap()
                    page.touchscreen.tap(*cell(page,host_row,1))
                    check(f'装备确认入口可见 {width}×{height}',confirm.evaluate(REACHABLE) and '确认佩戴' in confirm.inner_text())
                    confirm.tap()
                    page.wait_for_function('([id,row])=>{const v=__defense.campaign.view;return !v.loading&&[...v.battle.units.values()].some(u=>u.row===row&&u.col===1&&u.gear===id);}',arg=[gear_id,host_row])
                    check(f'装备后名称、费用和佩戴者不重叠 {width}×{height}',card.evaluate("""el=>{
                        const h=el.querySelector('.gear-chip-holder').getBoundingClientRect();
                        return ['.gear-chip-name','.gear-chip-cost'].every(s=>el.querySelector(s).getBoundingClientRect().bottom<=h.top+1);}"""))
                    page.evaluate('()=>{const v=__defense.campaign.view;v.battle.readyAt.clear();v.notify();}')
                    seed.scroll_into_view_if_needed();area=seed.bounding_box()
                    gesture(page,cdp,(area['x']+area['width']/2,area['y']+area['height']/2),cell(page,row,2))
                    page.wait_for_function('(row)=>{const v=__defense.campaign.view;return !v.loading&&v.battle.occupancy.has(`${row}:2`);}',arg=row)
                    check(f'向战场拖动仍能部署 {width}×{height}',page.evaluate('()=>!__defense.campaign.dragging'))
                    page.locator('[data-action=pause]').tap()
                    check(f'小屏暂停菜单可恢复 {width}×{height}',page.locator('[data-action=resume]').evaluate(REACHABLE))
                    page.locator('[data-action=resume]').tap()
                check('无未捕获脚本错误',not report['errors'])
                browser.close()
        finally:
            server.shutdown()
            (OUT/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__': main()
