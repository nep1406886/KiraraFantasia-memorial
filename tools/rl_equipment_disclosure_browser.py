"""Equipment brief/detail disclosure with real keyboard and touch input.

A named ground candidate and room seed isolate UI behavior; no direct equip.
DOM scrolling checks layout, not touch scrolling performance.
"""
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import ready, advance
from rl_gadget_contract_browser import offer_drop
from rl_decisions_browser import frame_fits

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.codex-tmp/feedback-20260910/equipment-disclosure'
FILES = ['site/game/rl/' + name for name in ['world.js', 'equipment.js', 'skills.js', 'gadgets.js',
    'main.js', 'ui/decisions.js', 'ui/equipmentbrief.js', 'ui/equipmentskills.js', 'ui/theme.css']]


def fingerprints():
    return {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in FILES}


def snapshot(page):
    return page.evaluate('''()=>{const w=kirafanRL.world,p=w.player;
        return JSON.stringify({items:p.equipment,skills:p.skills.describeLoadout(),gauge:p.skills.gauge,
            hp:p.hp,coin:w.coin,profile:localStorage.getItem('kirafan-rl:profile')});}''')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'checks': [], 'errors': [], 'layouts': [], 'before': fingerprints(), 'complete': False,
              'fixtures': ['正常选角', '固定第13层种子', '指定地面缚技罗盘候选', '无敌', '手动固定步长']}

    def check(label, ok, detail=None):
        report['checks'].append({'label': label, 'ok': bool(ok), 'detail': detail})
        print(('PASS ' if ok else 'FAIL ') + label, flush=True)
        if not ok:
            raise AssertionError(label + ': ' + str(detail))

    server = Server(('127.0.0.1', 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1280, 'height': 840}, has_touch=True)
            context.add_init_script('''window.requestAnimationFrame=()=>0;window.cancelAnimationFrame=()=>{};
                localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));''')
            page = context.new_page()
            page.on('pageerror', lambda error: report['errors'].append(str(error)))
            try:
                page.goto('http://127.0.0.1:%d/site/game/roguelike.html?volume=1&floor=13&seed=176'
                          % server.server_address[1], wait_until='load', timeout=60000)
                page.locator('.roster-card').filter(has=page.locator('img[src$="/22002001.webp"]')).click(timeout=60000)
                ready(page)
                item = {'slot': 'armor', 'rarity': 'epic', 'gadgetId': 'binding', 'sealedSlot': 2, 'affixes': []}
                offer_drop(page, item)
                dialog = page.locator('#rl-equipment-choice')
                details = dialog.locator('.equipment-more')
                toggle = details.locator(':scope > summary')
                expected_skill = page.evaluate('kirafanRL.world.player.skills.slots[2].name')
                baseline = snapshot(page)
                page.wait_for_function("document.querySelector('.comparison-summary-icon')?.naturalWidth>0", polling=50, timeout=10000)
                check('原图和候选身份加载，尚未装备或封印',
                      '缚技罗盘' in dialog.locator('.comparison-summary-name').inner_text()
                      and page.evaluate('kirafanRL.world.player.equipment.length===0&&!kirafanRL.world.player.skills.isSealed(2)'))

                for width, height in [(1280, 840), (844, 390), (568, 320)]:
                    label = str(width) + 'x' + str(height)
                    page.set_viewport_size({'width': width, 'height': height})
                    page.wait_for_function('!document.body.classList.contains("landscape-required")', polling=50, timeout=10000)
                    check(label + ' 默认简述公开技能封印，不要求先展开',
                          details.get_attribute('open') is None
                          and expected_skill in dialog.locator('.equipment-brief-cost').inner_text()
                          and '被封印' in dialog.locator('.equipment-brief-cost').inner_text()
                          and not dialog.locator('.equipment-skill-comparison').is_visible())
                    check(label + ' 简述、图标与两个44像素操作目标均在视口内',
                          frame_fits(page, '#rl-equipment-choice')
                          and all(frame_fits(page, selector) and page.locator(selector).bounding_box()['height'] >= 44
                                  for selector in ['#equipment-confirm', '#equipment-keep']))
                    page.wait_for_timeout(180)
                    page.screenshot(path=str(OUT / ('brief-' + label + '.png')))

                    toggle.focus()
                    page.keyboard.press('Enter')
                    page.wait_for_function("document.querySelector('.equipment-more')?.open && document.querySelector('.equipment-more > summary')?.textContent==='收起详情'", polling=50, timeout=5000)
                    check(label + ' 键盘展开可读完整来源与封印区别',
                          dialog.locator('.equipment-skill-comparison').is_visible()
                          and dialog.locator('.equipment-skill-change[data-change="seal"]').count() == 1
                          and '角色原技能' in dialog.locator('.equipment-skill-source').first.inner_text())
                    metrics = dialog.evaluate('''el=>{const scroll=el.querySelector('.comparison-scroll'),
                        identity=el.querySelector('.comparison-summary').getBoundingClientRect();
                        const old=scroll.scrollTop;scroll.scrollTop=scroll.scrollHeight;
                        const after=el.querySelector('.comparison-summary').getBoundingClientRect();
                        const result={content:scroll.clientHeight,scrolled:scroll.scrollTop>0,
                            fixed:Math.abs(after.top-identity.top)<.5,horizontal:scroll.scrollWidth>scroll.clientWidth+1};
                        scroll.scrollTop=old;return result;}''')
                    report['layouts'].append({'viewport': [width, height], **metrics})
                    check(label + ' 展开保留100像素阅读区、固定身份和确认区',
                          metrics['content'] >= 100 and metrics['scrolled'] and metrics['fixed']
                          and not metrics['horizontal'] and frame_fits(page, '#equipment-confirm'), metrics)
                    page.screenshot(path=str(OUT / ('details-' + label + '.png')))
                    toggle.scroll_into_view_if_needed()
                    toggle.tap()
                    page.wait_for_function("!document.querySelector('.equipment-more')?.open && document.querySelector('.equipment-more > summary')?.textContent.startsWith('查看详情')", polling=50, timeout=5000)
                    check(label + ' 触控收起后恢复简述位置并保留焦点',
                          dialog.locator('.comparison-scroll').evaluate('el=>el.scrollTop===0')
                          and toggle.evaluate('el=>el===document.activeElement'))
                    check(label + ' 展开收起不改装备、冷却、量能或存档，世界仍暂停',
                          snapshot(page) == baseline and page.evaluate('kirafanRL.world.frozen'))

                page.locator('#equipment-keep').tap()
                advance(page)
                check('触控不换后候选仍可拾取，没有隐式装配或封印', page.evaluate('''()=>{const w=kirafanRL.world;
                    return w.drops.includes(contractDrop)&&contractDrop.items.length===1&&w.player.equipment.length===0
                        &&!w.player.skills.isSealed(2)&&!w.frozen;}'''))
                check('浏览器无未捕获异常', not report['errors'], report['errors'])
                check('产品指纹在核验期间不变', report['before'] == fingerprints())
                report['complete'] = True
            except BaseException as error:
                report['failure'] = str(error)
                if not page.is_closed():
                    page.screenshot(path=str(OUT / 'failure.png'))
                raise
            finally:
                browser.close()
    finally:
        report['after'] = fingerprints()
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


if __name__ == '__main__':
    main()
