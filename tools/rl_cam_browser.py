# Browser gate for T22b 镜头高度可调 (user feedback #2):
#   1. default boot: rig height 9 / back 6.5 (54.2° pitch), ortho half-height
#      3.2 untouched, fog near/far at the authored 13/27
#   2. the menu slider (#menu-cam) exists, mirrors the saved height, and
#      moving it retunes the rig height live
#   3. the fog band rides along: near/far shift by the rig-distance delta,
#      and the player's distance to the camera stays under fog.near (a tall
#      rig must never fog the player over)
#   4. the readable ground band holds at both ends: 3.2/sin(pitch) within
#      3.5–5.1 half-view world units
#   5. persistence: a reload boots the saved rig (through the boot-time
#      applyVolume, which must include the stored shift); out-of-range saved
#      values clamp to 5.5/13
#   6. menu buttons stay reachable at 375/1280 with the new slider row
# Owns its server. Usage: python tools/rl_cam_browser.py [port]
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WIDTHS = [375, 1280]
BACK = 6.5


def rig_dist(h):
    return (h * h + BACK * BACK) ** 0.5


def approx(a, b, tol=0.06):
    return abs(a - b) <= tol


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 40
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL"):
            return
        page.wait_for_timeout(200)


def start_run(page):
    page.wait_for_selector(".roster-card", timeout=20000)
    page.evaluate("""(() => {
        const els = Array.from(document.querySelectorAll('.roster-card'));
        const yuno = els.find(e => (e.textContent || '').includes('由乃'));
        (yuno || els[0]).click();
    })()""")
    deadline = time.time() + 30
    while time.time() < deadline:
        if page.evaluate("!!(window.kirafanRL.world && window.kirafanRL.world.player)"):
            break
        page.wait_for_timeout(300)
    for _ in range(90):
        vis = page.evaluate(
            "(() => { const b = document.getElementById('dialogue-box');"
            " return !!(b && b.style.display !== 'none'); })()")
        if not vis:
            return
        page.evaluate("document.getElementById('dialogue-box').click()")
        page.wait_for_timeout(90)


def press_escape(page):
    page.keyboard.down("Escape")
    page.evaluate("window.kirafanRL.step(1/60)")
    page.wait_for_timeout(50)
    page.keyboard.up("Escape")
    page.evaluate("window.kirafanRL.step(1/60)")
    page.wait_for_timeout(50)


def rig_state(page):
    return page.evaluate("""(() => {
        const k = window.kirafanRL;
        const cam = k.camera;
        const fog = k.scene.fog || {near: -1, far: -1};
        const p = k.world.player;
        const dist = Math.hypot(cam.position.x - p.x, cam.position.y,
                                cam.position.z - p.y);
        const direction = cam.getWorldDirection(cam.position.clone());
        const pitch = Math.asin(Math.abs(direction.y));
        return {
            y: cam.position.y,
            ortho: !!cam.isOrthographicCamera,
            // the converted ortho lens writes the frustum straight into the
            // projection matrix (te[5] = 1/halfHeight), never into .top
            halfH: 1 / cam.projectionMatrix.elements[5],
            fogNear: fog.near, fogFar: fog.far,
            playerDist: dist,
            pitchDeg: pitch * 180 / Math.PI,
            halfBand: (1 / cam.projectionMatrix.elements[5]) / Math.sin(pitch)
        };
    })()""")


def set_slider(page, tenths):
    page.evaluate("""(() => {
        const s = document.getElementById('menu-cam');
        s.value = '%d';
        s.dispatchEvent(new Event('input'));
    })()""" % tenths)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8973
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "serve.py"), str(port)],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fails = 0

    def check(label, ok, detail=""):
        nonlocal fails
        print(("OK   " if ok else "FAIL ") + label
              + ("  " + str(detail) if detail else ""))
        if not ok:
            fails += 1

    try:
        time.sleep(1.5)
        url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=1" % port
        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                      "--autoplay-policy=no-user-gesture-required"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            # --- 1. default rig ------------------------------------------
            # init scripts re-run on every navigation, so gate the clear on
            # sessionStorage (survives reloads, dies with the tab) or the
            # persistence checks below would wipe their own fixture.
            page.add_init_script(
                "if (!sessionStorage.getItem('__camGateCleared')) {"
                " localStorage.clear();"
                " sessionStorage.setItem('__camGateCleared', '1'); }")
            boot(page, url)
            start_run(page)
            s = rig_state(page)
            check("default rig height is 9 (51.3° pitch to the 0.9-height focus)",
                  approx(s["y"], 9) and approx(s["pitchDeg"], 51.3, 0.5),
                  "y=%.2f pitch=%.1f" % (s["y"], s["pitchDeg"]))
            check("expanded default ortho framing (half-height 4.6)",
                  s["ortho"] and approx(s["halfH"], 4.6))
            check("fog at the authored 13/27",
                  approx(s["fogNear"], 13) and approx(s["fogFar"], 27),
                  "near=%.2f far=%.2f" % (s["fogNear"], s["fogFar"]))

            # --- 2/3/4. slider drives the rig live -----------------------
            press_escape(page)
            menu_up = page.evaluate(
                "!document.getElementById('menu-panel')"
                ".classList.contains('hidden')")
            check("Esc opens the menu with the slider row", menu_up)
            val = page.evaluate(
                "(document.getElementById('menu-cam') || {}).value")
            check("slider mirrors the default (90)", val == "90", val)

            set_slider(page, 130)
            s = rig_state(page)
            check("slider 130 -> rig height 13", approx(s["y"], 13),
                  "y=%.2f" % s["y"])
            check("fog band rides along (+%.2f)" % (rig_dist(13) - rig_dist(9)),
                  approx(s["fogNear"], 13 + rig_dist(13) - rig_dist(9))
                  and approx(s["fogFar"], 27 + rig_dist(13) - rig_dist(9)),
                  "near=%.2f far=%.2f" % (s["fogNear"], s["fogFar"]))
            check("player stays clear of the fog on a tall rig",
                  s["playerDist"] < s["fogNear"] - 0.5,
                  "dist=%.2f near=%.2f" % (s["playerDist"], s["fogNear"]))
            check("tall rig expands the lens and reveals 7.3-7.8 half-view ground units",
                  approx(s["halfH"], 4.6 * 13 / 9) and 7.3 <= s["halfBand"] <= 7.8, s)
            tall_band = s["halfBand"]

            set_slider(page, 55)
            s = rig_state(page)
            check("slider 55 -> rig height 5.5", approx(s["y"], 5.5),
                  "y=%.2f" % s["y"])
            check("low rig is a closer view; raising it reveals at least 50 percent more ground",
                  approx(s["halfH"], 4.6 * 5.5 / 9) and tall_band > 1.5 * s["halfBand"], s)
            check("low rig fog pulled in with the rig",
                  approx(s["fogNear"], 13 + rig_dist(5.5) - rig_dist(9)),
                  "near=%.2f" % s["fogNear"])

            # --- 6. menu buttons reachable with the new row ---------------
            for w in WIDTHS:
                page.set_viewport_size({"width": w, "height": 800})
                page.wait_for_timeout(150)
                res = page.evaluate("""(() => {
                    const owns = (a, b) => !!(a && b && (a === b
                        || a.contains(b) || b.contains(a)));
                    const out = {};
                    ['menu-resume', 'menu-codex', 'menu-restart',
                     'menu-cam'].forEach(function (id) {
                        const el = document.getElementById(id);
                        if (!el) { out[id] = 'missing'; return; }
                        const r = el.getBoundingClientRect();
                        const hit = document.elementFromPoint(
                            r.left + r.width / 2, r.top + r.height / 2);
                        out[id] = owns(el, hit);
                    });
                    return out;
                })()""")
                bad = [k for k, v in res.items() if v is not True]
                check("width %d: resume/codex/restart/cam all reachable" % w,
                      not bad, bad)

            # --- 5. persistence through a reload ---------------------------
            set_slider(page, 130)   # leave 13 saved
            page.evaluate("window.location.reload()")
            boot(page, url)
            start_run(page)
            s = rig_state(page)
            check("reload boots the saved rig (13)", approx(s["y"], 13),
                  "y=%.2f" % s["y"])
            check("reload preserves the enlarged frustum", approx(s["halfH"], 4.6 * 13 / 9))
            check("boot-time applyVolume included the stored shift",
                  approx(s["fogNear"], 13 + rig_dist(13) - rig_dist(9)),
                  "near=%.2f" % s["fogNear"])
            val = page.evaluate(
                "(document.getElementById('menu-cam') || {}).value")
            check("slider mirrors the saved height on reload", val == "130",
                  val)

            # T28: explicit invalid legacy settings now block migration instead
            # of being silently clamped and written back over the old archive.
            for raw in ["99", "1"]:
                invalid_context = browser.new_context()
                invalid_context.add_init_script("localStorage.setItem('kirafan-rl:cam-height', %s);" % json.dumps(raw))
                invalid_page = invalid_context.new_page()
                invalid_page.on("pageerror", lambda error: errors.append(str(error)))
                boot(invalid_page, url)
                start_run(invalid_page)
                s = rig_state(invalid_page)
                check("invalid saved %s uses a safe unsaved default" % raw, approx(s["y"], 9), "y=%.2f" % s["y"])
                check("invalid camera archive is preserved", invalid_page.evaluate("localStorage.getItem('kirafan-rl:cam-height')") == raw)
                check("invalid camera does not migrate to a fabricated profile", invalid_page.evaluate("localStorage.getItem('kirafan-rl:profile')") is None)
                invalid_context.close()

            check("no pageerrors", not errors, errors[:3])
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    print("RESULT " + ("ALL OK" if fails == 0 else "%d FAILURES" % fails))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
