"""Real HUD inputs, layout, quiet DOM and reduced-motion checks; not an FPS benchmark."""
import argparse
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss, press
from rl_persistence_browser import inject_quota

ROOT = Path(__file__).resolve().parents[1]
FILES = ['site/game/roguelike.html', 'site/game/rl/main.js', 'site/game/rl/ui/hud.js',
         'site/game/rl/ui/storage.js', 'site/game/rl/ui/theme.css', 'site/game/rl/view/battleindicators.js',
         'site/game/rl/ui/orientation.js', 'site/game/rl/ui/skilltooltip.js',
         'site/game/rl/input.js', 'site/game/rl/world.js', 'site/game/rl/ui/decisions.js',
         'site/core/skillstage.js', 'site/core/uniqueskill.js']


def fingerprints():
    return {f: hashlib.sha256((ROOT / f).read_bytes()).hexdigest() for f in FILES}


LAYOUT = """() => {
    const selectors=['#save-status','#hud','#minimap','.hud-skillbar','.hud-gauge',
        '.touch-attack','.touch-dodge','.touch-interact','.hud-pause'];
    const areas=selectors.map(s=>{const n=document.querySelector(s),r=n.getBoundingClientRect();
        return {s,x:r.x,y:r.y,w:r.width,h:r.height,visible:getComputedStyle(n).visibility==='visible'};})
        .filter(a=>a.w&&a.h&&a.visible),overlaps=[];
    for(let i=0;i<areas.length;i++)for(let j=i+1;j<areas.length;j++){
        const a=areas[i],b=areas[j];
        if(a.s==='#save-status'||b.s==='#save-status')continue;
        if(a.x<b.x+b.w-1&&b.x<a.x+a.w-1&&a.y<b.y+b.h-1&&b.y<a.y+a.h-1)overlaps.push([a.s,b.s]);
    }
    return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,areas,overlaps,
        fits:areas.every(a=>a.x>=0&&a.y>=0&&a.x+a.w<=innerWidth+1&&a.y+a.h<=innerHeight+1),
        touch:document.body.classList.contains('touch-on')};
}"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--out', type=Path, help='Write this run to an isolated report directory')
    args = parser.parse_args()
    out = args.out.resolve() if args.out else ROOT / '.codex-tmp/ui-polish' / ('baseline' if args.baseline else 'current')
    out.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'layouts': [], 'errors': [], 'source_before': fingerprints()}

    def check(label, ok, detail=None):
        report['checks'].append({'label': label, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        if not ok:
            raise AssertionError(label + ': ' + str(detail))

    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    base = 'http://127.0.0.1:%d' % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1280, 'height': 840}, has_touch=True)
            context.add_init_script("""window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
                if(!localStorage.getItem('kirafan-rl:profile')) localStorage.setItem('kirafan-rl:meta',
                    JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
            page = context.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.goto(base + '/site/game/roguelike.html?volume=1&seed=10926', wait_until='load', timeout=60000)
            page.locator('.roster-card').filter(has=page.locator('img[src$="/32002001.webp"]')).click(timeout=60000)
            page.wait_for_function('kirafanRL?.world?.player && kirafanRL.pending===0', polling=50, timeout=60000)
            dismiss(page); advance(page, 2.2)
            report['capsule'] = page.evaluate("""()=>{const n=document.querySelector('#tutorial-hint');
                if(!n)return null;const r=n.getBoundingClientRect(),s=getComputedStyle(n);
                return {text:n.textContent,display:s.display,width:r.width,height:r.height,x:r.x,y:r.y};}""")
            report['idle_mutations'] = page.evaluate("""()=>{
                const observer=new MutationObserver(()=>{});
                for(const s of ['#hud','.hud-skillbar','.hud-gauge','#status'])
                    observer.observe(document.querySelector(s),{subtree:true,attributes:true,childList:true,characterData:true});
                for(let i=0;i<60;i++)kirafanRL.step(0);
                const records=observer.takeRecords(),counts={};observer.disconnect();
                for(const r of records){const key=r.target.id||r.target.className||r.target.nodeName;
                    counts[key]=(counts[key]||0)+1;}
                return {total:records.length,counts};}""")
            if not args.baseline:
                check('废弃教学胶囊节点已移除', report['capsule'] is None, report['capsule'])
                check('顶部只保留一组信息，正常冒险不显示调试行',
                      page.evaluate("document.querySelector('#save-status').contains(document.querySelector('#bar'))")
                      and not page.locator('#status').is_visible())
                check('空提示与未就绪目标不再遮挡场景', not page.locator('#hint').is_visible()
                      and page.locator('.target-summary,.ultimate-target').count() == 0)
                check('相同战斗状态60次更新不重复写入HUD DOM', report['idle_mutations']['total'] == 0,
                      report['idle_mutations'])
            layouts = [(1280,840,False),(844,640,False),(812,375,True),(844,390,True),
                       (915,412,True),(932,430,True),(1024,768,True)]
            for width, height, touch in layouts:
                page.set_viewport_size({'width': width, 'height': height})
                if touch: page.touchscreen.tap(width / 2, height / 2)
                else: page.keyboard.press('Shift')
                advance(page, 1 / 60); page.wait_for_timeout(220)
                row = page.evaluate(LAYOUT); report['layouts'].append(row)
                tag = '%sx%s' % (width, height)
                if not args.baseline:
                    check(tag + ' 无溢出、重叠且输入模式正确', row['fits'] and not row['overlaps']
                          and row['scroll'] <= width and row['touch'] == touch, row)
                    sizes = page.locator('.hud-skill:not(.hud-hidden),.hud-gauge,.hud-pause').evaluate_all(
                        '(ns)=>ns.map(n=>{const r=n.getBoundingClientRect();return {w:r.width,h:r.height};})')
                    check(tag + ' 所有主要动作目标至少44像素', all(r['w'] >= 44 and r['h'] >= 44 for r in sizes), sizes)
                page.screenshot(path=str(out / (tag + '.png')))
            if args.baseline:
                print('BASELINE ' + json.dumps({'capsule': report['capsule'], 'idle': report['idle_mutations']}, ensure_ascii=False), flush=True)
                return 0

            page.set_viewport_size({'width': 1280, 'height': 840}); page.keyboard.press('Shift'); advance(page, 1/60)
            page.locator('.hud-pause').focus(); page.keyboard.press('Enter'); advance(page, 1/60)
            check('键盘菜单入口即时暂停世界', page.locator('#menu-panel').is_visible() and page.evaluate('kirafanRL.world.frozen'))
            page.screenshot(path=str(out / 'menu-desktop.png'))
            page.locator('#menu-resume').click(); advance(page, 1/60)
            check('继续按钮即时恢复且不误触战斗', not page.evaluate('kirafanRL.world.frozen || kirafanRL.input.state.attack || kirafanRL.input.state.dodge'))
            page.evaluate("""()=>{const w=kirafanRL.world,p=w.player,s=w.encounter.mobs[0];
                w.spawnEnemy({x:p.x+4,y:p.y,hp:1000000,atk:0,def:0,mdef:0,model:s.model,nameZh:s.nameZh}).actionTimer=1e9;
                p.iframes=1000;p.skills.slots.slice(1).forEach(s=>s.remaining=0);}""")
            advance(page, 1/60)
            page.locator('.hud-skill[data-slot="1"]').click(); advance(page, 1/60)
            check('鼠标短按锁存到真实技能结算', page.evaluate('kirafanRL.world.player.skills.slots[1].remaining>0'))
            advance(page, .8); page.locator('.hud-skill[data-slot="2"]').focus(); page.keyboard.press('Space'); advance(page, 1/60)
            check('空格激活聚焦技能且不穿透为闪避', page.evaluate('kirafanRL.world.player.skills.slots[2].remaining>0 && !kirafanRL.input.state.dodge'))
            page.screenshot(path=str(out / 'cooldown.png'))
            advance(page, .8); page.evaluate('kirafanRL.world.player.skills.addGauge(10000)'); advance(page, 1/60)
            check('必杀就绪时显示真实目标而不恢复冗余浮框', page.locator('.ultimate-target').count() > 0
                  and page.locator('.target-summary').count() == 0 and page.locator('.hud-gauge-readout').inner_text() == '就绪')
            page.screenshot(path=str(out / 'ultimate-ready.png'))
            page.set_viewport_size({'width': 844, 'height': 390}); page.touchscreen.tap(400,230); advance(page, 1/60)
            before = page.evaluate('kirafanRL.world.player.swingId')
            page.locator('.touch-attack').tap(); advance(page, 1/60)
            check('短于一帧的触控普攻不丢失', page.evaluate('kirafanRL.world.player.swingId') > before)
            advance(page, .8)
            page.locator('.hud-pause').tap(); advance(page, 1/60)
            menu = page.locator('#menu-panel').bounding_box()
            check('手机菜单在可视区域内滚动', menu['x'] >= 0 and menu['y'] >= 0
                  and menu['x']+menu['width'] <= 845 and menu['y']+menu['height'] <= 391, menu)
            page.screenshot(path=str(out / 'menu-mobile.png')); page.locator('#menu-resume').click(); advance(page, 1/60)
            page.emulate_media(reduced_motion='reduce')
            motion = page.locator('.hud-gauge-fill,.hud-skill,.hud-pause').evaluate_all("""ns=>ns.map(n=>{
                const s=getComputedStyle(n);return {transition:s.transitionDuration,animation:s.animationName};})""")
            check('减少动态效果关闭界面缓动', all(all(float(x.strip().rstrip('s')) <= .01 for x in r['transition'].split(','))
                  and r['animation'] == 'none' for r in motion), motion)
            page.screenshot(path=str(out / 'reduced-motion.png'))
            inject_quota(page)
            page.locator('.hud-pause').tap(); advance(page, 1/60)
            page.locator('#menu-cam').focus(); page.keyboard.press('ArrowRight')
            page.wait_for_selector('#save-status[data-state="unsaved"]')
            page.set_viewport_size({'width': 390, 'height': 844})
            check('窄屏保存失败告警和重试入口仍可见', page.locator('#save-status-message').is_visible()
                  and '未保存' in page.locator('#save-status-message').inner_text() and page.locator('#save-status-retry').is_visible())
            page.screenshot(path=str(out / 'save-warning-mobile.png'))
            page.evaluate('window.blockWrites=false'); page.locator('#save-status-retry').click()
            page.wait_for_selector('#save-status[data-state="saved"]')
            check('保存重试成功后焦点转到保留的备份入口', page.locator('#save-status-open').evaluate('n=>n===document.activeElement'))
            page.set_viewport_size({'width': 1280, 'height': 840})
            page.goto(base + '/site/game/roguelike.html?volume=1&seed=10926&debug=1', wait_until='load', timeout=60000)
            page.locator('#roster-continue').click(timeout=60000)
            page.wait_for_function('kirafanRL?.world?.player && kirafanRL.pending===0', polling=50, timeout=60000)
            dismiss(page); advance(page, 1/60)
            check('显式调试模式保留诊断读数', page.locator('#status').is_visible() and 'HP ' in page.locator('#status').inner_text())
            check('无未处理页面异常', not report['errors'], report['errors'])
            context.close(); browser.close()
    except Exception:
        if 'page' in locals() and not page.is_closed():
            try: page.screenshot(path=str(out / 'failure.png'), timeout=10000)
            except Exception: pass
        raise
    finally:
        report['source_after'] = fingerprints()
        report['changed_during_run'] = [f for f in FILES if report['source_before'][f] != report['source_after'][f]]
        (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
        server.shutdown(); worker.join(timeout=5); server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
