"""T30 stat reset: actual input/equipment/enemy casts and a served-code control.

Port-0 server, serial contexts, deterministic stats and manually advanced steps.
This is not natural-encounter, physical-device or performance acceptance.
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
OUT = ROOT / ".codex-tmp" / "t30-stat-reset"
WIDTHS = (375, 390, 412, 430, 768, 1280)


def state(page):
    return page.evaluate("""() => {
        const w=window.kirafanRL.world,p=w.player,s=p.skills,e=window.__resetEnemy;
        const stat=window.__resetTools.effectiveStat;
        return {time:w.time,hp:p.hp,maxHp:p.maxHp,atk:p.atk,mgc:p.mgc,def:p.def,mdef:p.mdef,
            base:p.base,rate:s.cooldownRate,buffs:s.buffs,barrier:s.barrier,gauge:s.gauge,
            cooldowns:s.slots.map(slot=>slot.remaining),speed:p.speed,nextAtk:p.nextAtkBonus,
            frozen:w.frozen,enemy:e?{hp:e.hp,atk:stat(e,'atk'),mgc:stat(e,'mgc'),mdef:stat(e,'mdef'),
            buffs:e.debuffs,slow:e.slow,resists:e.resists}:null};
    }""")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    checks, errors, measurements = [], [], []
    report = {"checks": checks, "errors": errors, "measurements": measurements,
              "manualSimulation": True, "controlledEnemySkills": [16002, 12011, 15017, 143002, 114074],
              "detectedFailures": []}

    def check(label, condition, detail=None):
        if not condition:
            raise AssertionError(label + ": " + str(detail))
        checks.append(label)
        print("PASS " + label, flush=True)

    def near(a, b):
        return abs(a - b) < 1e-7

    def value_is(page, key, expected, label):
        actual = state(page)
        for part in key.split("."):
            actual = actual[part]
        measurements.append({"label": label, "actual": actual, "expected": expected})
        check(label, near(actual, expected), [actual, expected])

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

            def start_card(card_id=46002001):
                context = browser.new_context(viewport={"width": 1280, "height": 840}, has_touch=True)
                context.add_init_script("""window.__captureRAF=window.requestAnimationFrame.bind(window);
                    window.requestAnimationFrame=()=>0;
                    window.cancelAnimationFrame=()=>{};
                    localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                if args.probe:
                    source = (ROOT / "site/game/rl/statreset.js").read_text(encoding="utf-8")
                    needle = "buff[key] = 0;"
                    assert source.count(needle) == 1, "negative-control injection point changed"
                    page.route("**/rl/statreset.js", lambda route: route.fulfill(content_type="text/javascript",
                        body="window.__statResetProbeLoaded=true;\n" + source.replace(needle, "void value;")))
                page.goto(base + "/site/game/roguelike.html?volume=1&seed=300912", wait_until="load", timeout=60000)
                page.wait_for_selector(".roster-card", timeout=60000)
                selected = page.locator(".roster-card").filter(has=page.locator('img[src$="/%d.webp"]' % card_id))
                check(str(card_id) + " 正常选角入口唯一可达", selected.count() == 1)
                selected.click()
                page.wait_for_function("window.kirafanRL?.world?.player && window.kirafanRL.pending===0",
                                       polling=100, timeout=60000)
                dismiss(page)
                advance(page, 1 / 60)
                check(str(card_id) + " 保留真实进化卡身份", page.evaluate("window.kirafanRL.world.player.card.id") == card_id)
                page.evaluate("""async () => {
                    const k=window.kirafanRL,w=k.world,p=w.player,art=w.encounter.mobs[0];
                    const {enemyMoveset,decodeSkill}=await import('/site/game/rl/skills.js');
                    const {effectiveStat}=await import('/site/game/rl/combat.js');
                    window.__resetTools={enemyMoveset,decodeSkill,effectiveStat};
                    Object.assign(p,{maxHp:1000,hpOverride:1000,hp:1000,iframes:0});
                    Object.assign(p.base,{atk:100,mgc:100,def:100,mdef:100,luck:0});
                    w.rng=()=>.5;
                    window.__resetEnemy=w.spawnEnemy({x:p.x+4,y:p.y,hp:100000,atk:500,mgc:500,
                        def:100,mdef:100,element:p.element,model:art.model,nameZh:art.nameZh,
                        shadowScale:art.shadowScale,aiType:'sentry'});
                    window.__resetEnemy.actionTimer=1e9;
                    window.__resetEvents=[];
                    const drain=w.drainEvents,seen=new WeakSet();
                    w.drainEvents=function(){
                        const events=drain();
                        for(const e of events) if(!seen.has(e) &&
                            ['skill','playerShot','hit','statReset','pickup','telegraph','enemySkill','ultimateSpent'].includes(e.type)) {
                            seen.add(e);
                            window.__resetEvents.push({type:e.type,time:w.time,slot:e.slot,skill:e.skill?.id,
                                damage:e.damage,target:e.target?.id,unit:e.unit?.id,mode:e.mode,stats:e.stats,
                                changed:e.changed,bullets:e.bullets});
                        }
                        return events;
                    };
                }""")
                advance(page, 1 / 60)
                page.wait_for_function("window.kirafanRL.pending===0", polling=100, timeout=30000)
                return context, page

            def events(page, kind):
                return page.evaluate("kind=>window.__resetEvents.filter(e=>e.type===kind)", kind)

            def enemy_attack(page, skill_id):
                result = page.evaluate("""skillId=>{
                    const k=window.kirafanRL,w=k.world,p=w.player,e=window.__resetEnemy;
                    const mark=window.__resetEvents.length;
                    w.danmaku.clear(); p.iframes=0;
                    e.moveset=window.__resetTools.enemyMoveset(w.tables.skills,[skillId]);
                    e.sm.force('idle'); e.pending=null; e.actionTimer=0;
                    for(let i=0;i<240;i++) {
                        k.step(1/60);
                        if(window.__resetEvents.slice(mark).some(ev=>ev.type==='hit' && ev.target===p.id)) {
                            e.actionTimer=1e9;
                            // Later volley bullets are outside this controlled first-hit observation.
                            w.danmaku.clear(); return window.__resetEvents.slice(mark);
                        }
                    }
                    throw new Error('enemy did not hit within four simulated seconds');
                }""", skill_id)
                check(str(skill_id) + " 经过真实敌方读条、发射和命中", any(e["type"] == "telegraph" and e.get("skill") == skill_id for e in result)
                      and any(e["type"] == "enemySkill" and e.get("skill") == skill_id and e.get("bullets", 0) > 0 for e in result)
                      and len([e for e in result if e["type"] == "hit"]) == 1, result)
                return result

            def sheet(page):
                press(page, "Escape")
                before = state(page)
                advance(page, 20)
                check("菜单暂停冻结能力、计时、生命和量能", state(page) == before, state(page))
                page.locator("#menu-skills").click()
                words = page.locator("#rl-skillcard").inner_text()
                check("一里技能说明区分降低与提高并保留孤立缺口", all(word in words for word in
                      ["解除自身魔防降低效果（保留提高）", "护盾 50%×1次", "自身魔防+35%", "未适配：自身异常"])
                      and "未适配：能力重置" not in words, words)
                for width in WIDTHS:
                    page.set_viewport_size({"width": width, "height": 812 if width < 500 else 840})
                    fits = page.locator("#rl-skillcard .sheet").evaluate("""el=>{
                        const r=el.getBoundingClientRect(),b=document.querySelector('#rl-skillcard .close-row button').getBoundingClientRect();
                        return document.documentElement.scrollWidth<=innerWidth+1 && r.left>=0 && r.right<=innerWidth+1
                            && b.bottom<=innerHeight && b.left>=0;
                    }""")
                    check("能力解除说明六宽度可达 " + str(width), fits)
                    if width in (375, 1280):
                        page.screenshot(path=str(OUT / ("reset-sheet-%d.png" % width)))
                close = page.locator("#rl-skillcard .close-row button")
                for _ in range(12):
                    if close.evaluate("n=>n===document.activeElement"):
                        break
                    page.keyboard.press("Tab")
                check("说明关闭键可由键盘聚焦", close.evaluate("n=>n===document.activeElement"))
                page.keyboard.press("Enter")
                page.locator("#menu-resume").click()

            def hud_widths(page):
                page.touchscreen.tap(250, 400)
                for width in WIDTHS:
                    page.set_viewport_size({"width": width, "height": 812 if width < 500 else 840})
                    advance(page, 1 / 60)
                    page.wait_for_function("""()=>{
                        const h=document.querySelector('#hud').getBoundingClientRect(),m=document.querySelector('#minimap').getBoundingClientRect(),
                            p=document.querySelector('.hud-pause').getBoundingClientRect(),e=document.querySelector('.hud-effects').getBoundingClientRect();
                        return document.documentElement.scrollWidth<=innerWidth+1 && h.right+4<=m.left && p.top>=h.bottom+4
                            && e.right<=h.right && p.bottom<innerHeight;
                    }""", polling=100, timeout=5000)
                    check("解除后增益面板六宽度无重叠 " + str(width), True)
                    if width in (390, 1280):
                        before = state(page)
                        # Resize/storage callbacks may clear WebGL after a one-off
                        # draw while simulation rAF is disabled. Paint native frames
                        # only for capture; never advance the world or its timers.
                        page.evaluate("""()=>new Promise(resolve=>{
                            window.__capturePaint=true; let frames=0;
                            function paint(){
                                window.kirafanRL.renderOnce(); frames++;
                                if(frames===2) resolve();
                                if(window.__capturePaint && frames<600) window.__captureRAF(paint);
                            }
                            window.__captureRAF(paint);
                        })""")
                        try:
                            page.screenshot(path=str(OUT / ("reset-hud-%d.png" % width)))
                        finally:
                            page.evaluate("window.__capturePaint=false")
                        check("布局稳定后截图不推进模拟 " + str(width), state(page) == before)

            def equip_affix(page, affix):
                before = page.evaluate("""affix=>{
                    const k=window.kirafanRL,w=k.world,p=w.player;
                    const item={slot:'armor',rarity:'rare',affixes:affix?[affix]:[]};
                    const drop={x:p.x,y:p.y,items:[item]};
                    const before=JSON.stringify([p.hp,p.skills.slots[1].id,p.equipment,p.passives]);
                    w.drops.push(drop); w.events.push({type:'drop',drop,items:drop.items,x:p.x,y:p.y});
                    k.step(0); return before;
                }""", affix)
                page.wait_for_selector("#rl-equipment-choice")
                check("装备比较不提前修改技能或装备", page.evaluate("""()=>{
                    const p=window.kirafanRL.world.player; return JSON.stringify([p.hp,p.skills.slots[1].id,p.equipment,p.passives]);
                }""") == before)
                if affix:
                    check("合法词条比较披露替换职业技能", "替换职业技能 2 项" in page.locator("#rl-equipment-choice").inner_text())
                page.locator("#equipment-confirm").focus()
                page.keyboard.press("Enter")
                advance(page, 1 / 60)

            context, page = start_card()
            check("一里当前第一普通技能仍为460020001", page.evaluate("window.kirafanRL.world.player.skills.slots[1].id") == 460020001)
            page.evaluate("window.kirafanRL.world.player.skills.addGauge(123)")
            press(page, "Digit3")
            advance(page, .5)
            page.evaluate("window.kirafanRL.world.player.skills.applySelf({buff:{turns:10,mdef:-.5,atk:-.2}})")
            advance(page, 1 / 60)
            value_is(page, "mdef", 85, "真实35%魔防提高与受控50%降低共存时魔防为85")
            before_base = state(page)["base"]
            press(page, "Digit2")
            effect_or_control(lambda: value_is(page, "mdef", 135, "键盘解除降低后魔防固定恢复为135而非100"),
                              "同一面板断言检出只有解除提示却仍为85")
            check("解除只消耗一次9.8秒冷却且不改量能与基础属性", near(state(page)["cooldowns"][1], 9.8 - 1 / 60)
                  and state(page)["gauge"] == 123 and state(page)["base"] == before_base
                  and len([e for e in events(page, "skill") if e["slot"] == 1]) == 1)
            check("解除事件保留指定能力与实际改变字段", events(page, "statReset")[-1]["changed"] == ["mdef"]
                  and events(page, "statReset")[-1]["mode"] == "down")
            if args.probe:
                check("负面对照确实只替换内存响应并保留护盾与事件", page.evaluate("window.__statResetProbeLoaded===true")
                      and state(page)["barrier"] == {"cut": .5, "hits": 1})
            else:
                check("解除结果没有被同帧施放提示覆盖", "已解除魔防降低效果" in page.locator("#hint").inner_text())
                words = page.locator(".hud-effects").inner_text()
                check("HUD保留35%提高和同条目的物攻降低", "魔防+35%" in words and "魔防-50%" not in words and "物攻-20%" in words, words)
                sheet(page)
                hud_widths(page)
            enemy_attack(page, 16002)
            effect_or_control(lambda: value_is(page, "hp", 965, "固定69点魔法伤害经一次50%盾为35点"),
                              "同一承伤断言检出未解除时实际承伤50点")
            check("一次护盾在该真实命中后耗尽", state(page)["barrier"] is None)
            if not args.probe:
                advance(page, 11)
                page.set_viewport_size({"width": 390, "height": 812})
                page.touchscreen.tap(195, 400)
                page.locator('.hud-skill[data-slot="1"]').tap()
                advance(page, 1 / 30)
                check("真实触控可施放无可解除项的技能且只消费一次", len([e for e in events(page, "skill") if e["slot"] == 1]) == 2
                      and events(page, "statReset")[-1]["changed"] == [] and state(page)["cooldowns"][1] > 9.7)
                check("无可解除项在页面明确提示而非宣称恢复", "无可解除的魔防降低效果" in page.locator("#hint").inner_text())
                press(page, "Escape")
                advance(page, 5.1)
                page.wait_for_timeout(150)
                saved = page.evaluate("import('/site/game/rl/save.js').then(m=>m.load('run'))")
                check("普通存档不新增能力解除或临时增益字段", "statResets" not in saved and "buffs" not in saved)
                page.reload(wait_until="load", timeout=60000)
                page.wait_for_selector("#roster-continue", timeout=60000)
                page.locator("#roster-continue").click()
                page.wait_for_function("window.kirafanRL?.world?.player && window.kirafanRL.pending===0", polling=100, timeout=60000)
                dismiss(page)
                advance(page, 1 / 60)
                check("真实续档仍为一里且不恢复战场临时能力", page.evaluate("""()=>{
                    const p=window.kirafanRL.world.player;return p.card.id===46002001 && p.skills.buffs.length===0 && p.skills.barrier===null;
                }"""))
            context.close()

            context, page = start_card(14002001)
            equip_affix(page, "32142001")
            check("键盘确认装备真实321420012替换行一次", page.evaluate("window.kirafanRL.world.player.skills.slots[1].id") == 321420012
                  and len(events(page, "pickup")) == 1)
            page.evaluate("""()=>{
                const w=window.kirafanRL.world,p=w.player,e=window.__resetEnemy;
                Object.assign(p.base,{atk:100,mgc:100,def:100,mdef:100,luck:0}); p.nextAtkBonus=.6;
                e.debuffs=[{atk:.8,mgc:.5,remaining:30},{atk:-.3,mgc:-.2,mdef:-.25,remaining:30}];
                e.slow={pct:.2,remaining:30}; e.resists=[{element:(p.element+1)%6,pct:.2,remaining:30}];
            }""")
            advance(page, 1 / 60)
            point = page.evaluate("""()=>{
                const k=window.kirafanRL,e=window.__resetEnemy;
                const v=new k.camera.position.constructor(e.x,0,e.y).project(k.camera),r=k.renderer.domElement.getBoundingClientRect();
                return {x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2};
            }""")
            page.mouse.move(point["x"], point["y"])
            press(page, "Digit2")
            value_is(page, "enemy.atk", 750, "技能发射时尚未解除敌方能力提高")
            check("真实伤害技能仍使用10.5秒基础冷却", near(state(page)["cooldowns"][1], 10.5 - 1 / 60))
            equip_affix(page, None)
            check("在途弹等待装备确认后不跟随替换回原技能", page.evaluate("window.kirafanRL.world.player.skills.slots[1].id") == 140020001
                  and state(page)["enemy"]["hp"] == 100000 and len(events(page, "pickup")) == 2)
            page.evaluate("""()=>{
                const k=window.kirafanRL,p=k.world.player;
                for(let i=0;i<120;i++) {
                    k.step(1/60);
                    if(window.__resetEvents.some(e=>e.type==='hit' && e.target!==p.id)) return;
                }
                throw new Error('outgoing skill projectile did not hit');
            }""")
            value_is(page, "enemy.hp", 99688, "原作1.43系数在途弹固定造成312伤害")
            effect_or_control(lambda: value_is(page, "enemy.atk", 350, "命中后只解除物攻提高并保留30%降低"),
                              "同一敌物攻断言检出未清除的提高效果")
            effect_or_control(lambda: value_is(page, "enemy.mgc", 400, "命中后只解除魔攻提高并保留20%降低"),
                              "同一敌魔攻断言检出未清除的提高效果")
            check("命中后保留未选魔防、异常减速、耐性及次攻", near(state(page)["enemy"]["mdef"], 75)
                  and state(page)["enemy"]["slow"] is not None and len(state(page)["enemy"]["resists"]) == 1
                  and near(state(page)["nextAtk"], .6) and state(page)["gauge"] == 312)
            advance(page, .45)
            page.evaluate("Object.assign(window.kirafanRL.world.player.base,{def:100,mdef:100})")
            before_hp = state(page)["hp"]
            enemy_attack(page, 12011)
            effect_or_control(lambda: value_is(page, "hp", before_hp - 45, "敌人下一次真实物理攻击按解除后属性造成45点伤害"),
                              "同一后续承伤断言检出未解除时实际165点伤害")
            context.close()

            context, page = start_card()
            page.evaluate("window.kirafanRL.world.player.skills.applySelf({buff:{turns:10,atk:.5,mgc:-.3,mdef:.2,spd:.5}})")
            advance(page, 1 / 60)
            enemy_attack(page, 15017)
            value_is(page, "hp", 947, "敌方双取消器保持原有53点魔法命中")
            effect_or_control(lambda: value_is(page, "atk", 100, "六位旧格式解除物攻提高"), "同一物攻断言检出敌方解除载荷未生效")
            effect_or_control(lambda: value_is(page, "mgc", 100, "六位旧格式也解除魔攻降低"), "同一魔攻断言检出旧格式不能只解除提高")
            value_is(page, "mdef", 120, "敌方六位掩码不误删未选中的魔防提高")
            advance(page, .45)
            enemy_attack(page, 143002)
            effect_or_control(lambda: value_is(page, "mdef", 100, "敌方全能力解除同步刷新魔防"), "同一魔防断言检出敌方全解除无效")
            effect_or_control(lambda: value_is(page, "rate", 1, "敌方全能力解除同时恢复单倍技能恢复速度"), "同一恢复速度断言检出只改面板提示")
            context.close()

            context, page = start_card(36002001)
            press(page, "Digit3")
            page.evaluate("window.kirafanRL.world.player.skills.applySelf({buff:{turns:10,spd:-.5,atk:.2}})")
            advance(page, .45)
            value_is(page, "rate", 29 / 34, "晴海两层真实速度提高与50%降低同时存在")
            enemy_attack(page, 114074)
            effect_or_control(lambda: value_is(page, "rate", .5, "七位末项1仅解除速度提高且保留降低"),
                              "同一速度断言检出未清除晴海的提高效果")
            value_is(page, "atk", 120, "速度掩码保留未选中的物攻提高")
            advance(page, .45)
            before = state(page)
            advance(page, 1)
            after = state(page)
            effect_or_control(lambda: check("解除后冷却实际按固定半倍恢复", near(before["cooldowns"][2] - after["cooldowns"][2],
                              (after["time"] - before["time"]) * .5), [before, after]),
                              "同一冷却积分断言检出属性解除没有进入恢复管线")
            check("速度解除不改变移动速度", state(page)["speed"] == 3.5)
            if not args.probe:
                check("HUD只留下降低且没有空增益项", "技能恢复 ×0.50" in page.locator(".hud-effects").inner_text()
                      and "技能恢复-50%" in page.locator(".hud-effects").inner_text()
                      and "技能恢复+17.6%" not in page.locator(".hud-effects").inner_text())
                page.evaluate("""()=>{
                    const k=window.kirafanRL,w=k.world;
                    w.enterRoom(w.dungeon.rooms.find(r=>r.id!==w.room.id && r.type!=='boss').id); k.step(0);
                }""")
                check("换房沿既有边界清空能力而非留下永久解除状态", page.evaluate("""()=>{
                    const p=window.kirafanRL.world.player;return p.skills.buffs.length===0 && p.skills.cooldownRate===1;
                }"""))
            context.close()
            check("没有浏览器脚本异常", not errors, errors)
            browser.close()
            print("Stat-reset browser: %d checks passed" % len(checks), flush=True)
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
