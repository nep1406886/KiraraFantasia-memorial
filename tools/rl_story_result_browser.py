"""Previous-result stories through real terminal confirmation and a new run.

Room/position and lethal projectile fixtures are explicit; they do not call a
story selector, archive command, receipt writer or reward reducer. Profiles used
by fault/mobile cases are captured from the preceding actual player journey.
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
from rl_story_roster_browser import fingerprints, line_state, resources, wait_line
from rl_terminal_browser import fatal_projectile
from rl_result_browser import kill_boss

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "story-result"
checks = []


def check(label, condition, detail=None):
    if not condition:
        raise AssertionError(label + ": " + str(detail))
    checks.append(label)
    print("PASS " + label, flush=True)


def source_state():
    result = fingerprints()
    for path in (ROOT / "site/asset/rl").glob("*.json"):
        result[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def raw(page):
    return page.evaluate("localStorage.getItem('kirafan-rl:profile')")


def choose(page, card_id):
    page.locator('.roster-card').filter(has=page.locator('img.art[src$="/' + str(card_id) + '.webp"]')).click(timeout=60000)
    ready(page)
    page.evaluate("kirafanRL.world.player.iframes=1e9")
    # Volume five queues two nodes. A hidden presenter between asynchronous
    # portraits is not the end of its opening queue or room reveal.
    for _ in range(30):
        page.wait_for_function("""() => !kirafanRL.world.frozen
            || getComputedStyle(document.getElementById('dialogue-box')).display!=='none'""", timeout=60000)
        dismiss(page, skip=True)
        if page.evaluate('!kirafanRL.world.frozen&&!kirafanRL.roomLoading'):
            return
    raise AssertionError('opening dialogue/reveal did not finish')


def rest(page):
    enter(page, "rest")
    page.wait_for_function("kirafanRL.interactPending===0", timeout=60000)


def read_again(page, node):
    press(page, "Escape")
    page.locator("#menu-codex").click()
    page.locator('.codex-tab[data-tab="stories"]').click()
    page.locator('[data-story-id="' + node + '"]').click()


def terminal(page, volume, outcome):
    if outcome == "defeat":
        fatal_projectile(page)
    else:
        enter(page, "boss")
        dismiss(page, skip=True)
        kill_boss(page)
        dismiss(page, skip=True)
        page.wait_for_function("kirafanRL.world.floorExitReady && kirafanRL.mapview.floorShrine?.room===kirafanRL.world.room", timeout=60000)
        check("卷%d首领击破仍保留拾取阶段，不提前结算" % volume, profile(page)["run"] is not None and profile(page)["lastResult"] is None)
        page.evaluate("""() => {const k=kirafanRL,w=k.world,s=w.floorShrine;
            w.player.x=s.x;w.player.y=s.y+1.3;k.step(1/60);}""")
        press(page, "e")
        page.locator("#floor-departure-confirm").click()
    dismiss(page, skip=True)
    page.locator("#rl-result[open]").wait_for(timeout=60000)
    receipt = profile(page)["lastResult"]
    check("卷%d%s真实终局收据待确认且不提前归档重返故事" % (volume, outcome),
          receipt["outcome"] == outcome and receipt["volume"] == volume and not receipt["acknowledged"]
          and profile(page)["run"] is None and not any(id.startswith("return_") for id in profile(page)["meta"]["storySeen"]))
    return receipt


def journey(page, base, volume, outcome):
    label = "卷%d%s：" % (volume, outcome)
    node = "return_v%d_%s" % (volume, outcome)
    page.goto(base + "/site/game/roguelike.html?volume=%d&floor=20&seed=28119" % volume, wait_until="load", timeout=60000)
    choose(page, 25002001)
    previous = terminal(page, volume, outcome)
    page.locator("#result-restart").click()
    page.locator("#roster-codex").wait_for(state="visible", timeout=60000)
    acknowledged = profile(page)["lastResult"]
    check(label + "结果确认仅更改确认标记，不创建冒险或推断已读",
          acknowledged == {**previous, "acknowledged": True} and profile(page)["run"] is None and not seen(page, node))
    # A different current volume and actor must not rewrite the previous trip.
    target_volume = volume % 5 + 1
    page.goto(base + "/site/game/roguelike.html?volume=%d&seed=28120" % target_volume, wait_until="load", timeout=60000)
    choose(page, 32022001)
    current = profile(page)
    check(label + "换卷换角的新局保留上一趟而不误认当前角色", current["run"]["cardId"] == 32022001
          and current["run"]["volume"] == target_volume and current["runId"] != previous["runId"]
          and current["lastResult"] == acknowledged and not seen(page, node))
    rest(page)
    before = resources(page)
    press(page, "e")
    page.locator('#supply-gauge').wait_for(state='visible', timeout=10000)
    page.keyboard.press("Escape")
    check(label + "取消补给不消费且不触发结果闲谈", resources(page) == before and not seen(page, node)
          and not page.locator("#dialogue-box").is_visible(),
          {'before': before, 'after': resources(page), 'seen': seen(page, node),
           'dialogue': line_state(page), 'frozen': page.evaluate('kirafanRL.world.frozen')})
    press(page, "e")
    page.locator("#supply-gauge").click()
    check(label + "预览仍不提前归档重返故事", resources(page) == before and not seen(page, node))
    page.locator("#room-event-confirm").click()
    page.evaluate("kirafanRL.step(1/60)")
    # Collected page IDs are strings in the profile, unlike current card IDs.
    owned_pages = {str(page_id) for page_id in profile(page)["meta"]["pages"]}
    chatter = "chatter_claire_" + ("found" if "32002000" in owned_pages else "missing")
    expected_chatter = page.evaluate("id=>kirafanDialogue[id]", chatter)
    wait_line(page, expected_chatter[0]["text"])
    check(label + "原有克蕾尔条件闲聊优先，不被结果分支抢占", not seen(page, node))
    dismiss(page, skip=True)
    check(label + "角色闲聊完成后只消费一次补给", seen(page, chatter) and page.evaluate("kirafanRL.world.getSupplyOffer().used"))
    before_return = raw(page)
    before = resources(page)
    press(page, "e")
    page.locator("#dialogue-box").wait_for(state="visible", timeout=10000)
    expected = page.evaluate("id=>kirafanDialogue[id]||null", node)
    check(label + "真实再次交谈选择上一局对应的重返正文", expected is not None, line_state(page))
    state = wait_line(page, expected[0]["text"])
    check(label + "固定同行者谈旧旅程，不借用新角色经历", state["name"] == "琪拉拉"
          and [line["who"] for line in expected] == ["きらら", "うつつ"])
    check(label + "正文未完成不归档，原结果和补给都不变化", not seen(page, node) and resources(page) == before
          and profile(page)["lastResult"] == acknowledged and page.evaluate("kirafanRL.world.frozen"))
    if volume == 1 and outcome == "defeat":
        page.reload(wait_until="load", timeout=60000)
        page.locator("#roster-continue").click(timeout=60000)
        ready(page)
        check(label + "中途刷新不伪造已读且保留当前局身份", not seen(page, node) and profile(page)["runId"] == current["runId"])
        rest(page)
        before = resources(page)
        press(page, "e")
        wait_line(page, expected[0]["text"])
        check(label + "续档后再次交谈仍命中未读结果分支且无第二份补给", resources(page) == before)
    if volume in (1, 5):
        page.screenshot(path=str(OUT / (node + "-dialogue.png")))
    if outcome == "defeat":
        page.locator("#dialogue-box").click()
        wait_line(page, expected[1]["text"])
        check(label + "第二句显示时仍不提前归档", not seen(page, node))
        page.locator("#dialogue-box").click()
    else:
        page.locator("#dialogue-skip").click()
    page.wait_for_function("!kirafanRL.world.frozen")
    check(label + "阅读或明确跳过后只归档一次，不修改结算或重发补给", seen(page, node)
          and profile(page)["meta"]["storySeen"].count(node) == 1 and profile(page)["lastResult"] == acknowledged
          and profile(page)["runId"] == current["runId"] and resources(page) == before)
    press(page, "e")
    page.locator("#dialogue-box").wait_for(state="visible")
    check(label + "归档后交谈回退随机词，不重复上一局节点", line_state(page)["text"] != expected[0]["text"] and resources(page) == before)
    dismiss(page, skip=True)
    read_again(page, node)
    before_replay = raw(page)
    for _ in range(4):
        page.locator(".story-controls button").last.click()
    check(label + "图鉴已归档筛选可回看且不写档不重奖", story_fits(page) and expected[0]["text"] in page.locator("#codex-detail").inner_text()
          and raw(page) == before_replay and page.locator("#story-filter-read").get_attribute("aria-pressed") == "true")
    if volume in (1, 5):
        page.screenshot(path=str(OUT / (node + "-archive.png")))
    page.reload(wait_until="load", timeout=60000)
    page.locator("#roster-continue").click(timeout=60000)
    ready(page)
    check(label + "重载后记录持久且续档不自动重播", seen(page, node) and not page.locator("#dialogue-box").is_visible()
          and profile(page)["lastResult"] == acknowledged and profile(page)["runId"] == current["runId"])
    return {"node": node, "lines": expected, "saved": raw(page), "before_return": before_return, "receipt": acknowledged}


def mobile_replay(browser, base, record, errors):
    context = browser.new_context(viewport={"width": 375, "height": 812}, is_mobile=True, has_touch=True)
    context.add_init_script("localStorage.setItem('kirafan-rl:profile'," + json.dumps(record["saved"]) + " );")
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        volume = json.loads(record["saved"])["run"]["volume"]
        page.goto(base + "/site/game/roguelike.html?volume=%d" % volume, wait_until="load", timeout=60000)
        page.locator("#landscape-guard").wait_for(state="visible")
        check("重返故事手机竖屏不改已读或结果", raw(page) == record["saved"] and page.evaluate("kirafanRL.world.frozen"))
        page.set_viewport_size({"width": 812, "height": 375})
        page.locator("#roster-continue").tap(timeout=60000)
        ready(page)
        page.locator(".hud-pause").tap()
        page.locator("#menu-codex").tap()
        page.locator('.codex-tab[data-tab="stories"]').tap()
        before = raw(page)
        for width, height in [(812, 375), (932, 430)]:
            page.set_viewport_size({"width": width, "height": height})
            page.locator('[data-story-id="' + record["node"] + '"]').tap()
            page.locator(".story-controls button").last.tap()
            check("重返故事手机真实触控回看可达且只读 %d" % width, story_fits(page) and raw(page) == before
                  and record["lines"][1]["text"] in page.locator("#codex-detail").inner_text())
        page.screenshot(path=str(OUT / "mobile-archive.png"))
        page.set_viewport_size({"width": 375, "height": 812})
        page.locator("#landscape-guard").wait_for(state="visible")
        check("重返故事回看中转竖屏保持冻结与终局记录", raw(page) == before and page.evaluate("kirafanRL.world.frozen"))
        page.set_viewport_size({"width": 812, "height": 375})
        page.locator("#codex-close").tap()
        check("重返故事手机关闭回看恢复当前局而非旧局", not page.evaluate("kirafanRL.world.frozen")
              and profile(page)["runId"] != record["receipt"]["runId"])
    except Exception:
        page.screenshot(path=str(OUT / "mobile-failure.png"))
        raise
    finally:
        context.close()


def missing_body(browser, base, record, errors):
    context = browser.new_context(viewport={"width": 1280, "height": 840})
    context.add_init_script("localStorage.setItem('kirafan-rl:profile'," + json.dumps(record["before_return"]) + " );")
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/dialogue/returns.js", lambda route: route.fulfill(status=503, content_type="text/javascript", body=""))
    try:
        volume = json.loads(record["before_return"])["run"]["volume"]
        page.goto(base + "/site/game/roguelike.html?volume=%d" % volume, wait_until="load", timeout=60000)
        page.locator("#roster-continue").click(timeout=60000)
        ready(page)
        rest(page)
        before = resources(page)
        press(page, "e")
        check("正文HTTP503不提前归档、不重复补给、不困住战斗", not seen(page, record["node"]) and resources(page) == before
              and not page.locator("#dialogue-box").is_visible() and not page.evaluate("kirafanRL.world.frozen")
              and profile(page)["lastResult"] == record["receipt"])
        page.unroute("**/dialogue/returns.js")
        page.reload(wait_until="load", timeout=60000)
        page.locator("#roster-continue").click(timeout=60000)
        ready(page)
        rest(page)
        press(page, "e")
        wait_line(page, record["lines"][0]["text"])
        check("正文恢复后同一未读分支可再次触发", not seen(page, record["node"]))
        dismiss(page, skip=True)
        check("资源恢复后完成只归档一次且保留原收据", seen(page, record["node"])
              and profile(page)["lastResult"] == record["receipt"])
    except Exception:
        page.screenshot(path=str(OUT / "missing-body-failure.png"))
        raise
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", action="append", choices=["%d:%s" % (v, r) for v in range(1, 6) for r in ("defeat", "victory")])
    args = parser.parse_args()
    selected = args.case or ["%d:%s" % (v, r) for v in range(1, 6) for r in ("defeat", "victory")]
    OUT.mkdir(parents=True, exist_ok=True)
    report = {"complete": False, "cases": selected, "checks": checks, "errors": [], "source_before": source_state()}
    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = "http://127.0.0.1:%d" % server.server_address[1]
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])
            report["browser"] = browser.version
            for case in selected:
                volume, outcome = case.split(":")
                context = browser.new_context(viewport={"width": 1280, "height": 840})
                context.add_init_script("if(!localStorage.getItem('kirafan-rl:meta'))localStorage.setItem('kirafan-rl:meta',JSON.stringify({prologueSeen:true,tutorialSeen:true}));")
                page = context.new_page()
                page.on("pageerror", lambda error: report["errors"].append(str(error)))
                try:
                    record = journey(page, base, int(volume), outcome)
                except Exception:
                    page.screenshot(path=str(OUT / ("failure-" + case.replace(":", "-") + ".png")))
                    raise
                finally:
                    context.close()
                if case == "1:defeat":
                    mobile_replay(browser, base, record, report["errors"])
                    missing_body(browser, base, record, report["errors"])
            check("上一局剧情全部场景无未处理浏览器异常", not report["errors"], report["errors"])
            report["complete"] = True
            browser.close()
    except Exception as error:
        report["failure"] = str(error)
        raise
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()
        report["source_after"] = source_state()
        report["changed_during_run"] = sorted(path for path in report["source_before"].keys() | report["source_after"].keys()
                                               if report["source_before"].get(path) != report["source_after"].get(path))
        (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("上一局剧情浏览器回归：%d项通过" % len(checks), flush=True)


if __name__ == "__main__":
    main()
