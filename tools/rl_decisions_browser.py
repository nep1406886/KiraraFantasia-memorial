"""T26: real camp, comparison, shop and supply workflows with reload checks."""
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_result_browser import dismiss_dialogue, slot
from rl_floor_loot_browser import ready

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "t26"
WIDTHS = (375, 390, 412, 430, 768, 1280)
checks = []
FILES = ['site/game/rl/' + name for name in ['main.js', 'world.js', 'equipment.js', 'skills.js',
    'roomevents.js', 'runschema.js', 'profileschema.js', 'ui/decisions.js', 'ui/equipmentskills.js', 'ui/equipmentbrief.js', 'ui/theme.css']]


def fingerprints():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in FILES}


def check(label, condition, detail=None):
    if not condition:
        raise AssertionError(label + ": " + str(detail))
    checks.append(label)
    print("PASS " + label, flush=True)


def settle(page):
    ready(page)
    page.wait_for_function('!kirafanRL.world.frozen', timeout=60000)


def press(page, key):
    page.keyboard.down(key)
    page.evaluate("window.kirafanRL.step(1/60)")
    page.keyboard.up(key)
    page.evaluate("window.kirafanRL.step(1/60)")


def enter(page, room_type):
    page.evaluate("""type => {
        const k=window.kirafanRL,w=k.world;
        const room=w.dungeon.rooms.find(r=>r.type===type);
        if(!room) throw new Error('missing room '+type);
        w.enterRoom(room.id); k.step(1/60);
    }""", room_type)
    settle(page)


def drop(page, invalid=False):
    return page.evaluate("""async invalid => {
        const k=window.kirafanRL,w=k.world,p=w.player;
        const data=await fetch('../asset/rl/weapons-rl.json').then(r=>r.json());
        const id=Object.keys(data.passives).find(id=>data.passives[id].effects.some(
            e=>e.type===0 && e.trigger===0 && e.args[0]>0));
        if(!id) throw new Error('no real attack affix');
        const before=JSON.stringify([p.hp,p.base,p.equipment,p.skills.gauge]);
        const weapon=data.catalog.find(row=>row.charaId<0 && row.class===p.card.class && row.rare===4);
        if(!weapon) throw new Error('no eligible native weapon');
        window.t26Weapon=weapon;
        window.t26Drop={x:p.x,y:p.y,items:[{slot:'weapon',rarity:'rare',catalogId:weapon.id,affixes:[invalid?'missing':id]}]};
        w.drops.push(window.t26Drop);
        w.events.push({type:'drop',drop:window.t26Drop,items:window.t26Drop.items,x:p.x,y:p.y});
        window.t26Expected=w.previewEquipment(window.t26Drop.items[0]);
        k.step(1/60);
        return before;
    }""", invalid)


def frame_fits(page, selector):
    return page.locator(selector).evaluate("""el => {
        const r=el.getBoundingClientRect();
        return r.left>=0 && r.top>=0 && r.right<=innerWidth+1 && r.bottom<=innerHeight+1
            && el.scrollWidth<=el.clientWidth+1;
    }""")


def expand_comparison(page, touch=False):
    details = page.locator('#rl-equipment-choice .equipment-more')
    if details.get_attribute('open') is None:
        summary = details.locator(':scope > summary')
        if touch:
            summary.tap()
        else:
            summary.click()


def wait_visible_catalog_art(page):
    # The tab panel is the scroller. The list itself is deliberately unbounded;
    # requiring every lazy image inside that full list waits on off-screen art.
    page.wait_for_function("""() => {
        const panel=document.querySelector('#equipment-tab-content'),box=panel.getBoundingClientRect();
        const images=[...panel.querySelectorAll('.weapon-entry > summary > img')].filter(img=>{
            const r=img.getBoundingClientRect();
            return r.height>0 && r.bottom>box.top && r.top<box.bottom;
        });
        return images.length>0 && images.every(img=>img.complete && img.naturalWidth>0);
    }""")


def nonweapon_workflows(page):
    # Deterministic candidates isolate rendering/confirmation/persistence; loot
    # probability is covered by the logic harness, not these injected offers.
    for kind in ("amulet", "armor", "charm"):
        before = page.evaluate("""kind => {
            const k=window.kirafanRL,w=k.world,p=w.player;
            const item={slot:kind,rarity:'rare',affixes:[]};
            window.iconDrop={x:p.x+(p.x>=w.width/2?-2.5:2.5),y:p.y,items:[item]};
            window.iconExpected=w.previewEquipment(item);
            w.drops.push(iconDrop);
            w.events.push({type:'drop',drop:iconDrop,items:iconDrop.items,x:iconDrop.x,y:iconDrop.y});
            k.step(1/60);
            return JSON.stringify([p.hp,p.base,p.equipment,p.skills.gauge]);
        }""", kind)
        suffix = "/equipment/slot-" + kind + ".svg"
        page.wait_for_function("""suffix => window.kirafanRL.scene.children.some(s=>
            s.userData.weaponIcon?.endsWith(suffix) && s.children[0]?.material.map.image?.width>0)""", arg=suffix)
        pixels = page.evaluate("""suffix => {
            const k=window.kirafanRL,s=k.scene.children.find(s=>s.userData.weaponIcon?.endsWith(suffix));
            const image=s.children[0],gl=k.renderer.getContext(),n=gl.drawingBufferWidth*gl.drawingBufferHeight*4;
            function read(){k.renderOnce();const b=new Uint8Array(n);
                gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,b);return b;}
            image.visible=false;const before=read();image.visible=true;const after=read();
            let changed=0;for(let i=0;i<n;i+=4)if(before[i]!==after[i]||before[i+1]!==after[i+1]||before[i+2]!==after[i+2])changed++;
            return {changed,untinted:image.material.color.getHex()===0xffffff};
        }""", suffix)
        check(kind + " ground icon contributes untinted GPU pixels", pixels["changed"] > 20 and pixels["untinted"], pixels)
        page.screenshot(path=str(OUT / (kind + "-drop-1280.png")))
        page.evaluate("""() => {const k=window.kirafanRL;k.world.player.x=iconDrop.x;k.step(1/60)}""")
        page.wait_for_function("document.querySelector('#rl-equipment-choice .comparison-summary-icon')?.naturalWidth>0")
        check(kind + " comparison shows its own slot art", page.locator("#rl-equipment-choice .comparison-summary-icon").first.get_attribute("src").endswith(suffix))
        page.keyboard.press("Escape")
        check(kind + " cancel preserves stats and candidate", page.evaluate("""() => {
            const w=window.kirafanRL.world,p=w.player;
            return w.drops.includes(iconDrop) && JSON.stringify([p.hp,p.base,p.equipment,p.skills.gauge]);
        }""") == before)
        page.evaluate("""() => {const k=window.kirafanRL,p=k.world.player;p.x-=2.5;k.step(1/60);p.x=iconDrop.x;k.step(1/60)}""")
        page.locator("#equipment-confirm").click()
        page.evaluate("window.kirafanRL.step(1/60)")
        check(kind + " confirmation consumes once and matches preview", page.evaluate("""kind => {
            const w=window.kirafanRL.world;return !w.drops.includes(iconDrop)
                && w.player.equipment.filter(i=>i.slot===kind).length===1
                && JSON.stringify(w.player.base)===JSON.stringify(iconExpected.candidate);
        }""", kind))

    enter(page, "shop")
    # Exercise a non-weapon purchase in a remaining stock slot.
    coin = page.evaluate("""() => {const w=window.kirafanRL.world;
        w.getShopOffer()[1]={item:{slot:'charm',rarity:'rare',affixes:[]},price:35,bought:false};return w.coin;}""")
    press(page, "KeyE")
    page.wait_for_function("""document.querySelector('#shop-items [data-index="1"] img')?.naturalWidth>0""")
    check("non-weapon shop stock uses slot art", page.locator('#shop-items [data-index="1"] img').get_attribute("src").endswith("/equipment/slot-charm.svg"))
    page.locator('#shop-items button[data-index="1"]').click()
    page.keyboard.press("Escape")
    check("non-weapon purchase cancellation has no charge", page.evaluate("window.kirafanRL.world.coin") == coin)
    page.locator('#shop-items button[data-index="1"]').click()
    page.locator("#equipment-confirm").click()
    page.evaluate("window.kirafanRL.step(1/60)")
    check("non-weapon purchase charges exactly once", page.evaluate("window.kirafanRL.world.coin") == coin - 35
          and page.locator('#shop-items button[data-index="1"]').is_disabled())
    page.locator("#shop-close").click()
    saved = slot(page)
    page.reload(wait_until="load")
    page.locator("#roster-continue").click(timeout=60000)
    settle(page)
    check("all four slots survive real reload", page.evaluate("window.kirafanRL.world.player.equipment") == saved["equipment"]
          and len(saved["equipment"]) == 4)
    enter(page, "shop")
    check("non-weapon receipt and balance survive reload", page.evaluate("window.kirafanRL.world.getShopOffer()[1].bought")
          and page.evaluate("window.kirafanRL.world.coin") == coin - 35)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=1&seed=260907" % server.server_address[1]
    errors = []
    report = {'checks': checks, 'errors': errors, 'before': fingerprints(), 'complete': False,
              'widths': WIDTHS, 'touch': 'Chromium landscape emulation',
              'fixtures': ['营地初始资源和角色等级', '确定性地面候选', '房间路由', '非武器受控货位与金币']}
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                               "--autoplay-policy=no-user-gesture-required"])
            report['browser'] = browser.version
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            context.add_init_script("""if(!localStorage.getItem('kirafan-rl:meta')) localStorage.setItem('kirafan-rl:meta',
                JSON.stringify({gems:700,levels:{15002001:23},prologueSeen:true,tutorialSeen:true}));""")
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url, wait_until="load")
            page.locator("#roster-train").click(timeout=60000)
            page.locator("#camp-character").select_option("15002001")
            page.locator("#camp-target").fill("24")
            check("camp displays original 23-to-24 cost", "练级花费 56" in page.locator("#camp-price").inner_text())
            page.locator("#camp-train").click()
            meta = slot(page, "meta")
            check("camp train debits 56 and persists level 24", meta["gems"] == 644 and meta["levels"]["15002001"] == 24)
            page.locator("#camp-break").click()
            meta = slot(page, "meta")
            check("limit break debits 500 once", meta["gems"] == 144 and meta["lb"]["15002001"] == 1)
            check("unaffordable break is disabled", page.locator("#camp-break").is_disabled())
            page.locator("#camp-target").fill("85")
            check("unaffordable training is disabled", page.locator("#camp-train").is_disabled())
            page.locator("#camp-target").fill("24.5")
            check("fractional level is disabled", page.locator("#camp-train").is_disabled())
            page.locator("#camp-target").fill("25")
            for width in WIDTHS:
                page.set_viewport_size({"width": width, "height": 844 if width < 768 else 800})
                check("camp fits " + str(width), frame_fits(page, "#rl-camp-training"))
            page.screenshot(path=str(OUT / "camp-1280.png"))
            page.keyboard.press("Escape")
            check("camp returns to roster", page.locator("#roster-overlay").is_visible())
            page.reload(wait_until="load")
            page.locator("#roster-train").click(timeout=60000)
            page.locator("#camp-character").select_option("15002001")
            check("camp level and cap survive reload", "24 / 85" in page.locator("#camp-levels").inner_text())
            page.keyboard.press("Escape")
            page.locator(".roster-card").filter(has_text="凉风 青叶").first.click()
            settle(page)
            check("trained level becomes actual run level", page.evaluate("window.kirafanRL.world.player.level") == 24)

            before = drop(page)
            page.wait_for_selector("#rl-equipment-choice")
            check("comparison opens at its title", page.locator("#rl-equipment-choice").evaluate("el=>el.scrollTop===0"))
            check("comparison does not equip or heal", page.evaluate("""() => {
                const p=window.kirafanRL.world.player;return JSON.stringify([p.hp,p.base,p.equipment,p.skills.gauge]);
            }""") == before)
            check("comparison freezes the world", page.evaluate("window.kirafanRL.world.frozen"))
            expand_comparison(page)
            page.wait_for_function("document.querySelector('#rl-equipment-choice .comparison-summary-icon')?.naturalWidth>0")
            check("comparison shows original weapon name and four exact stats", page.evaluate("""() => {
                const row=window.t26Weapon,d=document.querySelector('[data-catalog-id="'+row.id+'"]');
                return d.textContent.includes(row.nameZh) && [...d.querySelectorAll('.weapon-stats dd')]
                    .map(el=>Number(el.textContent)).join(',')===[row.max.atk,row.max.mgc,row.max.def,row.max.mdef].join(',');
            }"""))
            for width in WIDTHS:
                page.set_viewport_size({"width": width, "height": 844 if width < 768 else 800})
                check("comparison fits " + str(width), frame_fits(page, "#rl-equipment-choice"))
                check("comparison confirmation stays visible " + str(width), page.locator("#equipment-confirm").evaluate("""el => {
                    const r=el.getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight && r.height>=44;
                }"""))
            page.screenshot(path=str(OUT / "comparison-1280.png"))
            page.keyboard.press("Escape")
            check("cancel preserves the candidate", page.evaluate("window.kirafanRL.world.drops.includes(window.t26Drop)"))
            check("cancel leaves current equipment intact", page.evaluate("window.kirafanRL.world.player.equipment.length") == 0)
            page.evaluate("""() => {const k=window.kirafanRL;k.world.player.x-=3;k.step(1/60)}""")
            page.wait_for_function("window.kirafanRL.scene.children.some(s=>s.userData.catalogId===window.t26Weapon.id && s.children[0]?.material.map.image?.width>0)")
            check("native weapon texture contributes real canvas pixels", page.evaluate("""() => {
                const k=window.kirafanRL,s=k.scene.children.find(s=>s.userData.catalogId===window.t26Weapon.id);
                const image=s.children[0],gl=k.renderer.getContext(),n=gl.drawingBufferWidth*gl.drawingBufferHeight*4;
                function pixels(){k.renderOnce();const b=new Uint8Array(n);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,b);return b;}
                image.visible=false;const before=pixels();image.visible=true;const after=pixels();
                let changed=0;for(let i=0;i<n;i+=4) if(before[i]!==after[i]||before[i+1]!==after[i+1]||before[i+2]!==after[i+2]) changed++;
                return changed>20 && image.material.color.getHex()===0xffffff;
            }"""))
            page.screenshot(path=str(OUT / "weapon-drop-1280.png"))
            page.evaluate("""() => {const k=window.kirafanRL;k.world.player.x=window.t26Drop.x;k.step(1/60)}""")
            page.locator("#equipment-confirm").focus()
            page.keyboard.press("Enter")
            page.evaluate("window.kirafanRL.step(1/60)")
            check("keyboard confirmation equips once", page.evaluate("window.kirafanRL.world.player.equipment.length") == 1)
            check("confirmed loot is removed", page.evaluate("window.kirafanRL.world.drops.length") == 0)
            check("confirmed stats equal the native weapon preview", page.evaluate("JSON.stringify(window.kirafanRL.world.player.base)===JSON.stringify(window.t26Expected.candidate)"))
            drop(page, True)
            check("unknown affix cannot be confirmed", page.locator("#equipment-confirm").is_disabled())
            page.keyboard.press("Escape")

            enter(page, "shop")
            page.evaluate("window.kirafanRL.world.coin=1000")
            press(page, "KeyE")
            page.wait_for_selector('#shop-panel[open]')
            check("shop uses three native buttons", page.locator("#shop-items button").count() == 3,
                  page.locator("#shop-items button").count())
            page.wait_for_function("document.querySelector('#shop-items button[data-index=\"0\"] img')?.naturalWidth>0")
            check("shop first item has its real weapon icon and stat line", page.locator('#shop-items button[data-index="0"] .item-stats').is_visible())
            for width in WIDTHS:
                page.set_viewport_size({"width": width, "height": 844 if width < 768 else 800})
                check("shop fits " + str(width), frame_fits(page, "#shop-panel"))
                check("shop name and price do not overlap " + str(width), page.evaluate("""() =>
                    [...document.querySelectorAll('#shop-items button')].every(b=>{
                        const n=b.querySelector('.item-name').getBoundingClientRect(),
                              p=b.querySelector('.item-price').getBoundingClientRect();
                        return n.right+4<=p.left;
                    })"""))
            price = page.evaluate("window.kirafanRL.world.getShopOffer()[0].price")
            page.locator('#shop-items button[data-index="0"]').click()
            check("opening shop comparison does not charge", page.evaluate("window.kirafanRL.world.coin") == 1000)
            page.keyboard.press("Escape")
            check("cancelled purchase keeps stock", not page.evaluate("window.kirafanRL.world.getShopOffer()[0].bought"))
            check("shop retains freeze after comparison closes", page.evaluate("window.kirafanRL.world.frozen"))
            page.locator('#shop-items button[data-index="0"]').focus()
            page.keyboard.press("Enter")
            page.locator("#equipment-confirm").click()
            page.evaluate("window.kirafanRL.step(1/60)")
            check("purchase debits its exact price", page.evaluate("window.kirafanRL.world.coin") == 1000 - price)
            check("sold button becomes disabled", page.locator('#shop-items button[data-index="0"]').is_disabled())
            page.screenshot(path=str(OUT / "shop-1280.png"))
            page.locator("#shop-close").click()

            press(page, "Escape")
            page.locator("#menu-equipment").click()
            check("equipped native weapon is inspectable from the menu", page.locator("#rl-equipment-collection [data-catalog-id]").count() == 1)
            page.locator("#equipment-tab-catalog").click()
            page.get_by_label("武器职业", exact=True).select_option("")
            check("catalog includes all 224 weapon families", page.locator(".weapon-entry").count() == 224)
            page.get_by_label("武器名称", exact=True).fill("仿制之刃")
            check("catalog search finds the named native weapon", page.locator(".weapon-entry").count() == 1)
            page.locator(".weapon-entry summary").click()
            check("catalog detail uses the original 45 attack", "+45" in page.locator(".weapon-entry[open] .weapon-stats").inner_text())
            for width in WIDTHS:
                page.set_viewport_size({"width": width, "height": 844 if width < 768 else 800})
                check("equipment catalog fits " + str(width), frame_fits(page, "#rl-equipment-collection"))
            page.screenshot(path=str(OUT / "weapon-catalog-1280.png"))
            page.get_by_label("武器名称", exact=True).fill("")
            page.get_by_label("武器职业", exact=True).select_option("2")
            page.locator(".weapon-entry").filter(has_text="由乃").first.locator("summary").click()
            entry = page.locator(".weapon-entry[open]")
            entry.locator("select").select_option("1000203")
            check("catalog evolution changes the original stats", "+648" in entry.locator(".weapon-stats").inner_text())
            page.keyboard.press("Escape")
            check("closing equipment retains menu freeze", page.evaluate("window.kirafanRL.world.frozen"))
            page.locator("#menu-resume").click()

            enter(page, "rest")
            hp, max_hp = page.evaluate("""() => {const p=window.kirafanRL.world.player;p.hp=Math.floor(p.maxHp/2);return [p.hp,p.maxHp]}""")
            press(page, "KeyE")
            page.wait_for_selector("#rl-supply-choice")
            for width in WIDTHS:
                page.set_viewport_size({"width": width, "height": 844 if width < 768 else 800})
                check("supply fits " + str(width), frame_fits(page, "#rl-supply-choice"))
            check("supply portrait loads", page.locator("#rl-supply-choice .decision-portrait").evaluate("el=>el.complete && el.naturalWidth>0"))
            page.keyboard.press("Escape")
            check("cancel preserves supply and HP", page.evaluate("window.kirafanRL.world.player.hp") == hp
                  and not page.evaluate("window.kirafanRL.world.getSupplyOffer().used"))
            press(page, "KeyE")
            page.locator("#supply-heal").click()
            check("supply preview has not consumed the choice", not page.evaluate("window.kirafanRL.world.getSupplyOffer().used"))
            page.locator("#room-event-confirm").click()
            page.evaluate("window.kirafanRL.step(1/60)")
            dismiss_dialogue(page)
            check("supply heals the original 40 percent", page.evaluate("window.kirafanRL.world.player.hp") == min(max_hp, hp + int(max_hp * 0.4 + 0.5)))
            saved = slot(page)
            check("v3 writes resource and consumption together", saved["schemaVersion"] == 3
                  and any(r.get("supply") == "heal" and r["rested"] for r in saved["roomClaims"]))
            page.reload(wait_until="load")
            page.locator("#roster-continue").click(timeout=60000)
            settle(page)
            enter(page, "shop")
            check("purchased stock survives reload", page.evaluate("window.kirafanRL.world.getShopOffer()[0].bought"))
            check("spent gold survives reload", page.evaluate("window.kirafanRL.world.coin") == 1000 - price)
            check("native weapon identity survives reload", page.evaluate("window.kirafanRL.world.player.equipment[0].catalogId") == saved["equipment"][0]["catalogId"])
            check("native weapon model follows the restored equipment", page.evaluate("""async () => {
                const k=window.kirafanRL,v=k.views.player;await v.equipmentReady;
                const data=await fetch('../asset/rl/weapons-rl.json').then(r=>r.json());
                const row=data.catalog.find(w=>w.id===k.world.player.equipment[0].catalogId);
                const ids=[...new Set([row.resourceIdL,row.resourceIdR].filter(id=>id>0))];
                return v.equipment.status==='ready' && JSON.stringify(v.actor.weaponResourceIds)===JSON.stringify(ids);
            }"""))
            page.evaluate("window.kirafanRL.world.coin=0")
            press(page, "KeyE")
            check("insufficient balance disables unsold stock", page.locator("#shop-items button:enabled").count() == 0)
            page.locator("#shop-close").click()
            enter(page, "rest")
            check("supply remains consumed after reload", page.evaluate("window.kirafanRL.world.getSupplyOffer().used"))
            page.evaluate("window.kirafanRL.world.coin=100")
            nonweapon_workflows(page)
            context.close()

            touch = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=1)
            touch.add_init_script("localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
            mobile = touch.new_page()
            mobile.on("pageerror", lambda error: errors.append(str(error)))
            mobile.goto(url, wait_until="load")
            mobile.locator('#landscape-guard').wait_for(state='visible')
            check('touch portrait retains orientation and backup entries', mobile.locator('#landscape-fullscreen').is_visible()
                  and mobile.locator('#save-status-open').is_visible())
            mobile.set_viewport_size({'width': 844, 'height': 390})
            mobile.locator('#landscape-guard').wait_for(state='hidden')
            mobile.locator("#roster-train").tap(timeout=60000)
            check("touch camp opens and fits", frame_fits(mobile, "#rl-camp-training"))
            mobile.locator("#rl-camp-training button").filter(has_text="关闭").tap()
            mobile.locator(".roster-card").filter(has_text="凉风 青叶").first.tap()
            settle(mobile)
            drop(mobile)
            mobile.wait_for_function("document.querySelector('#rl-equipment-choice .comparison-summary-icon')?.naturalWidth>0")
            check("touch comparison title and original art are fully visible", mobile.locator("#rl-equipment-choice").evaluate("""el => {
                const box=el.getBoundingClientRect(),title=el.querySelector('h2').getBoundingClientRect(),
                      art=el.querySelector('img').getBoundingClientRect();
                return el.scrollTop===0 && title.top>=box.top && art.top>=box.top && art.bottom<=box.bottom;
            }"""))
            mobile.screenshot(path=str(OUT / "comparison-touch-844x390.png"))
            mobile.locator("#equipment-confirm").tap()
            check("touch confirmation equips", mobile.evaluate("window.kirafanRL.world.player.equipment.length") == 1)
            mobile.evaluate("window.kirafanRL.step(1/60)")
            mobile.locator(".hud-pause").tap()
            mobile.locator("#menu-equipment").tap()
            mobile.locator("#equipment-tab-catalog").tap()
            check("touch catalog opens and fits", frame_fits(mobile, "#rl-equipment-collection"))
            wait_visible_catalog_art(mobile)
            mobile.screenshot(path=str(OUT / "weapon-catalog-touch-844x390.png"))
            # Layout/lazy-load audit via real DOM scrolling, not a touch-swipe claim.
            # Visit every item instead of deleting the old off-screen checks.
            art = mobile.locator('.weapon-entry > summary > img')
            count = art.count()
            for image in art.all():
                image.scroll_into_view_if_needed()
                wait_visible_catalog_art(mobile)
            check('catalog art loads for every reachable row after scrolling', count > 0
                  and art.evaluate_all('images=>images.every(img=>img.complete&&img.naturalWidth>0)'))
            check('catalog scrolling keeps the return action visible', frame_fits(mobile, '#rl-equipment-collection > button'))
            mobile.get_by_role("button", name="返回", exact=True).tap()
            mobile.locator("#menu-resume").tap()
            enter(mobile, "rest")
            mobile.locator(".touch-interact").tap()
            mobile.wait_for_selector("#rl-supply-choice")
            mobile.screenshot(path=str(OUT / "supply-touch-844x390.png"))
            mobile.locator("#supply-gauge").tap()
            mobile.locator("#room-event-confirm").tap()
            check("touch supply grants gauge", mobile.evaluate("window.kirafanRL.world.player.skills.gauge") > 0)
            mobile.evaluate("window.kirafanRL.step(1/60)")
            dismiss_dialogue(mobile)
            check("rendered battlefield contains scene pixels", mobile.evaluate("""() => {
                const k=window.kirafanRL;k.renderOnce();
                const gl=k.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
                const pixels=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
                let varied=0;for(let i=0;i<pixels.length;i+=400)
                    if(pixels[i]!==pixels[0]||pixels[i+1]!==pixels[1]||pixels[i+2]!==pixels[2]) varied++;
                return varied>100;
            }"""))
            check("no uncaught browser errors", not errors, errors)
            check('product source unchanged during acceptance', report['before'] == fingerprints())
            report['complete'] = True
            browser.close()
    except BaseException as error:
        report['failure'] = str(error)
        raise
    finally:
        report['after'] = fingerprints()
        (OUT / 'decisions-browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
        server.shutdown()
        server.server_close()
    print("T26 browser: %d checks passed" % len(checks), flush=True)


if __name__ == "__main__":
    main()
