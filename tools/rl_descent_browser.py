"""T28: real guard hits, staged floor loading, atomic checkpoint and retry UI."""
import argparse
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_result_browser import start, dismiss_dialogue, save_triggers, check, canvas_check, ready_room, prepare_prayer, confirm_prayer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "t28-descent"


def raw_profile(page):
    return page.evaluate("localStorage.getItem('kirafan-rl:profile')")


def enter_guard(page):
    page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world;
        w.enterRoom(w.dungeon.boss, 'N'); k.step(1/60);
        w.enemies.forEach(e => { e.actionTimer = 1e9; });
    }""")
    ready_room(page)
    save_triggers(page)


def _kill_guard(page):
    page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world;
        w.enemies.forEach(e => {
            e.iframes = 0;
            w.danmaku.emit('aimed', {x: e.x - 3, y: e.y, angle: 0},
                {side: 'player', power: 999999999, coef: 1, count: 1, speed: 10, life: 4});
        });
        for (let i = 0; i < 180 && w.enemies.some(e => !e.dead); i++) k.step(1/60);
        if (w.enemies.some(e => !e.dead)) throw new Error('guard must die through the actual projectile funnel');
    }""")


def clear_guard_and_pray(page):
    _kill_guard(page)
    prepare_prayer(page)
    confirm_prayer(page)


def profile(page):
    return json.loads(raw_profile(page))


def fresh_context(browser, errors, session=False):
    context = browser.new_context(viewport={"width": 1280, "height": 900}, has_touch=True)
    # step() owns simulation time in this transaction matrix. Wall-clock load
    # timeouts still run, but a slow browser must not move twice while W is held.
    context.add_init_script('window.requestAnimationFrame = () => 0')
    if session:
        context.add_init_script("""(() => {
            const actual = window.localStorage;
            window.restoreStorageAccess = () => Object.defineProperty(window, 'localStorage', {value: actual, configurable: true});
            Object.defineProperty(window, 'localStorage', {get() { throw new Error('test storage denied'); }, configurable: true});
        })();""")
    else:
        context.add_init_script("""if (!localStorage.getItem('kirafan-rl:meta')) {
            localStorage.setItem('kirafan-rl:meta', JSON.stringify({prologueSeen: true}));
        }""")
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    return context, page


def trace_writes(page, block="none"):
    page.evaluate("""block => {
        window.descentWrites = []; window.descentBlock = block;
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
            if (key !== 'kirafan-rl:profile') return original.call(this, key, value);
            const entry = {profile: JSON.parse(value), saved: false, stack: new Error().stack,
                gameTime: window.kirafanRL.world.time};
            window.descentWrites.push(entry);
            if (window.descentBlock === 'all' || window.descentBlock === 'next' && entry.profile.run?.floor === 6) {
                throw new DOMException('descent quota test', 'QuotaExceededError');
            }
            const result = original.call(this, key, value); entry.saved = true; return result;
        };
    }""", block)


def remember_source(page):
    page.evaluate("""() => {
        const k = window.kirafanRL;
        window.descentOldDungeon = k.world.dungeon;
        window.descentOldGroup = k.mapview.group;
        window.descentOldColliders = JSON.stringify(k.world.roomColliders);
        window.descentOldFog = k.scene.fog.color.getHex();
    }""")


def source_unchanged(page, label):
    check(label + "：正式层号、原场景、地形和雾色未切换", page.evaluate("""() => {
        const k = window.kirafanRL;
        return k.world.floor === 5 && k.mapview.floor === 5 && k.world.frozen
            && k.world.dungeon === window.descentOldDungeon && k.mapview.group === window.descentOldGroup
            && JSON.stringify(k.world.roomColliders) === window.descentOldColliders
            && k.scene.fog.color.getHex() === window.descentOldFog;
    }"""))


def wait_failed(page):
    page.wait_for_selector('#rl-floor-load[data-phase="failed"]', timeout=40000)
    check("失败可重试且没有解冻", page.locator("#floor-load-retry").is_enabled()
          and page.evaluate("window.kirafanRL.world.frozen"))


def wait_descended(page, floor=6):
    page.wait_for_function("""floor => {
        const k = window.kirafanRL;
        return k?.world.floor === floor && k.mapview.floor === floor
            && k.mapview.group?.name === 'room:' + k.world.roomId && !document.getElementById('rl-floor-load');
    }""", polling=50, arg=floor, timeout=40000)
    # T27 narrates a successfully activated segment before releasing story freeze.
    dismiss_dialogue(page)
    page.wait_for_function("!window.kirafanRL.world.frozen", polling=50, timeout=10000)
    check("下潜后入口、层号与碰撞同时就绪", page.evaluate("""() => {
        const k = window.kirafanRL;
        return k.world.roomId === k.world.dungeon.start && k.world.roomColliders.length > 0
            && k.mapview.group.userData.placements.length > 0;
    }"""))


def exactly_one_transition(page):
    writes = page.evaluate("window.descentWrites.filter(e => e.saved && e.profile.run?.floor === 6)")
    # Distinguish the one descent transaction from optional story archival and
    # ordinary saves that cross the same activation/autosave boundary.
    transitions = [w for w in writes if 'advanceFloor' in (w.get('stack') or '')]
    check('下一层和残页恰好一次正式提交', len(transitions) == 1
          and transitions[0]['profile']['meta']['pages'] == ['21000000']
          and transitions[0]['profile']['run']['roomClaims'] == [], len(writes))
    check('后续写入不会重发残页或改变局编号', all(
        w['profile']['runId'] == transitions[0]['profile']['runId']
        and w['profile']['meta']['pages'] == transitions[0]['profile']['meta']['pages']
        for w in writes), [w.get('stack') for w in writes])
    revisions = [w['profile']['revision'] for w in writes]
    check('保存序号单调递增', revisions == sorted(revisions) and len(set(revisions)) == len(revisions), revisions)

def resume(page, floor):
    page.wait_for_selector("#roster-continue", timeout=40000)
    page.locator("#roster-continue").click()
    ready_room(page)
    page.wait_for_function("floor => window.kirafanRL.world.floor === floor && !window.kirafanRL.world.frozen", polling=50, arg=floor)
    page.wait_for_function("window.kirafanRL.mapview.group?.name === 'room:' + window.kirafanRL.world.roomId", polling=50)


def preload_failure(page, url, label):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    before = raw_profile(page)
    remember_source(page)
    trace_writes(page)
    page.evaluate("""() => {
        const k = window.kirafanRL;
        window.descentOldDungeon = k.world.dungeon;
        window.descentOldGroup = k.mapview.group;
        window.descentOriginalPreload = k.mapview.preloadVolume;
        window.descentPreloadCalls = 0;
        k.mapview.preloadVolume = function (...args) {
            window.descentPreloadCalls++;
            return Promise.reject(new Error('injected next-floor preload failure'));
        };
    }""")
    clear_guard_and_pray(page)
    page.wait_for_timeout(150)
    evidence = page.evaluate("""() => ({floor: window.kirafanRL.world.floor,
        viewFloor: window.kirafanRL.mapview.floor, frozen: window.kirafanRL.world.frozen,
        sameDungeon: window.kirafanRL.world.dungeon === window.descentOldDungeon,
        sameGroup: window.kirafanRL.mapview.group === window.descentOldGroup,
        preloadCalls: window.descentPreloadCalls,
        durable: JSON.parse(localStorage.getItem('kirafan-rl:profile'))})""")
    (OUT / (label + "-preload-failure.json")).write_text(json.dumps({"before": json.loads(before), **evidence}, ensure_ascii=False, indent=2), encoding="utf-8")
    check("预加载异常已实际注入", evidence["preloadCalls"] == 1)
    check("预加载失败不改变正式层号、地图层号或旧场景", evidence["floor"] == 5 and evidence["viewFloor"] == 5
          and evidence["sameDungeon"] and evidence["sameGroup"], evidence)
    check("预加载失败不提前保存下一层或新增残页", evidence["durable"]["run"]["floor"] == 5
          and evidence["durable"]["meta"]["pages"] == json.loads(before)["meta"]["pages"])
    check("失败时仍冻结并提供重试", evidence["frozen"] and page.locator("#floor-load-retry").is_enabled())
    source_unchanged(page, "预加载失败")
    page.evaluate("() => { window.kirafanRL.mapview.preloadVolume = window.descentOriginalPreload; }")
    page.locator("#floor-load-retry").click()
    wait_descended(page)
    # Cross the real autosave cadence and pagehide boundary after activation.
    # A repeated save is not a repeated descent and must preserve its rewards.
    save_triggers(page)
    exactly_one_transition(page)
    check("成功后保留局编号与资源，不多发残页", profile(page)["runId"] == json.loads(before)["runId"]
          and profile(page)["meta"]["pages"] == ["21000000"])
    canvas_check(page)


def write_failure(page, url, label, all_writes=False):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    remember_source(page)
    before = raw_profile(page)
    trace_writes(page, "all" if all_writes else "next")
    clear_guard_and_pray(page)
    wait_failed(page)
    source_unchanged(page, "提交失败")
    check("提交失败保留旧层且没有残页半提交", profile(page)["run"]["floor"] == 5
          and profile(page)["meta"]["pages"] == [])
    if all_writes:
        check("所有写入失败时原始字节不变", raw_profile(page) == before)
    page.locator("#floor-load-storage").tap()
    page.wait_for_selector("#rl-storage[open]")
    if all_writes:
        with page.expect_download() as download:
            page.locator("#storage-export-pending").click()
        target = OUT / (label + "-pending-old-floor.json")
        download.value.save_as(target)
        pending = json.loads(target.read_text(encoding="utf-8"))
        check("实际下载只包含旧层已发生资源而非跳层命令", pending["run"]["floor"] == 5
              and pending["meta"]["pages"] == [] and pending["runId"] == json.loads(before)["runId"])
    page.evaluate("window.descentBlock = 'none'")
    page.locator("#storage-retry").click()
    check("普通存储重试不自动下潜或发残页", profile(page)["run"]["floor"] == 5
          and profile(page)["meta"]["pages"] == [])
    source_unchanged(page, "备份内重试")
    page.locator("#storage-close").click()
    check("关闭备份后仍冻结且焦点回到下潜窗口", page.evaluate(
        "window.kirafanRL.world.frozen && document.activeElement.id === 'floor-load-storage'"))
    page.locator("#floor-load-retry").click()
    wait_descended(page)
    exactly_one_transition(page)


def delayed_candidate(page, url, label):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    remember_source(page)
    trace_writes(page)
    page.evaluate("""() => {
        const view = window.kirafanRL.mapview;
        window.nativeGeometryResources = new WeakMap();
        window.watchGeometry = (group, owner) => {
            const own = new Set(), shared = new Set(), doors = new Set(), materials = new Set(), surfaces = new Set(), surfaceTextures = new Set();
            const nativeGeometry = new Set(), nativeMaterials = new Set(), nativeTextures = new Set();
            const instanceMaterials = new Set(), instanceTextures = new Set();
            const nativeRoots = group.children.filter(c => c.name.startsWith('native-building:'));
            const audit = {owned: 0, disposed: 0, sharedDisposed: 0, doorDisposed: 0, materialDisposed: 0, surfaceMaterialDisposed: 0, surfaceTextureDisposed: 0,
                nativeRoots: nativeRoots.length, nativeOwnership: true, nativeMaterialDisposed: 0,
                nativeTextureDisposed: 0, instanceMaterials: 0, instanceTextures: 0,
                instanceMaterialDisposed: 0, instanceTextureDisposed: 0, duplicateDisposals: 0};
            // Native arrangements (landmark/shrine/rest camp) borrow template
            // geometry from the shared LRU cache and own cloned materials only.
            // releaseRoom's blanket geometry pass must never see them: the
            // arrangement's own dispose releases the instance materials, and
            // the template keeps the geometry alive for the next instance.
            const arrangementSubtrees = [owner?.floorShrine?.object, owner?.landmark?.root,
                owner?.restCamp?.object].filter(Boolean);
            const underArrangement = node => arrangementSubtrees.some(root => {
                for (let parent = node; parent; parent = parent.parent) { if (parent === root) return true; }
                return false;
            });
            // Native templates own geometry; each instance owns cloned material/UV
            // state. Mapkit's sharedGeometry flag describes a different owner.
            nativeRoots.forEach(root => root.traverse(c => {
                if (c.geometry) nativeGeometry.add(c.geometry);
                if (!c.material) return;
                if (!c.userData.__usOwnMaterials) audit.nativeOwnership = false;
                for (const material of Array.isArray(c.material) ? c.material : [c.material]) {
                    nativeMaterials.add(material);
                    for (const key of ['map', 'alphaMap']) if (material[key]) {
                        if (!material.userData['__usOwn_' + key]) audit.nativeOwnership = false;
                        nativeTextures.add(material[key]);
                    }
                }
            }));
            group.traverse(c => {
                const inArrangement = underArrangement(c);
                if (c.geometry) {
                    (c.userData.sharedGeometry || nativeGeometry.has(c.geometry) || inArrangement
                        ? shared : own).add(c.geometry);
                }
                if (!c.material) return;
                for (const material of Array.isArray(c.material) ? c.material : [c.material]) {
                    if (c.name.startsWith('door:')) doors.add(material);
                    else if (c.name === 'room-surface') { surfaces.add(material); if (material.map) surfaceTextures.add(material.map); }
                    else if (nativeMaterials.has(material)) continue;
                    else if (inArrangement) {
                        instanceMaterials.add(material);
                        for (const key of ['map', 'alphaMap']) if (material[key]) instanceTextures.add(material[key]);
                    }
                    else materials.add(material);
                }
            });
            audit.owned = own.size;
            audit.nativeGeometries = nativeGeometry.size;
            audit.nativeMaterials = nativeMaterials.size;
            audit.nativeTextures = nativeTextures.size;
            audit.instanceMaterials = instanceMaterials.size;
            audit.instanceTextures = instanceTextures.size;
            function watch(resources, key) {
                const disposed = new Set();
                resources.forEach(resource => resource.addEventListener('dispose', () => {
                    if (disposed.has(resource)) audit.duplicateDisposals++;
                    disposed.add(resource); audit[key]++;
                }));
            }
            watch(own, 'disposed'); watch(shared, 'sharedDisposed');
            watch(doors, 'doorDisposed'); watch(materials, 'materialDisposed');
            watch(surfaces, 'surfaceMaterialDisposed'); watch(surfaceTextures, 'surfaceTextureDisposed');
            watch(nativeMaterials, 'nativeMaterialDisposed'); watch(nativeTextures, 'nativeTextureDisposed');
            watch(instanceMaterials, 'instanceMaterialDisposed'); watch(instanceTextures, 'instanceTextureDisposed');
            window.nativeGeometryResources.set(group, {geometry: nativeGeometry, materials: nativeMaterials, textures: nativeTextures});
            return audit;
        };
        window.oldGeometryAudit = window.watchGeometry(view.group, view);
        window.originalPrepare = view.prepareRoom;
        view.prepareRoom = function (...args) {
            return window.originalPrepare.apply(this, args).then(candidate => {
                window.heldCandidate = candidate;
                window.heldPrepareArgs = args;
                window.candidateAudit = window.watchGeometry(candidate.group, candidate);
                return new Promise(resolve => { window.releaseCandidate = () => resolve(candidate); });
            });
        };
    }""")
    clear_guard_and_pray(page)
    page.wait_for_function("!!window.heldCandidate", polling=50, timeout=40000)
    source_unchanged(page, "离屏准备")
    check("候选尚未挂入场景", page.evaluate("window.heldCandidate.group.parent === null"))
    native = page.evaluate("""async () => {
        // The old room is a boss arena and correctly has no work building.
        // Compare two start-room candidates to prove native sharing without
        // reintroducing an unrelated building into the live boss room.
        const peer = await window.originalPrepare(...window.heldPrepareArgs);
        const peerAudit = window.watchGeometry(peer.group, peer);
        const old = window.nativeGeometryResources.get(peer.group);
        const next = window.nativeGeometryResources.get(window.heldCandidate.group);
        const audits = [peerAudit, window.candidateAudit];
        const result = {owned: audits.every(a => a.nativeRoots === 1 && a.nativeOwnership
                && a.nativeGeometries > 0 && a.nativeMaterials > 0 && a.nativeTextures > 0),
            oldBossHasNoBuilding: window.oldGeometryAudit.nativeRoots === 0,
            sharedGeometry: old.geometry.size === next.geometry.size && [...old.geometry].every(g => next.geometry.has(g)),
            separateMaterials: [...old.materials].every(m => !next.materials.has(m)),
            separateTextures: [...old.textures].every(t => !next.textures.has(t))};
        peer.dispose();
        return result;
    }""")
    check("原作建筑真实共享模板几何，但材质与纹理属于各自实例", all(native.values()), native)
    page.locator("#floor-load-storage").click()
    page.evaluate("window.releaseCandidate()")
    page.wait_for_function("window.heldCandidate.disposed", polling=50)
    audit = page.evaluate("window.candidateAudit")
    check("迟到候选释放全部私有几何与门材质", audit["owned"] > 0
          and audit["disposed"] == audit["owned"] and audit["doorDisposed"] == 1, audit)
    check("迟到候选释放房间专属地面材质与纹理",
          audit["surfaceMaterialDisposed"] == 1 and audit["surfaceTextureDisposed"] == 1, audit)
    check("迟到候选恰好一次释放原作建筑私有材质与纹理",
          audit["nativeMaterialDisposed"] == audit["nativeMaterials"]
          and audit["nativeTextureDisposed"] == audit["nativeTextures"] and audit["duplicateDisposals"] == 0, audit)
    check("迟到候选不销毁共享模板与材质", audit["sharedDisposed"] == 0 and audit["materialDisposed"] == 0, audit)
    page.evaluate("window.heldCandidate.dispose()")
    check("候选销毁幂等", page.evaluate("""() => {
        const a = window.candidateAudit;
        return a.duplicateDisposals == 0 && a.disposed == a.owned && a.sharedDisposed == 0
            && a.materialDisposed == 0
            && a.instanceMaterialDisposed == a.instanceMaterials
            && a.instanceTextureDisposed == a.instanceTextures;
    }"""))
    source_unchanged(page, "备份窗口中的迟到回调")
    check("候选取消前不释放旧组", page.evaluate("""() => {
        const a = window.oldGeometryAudit;
        return [a.disposed, a.sharedDisposed, a.doorDisposed, a.materialDisposed,
            a.nativeMaterialDisposed, a.nativeTextureDisposed, a.duplicateDisposals].every(n => n === 0);
    }"""))
    page.locator("#storage-close").click()
    page.evaluate("() => { window.kirafanRL.mapview.prepareRoom = window.originalPrepare; }")
    page.locator("#floor-load-retry").click()
    wait_descended(page)
    exactly_one_transition(page)
    old = page.evaluate("window.oldGeometryAudit")
    check("成功替换后才释放旧组的私有资源", old["owned"] == old["disposed"]
          and old["doorDisposed"] == 1 and old["sharedDisposed"] == 0 and old["materialDisposed"] == 0
          and old["surfaceMaterialDisposed"] == 1 and old["surfaceTextureDisposed"] == 1
          and old["instanceMaterialDisposed"] == old["instanceMaterials"]
          and old["instanceTextureDisposed"] == old["instanceTextures"]
          and old["nativeMaterialDisposed"] == old["nativeMaterials"]
          and old["nativeTextureDisposed"] == old["nativeTextures"] and old["duplicateDisposals"] == 0, old)
    (OUT / (label + "-geometry.json")).write_text(json.dumps({"native": native, "candidate": audit, "old": old}, indent=2), encoding="utf-8")


def timeout_and_late(page, url, label):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    remember_source(page)
    trace_writes(page)
    page.evaluate("""() => {
        const view = window.kirafanRL.mapview, original = view.preloadVolume;
        let first = true;
        view.preloadVolume = function (...args) {
            if (!first) return original.apply(this, args);
            first = false;
            return new Promise(resolve => { window.releaseSlowLoad = () => original.apply(this, args).then(resolve); });
        };
    }""")
    clear_guard_and_pray(page)
    page.wait_for_function("!!window.releaseSlowLoad", polling=50)
    frozen = page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world;
        const before = JSON.stringify([w.time, w.player.x, w.player.y, w.player.hp, w.player.skills.gauge]);
        k.step(30);
        return before === JSON.stringify([w.time, w.player.x, w.player.y, w.player.hp, w.player.skills.gauge]);
    }""")
    check("模拟时间不能推进冻结世界或提前触发墙钟超时", frozen
          and page.locator("#floor-load-retry").is_disabled())
    page.wait_for_selector('#rl-floor-load[data-phase="failed"]', timeout=24000)
    check("真实墙钟 20 秒触发可操作的超时", "20 秒" in page.locator("#floor-load-message").inner_text())
    source_unchanged(page, "超时")
    page.locator("#floor-load-retry").click()
    wait_descended(page)
    page.evaluate("window.releaseSlowLoad()")
    page.wait_for_timeout(150)
    check("超时旧请求晚到不再切层或重新冻结", page.evaluate(
        "window.kirafanRL.world.floor === 6 && !window.kirafanRL.world.frozen && !document.getElementById('rl-floor-load')"))
    exactly_one_transition(page)


def prepare_failure(page, url, label):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    remember_source(page)
    trace_writes(page)
    page.evaluate("""() => {
        const view = window.kirafanRL.mapview;
        window.originalPrepare = view.prepareRoom;
        view.prepareRoom = () => Promise.reject(new Error('injected candidate build failure'));
    }""")
    clear_guard_and_pray(page)
    wait_failed(page)
    source_unchanged(page, "入口构建失败")
    check("入口构建失败不提交下一层", profile(page)["run"]["floor"] == 5 and profile(page)["meta"]["pages"] == [])
    page.evaluate("() => { window.kirafanRL.mapview.prepareRoom = window.originalPrepare; }")
    page.locator("#floor-load-retry").click()
    wait_descended(page)
    exactly_one_transition(page)


def assembly_failure(page, url, label, after_world=False, reload=False):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    trace_writes(page)
    page.evaluate("""afterWorld => {
        const target = afterWorld ? window.kirafanRL.world : window.kirafanRL.mapview;
        const key = afterWorld ? 'setDungeon' : 'activateRoom', original = target[key];
        target[key] = function (...args) {
            target[key] = original;
            if (afterWorld) original.apply(this, args);
            throw new Error('injected post-commit assembly failure');
        };
    }""", after_world)
    clear_guard_and_pray(page)
    wait_failed(page)
    exactly_one_transition(page)
    saved = profile(page)
    check("装配中断如实显示已提交检查点", saved["run"]["floor"] == 6
          and page.locator("#rl-floor-load").get_attribute("data-committed") == "true"
          and page.locator("#floor-load-retry").inner_text() == "重试装配")
    save_triggers(page)
    check("装配中断后旧场景不能覆盖已提交的新检查点", profile(page)["run"] == saved["run"])
    if reload:
        page.reload(wait_until="load")
        resume(page, 6)
        check("刷新直接恢复下一层而不重复发奖", profile(page)["meta"]["pages"] == saved["meta"]["pages"]
              and profile(page)["runId"] == saved["runId"])
    else:
        page.locator("#floor-load-retry").click()
        wait_descended(page)
        exactly_one_transition(page)


def hold_preload(page):
    page.evaluate("""() => {
        const view = window.kirafanRL.mapview;
        window.originalPreload = view.preloadVolume;
        view.preloadVolume = (...args) => new Promise((resolve, reject) => {
            window.releaseDescentPreload = () => window.originalPreload(...args).then(resolve, reject);
        });
    }""")


def hidden_page(page, url, label):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    remember_source(page)
    trace_writes(page)
    hold_preload(page)
    clear_guard_and_pray(page)
    page.evaluate("""() => {
        window.testHidden = true;
        Object.defineProperty(document, 'hidden', {get() { return window.testHidden; }, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
    }""")
    wait_failed(page)
    source_unchanged(page, "页面隐藏")
    page.evaluate("""() => {
        window.testHidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        window.kirafanRL.mapview.preloadVolume = window.originalPreload;
    }""")
    page.locator("#floor-load-retry").click()
    wait_descended(page)
    page.evaluate("window.releaseDescentPreload()")
    exactly_one_transition(page)


def leave_old_checkpoint(page, url, label, reload=False):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    hold_preload(page)
    clear_guard_and_pray(page)
    saved = profile(page)
    if reload:
        page.reload(wait_until="load")
    else:
        page.locator("#floor-load-back").click()
    page.wait_for_selector("#roster-continue", timeout=40000)
    check("离开加载界面保留旧层检查点和局编号", profile(page)["run"]["floor"] == 5
          and profile(page)["runId"] == saved["runId"] and profile(page)["meta"]["pages"] == [])
    resume(page, 5)
    check("继续旧层保留真实战斗后的资源", profile(page)["run"]["coin"] == saved["run"]["coin"]
          and profile(page)["run"]["exp"] == saved["run"]["exp"])


def restore_during_load(page, url, label):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    hold_preload(page)
    clear_guard_and_pray(page)
    backup = profile(page)
    backup["run"]["floor"] = 3
    backup["run"]["roomClaims"] = []
    backup["runId"] = "a" * 32
    page.locator("#floor-load-storage").click()
    page.locator("#storage-file").set_input_files({"name": "other-run.json", "mimeType": "application/json",
        "buffer": json.dumps(backup).encode("utf-8")})
    page.wait_for_function("!document.getElementById('storage-confirm').disabled", polling=50)
    page.evaluate("window.releaseDescentPreload()")
    check("预览备份时旧请求不能激活下一层", page.evaluate("window.kirafanRL.world.floor === 5 && window.kirafanRL.world.frozen"))
    page.locator("#storage-confirm").click()
    page.wait_for_selector("#roster-continue", timeout=40000)
    check("确认导入后没有旧回调或 pagehide 覆盖", profile(page)["runId"] == backup["runId"]
          and profile(page)["run"]["floor"] == 3 and profile(page)["meta"]["pages"] == [])
    resume(page, 3)


def conflicting_page(page, url, label):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    remember_source(page)
    hold_preload(page)
    clear_guard_and_pray(page)
    peer = page.context.new_page()
    peer.goto(url, wait_until="load")
    peer.wait_for_selector("#roster-continue", timeout=40000)
    peer.evaluate("""() => {
        const p = JSON.parse(localStorage.getItem('kirafan-rl:profile'));
        p.revision++; p.meta.gems += 7;
        localStorage.setItem('kirafan-rl:profile', JSON.stringify(p));
    }""")
    external = raw_profile(peer)
    page.wait_for_selector('#save-status[data-state="conflict"]')
    page.evaluate("window.releaseDescentPreload()")
    source_unchanged(page, "跨页冲突")
    check("跨页变更的原文不被加载回调覆盖", raw_profile(page) == external)
    check("冲突期间不能无提示返回并丢弃本页事实", page.locator("#floor-load-back").is_disabled())
    page.locator("#floor-load-retry").click()
    check("显式下潜重试也不能越过冲突", raw_profile(page) == external)
    peer.close()


def session_storage(page, url, label):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    clear_guard_and_pray(page)
    wait_descended(page)
    pending = page.evaluate("""async () => JSON.parse((await import('/site/game/rl/save.js')).exportPendingSave())""")
    check("会话后端允许明确的本页下潜", pending["run"]["floor"] == 6 and pending["meta"]["pages"] == ["21000000"])
    check("会话成功不冒充持久保存", "仅本页有效" in page.locator("#save-status-message").inner_text())
    page.evaluate("window.restoreStorageAccess()")
    page.locator("#save-status-retry").click()
    check("权限恢复只保存本页新检查点，不重复下潜或奖励", profile(page)["run"]["floor"] == 6
          and profile(page)["meta"]["pages"] == ["21000000"])


def loading_layout(page, url, label):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    page.evaluate("""() => {
        window.kirafanRL.mapview.preloadVolume = () => Promise.reject(new Error(
            '地图服务暂时不可达。请检查网络后重试，旧检查点没有改变。'.repeat(8)));
    }""")
    clear_guard_and_pray(page)
    wait_failed(page)
    page.wait_for_function("document.querySelector('#rl-floor-load img')?.naturalWidth > 0", polling=50)
    for width, height in [(375, 844), (390, 844), (412, 844), (430, 844), (768, 900), (1280, 900), (844, 390)]:
        page.set_viewport_size({"width": width, "height": height})
        bad = page.evaluate("""() => [...document.querySelectorAll('#rl-floor-load button')].flatMap(el => {
            const r = el.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
            return r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight
                || r.height < 44 || !el.contains(top) ? [el.id] : [];
        })""")
        check("下潜操作可达 %s×%s" % (width, height), not bad, bad)
        check("下潜界面没有横向溢出 %s×%s" % (width, height), page.evaluate("document.documentElement.scrollWidth === innerWidth"))
        if width in (375, 1280, 844):
            page.screenshot(path=str(OUT / (label + "-%sx%s.png" % (width, height))))
    page.locator(".floor-load-scroll").evaluate("el => { el.scrollTop = el.scrollHeight; }")
    page.screenshot(path=str(OUT / (label + "-scrolled.png")))
    page.keyboard.press("Escape")
    check("Escape 不会解冻或关闭加载失败窗口", page.locator("#rl-floor-load").is_visible()
          and page.evaluate("window.kirafanRL.world.frozen"))
    page.locator("#floor-load-retry").focus()
    page.keyboard.press("Shift+Tab")
    check("反向 Tab 留在操作组", page.evaluate("document.activeElement.id === 'floor-load-back'"))
    page.keyboard.press("Tab")
    check("正向 Tab 回到重试", page.evaluate("document.activeElement.id === 'floor-load-retry'"))
    page.locator("#floor-load-storage").tap()
    page.locator("#storage-close").tap()
    check("触控备份返回保持加载冻结和焦点", page.evaluate(
        "window.kirafanRL.world.frozen && document.activeElement.id === 'floor-load-storage'"))


def same_batch_death(page, url, label):
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    page.evaluate("""() => {
        const k = window.kirafanRL, w = k.world, p = w.player;
        w.enemies.forEach(e => {
            e.iframes = 0;
            w.danmaku.emit('aimed', {x: e.x-3, y: e.y, angle: 0},
                {side: 'player', power: 999999999, coef: 1, count: 1, speed: 10, life: 4});
        });
        for (let i=0; i<180 && w.enemies.some(e=>!e.dead); i++) w.update(1/60);
        p.iframes = 0;
        w.danmaku.emit('aimed', {x: p.x-3, y: p.y, angle: 0},
            {side: 'enemy', power: 999999999, coef: 1, count: 1, speed: 10, life: 4});
        for (let i=0; i<180 && !p.dead; i++) w.update(1/60);
        if (!p.dead || w.enemies.some(e=>!e.dead)) throw new Error('both actual deaths required');
        k.step(1/60);
    }""")
    dismiss_dialogue(page)
    page.wait_for_selector("#rl-result[open]")
    result = profile(page)
    check("守卫与玩家同批死亡只力竭，不下潜或发残页", result["run"] is None
          and result["meta"]["pages"] == [] and result["lastResult"]["outcome"] == "defeat"
          and page.evaluate("window.kirafanRL.world.floor === 5 && !document.getElementById('rl-floor-load')"))


def ultimate_descent(page, url, label):
    messages = []
    page.on("console", lambda message: messages.append(message.text) if message.type in ("warning", "error") else None)
    page.goto(url + "?volume=1&floor=5&seed=28101", wait_until="load", timeout=60000)
    page.wait_for_selector(".roster-card", timeout=40000)
    page.locator(".roster-card").filter(has_text="青叶").first.click()
    page.wait_for_function("window.kirafanRL?.world?.player && window.kirafanRL.world.dungeon", polling=50, timeout=40000)
    dismiss_dialogue(page)
    enter_guard(page)
    trace_writes(page)
    page.evaluate("""() => {
        const w = window.kirafanRL.world;
        w.player.iframes = 1e9;
        w.enemies.forEach(e => { e.hp = 1; e.iframes = 0; });
        w.player.skills.addGauge(w.player.skills.gaugeMax);
    }""")
    page.keyboard.down("r")
    page.evaluate("window.kirafanRL.step(1/60)")
    page.keyboard.up("r")
    try:
        page.wait_for_function("!!window.kirafanRL.ultimate.stage", polling=50, timeout=40000)
    except Exception:
        state = page.evaluate("""() => {
            const k=window.kirafanRL, w=k.world, p=w.player;
            return {floor:w.floor, frozen:w.frozen, playerDead:p.dead, state:p.sm.state,
                card:p.card, ultimate:p.skills.ultimate, gauge:p.skills.gauge, ready:p.skills.ultimateReady,
                loading:k.ultimate.loading, input:k.input.state, enemies:w.enemies.map(e=>({hp:e.hp,dead:e.dead})),
                dialogs:[...document.querySelectorAll('dialog[open]')].map(el=>el.id),
                floorLoad:document.getElementById('floor-load-message')?.textContent};
        }""")
        (OUT / (label + "-failure.json")).write_text(json.dumps({"state":state,"messages":messages}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"state":state,"messages":messages}, ensure_ascii=False), flush=True)
        raise
    check("真实必杀致死期间延迟下潜事件", page.evaluate(
        "window.kirafanRL.world.enemies.every(e=>e.dead) && window.kirafanRL.world.floor === 5 && window.kirafanRL.world.frozen")
          and profile(page)["meta"]["pages"] == [])
    page.locator(".rl-ultimate-skip").click()
    prepare_prayer(page)
    confirm_prayer(page)
    wait_descended(page)
    exactly_one_transition(page)


def main():
    scenarios = {
        "preload": preload_failure,
        "write": write_failure,
        "write-all": lambda p, u, l: write_failure(p, u, l, all_writes=True),
        "candidate": delayed_candidate,
        "timeout": timeout_and_late,
        "prepare": prepare_failure,
        "assembly": assembly_failure,
        "partial": lambda p, u, l: assembly_failure(p, u, l, after_world=True),
        "reload": lambda p, u, l: assembly_failure(p, u, l, reload=True),
        "hidden": hidden_page,
        "return": leave_old_checkpoint,
        "reload-old": lambda p, u, l: leave_old_checkpoint(p, u, l, reload=True),
        "restore": restore_during_load,
        "conflict": conflicting_page,
        "session": session_storage,
        "layout": loading_layout,
        "double-death": same_batch_death,
        "ultimate": ultimate_descent,
    }
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", default="browser")
    parser.add_argument("--scenario", choices=["all", *scenarios], default="all")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with Server(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = "http://127.0.0.1:%d/site/game/roguelike.html" % server.server_address[1]
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])
                errors = []
                for name in scenarios if args.scenario == "all" else [args.scenario]:
                    print("SCENARIO " + name, flush=True)
                    context, page = fresh_context(browser, errors, session=name == "session")
                    try:
                        scenarios[name](page, url, args.label + "-" + name)
                    except BaseException as error:
                        try:
                            state = page.evaluate('''()=>{const k=kirafanRL,w=k.world;
                                return {floor:w.floor,room:w.roomId,frozen:w.frozen,locked:w.roomLocked,
                                    pending:k.pending,interactPending:k.interactPending,loading:k.roomLoading,
                                    player:w.player&&{hp:w.player.hp,dead:w.player.dead,x:w.player.x,y:w.player.y,state:w.player.sm.state},
                                    phase:document.querySelector('#rl-floor-load')?.dataset.phase,
                                    message:document.querySelector('#floor-load-message')?.textContent,
                                    dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.id),
                                    enemies:w.enemies.map(e=>({kind:e.kind,hp:e.hp,dead:e.dead})),
                                    claims:w.getRoomClaims()};}''')
                            (OUT / (args.label + '-' + name + '-failure-state.json')).write_text(
                                json.dumps({'failure':str(error),'state':state}, ensure_ascii=False, indent=2), encoding='utf8')
                            page.screenshot(path=str(OUT / (args.label + '-' + name + '-failure.png')))
                        except Exception as diagnostic_error:
                            print('Failure diagnostic: ' + str(diagnostic_error), flush=True)
                        raise
                    finally:
                        try:
                            (OUT / (args.label + '-' + name + '-writes.json')).write_text(
                                json.dumps(page.evaluate('window.descentWrites || []'), ensure_ascii=False, indent=2),
                                encoding='utf8')
                        except Exception as diagnostic_error:
                            print('Write journal diagnostic: ' + str(diagnostic_error), flush=True)
                        context.close()
                check("没有未捕获页面异常", not errors, errors)
                browser.close()
        finally:
            server.shutdown(); thread.join(timeout=5)
    print("DESCENT ALL OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
