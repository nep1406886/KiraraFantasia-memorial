"""T28 backup restore through real file controls, storage faults and reloads."""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_result_browser import dismiss_dialogue
from rl_decisions_browser import frame_fits, press, settle

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "t28"
checks = []


def check(label, ok):
    if not ok:
        raise AssertionError(label)
    checks.append(label)
    print("PASS " + label, flush=True)


def raw_storage(page):
    return page.evaluate("JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('kirafan-rl:')).sort().map(k=>[k,localStorage.getItem(k)])))")


def select_backup(page, data, name="backup.json"):
    content = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    with page.expect_file_chooser() as chooser:
        page.locator("#storage-select-file").click()
    chooser.value.set_files({"name": name, "mimeType": "application/json", "buffer": content.encode("utf-8")})


def fixture(page):
    return page.evaluate("""async () => {
        const data=await fetch('../site/asset/rl/weapons-rl.json').then(r=>r.json());
        const cards=await fetch('../site/asset/rl/cards-rl.json').then(r=>r.json());
        const card=cards.cards.find(c=>c.id===10000000);
        const weapon=data.catalog.find(w=>w.class===card.class && w.charaId<0 && w.rare===3);
        const {generateDungeon}=await import('./rl/dungeon.js');
        const {layoutSeedFor}=await import('./rl/runschema.js');
        const dungeon=generateDungeon(layoutSeedFor(12345,1),{roomsMin:6,roomsMax:9});
        const shop=dungeon.rooms.find(r=>r.type==='shop');
        const item={slot:'weapon',rarity:'rare',catalogId:weapon.id,affixes:[]};
        const run={schemaVersion:3,generatorVersion:'t24-1',seed:12345,volume:1,floor:1,
            cardId:card.id,level:24,exp:0,hp:400,gauge:0,coin:90,stackHits:0,stackKills:0,
            equipment:[item],roomClaims:[{id:shop.id,chestOpened:false,altarUsed:false,rested:false,
                npcTalked:false,barrels:[],offer:[true,false,false].map(bought=>({item,price:60,bought}))}]};
        return {meta:JSON.stringify({gems:777,levels:{10000000:24,10002001:21},lb:{18000000:1},volumes:1,pages:['29001000'],
            prologueSeen:true,tutorialSeen:true}),run:JSON.stringify(run),'cam-height':'11'};
    }""")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=1&seed=280908" % server.server_address[1]
    errors = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])
            context = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
            context.add_init_script("""if(!localStorage.getItem('kirafan-rl:meta')) {
                localStorage.setItem('kirafan-rl:meta',JSON.stringify({gems:700,prologueSeen:true,tutorialSeen:true}));
                localStorage.setItem('kirafan-rl:cam-height','9');
            }""")
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url, wait_until="load")
            page.locator("#roster-storage").click(timeout=60000)
            check("roster opens backup with focus on its title", page.locator("#storage-title").evaluate("e=>e===document.activeElement"))
            with page.expect_download() as download:
                page.locator("#storage-export").click()
            downloaded = OUT / "exported-legacy.json"
            download.value.save_as(downloaded)
            exported = json.loads(downloaded.read_text(encoding="utf-8"))
            check("automatic migration exports scalar camera and real saved gems", exported["settings"]["cam-height"] == 9 and exported["meta"]["gems"] == 700)
            before = raw_storage(page)
            select_backup(page, "{bad")
            page.wait_for_function("document.querySelector('#storage-result').textContent.includes('JSON')")
            check("invalid file leaves current bytes intact and confirmation disabled", raw_storage(page) == before and page.locator("#storage-confirm").is_disabled())
            data = fixture(page)
            select_backup(page, data)
            page.locator("#storage-preview").wait_for(state="visible")
            check("preview displays imported gems, pages and trained level", all(text in page.locator("#storage-preview").inner_text() for text in ["777", "1 / 37", "Lv 24"]))
            check("preview includes a level-one character with limit breaks", "Lv 1 · 突破 1" in page.locator("#storage-preview .storage-levels").inner_text())
            for width in (375, 390, 412, 430, 768, 1280):
                page.set_viewport_size({"width": width, "height": 900})
                check("backup dialog fits %d" % width, frame_fits(page, "#rl-storage"))
                check("restore button remains visible %d" % width, page.locator("#storage-confirm").evaluate("e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}"))
            page.screenshot(path=str(OUT / "storage-preview-1280.png"))
            page.locator("#storage-close").click()
            check("cancel restores roster focus and changes nothing", raw_storage(page) == before and page.locator("#roster-storage").evaluate("e=>e===document.activeElement"))
            page.locator("#roster-storage").click()
            select_backup(page, data)
            page.locator("#storage-preview").wait_for(state="visible")
            page.evaluate("""() => {
                const original=Storage.prototype.setItem;
                window.restoreAttempts=0;window.failRestore=true;
                Storage.prototype.setItem=function(key,value){
                    if(key==='kirafan-rl:profile'){
                        window.restoreAttempts++;
                        if(window.failRestore) throw new DOMException('injected quota','QuotaExceededError');
                    }
                    return original.call(this,key,value);
                };
            }""")
            page.locator("#storage-confirm").click()
            check("quota fault reaches the actual profile commit exactly once", page.evaluate("restoreAttempts") == 1)
            check("failed restore is visible, retryable and preserves all old bytes", "原存档保持不变" in page.locator("#storage-result").inner_text() and raw_storage(page) == before and page.locator("#storage-confirm").is_enabled())
            page.evaluate("window.failRestore=false")
            with page.expect_navigation(wait_until="load"):
                page.locator("#storage-confirm").click()
            page.locator("#roster-continue").wait_for(timeout=60000)
            check("successful restore reloads normal entry without old seed override", "seed=" not in page.url and "volume=" not in page.url and "floor=" not in page.url)
            active = page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile'))")
            check("restored checkpoint, gold, native weapon and consumed shop are durable", active["meta"]["gems"] == 777 and active["run"]["coin"] == 90 and active["run"]["equipment"][0]["catalogId"] == json.loads(data["run"])["equipment"][0]["catalogId"] and active["run"]["roomClaims"][0]["offer"][0]["bought"])
            check("legacy bytes remain available after explicit restore", page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:meta')).gems") == 700)
            check("restored current and historical training identities remain distinct",
                  active["meta"]["levels"]["10002001"] == 21 and active["meta"]["levels"]["10000000"] == 24
                  and active["run"]["cardId"] == 10000000)
            page.locator("#roster-train").click()
            check("camp exposes the current playable set, not historical save identities", page.evaluate("""async () => {
                const {PLAYABLE_IDS} = await import('./rl/rosterids.js');
                const ids = [...document.querySelectorAll('#camp-character option')].map(option => Number(option.value)).sort((a,b)=>a-b);
                return JSON.stringify(ids) === JSON.stringify([...PLAYABLE_IDS].sort((a,b)=>a-b))
                    && !ids.includes(10000000) && ids.includes(32022001);
            }"""))
            page.locator("#camp-character").select_option("10002001")
            page.locator("#camp-target").fill("22")
            before_training = raw_storage(page)
            page.evaluate("""() => {
                window.realStorageWrite=Storage.prototype.setItem;
                Storage.prototype.setItem=function(key,value){
                    if(key==='kirafan-rl:profile') throw new DOMException('injected quota','QuotaExceededError');
                    return window.realStorageWrite.call(this,key,value);
                };
            }""")
            page.locator("#camp-train").click()
            check("camp payment failure is visible without spending or training", "存档写入失败" in page.locator("#rl-camp-training .decision-status").inner_text() and "777" in page.locator("#camp-balance").inner_text() and "培养等级 21" in page.locator("#camp-levels").inner_text() and raw_storage(page) == before_training)
            page.evaluate("() => { Storage.prototype.setItem=window.realStorageWrite; }")
            page.locator("#rl-camp-training").get_by_role("button", name="关闭", exact=True).click()
            page.locator("#roster-continue").click()
            settle(page)
            check("continued world uses restored resources and equipment", page.evaluate("kirafanRL.world.player.level===24&&kirafanRL.world.coin===90&&kirafanRL.world.player.equipment[0].catalogId") == active["run"]["equipment"][0]["catalogId"])
            press(page, "Escape")
            page.locator("#menu-storage").click()
            check("pause menu exposes backup and keeps world frozen", page.evaluate("kirafanRL.world.frozen"))
            now = page.evaluate("kirafanRL.world.time")
            persisted = raw_storage(page)
            page.evaluate("kirafanRL.step(1)")
            check("backup modal cannot advance simulation", page.evaluate("kirafanRL.world.time") == now)
            page.evaluate("kirafanRL.step(6)")
            check("paused autosave leaves the profile revision unchanged", raw_storage(page) == persisted)
            page.keyboard.press("Escape")
            check("closing backup retains menu pause", page.evaluate("kirafanRL.world.frozen") and page.locator("#menu-panel").is_visible())
            page.locator("#menu-cam").evaluate("e=>{e.value='120';e.dispatchEvent(new Event('input',{bubbles:true}))}")
            check("camera now writes through the active profile", page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).settings['cam-height']") == 12)
            page.locator("#menu-storage").click()
            with page.expect_download() as download:
                page.locator("#storage-export").click()
            download.value.save_as(OUT / "exported-profile.json")
            check("post-restore export is a complete profile", json.loads((OUT / "exported-profile.json").read_text(encoding="utf-8"))["profileVersion"] == 2)
            context.close()

            touch = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=1)
            touch.add_init_script("localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
            mobile = touch.new_page(); mobile.on("pageerror", lambda error: errors.append(str(error)))
            mobile.goto(url, wait_until="load")
            # 与 rl_result/rl_terminal 的触屏流程一致：竖屏先落到横屏守卫，
            # 转横屏后才出现可点的选人界面（竖屏保护隐藏选人是有意行为）。
            mobile.locator("#landscape-guard").wait_for(state="visible", timeout=60000)
            mobile.set_viewport_size({"width": 844, "height": 390})
            mobile.locator("#landscape-guard").wait_for(state="hidden", timeout=60000)
            mobile.locator("#roster-storage").tap(timeout=60000)
            select_backup(mobile, data)
            mobile.locator("#storage-preview").wait_for(state="visible")
            mobile.screenshot(path=str(OUT / "storage-preview-390.png"))
            check("touch backup fits with a reachable confirmation", frame_fits(mobile, "#rl-storage") and mobile.locator("#storage-confirm").is_enabled())
            mobile.locator("#storage-close").tap()
            check("touch cancellation returns to character selection", mobile.locator("#roster-overlay").is_visible())
            touch.close()

            future = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
            future.add_init_script("localStorage.setItem('kirafan-rl:profile','{\"profileVersion\":999}');")
            damaged = future.new_page(); damaged.on("pageerror", lambda error: errors.append(str(error)))
            damaged.goto(url, wait_until="load")
            damaged.locator("#roster-storage").wait_for(timeout=60000)
            dismiss_dialogue(damaged)
            damaged.locator("#roster-storage").click()
            check("future profile stays recoverable without being overwritten at boot", damaged.evaluate("localStorage.getItem('kirafan-rl:profile')") == '{"profileVersion":999}' and "原文仍可导出" in damaged.locator("#rl-storage").inner_text())
            with damaged.expect_download() as download:
                damaged.locator("#storage-export").click()
            download.value.save_as(OUT / "exported-future.json")
            check("future profile export preserves exact source bytes", (OUT / "exported-future.json").read_text(encoding="utf-8") == '{"profileVersion":999}')
            future.close()

            invalid_profile = json.loads(json.dumps(active))
            invalid_profile["run"]["cardId"] = 999999
            invalid_raw = json.dumps(invalid_profile, ensure_ascii=False)
            invalid = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
            invalid.add_init_script("if(!localStorage.getItem('kirafan-rl:profile')) localStorage.setItem('kirafan-rl:profile',%s);" % json.dumps(invalid_raw))
            corrupt = invalid.new_page(); corrupt.on("pageerror", lambda error: errors.append(str(error)))
            corrupt.goto(url, wait_until="load")
            corrupt.locator("#roster-storage").wait_for(timeout=60000)
            dismiss_dialogue(corrupt)
            check("same-version corrupt checkpoint has no continue action", not corrupt.locator("#roster-continue").is_visible())
            check("automatic progression cannot overwrite a corrupt active profile", corrupt.evaluate("localStorage.getItem('kirafan-rl:profile')") == invalid_raw)
            corrupt.locator("#roster-storage").click()
            with corrupt.expect_download() as download:
                corrupt.locator("#storage-export").click()
            download.value.save_as(OUT / "exported-corrupt.json")
            check("corrupt content exports without normalization or data loss", (OUT / "exported-corrupt.json").read_text(encoding="utf-8") == invalid_raw)
            select_backup(corrupt, data)
            corrupt.locator("#storage-preview").wait_for(state="visible")
            with corrupt.expect_navigation(wait_until="load"):
                corrupt.locator("#storage-confirm").click()
            corrupt.locator("#roster-continue").wait_for(timeout=60000)
            check("explicit recovery replaces corrupt content and restores continue", corrupt.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile')).run.cardId") == 10000000)
            invalid.close()

            full = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
            full.add_init_script("""localStorage.setItem('kirafan-rl:meta',JSON.stringify({gems:432,prologueSeen:true,tutorialSeen:true}));
                Storage.prototype.setItem=function(){throw new DOMException('injected full','QuotaExceededError')};""")
            capacity = full.new_page(); capacity.on("pageerror", lambda error: errors.append(str(error)))
            capacity.goto(url, wait_until="load")
            capacity.locator("#roster-storage").click(timeout=60000)
            check("full-at-boot storage retains readable progress", "432" in capacity.locator(".storage-current").inner_text())
            with capacity.expect_download() as download:
                capacity.locator("#storage-export").click()
            download.value.save_as(OUT / "exported-full.json")
            check("full-at-boot storage can export old progress", json.loads(json.loads((OUT / "exported-full.json").read_text(encoding="utf-8"))["meta"])["gems"] == 432)
            full.close()

            blocked = browser.new_context(viewport={"width": 390, "height": 844})
            blocked.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new DOMException('injected denial','SecurityError')}})")
            denied = blocked.new_page(); denied.on("pageerror", lambda error: errors.append(str(error)))
            denied.goto(url, wait_until="load")
            denied.locator("#roster-storage").wait_for(timeout=60000)
            dismiss_dialogue(denied)
            denied.locator("#roster-storage").click()
            check("blocked storage keeps the game usable with visible session mode", "仅当前页面有效" in denied.locator("#rl-storage").inner_text())
            select_backup(denied, data)
            denied.locator("#storage-preview").wait_for(state="visible")
            check("session mode cannot report a durable restore", denied.locator("#storage-confirm").is_disabled())
            blocked.close()

            check("no uncaught browser exceptions", not errors)
            (OUT / "storage-browser.json").write_text(json.dumps({"browser": browser.version, "checks": checks, "errors": errors}, ensure_ascii=False, indent=2), encoding="utf-8")
            browser.close()
    finally:
        server.shutdown(); server.server_close()


if __name__ == "__main__":
    main()
