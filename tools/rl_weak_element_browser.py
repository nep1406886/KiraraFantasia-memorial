"""T30 kind 10: real input, fixed damage oracles, and a served-code negative control.

Own port-0 server; one browser at a time. Manual simulation is not a device
performance test or a complete character/ecosystem acceptance run.
"""
import argparse
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss, press

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "t30-weak-element"
WIDTHS = (375, 390, 412, 430, 768, 1280)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    checks, errors, measurements = [], [], []

    def check(label, condition, detail=None):
        if not condition:
            raise AssertionError(label + ": " + str(detail))
        checks.append(label)
        print("PASS " + label, flush=True)

    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                               "--autoplay-policy=no-user-gesture-required"])
            version = browser.version
            context = browser.new_context(viewport={"width": 1280, "height": 840}, has_touch=True)
            context.add_init_script("""window.requestAnimationFrame=()=>0;
                window.cancelAnimationFrame=()=>{};
                localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            if args.probe:
                source = (ROOT / "site/game/rl/combat.js").read_text(encoding="utf-8")
                needle = "power * coef * (ring + weakBonus) * tempo * critMult"
                assert source.count(needle) == 1, "negative-control injection point changed"
                page.route("**/rl/combat.js", lambda route: route.fulfill(content_type="text/javascript",
                    body="window.__weakProbeLoaded=true;\n" + source.replace(needle,
                         "power * coef * ring * tempo * critMult")))

            page.goto(base + "/site/game/roguelike.html?volume=1&seed=300909", wait_until="load", timeout=60000)
            page.wait_for_selector(".roster-card", timeout=60000)
            card = page.locator(".roster-card").filter(has=page.locator('img[src$="/45002001.webp"]'))
            check("琴音当前卡能从正常选角入口到达", card.count() == 1)
            card.click()
            page.wait_for_function("window.kirafanRL?.world?.player && window.kirafanRL.pending===0",
                                   polling=100, timeout=60000)
            dismiss(page)
            advance(page, 1 / 60)
            check("运行时保留当前卡和真实技能行", page.evaluate("""() => {
                const p=window.kirafanRL.world.player;
                return p.card.id===45002001 && p.skills.slots[2].id===450020002;
            }"""))
            # Only fixture stats/enemy position are controlled. Skills, cooldowns,
            # damage, input and UI all execute the shipped implementation.
            page.evaluate("""() => {
                const k=window.kirafanRL,w=k.world,p=w.player,art=w.encounter.mobs[0];
                Object.assign(p.base,{atk:100,mgc:100,luck:0});
                p.critBonus=0;p.critDamage=0;p.iframes=1000;
                window.__weakEnemy=w.spawnEnemy({x:p.x+4,y:p.y,hp:100000,atk:1,
                    def:100,mdef:100,element:3,model:art.model,nameZh:art.nameZh,
                    shadowScale:art.shadowScale});
                window.__weakEnemy.actionTimer=1e9;
                window.__weakEvents=[];
                // Ultimate hit feedback is deferred then requeued by identity.
                // Count world results, not both presentation deliveries.
                const drain=w.drainEvents,seen=new WeakSet();
                w.drainEvents=function(){
                    const events=drain();
                    for(const e of events) if(!seen.has(e) && ['skill','hit','ultimateSpent'].includes(e.type)) {
                        seen.add(e);
                        window.__weakEvents.push({type:e.type,slot:e.slot,damage:e.damage,
                            target:e.target?.id,ultimate:!!e.ultimate});
                    }
                    return events;
                };
            }""")
            advance(page, 1 / 60)
            page.wait_for_function("window.kirafanRL.pending===0", polling=100, timeout=30000)

            def state():
                return page.evaluate("""() => {
                    const w=window.kirafanRL.world,p=w.player,s=p.skills;
                    return {time:w.time,bonus:s.weakElementBonus,buffs:s.buffs,
                        cooldown:s.slots[2].remaining,gauge:s.gauge,speed:p.speed,frozen:w.frozen};
                }""")

            def prepare_enemy(element=3):
                page.evaluate("""element => {
                    const e=window.__weakEnemy,p=window.kirafanRL.world.player;
                    Object.assign(e,{x:p.x+4,y:p.y,hp:100000,element,stun:0,stunTimer:0,kx:0,ky:0});
                    window.__weakEvents.length=0;
                }""", element)
                point = page.evaluate("""() => {
                    const k=window.kirafanRL,e=window.__weakEnemy;
                    const v=new k.camera.position.constructor(e.x,0,e.y).project(k.camera);
                    const r=k.renderer.domElement.getBoundingClientRect();
                    return {x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2};
                }""")
                page.mouse.move(point["x"], point["y"])

            def damage_is(expected, label):
                damage = page.evaluate("100000-window.__weakEnemy.hp")
                measurements.append({"label": label, "damage": damage, "expected": expected})
                assert damage == expected, label + ": " + str([damage, expected])
                check(label, True)
                hits = page.evaluate("window.__weakEvents.filter(e=>e.type==='hit' && e.target===window.__weakEnemy.id)")
                check(label + "仅一次命中", len(hits) == 1, hits)
                return damage

            press(page, "Digit3")
            advance(page, .45)
            first = state()
            check("键盘施放加入0.35倍率增量且不花量能", first["bonus"] == .35 and first["gauge"] == 0, first)
            check("冷却沿用14秒，跑速保持3.5", 13 < first["cooldown"] < 14 and first["speed"] == 3.5, first)
            check("状态提示明确只强化有利属性", "克制倍率+0.35（仅有利属性）" in page.locator(".hud-effects").inner_text())
            prepare_enemy()
            press(page, "KeyJ")
            advance(page, .12)
            shots = page.evaluate("""() => {const out=[];window.kirafanRL.world.danmaku.forEach(b=>{
                if(b.side==='player') out.push({bonus:b.weakElementBonus,power:b.power,coef:b.coef});
            });return out;}""")
            check("真实普攻弹携带施放快照", shots == [{"bonus": .35, "power": 100, "coef": .5}], shots)
            advance(page, .8)
            if args.probe:
                check("负面对照确实加载替换代码", page.evaluate("window.__weakProbeLoaded===true"))
                failure = None
                try:
                    damage_is(246, "强化后普攻固定伤害246")
                except AssertionError as error:
                    failure = str(error)
                check("相同伤害断言检出只有提示没有强化", failure is not None, failure)
                check("负面对照实际退回基础伤害200", page.evaluate("100000-window.__weakEnemy.hp") == 200)
            else:
                damage_is(246, "强化后普攻固定伤害246")
                for element, expected, label in [(0, 70, "中性属性仍为70"), (1, 5, "不利属性仍为5")]:
                    prepare_enemy(element)
                    press(page, "KeyJ")
                    advance(page, .8)
                    damage_is(expected, label)
                press(page, "Escape")
                paused = state()
                advance(page, 20)
                check("暂停不流逝增益冷却或量能", paused == state(), state())
                page.locator("#menu-skills").click()
                words = page.locator("#rl-skillcard").inner_text()
                check("人物卡说明2到2.35且不再标为未适配", "2→2.35" in words
                      and "仅有利属性" in words and "未适配：克制强化" not in words)
                for width in WIDTHS:
                    page.set_viewport_size({"width": width, "height": 812 if width < 500 else 840})
                    fits = page.evaluate("""() => {
                        const w=document.documentElement.clientWidth,s=document.querySelector('#rl-skillcard .sheet').getBoundingClientRect();
                        const b=document.querySelector('#rl-skillcard .close-row button').getBoundingClientRect();
                        return document.documentElement.scrollWidth<=w+1 && s.left>=0 && s.right<=w+1
                            && b.bottom<=innerHeight && b.left>=0;
                    }""")
                    check("技能说明六宽度可达 " + str(width), fits)
                    if width in (375, 1280):
                        page.screenshot(path=str(OUT / ("weak-sheet-%d.png" % width)))
                for _ in range(12):
                    if page.locator("#rl-skillcard .close-row button").evaluate("n=>n===document.activeElement"):
                        break
                    page.keyboard.press("Tab")
                check("键盘能聚焦技能说明关闭键", page.locator("#rl-skillcard .close-row button").evaluate("n=>n===document.activeElement"))
                page.keyboard.press("Enter")
                page.locator("#menu-resume").click()
                advance(page, 15)
                check("到期撤去强化并恢复技能可用", state()["bonus"] == 0 and state()["cooldown"] == 0)
                check("到期提示消失", "克制倍率" not in page.locator(".hud-effects").inner_text())
                prepare_enemy()
                press(page, "KeyJ")
                advance(page, .8)
                damage_is(200, "到期后有利普攻恢复基础伤害200")
                page.set_viewport_size({"width": 390, "height": 812})
                page.touchscreen.tap(195, 400)
                page.locator('.hud-skill[data-slot="2"]').tap()
                advance(page, .45)
                check("真实触控再次施放强化", state()["bonus"] == .35 and state()["cooldown"] > 13)
                prepare_enemy()
                press(page, "Digit2")
                advance(page, 1)
                damage_is(685, "普通技能1.22系数固定伤害685")
                prepare_enemy()
                page.evaluate("window.kirafanRL.world.player.skills.addGauge(1e9)")
                press(page, "KeyR")
                page.wait_for_function("!window.kirafanRL.ultimate.loading", polling=100, timeout=60000)
                if page.locator(".rl-ultimate-skip").is_visible():
                    page.locator(".rl-ultimate-skip").click()
                advance(page, .5)
                damage_is(1413, "必杀先伤害后魔攻增益固定伤害1413")
                check("必杀仅一次量能消费且不从自身伤害回充", state()["gauge"] == 0
                      and page.evaluate("window.__weakEvents.filter(e=>e.type==='ultimateSpent').length") == 1)
                # Keyboard checks intentionally switch back to desktop mode.
                # Re-enter touch mode before measuring its pause hit target.
                page.touchscreen.tap(195, 400)
                check("首次触摸重新显示触控暂停键", page.locator("body").evaluate("n=>n.classList.contains('touch-on')"))
                for width in WIDTHS:
                    page.set_viewport_size({"width": width, "height": 812 if width < 500 else 840})
                    advance(page, 1 / 60)
                    # The HUD's ResizeObserver positions the pause control.
                    page.wait_for_function("""() => {
                        const h=document.querySelector('#hud').getBoundingClientRect(),
                            m=document.querySelector('#minimap').getBoundingClientRect(),
                            p=document.querySelector('.hud-pause').getBoundingClientRect(),
                            e=document.querySelector('.hud-effects').getBoundingClientRect();
                        return document.documentElement.scrollWidth<=innerWidth+1 && h.right+4<=m.left
                            && p.top>=h.bottom+4 && e.right<=h.right && p.bottom<innerHeight;
                    }""", polling=100, timeout=5000)
                    check("增益面板与小地图暂停键无重叠 " + str(width), True)
                    if width in (390, 1280):
                        page.screenshot(path=str(OUT / ("weak-hud-%d.png" % width)))
            check("没有浏览器脚本异常", not errors, errors)
            context.close()
            browser.close()
            name = "browser-probe.json" if args.probe else "browser.json"
            (OUT / name).write_text(json.dumps({"browser": version, "checks": checks, "errors": errors,
                "manualSimulation": True, "measurements": measurements}, ensure_ascii=False, indent=2), encoding="utf-8")
            print("Weak-element browser: %d checks passed" % len(checks), flush=True)
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


if __name__ == "__main__":
    main()
