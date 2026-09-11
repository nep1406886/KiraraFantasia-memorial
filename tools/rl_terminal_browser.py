"""T28: terminal profile transactions through real combat and durable bytes."""
import argparse
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_result_browser import start, dismiss_dialogue, save_triggers, check, enter_boss, kill_boss, ready_room, prepare_prayer, confirm_prayer

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = ROOT / ".codex-tmp" / "t28-terminal"


def fatal_projectile(page):
    page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world, p = w.player;
        p.iframes = 0;
        w.danmaku.emit('aimed', {x: p.x - 3, y: p.y, angle: 0},
            {side: 'enemy', power: 999999999, coef: 1, count: 1,
             speed: 10, life: 4});
        for (let i = 0; i < 120 && !p.dead; i++) k.step(1 / 60);
        if (!p.dead) throw new Error('real projectile did not kill the player');
    }""")


def profile(page):
    return page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile'))")


def trace_writes(page, fail_at):
    page.evaluate("""failAt => {
        window.terminalWrites = [];
        window.terminalFailAt = failAt;
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
            if (key !== 'kirafan-rl:profile') return original.call(this, key, value);
            const entry = {number: window.terminalWrites.length + 1,
                value: JSON.parse(value), committed: false, stack: new Error().stack};
            window.terminalWrites.push(entry);
            if (window.terminalFailAll || entry.number === window.terminalFailAt) {
                throw new DOMException('terminal test quota', 'QuotaExceededError');
            }
            const result = original.call(this, key, value);
            entry.committed = true;
            return result;
        };
    }""", fail_at)


def second_write_failure(page, url, label):
    start(page, url + "?volume=1&seed=28001")
    page.evaluate("""() => {
        const w = window.kirafanRL.world;
        w.enemies.forEach(e => { e.actionTimer = 1e9; });
        w.player.equipment = [{slot: 'charm', rarity: 'legendary', affixes: []}];
    }""")
    save_triggers(page)
    before = profile(page)
    check("复现前已有持久续档", before["run"] is not None)
    trace_writes(page, 2)
    fatal_projectile(page)
    immediate = page.evaluate('window.terminalWrites')
    check('力竭后、退场对白完成前只提交一次完整终局', len(immediate) == 1
          and immediate[0]['committed'] and 'Module.completeRun' in immediate[0]['stack'], immediate)
    dismiss_dialogue(page)
    page.wait_for_selector("#rl-result[open]", timeout=10000)
    after = profile(page)
    writes = page.evaluate("window.terminalWrites")
    check("终局未出现清续档但少奖励的半提交",
          not (after["run"] is None and after["meta"]["gems"] != before["meta"]["gems"] + 18),
          {"writes": len(writes), "run": after["run"],
           "gems_before": before["meta"]["gems"], "gems_after": after["meta"]["gems"]})
    check('真实力竭仅一次结算，第二次是故意失败的退场对白归档', len(writes) == 2
          and sum('Module.completeRun' in entry['stack'] for entry in writes) == 1
          and writes[0]['committed'] and not writes[1]['committed']
          and 'markStorySeen' in writes[1]['stack'], writes)
    check("完整终局含奖励与收据", after["run"] is None
          and after["meta"]["gems"] == before["meta"]["gems"] + 18
          and after.get("lastResult", {}).get("gems") == 18)
    archive = writes[1]['value']
    pending = page.evaluate("async () => JSON.parse((await import('/site/game/rl/save.js')).exportPendingSave())")
    check('失败归档只追加已读，不修改已提交奖励、收据或局编号', after == writes[0]['value']
          and terminal_payload(archive) == terminal_payload(after)
          and archive['meta']['storySeen'] == before['meta']['storySeen'] + ['exit_ゆの']
          and archive['revision'] == after['revision'] + 1
          and archive['lastResult'] == after['lastResult'])
    check('未保存退场对白保留完整候选，不能导航丢弃', pending is not None
          and terminal_payload(pending) == terminal_payload(after)
          and pending['meta']['storySeen'] == archive['meta']['storySeen']
          and pending['lastResult'] == after['lastResult']
          and page.locator('#result-restart').is_disabled()
          and page.locator('#result-save').get_attribute('data-saved') == 'false')
    page.locator('#result-retry').click()
    retried = page.evaluate('window.terminalWrites')
    final = profile(page)
    check('显式重试只保存一次合并归档，不重新结算或确认收据', len(retried) == 3
          and retried[-1]['committed'] and 'retryStorage' in retried[-1]['stack']
          and final == archive and not final['lastResult']['acknowledged']
          and page.locator('#result-save').get_attribute('data-saved') == 'true'
          and page.locator('#result-restart').is_enabled() and page.locator('#result-retry').is_hidden())
    evidence = {'before': before, 'afterArchive': after, 'pending': pending, 'afterRetry': final, 'writes': retried}
    (EVIDENCE / (label + '-second-write.json')).write_text(
        json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')



def raw_profile(page):
    return page.evaluate("localStorage.getItem('kirafan-rl:profile')")


def loaded_result(page):
    dismiss_dialogue(page)
    page.wait_for_selector("#rl-result[open]", timeout=40000)
    page.wait_for_selector("#rl-result img", timeout=40000)
    page.wait_for_function("document.querySelector('#rl-result img')?.complete && document.querySelector('#rl-result img').naturalWidth > 0", timeout=40000, polling=100)


def equipment_checkpoint(page):
    page.evaluate("""() => {
        const w = window.kirafanRL.world;
        w.enemies.forEach(e => { e.actionTimer = 1e9; });
        w.player.equipment = [{slot: 'charm', rarity: 'legendary', affixes: []}];
    }""")
    save_triggers(page)


def fresh_context(browser, errors, **kwargs):
    context = browser.new_context(viewport={"width": 1280, "height": 900}, **kwargs)
    context.add_init_script('window.requestAnimationFrame = () => 0')
    context.add_init_script("""if (!localStorage.getItem('kirafan-rl:meta')) {
        localStorage.setItem('kirafan-rl:meta', JSON.stringify({prologueSeen: true}));
    }""")
    page = context.new_page()
    page.on("pageerror", lambda err: errors.append(str(err)))
    return context, page


def downloaded(page, selector, path):
    with page.expect_download() as download:
        page.locator(selector).click()
    download.value.save_as(path)
    return path.read_text(encoding="utf-8")


_backup_serial = 0
def select_backup(page, text, name=None):
    global _backup_serial
    _backup_serial += 1
    name = name or ("receipt-%02d.json" % _backup_serial)
    with page.expect_file_chooser() as chooser:
        page.locator("#storage-select-file").click()
    chooser.value.set_files(
        {"name": name, "mimeType": "application/json", "buffer": text.encode("utf-8")})


def result_layout(page):
    for width, height in [(375, 844), (390, 844), (412, 844), (430, 844), (768, 900), (1280, 900), (844, 390)]:
        page.set_viewport_size({"width": width, "height": height})
        bad = page.evaluate("""() => {
            const dialog = document.getElementById('rl-result');
            return [...dialog.querySelectorAll('button:not([hidden])')].flatMap(el => {
                const r = el.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
                return r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight
                    || r.height < 44 || !el.contains(top) ? [el.id] : [];
            });
        }""")
        check("结果页可见按钮可达 %s×%s" % (width, height), not bad, bad)
        check("结果页无横向溢出 %s×%s" % (width, height), page.evaluate(
            "document.documentElement.scrollWidth === innerWidth"))
        if width in (375, 1280, 844):
            page.screenshot(path=str(EVIDENCE / ("pending-%sx%s.png" % (width, height))))
        if height == 390:
            page.locator(".result-scroll").evaluate("el => { el.scrollTop = el.scrollHeight; }")
            check("短横屏可以滚动查看最后一项结果", page.evaluate("""() => {
                const scroll = document.querySelector('.result-scroll'), last = scroll.querySelector('dl > div:last-child');
                const box = scroll.getBoundingClientRect(), item = last.getBoundingClientRect();
                return scroll.scrollTop > 0 && item.top >= box.top && item.bottom <= box.bottom;
            }"""))
            page.screenshot(path=str(EVIDENCE / "pending-landscape-scrolled.png"))
    page.keyboard.press("Escape")
    check("未保存结果不能被 Escape 关闭", page.locator("#rl-result").is_visible())
    page.locator("#result-title").focus()
    page.keyboard.press("Shift+Tab")
    check("从结果标题反向 Tab 到最后一个可用按钮", page.evaluate("document.activeElement.id === 'result-retry'"))
    page.keyboard.press("Tab")
    check("从末按钮正向 Tab 回到备份入口", page.evaluate("document.activeElement.id === 'result-storage'"))
    for key in ("Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"):
        page.keyboard.press(key)
        check("保存失败时键盘焦点留在结果窗口", page.evaluate(
            "document.getElementById('rl-result').contains(document.activeElement)"))
    page.set_viewport_size({"width": 390, "height": 844})


def refresh_and_ack_failure(page, url):
    before = raw_profile(page)
    receipt = profile(page)["lastResult"]
    count = len(page.evaluate('window.terminalWrites'))
    page.evaluate("""() => {
        const k = window.kirafanRL;
        k.world.events.push({type: 'hit', target: k.world.player, attacker: null, damage: 1, died: true});
        k.step(1/60);
    }""")
    check("重复死亡事件不增加写入或奖励", raw_profile(page) == before and len(page.evaluate("window.terminalWrites")) == count)
    page.reload(wait_until="load")
    loaded_result(page)
    check("刷新直接恢复同一收据且不重奖", raw_profile(page) == before and profile(page)["lastResult"] == receipt)
    check("收据恢复不加载旧战斗或终局对白", page.evaluate("!window.kirafanRL.world.player && !window.kirafanRL.world.dungeon")
          and page.locator(".roster-card").count() == 0
          and page.evaluate("!document.getElementById('dialogue-box') || document.getElementById('dialogue-box').style.display === 'none'"))
    trace_writes(page, 1)
    original_url = page.url
    page.locator("#result-restart").click()
    page.wait_for_function("!document.getElementById('result-retry').hidden", polling=100)
    check("确认写失败仍留结果页且原文不变", page.url == original_url and raw_profile(page) == before
          and not profile(page)["lastResult"]["acknowledged"])
    check("确认失败后备份和重试仍可操作", page.locator("#result-storage").is_enabled() and page.locator("#result-retry").is_enabled())
    page.locator("#result-retry").click()
    check("确认失败后的重试不自动确认或跳转", not profile(page)["lastResult"]["acknowledged"]
          and page.locator("#rl-result").is_visible() and profile(page)["meta"]["gems"] == 18)
    check("隐藏的重试按钮把焦点交回标题", page.evaluate("document.activeElement.id === 'result-title'"))
    page.locator("#result-restart").click()
    page.wait_for_selector(".roster-card", timeout=40000)
    check("确认成功后回选角，续档为空", profile(page)["lastResult"]["acknowledged"] and profile(page)["run"] is None)
    page.locator(".roster-card").first.click()
    page.wait_for_timeout(100)
    page.evaluate('window.kirafanRL?.step(1/60)')
    ready_room(page)
    check("相同显式种子的新局使用不同编号", profile(page)["runId"] != receipt["runId"]
          and profile(page)["run"]["seed"] == 28001 and profile(page)["lastResult"]["runId"] == receipt["runId"])


def pending_defeat(browser, url, errors):
    context, page = fresh_context(browser, errors, is_mobile=True, has_touch=True)
    try:
        start(page, url + "?volume=1&seed=28002")
        equipment_checkpoint(page)
        before = raw_profile(page)
        trace_writes(page, 1)
        page.evaluate("window.terminalFailAll = true")
        fatal_projectile(page)
        loaded_result(page)
        check("首次终局写失败保留整份原存档", raw_profile(page) == before and profile(page)["run"] is not None)
        check("未保存结果禁止导航", page.locator("#result-restart").is_disabled()
              and page.locator("#result-save").get_attribute("data-saved") == "false")
        result_layout(page)
        page.locator("#result-storage").tap()
        page.wait_for_selector("#rl-storage[open]")
        check("备份窗口明确区分旧续档与待确认收据", "待确认" in page.locator("#storage-pending").inner_text())
        original = downloaded(page, "#storage-export", EVIDENCE / "terminal-original.json")
        pending = downloaded(page, "#storage-export-pending", EVIDENCE / "terminal-pending.json")
        draft = json.loads(pending)
        check("原存档导出逐字节未变", original == before)
        check("本页导出是完整未提交终局", draft["run"] is None and draft["runId"] is None
              and draft["meta"]["gems"] == 18 and draft["lastResult"]["revision"] == 0)
        page.locator("#storage-close").tap()
        check("关闭内层备份返回结果按钮焦点，战斗仍冻结", page.evaluate(
            "document.activeElement.id === 'result-storage' && window.kirafanRL.world.frozen"))
        count = len(page.evaluate("window.terminalWrites"))
        page.locator("#result-retry").tap()
        check("再次写失败不丢候选也不离页", raw_profile(page) == before and page.locator("#result-restart").is_disabled()
              and len(page.evaluate("window.terminalWrites")) == count + 1)
        page.evaluate("window.terminalFailAll = false; window.terminalFailAt = 0")
        page.locator("#result-storage").tap()
        count = len(page.evaluate("window.terminalWrites"))
        page.locator("#storage-retry").tap()
        check("内层备份重试只提交一次完整终局", len(page.evaluate("window.terminalWrites")) == count + 1
              and profile(page)["meta"]["gems"] == 18 and profile(page)["run"] is None)
        page.locator("#storage-close").tap()
        check("内层重试同步外层结果状态和按钮", page.locator("#result-save").get_attribute("data-saved") == "true"
              and page.locator("#result-retry").is_hidden() and page.locator("#result-restart").is_enabled())
        check("成功收据盖当前修订号而非候选零号", profile(page)["lastResult"]["revision"] == profile(page)["revision"])
        page.locator("#result-restart").tap()
        page.wait_for_selector('.roster-card', state='attached', timeout=40000)
        check('触控确认后竖屏仍由横屏提示保护选角', page.locator('#landscape-guard').is_visible()
              and not page.locator('.roster-card').first.is_visible())
        page.set_viewport_size({'width': 844, 'height': 390})
        page.wait_for_selector(".roster-card", timeout=40000)
        check("触控确认后安全离开结果页", profile(page)["lastResult"]["acknowledged"] and profile(page)["run"] is None)
        return pending
    finally:
        context.close()


def import_receipt(browser, url, errors, pending):
    context, page = fresh_context(browser, errors)
    try:
        page.goto(url, wait_until="load")
        page.wait_for_selector("#roster-storage", timeout=40000)
        page.locator("#roster-storage").click()
        page.wait_for_selector("#rl-storage[open]", timeout=40000)
        before = raw_profile(page)
        bad = json.loads(pending); bad["lastResult"]["cardId"] = 999999
        select_backup(page, json.dumps(bad))
        page.wait_for_function("""() => {
            const name = document.querySelector('.storage-filename')?.textContent;
            return name && name !== '未选择文件';
        }""", timeout=10000, polling=100)
        page.wait_for_function("document.getElementById('storage-result').textContent.length > 0",
                               timeout=10000, polling=100)
        unknown_status = page.locator("#storage-result").inner_text()
        check("未知角色收据不能进入恢复确认", "结算角色" in unknown_status
              and page.locator("#storage-confirm").is_disabled() and raw_profile(page) == before, unknown_status)
        bad = json.loads(pending); bad["meta"]["gems"] = 0
        select_backup(page, json.dumps(bad))
        page.wait_for_function("document.getElementById('storage-result').textContent.includes('进度不符')",
                               timeout=10000, polling=100)
        check("未确认收据不能声称不存在的奖励余额", page.locator("#storage-confirm").is_disabled() and raw_profile(page) == before)
        select_backup(page, pending)
        page.wait_for_selector("#storage-preview", state="visible")
        trace_writes(page, 1)
        page.locator("#storage-confirm").click()
        check("收据导入失败不覆盖目标档案", raw_profile(page) == before and page.locator("#storage-confirm").is_enabled())
        page.locator("#storage-confirm").click()
        loaded_result(page)
        restored = profile(page)
        check("导入待保存收据直接进入结果而非战斗", restored["lastResult"]["runId"] == json.loads(pending)["lastResult"]["runId"]
              and restored["run"] is None and not restored["lastResult"]["acknowledged"]
              and page.evaluate("!window.kirafanRL.world.player && !window.kirafanRL.world.dungeon"))
        check("导入只恢复已计算奖励，不重复发放", restored["meta"]["gems"] == 18
              and page.locator("#result-save").get_attribute("data-saved") == "true")
        before = raw_profile(page)
        page.reload(wait_until="load")
        loaded_result(page)
        check("恢复收据后再次刷新仍无额外写入", raw_profile(page) == before)
    finally:
        context.close()


def terminal_payload(value):
    """Only archive additions and storage revisions may follow a terminal commit."""
    result = json.loads(json.dumps(value))
    result.pop("revision")
    result["meta"].pop("storySeen")
    result["lastResult"].pop("revision")
    return result


def victory_transactions(browser, url, errors):
    scenarios = [(1, 2, False, "archive-once"), (5, 1, False, "terminal-once"),
                 (5, 0, True, "all-failed"), (5, 3, False, "last-archive")]
    for volume, fail_at, fail_all, case in scenarios:
        context, page = fresh_context(browser, errors)
        try:
            label = " V%s/%s" % (volume, case)
            start(page, url + "?volume=%s&floor=20&seed=28003" % volume)
            enter_boss(page)
            equipment_checkpoint(page)
            before_clear = profile(page)
            kill_boss(page)
            prepare_prayer(page)
            before = raw_profile(page)
            original = json.loads(before)
            seen = original["meta"]["storySeen"]
            check('清场与战后对白只保存旧层事实，不提前结算奖励' + label,
                  original['run'] is not None and original['runId'] == before_clear['runId']
                  and original['meta']['gems'] == before_clear['meta']['gems']
                  and original['meta']['pages'] == before_clear['meta']['pages']
                  and original['meta']['volumes'] == before_clear['meta']['volumes']
                  and original.get('lastResult') == before_clear.get('lastResult')
                  and 'v%s_boss_post' % volume in seen)
            nodes = ["v%s_close" % volume]
            if volume == 5:
                nodes.append("finale_end")
            trace_writes(page, fail_at)
            page.evaluate("value => { window.terminalFailAll = value; }", fail_all)
            confirm_prayer(page)
            immediate = page.evaluate("window.terminalWrites")
            check("祈愿确认后、卷末对白完成前只尝试一次完整终局" + label, len(immediate) == 1, immediate)
            terminal = immediate[0]["value"]
            check("首个候选已包含装备折价、残页与收据，但没有提前归档对白" + label,
                  terminal["run"] is None and terminal["runId"] is None
                  and terminal["lastResult"]["runId"] == original["runId"]
                  and terminal["meta"]["volumes"] == volume
                  and terminal["meta"]["gems"] == original["meta"]["gems"] + 18
                  and terminal["lastResult"]["outcome"] == "victory"
                  and terminal["lastResult"]["gems"] == 18
                  and len(terminal["lastResult"]["newPages"]) == (7 if volume == 1 else 10)
                  and terminal["meta"]["storySeen"] == seen)
            if fail_all or fail_at == 1:
                check("首次终局写失败时原档逐字节不变" + label, raw_profile(page) == before)
                pending = page.evaluate("async () => JSON.parse((await import('/site/game/rl/save.js')).exportPendingSave())")
                check("失败候选完整且收据仍未盖持久修订号" + label,
                      terminal_payload(pending) == terminal_payload(terminal)
                      and pending["lastResult"]["revision"] == 0)
            loaded_result(page)
            archive_writes = page.evaluate("window.terminalWrites")
            check("对白每段完成后各归档一次，没有逐残页写入" + label,
                  len(archive_writes) == 1 + len(nodes), archive_writes)
            committed = 0
            for index, entry in enumerate(archive_writes):
                candidate = entry["value"]
                check("逐次写入只追加已读，不改变终局事实 #%s" % entry["number"] + label,
                      terminal_payload(candidate) == terminal_payload(terminal)
                      and candidate["meta"]["storySeen"] == seen + nodes[:index]
                      and candidate["revision"] == original["revision"] + committed + 1
                      and candidate["lastResult"]["revision"] == original["revision"] + 1
                      and entry["committed"] == (not fail_all and entry["number"] != fail_at))
                committed += int(entry["committed"])
            after_archive = raw_profile(page)
            pending = page.evaluate("async () => JSON.parse((await import('/site/game/rl/save.js')).exportPendingSave())")
            if fail_all or fail_at == 1 + len(nodes):
                latest = next((entry["value"] for entry in reversed(archive_writes) if entry["committed"]), original)
                check("失败归档不覆盖最后成功档案，结果禁止导航" + label,
                      profile(page) == latest and page.locator("#result-restart").is_disabled()
                      and page.locator("#result-save").get_attribute("data-saved") == "false")
                check("本页候选合并完整终局和所有已读对白" + label,
                      terminal_payload(pending) == terminal_payload(terminal)
                      and pending["meta"]["storySeen"] == seen + nodes
                      and pending["lastResult"]["revision"] == (0 if fail_all else original["revision"] + 1))
                if fail_all:
                    check("终局和所有归档持续失败仍保留原始字节" + label, after_archive == before)
                page.evaluate("window.terminalFailAll = false; window.terminalFailAt = 0")
                page.locator("#result-retry").click()
                retried = page.evaluate("window.terminalWrites")
                check("显式重试只提交一次合并候选" + label,
                      len(retried) == len(archive_writes) + 1 and retried[-1]["committed"])
                committed += 1
            else:
                check("后续成功归档保存完整候选且无遗留待保存数据" + label, pending is None)
            after = profile(page)
            (EVIDENCE / ("victory-v%s-%s-writes.json" % (volume, case))).write_text(
                json.dumps({"before": original, "immediate": immediate,
                    "afterArchive": json.loads(after_archive), "pending": pending, "after": after,
                    "writes": page.evaluate("window.terminalWrites")}, ensure_ascii=False, indent=2), encoding="utf-8")
            check("最终档案只有一次奖励与原收据，已读完整且从未代替用户确认" + label,
                  terminal_payload(after) == terminal_payload(terminal)
                  and after["meta"]["storySeen"] == seen + nodes
                  and after["revision"] == original["revision"] + committed
                  and after["lastResult"]["revision"] == original["revision"] + 1
                  and not after["lastResult"]["acknowledged"])
            check("保存状态、重试和导航按钮与持久字节一致" + label,
                  page.locator("#result-save").get_attribute("data-saved") == "true"
                  and page.locator("#result-retry").is_hidden()
                  and page.locator("#result-restart").is_enabled())
            count = len(page.evaluate("window.terminalWrites"))
            final_bytes = raw_profile(page)
            page.evaluate("""() => {
                const k = window.kirafanRL;
                k.world.events.push({type: 'hit', target: window.t23Boss, damage: 1, died: true});
                k.step(1 / 60);
            }""")
            save_triggers(page)
            check("重复首领致死和晚到保存不重奖、不重播或复活续档" + label,
                  raw_profile(page) == final_bytes and len(page.evaluate("window.terminalWrites")) == count
                  and page.locator("#rl-result").is_visible() and page.evaluate("window.kirafanRL.world.frozen"))
            check("下一卷按钮不越过卷五 V%s" % volume, page.locator("#result-next").count() == (1 if volume == 1 else 0))
            if case == "archive-once":
                before_refresh = raw_profile(page)
                page.goto(url + "?volume=5&floor=20", wait_until="load")
                loaded_result(page)
                check("显式其他卷入口也不能跳过未确认收据", raw_profile(page) == before_refresh and "第 1 卷" in page.locator(".result-volume").inner_text())
                page.locator("#result-next").click()
                page.wait_for_selector(".roster-card", timeout=40000)
                check("恢复收据按收据卷号前往下一卷", page.url.endswith("?volume=2") and profile(page)["lastResult"]["acknowledged"])
        finally:
            context.close()


def pending_conflict(browser, url, errors):
    context, page = fresh_context(browser, errors)
    try:
        start(page, url + "?volume=1&seed=28004")
        equipment_checkpoint(page)
        before = raw_profile(page)
        trace_writes(page, 1)
        page.evaluate('window.terminalFailAll = true')
        fatal_projectile(page)
        loaded_result(page)
        check('冲突用例先保留终局及对白的未保存候选', raw_profile(page) == before
              and page.locator('#result-restart').is_disabled()
              and all(not entry['committed'] for entry in page.evaluate('window.terminalWrites')))
        other = context.new_page()
        other.on("pageerror", lambda err: errors.append(str(err)))
        other.goto(url, wait_until="load")
        other.wait_for_selector("#roster-continue", timeout=40000)
        other.evaluate("async () => (await import('/site/game/rl/save.js')).write('cam-height', 12)")
        page.wait_for_function("document.getElementById('save-status').dataset.state === 'conflict'", polling=100)
        other_bytes = raw_profile(other)
        check("其他页面更新后终局重试被阻止", page.locator("#result-retry").is_hidden() and page.locator("#result-restart").is_disabled()
              and raw_profile(page) == other_bytes)
        page.locator("#result-storage").click()
        local = json.loads(downloaded(page, "#storage-export-pending", EVIDENCE / "terminal-conflict.json"))
        check("冲突仍能导出本页收据，不覆盖另一页面", local["lastResult"]["gems"] == 18 and local["run"] is None
              and raw_profile(other) == other_bytes and profile(other)["settings"]["cam-height"] == 12)
    finally:
        context.close()


def denied_storage(browser, url, errors, unseen=False):
    context = browser.new_context(viewport={"width": 844, "height": 390})
    context.add_init_script('window.requestAnimationFrame = () => 0')
    context.add_init_script("""(() => {
        const storage = window.localStorage;
        if (%s) storage.setItem('kirafan-rl:meta', JSON.stringify({gems: 900, prologueSeen: true}));
        window.terminalDenied = true;
        Object.defineProperty(window, 'localStorage', {configurable: true, get() {
            if (window.terminalDenied) throw new DOMException('terminal test denied', 'SecurityError');
            return storage;
        }});
    })();""" % ("true" if unseen else "false"))
    page = context.new_page()
    page.on("pageerror", lambda err: errors.append(str(err)))
    try:
        page.goto(url + "?seed=28005", wait_until="load")
        page.wait_for_selector(".roster-card", timeout=40000)
        dismiss_dialogue(page)
        page.locator(".roster-card").first.click()
        page.wait_for_function("window.kirafanRL?.world?.dungeon && window.kirafanRL.world.player", timeout=40000, polling=100)
        ready_room(page)
        page.evaluate("window.kirafanRL.world.player.iframes = 1e9")
        equipment_checkpoint(page)
        fatal_projectile(page)
        loaded_result(page)
        page.set_viewport_size({'width': 390, 'height': 844})
        check("禁存储会话不能把结算冒充持久保存", page.locator("#result-restart").is_disabled()
              and "仅本页有效" in page.locator("#result-save").inner_text())
        page.locator("#result-storage").click()
        candidate = json.loads(downloaded(page, "#storage-export-pending", EVIDENCE / ("terminal-denied-%s.json" % unseen)))
        check("禁存储仍可导出完整终局", candidate["run"] is None and candidate["lastResult"]["gems"] == 18)
        page.locator("#storage-close").click()
        page.evaluate("window.terminalDenied = false")
        page.locator("#result-retry").click()
        if unseen:
            check("权限恢复发现未读旧档时拒绝覆盖", raw_profile(page) is None
                  and page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:meta')).gems") == 900
                  and page.locator("#result-retry").is_hidden() and page.locator("#result-restart").is_disabled())
        else:
            check("权限恢复后完整提交且不重奖", profile(page)["lastResult"]["runId"] == candidate["lastResult"]["runId"]
                  and profile(page)["meta"]["gems"] == 18 and profile(page)["run"] is None
                  and page.locator("#result-save").get_attribute("data-saved") == "true")
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="browser")
    parser.add_argument("--probe-only", action="store_true")
    args = parser.parse_args()
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with Server(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = "http://127.0.0.1:%d/site/game/roguelike.html" % server.server_address[1]
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                                  "--autoplay-policy=no-user-gesture-required"])
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                context.add_init_script('window.requestAnimationFrame = () => 0')
                context.add_init_script("""if (!localStorage.getItem('kirafan-rl:meta')) {
                    localStorage.setItem('kirafan-rl:meta', JSON.stringify({prologueSeen: true}));
                }""")
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda err: errors.append(str(err)))
                second_write_failure(page, url, args.label)
                if not args.probe_only:
                    refresh_and_ack_failure(page, url)
                context.close()
                if not args.probe_only:
                    pending = pending_defeat(browser, url, errors)
                    import_receipt(browser, url, errors, pending)
                    victory_transactions(browser, url, errors)
                    pending_conflict(browser, url, errors)
                    denied_storage(browser, url, errors)
                    denied_storage(browser, url, errors, unseen=True)
                check("没有未捕获页面异常", not errors, errors)
                browser.close()
        finally:
            server.shutdown()
            thread.join(timeout=5)
    print("TERMINAL ALL OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
