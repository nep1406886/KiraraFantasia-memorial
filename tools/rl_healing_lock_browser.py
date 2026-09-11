"""T30 healing lock: real input, authored enemy shots, and a served-code control.

One port-0 server and serial browser contexts. Controlled stats/encounter/RNG,
not a complete natural encounter, device-performance or release acceptance run.
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
OUT = ROOT / ".codex-tmp" / "t30-healing-lock"
WIDTHS = (375, 390, 412, 430, 768, 1280)


def state(page):
    return page.evaluate("""() => {
        const w=window.kirafanRL.world,p=w.player,s=p.skills;
        return {time:w.time,hp:p.hp,maxHp:p.maxHp,lock:p.healingLock,
            immunity:p.healingLockImmunity,passive:!!p.passives.healingLockImmune,
            cooldowns:s.slots.map(slot=>slot.remaining),gauge:s.gauge,
            speed:p.speed,barrier:s.barrier,frozen:w.frozen};
    }""")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    checks, errors, measurements = [], [], []
    report = {"checks": checks, "errors": errors, "measurements": measurements,
              "manualSimulation": True, "controlledEnemySkill": 138002}

    def check(label, condition, detail=None):
        if not condition:
            raise AssertionError(label + ": " + str(detail))
        checks.append(label)
        print("PASS " + label, flush=True)

    def near(actual, expected):
        return abs(actual - expected) < 1e-7

    def hp_is(page, expected, label):
        actual = state(page)["hp"]
        measurements.append({"label": label, "hp": actual, "expected": expected})
        assert actual == expected, label + ": " + str([actual, expected])
        check(label, True)

    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                               "--autoplay-policy=no-user-gesture-required"])
            report["browser"] = browser.version

            def start_card(card_id):
                context = browser.new_context(viewport={"width": 1280, "height": 840}, has_touch=True)
                # Hold only simulation rAF; DOM layout, input and ResizeObserver
                # stay real. kirafanRL.step runs the normal update/render path.
                context.add_init_script("""window.requestAnimationFrame=()=>0;
                    window.cancelAnimationFrame=()=>{};
                    localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                if args.probe:
                    source = (ROOT / "site/game/rl/world.js").read_text(encoding="utf-8")
                    needle = "if (!healingLocked(p)) { return true; }"
                    assert source.count(needle) == 1, "negative-control injection point changed"
                    page.route("**/rl/world.js", lambda route: route.fulfill(content_type="text/javascript",
                        body="window.__healingLockProbeLoaded=true;\n" + source.replace(needle, "return true;")))
                page.goto(base + "/site/game/roguelike.html?volume=1&seed=300910", wait_until="load", timeout=60000)
                page.wait_for_selector(".roster-card", timeout=60000)
                card = page.locator(".roster-card").filter(has=page.locator('img[src$="/%d.webp"]' % card_id))
                check(str(card_id) + " 正常选角入口唯一可达", card.count() == 1)
                card.click()
                page.wait_for_function("window.kirafanRL?.world?.player && window.kirafanRL.pending===0",
                                       polling=100, timeout=60000)
                dismiss(page)
                advance(page, 1 / 60)
                check(str(card_id) + " 保留实际进化卡身份", page.evaluate("window.kirafanRL.world.player.card.id") == card_id)
                page.evaluate("""async () => {
                    const k=window.kirafanRL,w=k.world,p=w.player,art=w.encounter.mobs[0];
                    const {enemyMoveset}=await import('/site/game/rl/skills.js');
                    Object.assign(p,{maxHp:1000,hpOverride:1000,hp:1000,iframes:0});
                    Object.assign(p.base,{atk:100,mgc:100,def:10,mdef:10,luck:0});
                    w.rng=()=>0;
                    window.__lockEnemy=w.spawnEnemy({x:p.x+4,y:p.y,hp:100000,atk:100,mgc:100,
                        def:10,mdef:10,element:p.element,model:art.model,nameZh:art.nameZh,
                        shadowScale:art.shadowScale,aiType:'sentry',moveset:enemyMoveset(w.tables.skills,[138002])});
                    window.__lockEnemy.actionTimer=1e9;
                    window.__lockEvents=[];
                    const drain=w.drainEvents,seen=new WeakSet();
                    w.drainEvents=function(){
                        const events=drain();
                        // Ultimate feedback is deferred then requeued by the
                        // same object identity; count actual world results once.
                        for(const e of events) if(!seen.has(e) &&
                            ['telegraph','enemySkill','hit','playerStatus','skill','heal','ultimateSpent','pickup'].includes(e.type)) {
                            seen.add(e);
                            window.__lockEvents.push({type:e.type,action:e.action,remaining:e.remaining,
                                slot:e.slot,skill:e.skill?.id,damage:e.damage,amount:e.amount,
                                target:e.target?.id,bullets:e.bullets,healBlocked:e.healBlocked});
                        }
                        return events;
                    };
                }""")
                advance(page, 1 / 60)
                page.wait_for_function("window.kirafanRL.pending===0", polling=100, timeout=30000)
                return context, page

            def enemy_attack(page):
                result = page.evaluate("""() => {
                    const k=window.kirafanRL,w=k.world,e=window.__lockEnemy,start=window.__lockEvents.length;
                    e.actionTimer=0;
                    for(let i=0;i<180;i++) {
                        k.step(1/60);
                        if(window.__lockEvents.slice(start).some(ev=>ev.type==='hit' && ev.target===w.player.id)) break;
                    }
                    e.actionTimer=1e9;
                    return window.__lockEvents.slice(start);
                }""")
                check("真实敌方读条、发射和命中均已发生", any(e["type"] == "telegraph" and e.get("skill") == 138002 for e in result)
                      and any(e["type"] == "enemySkill" and e.get("bullets") == 1 for e in result)
                      and len([e for e in result if e["type"] == "hit"]) == 1, result)
                return result

            def skill_count(page, slot):
                return page.evaluate("slot=>window.__lockEvents.filter(e=>e.type==='skill' && e.slot===slot).length", slot)

            def ultimate(page):
                page.evaluate("window.kirafanRL.world.player.skills.addGauge(1e9)")
                press(page, "KeyR")
                page.wait_for_function("!window.kirafanRL.ultimate.loading", polling=100, timeout=60000)
                if page.locator(".rl-ultimate-skip").is_visible():
                    page.locator(".rl-ultimate-skip").click()
                advance(page, .45)

            def close_sheet(page):
                for _ in range(12):
                    if page.locator("#rl-skillcard .close-row button").evaluate("n=>n===document.activeElement"):
                        break
                    page.keyboard.press("Tab")
                check("技能说明关闭键可由键盘聚焦", page.locator("#rl-skillcard .close-row button").evaluate("n=>n===document.activeElement"))
                page.keyboard.press("Enter")
                page.locator("#menu-resume").click()

            context, page = start_card(24002001)
            check("薰子第三技能是真实解除免疫行", page.evaluate("window.kirafanRL.world.player.skills.slots[2].id") == 240020002)
            events = enemy_attack(page)
            hp_is(page, 986, "真实33%诅咒攻击固定造成14点伤害")
            check("命中附加一次两回合封锁", state(page)["lock"] > 5.5
                  and len([e for e in events if e.get("action") == "applied"]) == 1, events)
            check("HUD明确显示战斗治疗被封锁", "治疗封锁（技能/吸血回复无效）" in page.locator(".hud-effects").inner_text())
            page.evaluate("window.kirafanRL.world.player.hp=400")
            advance(page, .45)  # Let the real damage-state recovery finish.
            press(page, "Digit2")
            check("键盘治疗消费一次普通技能冷却", skill_count(page, 1) == 1 and state(page)["cooldowns"][1] > 0)
            if args.probe:
                check("负面对照确实加载响应替换代码", page.evaluate("window.__healingLockProbeLoaded===true"))
                failure = None
                try:
                    hp_is(page, 400, "封锁期间治疗后生命仍为400")
                except AssertionError as error:
                    failure = str(error)
                check("相同生命值断言检出有状态却未阻断治疗", failure is not None, failure)
                check("负面对照错误恢复到1000但封锁仍在", state(page)["hp"] == 1000 and state(page)["lock"] > 0, state(page))
                report["detectedFailure"] = failure
                context.close()
            else:
                hp_is(page, 400, "封锁期间治疗后生命仍为400")
                check("失败治疗提示可见且没有伪造正回复", "治疗被封锁" in page.locator("#hint").inner_text()
                      and page.evaluate("!window.__lockEvents.some(e=>e.type==='heal' && e.amount>0)"))
                advance(page, .45)
                press(page, "Digit2")
                check("冷却期间重复输入不会再次施放", skill_count(page, 1) == 1 and state(page)["hp"] == 400)
                gauge_before = state(page)["gauge"]  # The earlier enemy hit legitimately filled gauge.
                press(page, "Digit3")
                s = state(page)
                check("薰子按顺序解除再免疫并沿用6.3秒冷却", s["lock"] == 0
                      and near(s["immunity"], 8.4 - 1 / 60) and near(s["cooldowns"][2], 6.3 - 1 / 60), s)
                check("解除技能只消费一次且不改变量能与移速", skill_count(page, 2) == 1
                      and s["gauge"] == gauge_before and s["speed"] == 3.5, s)
                press(page, "Escape")
                frozen = state(page)
                advance(page, 20)
                check("暂停冻结状态、冷却、生命与量能", frozen == state(page), state(page))
                page.locator("#menu-skills").click()
                words = page.locator("#rl-skillcard").inner_text()
                check("薰子人物卡限定解除免疫范围", all(word in words for word in
                      ["解除治疗封锁", "治疗封锁免疫", "不解除已有封锁", "其余异常解除", "其余异常免疫"]))
                for width in WIDTHS:
                    page.set_viewport_size({"width": width, "height": 812 if width < 500 else 840})
                    fits = page.locator("#rl-skillcard .sheet").evaluate("""el => {
                        const r=el.getBoundingClientRect(),b=document.querySelector('#rl-skillcard .close-row button').getBoundingClientRect();
                        return document.documentElement.scrollWidth<=innerWidth+1 && r.left>=0 && r.right<=innerWidth+1
                            && b.bottom<=innerHeight && b.left>=0;
                    }""")
                    check("治疗封锁说明六宽度可达 " + str(width), fits)
                    if width in (375, 1280):
                        page.screenshot(path=str(OUT / ("lock-sheet-%d.png" % width)))
                close_sheet(page)
                events = enemy_attack(page)
                hp_is(page, 386, "限时免疫只挡异常不免除14点伤害")
                check("后续诅咒被免疫且不重新封锁", state(page)["lock"] == 0
                      and any(e.get("action") == "immune" for e in events), events)
                advance(page, 16)
                check("免疫到期与技能冷却自然归零", state(page)["immunity"] == 0 and state(page)["cooldowns"][1:] == [0, 0])
                page.set_viewport_size({"width": 390, "height": 812})
                page.touchscreen.tap(195, 400)
                page.locator('.hud-skill[data-slot="1"]').tap()
                advance(page, .45)
                hp_is(page, 986, "真实触控治疗在封锁结束后回复60%得到986")
                check("触控治疗只增加一次施放", skill_count(page, 1) == 2)

                enemy_attack(page)
                check("免疫结束后敌方可再次施加封锁", state(page)["lock"] > 5.5)
                advance(page, .45)  # Finish hit-stop before the zero-time preview boundary.
                # A legal loot fixture enters the existing comparison/confirm
                # transaction. Neither preview nor the test writes passives.
                before = page.evaluate("""async () => {
                    const k=window.kirafanRL,w=k.world,p=w.player;
                    const data=await fetch('/site/asset/rl/weapons-rl.json').then(r=>r.json());
                    const weapon=data.catalog.find(row=>row.charaId<0 && row.class===p.card.class && row.rare===4);
                    if(!weapon || !data.passives['11032001']) throw new Error('missing authored equipment fixture');
                    window.__lockDrop={x:p.x,y:p.y,items:[{slot:'weapon',rarity:'rare',catalogId:weapon.id,affixes:['11032001']}]};
                    const before=JSON.stringify([p.hp,p.healingLock,p.healingLockImmunity,p.equipment,p.passives]);
                    w.drops.push(window.__lockDrop);
                    w.events.push({type:'drop',drop:window.__lockDrop,items:window.__lockDrop.items,x:p.x,y:p.y});
                    k.step(0);
                    return before;
                }""")
                page.wait_for_selector("#rl-equipment-choice")
                check("装备比较不治疗、不解除也不提前穿戴", page.evaluate("""() => {
                    const p=window.kirafanRL.world.player;
                    return JSON.stringify([p.hp,p.healingLock,p.healingLockImmunity,p.equipment,p.passives]);
                }""") == before)
                check("装备比较明确仅适配治疗封锁免疫", "治疗封锁免疫（其余异常未适配）" in page.locator("#rl-equipment-choice").inner_text())
                page.locator("#equipment-confirm").focus()
                page.keyboard.press("Enter")
                advance(page, 1 / 60)
                check("键盘确认只装备一次且不清除已有封锁", state(page)["passive"] and state(page)["lock"] > 5
                      and page.evaluate("window.kirafanRL.world.player.equipment.length===1 && !window.kirafanRL.world.drops.includes(window.__lockDrop)")
                      and page.evaluate("window.__lockEvents.filter(e=>e.type==='pickup').length") == 1)
                check("HUD展示武器常驻保护", "治疗封锁免疫 · 武器常驻" in page.locator(".hud-effects").inner_text())
                advance(page, 6)
                page.evaluate("Object.assign(window.kirafanRL.world.player.base,{def:10,mdef:10})")
                hp_before = state(page)["hp"]
                events = enemy_attack(page)
                check("常驻武器保护后续命中而不吞掉伤害", state(page)["lock"] == 0 and state(page)["hp"] == hp_before - 14
                      and any(e.get("action") == "immune" for e in events), events)
                context.close()

                context, page = start_card(28002001)
                page.evaluate("window.kirafanRL.world.player.hp=400")
                press(page, "Digit3")
                s = state(page)
                check("杏真实第三技能先自身封锁再免疫", near(s["lock"], 5.6 - 1 / 60) and near(s["immunity"], 8.4 - 1 / 60)
                      and near(s["cooldowns"][2], 11.55 - 1 / 60) and s["hp"] == 400, s)
                check("杏的负面状态未被随后免疫错误清除", "治疗封锁（" in page.locator(".hud-effects").inner_text()
                      and "治疗封锁免疫" in page.locator(".hud-effects").inner_text())
                advance(page, .45)
                press(page, "Escape")
                frozen = state(page)
                advance(page, 20)
                check("暂停同时冻结封锁与免疫两种倒计时", frozen == state(page))
                page.locator("#menu-skills").click()
                words = page.locator("#rl-skillcard").inner_text()
                check("杏人物卡披露两回合代价和非战斗回复例外", all(word in words for word in
                      ["自身治疗封锁（不幸）100%概率×2回合", "技能/持续/吸血回复无效", "补给、升级与保命不受影响", "未适配：仇恨"]))
                close_sheet(page)
                ultimate(page)
                hp_is(page, 840, "杏必杀先解除再回复44%得到840")
                s = state(page)
                check("必杀解除封锁但保留免疫及三次护盾", s["lock"] == 0 and s["immunity"] > 0 and s["barrier"]["hits"] == 3, s)
                check("必杀一次回复440且量能只消费一次", s["gauge"] == 0
                      and page.evaluate("window.__lockEvents.filter(e=>e.type==='ultimateSpent').length") == 1
                      and page.evaluate("window.__lockEvents.filter(e=>e.type==='heal' && e.amount>0).map(e=>e.amount)") == [440])
                advance(page, 13)
                page.evaluate("window.kirafanRL.world.player.hp=400")
                page.set_viewport_size({"width": 390, "height": 812})
                page.touchscreen.tap(195, 400)
                page.locator('.hud-skill[data-slot="2"]').tap()
                advance(page, 1 / 30)
                s = state(page)
                check("杏触控再次施放同一代价与免疫", s["lock"] > 5.5 and s["immunity"] > 8.3 and skill_count(page, 2) == 2, s)
                check("真实触摸启用触控HUD", page.locator("body").evaluate("n=>n.classList.contains('touch-on')"))
                for width in WIDTHS:
                    page.set_viewport_size({"width": width, "height": 812 if width < 500 else 840})
                    advance(page, 1 / 60)
                    page.wait_for_function("""() => {
                        const h=document.querySelector('#hud').getBoundingClientRect(),m=document.querySelector('#minimap').getBoundingClientRect(),
                            p=document.querySelector('.hud-pause').getBoundingClientRect(),e=document.querySelector('.hud-effects').getBoundingClientRect();
                        return document.documentElement.scrollWidth<=innerWidth+1 && h.right+4<=m.left && p.top>=h.bottom+4
                            && e.right<=h.right && p.bottom<innerHeight;
                    }""", polling=100, timeout=5000)
                    check("双状态面板与小地图暂停键无重叠 " + str(width), True)
                    if width in (390, 1280):
                        before_render = state(page)
                        if width == 390:
                            page.screenshot(path=str(OUT / "lock-hud-390-before-render.png"))
                        # A resize can clear the drawing buffer after step().
                        # With rAF held, redraw only after layout has settled.
                        page.evaluate("window.kirafanRL.renderOnce()")
                        page.screenshot(path=str(OUT / ("lock-hud-%d.png" % width)))
                        if width == 390:
                            check("稳定布局后的截图重绘不推进战斗模拟", before_render == state(page))
                advance(page, 5.6)
                check("封锁先到期而免疫继续存在", state(page)["lock"] == 0 and state(page)["immunity"] > 2.5 and state(page)["hp"] == 400)
                advance(page, 3)
                check("两项状态到期后HUD不残留", state(page)["immunity"] == 0 and "治疗封锁" not in page.locator(".hud-effects").inner_text())
                context.close()

                context, page = start_card(32002001)
                enemy_attack(page)
                page.evaluate("window.kirafanRL.world.player.hp=400")
                advance(page, .45)
                ultimate(page)
                hp_is(page, 400, "琪拉拉必杀先治疗失败后免疫仍为400")
                s = state(page)
                check("琪拉拉免疫不回溯解除旧封锁", s["lock"] > 0 and s["immunity"] > 0 and s["gauge"] == 0, s)
                check("琪拉拉必杀一次扣能且没有正回复或隐式解除", page.evaluate("""window.__lockEvents.filter(e=>e.type==='ultimateSpent').length===1
                    && !window.__lockEvents.some(e=>e.type==='heal' && e.amount>0 || e.action==='cleared')"""))
                context.close()

            check("没有浏览器脚本异常", not errors, errors)
            browser.close()
            print("Healing-lock browser: %d checks passed" % len(checks), flush=True)
    except Exception as error:
        report["failure"] = str(error)
        raise
    finally:
        name = "browser-probe.json" if args.probe else "browser.json"
        (OUT / name).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


if __name__ == "__main__":
    main()
