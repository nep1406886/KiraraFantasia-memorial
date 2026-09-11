# Visual diagnostic for the roguelike view layer: boot, pick the first roster
# card, drive the world with step(), and screenshot the canvas. Screenshots are
# read by the agent (multimodal); the structural JSON next to them says what
# should be on screen so pixels can be cross-checked.
#
# Usage: python tools/rl_shot_diag.py PORT [volume] [tag]
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8941
    vol = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    tag = sys.argv[3] if len(sys.argv) > 3 else "diag"
    url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=%d" % (port, vol)
    result = {"console": [], "errors": []}
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("console", lambda m: result["console"].append(m.type + ": " + m.text)
                if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: result["errors"].append(str(e)))

        page.goto(url, wait_until="load", timeout=60000)
        deadline = time.time() + 120
        while time.time() < deadline:
            if page.evaluate("!!window.kirafanRL && !!window.kirafanRL.mapview.group"):
                break
            try:
                card = page.query_selector(".roster-card")
                if card:
                    card.click()
            except Exception:
                pass
            page.evaluate("window.kirafanRL && window.kirafanRL.step(1/60)")
            page.wait_for_timeout(50)
        # let the first room settle (textures, enemy views)
        for _ in range(400):
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(5)
        page.wait_for_timeout(500)
        while page.evaluate("window.kirafanRL.pending"):
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(50)

        shot = CACHE / ("rl_%s.png" % tag)
        page.screenshot(path=str(shot))

        state = page.evaluate(
            """(() => {
              const k = window.kirafanRL;
              const out = {};
              const cam = k.camera;
              cam.updateMatrixWorld();
              out.camera = {
                type: cam.isOrthographicCamera ? 'ortho' : 'persp',
                pos: cam.position.toArray().map(v => +v.toFixed(2)),
                rot: [+(cam.rotation.x).toFixed(3), +(cam.rotation.y).toFixed(3), +(cam.rotation.z).toFixed(3)],
                fov: cam.fov || null,
                aspect: +cam.aspect.toFixed(2)
              };
              out.info = { calls: k.renderer.info.render.calls, tris: k.renderer.info.render.triangles,
                           geoms: k.renderer.info.memory.geometries, tex: k.renderer.info.memory.textures };
              const pv = k.views.player;
              if (pv) {
                const o = pv.actor.object;
                out.player = { pos: o.position.toArray().map(v=>+v.toFixed(2)),
                               scale: o.scale.toArray().map(v=>+v.toFixed(2)),
                               action: pv.actor.action, lastState: pv.lastState };
              }
              out.enemies = [];
              (k.views.enemies||[]).forEach(v => {
                out.enemies.push({
                  model: v.unit.model, state: v.unit.sm.state, current: v.current,
                  pos: v.object.position.toArray().map(x=>+x.toFixed(2)),
                  scale: v.object.scale.toArray().map(x=>+x.toFixed(2))
                });
              });
              out.worldEnemies = k.world.enemies.map(e => ({model: e.model, dead: e.dead}));
              out.status = document.getElementById('status') ? document.getElementById('status').textContent : null;
              return out;
            })()""")
        # second sample after moving around: hold "up" for a bit
        page.evaluate("window.kirafanRL.input.state.move[1] = -1")
        for _ in range(120):
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(5)
        page.evaluate("window.kirafanRL.input.state.move[1] = 0")
        page.screenshot(path=str(CACHE / ("rl_%s_move.png" % tag)))
        moving = page.evaluate(
            """(() => {
              const k = window.kirafanRL;
              const pv = k.views.player;
              return pv ? { action: pv.actor.action, lastState: pv.lastState,
                            pos: pv.actor.object.position.toArray().map(v=>+v.toFixed(2)),
                            scale: pv.actor.object.scale.toArray().map(v=>+v.toFixed(2)),
                            rotz: +(pv.actor.object.rotation.z).toFixed(3) } : null;
            })()""")
        state["moving"] = moving
        print(json.dumps(state, ensure_ascii=True)[:4000])
        print("console errors/warnings:")
        for c in result["console"]:
            print("  " + c[:300])
        for e in result["errors"]:
            print("  PAGEERROR " + e[:300])
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
