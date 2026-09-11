#!/usr/bin/env python3
"""Playwright driver for the T09 view harness (spawned by rl_view_harness.mjs).

Drives site/game/roguelike.html through the window.kirafanRL handle — step() and
renderOnce(), never rAF: the page may be backgrounded, and a hidden pane never
runs animation frames (timers still tick; DOM/JS state is the truth, not
pixels).

Usage:  python tools/rl_view_browser.py http://localhost:PORT/site/game/roguelike.html

Prints one line "RESULT <json>" with every raw measurement; the node harness
owns the pass/fail expectations.
"""

from __future__ import annotations

import json
import sys
import time

from playwright.sync_api import sync_playwright

BOOT_TIMEOUT = 120.0     # kit preload = ~55 files on first volume
STEP_TIMEOUT = 20.0


def wait_for(page, expr, timeout=STEP_TIMEOUT, label="condition"):
    """Poll a JS expression until truthy; kick the game loop while waiting."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if page.evaluate(expr):
            return True
        dismiss_roster(page)
        page.evaluate("window.kirafanRL && window.kirafanRL.step(1/60)")
        page.wait_for_timeout(50)
    raise TimeoutError("timed out waiting for " + label)


def dismiss_roster(page):
    """The roster gate blocks boot until a character is picked; drive it like
    a player would (click the first card) so the room can build. No-op when
    the roster is already gone or never appeared."""
    try:
        card = page.query_selector(".roster-card")
        if card:
            card.click()
    except Exception:
        pass  # overlay mid-teardown: the next poll decides


def main() -> int:
    url = sys.argv[1]
    night_url = sys.argv[2] if len(sys.argv) > 2 else None
    result = {"console": [], "errors": []}

    with sync_playwright() as p:
        browser = p.chromium.launch(
            args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        page = browser.new_page(viewport={"width": 1280, "height": 800})
        # Conservative listener accounting: a room-built node that is removed
        # without explicitly removing its listener leaves active above the
        # long-run baseline. This deliberately catches that worst case.
        page.add_init_script(r"""(() => {
            const add = EventTarget.prototype.addEventListener;
            const remove = EventTarget.prototype.removeEventListener;
            const state = { added: 0, removed: 0, active: 0 };
            EventTarget.prototype.addEventListener = function (...args) {
                state.added += 1; state.active += 1;
                return add.apply(this, args);
            };
            EventTarget.prototype.removeEventListener = function (...args) {
                state.removed += 1; state.active = Math.max(0, state.active - 1);
                return remove.apply(this, args);
            };
            window.__listenerInstrument = state;
        })()""")

        def resource_sample(tag):
            return page.evaluate("""tag => {
                const k = window.kirafanRL, info = k.renderer.info;
                const geometries = new Set(), materials = new Set(), textures = new Set();
                let meshes = 0;
                k.scene.traverse(node => {
                    if (node.isMesh) { meshes += 1; }
                    if (node.geometry) { geometries.add(node.geometry.uuid); }
                    for (const material of [node.material].flat()) {
                        if (!material) { continue; }
                        materials.add(material.uuid);
                        for (const value of Object.values(material)) {
                            if (value && value.isTexture) { textures.add(value.uuid); }
                        }
                    }
                });
                return { tag, meshes, geometries: geometries.size,
                         materials: materials.size, textures: textures.size,
                         rendererGeometries: info.memory.geometries,
                         rendererTextures: info.memory.textures,
                         listeners: { ...window.__listenerInstrument },
                         heap: performance.memory ? performance.memory.usedJSHeapSize : null };
            }""", tag)

        page.on("console", lambda m: result["console"].append(m.type + ": " + m.text)
                if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: result["errors"].append(str(e)))
        def on_request_failed(r):
            text = "REQFAIL " + r.url + " " + str(r.failure)
            # streamed model reads surface as net::ERR_ABORTED without any
            # bytes missing (documented in core/loader.js readModel) — count
            # them separately so real failures stay loud
            if "ERR_ABORTED" in str(r.failure):
                result.setdefault("aborted", []).append(r.url)
            else:
                result["errors"].append(text)
        page.on("requestfailed", on_request_failed)

        t0 = time.time()
        page.goto(url, wait_until="load", timeout=60000)
        wait_for(page, "!!window.kirafanRL", BOOT_TIMEOUT, "kirafanRL handle")
        wait_for(page, "!!window.kirafanRL.mapview.group", BOOT_TIMEOUT, "first room")
        result["bootSeconds"] = round(time.time() - t0, 2)

        # textures arrive async; wait until every kit mesh has its map. The
        # merged contact-shadow mesh (mapview `propshadow`) is deliberately an
        # untextured black disc sheet, so it is excluded here and from the
        # untextured count below — it is not a plain-colour plane standing in
        # for missing art.
        wait_for(page, """(() => {
            const g = window.kirafanRL.mapview.group;
            let meshes = 0;
            g.traverse(c => { if (c.isMesh) meshes++; });
            return meshes > 0 && Array.from(g.children).every(
                c => !c.isMesh || c.name === 'propshadow'
                    || (c.material && c.material.map));
        })()""", BOOT_TIMEOUT, "room textures")

        # --- environment ------------------------------------------------------
        result["env"] = page.evaluate("""(() => {
            const s = window.kirafanRL.scene;
            const env = { fog: null, background: null, lights: [] };
            if (s.fog) {
                env.fog = { color: s.fog.color.getHexString(),
                            near: s.fog.near, far: s.fog.far };
            }
            if (s.background && s.background.getHexString) {
                env.background = s.background.getHexString();
            }
            s.traverse(o => {
                if (o.isDirectionalLight || o.isHemisphereLight) {
                    env.lights.push({
                        kind: o.isDirectionalLight ? 'directional' : 'hemisphere',
                        color: o.color.getHexString(),
                        intensity: o.intensity
                    });
                }
            });
            return env;
        })()""")

        # --- draw calls -------------------------------------------------------
        result["drawCalls"] = page.evaluate(
            "window.kirafanRL.renderOnce(), window.kirafanRL.renderer.info.render.calls")
        result["triangles"] = page.evaluate(
            "window.kirafanRL.renderer.info.render.triangles")

        # --- untextured kit meshes / Y rotations -------------------------------
        result["untextured"] = page.evaluate("""(() => {
            let n = 0;
            window.kirafanRL.mapview.group.traverse(c => {
                if (c.name === 'propshadow') return;
                if (c.isMesh && (!c.material || !c.material.map)) n++;
            });
            return n;
        })()""")
        result["yRotations"] = page.evaluate("""(() => {
            const bad = [];
            const note = (o) => {
                if (Math.abs(o.rotation.y) > 1e-6) bad.push(o.name || o.type);
            };
            // map cards, merged room meshes, and view ROOTS (view roots hold
            // the billboard rule; the player rig's bones are free to rotate)
            window.kirafanRL.mapview.group.traverse(o => {
                // A native prefab's authored internal transforms are evidence,
                // just like actor bones. Only its placement root is billboarded.
                for (let p=o.parent;p;p=p.parent) {
                    if (p.name.startsWith('native-building:')) return;
                }
                note(o);
            });
            window.kirafanRL.scene.children.forEach(note);
            return bad;
        })()""")

        # --- determinism + build time (same room twice) ------------------------
        result["determinism"] = page.evaluate("""(async () => {
            const rl = window.kirafanRL;
            const room = rl.world.room;
            const biome = rl.volumeBiome;      // set by main.js on the handle
            const a = await rl.mapview.buildRoom(room, biome);
            const b = await rl.mapview.buildRoom(room, biome);
            return {
                same: JSON.stringify(a.placements) === JSON.stringify(b.placements),
                placements: a.placements.length,
                buildMs: Math.round(a.buildMs),
                colliders: a.colliders.length,
                roomType: room.type
            };
        })()""")

        # Warm one full cycle first. First visits may compile/decode
        # room-type-specific native kits; spec measures the settled long run,
        # not cold cache cost.
        result["warmRooms"] = page.evaluate("""(async () => {
            const rl = window.kirafanRL;
            const world = rl.world;
            const rooms = world.dungeon.rooms;
            const waitRoom = (id) => new Promise((resolve, reject) => {
                const t0 = performance.now();
                const timer = setInterval(() => {
                    rl.step(1/60);
                    const g = rl.mapview.group;
                    if (g && g.name === 'room:' + id) {
                        clearInterval(timer); resolve(performance.now() - t0);
                    } else if (performance.now() - t0 > 20000) {
                        clearInterval(timer); reject(new Error('warm room ' + id + ' never built'));
                    }
                }, 10);
            });
            const times = [];
            for (const room of rooms) {
                world.enterRoom(room.id, null);
                times.push(await waitRoom(room.id));
            }
            world.enterRoom(rooms[0].id, null);
            await waitRoom(rooms[0].id);
            return times.map(t => Math.round(t));
        })()""")

        # --- 50 room switches: rebuild time + long-run stability -----------------
        result["initial"] = resource_sample("initial")
        result["roomSwitches"] = page.evaluate("""(async () => {
            const rl = window.kirafanRL;
            const world = rl.world;
            const rooms = world.dungeon.rooms;
            const waitRoom = (id) => new Promise((resolve, reject) => {
                const t0 = performance.now();
                const timer = setInterval(() => {
                    rl.step(1/60);
                    const g = rl.mapview.group;
                    if (g && g.name === 'room:' + id) {
                        clearInterval(timer); resolve(performance.now() - t0);
                    } else if (performance.now() - t0 > 15000) {
                        clearInterval(timer); reject(new Error('room ' + id + ' never built'));
                    }
                }, 10);
            });
            const times = [];
            const ids = [];
            for (let i = 0; i < 50; i++) {
                const room = rooms[i % rooms.length];
                ids.push(room.id);
                world.enterRoom(room.id, null);
                times.push(await waitRoom(room.id));
            }
            // back to the start room so later checks have a real room
            world.enterRoom(rooms[0].id, null);
            await waitRoom(rooms[0].id);
            const info = rl.renderer.info;
            return {
                ids: ids,
                maxMs: Math.round(Math.max.apply(null, times)),
                times: times.map(t => Math.round(t)),
                base: null,
                memory: { geometries: info.memory.geometries, textures: info.memory.textures }
            };
        })()""")

        result["after50"] = resource_sample("after50")

        # memory baseline needs a settled state: rebuild the start room again
        # and compare against the value recorded after the LAST switch
        result["memoryStable"] = page.evaluate("""(async () => {
            const rl = window.kirafanRL;
            const world = rl.world;
            const rooms = world.dungeon.rooms;
            const waitRoom = (id) => new Promise((resolve, reject) => {
                const t0 = performance.now();
                const timer = setInterval(() => {
                    rl.step(1/60);
                    const g = rl.mapview.group;
                    if (g && g.name === 'room:' + id) {
                        clearInterval(timer); resolve();
                    } else if (performance.now() - t0 > 15000) {
                        clearInterval(timer); reject(new Error('timeout'));
                    }
                }, 10);
            });
            // two extra full cycles: baseline after cycle A, compare after B
            const cycle = async () => {
                for (const room of rooms) {
                    world.enterRoom(room.id, null);
                    await waitRoom(room.id);
                }
            };
            await cycle();
            const base = { ...rl.renderer.info.memory };
            await cycle();
            const after = { ...rl.renderer.info.memory };
            return { base: base, after: after };
        })()""")

        result["stableBase"] = resource_sample("stableBase")
        result["stableAfter"] = resource_sample("stableAfter")

        # --- boss room: which kits dressed it, arena disc, contact shadows -------
        result["boss"] = page.evaluate("""(async () => {
            const rl = window.kirafanRL;
            const world = rl.world;
            const boss = world.dungeon.rooms.find(r => r.type === 'boss');
            world.enterRoom(boss.id, null);
            await new Promise((resolve, reject) => {
                const t0 = performance.now();
                const timer = setInterval(() => {
                    rl.step(1/60);
                    const g = rl.mapview.group;
                    if (g && g.name === 'room:' + boss.id) { clearInterval(timer); resolve(); }
                    else if (performance.now() - t0 > 15000) {
                        clearInterval(timer); reject(new Error('boss room never built')); }
                }, 10);
            });
            const group = rl.mapview.group;
            const prefixes = group.children
                .filter(c => c.name && c.name.startsWith('kit:'))
                .map(c => c.name.slice(4).split('/')[0]);
            const ground = group.getObjectByName('ground');
            // T21d door strips also live in the ground group — count them
            // apart so the arena check keeps meaning "4 base layers".
            const strips = ground
                ? ground.children.filter(c => c.name && c.name.startsWith('door:')).length
                : 0;
            return { uniqueKits: Array.from(new Set(prefixes)),
                     groundLayers: ground ? ground.children.length - strips : 0,
                     doorStrips: strips,
                     doorCount: world.roomDoors.length,
                     shadows: !!group.getObjectByName('propshadow'),
                     colliders: world.roomColliders.length };
        })()""")

        # --- colliders actually block (in the boss room, whose forced
        #     collidable anchor guarantees at least one AABB is armed) --------
        result["colliderBlock"] = page.evaluate("""(() => {
            const rl = window.kirafanRL;
            const world = rl.world;
            const p = world.player;
            const c = world.roomColliders[0];
            if (!c) { return { has: false }; }
            // stand one unit west of the box, walk east into it for 1.2s.
            // input.state is refreshed by the real input system every frame,
            // so drive the world with a substituted state object instead.
            const real = world.inputState;
            world.inputState = { move: { x: 1, y: 0 }, attack: false, dodge: false };
            p.x = c.x - c.hw - 1.0; p.y = c.y;
            for (let i = 0; i < 72; i++) { world.update(1 / 60); }
            world.inputState = real;
            const overlap = Math.abs(p.x - c.x) < c.hw + p.radius - 0.02
                && Math.abs(p.y - c.y) < c.hh + p.radius - 0.02;
            return { has: true, blocked: !overlap, px: +p.x.toFixed(2), cx: c.x, hw: c.hw };
        })()""")

        # --- T21e-3 streak layer: aimed/volley route to the InstancedMesh,
        #     every other shape stays in the round Points, and the streak's
        #     quad is placed so its bright core lands on the bullet. --------
        result["streaks"] = page.evaluate("""(() => {
            const rl = window.kirafanRL;
            const world = rl.world;
            const view = rl.views.danmaku;
            const out = {};
            // freeze the world so a live boss/room enemy cannot fire into the
            // measured counts; views still sync from rl.step/renderOnce.
            world.frozen = true;
            const fire = (pattern, mods) => {
                world.danmaku.clear();
                rl.step(1 / 60);
                world.danmaku.emit(pattern, { x: 5, y: 5, angle: 0 },
                    Object.assign({ side: "enemy", speed: 6 }, mods));
                rl.step(1 / 60);
                rl.renderOnce();
            };
            fire("aimed", { count: 1 });
            out.aimed = { streak: view.streakCount, points: view.count };
            const mesh = rl.scene.getObjectByName("danmaku-streaks");
            out.hasMesh = !!mesh;
            if (mesh && mesh.count > 0) {
                const e = mesh.instanceMatrix.array;
                out.inst = {
                    px: e[12], py: e[13], pz: e[14],
                    sx: Math.hypot(e[0], e[1], e[2]),
                    sy: Math.hypot(e[4], e[5], e[6])
                };
                let b0 = null;
                world.danmaku.forEach(function (b) {
                    if (!b0 && b.delay <= 0) { b0 = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: b.radius }; }
                });
                out.bullet = b0;
            }
            fire("volley", { count: 3, stepDelay: 0 });
            out.volley = { streak: view.streakCount, points: view.count };
            fire("ring", { count: 12 });
            out.ring = { streak: view.streakCount, points: view.count };
            fire("wall", { count: 7, speed: 2.6 });
            out.wall = { streak: view.streakCount, points: view.count };
            world.danmaku.clear();
            rl.step(1 / 60);
            rl.renderOnce();
            out.cleared = { streak: view.streakCount, points: view.count };
            world.frozen = false;
            return out;
        })()""")

        if night_url:
            page2 = browser.new_page(viewport={"width": 1280, "height": 800})
            page2.on("pageerror", lambda e: result["errors"].append("night: " + str(e)))
            page2.goto(night_url, wait_until="load", timeout=60000)
            wait_for(page2,
                     "!!(window.kirafanRL && window.kirafanRL.mapview && window.kirafanRL.mapview.group)",
                     BOOT_TIMEOUT, "night room")
            result["night"] = page2.evaluate("""(() => {
                const s = window.kirafanRL.scene;
                const env = { fog: null, lights: [] };
                if (s.fog) {
                    env.fog = s.fog.color.getHexString();
                }
                s.traverse(o => {
                    if (o.isDirectionalLight || o.isHemisphereLight) {
                        env.lights.push({
                            kind: o.isDirectionalLight ? 'directional' : 'hemisphere',
                            color: o.color.getHexString(),
                            intensity: o.intensity
                        });
                    }
                });
                return env;
            })()""")
            page2.close()

        browser.close()

    print("RESULT " + json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
