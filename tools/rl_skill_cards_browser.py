"""T30 CARD placements: real controls, timed effects, and a served-code control.

Port-0 server, serial contexts, controlled stats/targets and manual fixed steps.
This is functional evidence, not natural encounter, device or performance proof.
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
OUT = ROOT / ".codex-tmp" / "t30-skill-cards"
WIDTHS = (375, 390, 412, 430, 768, 1280)


def state(page):
    return page.evaluate("""() => {
        const w=window.kirafanRL.world,p=w.player,s=p.skills;
        return {time:w.time,hp:p.hp,maxHp:p.maxHp,gauge:s.gauge,lock:p.healingLock,
            barrier:s.barrier,
            cooldowns:s.slots.map(slot=>slot.remaining),frozen:w.frozen,
            extra:p.passives.extraCardTriggers,nextAtk:p.nextAtkBonus,
            enemy:window.__cardEnemy?.hp,cards:p.skillCards.map(e=>({id:e.id,card:e.card.id,
                slot:e.sourceSlot,skill:e.sourceSkillId,next:e.next,interval:e.interval,
                remaining:e.remaining,triggers:e.triggers}))};
    }""")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    checks, errors, measurements = [], [], []
    report = {"checks": checks, "errors": errors, "measurements": measurements,
              "manualSimulation": True, "controlledStats": {"maxHp": 1000, "magic": 100,
              "enemyHp": 100000, "enemyDefence": 100}, "detectedFailures": []}

    def check(label, condition, detail=None):
        if not condition:
            raise AssertionError(label + ": " + str(detail))
        checks.append(label)
        print("PASS " + label, flush=True)

    def near(a, b):
        return abs(a - b) < 1e-7

    def hp_is(page, expected, label):
        actual = state(page)["hp"]
        measurements.append({"label": label, "hp": actual, "expected": expected})
        check(label, actual == expected, [actual, expected])

    def damage_is(page, before, expected, label):
        actual = before - state(page)["enemy"]
        measurements.append({"label": label, "damage": actual, "expected": expected})
        check(label, actual == expected, [actual, expected])

    def effect_or_control(assertion, label):
        if not args.probe:
            assertion()
            return
        failure = None
        try:
            assertion()
        except AssertionError as error:
            failure = str(error)
        check(label, failure is not None, failure)
        report["detectedFailures"].append(failure)

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
                context.add_init_script("""window.requestAnimationFrame=()=>0;
                    window.cancelAnimationFrame=()=>{};
                    if(!localStorage.getItem('kirafan-rl:meta'))
                        localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                if args.probe:
                    source = (ROOT / "site/game/rl/world.js").read_text(encoding="utf-8")
                    needle = "for (const effect of entry.card.effects) {"
                    assert source.count(needle) == 1, "negative-control injection point changed"
                    page.route("**/rl/world.js", lambda route: route.fulfill(content_type="text/javascript",
                        body="window.__skillCardProbeLoaded=true;\n" + source.replace(needle, "for (const effect of []) {")))
                page.goto(base + "/site/game/roguelike.html?volume=1&seed=300911", wait_until="load", timeout=60000)
                page.wait_for_selector(".roster-card", timeout=60000)
                selected = page.locator(".roster-card").filter(has=page.locator('img[src$="/%d.webp"]' % card_id))
                check(str(card_id) + " 正常选角入口唯一可达", selected.count() == 1)
                selected.click()
                page.wait_for_function("window.kirafanRL?.world?.player && window.kirafanRL.pending===0",
                                       polling=100, timeout=60000)
                dismiss(page)
                advance(page, 1 / 60)
                check(str(card_id) + " 保留真实进化卡身份", page.evaluate("window.kirafanRL.world.player.card.id") == card_id)
                page.evaluate("""() => {
                    const k=window.kirafanRL,w=k.world,p=w.player,art=w.encounter.mobs[0];
                    Object.assign(p,{maxHp:1000,hpOverride:1000,hp:1000,iframes:0});
                    Object.assign(p.base,{atk:100,mgc:100,def:100,mdef:100,luck:0});
                    w.rng=()=>.5;
                    window.__cardEnemy=w.spawnEnemy({x:p.x+4,y:p.y,hp:100000,atk:1,mgc:1,
                        def:100,mdef:100,element:p.element,model:art.model,nameZh:art.nameZh,
                        shadowScale:art.shadowScale,aiType:'sentry'});
                    window.__cardEnemy.actionTimer=1e9;
                    window.__cardEvents=[];
                    const drain=w.drainEvents,seen=new WeakSet();
                    w.drainEvents=function(){
                        const events=drain();
                        for(const e of events) if(!seen.has(e) &&
                            ['skillCard','playerShot','skill','hit','heal','ultimateSpent','playerStatus','pickup','telegraph','enemySkill'].includes(e.type)) {
                            seen.add(e);
                            window.__cardEvents.push({type:e.type,time:w.time,action:e.action,card:e.cardId,
                                instance:e.instance,trigger:e.trigger,remaining:e.remaining,next:e.next,
                                slot:e.slot,skill:e.skill?.id,damage:e.damage,amount:e.amount,
                                target:e.target?.id,skillCard:e.skillCard,bullets:e.bullets});
                        }
                        return events;
                    };
                }""")
                advance(page, 1 / 60)
                page.wait_for_function("window.kirafanRL.pending===0", polling=100, timeout=30000)
                return context, page

            def events(page, kind="skillCard", action=None):
                return page.evaluate("""([kind,action])=>window.__cardEvents.filter(e=>
                    e.type===kind && (action===null || e.action===action))""", [kind, action])

            def next_trigger(page):
                count = len(events(page, action="triggered"))
                page.evaluate("""count=>{
                    const k=window.kirafanRL;
                    for(let i=0;i<600;i++) {
                        k.step(1/60);
                        if(window.__cardEvents.filter(e=>e.type==='skillCard' && e.action==='triggered').length>count) return;
                    }
                    throw new Error('no card trigger within ten simulated seconds');
                }""", count)
                event = events(page, action="triggered")[-1]
                measurements.append({"trigger": event, "state": state(page)})
                return event

            def ultimate(page, touch=False, verify_freeze=False):
                page.evaluate("window.kirafanRL.world.player.skills.addGauge(1e9)")
                advance(page, 1 / 60)
                if touch:
                    # Keyboard equipment confirmation switches to desktop mode;
                    # a real canvas touch must re-enable touch chrome first.
                    page.touchscreen.tap(195, 400)
                    page.locator(".hud-gauge").tap()
                    advance(page, 1 / 30)
                else:
                    press(page, "KeyR")
                page.wait_for_function("!window.kirafanRL.ultimate.loading", polling=100, timeout=60000)
                if verify_freeze:
                    check("技能卡来源必杀使用真实独立演出", page.evaluate("!!window.kirafanRL.ultimate.stage"))
                    before = state(page)
                    advance(page, 1)
                    check("必杀演出冻结卡倒计时且不重复触发", before == state(page), state(page))
                if page.locator(".rl-ultimate-skip").is_visible():
                    page.locator(".rl-ultimate-skip").click()
                advance(page, 1 / 60)

            def hud_widths(page, stem):
                page.touchscreen.tap(250, 400)
                for width in WIDTHS:
                    page.set_viewport_size({"width": width, "height": 812 if width < 500 else 840})
                    advance(page, 1 / 60)
                    page.wait_for_function("""() => {
                        const h=document.querySelector('#hud').getBoundingClientRect(),m=document.querySelector('#minimap').getBoundingClientRect(),
                            p=document.querySelector('.hud-pause').getBoundingClientRect(),e=document.querySelector('.hud-effects').getBoundingClientRect();
                        return document.documentElement.scrollWidth<=innerWidth+1 && h.right+4<=m.left && p.top>=h.bottom+4
                            && e.right<=h.right && p.bottom<innerHeight;
                    }""", polling=100, timeout=5000)
                    check(stem + " 技能卡面板六宽度无重叠 " + str(width), True)
                    if width in (390, 1280):
                        before = state(page)
                        page.evaluate("window.kirafanRL.renderOnce()")
                        page.screenshot(path=str(OUT / (stem + "-hud-%d.png" % width)))
                        check(stem + " 布局稳定后截图不推进模拟 " + str(width), before == state(page))

            context, page = start_card(24002001)
            page.evaluate("window.kirafanRL.world.player.hp=400")
            ultimate(page, verify_freeze=True)
            hp_is(page, 730, "薰子必杀即时33%治疗使400变730")
            s = state(page)
            check("薰子只放置真实CARD10005三次且扣能一次", len(s["cards"]) == 1
                  and s["cards"][0]["card"] == 10005 and s["cards"][0]["remaining"] == 3
                  and s["gauge"] == 0 and len(events(page, "ultimateSpent")) == 1, s)
            check("HUD披露来源、次数和倒计时", "治疗卡（必杀）" in page.locator(".hud-effects").inner_text()
                  and "3次" in page.locator(".hud-effects").inner_text())
            if not args.probe:
                press(page, "Escape")
                before = state(page)
                advance(page, 20)
                check("菜单暂停冻结卡、生命、冷却和量能", before == state(page), state(page))
                page.locator("#menu-skills").click()
                words = page.locator("#rl-skillcard").inner_text()
                check("人物卡明确20%单次效果和刷新边界", all(word in words for word in
                      ["放置治疗卡×3次", "2.8秒", "最大生命20%", "受治疗封锁", "不重置倒计时", "换房清除"]))
                for width in WIDTHS:
                    page.set_viewport_size({"width": width, "height": 812 if width < 500 else 840})
                    fits = page.locator("#rl-skillcard .sheet").evaluate("""el => {
                        const r=el.getBoundingClientRect(),b=document.querySelector('#rl-skillcard .close-row button').getBoundingClientRect();
                        return document.documentElement.scrollWidth<=innerWidth+1 && r.left>=0 && r.right<=innerWidth+1
                            && b.bottom<=innerHeight && b.left>=0;
                    }""")
                    check("技能卡说明六宽度可达 " + str(width), fits)
                    if width in (375, 1280):
                        page.screenshot(path=str(OUT / ("card-sheet-%d.png" % width)))
                close = page.locator("#rl-skillcard .close-row button")
                for _ in range(12):
                    if close.evaluate("n=>n===document.activeElement"):
                        break
                    page.keyboard.press("Tab")
                check("技能卡说明关闭键可由键盘聚焦", close.evaluate("n=>n===document.activeElement"))
                page.keyboard.press("Enter")
                page.locator("#menu-resume").click()
            next_trigger(page)
            effect_or_control(lambda: hp_is(page, 930, "首张治疗卡固定回复200至930"), "相同生命断言检出仅有卡提示却未回复")
            if args.probe:
                check("负面对照仅撤去效果而保留调度与HUD", page.evaluate("window.__skillCardProbeLoaded===true")
                      and state(page)["cards"][0]["remaining"] == 2 and "2次" in page.locator(".hud-effects").inner_text())
            else:
                next_trigger(page)
                hp_is(page, 1000, "第二张治疗卡受正常生命上限限制为1000")
                next_trigger(page)
                hp_is(page, 1000, "满血仍消费第三次且不重复回复")
                check("三次结束后卡与HUD一起消失", not state(page)["cards"] and "治疗卡" not in page.locator(".hud-effects").inner_text()
                      and len(events(page, action="triggered")) == 3 and len(events(page, "ultimateSpent")) == 1)
                ultimate(page)
                page.evaluate("""async()=>{
                    const p=window.kirafanRL.world.player;
                    const {applyHealingLock}=await import('/site/game/rl/playerstatus.js');
                    p.hp=400; applyHealingLock(p,1,4,()=>0);
                }""")
                next_trigger(page)
                hp_is(page, 400, "剩余四秒治疗封锁阻断卡回复但照常消费一次")
                check("卡回复被封锁仍有明确失败事件", bool(events(page, "playerStatus", "healBlocked")))
                hud_widths(page, "healing-card")
                next_trigger(page)
                hp_is(page, 600, "封锁到期只付本次200而不补发旧次数")
                next_trigger(page)
                hp_is(page, 800, "余下最后一次治疗卡正常回复200")
                ultimate(page)
                check("重载前确有活跃技能卡", len(state(page)["cards"]) == 1)
                press(page, "Escape")
                advance(page, 5.1)
                page.wait_for_timeout(150)
                saved = page.evaluate("import('/site/game/rl/save.js').then(m=>m.load('run'))")
                check("常规存档保存玩家结果但不序列化战场卡", saved["hp"] == state(page)["hp"]
                      and "skillCards" not in saved and "skillCardSerial" not in saved)
                page.reload(wait_until="load", timeout=60000)
                page.wait_for_selector("#roster-continue", timeout=60000)
                page.locator("#roster-continue").click()
                page.wait_for_function("window.kirafanRL?.world?.player && window.kirafanRL.pending===0", polling=100, timeout=60000)
                dismiss(page)
                advance(page, 1 / 60)
                check("真实续档恢复身份和生命但不恢复技能卡", page.evaluate("window.kirafanRL.world.player.card.id") == 24002001
                      and state(page)["hp"] == min(saved["hp"], state(page)["maxHp"]) and not state(page)["cards"])
                before_hp = state(page)["hp"]
                advance(page, 9)
                hp_is(page, before_hp, "续档九秒不重放保存前的治疗卡")
            context.close()

            context, page = start_card(39002001)
            point = page.evaluate("""()=>{
                const k=window.kirafanRL,e=window.__cardEnemy;
                const v=new k.camera.position.constructor(e.x,0,e.y).project(k.camera),r=k.renderer.domElement.getBoundingClientRect();
                return {x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2};
            }""")
            page.mouse.move(point["x"], point["y"])
            page.evaluate("window.kirafanRL.world.player.nextAtkBonus=.6")
            press(page, "Digit2")
            check("咏深键盘施放原技能并放置CARD10050", state(page)["cards"][0]["card"] == 10050
                  and 16.7 < state(page)["cooldowns"][1] < 16.8 and len(events(page, "skill")) == 1)
            page.evaluate("""()=>{
                for(let i=0;i<120;i++) {
                    window.kirafanRL.step(1/60);
                    if(window.__cardEvents.some(e=>e.type==='hit' && !e.skillCard)) return;
                }
                throw new Error('ordinary parent projectile did not hit');
            }""")
            damage_is(page, 100000, 242, "咏深原普通技能1.16系数仍独立造成242伤害")
            before_hp = state(page)["enemy"]
            next_trigger(page)
            effect_or_control(lambda: damage_is(page, before_hp, 70, "咏深后续攻击卡0.5系数固定造成70伤害"),
                              "相同伤害断言检出有攻击卡提示却无伤害")
            if args.probe:
                check("攻击负面对照仍消费次数且没有伪造卡命中", state(page)["cards"][0]["remaining"] == 2
                      and not any(e.get("skillCard") for e in events(page, "hit")))
            else:
                check("卡伤害获得70量能且不消费次攻", state(page)["gauge"] == 312 and near(state(page)["nextAtk"], .6))
                advance(page, .45)
                press(page, "Digit2")
                check("冷却中重复输入不重复放置或发射", len(events(page, "skill")) == 1
                      and len(events(page, "playerShot")) == 1 and len(events(page, action="placed")) == 1)
                next_trigger(page)
                next_trigger(page)
                check("攻击卡三次真实命中后耗尽", not state(page)["cards"]
                      and [e["damage"] for e in events(page, "hit") if e.get("skillCard")] == [70, 70, 70])
                advance(page, state(page)["cooldowns"][1] + .5)
                page.set_viewport_size({"width": 390, "height": 812})
                page.touchscreen.tap(195, 400)
                page.locator('.hud-skill[data-slot="1"]').tap()
                advance(page, 1 / 30)
                check("真实触控再次放置一次攻击卡", len(events(page, "skill")) == 2
                      and len(state(page)["cards"]) == 1 and state(page)["cards"][0]["remaining"] == 3)
                hud_widths(page, "attack-card")
                page.evaluate("""()=>{
                    const k=window.kirafanRL,w=k.world;
                    const next=w.dungeon.rooms.find(r=>r.id!==w.room.id && r.type!=='boss');
                    w.enterRoom(next.id); k.step(0);
                }""")
                check("沿既有换房入口清除攻击卡", not state(page)["cards"])
            context.close()

            context, page = start_card(14002001)
            page.evaluate("""()=>{
                const k=window.kirafanRL,w=k.world,p=w.player;
                window.__normalCardDrop={x:p.x,y:p.y,items:[{slot:'armor',rarity:'rare',affixes:['14032021']}]};
                w.drops.push(window.__normalCardDrop);
                w.events.push({type:'drop',drop:window.__normalCardDrop,items:window.__normalCardDrop.items,x:p.x,y:p.y});
                k.step(0);
            }""")
            page.wait_for_selector("#rl-equipment-choice")
            check("普攻替换词条沿合法装备比较入口进入", "替换普攻" in page.locator("#rl-equipment-choice").inner_text()
                  and not state(page)["cards"])
            page.locator("#equipment-confirm").focus()
            page.keyboard.press("Enter")
            advance(page, 1 / 60)
            check("确认装备真实普攻替换行140320211", page.evaluate("window.kirafanRL.world.player.skills.normal.id") == 140320211)
            press(page, "KeyJ")
            s = state(page)
            check("近战挥空也接受普攻来源的防护卡", len(s["cards"]) == 1 and s["cards"][0]["slot"] == 3
                  and s["cards"][0]["card"] == 10041 and s["cards"][0]["remaining"] == 1
                  and "防护卡（普攻）" in page.locator(".hud-effects").inner_text(), s)
            if not args.probe:
                hud_widths(page, "normal-card")
            event = next_trigger(page)
            check("防护卡按2.1秒独立计时触发一次后耗尽", event["card"] == 10041
                  and event["trigger"] == 1 and not state(page)["cards"])
            check("防护卡不以普攻命中为前提", not events(page, "hit"))
            page.evaluate("""async()=>{
                const w=window.kirafanRL.world,p=w.player,e=window.__cardEnemy;
                const {enemyMoveset}=await import('/site/game/rl/skills.js');
                Object.assign(p.base,{def:10,mdef:10});
                Object.assign(e,{atk:100,mgc:100,moveset:enemyMoveset(w.tables.skills,[138002]),actionTimer:0});
            }""")
            before_hp = state(page)["hp"]
            page.evaluate("""()=>{
                const k=window.kirafanRL,w=k.world;
                for(let i=0;i<180;i++) {
                    k.step(1/60);
                    if(window.__cardEvents.some(e=>e.type==='hit' && e.target===w.player.id)) {
                        window.__cardEnemy.actionTimer=1e9; return;
                    }
                }
                throw new Error('authored shield-test enemy did not hit');
            }""")
            check("护盾承伤验证经过真实敌方读条和发射", any(e.get("skill") == 138002 for e in events(page, "telegraph"))
                  and any(e.get("skill") == 138002 for e in events(page, "enemySkill")))
            effect_or_control(lambda: hp_is(page, before_hp - 11, "20%防护卡将真实14点命中减为11点"),
                              "相同承伤断言检出防护卡触发却没有护盾")
            if not args.probe:
                check("防护卡的一次护盾已被该命中消耗", state(page)["barrier"] is None)
            context.close()

            if not args.probe:
                for card_id, ref, amount in [(12002001, 10001, 200), (21002001, 10004, 200),
                                             (25002001, 10007, 130), (32002001, 10014, 130)]:
                    context, page = start_card(card_id)
                    page.set_viewport_size({"width": 390, "height": 812})
                    page.touchscreen.tap(195, 400)
                    ultimate(page, touch=True)
                    check(str(card_id) + " 触控必杀只放置对应原表卡一次", len(state(page)["cards"]) == 1
                          and state(page)["cards"][0]["card"] == ref and len(events(page, "ultimateSpent")) == 1)
                    page.evaluate("window.kirafanRL.world.player.hp=400")
                    next_trigger(page)
                    hp_is(page, 400 + amount, str(card_id) + " 卡单次回复精确为" + str(amount))
                    if card_id == 21002001:
                        before = page.evaluate("""()=>{
                            const k=window.kirafanRL,w=k.world,p=w.player;
                            window.__cardDrop={x:p.x,y:p.y,items:[{slot:'weapon',rarity:'legendary',catalogId:2100203,affixes:[]}]};
                            const before=JSON.stringify([p.hp,p.skillCards,p.equipment,p.passives]);
                            w.drops.push(window.__cardDrop);
                            w.events.push({type:'drop',drop:window.__cardDrop,items:window.__cardDrop.items,x:p.x,y:p.y});
                            k.step(0); return before;
                        }""")
                        page.wait_for_selector("#rl-equipment-choice")
                        check("花名真实专武比较不提前穿戴或修改卡", page.evaluate("""()=>{
                            const p=window.kirafanRL.world.player; return JSON.stringify([p.hp,p.skillCards,p.equipment,p.passives]);
                        }""") == before)
                        check("比较披露额外两次与仍未实现的眩晕免疫", all(word in page.locator("#rl-equipment-choice").inner_text()
                              for word in ["技能卡触发次数 +2（放置/刷新时）", "未适配：眩晕免疫"]))
                        page.locator("#equipment-confirm").focus()
                        page.keyboard.press("Enter")
                        advance(page, 1 / 60)
                        s = state(page)
                        check("键盘确认装备一次但不追溯延长现有卡", s["extra"] == 2 and s["cards"][0]["remaining"] == 2
                              and len(events(page, "pickup")) == 1)
                        old_id = s["cards"][0]["id"]
                        deadline = s["time"] + s["cards"][0]["next"]
                        ultimate(page, touch=True)
                        s = state(page)
                        check("同槽刷新为五次但保留实例与原截止时间", len(s["cards"]) == 1
                              and s["cards"][0]["id"] == old_id and s["cards"][0]["remaining"] == 5
                              and near(s["time"] + s["cards"][0]["next"], deadline)
                              and len(events(page, action="refreshed")) == 1, s)
                        for _ in range(5):
                            next_trigger(page)
                        check("新增两次确实形成五次后续触发而非仅显示文字", not state(page)["cards"]
                              and len(events(page, action="triggered")) == 6 and len(events(page, "ultimateSpent")) == 2)
                    context.close()
            check("没有浏览器脚本异常", not errors, errors)
            browser.close()
            print("Skill-card browser: %d checks passed" % len(checks), flush=True)
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
