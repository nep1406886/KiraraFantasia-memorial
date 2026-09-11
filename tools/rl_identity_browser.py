"""T25: select five real roster cards, operate skills, inspect feedback and reload.

Owns a port-0 server. Browser checks are serial; all storage is isolated.
"""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_result_browser import dismiss_dialogue

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "t25"
PROFILES = json.loads((ROOT / "docs/combat-identities.json").read_text(encoding="utf-8"))["profiles"]
WIDTHS = (375, 390, 412, 430, 768, 1280)
# The hand-written evidence file keeps historical IDs; the shipped roster
# uses current evolution IDs. Map them explicitly instead of editing evidence.
CURRENT_CARD_IDS = {15000000: 15002001, 23001000: 23002001, 20000000: 20002001,
                    29001000: 29002001, 19000000: 19002001}
checks = []


def check(label, ok, detail=None):
    if not ok:
        raise AssertionError(label + (": " + str(detail) if detail is not None else ""))
    checks.append(label)
    print("PASS " + label, flush=True)


def press(page, key, seconds=0.65):
    page.evaluate("window.kirafanRL.world.frozen = false")
    ultimate = key == "Digit1"
    if ultimate:
        page.evaluate("""() => {const p=window.kirafanRL.world.player;
            p.skills.addGauge(p.skills.gaugeMax);}""")
    page.keyboard.down(key)
    page.evaluate("window.kirafanRL.step(1/60)")
    page.keyboard.up(key)
    page.evaluate("""seconds => {
        const k = window.kirafanRL;
        for (let i = 0; i < Math.ceil(seconds*60); i++) k.step(1/60);
        k.world.frozen = true;
    }""", seconds)
    if ultimate:
        page.wait_for_function("!window.kirafanRL.ultimate.loading", timeout=60000)
        page.evaluate("""() => {const k=window.kirafanRL;
            k.skipUltimate();k.world.frozen=false;
            for(let i=0;i<40;i++)k.step(1/60);k.world.frozen=true;}""")


def aim_at_foe(page):
    point = page.evaluate("""() => {
        const k=window.kirafanRL, e=window.t25Foe;
        const v=new k.camera.position.constructor(e.x, 0, e.y).project(k.camera);
        const r=k.renderer.domElement.getBoundingClientRect();
        return {x:r.left+(v.x+1)*r.width/2, y:r.top+(1-v.y)*r.height/2};
    }""")
    page.mouse.move(point["x"], point["y"])


def prepare(page, distance=3):
    page.evaluate("""distance => {
        const k=window.kirafanRL, w=k.world, p=w.player;
        w.frozen=true;
        p.base.luck=0; p.luck=0; p.iframes=0;
        w.aim=null; p.facing=0;
        const art=w.encounter.mobs[0];
        window.t25Foe=w.spawnEnemy({x:p.x+distance,y:p.y,hp:1000000,
            atk:100,mgc:100,def:0,mdef:0,luck:0,
            model:art.model,nameZh:art.nameZh,shadowScale:art.shadowScale});
        w.enemies.forEach(e=>e.actionTimer=1e9);
        k.step(1/60);
    }""", distance)
    page.wait_for_function("window.kirafanRL.pending === 0", timeout=30000)
    aim_at_foe(page)


def fire_at_player(page):
    return page.evaluate("""() => {
        const k=window.kirafanRL,w=k.world,p=w.player,e=window.t25Foe;
        const before=p.hp;
        p.iframes=0;
        w.danmaku.emit('aimed',{x:e.x,y:e.y,angle:Math.atan2(p.y-e.y,p.x-e.x)},
            {side:'enemy',power:1000,coef:1,magic:false,count:1,speed:10,life:4,srcId:e.id});
        w.frozen=false;
        for(let i=0;i<80;i++) k.step(1/60);
        w.frozen=true;
        return before-p.hp;
    }""")


def feedback(page):
    return page.locator(".hud-effects").inner_text()


def start(page, url, profile):
    page.goto(url, wait_until="load", timeout=60000)
    page.wait_for_selector(".roster-card", timeout=40000)
    page.locator(".roster-card").filter(has_text=profile["name"]).first.click()
    page.wait_for_function("window.kirafanRL?.world?.player && window.kirafanRL.views.player", timeout=40000)
    dismiss_dialogue(page)
    page.evaluate("window.kirafanRL.world.frozen=true")
    current_id = CURRENT_CARD_IDS[profile["cardId"]]
    check(profile["name"] + " selected through roster",
          page.evaluate("window.kirafanRL.world.player.card.id") == current_id)
    check(profile["name"] + " rendered model has meshes", page.evaluate("""() => {
        const a=window.kirafanRL.actor(); if(!a) return false;
        let n=0; a.object.traverse(o=>{if(o.isMesh) n++;}); return n>0;
    }"""))


def skill_sheet(page, expected):
    # The menu reads input outside the frozen world, matching normal pause use.
    press(page, "Escape", 0.05)
    page.locator("#menu-skills").click()
    page.wait_for_selector("#rl-skillcard")
    names = page.locator("#rl-skillcard .skname-text").all_text_contents()
    words = page.locator("#rl-skillcard .skwords").all_text_contents()
    check("skill sheet has four nonempty names", len(names) == 4 and all(names))
    check("skill sheet describes " + expected, expected in " ".join(words), words)
    check("original text is explicitly labelled",
          "实际效果见词条" in page.locator("#rl-skillcard summary").first.inner_text())


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    server = Server(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=1&seed=250907" % server.server_address[1]
    errors = []
    completed = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                               "--autoplay-policy=no-user-gesture-required"])
            version = browser.version
            for profile in PROFILES:
                context = browser.new_context(viewport={"width": 1280, "height": 800})
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                start(page, url, profile)
                cls = profile["class"]
                prepare(page, 1.3 if cls == 0 else 4)

                if cls == 0:
                    bonus = page.evaluate("window.kirafanRL.world.player.skills.slots[2].nextAtk")
                    check("warrior skill 3 declares a next-attack bonus", bonus > 0, bonus)
                    press(page, "KeyJ")
                    base_damage = page.evaluate("1000000-window.t25Foe.hp")
                    check("warrior unboosted hit lands", base_damage > 0, base_damage)
                    page.evaluate("window.t25Foe.hp = 1000000")
                    press(page, "Digit3")
                    check("warrior pending bonus is visible", ("次攻 +" + str(round(bonus * 100)) + "%") in feedback(page), feedback(page))
                    page.screenshot(path=str(OUT / "warrior-status-1280.png"))
                    expected = round(base_damage * (1 + bonus))
                    press(page, "KeyJ")
                    damage = page.evaluate("1000000-window.t25Foe.hp")
                    check("warrior real key consumes one boosted hit", abs(damage - expected) <= 1, {"damage": damage, "expected": expected})
                    check("consumed status disappears", "次攻" not in feedback(page))
                    skill_sheet(page, "下次普攻 +" + str(round(bonus * 100)) + "%")
                    for width in WIDTHS:
                        page.set_viewport_size({"width": width, "height": 812 if width < 500 else 800})
                        page.wait_for_timeout(120)
                        fits = page.evaluate("""() => {
                            const w=document.documentElement.clientWidth;
                            const sheet=document.querySelector('#rl-skillcard .sheet').getBoundingClientRect();
                            const close=document.querySelector('#rl-skillcard .close-row button').getBoundingClientRect();
                            return document.documentElement.scrollWidth<=w+1 && sheet.left>=-1 && sheet.right<=w+1
                                && close.left>=0 && close.right<=w+1;
                        }""")
                        check("skill sheet fits width " + str(width), fits)
                        if width in (375, 1280):
                            page.screenshot(path=str(OUT / ("skills-%d.png" % width)))
                    # Resume through the real menu, prepare another pending buff,
                    # save and reload: transient state must not be serialized.
                    press(page, "Escape", 0.05)
                    press(page, "Escape", 0.05)
                    page.evaluate("""() => { const k=window.kirafanRL; k.world.frozen=false;
                        for(let i=0;i<600;i++) k.step(1/60); k.world.frozen=true; }""")
                    press(page, "Digit3")
                    check("reload fixture has a live pending buff", page.evaluate("window.kirafanRL.world.player.nextAtkBonus") == bonus)
                    page.evaluate("window.dispatchEvent(new Event('pagehide'))")
                    check("run snapshot exists before reload", page.evaluate("!!JSON.parse(localStorage.getItem('kirafan-rl:profile')).run"))
                    page.reload(wait_until="load")
                    page.wait_for_selector("#roster-continue", timeout=40000)
                    page.locator("#roster-continue").click()
                    page.wait_for_function("window.kirafanRL.world.player", timeout=40000)
                    check("reload restores no temporary buff", page.evaluate("""() => {
                        const p=window.kirafanRL.world.player;
                        return !p.nextAtkBonus && !p.regen && !p.skills.barrier && p.skills.buffs.length===0;
                    }"""))
                elif cls == 1:
                    # Current table: class skill 2 (index 1) is an all-target
                    # attack, skill 3 (index 2) grants the next-attack bonus.
                    # Skill assertions run before the normal-attack probe so a
                    # leftover swing/ultimate bullet cannot mask the ring hit.
                    press(page, "Digit1", 1.6)
                    check("mage original all-target ultimate connects", page.evaluate("window.t25Foe.hp") < 1000000)
                    page.evaluate("window.t25Foe.hp = 1000000")
                    press(page, "Digit2")
                    page.evaluate("""() => { const k = window.kirafanRL; k.world.frozen = false;
                        for (let i = 0; i < 300; i++) k.step(1/60); k.world.frozen = true; }""")
                    check("mage class skill 2 hits the prepared foe", page.evaluate("window.t25Foe.hp") < 1000000,
                          page.evaluate("window.t25Foe.hp"))
                    page.evaluate("window.t25Foe.hp = 1000000")
                    press(page, "KeyJ")
                    check("mage normal attack cannot reach four units", page.evaluate("window.t25Foe.hp") == 1000000,
                          page.evaluate("window.t25Foe.hp"))
                    declared = page.evaluate("window.kirafanRL.world.player.skills.slots[2].nextAtk || 0")
                    press(page, "Digit3", 0.05)
                    granted = page.evaluate("window.kirafanRL.world.player.nextAtkBonus || 0")
                    check("mage skill 3 grants its declared next-attack bonus",
                          declared > 0 and abs(granted - declared) < 1e-9, {"declared": declared, "granted": granted})
                    skill_sheet(page, "下次普攻")
                elif cls == 2:
                    # Current table: skill 2 (index 1) is an all-target attack,
                    # skill 3 (index 2) is a timed self buff read from data.
                    press(page, "Digit2")
                    page.evaluate("""() => { const k = window.kirafanRL; k.world.frozen = false;
                        for (let i = 0; i < 300; i++) k.step(1/60); k.world.frozen = true; }""")
                    check("cleric class skill 2 hits the prepared foe", page.evaluate("window.t25Foe.hp") < 1000000,
                          page.evaluate("window.t25Foe.hp"))
                    press(page, "Digit3")
                    check("cleric timed buff is visible", "魔攻+30%" in feedback(page), feedback(page))
                    skill_sheet(page, "魔攻+30%")
                    before = page.evaluate("JSON.stringify(window.kirafanRL.world.player.skills.buffs)")
                    page.wait_for_timeout(450)
                    check("pause overlay freezes buff timers", page.evaluate("JSON.stringify(window.kirafanRL.world.player.skills.buffs)") == before)
                elif cls == 3:
                    press(page, "Digit1")
                    check("knight shield charge is visible", "护盾 100%" in feedback(page), feedback(page))
                    hits = page.evaluate("window.kirafanRL.world.player.skills.barrier.hits")
                    check("knight shield declares its charges", hits > 0, hits)
                    for index in range(hits):
                        check("knight charge " + str(index + 1) + " blocks the projectile", fire_at_player(page) == 0)
                    check("shield status disappears after all charges", "护盾" not in feedback(page))
                    check("knight next projectile does damage", fire_at_player(page) > 0)
                    skill_sheet(page, "护盾 100%")
                else:
                    # Current table: both class skills are timed self buffs
                    # (defence / dual defence), no enemy debuff rows remain.
                    before = page.evaluate("window.kirafanRL.world.player.atk")
                    press(page, "Digit1")
                    check("alchemist skill 2 leaves own attack intact",
                          page.evaluate("window.kirafanRL.world.player.atk") == before)
                    check("alchemist skill 2 grants a timed defence buff",
                          page.evaluate("window.kirafanRL.world.player.skills.buffs.some(b => (b.def || 0) > 0)"),
                          feedback(page))
                    press(page, "Digit3")
                    check("alchemist skill 3 grants dual defence buffs",
                          page.evaluate("""() => {
                              const b = window.kirafanRL.world.player.skills.buffs;
                              return b.some(x => (x.def || 0) > 0) && b.some(x => (x.mdef || 0) > 0);
                          }"""), feedback(page))
                    skill_sheet(page, "物防+35%")
                completed.append(profile["cardId"])
                context.close()

            # Actual touch input, with the same actor and semantics as desktop.
            # Landscape: the orientation guard hides the roster in portrait.
            context = browser.new_context(viewport={"width": 844, "height": 390},
                                          is_mobile=True, has_touch=True, device_scale_factor=1)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            start(page, url, PROFILES[0])
            prepare(page, 1.3)
            page.evaluate("window.kirafanRL.world.frozen=false")
            page.locator('.hud-skill[data-slot="2"]').tap()
            page.evaluate("""() => {const k=window.kirafanRL;for(let i=0;i<40;i++)k.step(1/60);k.world.frozen=true;}""")
            check("touch skill sets the same pending bonus", page.evaluate(
                "window.kirafanRL.world.player.nextAtkBonus") == page.evaluate(
                "window.kirafanRL.world.player.skills.slots[2].nextAtk"))
            check("mobile status fits viewport", page.evaluate("document.querySelector('.hud-effects').getBoundingClientRect().right <= document.documentElement.clientWidth"))
            page.screenshot(path=str(OUT / "warrior-status-375.png"))
            context.close()
            check("no browser exceptions", not errors, errors)
            browser.close()
            report = {"status": "PASS", "profiles": completed, "widths": WIDTHS,
                      "touch": "Chromium mobile emulation", "browser": version,
                      "checks": checks, "errors": errors}
            (OUT / "identity-browser.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print("T25 browser: %d checks passed" % len(checks), flush=True)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
