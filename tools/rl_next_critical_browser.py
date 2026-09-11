"""T30 kind 12: browser acceptance for the real type-8 weapon child and forced critical delivery.

The browser uses manually advanced simulation. The HTTP probe removes only the shared
forced-critical branch in combat.js; it leaves state, UI, normal attack amplification,
and all other delivery code intact.
"""
import argparse
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_recovery_browser import advance, dismiss, press
from rl_floor_loot_browser import ready

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "t30-next-critical"
WIDTHS = (375, 390, 412, 430, 768, 1280)
FILES = ['site/game/rl/' + name for name in ['skills.js', 'world.js', 'combat.js', 'equipment.js', 'main.js',
    'nextcritical.js', 'gadgets.js', 'danmaku.js', 'ui/infocard.js', 'ui/hud.js', 'ui/decisions.js',
    'ui/equipmentskills.js', 'ui/equipmentbrief.js', 'ui/skilltooltip.js', 'ui/theme.css']]


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    checks, errors, measurements = [], [], []
    report = {"checks": checks, "errors": errors, "measurements": measurements,
              "manualSimulation": True, "probe": args.probe, 'before': fingerprints(),
              'fixtures': ['固定攻防100/零随机暴击', '高生命静止敌人', '原作32032001地面候选', 'R量能填满用于验证入口']}

    def check(label, condition, detail=None):
        if not condition:
            raise AssertionError(label + ": " + str(detail))
        checks.append(label)
        print("PASS " + label, flush=True)

    def near(a, b):
        return abs(a - b) < 1e-7

    def state(page):
        return page.evaluate("""() => {
            const w=window.kirafanRL.world,p=w.player,s=p.skills;
            return {time:w.time,hp:p.hp,maxHp:p.maxHp,atk:p.atk,mgc:p.mgc,def:p.def,mdef:p.mdef,
                speed:p.speed,card:p.card?.id,next:p.nextCritical,nextAtk:p.nextAtkBonus,
                gauge:s.gauge,cooldowns:s.slots.map(x=>x.remaining),normal:s.normal?.id,
                slots:s.slots.map(x=>x.id),enemy:window.__criticalEnemy?.hp,
                enemyDebuffs:window.__criticalEnemy?.debuffs,
                frozen:w.frozen,hitStop:w.hitStop,action:p.sm.state,actionTime:p.sm.stateTime,
                pending:window.kirafanRL.pending,barrier:s.barrier};
        }""")

    def events(page):
        return page.evaluate("window.__criticalEvents || []")

    def start_card(page, card_id=14002001):
        page.wait_for_selector(".roster-card", timeout=60000)
        selected = page.locator(".roster-card").filter(
            has=page.locator('img[src$="/%d.webp"]' % card_id))
        check(str(card_id) + " 正常选角入口唯一可达", selected.count() == 1)
        selected.click()
        ready(page)
        check(str(card_id) + " 保留真实进化卡身份", page.evaluate("window.kirafanRL.world.player.card.id") == card_id)
        page.evaluate("""() => {
            const k=window.kirafanRL,w=k.world,p=w.player,art=w.encounter.mobs[0];
            Object.assign(p,{x:w.width/2,y:w.height/2,maxHp:1000,hpOverride:1000,hp:1000,iframes:1e9});
            Object.assign(p.base,{atk:100,mgc:100,def:100,mdef:100,luck:0});
            Object.assign(p,{atk:100,mgc:100,def:100,mdef:100,luck:0,critBonus:0,critDamage:0});
            w.rng=()=>.99;
            const e=w.spawnEnemy({x:p.x+1.4,y:p.y,hp:100000,atk:100,mgc:100,def:100,mdef:100,
                element:p.element,model:art.model,nameZh:art.nameZh,shadowScale:art.shadowScale,
                aiType:'sentry'}); e.actionTimer=1e9; window.__criticalEnemy=e;
            window.__criticalEvents=[];
            const drain=w.drainEvents,seen=new WeakSet();
            w.drainEvents=function(){
                const list=drain();
                for(const e of list) if(!seen.has(e) &&
                    ['skill','playerShot','hit','heal','ultimateSpent','nextCritical','pickup','room'].includes(e.type)){
                    seen.add(e); window.__criticalEvents.push({type:e.type,action:e.action,
                        slot:e.slot,skill:e.skill?.id,damage:e.damage,crit:e.crit,
                        target:e.target?.id,unit:e.unit?.id,
                        bullets:e.bullets,card:e.card?.id,x:e.unit?.x,y:e.unit?.y});
                }
                return list;
            };
        }""")
        ready(page)

    def equip(page, affix):
        before = page.evaluate("""affix => {
            const k=window.kirafanRL,w=k.world,p=w.player;
            const item={slot:'armor',rarity:'rare',affixes:affix?[affix]:[]};
            const drop={x:p.x,y:p.y,items:[item]};
            const old=JSON.stringify([p.equipment,p.nextCritical,p.skills.slots.map(s=>s.id)]);
            w.drops.push(drop);w.events.push({type:'drop',drop,items:drop.items,x:drop.x,y:drop.y});
            k.step(1/60);return {old,item};
        }""", affix)
        page.wait_for_selector("#rl-equipment-choice", timeout=30000)
        check("装备比较不提前修改必暴状态或技能槽", page.evaluate("""before => {
            const p=window.kirafanRL.world.player;
            return JSON.stringify([p.equipment,p.nextCritical,p.skills.slots.map(s=>s.id)])===before;
        }""", before["old"]), state(page))
        if affix:
            page.locator('#rl-equipment-choice .equipment-more > summary').click()
            words = page.locator("#rl-equipment-choice").inner_text()
            check("比较界面披露必暴、普攻强化和即时冷却变化", all(word in words for word in ['必定暴击', '下次普攻 +35%', '立即缩短', '本次施放']))
            page.screenshot(path=str(OUT / 'critical-equipment-preview.png'))
        page.locator("#equipment-confirm").focus()
        page.keyboard.press("Enter")
        advance(page, 1 / 60)
        check("装备确认后实际替换为320320013", page.evaluate("window.kirafanRL.world.player.skills.slots[2].id") == 320320013)
        page.evaluate("""() => {
            const p=window.kirafanRL.world.player;
            const stats={hp:1000,atk:100,mgc:100,def:100,mdef:100,spd:100,luck:0};
            Object.assign(p.truthBase,stats); Object.assign(p.base,stats);
            Object.assign(p,{maxHp:1000,hp:1000,atk:100,mgc:100,def:100,mdef:100,spd:100,luck:0,critBonus:0,critDamage:0});
        }""")

    def wait_hits(page, count=1, seconds=1.5):
        for _ in range(int(seconds * 60)):
            advance(page, 1 / 60)
            if len([e for e in events(page) if e["type"] == "hit" and e.get("target") == page.evaluate("window.__criticalEnemy.id")]) >= count:
                break
        return events(page)

    def wait_ready(page, index=2):
        # Recover through the real clock; never zero a cooldown to bypass repeated casts.
        # A landed hit pauses the world before skills.update, so a prediction in
        # active seconds alone is insufficient. Bound the actual fixed-step wait.
        measured = page.evaluate('''i=>{
            const k=kirafanRL,w=k.world,s=w.player.skills;
            const before={time:w.time,remaining:s.slots[i].remaining,seconds:s.cooldownSeconds(i)};
            const limit=Math.ceil((Math.max(0,before.seconds)+2)*60);
            let frames=0,hitStopFrames=0;
            while(!s.ready(i)&&frames<limit){
                if(w.hitStop>0)hitStopFrames++;
                k.step(1/60);frames++;
            }
            return {before,frames,hitStopFrames,limit,ready:s.ready(i),
                after:{time:w.time,remaining:s.slots[i].remaining}};
        }''', index)
        measurements.append({'action':'wait-ready','slot':index,**measured})
        check('真实时钟恢复技能就绪 ' + str(index + 1), measured['ready'], {'wait':measured,'state':state(page)})

    def arm(page):
        press(page, "Digit3")
        check("真实320320013施放后同时保留35%普攻强化和待用必暴", state(page)["next"] is True and near(state(page)["nextAtk"], .35))
        check("每次必暴技能冷却均为真实11.2秒，不叠加减免", near(state(page)["cooldowns"][2], 11.2 - 1 / 60), state(page)["cooldowns"])

    def aim_enemy(page):
        point = page.evaluate("""async()=>{const k=kirafanRL,e=__criticalEnemy;
            const {COMBAT_HEIGHT}=await import('/site/game/rl/view/layers.js');
            const r=k.renderer.domElement.getBoundingClientRect();k.camera.updateMatrixWorld();
            const p=k.camera.position.clone().set(e.x,COMBAT_HEIGHT,e.y).project(k.camera);
            return {x:r.left+(p.x+1)*r.width/2,y:r.top+(1-p.y)*r.height/2};}""")
        page.mouse.move(point['x'], point['y']); advance(page, 1/60)
        check('真实鼠标瞄准敌人而非确认按钮位置', page.evaluate("""()=>{const w=kirafanRL.world;
            return w.aim && Math.hypot(w.aim.x-__criticalEnemy.x,w.aim.y-__criticalEnemy.y)<.03;}"""))

    def clear_enemy(page):
        page.evaluate("""() => { const e=window.__criticalEnemy,p=kirafanRL.world.player;
            e.x=p.x+1.4;e.y=p.y;e.hp=100000;e.dead=false;e.iframes=0;e.sm.force('idle');e.actionTimer=1e9; }""")
        page.evaluate("window.__criticalEvents=[]")

    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    pw = None
    try:
        # Keep the driver alive until the outer failure evidence is captured.
        pw = sync_playwright().start()
        browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                           "--autoplay-policy=no-user-gesture-required"])
        report["browser"] = browser.version
        context = browser.new_context(viewport={"width":1280,"height":840}, has_touch=True)
        context.add_init_script("""window.requestAnimationFrame=()=>0; window.cancelAnimationFrame=()=>{};
            if(!localStorage.getItem('kirafan-rl:profile'))localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        if args.probe:
            source = (ROOT / "site/game/rl/combat.js").read_text(encoding="utf-8")
            needle = "if (forceCritical === true) return true;"
            assert source.count(needle) == 1, "critical probe injection point changed"
            page.route("**/rl/combat.js", lambda route: route.fulfill(content_type="text/javascript",
                body="window.__criticalProbeLoaded=true;\n" + source.replace(needle, "if (forceCritical === true) return false;")))
        page.goto(base + "/site/game/roguelike.html?volume=1&seed=300913", wait_until="load", timeout=60000)
        start_card(page)
        equip(page, "32032001")
        check("装备名和人物卡保留当前身份", page.evaluate("window.kirafanRL.world.player.card.id") == 14002001)
        page.evaluate("window.__criticalEvents=[]")
        if args.probe:
            check("负面对照只撤掉强制暴击判定", page.evaluate("window.__criticalProbeLoaded===true"))
        arm(page)
        # The real skill owns the same attack state for its authored cast
        # window; wait for that action to finish before testing the next input.
        advance(page, .5)
        aim_enemy(page)
        press(page, "KeyJ")
        advance(page, .1)
        result = wait_hits(page)
        player_hits = [e for e in result if e["type"] == "hit" and e.get("target") == page.evaluate("window.__criticalEnemy.id")]
        check("近战普攻有效攻击窗口产生一次命中", len(player_hits) >= 1, result)
        check("近战命中伤害为243且事件标记暴击", player_hits[0]["damage"] == 243 and player_hits[0]["crit"] is True, player_hits[0])
        measurements.append({'action':'normal','hit':player_hits[0],'state':state(page)})
        check("近战出手后必暴只消费一次", state(page)["next"] is False and len([e for e in result if e["type"] == "nextCritical" and e.get("action") == "used"]) == 1)
        check("近战命中后消费kind11普攻强化", near(state(page)["nextAtk"], 0))
        clear_enemy(page)
        # Re-arm through the real weapon skill before testing ordinary skill delivery.
        wait_ready(page)
        arm(page)
        advance(page, .5); aim_enemy(page)
        page.evaluate("window.__criticalEvents=[]")
        page.keyboard.down("Digit2"); advance(page, 1 / 60); page.keyboard.up("Digit2"); advance(page, 1 / 60)
        check('普通技能每次从真实10.5秒冷却开始', near(state(page)['cooldowns'][1], 10.5-1/60), state(page))
        check("普通伤害技能出手前没有误消费kind11", near(state(page)["nextAtk"], .35))
        result = wait_hits(page)
        player_hits = [e for e in result if e["type"] == "hit" and e.get("target") == page.evaluate("window.__criticalEnemy.id")]
        check("普通技能真实命中仍为498点强制暴击", len(player_hits) >= 1 and player_hits[0]["damage"] == 498 and player_hits[0]["crit"] is True, player_hits[0] if player_hits else result)
        measurements.append({'action':'skill','hit':player_hits[0],'state':state(page)})
        check("普通技能出手消费必暴但不消费kind11", state(page)["next"] is False and near(state(page)["nextAtk"], .35))
        # HUD and sheet are checked before going through the ultimate path.
        press(page, 'Escape')
        page.locator("#menu-skills").click()
        sheet = page.locator("#rl-skillcard").inner_text()
        check("人物卡明确区分必暴与普攻强化", all(text in sheet for text in ["下次普攻 +35%（命中后消耗）", "下次伤害行动必定暴击", "普通技能", "必杀", "技能卡不使用", "不利属性仍可暴击"]))
        close = page.locator("#rl-skillcard .close-row button"); close.click(); advance(page, 1 / 60)
        page.locator('#menu-resume').click(); advance(page, 1 / 60)
        # Re-arm through the real weapon skill before testing the ultimate path.
        clear_enemy(page)
        wait_ready(page)
        arm(page)
        advance(page, .5)
        check('前招防御降低仍在，必杀采用90有效防御', page.evaluate('''()=>{
            const e=__criticalEnemy,delta=(e.debuffs||[]).reduce((sum,b)=>sum+(b.def||0),0);
            return e.def===100&&Math.abs(delta+.1)<1e-8;
        }'''), state(page))
        page.evaluate("window.kirafanRL.world.player.skills.addGauge(1e9); window.__criticalEvents=[]")
        press(page, "KeyR")
        page.wait_for_function("!window.kirafanRL.ultimate.loading", polling=100, timeout=60000)
        if page.locator(".rl-ultimate-skip").is_visible(): page.locator(".rl-ultimate-skip").click()
        advance(page, .5)
        result = events(page)
        player_hits = [e for e in result if e["type"] == "hit" and e.get("target") == page.evaluate("window.__criticalEnemy.id")]
        check("必杀路径命中并只消费一次必暴", len(player_hits) >= 1 and player_hits[0]["crit"] is True
              and state(page)["next"] is False and len([e for e in result if e['type']=='nextCritical' and e.get('action')=='used']) == 1, player_hits)
        # Original 3.01 coefficient: round(100*3.01*2.6*1.5 - 90*.6) = 1120.
        check('必杀一次命中1120且不消耗35%普攻强化', len(player_hits) == 1
              and player_hits[0]['damage'] == 1120 and near(state(page)['nextAtk'], .35), player_hits)
        measurements.append({'action':'ultimate','hits':player_hits,'state':state(page)})
        # Touch input plus six-width layout and focus reachability.
        page.set_viewport_size({"width":844,"height":390})
        wait_ready(page)
        page.touchscreen.tap(400, 100); advance(page, 1 / 60)
        page.locator('.hud-skill[data-slot="2"]').tap()
        advance(page, 1/60)
        check("真实触控施放必暴技能且仍是完整冷却", state(page)['next'] is True and near(state(page)['cooldowns'][2],11.2), state(page))
        page.screenshot(path=str(OUT / 'critical-touch.png'))
        page.locator('.hud-pause').tap(); advance(page, 1 / 60)
        page.locator('#menu-skills').tap()
        for width in WIDTHS:
            page.set_viewport_size({"width":width,"height":812 if width < 500 else 840})
            page.locator('#rl-skillcard .sheet').wait_for(state='visible')
            fits = page.locator("#rl-skillcard .sheet").evaluate("""el => { const r=el.getBoundingClientRect(),b=el.querySelector('.close-row button').getBoundingClientRect(); return document.documentElement.scrollWidth<=innerWidth+1 && r.left>=0 && r.right<=innerWidth+1 && b.bottom<=innerHeight && b.left>=0; }""")
            check("人物卡六宽度可达 " + str(width), fits)
            if width in [390,1280]: page.screenshot(path=str(OUT/('skill-sheet-'+str(width)+'.png')))
        page.locator('#rl-skillcard .close-row button').click(); page.locator('#menu-resume').click(); advance(page, 1 / 60)
        check("没有浏览器脚本异常", not errors, errors)
        check('验证期间产品源文件未变', report['before']==fingerprints())
        context.close(); browser.close()
    except Exception as error:
        report["failure"] = str(error)
        if 'page' in locals() and not page.is_closed():
            try:
                report['failureState'] = state(page)
                page.screenshot(path=str(OUT / ('failure-probe.png' if args.probe else 'failure.png')))
            except Exception as diagnostic_error:
                report['diagnosticError'] = str(diagnostic_error)
        raise
    finally:
        if pw is not None:
            pw.stop()
        report['after'] = fingerprints()
        (OUT / ("browser-probe.json" if args.probe else "browser.json")).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
        server.shutdown(); server.server_close(); worker.join(timeout=2)


if __name__ == "__main__":
    main()
