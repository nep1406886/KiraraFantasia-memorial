"""T28: real map document/model/atlas faults and staged-map ownership."""
import argparse
import functools
import json
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
from serve import NoCacheHandler, Server
from rl_descent_browser import fresh_context, enter_guard, kill_guard, remember_source, source_unchanged, wait_failed, wait_descended, profile
from rl_result_browser import start, check, canvas_check

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "t28-descent"
BIOME = "1018_1"
MODEL = "DeepGreenSeaWeed_C2.glb.gz"
ATLAS = "QuestMapObj_1_icon.webp"


def rendered_atlases(page):
    check("实际场景图集已解码且保留原 UV/透明裁切规则", page.evaluate("""() => {
        const group = window.kirafanRL.mapview.group;
        const meshes = group.children.filter(c => c.name.startsWith('kit:'));
        return meshes.length > 0 && meshes.every(c => c.material.map?.image?.complete
            && c.material.map.image.naturalWidth > 0 && c.material.map.flipY === false
            && c.material.alphaTest === 0.5 && c.material.map.colorSpace === 'srgb');
    }"""))
    canvas_check(page)


def network_fault(page, url, label, kind):
    atlas = kind.startswith("atlas")
    late = kind.endswith("late")
    name = ATLAS if atlas else MODEL
    fragment = "/site/asset/img/rl/mapkit/" + BIOME + "/" + name
    pattern = "**" + fragment + "*"
    requests, held = [], []

    def intercept(route):
        requests.append(route.request.url)
        if late:
            if len(requests) == 1:
                held.append(route)
            else:
                route.continue_()
        else:
            route.abort("failed")

    page.route(pattern, intercept)
    start(page, url + "?volume=1&floor=5&seed=28101")
    enter_guard(page)
    remember_source(page)
    kill_guard(page)
    if late:
        end = time.monotonic() + 15
        while not held and time.monotonic() < end:
            page.wait_for_timeout(30)
        check("实际网络请求被挂起", len(held) == 1, requests)
        source_unchanged(page, "网络挂起")
        page.locator("#floor-load-storage").click()
        page.locator("#storage-close").click()
        page.locator("#floor-load-retry").click()
        arrived = True
        try:
            page.wait_for_function("window.kirafanRL.world.floor === 6 && !window.kirafanRL.world.frozen", timeout=8000)
        except PlaywrightTimeout:
            arrived = False
        evidence = {"requestsBeforeRelease": requests[:], "arrivedBeforeRelease": arrived}
        page.evaluate("""() => {
            window.activeBeforeLate = window.kirafanRL.mapview.group;
            window.activeGeometryDisposals = 0;
            window.activeBeforeLate.traverse(c => {
                if (c.geometry) c.geometry.addEventListener('dispose', () => window.activeGeometryDisposals++);
            });
        }""")
        for route in held:
            route.continue_()
        held.clear()
        page.wait_for_timeout(250)
        (OUT / (label + "-network.json")).write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        check("重试发起独立网络请求，不等待旧请求解除", arrived and len(evidence["requestsBeforeRelease"]) >= 2, evidence)
        check("网络迟到结果不替换或释放当前地图", page.evaluate(
            "window.kirafanRL.mapview.group === window.activeBeforeLate && window.activeGeometryDisposals === 0 && !window.kirafanRL.world.frozen"))
    else:
        wait_failed(page)
        source_unchanged(page, "真实网络失败")
        check("配置中的模型或图集缺失必须阻止提交", len(requests) > 0
              and profile(page)["run"]["floor"] == 5 and profile(page)["meta"]["pages"] == [])
        failed_count = len(requests)
        page.unroute(pattern, intercept)
        recovered = []
        page.on("request", lambda request: recovered.append(request.url) if fragment in request.url else None)
        page.locator("#floor-load-retry").click()
        wait_descended(page)
        check("网络恢复实际重新请求失败素材", len(recovered) > 0, {"failed": failed_count, "retried": recovered})
    rendered_atlases(page)
    check("真实素材加载完成后仅救回一页", profile(page)["run"]["floor"] == 6
          and profile(page)["meta"]["pages"] == ["21000000"])
    page.screenshot(path=str(OUT / (label + ".png")))


def isolated_view(page, url):
    blank = url.rsplit("/", 1)[0] + "/mapload-test"
    page.route("**/game/mapload-test", lambda route: route.fulfill(content_type="text/html", body="<!doctype html><title>Map lifecycle test</title>"))
    page.goto(blank)
    page.evaluate("""async () => {
        const loader = await import('/site/core/loader.js');
        const modules = await loader.loadModules();
        window.maps = await import('/site/game/rl/view/mapview.js');
        window.dungeons = await import('/site/game/rl/dungeon.js');
        window.schemas = await import('/site/game/rl/runschema.js');
        window.mapScene = new modules.THREE.Scene();
        window.mapView = window.maps.createMapView(window.mapScene, 1);
        window.prepareTestMap = floor => {
            const d = window.dungeons.generateDungeon(window.schemas.layoutSeedFor(28101, floor));
            const room = d.rooms.find(r=>r.id === d.start);
            return window.mapView.prepareRoom(room, undefined, window.dungeons.doorsOf(d, room.id).map(d=>d.side), {floor, strict: true});
        };
    }""")


def documents_and_ownership(page, url, label):
    isolated_view(page, url)
    blocked = "**/site/asset/rl/floors.json"
    hits = []
    def abort(route):
        hits.append(route.request.url)
        route.abort("failed")
    page.route(blocked, abort)
    failed = page.evaluate("""async () => {
        try { await window.mapView.preloadVolume(1, 6, {strict: true}); return false; }
        catch (_) { return true; }
    }""")
    check("元数据网络失败不是成功", failed and len(hits) == 1)
    page.unroute(blocked, abort)
    proof = page.evaluate("""async () => {
        const view = window.mapView;
        await view.preloadVolume(1, 6, {strict: true, retry: true});
        const first = await window.prepareTestMap(6);
        const offscreen = view.group === null && view.floor === 1 && first.group.parent === null;
        view.activateRoom(first);
        const second = await window.prepareTestMap(6);
        const same = JSON.stringify(first.result.placements) === JSON.stringify(second.result.placements);
        view.setDoorsLocked(true);
        const independentDoor = first.doorMat !== second.doorMat && second.doorMat.color.getHex() === 0xffffff;
        const kit = first.group.children.find(c => c.name.startsWith('kit:'));
        const color = kit.material.color.getHex();
        const nightView = window.maps.createMapView(window.mapScene.clone(false), 5);
        const dungeon = window.dungeons.generateDungeon(28101);
        const room = dungeon.rooms.find(r=>r.id === dungeon.start);
        const night = await nightView.prepareRoom(room, '1018_1', ['N'], {floor: 1, strict: true});
        const noTint = kit.material.color.getHex() === color;
        night.dispose(); second.dispose();
        const before = view.group;
        let refused = false;
        try { view.activateRoom(second); } catch (_) { refused = true; }
        view.dispose();
        return {offscreen, same, independentDoor, noTint, refused, disposed: first.disposed,
            empty: view.group === null && window.mapScene.children.length === 0,
            oldWasActive: before === first.group};
    }""")
    for key, text in [("offscreen", "准备不改变活动场景或正式层号"), ("same", "暖缓存重复准备保留相同布局"),
                      ("independentDoor", "候选门材质不受旧房间开关影响"), ("noTint", "夜景候选不能提前染色当前共享材质"),
                      ("refused", "已销毁候选不能再激活"), ("disposed", "视图关闭释放当前候选"), ("empty", "视图关闭移除所属场景组")]:
        check(text, proof[key], proof)
    (OUT / (label + "-ownership.json")).write_text(json.dumps(proof, indent=2), encoding="utf-8")


def stale_build(page, url, label):
    isolated_view(page, url)
    page.evaluate("""async () => {
        await window.mapView.preloadVolume(1, 6, {strict: true});
        window.mapView.activateRoom(await window.prepareTestMap(6));
    }""")
    held = []
    pattern = "**/site/asset/img/rl/mapkit/1075_0/*.glb.gz*"
    page.route(pattern, lambda route: held.append(route))
    page.evaluate("""() => {
        const d = window.dungeons.generateDungeon(window.schemas.layoutSeedFor(28101, 6));
        const room = d.rooms.find(r=>r.id === d.start);
        window.oldMapPromise = window.mapView.buildRoom(room, '1075_0', ['N'], {strict: true})
            .then(result => { window.oldMapResult = result; });
    }""")
    until = time.monotonic() + 10
    while not held and time.monotonic() < until:
        page.wait_for_timeout(20)
    check("旧房间构建确有未完成的网络请求", bool(held))
    page.evaluate("""async () => {
        window.mapView.setFloor(7);
        const d = window.dungeons.generateDungeon(window.schemas.layoutSeedFor(28101, 7));
        const room = d.rooms.find(r=>r.id === d.start);
        await window.mapView.buildRoom(room, undefined, ['N'], {strict: true});
        window.newMapGroup = window.mapView.group;
    }""")
    page.unroute(pattern)
    for route in held:
        route.continue_()
    page.evaluate("window.oldMapPromise")
    check("同数字房号的旧构建不能覆盖新层", page.evaluate(
        "window.oldMapResult === null && window.mapView.floor === 7 && window.mapView.group === window.newMapGroup && window.mapScene.children.length === 1"))


def main():
    scenarios = {"model": lambda p,u,l: network_fault(p,u,l,"model"),
        "atlas": lambda p,u,l: network_fault(p,u,l,"atlas"),
        "model-late": lambda p,u,l: network_fault(p,u,l,"model-late"),
        "atlas-late": lambda p,u,l: network_fault(p,u,l,"atlas-late"),
        "ownership": documents_and_ownership, "stale": stale_build}
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=["all", *scenarios], default="all")
    parser.add_argument("--label", default="mapload")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    with Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT))) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"])
                errors = []
                url = "http://127.0.0.1:%d/site/game/roguelike.html" % server.server_address[1]
                for name in scenarios if args.scenario == "all" else [args.scenario]:
                    print("SCENARIO " + name, flush=True)
                    context, page = fresh_context(browser, errors)
                    try:
                        scenarios[name](page, url, args.label + "-" + name)
                    finally:
                        context.close()
                check("地图故障场景没有未捕获页面异常", not errors, errors)
                browser.close()
        finally:
            server.shutdown(); thread.join(timeout=5)
    print("MAPLOAD ALL OK", flush=True)


if __name__ == "__main__":
    main()

