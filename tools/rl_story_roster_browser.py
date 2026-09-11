"""Current-card story identities through roster, supply, replay and real death.

Room placement and page collection are explicit fixtures. Interactions use real
keyboard/mouse input; no dialogue queue or archive callback is called directly.
Each case owns an isolated profile, and failures retain screenshots and results.
"""
import argparse
import functools
import hashlib
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_story_browser import dismiss, enter, press, profile, ready, seen, story_fits
from rl_terminal_browser import fatal_projectile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "story-roster"
# Independent identity fixtures. The GA page is historic Tomokane, but the
# selected current actor is Kisaragi. A shared page must never pick the speaker.
CASES = (
    (25002001, "kisaragi", "山口 如月", "山口如月", 25021000),
    (32022001, "claire", "クレア", "克蕾尔", 32002000),
    (32002001, "kirara", "きらら", "琪拉拉", 32002000),
    (32172001, "utsutsu", "うつつ", "住良木现", 32002000),
    (14012001, "alice", "アリス・カータレット", "爱丽丝·卡塔雷特", 14010000),
    (23012001, "nadeshiko", "各務原 なでしこ", "各务原抚子", 23001000),
    (36002001, "harumi", "はるみ", "细野晴海", 36001000),
    (41002001, "tsumiki", "つみき", "御庭摘希", 41001000),
    (43002001, "koharu", "こはる", "小野坂小春", 43001000),
    (42002001, "mayu", "まゆ", "篠华茉优", 42001000),
    (33012001, "futaba", "小田切 双葉", "小田切双叶", 33011000),
    (14002001, "karen", "九条 カレン", "九条可怜", 14010000),
)
checks = []
portraits = []


def check(label, condition, detail=None):
    if not condition:
        raise AssertionError(label + ": " + str(detail))
    checks.append(label)
    print("PASS " + label, flush=True)


def fingerprints():
    paths = list((ROOT / "game/rl").rglob("*.js"))
    paths += list((ROOT / "site/asset/rl/dialogue").glob("*.js"))
    paths += [ROOT / "site/game/roguelike.html", ROOT / "site/core/actor.js", ROOT / "site/game/rl/ui/story.css"]
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}


def resources(page, include_profile=False):
    return page.evaluate("""include => {
        const w=window.kirafanRL.world,p=w.player;
        return JSON.stringify({hp:p.hp,coin:w.coin,gauge:p.skills.gauge,
            equipment:p.equipment,claims:w.getRoomClaims(),
            profile:include ? localStorage.getItem('kirafan-rl:profile') : null});
    }""", include_profile)


def line_state(page):
    return page.locator("#dialogue-box").evaluate("""box => {
        const body=box.children[1],image=box.children[0];
        return {name:body.children[0].textContent,text:body.children[1].textContent,
            portrait:{src:image.getAttribute('src'),visible:getComputedStyle(image).display!=='none',
                loaded:image.complete && image.naturalWidth>0}};
    }""")


def wait_line(page, text):
    page.wait_for_selector("#dialogue-box", state="visible")
    page.wait_for_function("""text => document.querySelector('#dialogue-box')
        ?.children[1]?.children[1]?.textContent===text""", arg=text, timeout=8000)
    return line_state(page)


def compact(text):
    # The original name table and current card table use equivalent middle-dot
    # glyphs. Normalize punctuation/spacing only, never remove a surname.
    return "".join(text.split()).replace("・", "·")


def dialogue_fits(page):
    return page.locator("#dialogue-box").evaluate("""box => {
        const r=box.getBoundingClientRect(),s=box.querySelector('#dialogue-skip').getBoundingClientRect();
        return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight
            && box.scrollWidth<=box.clientWidth+1 && s.left>=0 && s.right<=innerWidth
            && s.bottom<=innerHeight && box.contains(document.elementFromPoint(s.x+s.width/2,s.y+s.height/2));
    }""")


def mobile_archive(browser,base,record,errors):
    # Copy the actual post-terminal profile from the preceding player journey;
    # this fixture grants no stories and does not call an archive command.
    context=browser.new_context(viewport={'width':375,'height':812},is_mobile=True,has_touch=True)
    context.add_init_script("localStorage.setItem('kirafan-rl:profile',"+json.dumps(record['saved'])+");")
    page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.goto(base+'/site/game/roguelike.html',wait_until='load',timeout=60000)
        page.locator('#landscape-guard').wait_for(state='visible',timeout=60000)
        check('旧对白手机回看前竖屏保护不修改档案',page.evaluate("localStorage.getItem('kirafan-rl:profile')")==record['saved']
              and page.evaluate('kirafanRL.world.frozen'))
        page.set_viewport_size({'width':812,'height':375})
        page.locator('#roster-codex').tap(timeout=60000);page.locator('.codex-tab[data-tab="stories"]').tap()
        for width,height in [(812,375),(932,430)]:
            page.set_viewport_size({'width':width,'height':height})
            for entry in record['entries']:
                page.locator('[data-story-id="'+entry['id']+'"]').tap()
                page.locator('.story-controls button').last.tap()
                check('手机横屏实际触控只读回看 '+entry['id']+' '+str(width),story_fits(page)
                      and entry['lines'][0]['text'] in page.locator('#codex-detail').inner_text()
                      and page.evaluate("localStorage.getItem('kirafan-rl:profile')")==record['saved'])
        page.screenshot(path=str(OUT/'legacy-archive-landscape.png'))
        page.set_viewport_size({'width':375,'height':812});page.locator('#landscape-guard').wait_for(state='visible')
        check('旧对白回看中转竖屏仍冻结且不修改终局收据',page.evaluate('kirafanRL.world.frozen')
              and page.evaluate("localStorage.getItem('kirafan-rl:profile')")==record['saved'])
        page.set_viewport_size({'width':812,'height':375});page.locator('#landscape-guard').wait_for(state='hidden')
        check('旧对白回到横屏保持原来回看位置',record['entries'][-1]['lines'][0]['text'] in page.locator('#codex-detail').inner_text())
        page.locator('#codex-close').tap()
        check('旧对白手机图鉴关闭回到选角且不创建冒险',page.locator('#roster-overlay').is_visible() and profile(page)['run'] is None)
    finally:context.close()


def verify_actor(page, case):
    card_id, key, who, name, page_id = case
    prefix = str(card_id) + " " + name + "："
    missing, found = "chatter_" + key + "_missing", "chatter_" + key + "_found"
    page.locator('.roster-card').filter(has=page.locator('img.art[src$="/' + str(card_id) + '.webp"]')).click(timeout=60000)
    ready(page)
    page.evaluate("window.kirafanRL.world.player.iframes=1e9")
    dismiss(page, skip=True)
    check(prefix + "真实选角保留当前卡身份", page.evaluate("window.kirafanRL.world.player.card.id") == card_id)
    enter(page, "rest")
    page.wait_for_function("window.kirafanRL.interactPending===0", timeout=60000)
    before = resources(page)
    press(page, "e")
    page.wait_for_function("document.querySelector('#rl-supply-choice .decision-character img')?.naturalWidth>0")
    check(prefix + "补给头像为可显示的当前旅人", page.evaluate("""async () => {
        const {PLAYABLE_IDS}=await import('/site/game/rl/rosterids.js'),card=window.kirafanRL.npcCard;
        const id=card ? card.evolvedId||card.id : window.kirafanRL.world.player.card.id;
        return PLAYABLE_IDS.includes(id) && document.querySelector('#rl-supply-choice .decision-character img').src.endsWith('/'+id+'.webp');
    }"""))
    page.keyboard.press("Escape")
    check(prefix + "取消不消费补给或触发闲聊", resources(page) == before
          and not seen(page, missing) and not page.locator("#dialogue-box").is_visible())
    press(page, "e")
    page.locator("#supply-gauge").click()
    check(prefix + "预览不消费且不提前触发对白", resources(page) == before
          and not seen(page, missing) and not page.locator("#dialogue-box").is_visible())
    page.locator("#room-event-confirm").click()
    page.evaluate("window.kirafanRL.step(1/60)")
    lines = page.evaluate("id => window.kirafanDialogue[id]", missing)
    partner = "うつつ" if key == "kirara" else "きらら"
    check(prefix + "当前人物开场并由同行者回应", len(lines) == 2
          and [line["who"] for line in lines] == [who, partner])
    state = wait_line(page, lines[0]["text"])
    check(prefix + "画面姓名与当前角色一致", compact(state["name"]) == name, state)
    portraits.append({"card": card_id, **state["portrait"]})
    check(prefix + "对白肖像已解码且可见", state["portrait"]["loaded"] and state["portrait"]["visible"], state)
    check(prefix + "未读完不提前归档且战斗冻结", not seen(page, missing)
          and page.evaluate("window.kirafanRL.world.frozen"))
    page.set_viewport_size({"width": 390, "height": 844})
    check(prefix + "窄屏正文与跳过按钮可达", dialogue_fits(page))
    if key in ("kisaragi", "claire", "alice", "harumi"):
        page.screenshot(path=str(OUT / (key + "-missing-390.png")))
    page.locator("#dialogue-box").click()
    response = wait_line(page, lines[1]["text"])
    check(prefix + "第二句正确切换到同行者", compact(response["name"]) == {"きらら": "琪拉拉", "うつつ": "住良木现"}[partner])
    check(prefix + "第二句显示时仍不提前归档", not seen(page, missing))
    page.locator("#dialogue-box").click()
    page.wait_for_function("!window.kirafanRL.world.frozen")
    check(prefix + "完整阅读后归档一次并保存补给收据", seen(page, missing)
          and profile(page)["meta"]["storySeen"].count(missing) == 1
          and any(row.get("supply") == "gauge" and row.get("rested") for row in profile(page)["run"]["roomClaims"]))

    # Use the same durable page command as real collection; never edit raw bytes.
    page.evaluate("""async id => {
        const {createMeta}=await import('/site/game/rl/meta.js');const meta=createMeta();meta.read();
        if(!meta.collectPage(id)) throw new Error('page fixture was not newly collected');
    }""", page_id)
    page.reload(wait_until="load")
    page.locator("#roster-continue").click(timeout=60000)
    ready(page)
    check(prefix + "重载不重播已归档节点", not page.locator("#dialogue-box").is_visible() and seen(page, missing))
    enter(page, "rest")
    before = resources(page)
    press(page, "e")
    found_lines = page.evaluate("id => window.kirafanDialogue[id]", found)
    state = wait_line(page, found_lines[0]["text"])
    check(prefix + "作品页变更选择另一分支而不串人物", found_lines[0]["who"] == who
          and compact(state["name"]) == name and not page.locator("#rl-supply-choice").count())
    dismiss(page, skip=True)
    check(prefix + "明确跳过归档且不发第二份补给", seen(page, found) and resources(page) == before)

    page.set_viewport_size({"width": 1280, "height": 840})
    menu_before=page.evaluate("""()=>({frozen:kirafanRL.world.frozen,
        tooltip:!document.querySelector('.hud-skill-tooltip').hidden,
        focus:document.activeElement.id,dialogue:document.getElementById('dialogue-box')?.style.display,
        menuInput:kirafanRL.input.state.menu})""")
    press(page, "Escape")
    check(prefix + "改变窗口尺寸后第一次Escape可打开菜单",page.locator('#menu-panel').is_visible(),menu_before)
    page.locator("#menu-codex").click()
    page.locator('.codex-tab[data-tab="stories"]').click()
    page.locator('[data-story-id="' + found + '"]').click()
    before = resources(page, include_profile=True)
    check(prefix + "图鉴显示正确的已读人物与正文", name in compact(page.locator("#codex-detail").inner_text())
          and found_lines[0]["text"] in page.locator("#codex-detail").inner_text())
    for _ in range(5):
        page.locator(".story-controls button").last.click()
    check(prefix + "回看不改变档案字节、资源与收据", resources(page, include_profile=True) == before)
    page.keyboard.press("Escape")
    page.evaluate("window.kirafanRL.step(1/60)")
    check(prefix + "关闭图鉴恢复冒险而不打开底层菜单", not page.evaluate("window.kirafanRL.world.frozen")
          and not page.locator("#menu-panel").is_visible())

    # Both conditional branches are read: the third talk uses existing guest
    # chatter, not a repeated conditional scene or another supply transaction.
    expected = page.evaluate("""async () => {
        const {dialogueNameForCard}=await import('/site/game/rl/storycharacters.js'),k=window.kirafanRL;
        const who=dialogueNameForCard(k.npcCard||k.world.player.card);
        return [1,2,3].map(n=>({id:'rest_'+who+'_'+n,lines:window.kirafanDialogue['rest_'+who+'_'+n]})).filter(row=>row.lines);
    }""")
    before = resources(page)
    press(page, "e")
    page.wait_for_function("""texts => texts.includes(document.querySelector('#dialogue-box')
        ?.children[1]?.children[1]?.textContent)""", arg=[row['lines'][0]['text'] for row in expected], timeout=8000)
    random_line=line_state(page)
    random_story=next(row for row in expected if row['lines'][0]['text']==random_line['text'])
    check(prefix + "随机闲聊读完前不提前归档",not seen(page,random_story['id']))
    dismiss(page, skip=True)
    check(prefix + "闲聊耗尽后仍有旅人对白且无重复收益", resources(page) == before)
    check(prefix + "随机闲聊明确跳过后按实际节点归档一次",seen(page,random_story['id'])
          and profile(page)['meta']['storySeen'].count(random_story['id'])==1)

    archived = profile(page)["meta"]["storySeen"][:]
    exit_lines = page.evaluate("id => window.kirafanDialogue[id]", "exit_" + who)
    fatal_projectile(page)
    state = wait_line(page, exit_lines[0]["text"])
    check(prefix + "真实力竭使用当前人物的退场词", exit_lines[0]["who"] == who
          and compact(state["name"]) == name and page.evaluate("window.kirafanRL.world.player.dead"))
    terminal=profile(page)['lastResult']
    check(prefix + "退场正文完成前结果已提交而故事仍未归档",profile(page)['run'] is None
          and not seen(page,'exit_'+who) and terminal is not None)
    if key in ("kisaragi", "claire"):
        page.screenshot(path=str(OUT / (key + "-exit-1280.png")))
    dismiss(page, skip=key not in ('kisaragi','claire'))
    page.wait_for_selector("#rl-result[open]")
    check(prefix + "退场完成归档一次且不复活冒险或改终局收据", profile(page)["run"] is None
          and profile(page)["meta"]["storySeen"] == archived+['exit_'+who]
          and profile(page)['lastResult']==terminal
          and page.locator("#rl-result img").get_attribute("src").endswith("/" + str(card_id) + ".webp"))
    page.locator('#result-restart').click()
    page.locator('#roster-codex').wait_for(state='visible',timeout=60000)
    page.locator('#roster-codex').click();page.locator('.codex-tab[data-tab="stories"]').click()
    saved=page.evaluate("localStorage.getItem('kirafan-rl:profile')")
    for record in [random_story,{'id':'exit_'+who,'lines':exit_lines}]:
        page.locator('[data-story-id="'+record['id']+'"]').click()
        for _ in range(3):page.locator('.story-controls button').last.click()
        check(prefix + "重新出发前可只读回看 "+record['id'],record['lines'][0]['text'] in page.locator('#codex-detail').inner_text()
              and page.evaluate("localStorage.getItem('kirafan-rl:profile')")==saved and profile(page)['run'] is None)
    page.reload(wait_until='load');page.locator('#roster-codex').click(timeout=60000)
    page.locator('.codex-tab[data-tab="stories"]').click()
    check(prefix + "重载后随机闲聊与退场的归档仍然可见",all(page.locator('[data-story-id="'+id+'"]').get_attribute('data-unlocked')=='true'
          for id in [random_story['id'],'exit_'+who]))
    if key=='kisaragi':
        page.locator('[data-story-id="exit_'+who+'"]').click()
        page.screenshot(path=str(OUT/'legacy-archive-desktop.png'))
    return {'saved':page.evaluate("localStorage.getItem('kirafan-rl:profile')"),
            'entries':[random_story,{'id':'exit_'+who,'lines':exit_lines}]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--card", type=int, action="append", help="Only run a named identity fixture (repeatable).")
    args = parser.parse_args()
    selected = [row for row in CASES if not args.card or row[0] in args.card]
    if not selected or args.card and set(args.card) - {row[0] for row in CASES}:
        parser.error("--card must name one of the explicit identity fixtures")
    OUT.mkdir(parents=True, exist_ok=True)
    before = fingerprints()
    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    errors, result = [], {"complete": False, "cards": [row[0] for row in selected]}
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                               "--autoplay-policy=no-user-gesture-required"])
            result["browser"] = browser.version
            for case in selected:
                # Identity cases cover keyboard/mouse and narrow desktop windows.
                # Real mobile landscape and portrait pause are covered by rl_story_browser.
                context = browser.new_context(viewport={"width": 1280, "height": 840}, has_touch=False)
                context.add_init_script("""if(!localStorage.getItem('kirafan-rl:meta')) localStorage.setItem('kirafan-rl:meta',
                    JSON.stringify({prologueSeen:true,tutorialSeen:true}));""")
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                try:
                    page.goto(base + "/site/game/roguelike.html?volume=1&floor=5&seed=28101", wait_until="load")
                    record=verify_actor(page, case)
                except Exception:
                    page.screenshot(path=str(OUT / ("failure-" + str(case[0]) + ".png")))
                    raise
                finally:
                    context.close()
                if case[1]=='kisaragi':mobile_archive(browser,base,record,errors)
            check("所有身份场景无未处理浏览器异常", not errors, errors)
            result["complete"] = True
            browser.close()
    except Exception as error:
        result["failure"] = str(error)
        raise
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()
        after = fingerprints()
        changed = sorted(path for path in before.keys() | after.keys() if before.get(path) != after.get(path))
        result.update({"checks": checks, "errors": errors, "portraits": portraits,
                       "source_before": before, "source_after": after, "changed_during_run": changed})
        label = "-".join(str(row[0]) for row in selected) if args.card else "all"
        (OUT / ("results-" + label + ".json")).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        if changed:
            print("注意：测试期间源码变化，不能作为稳定工作树的最终验收：" + ", ".join(changed), flush=True)
    print("当前角色浏览器回归：%d 项通过" % len(checks), flush=True)


if __name__ == "__main__":
    main()
