"""T28: real migration, visible persistence faults, candidate export and retry."""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_result_browser import dismiss_dialogue, slot
from rl_decisions_browser import settle, press, frame_fits

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "t28-persistence"
checks = []


def check(label, condition):
    if not condition:
        raise AssertionError(label)
    checks.append(label)
    print("PASS " + label, flush=True)


def raw(page):
    return page.evaluate("JSON.stringify(Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('kirafan-rl:')).sort().map(k=>[k,localStorage.getItem(k)])))")


def downloaded(page, selector, path):
    with page.expect_download() as event:
        page.locator(selector).click()
    event.value.save_as(path)
    return json.loads(path.read_text(encoding="utf-8"))


def state(page, expected):
    page.wait_for_function("expected=>document.querySelector('#save-status')?.dataset.state===expected", arg=expected)


def status_fits(page):
    return page.evaluate("""() => {
        const panel=document.querySelector('#save-status'), r=panel.getBoundingClientRect();
        const overlay=document.querySelector('#roster-overlay');
        if(r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight||panel.scrollWidth>panel.clientWidth+1) return false;
        if(overlay && overlay.getBoundingClientRect().top<r.bottom-1) return false;
        return [...panel.querySelectorAll('button')].filter(e=>!e.hidden).every(e=>{
            const b=e.getBoundingClientRect(), top=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
            return b.width>=44&&b.height>=44&&b.right<=innerWidth&&b.bottom<=innerHeight&&e.contains(top);
        });
    }""")


def inject_quota(page):
    page.evaluate("""() => {
        const write=Storage.prototype.setItem;window.blockWrites=true;window.profileAttempts=0;
        Storage.prototype.setItem=function(k,v){
            if(k==='kirafan-rl:profile'){window.profileAttempts++;if(window.blockWrites) throw new DOMException('injected quota','QuotaExceededError');}
            return write.call(this,k,v);
        };
    }""")


def controls_reachable(page, selector):
    return page.locator(selector).evaluate_all("""elements => elements.length > 0 && elements.every(e => {
        const r=e.getBoundingClientRect(), top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return r.width>=44 && r.height>=44 && r.left>=0 && r.top>=0
            && r.right<=innerWidth && r.bottom<=innerHeight && e.contains(top);
    })""")


def retry_attempts(page, selector, blocked):
    # Change the injected fault at the actual click boundary, not during a
    # Playwright round trip where a legitimate autosave could win the race.
    page.evaluate("""({selector,blocked}) => {
        document.querySelector(selector).addEventListener('click',() => {
            window.blockWrites=blocked;window.retryAttemptsBefore=window.profileAttempts;
        },{capture:true,once:true});
    }""", {"selector":selector,"blocked":blocked})
    page.locator(selector).click()
    return page.evaluate("profileAttempts-retryAttemptsBefore")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server=Server(("127.0.0.1",0),functools.partial(NoCacheHandler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    url="http://127.0.0.1:%d/site/game/roguelike.html?seed=12345" % server.server_address[1]
    errors=[]
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(args=["--use-gl=angle","--enable-unsafe-swiftshader","--autoplay-policy=no-user-gesture-required"])
            context=browser.new_context(viewport={"width":1280,"height":900},accept_downloads=True)
            context.add_init_script("""if(!localStorage.getItem('kirafan-rl:profile')&&!localStorage.getItem('kirafan-rl:meta')){
                localStorage.setItem('kirafan-rl:meta',JSON.stringify({gems:800,levels:{10000000:24,10002001:24},prologueSeen:true,tutorialSeen:true}));
                localStorage.setItem('kirafan-rl:cam-height','11');
            }""")
            page=context.new_page();page.on("pageerror",lambda error:errors.append(str(error)))
            page.goto(url,wait_until="load");page.locator("#roster-storage").wait_for(timeout=60000)
            state(page,"saved")
            check("ordinary boot migrates legacy progress to a durable profile",slot(page,"meta")["gems"]==800 and slot(page,"cam-height")==11)
            check("legacy progress remains byte-preserved after automatic migration",page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:meta')).gems") == 800)
            check("save status is visible above the roster without covering controls",status_fits(page))
            inject_quota(page)
            page.locator("#roster-train").click();page.locator("#camp-character").select_option("10002001");page.locator("#camp-target").fill("25")
            page.locator("#camp-train").click();state(page,"unsaved")
            check("failed camp payment reaches storage and keeps durable gems",page.evaluate("profileAttempts")>0 and slot(page,"meta")["gems"]==800)
            page.locator("#rl-camp-training").get_by_role("button",name="关闭",exact=True).click()
            retry_attempts(page,"#save-status-retry",False);state(page,"saved")
            check("retry does not execute a previously failed camp payment",slot(page,"meta")["levels"]["10000000"]==24
                  and slot(page,"meta")["levels"]["10002001"]==24 and slot(page,"meta")["gems"]==800)
            check("status retry keeps focus on the surviving backup action",page.locator("#save-status-open").evaluate("e=>e===document.activeElement"))
            before_read_loss=raw(page)
            page.evaluate("""() => {
                const read=Storage.prototype.getItem;window.blockReads=true;
                Storage.prototype.getItem=function(k){
                    if(window.blockReads && String(k).startsWith('kirafan-rl:')) throw new DOMException('read denied','SecurityError');
                    return read.call(this,k);
                };
                window.dispatchEvent(new Event('focus'));
            }""")
            state(page,"unsaved");page.locator("#save-status-open").click()
            check("read access loss retains an exportable in-page profile",page.locator("#storage-pending").is_visible())
            cached=downloaded(page,"#storage-export-pending",OUT/"read-denied-cached.json")
            check("cached profile exports while durable reads are denied",cached["meta"]["gems"]==800 and cached["run"] is None)
            page.locator("#storage-export").click()
            check("raw export reports denied access without claiming success","导出未完成" in page.locator("#storage-result").inner_text())
            page.evaluate("window.blockReads=false")
            check("restored read access alone leaves durable bytes unchanged",raw(page)==before_read_loss)
            attempts=retry_attempts(page,"#storage-retry",False);state(page,"saved")
            check("one retry after read recovery saves only the known profile",attempts==1
                  and slot(page,"meta")["gems"]==800 and slot(page) is None
                  and page.locator("#storage-title").evaluate("e=>e===document.activeElement"))
            page.locator("#storage-close").click()
            page.locator(".roster-card").first.click();settle(page)
            page.evaluate("kirafanRL.world.player.iframes=1e9")
            press(page,"Escape");page.evaluate("window.dispatchEvent(new Event('pagehide'))")
            persisted=raw(page);saved_run=slot(page)
            page.evaluate("window.blockWrites=true;kirafanRL.world.coin=164;window.dispatchEvent(new Event('pagehide'))")
            state(page,"unsaved")
            check("autosave failure leaves all durable bytes untouched",raw(page)==persisted)
            page.locator("#save-status-open").click()
            check("backup opens from persistent status and shows pending progress",page.locator("#storage-pending").is_visible() and page.evaluate("kirafanRL.world.frozen"))
            original=downloaded(page,"#storage-export",OUT/"persisted-before-retry.json")
            candidate=downloaded(page,"#storage-export-pending",OUT/"pending-before-retry.json")
            check("raw export and pending export are distinct honest snapshots",original["run"]["coin"]==saved_run["coin"] and candidate["run"]["coin"]==164)
            attempts=retry_attempts(page,"#storage-retry",True)
            check("failed retry makes exactly one attempted commit",attempts==1 and raw(page)==persisted)
            attempts=retry_attempts(page,"#storage-retry",False);state(page,"saved")
            check("successful retry commits the latest candidate exactly once",attempts==1 and slot(page)["coin"]==164)
            check("successful retry removes the unsaved export state",page.locator("#storage-pending").is_hidden() and page.locator("#storage-export-pending").is_hidden())
            check("hidden retry returns focus to the dialog title",page.locator("#storage-title").evaluate("e=>e===document.activeElement"))
            page.locator("#storage-close").focus();page.keyboard.press("Tab")
            check("forward focus wrap skips actions hidden by a successful retry",page.locator("#storage-select-file").evaluate("e=>e===document.activeElement"))
            page.keyboard.press("Shift+Tab")
            check("reverse focus wrap returns to the last enabled action",page.locator("#storage-close").evaluate("e=>e===document.activeElement"))
            page.locator("#storage-close").click()
            check("closing persistence manager preserves the pause menu",page.locator("#menu-panel").is_visible() and page.evaluate("kirafanRL.world.frozen"))
            page.reload(wait_until="load");page.locator("#roster-continue").click(timeout=60000);settle(page)
            check("retried progress survives a real reload and continue",page.evaluate("kirafanRL.world.coin")==164)
            page.evaluate("window.dispatchEvent(new Event('pagehide'))")
            other=context.new_page();other.goto(url,wait_until="load");other.locator("#roster-storage").wait_for(timeout=60000)
            other.evaluate("() => {const p=JSON.parse(localStorage.getItem('kirafan-rl:profile'));p.revision+=1;p.meta.gems=321;localStorage.setItem('kirafan-rl:profile',JSON.stringify(p));}")
            state(page,"conflict")
            check("an external page change freezes combat before a stale write",page.evaluate("kirafanRL.world.frozen") and slot(page,"meta")["gems"]==321)
            external=raw(page);page.evaluate("window.dispatchEvent(new Event('pagehide'))")
            check("conflicted page cannot overwrite newer durable data",raw(page)==external)
            page.locator("#save-status-open").click()
            local=downloaded(page,"#storage-export-pending",OUT/"conflict-local.json")
            check("conflict still allows exporting the local branch",local["meta"]["gems"]==800 and local["run"]["coin"]==164)
            context.close()

            # Quota full before boot: old archive remains readable; the page is usable.
            full=browser.new_context(viewport={"width":390,"height":844},is_mobile=True,has_touch=True,accept_downloads=True)
            full.add_init_script("""localStorage.setItem('kirafan-rl:meta',JSON.stringify({gems:432,prologueSeen:true,tutorialSeen:true}));
                window.quotaHits=0;Storage.prototype.setItem=function(){window.quotaHits++;throw new DOMException('full','QuotaExceededError')};""")
            mobile=full.new_page();mobile.on("pageerror",lambda error:errors.append(str(error)))
            mobile.goto(url,wait_until="load");mobile.locator("#roster-storage").wait_for(state="attached",timeout=60000);state(mobile,"unsaved")
            check("full-at-boot migration is attempted and explicitly unsaved",mobile.evaluate("quotaHits")>0 and mobile.evaluate("localStorage.getItem('kirafan-rl:profile')") is None)
            for width,height in [(375,844),(390,844),(412,844),(430,844),(768,900),(1280,900),(844,390)]:
                mobile.set_viewport_size({"width":width,"height":height})
                mobile.wait_for_timeout(50)
                check("save controls remain reachable despite portrait gating %dx%d"%(width,height),status_fits(mobile))
            mobile.set_viewport_size({"width":390,"height":844});mobile.wait_for_timeout(50)
            mobile.screenshot(path=str(OUT/"unsaved-roster-390.png"))
            mobile.locator("#save-status-open").tap()
            check("touch status opens backup with both old and pending progress",mobile.locator("#storage-title").evaluate("e=>e===document.activeElement") and "432" in mobile.locator("#storage-pending").inner_text())
            for width,height in [(375,844),(390,844),(412,844),(430,844),(768,900),(1280,900),(844,390)]:
                mobile.set_viewport_size({"width":width,"height":height})
                check("pending backup and actions are reachable %dx%d"%(width,height),frame_fits(mobile,"#rl-storage")
                      and controls_reachable(mobile,"#rl-storage .decision-actions button:not([hidden])"))
                mobile.locator("#storage-select-file").scroll_into_view_if_needed()
                check("backup file picker scrolls into reach %dx%d"%(width,height),controls_reachable(mobile,"#storage-select-file"))
                mobile.locator(".storage-scroll").evaluate("e=>e.scrollTop=0")
                if width==1280: mobile.screenshot(path=str(OUT/"pending-desktop.png"))
                if height==390: mobile.screenshot(path=str(OUT/"pending-landscape.png"))
            mobile.set_viewport_size({"width":390,"height":844});mobile.screenshot(path=str(OUT/"pending-mobile.png"))
            mobile.locator("#storage-title").focus();mobile.keyboard.press("Shift+Tab")
            check("reverse focus from the dialog title stays in the modal",mobile.locator("#storage-close").evaluate("e=>e===document.activeElement"))
            mobile.locator("#storage-title").focus()
            focus_inside=[]
            for key in ["Tab","Tab","Shift+Tab","Shift+Tab"]:
                mobile.keyboard.press(key)
                focus_inside.append(mobile.locator("#rl-storage").evaluate("e=>e.contains(document.activeElement)"))
            check("keyboard focus remains inside the pending backup dialog",all(focus_inside))
            mobile.locator("#storage-close").tap()
            check("touch cancel restores status-button focus",mobile.locator("#save-status-open").evaluate("e=>e===document.activeElement"))
            full.close()

            broken=browser.new_context(viewport={"width":1280,"height":900},accept_downloads=True)
            broken.add_init_script("localStorage.setItem('kirafan-rl:meta','{broken legacy');")
            damaged=broken.new_page();damaged.on("pageerror",lambda error:errors.append(str(error)))
            damaged.goto(url,wait_until="load");damaged.locator("#roster-storage").wait_for(timeout=60000);dismiss_dialogue(damaged);state(damaged,"corrupt")
            check("corrupt legacy is protected against automatic progression writes",damaged.evaluate("localStorage.getItem('kirafan-rl:meta')")=='{broken legacy' and damaged.evaluate("localStorage.getItem('kirafan-rl:profile')") is None)
            damaged.locator("#save-status-open").click();exported=downloaded(damaged,"#storage-export",OUT/"corrupt-legacy.json")
            check("corrupt legacy can be exported without fabrication",exported["meta"]=='{broken legacy' and damaged.locator("#storage-retry").is_hidden())
            broken.close()

            denied=browser.new_context(viewport={"width":390,"height":844},accept_downloads=True)
            denied.add_init_script("""const actual=window.localStorage;window.allowStorage=!!actual.getItem('kirafan-rl:profile');
                Object.defineProperty(window,'localStorage',{get(){if(!window.allowStorage)throw new DOMException('denied','SecurityError');return actual;}});""")
            session=denied.new_page();session.on("pageerror",lambda error:errors.append(str(error)))
            session.goto(url,wait_until="load");session.locator("#roster-storage").wait_for(timeout=60000);dismiss_dialogue(session);state(session,"session")
            session.locator("#save-status-open").click();backup=downloaded(session,"#storage-export-pending",OUT/"session.json")
            check("blocked browser storage still allows a complete session export",backup["profileVersion"]==2 and backup["meta"]["prologueSeen"])
            session.locator("#storage-retry").click();state(session,"session")
            check("retry does not claim persistence while permission is still denied","仅当前页面有效" in session.locator("#storage-result").inner_text())
            session.evaluate("window.allowStorage=true");session.locator("#storage-retry").click();state(session,"saved")
            check("retry detects restored permission and durably saves the session",slot(session,"meta")["prologueSeen"])
            session.reload(wait_until="load");session.locator("#roster-storage").wait_for(timeout=60000);state(session,"saved")
            check("permission-recovered progress survives reload",slot(session,"meta")["prologueSeen"])
            denied.close()

            check("no uncaught browser errors",not errors)
            (OUT/"persistence-browser.json").write_text(json.dumps({"browser":browser.version,"checks":checks,"errors":errors},ensure_ascii=False,indent=2),encoding="utf-8")
            browser.close()
    finally:
        server.shutdown();server.server_close()
    print("T28 persistence browser: %d checks passed" % len(checks),flush=True)


if __name__=="__main__":
    main()
