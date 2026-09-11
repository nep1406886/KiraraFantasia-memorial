# Structural probe of the roguelike view layer: what clips exist, what plays
# per state, do enemy views have bodies, what does the camera see.
# Usage: python tools/rl_probe.py PORT [volume]
from __future__ import annotations

import json
import sys
import time

from playwright.sync_api import sync_playwright


def boot(page, url):
    page.goto(url, wait_until="load", timeout=60000)
    deadline = time.time() + 120
    while time.time() < deadline:
        if page.evaluate("!!window.kirafanRL && !!window.kirafanRL.mapview.group"):
            return True
        try:
            card = page.query_selector(".roster-card")
            if card:
                card.click()
        except Exception:
            pass
        page.evaluate("window.kirafanRL.step(1/60)")
        page.wait_for_timeout(50)
    return False


def settle(page, frames=300):
    for _ in range(frames):
        # keep the player alive: a death during settle freezes the sm and
        # every later read on this page reports the dead state.
        page.evaluate(
            "(() => { const p = window.kirafanRL.world.player;"
            " if (p && p.maxHp) { p.hp = p.maxHp; } })()")
        page.evaluate("window.kirafanRL.step(1/60)")
        page.wait_for_timeout(4)
    while page.evaluate("window.kirafanRL.pending"):
        page.evaluate("window.kirafanRL.step(1/60)")
        page.wait_for_timeout(50)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8941
    vol = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    url = "http://127.0.0.1:%d/site/game/roguelike.html?volume=%d" % (port, vol)
    result = {"console": [], "errors": []}
    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        page.on("console", lambda m: result["console"].append(m.type + ": " + m.text)
                if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: result["errors"].append(str(e)))
        boot(page, url)
        settle(page, 200)

        out = {}

        # 1. the player's full clip vocabulary
        out["clips"] = page.evaluate(
            "window.kirafanRL.views.player.actor.actionNames")

        # 2. framing: player bbox + projected size (hand-rolled, no THREE global)
        out["framing"] = page.evaluate(
            """(() => {
              const k = window.kirafanRL;
              const cam = k.camera, pv = k.views.player;
              const o = pv.actor.object;
              o.updateMatrixWorld(true);
              let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9,minZ=1e9,maxZ=-1e9;
              o.traverse(c => {
                if (!c.isMesh || !c.geometry) return;
                c.geometry.computeBoundingBox();
                const b = c.geometry.boundingBox;
                for (let i=0;i<8;i++) {
                  const x = i&1 ? b.max.x : b.min.x, y = i&2 ? b.max.y : b.min.y, z = i&4 ? b.max.z : b.min.z;
                  const m = c.matrixWorld.elements;
                  const wx = m[0]*x+m[4]*y+m[8]*z+m[12];
                  const wy = m[1]*x+m[5]*y+m[9]*z+m[13];
                  const wz = m[2]*x+m[6]*y+m[10]*z+m[14];
                  minX=Math.min(minX,wx);maxX=Math.max(maxX,wx);
                  minY=Math.min(minY,wy);maxY=Math.max(maxY,wy);
                  minZ=Math.min(minZ,wz);maxZ=Math.max(maxZ,wz);
                }
              });
              const apply4 = (m, x, y, z) => {
                const w = m[3]*x+m[7]*y+m[11]*z+m[15];
                return [(m[0]*x+m[4]*y+m[8]*z+m[12])/w,
                        (m[1]*x+m[5]*y+m[9]*z+m[13])/w,
                        (m[2]*x+m[6]*y+m[10]*z+m[14])/w];
              };
              const proj = (x,y,z) => {
                const v = apply4(cam.matrixWorldInverse.elements, x, y, z);
                return apply4(cam.projectionMatrix.elements, v[0], v[1], v[2])[1];
              };
              const h = k.renderer.domElement.height;
              const cx = (minX+maxX)/2;
              const topNdc = proj(cx, maxY, minZ), botNdc = proj(cx, minY, minZ);
              return {
                cameraType: cam.isOrthographicCamera ? 'ortho' : 'persp',
                fov: cam.fov, pos: cam.position.toArray().map(v=>+v.toFixed(2)),
                rot: [cam.rotation.x, cam.rotation.y, cam.rotation.z].map(v=>+v.toFixed(3)),
                worldSize: [+(maxX-minX).toFixed(2), +(maxY-minY).toFixed(2), +(maxZ-minZ).toFixed(2)],
                pxHeight: Math.round(Math.abs(botNdc-topNdc)*h/2), canvasH: h,
                playerPos: [o.position.x, o.position.y, o.position.z].map(v=>+v.toFixed(2))
              };
            })()""")

        # 3. state -> clip coverage, in the safe start room. actor.action only
        # tracks actor.play(), so clips are read off the mixer's running
        # actions. 'dead' is terminal AND the walk below needs a live player,
        # so it is deferred to the end; 'hit' is tested from idle here (from
        # dodge it is correctly rejected by the iframe rule).
        out["states"] = page.evaluate(
            """(() => {
              const pv = window.kirafanRL.views.player;
              const u = pv.unit;
              const seen = {};
              // three's AnimationMixer exposes its action list as _actions;
              // actor.action only names clips played through actor.play()
              // and is blind to the anchor supplement (dead & co).
              const active = () => pv.actor.mixer._actions
                .filter(a => a.isRunning()).map(a => a.getClip().name);
              // timed states auto-transition on sm.update, so a fat dt resets
              // dodge/hit back to idle without needing an allowed exit.
              ['idle','move','attack','dodge','hit'].forEach(s => {
                u.sm.update(9);
                u.sm.set('idle');
                pv.sync(1/60);
                u.sm.set(s);
                pv.sync(1/60);
                seen[s] = active();
              });
              return seen;
            })()""")

        # 4. walk into the next room (press toward each wall until roomId
        # changes). The player is teleported to the room centre first: the
        # previous direction leaves them pinned against a wall, and a pinned
        # player moving along that wall never re-enters a door band. Hp is
        # topped up every step: the probe measures views, not survival, and a
        # death mid-walk freezes the player and reads as "no door works".
        def walk_one_room():
            # battle rooms lock the doors until cleared (world.js roomLocked),
            # so before walking, finish any fight: mark everything dead and
            # step until the lock releases.
            page.evaluate(
                """(() => {
                  const k = window.kirafanRL;
                  if (!k.world.roomLocked) { return; }
                  k.world.enemies.forEach(e => { e.dead = true; e.hp = 0; });
                  let n = 0;
                  while (k.world.roomLocked && n < 600) {
                    k.step(1/60);
                    n++;
                  }
                })()""")
            for xdir, ydir in ((0, -1), (0, 1), (-1, 0), (1, 0)):
                page.evaluate(
                    """(() => {
                      const k = window.kirafanRL;
                      const p = k.world.player;
                      p.x = k.world.width / 2;
                      p.y = k.world.height / 2;
                      k.views.player.sync(0);
                      k.renderOnce();
                    })()""")
                res = page.evaluate(
                    """(() => new Promise(resolve => {
                      const x = %d, y = %d;
                      const k = window.kirafanRL;
                      const startRoom = k.world.roomId;
                      k.input.state.move.x = x; k.input.state.move.y = y;
                      let steps = 0;
                      const iv = setInterval(() => {
                        const p = k.world.player;
                        if (p.maxHp) { p.hp = p.maxHp; }
                        k.step(1/60);
                        steps++;
                        if (k.world.roomId !== startRoom || steps > 1800) {
                          clearInterval(iv);
                          k.input.state.move.x = 0; k.input.state.move.y = 0;
                          resolve({ changed: k.world.roomId !== startRoom,
                                    roomType: k.world.room ? k.world.room.type : null,
                                    steps: steps });
                        }
                      }, 3);
                    }))()""" % (xdir, ydir))
                if res.get("changed"):
                    return res
            return None

        room = walk_one_room()
        settle(page, 500)
        out["room"] = room
        out["enemyViews"] = page.evaluate(
            """(() => {
              const k = window.kirafanRL;
              return (k.views.enemies || []).map(v => {
                let meshes = 0, visible = 0, tris = 0;
                v.object.traverse(c => { if (c.isMesh) { meshes++; if (c.visible) visible++; tris += (c.geometry.index ? c.geometry.index.count : c.geometry.attributes.position.count) / 3; } });
                return { model: v.unit.model, state: v.unit.sm.state, clip: v.current,
                         meshes, visible, tris: Math.round(tris),
                         scale: v.object.scale.toArray().map(x=>+x.toFixed(2)),
                         pos: v.object.position.toArray().map(x=>+x.toFixed(2)) };
              });
            })()""")
        out["worldEnemies"] = page.evaluate(
            "window.kirafanRL.world.enemies.map(e => ({model: e.model, dead: !!e.dead, state: e.sm.state}))")

        # 4. enemy projected sizes (are they on screen at a sane size?)
        out["enemyFraming"] = page.evaluate(
            """(() => {
              const k = window.kirafanRL;
              const cam = k.camera;
              const apply4 = (m, x, y, z) => {
                const w = m[3]*x+m[7]*y+m[11]*z+m[15];
                return [(m[0]*x+m[4]*y+m[8]*z+m[12])/w,
                        (m[1]*x+m[5]*y+m[9]*z+m[13])/w,
                        (m[2]*x+m[6]*y+m[10]*z+m[14])/w];
              };
              const projY = (x,y,z) => {
                const v = apply4(cam.matrixWorldInverse.elements, x, y, z);
                return apply4(cam.projectionMatrix.elements, v[0], v[1], v[2])[1];
              };
              const h = k.renderer.domElement.height;
              return (k.views.enemies||[]).map(v => {
                const o = v.object;
                o.updateMatrixWorld(true);
                let maxY=-1e9, minY=1e9, cx=0;
                o.traverse(c => {
                  if (!c.isMesh || !c.geometry) return;
                  c.geometry.computeBoundingBox();
                  const b = c.geometry.boundingBox;
                  const m = c.matrixWorld.elements;
                  for (let i=0;i<8;i++) {
                    const x = i&1 ? b.max.x : b.min.x, y = i&2 ? b.max.y : b.min.y, z = i&4 ? b.max.z : b.min.z;
                    const wy = m[1]*x+m[5]*y+m[9]*z+m[13];
                    maxY = Math.max(maxY, wy); minY = Math.min(minY, wy);
                  }
                });
                cx = o.position.x;
                const cz = o.position.z;
                return { model: v.unit.model,
                         pxHeight: Math.round(Math.abs(projY(cx, maxY, cz) - projY(cx, minY, cz)) * h / 2) };
              });
            })()""")

        # 5. memory across room builds: the snapshot above is after the second
        # build; walk one more room (forcing a third build) and compare.
        out["mem1"] = page.evaluate(
            "({g: window.kirafanRL.renderer.info.memory.geometries, t: window.kirafanRL.renderer.info.memory.textures})")
        room2 = walk_one_room()
        settle(page, 500)
        out["room2"] = room2
        out["mem2"] = page.evaluate(
            "({g: window.kirafanRL.renderer.info.memory.geometries, t: window.kirafanRL.renderer.info.memory.textures})")
        # a third build tells leak from kit variance: a leak grows again by
        # ~the enemy mesh count, a steady state returns to the same plateau.
        room3 = walk_one_room()
        settle(page, 500)
        out["room3"] = room3
        out["mem3"] = page.evaluate(
            "({g: window.kirafanRL.renderer.info.memory.geometries, t: window.kirafanRL.renderer.info.memory.textures})")

        # 7. 'dead' last: terminal, and the walks above need a live player.
        out["deadClip"] = page.evaluate(
            """(() => {
              const pv = window.kirafanRL.views.player;
              const u = pv.unit;
              u.sm.set('dead');
              pv.sync(1/60);
              pv.sync(1/60);
              return pv.actor.mixer._actions
                .filter(a => a.isRunning()).map(a => a.getClip().name);
            })()""")

        print(json.dumps(out, ensure_ascii=True)[:7000])
        print("=== console ===")
        for c in result["console"]:
            print("  " + c[:250])
        for e in result["errors"]:
            print("  PAGEERROR " + e[:250])
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
