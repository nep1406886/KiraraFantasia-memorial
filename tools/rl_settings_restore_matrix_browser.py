"""Settings/restore combination matrix (T28/T29): live settings at boot,
wholesale replacement by v2 backups, stale-key removal, rejected imports and
a legacy run backup that carries only a camera height."""
import functools
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright
from serve import NoCacheHandler, Server
from rl_storage_browser import fixture, raw_storage, select_backup

checks = []


def check(label, ok, detail=None):
    if not ok:
        raise AssertionError(label + ": " + repr(detail))
    checks.append(label)
    print("PASS " + label, flush=True)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "settings-restore-matrix"


def envelope(settings, meta_gems=500):
    return {"profileVersion": 2, "revision": 0, "dataVersion": 1,
            "meta": {"gems": meta_gems, "prologueSeen": True, "tutorialSeen": True},
            "run": None, "runId": None, "lastResult": None, "settings": settings}


def profile(page):
    return page.evaluate("JSON.parse(localStorage.getItem('kirafan-rl:profile'))")


def ui_state(page):
    return page.evaluate("""() => {
        const boxes = ['reduced-shake', 'reduced-flash', 'simplified-ultimates']
            .map(id => document.querySelector('#menu-' + id).checked);
        const k = window.kirafanRL;
        return {quality: document.querySelector('#menu-quality').value,
                cam: document.querySelector('#menu-cam').value, boxes,
                level: k.quality.level, ratio: String(k.renderer.getPixelRatio())};
    }""")


def open_storage(page):
    # A successful restore navigates and the modal no longer exists; case D's
    # rejected import leaves it open. Reopen from the roster only when closed.
    if not page.evaluate("document.querySelector('#rl-storage')?.open ?? false"):
        page.locator("#roster-storage").click()


def restore(page, data, name):
    open_storage(page)
    page.locator("#storage-select-file").wait_for(state="visible", timeout=60000)
    select_backup(page, data, name)
    page.locator("#storage-preview").wait_for(state="visible", timeout=60000)
    with page.expect_navigation(wait_until="load"):
        page.locator("#storage-confirm").click()
    page.locator("#roster-storage").wait_for(state="visible", timeout=60000)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    server = Server(("127.0.0.1", 0), functools.partial(NoCacheHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=1&seed=280911" % server.server_address[1]
    live = envelope({"reduced-shake": True, "reduced-flash": True,
                     "simplified-ultimates": True, "quality": "performance",
                     "cam-height": 9}, meta_gems=100)
    errors = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                               "--autoplay-policy=no-user-gesture-required"])
            try:
                context = browser.new_context(viewport={"width": 1280, "height": 900})
                context.add_init_script("if(!localStorage.getItem('kirafan-rl:profile')){"
                                        "localStorage.setItem('kirafan-rl:profile',JSON.stringify("
                                        + json.dumps(live, ensure_ascii=False) + "));}")
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(url, wait_until="load")
                page.locator("#roster-storage").wait_for(state="visible", timeout=60000)

                # A: live settings reach the menu, renderer and profile at boot.
                state = ui_state(page)
                check("boot applies live settings to menu and renderer",
                      state == {"quality": "performance", "cam": "90",
                                "boxes": [True, True, True], "level": "performance",
                                "ratio": "1"}, state)
                check("boot profile keeps live settings",
                      profile(page)["settings"] == live["settings"])

                # B: a v2 backup with different settings replaces them wholesale.
                restore(page, envelope({"reduced-shake": False, "quality": "balanced",
                                        "cam-height": 11}), "backup-b.json")
                restored = profile(page)["settings"]
                check("restore replaces settings wholesale with backup values",
                      restored == {"reduced-shake": False, "quality": "balanced",
                                   "cam-height": 11}, restored)
                state = ui_state(page)
                check("restored settings drive menu and renderer",
                      state == {"quality": "balanced", "cam": "110",
                                "boxes": [False, False, False], "level": "balanced",
                                "ratio": "1.5"}, state)

                # C: a backup without the new keys drops stale live keys too.
                restore(page, envelope({"cam-height": 11}), "backup-c.json")
                check("restore without settings keys drops stale live keys",
                      profile(page)["settings"] == {"cam-height": 11})
                state = ui_state(page)
                check("missing settings keys fall back to defaults",
                      state == {"quality": "high", "cam": "110",
                                "boxes": [False, False, False], "level": "high",
                                "ratio": "2"}, state)

                # D: an invalid settings enum is rejected before any write.
                open_storage(page)
                page.locator("#storage-select-file").wait_for(state="visible", timeout=60000)
                before = raw_storage(page)
                select_backup(page, envelope({"quality": "low", "cam-height": 11}),
                              "backup-d.json")
                page.wait_for_function(
                    "document.querySelector('#storage-result').textContent.includes('画质')",
                    timeout=60000)
                check("invalid quality enum rejects the import",
                      page.locator("#storage-confirm").is_disabled())
                check("rejected import leaves profile bytes intact",
                      raw_storage(page) == before)

                # E: a legacy run backup carries only a camera height; the run is
                # restored while settings fall back to that single value.
                legacy = fixture(page)
                # The shared fixture carries cam-height 11 (same as case C);
                # raise it so the restore must actually move the setting.
                legacy["cam-height"] = "13"
                restore(page, legacy, "backup-e.json")
                active = profile(page)
                check("legacy run restore keeps run rewards",
                      active["meta"]["gems"] == 777 and active["run"]["coin"] == 90,
                      {"gems": active["meta"]["gems"], "coin": active["run"].get("coin")})
                check("legacy run restore reduces settings to its own camera height",
                      active["settings"] == {"cam-height": 13}, active["settings"])
                state = ui_state(page)
                check("run-restore settings fall back to defaults",
                      state == {"quality": "high", "cam": "130",
                                "boxes": [False, False, False], "level": "high",
                                "ratio": "2"}, state)

                check("no uncaught browser exceptions", not errors)
                (OUT / "matrix.json").write_text(json.dumps({"browser": browser.version,
                    "errors": errors}, ensure_ascii=False, indent=2), encoding="utf-8")
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("SETTINGS RESTORE MATRIX ALL OK", flush=True)


if __name__ == "__main__":
    main()
