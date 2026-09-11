"""T30: six current cards, real input, recovery HUD and a served-code negative control.

Serial port-0 browser contexts; manual simulation is not a performance measurement.
"""
import argparse
import functools
import hashlib
import json
import math
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_floor_loot_browser import ready

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "t30-recovery"
CASES = [(36002001, 2, 23 / 17), (41002001, 1, 1 / .7),
         (32022001, 2, 1 / .85), (32172001, 1, 1 / .62),
         (27002001, 0, 1 / .7), (23002001, 0, 1 / .62)]
checks = []
FILES = ['site/game/rl/' + name for name in ['skills.js', 'world.js', 'main.js', 'input.js',
    'ui/hud.js', 'ui/infocard.js', 'ui/theme.css', 'ui/skilltooltip.js']]


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def check(label, condition, detail=None):
    if not condition:
        raise AssertionError(label + ": " + str(detail))
    checks.append(label)
    print("PASS " + label, flush=True)


def advance(page, seconds):
    page.evaluate("""seconds => {
        const k=window.kirafanRL;
        for(let left=seconds;left>1e-9;left-=1/60) k.step(Math.min(1/60,left));
    }""", seconds)


def press(page, key):
    page.keyboard.down(key)
    advance(page, 1 / 60)
    page.keyboard.up(key)
    advance(page, 1 / 60)


def dismiss(page):
    for _ in range(60):
        if not page.locator("#dialogue-box").is_visible():
            return
        page.locator("#dialogue-skip").click()
        page.wait_for_timeout(30)
    raise AssertionError("dialogue did not close")


def state(page, slot):
    return page.evaluate("""slot => {
        const w=window.kirafanRL.world,s=w.player.skills;
        return {time:w.time,work:s.slots[slot].remaining,seconds:s.cooldownSeconds(slot),
            rate:s.cooldownRate,buffs:s.buffs,move:w.player.speed,gauge:s.gauge,frozen:w.frozen};
    }""", slot)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--only", type=int)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    errors, measured = [], []
    report = {'checks': checks, 'errors': errors, 'measured': measured, 'before': fingerprints(),
              'manualSimulation': True, 'probe': args.probe, 'complete': False,
              'fixtures': ['静止高生命敌人', '玩家无敌用于输入和冷却核验', '必杀量能填满用于验证入口']}
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                               "--autoplay-policy=no-user-gesture-required"])
            version = browser.version
            report['browser'] = version
            selected = [row for row in CASES if not args.only or row[0] == args.only]
            if args.probe:
                selected = CASES[:1]
            assert selected, "unknown requested card"
            for card_id, speed_slot, rate in selected:
                context = browser.new_context(viewport={"width": 1280, "height": 840}, has_touch=True)
                # Only the simulation rAF is held; browser layout/CSS remain real.
                context.add_init_script("""window.requestAnimationFrame=()=>0;
                    window.cancelAnimationFrame=()=>{};
                    localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                if args.probe:
                    source = (ROOT / "site/game/rl/skills.js").read_text(encoding="utf-8")
                    needle = "const recovered = convertCooldown(buffs, dt, false);"
                    assert source.count(needle) == 1
                    page.route("**/rl/skills.js", lambda route: route.fulfill(content_type="text/javascript",
                        body="window.__recoveryProbeLoaded=true;\n" + source.replace(needle, "const recovered = dt;")))
                page.goto(base + "/site/game/roguelike.html?volume=1&seed=300908", wait_until="load", timeout=60000)
                page.wait_for_selector(".roster-card", timeout=60000)
                card_node = page.locator(".roster-card").filter(has=page.locator('img[src$="/%d.webp"]' % card_id))
                check(str(card_id) + " 正常选角卡片唯一可达", card_node.count() == 1)
                card_node.click()
                ready(page)
                check(str(card_id) + " 保留实际进化卡身份", page.evaluate("window.kirafanRL.world.player.card.id") == card_id)
                page.evaluate("""() => {
                    const k=window.kirafanRL,w=k.world,p=w.player,art=w.encounter.mobs[0];
                    w.spawnEnemy({x:p.x+4,y:p.y,hp:1000000,atk:1,def:0,mdef:0,
                        model:art.model,nameZh:art.nameZh,shadowScale:art.shadowScale}).actionTimer=1e9;
                    p.iframes=1000;
                }""")
                ready(page)
                other = 2 if speed_slot == 1 else 1
                press(page, "Digit" + str(other + 1))
                advance(page, .45)
                check(str(card_id) + " 先从输入启动普通技能冷却", state(page, other)["work"] > 0, state(page, other))
                if speed_slot == 0:
                    page.evaluate("""() => {
                        const s=window.kirafanRL.world.player.skills,spend=s.spendUltimate;
                        window.__recoverySpends=[];
                        s.spendUltimate=function(){
                            const accepted=spend();
                            if(accepted) window.__recoverySpends.push(s.gauge);
                            return accepted;
                        };
                        s.addGauge(1e9);
                    }""")
                    press(page, "KeyR")
                    page.wait_for_function("!window.kirafanRL.ultimate.loading", polling=100, timeout=60000)
                    if page.locator(".rl-ultimate-skip").is_visible():
                        page.locator(".rl-ultimate-skip").click()
                    advance(page, .45)
                else:
                    press(page, "Digit" + str(speed_slot + 1))
                before = state(page, other)
                check(str(card_id) + " 真实施放产生设计倍率", abs(before["rate"] - rate) < 1e-8, before)
                check(str(card_id) + " 状态提示说明技能恢复而非跑速", "技能恢复 ×" in page.locator(".hud-effects").inner_text())
                advance(page, 1)
                after = state(page, other)
                expected = max(0, before["work"] - (after["time"] - before["time"]) * rate)
                if args.probe:
                    check("负面对照确实替换了恢复实现", page.evaluate("window.__recoveryProbeLoaded===true"))
                check(str(card_id) + " 剩余冷却按真实倍率恢复", abs(after["work"] - expected) < 1e-7, [expected, after])
                if not args.probe:
                    displayed = page.locator('.hud-skill[data-slot="%d"] .hud-skill-secs' % other).inner_text()
                    check(str(card_id) + " HUD秒数等于到期分段预测", displayed == (str(math.ceil(after["seconds"])) + "秒" if after["seconds"] else ""), displayed)
                    check(str(card_id) + " 移速保持3.5", after["move"] == 3.5)
                    if speed_slot == 0:
                        # Earlier ordinary projectiles may legally refill the
                        # gauge afterwards. Observe the accepted debit itself.
                        check(str(card_id) + " 必杀量能只消费一次", page.evaluate("window.__recoverySpends") == [0])
                    press(page, "Escape")
                    frozen = state(page, other)
                    advance(page, 1)
                    check(str(card_id) + " 菜单冻结冷却和增益", state(page, other) == frozen)
                    page.locator("#menu-skills").click()
                    words = page.locator("#rl-skillcard").inner_text()
                    check(str(card_id) + " 人物卡披露新规则和上限", "技能恢复速度" in words and "0.5–2倍" in words and "不改变移动" in words)
                    if card_id == 36002001:
                        for width in (375, 390, 412, 430, 768, 1280):
                            page.set_viewport_size({"width": width, "height": 812 if width < 500 else 840})
                            fits = page.evaluate("""() => {
                                const w=document.documentElement.clientWidth,s=document.querySelector('#rl-skillcard .sheet').getBoundingClientRect();
                                const b=document.querySelector('#rl-skillcard .close-row button').getBoundingClientRect();
                                return document.documentElement.scrollWidth<=w+1 && s.left>=0 && s.right<=w+1 && b.bottom<=innerHeight && b.left>=0;
                            }""")
                            check("恢复说明六宽度适配 " + str(width), fits)
                            if width in (375, 1280):
                                page.screenshot(path=str(OUT / ("recovery-sheet-%d.png" % width)))
                        page.locator("#rl-skillcard .close-row button").click()
                        page.locator("#menu-resume").click()
                        advance(page, 12)
                        page.set_viewport_size({"width": 844, "height": 390})
                        page.locator('#landscape-guard').wait_for(state='hidden')
                        advance(page, .5)
                        # Keyboard input intentionally selects desktop mode. A
                        # real first touch switches HUD hit targets back on.
                        page.touchscreen.tap(400, 100)
                        check("首次真实触摸恢复触控模式", page.locator("body").evaluate("node=>node.classList.contains('touch-on')"))
                        page.locator('.hud-skill[data-slot="2"]').tap()
                        advance(page, .1)
                        check("晴海触控技能产生双目标叠加恢复", abs(state(page, 2)["rate"] - 23 / 17) < 1e-8)
                        for width, height in ((812, 375), (844, 390), (915, 412), (932, 430), (1024, 768), (1280, 840)):
                            page.set_viewport_size({"width": width, "height": height})
                            page.wait_for_function("""() => {
                                const h=document.querySelector('#hud').getBoundingClientRect(),
                                    m=document.querySelector('#minimap').getBoundingClientRect(),
                                    p=document.querySelector('.hud-pause').getBoundingClientRect(),
                                    e=document.querySelector('.hud-effects').getBoundingClientRect();
                                const apart=(a,b)=>a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top;
                                return apart(h,m)&&apart(h,p)&&apart(m,p)&&e.left>=h.left&&e.right<=h.right
                                    &&p.top>=0&&p.bottom<=innerHeight&&p.left>=0&&p.right<=innerWidth
                                    &&p.width>=44&&p.height>=44&&document.documentElement.scrollWidth<=innerWidth;
                            }""", polling=100)
                            check("状态、小地图和暂停键无重叠 " + str(width) + 'x' + str(height), True)
                            if width in (844, 1280):
                                page.screenshot(path=str(OUT / ("recovery-hud-%dx%d.png" % (width, height))))
                        for width, height in ((375, 812), (390, 844), (412, 915), (430, 932)):
                            page.set_viewport_size({'width': width, 'height': height})
                            page.locator('#landscape-guard').wait_for(state='visible')
                            frozen = state(page, 2); advance(page, .5)
                            check(str(width) + ' 触屏竖屏冻结冷却并保留横屏/备份入口', frozen == state(page, 2)
                                  and page.locator('#landscape-fullscreen').is_visible()
                                  and page.locator('#save-status-open').is_visible())
                    measured.append({"cardId": card_id, "before": before, "after": after})
                context.close()
            check("没有浏览器脚本异常", not errors, errors)
            check('验证期间产品源码不变', report['before'] == fingerprints())
            browser.close()
            report['complete'] = True
            print("Recovery browser: %d checks passed" % len(checks), flush=True)
    except Exception as error:
        report['failure'] = str(error)
        raise
    finally:
        report['after'] = fingerprints()
        name = "browser-probe.json" if args.probe else "browser.json"
        (OUT / name).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


if __name__ == "__main__":
    main()
