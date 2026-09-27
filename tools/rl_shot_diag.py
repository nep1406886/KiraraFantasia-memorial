# Visual diagnostic for the roguelike view layer: boot, pick the first roster
# card, drive the world with step(), and screenshot the canvas. Screenshots are
# read by the agent (multimodal); the structural JSON next to them says what
# should be on screen so pixels can be cross-checked.
#
# Usage: python tools/rl_shot_diag.py PORT [volume] [tag]
# PORT must serve the site root directly (e.g. `python -m http.server PORT
# --directory site`), so URLs here are /game/roguelike.html, NOT
# /site/game/roguelike.html — the repo-rooted servers the *_browser gates
# spin up are a different contract.
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
    # tag, or tag[-4:] == "battle": start in the floor's BATTLE room instead
    # of the start room. A battle room is where enemies and the border ring
    # actually live — the start room has neither (spawn clearing).
    tag = sys.argv[3] if len(sys.argv) > 3 else "diag"
    want_battle = tag.endswith("battle")
    url = ("http://127.0.0.1:%d/game/roguelike.html?volume=%d&debug=1"
           % (port, vol))
    result = {"console": [], "errors": []}
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("console", lambda m: result["console"].append(m.type + ": " + m.text)
                if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: result["errors"].append(str(e)))

        # Boot gates on the prologue/tutorial dialogue when neither flag is in
        # meta storage (rl_recovery_browser.py:96-98 pattern). A diagnostic
        # page without them freezes the world on the opening box and the
        # step() loop below spins forever with an empty room.
        page.add_init_script(
            "localStorage.setItem('kirafan-rl:meta',"
            "JSON.stringify({prologueSeen:true,tutorialSeen:true}));")

        page.goto(url, wait_until="load", timeout=60000)
        deadline = time.time() + 120
        while time.time() < deadline:
            if page.evaluate("window.kirafanRL && window.kirafanRL.mapview && !!window.kirafanRL.mapview.group"):
                break
            try:
                card = page.query_selector(".roster-card")
                if card:
                    card.click()
            except Exception:
                pass
            if page.evaluate("!!window.kirafanRL"):
                page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(50)

        if not page.evaluate("window.kirafanRL && !!window.kirafanRL.mapview.group"):
            state = page.evaluate("""() => ({
                kirafanRL: !!window.kirafanRL,
                status: document.getElementById('status')?.textContent,
                rosterCards: document.querySelectorAll('.roster-card').length,
                dialogueVisible: !!document.getElementById('dialogue-box')
                    && document.getElementById('dialogue-box').offsetParent !== null
            })""")
            result["errors"].append("boot: first room never built within 120s; state=" + json.dumps(state, ensure_ascii=False))
            browser.close()
            print(json.dumps(result, ensure_ascii=True))
            return 1

        # A volume-opening dialogue (v<vol>_open) or a leftover beat freezes
        # the world; its presenter has no clock here (no rAF), so skip lines
        # manually — same dismiss() as rl_recovery_browser.py. The roster gate
        # requires the FIRST card click to remain a plain select (spec/07 §6
        # rosters elect-click), so a headless pass that picks the default card
        # has to press the card the player sees selected, which is the click —
        # rl_recovery_browser.py line ~248 does exactly that.
        #
        # click("#dialogue-skip") dies whenever the box fades out under the
        # pointer mid-click (the 120ms dlg-out timer), and the box's own
        # click-advance listener runs regardless of the target, so a direct
        # DOM .click() on the button is the same action minus the race.
        def dismiss_dialogue():
            for _ in range(90):
                visible = page.evaluate(
                    "!!document.getElementById('dialogue-box')"
                    " && !document.getElementById('dialogue-box').classList.contains('dlg-hidden')"
                    " && !document.getElementById('dialogue-box').classList.contains('dlg-out')")
                if not visible:
                    return
                page.evaluate("document.getElementById('dialogue-skip')?.click()")
                page.evaluate("window.kirafanRL.step(1/60)")
                page.wait_for_timeout(20)

        # The volume-open dialogue is queued on the world BEFORE the first
        # step (queueDialogue in volumeOpen()), so until a step lands the
        # presenter never exists and dismiss_dialogue() above is a no-op.
        # Step once through any queued node, then sweep until the box is
        # really gone.
        dismiss_dialogue()
        for _ in range(240):
            page.evaluate("window.kirafanRL.step(1/60)")
            dismiss_dialogue()
            if not page.evaluate(
                    "!!document.getElementById('dialogue-box')"
                    " && !document.getElementById('dialogue-box').classList.contains('dlg-hidden')"
                    " && !document.getElementById('dialogue-box').classList.contains('dlg-out')"):
                break
            page.wait_for_timeout(10)
        # let the first room settle (textures, enemy views); a freeze can still
        # re-open the box (queued nodes), so re-dismiss mid-stream
        for i in range(400):
            page.evaluate("window.kirafanRL.step(1/60)")
            if i % 40 == 39:
                dismiss_dialogue()
            page.wait_for_timeout(5)
        page.wait_for_timeout(500)
        settle = time.time() + 60
        while page.evaluate("window.kirafanRL.pending") and time.time() < settle:
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(50)
        # Some opens queue AFTER the settle (the typewriter is a wall-clock
        # presenter; a step-only driver never finishes a line fast enough to
        # satisfy it). Sweep, settle again, sweep — then walk once the box is
        # really gone.
        dismiss_dialogue()
        settle = time.time() + 60
        while page.evaluate("window.kirafanRL.pending") and time.time() < settle:
            page.evaluate("window.kirafanRL.step(1/60)")
            page.wait_for_timeout(50)
        dismiss_dialogue()

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
