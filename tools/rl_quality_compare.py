"""T29 quality-tier screenshot comparison (spec/08 section 5).

Same card, same staged poses (idle feet, run, mirrored run-stop, attack,
skill cape swing), rendered once per tier from the real game renderer with the
world frozen. Saves every shot for human review and gates coverage: a tier
that loses mirror/cape/feet pixels fails. Undersampling itself is expected and
not gated -- the >=2x restoration stays the default.
"""
import functools
import json
import base64
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

from serve import NoCacheHandler, Server
from rl_floor_loot_browser import check
from skill_playback_browser import start_game

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".codex-tmp" / "quality-compare"
TIERS = ["high", "balanced", "performance"]

# (label, action, fraction, facing) -- facing 0 mirrors the rig's Math.PI.
POSES = [
    ("idle-feet", "idle", 0.2, 3.14159),
    ("run", "battle_run", 0.3, 3.14159),
    ("run-stop-mirror", "battle_run", 0.7, 0),
    ("attack", "attack", 0.55, 3.14159),
    ("skill-cape", "class_skill_2", 0.5, 3.14159),
]

STAGE_POSE = """pose => new Promise((resolve, reject) => {
    const k = window.kirafanRL;
    const view = k.views.player;
    if (!view || !view.actor) { reject(Error('no player view')); return; }
    try {
        k.world.player.facing = pose.facing;
        // view.play registers the external action so view.sync holds the pose
        // instead of switching back to the state machine's clip.
        if (!view.play(pose.action, {fade: 0, loop: false})) {
            reject(Error('missing action ' + pose.action)); return;
        }
        const action = view.actor.mixer._actions.find(x => x.getClip().name === pose.action);
        view.actor.seek(action.getClip().duration * pose.fraction);
        view.sync(0, {x: k.world.player.x, y: k.world.player.y});
        // Fresh buffer: toDataURL must read THIS pose's frame, not the last
        // frame the paused rAF loop happened to leave behind.
        k.renderOnce();
        const shot = k.renderer.domElement.toDataURL('image/png');
        resolve(shot);
    } catch (error) { reject(error); }
})"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with Server(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = "http://127.0.0.1:%d" % server.server_address[1]
        try:
            with sync_playwright() as pw:
                browser = pw.chromium.launch(args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                                   "--autoplay-policy=no-user-gesture-required"])
                try:
                    shots = {}
                    errors = []
                    for tier in TIERS:
                        context = browser.new_context(viewport={"width": 960, "height": 640})
                        context.add_init_script("""const raf = window.requestAnimationFrame.bind(window);
                            window.requestAnimationFrame = cb => raf(t => {
                                if (!window.__manualRAF) { cb(t); } });
                            localStorage.setItem('kirafan-rl:profile', JSON.stringify({
                                profileVersion: 2, revision: 0, dataVersion: 1,
                                meta: null, run: null, runId: null,
                                settings: {quality: '%s'}, lastResult: null}));""" % tier)
                        page = context.new_page()
                        page.on("pageerror", lambda err: errors.append(str(err)))
                        start_game(page, base)
                        page.evaluate("""() => {
                            const k = window.kirafanRL;
                            if (!k.world.frozen) { k.toggleMenu(); k.step(1/60); }
                            const w = k.world;
                            w.player.x = Math.floor(w.width / 2) + .5;
                            w.player.y = Math.floor(w.height / 2) + .5;
                            w.enemies.forEach(e => { e.actionTimer = 1e9; });
                        }""")
                        for label, action, fraction, facing in POSES:
                            data = page.evaluate(STAGE_POSE, {"action": action, "fraction": fraction,
                                                              "facing": facing}).split(",", 1)[1]
                            (OUT / ("%s-%s.png" % (tier, label))).write_bytes(base64.b64decode(data))
                            shots[(tier, label)] = True
                        page.close()
                        context.close()
                    check("三档 x 五姿势全部截屏成功", len(shots) == len(TIERS) * len(POSES), list(shots))
                    check("对照无未处理页面异常", not errors, errors)
                finally:
                    browser.close()
        finally:
            server.shutdown()
            thread.join(timeout=5)

    # Pixel comparison runs in Python so the browser fixture stays pose-only.
    # The room floor makes "character vs background" segmentation unreliable,
    # so the gates are: every frame is non-blank, and the character-zone diff
    # against the high tier stays edge-scale (a lost mirror/cape/feet blob
    # pushes the diff far past it). The saved PNG grid is the reviewable
    # evidence; these gates exist to catch blank/featureless captures.
    try:
        from PIL import Image, ImageStat
    except ImportError:
        print("PIL missing; screenshots saved, diff gate skipped")
        return 0
    summary = {}
    for label, _, _, _ in POSES:
        images = {}
        for tier in TIERS:
            image = Image.open(OUT / ("%s-%s.png" % (tier, label))).convert("RGB")
            stat = ImageStat.Stat(image.convert("L"))
            check("姿势 %s 在 %s 档为非空白帧" % (label, tier), stat.stddev[0] > 6,
                  {"stddev": round(stat.stddev[0], 2)})
            images[tier] = image
        w, h = images["high"].size
        box = (int(w * .30), int(h * .25), int(w * .70), int(h * .80))
        reference = images["high"].crop(box)
        ref_pixels = reference.getdata()
        for tier in ["balanced", "performance"]:
            other = images[tier].resize((w, h), Image.BILINEAR).crop(box)
            diff = sum(1 for a, b in zip(ref_pixels, other.getdata())
                       if max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2])) > 40)
            fraction = diff / max(1, len(ref_pixels))
            summary["%s/%s" % (tier, label)] = round(fraction, 4)
            check("姿势 %s 在 %s 档与还原档的中心区差异保持边缘级（<15%%）" % (label, tier),
                  fraction < 0.15, fraction)
    (OUT / "coverage.json").write_text(json.dumps(summary, indent=1), encoding="utf8")
    print("QUALITY COMPARE OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
