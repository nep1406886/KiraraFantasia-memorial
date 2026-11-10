"""Real hover/focus regression. Mobile rotation and touch are covered by adventure_viewports_browser.py."""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss, press
from rl_ui_polish_browser import fingerprints

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/ui-polish/interaction'
INIT = """window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
    if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',
        JSON.stringify({prologueSeen:true,tutorialSeen:true}));"""


def settled(page, touch=False):
    page.wait_for_function('kirafanRL?.world?.player && kirafanRL.pending===0', polling=50, timeout=60000)
    if touch:
        for _ in range(60):
            if not page.locator('#dialogue-box').is_visible(): break
            page.locator('#dialogue-skip').tap(); page.wait_for_timeout(30)
    else:
        dismiss(page)
    advance(page, 2)
    page.wait_for_function('!!kirafanRL.mapview.group?.userData.placements && kirafanRL.interactPending===0', polling=50, timeout=60000)
    page.wait_for_function('kirafanRL.pending===0&&!kirafanRL.roomLoading&&!kirafanRL.world.frozen', polling=50, timeout=60000)
    advance(page, 1/60)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'source_before': fingerprints()}

    def check(label, ok, detail=None):
        report['checks'].append({'label': label, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        if not ok: raise AssertionError(label + ': ' + str(detail))

    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    url = 'http://127.0.0.1:%d/site/game/roguelike.html?volume=1&seed=10926' % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            desktop = browser.new_context(viewport={'width':1280,'height':840})
            desktop.add_init_script(INIT)
            page = desktop.new_page(); page.on('pageerror', lambda e: report['errors'].append(str(e)))
            page.goto(url, wait_until='load', timeout=60000)
            page.locator('.roster-card[data-card-id="32002001"]').click(timeout=60000)
            page.locator('#roster-start').click()
            settled(page)
            page.locator('.hud-skill[data-slot="1"]').hover()
            tip = page.locator('.hud-skill-tooltip')
            tip.wait_for(state='visible')
            expected = page.evaluate("""()=>{const s=kirafanRL.world.player.skills.slots[1];
                return {name:s.name,cooldown:Number(s.cooldown.toFixed(1)),heal:s.heal,buffs:s.buffs};}""")
            content = tip.inner_text()
            check('鼠标悬停显示技能名称、真实目标与基础冷却', expected['name'] in content and '技能 2' in content
                  and ('基础冷却 %s 秒' % expected['cooldown']) in content, content)
            check('悬停有中文效果简述而非只显示技能名', tip.locator('li').count() > 0
                  and any(k in content for k in ['回复','物攻','魔攻','护盾','伤害','恢复']), content)
            check('悬停不施放、不暂停且有可访问说明关联', page.evaluate("""()=>{
                const w=kirafanRL.world,i=kirafanRL.input.state,n=document.querySelector('.hud-skill[data-slot="1"]');
                return !w.frozen&&!i.attack&&!i.skill.some(Boolean)&&!i.ultimate&&!!n.getAttribute('aria-describedby');}"""))
            page.screenshot(path=str(OUT / 'skill-hover.png'))
            tip.hover(); page.wait_for_timeout(200)
            check('指针可移入说明卡阅读而不闪退', tip.is_visible())
            press(page, 'Escape'); advance(page, 1/60)
            check('Escape只收起说明而不打开菜单', not tip.is_visible() and not page.locator('#menu-panel').is_visible())
            page.mouse.move(600,300); page.keyboard.press('Tab')
            page.locator('.hud-skill[data-slot="2"]').focus()
            tip.wait_for(state='visible')
            check('键盘聚焦可查看第二个普通技能', '技能 3' in tip.inner_text())
            page.keyboard.press('Space'); advance(page, 1/60)
            check('查看说明后仍能空格施放且不触发闪避', page.evaluate('kirafanRL.world.player.skills.slots[2].remaining>0&&!kirafanRL.input.state.dodge'))
            press(page, 'Escape'); page.mouse.move(600,300)
            page.locator('.hud-skill[data-slot="2"]').hover(); tip.wait_for(state='visible')
            check('冷却中的按钮仍可悬停查看剩余秒数', '剩余 ' in tip.inner_text(), tip.inner_text())
            page.mouse.move(600,300); page.locator('.hud-gauge').hover(); tip.wait_for(state='visible')
            check('必杀悬停说明同时显示目标、效果和量能', 'R / 1' in tip.inner_text()
                  and '量能 ' in tip.inner_text() and tip.locator('li').count()>0, tip.inner_text())
            page.screenshot(path=str(OUT / 'ultimate-hover.png'))
            page.set_viewport_size({'width':390,'height':844}); advance(page, 1/60)
            check('桌面窄窗口不会误触发手机横屏限制', not page.locator('#landscape-guard').is_visible())
            page.mouse.move(180,250); page.locator('.hud-gauge').hover(); tip.wait_for(state='visible')
            bounds = tip.bounding_box()
            check('窄窗口说明卡不越过屏幕边界', bounds['x']>=0 and bounds['y']>=0
                  and bounds['x']+bounds['width']<=391 and bounds['y']+bounds['height']<=845, bounds)
            page.screenshot(path=str(OUT / 'narrow-desktop-tooltip.png'))
            # A closing overlay can expose a skill under a stationary pointer.
            # Browser-generated boundary events are not a request to read it.
            page.mouse.move(200,250); page.wait_for_timeout(180)
            page.evaluate("""()=>{const n=document.createElement('div');n.id='hover-hit-test-shield';
                n.style.cssText='position:fixed;inset:0;z-index:100000';document.body.appendChild(n);}""")
            anchor=page.locator('.hud-skill[data-slot="1"]').bounding_box()
            page.mouse.move(anchor['x']+anchor['width']/2,anchor['y']+anchor['height']/2)
            page.evaluate("document.getElementById('hover-hit-test-shield').remove()")
            page.wait_for_timeout(180)
            check('覆盖层消失不让静止鼠标自动弹技能卡（命中测试夹具）',not tip.is_visible())
            # Simulation rAF is held: step while Escape is down so the real
            # input edge is sampled, rather than testing an already-released key.
            press(page, 'Escape');advance(page,1/60)
            check('覆盖层消失后的第一次Escape仍可打开菜单',page.locator('#menu-panel').is_visible())
            page.locator('#menu-resume').click();advance(page,1/60)
            page.mouse.move(200,250);page.locator('.hud-skill[data-slot="1"]').hover()
            tip.wait_for(state='visible');press(page, 'Escape');advance(page,1/60)
            page.mouse.move(anchor['x']+anchor['width']/2+2,anchor['y']+anchor['height']/2)
            check('Escape关闭后在同一按钮内轻微移动不会立刻重开',not tip.is_visible())
            desktop.close()

            browser.close()
        check('全部交互无未处理异常', not report['errors'], report['errors'])
    finally:
        report['source_after'] = fingerprints()
        report['changed_during_run'] = [f for f in report['source_before'] if report['source_before'][f] != report['source_after'][f]]
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
        server.shutdown(); worker.join(timeout=5); server.server_close()


if __name__ == '__main__': main()
