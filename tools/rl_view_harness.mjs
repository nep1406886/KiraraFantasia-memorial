// T09 view gate (spec/06): drives site/game/roguelike.html in headless Chromium
// and checks the room-assembly contract.
//
//   房间 draw call <120
//   雾/暖光参数断言 (spec/01 §5: key #fff4e0 1.0, sky ambient, per-volume
//                    fog tint; night volume swaps key to #c9d4f0, -20% ambient)
//   换层 <1.5s (buildRoom itself; kits are preloaded per volume)
//   renderer.info / scene model / listener 连换 50 次不单调增长
//   plus: untextured kit meshes = 0, no Y rotations (paper cards), same seed
//   → same placements, prop colliders block movement, the boss room is an
//   arena dressed from the volume's own two kits, and floors.json's authoring
//   (kits, colours, prefer/exclude patterns, anchors) resolves against
//   mapkit.json.
//
// The gate owns its server (free port, no-store static serving with the
// correct MIME for .gz — the loader inflates .glb.gz itself) and runs the
// python playwright driver one at a time.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- static server (no-store; .gz must arrive opaque, like tools/serve.py) ---

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".webp": "image/webp",
    ".png": "image/png",
    ".gz": "application/octet-stream",
    ".glb": "model/gltf-binary",
    ".wasm": "application/wasm"
};

function startServer() {
    const server = createServer(async function (req, res) {
        try {
            const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
            let file = path.join(ROOT, urlPath);
            if (!path.resolve(file).startsWith(ROOT)) {
                res.writeHead(403).end();
                return;
            }
            let body = await readFile(file).catch(function () { return null; });
            if (body === null) {
                res.writeHead(404).end("not found: " + urlPath);
                return;
            }
            res.writeHead(200, {
                "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
                "Content-Length": body.length,
                "Cache-Control": "no-store, must-revalidate"
            });
            res.end(body);
        } catch (error) {
            res.writeHead(500).end(String(error));
        }
    });
    return new Promise(function (resolve) {
        server.listen(0, "127.0.0.1", function () {
            resolve({ server: server, port: server.address().port });
        });
    });
}

// --- harness -------------------------------------------------------------------

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
    if (ok) {
        passed++;
        console.log("  ok  " + name);
    } else {
        failed++;
        console.log("  ×   " + name + (detail !== undefined ? "  — " + detail : ""));
    }
}

function runDriver(port) {
    return new Promise(function (resolve, reject) {
        const day = "http://127.0.0.1:" + port + "/site/game/roguelike.html?volume=1";
        const night = "http://127.0.0.1:" + port + "/site/game/roguelike.html?volume=5";
        const child = spawn("python", [
            path.join(ROOT, "tools", "rl_view_browser.py"), day, night
        ], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", function (chunk) { out += chunk; });
        child.on("error", reject);
        child.on("close", function (code) {
            const line = out.split("\n").find(function (l) {
                return l.startsWith("RESULT ");
            });
            if (!line) {
                reject(new Error("driver exited " + code + " without a RESULT line:\n" + out));
                return;
            }
            resolve(JSON.parse(line.slice(7)));
        });
    });
}

const light = function (env, kind) {
    return (env.lights || []).find(function (l) { return l.kind === kind; });
};

const { server, port } = await startServer();
console.log("view gate: serving on 127.0.0.1:" + port);

// --- static consistency: floors.json vs mapkit.json --------------------------
// The table is hand-authored against 64 kits whose units are named by hand, so
// what this catches is authoring drift: a volume pointing at a kit that does not
// exist, a prefer/exclude pattern that matches nothing (a typo, or a kit that
// was rebuilt under different names), or a room anchor no volume can satisfy.
// The original version of this block also demanded a `floor`-category unit per
// biome; the ground is synthesized now (no kit ships a tileable tile), so that
// requirement is gone.
{
    const { readFile } = await import("node:fs/promises");
    const floors = JSON.parse(await readFile(path.join(ROOT, "site/asset/rl/floors.json"), "utf8"));
    const kit = JSON.parse(await readFile(path.join(ROOT, "site/asset/rl/mapkit.json"), "utf8"));
    const WHITE = /_eff_white/i;
    // mirrors mapview.js matchesAny: "=name" is whole-name, the rest substring
    const hits = (name, patterns) => patterns.some(function (p) {
        return p.charAt(0) === "="
            ? name.toLowerCase() === p.slice(1)
            : name.toLowerCase().indexOf(p) !== -1;
    });
    const PROP = ["prop", "wall", "animated"];
    const biomes = new Set(kit.entries.map(function (e) { return e.biome; }));

    // Mirrors mapview.js volumeConfig(volume, floor): segment i of 4 × 5
    // floors, sparse-merged over the volume base. The base IS segment 0.
    const segmentConfigs = function (cfg) {
        const segs = (cfg.segments && cfg.segments.length) ? cfg.segments : [{}];
        return segs.map(function (seg) {
            const merged = Object.assign({}, cfg, seg || {});
            delete merged.segments;
            return merged;
        });
    };

    // One effective config (base or merged segment) through the same authoring
    // checks: kits exist, ground/fog are hex, ≥6 usable props, a silhouette,
    // every pattern bites, every room anchor resolves.
    const validateCfg = function (tag, cfg) {
        check(tag + "authors biome + extra + ground",
            biomes.has(cfg.biome) && biomes.has(cfg.extra) && cfg.extra !== cfg.biome
            && /^#[0-9a-f]{6}$/i.test((cfg.ground || {}).base || "")
            && /^#[0-9a-f]{6}$/i.test((cfg.ground || {}).mottle || "")
            && /^#[0-9a-f]{6}$/i.test(cfg.fog || ""),
            JSON.stringify({ biome: cfg.biome, extra: cfg.extra, ground: cfg.ground }));
        check(tag + "names a segment (HUD reads it)",
            typeof cfg.name === "string" && cfg.name.length > 0, String(cfg.name));

        const excludes = (floors.excludes || []).concat(cfg.exclude || []);
        const units = kit.entries.filter(function (e) {
            return e.biome === cfg.biome || e.biome === cfg.extra;
        });
        const usable = units.filter(function (e) {
            return !hits(e.name, excludes) && !WHITE.test(e.texture || "");
        });
        // A ring of 42 drawn from fewer than 6 kinds reads as wallpaper.
        check(tag + "≥6 usable props across both kits",
            usable.filter(function (e) { return PROP.indexOf(e.category) !== -1; }).length >= 6,
            usable.length + " usable of " + units.length);
        // Something has to stand as tall as a character (~1.6 units) or the
        // room has no silhouette at all.
        check(tag + "has a prop ≥1.0 units tall",
            usable.some(function (e) {
                return PROP.indexOf(e.category) !== -1 && e.footprint[1] >= 1.0;
            }));
        // Every authored pattern must bite: an unmatched prefer is a typo that
        // silently degrades to "whatever sorts first".
        [["prefer.border", (cfg.prefer || {}).border || []],
            ["prefer.focal", (cfg.prefer || {}).focal || []],
            ["prefer.scatter", (cfg.prefer || {}).scatter || []],
            ["exclude", cfg.exclude || []]].forEach(function (group) {
            const dead = group[1].filter(function (p) {
                return !units.some(function (e) { return hits(e.name, [p]); });
            });
            check(tag + group[0] + " patterns all match a unit", dead.length === 0,
                JSON.stringify(dead));
        });
        // Anchors are room-level but resolved per volume: a shop with no
        // anchor is a shop that looks like a battle room.
        Object.entries(floors.rooms).forEach(function (roomPair) {
            if (!roomPair[1].anchor) { return; }
            check(tag + roomPair[0] + " anchor resolves",
                usable.some(function (e) {
                    return ["prop", "wall", "animated", "water"].indexOf(e.category) !== -1
                        && hits(e.name, roomPair[1].anchor);
                }));
        });
    };

    Object.entries(floors.volumes).forEach(function (pair) {
        const vol = pair[0];
        const cfg = pair[1];
        const segs = segmentConfigs(cfg);
        segs.forEach(function (merged, i) {
            validateCfg("vol " + vol + " seg" + i + " ", merged);
        });
        // The descent table is 4 segments × 5 floors = 20 layers (spec/02 §3);
        // segment 0 is the base itself and stays `{}`.
        check("vol " + vol + " authors 4 segments",
            (cfg.segments || []).length === 4 && Object.keys(cfg.segments[0]).length === 0,
            JSON.stringify((cfg.segments || []).length));
    });

    // Global fragment names are shared across volumes, so they only have to
    // bite somewhere in the library — one that bites nowhere is dead weight.
    const deadGlobal = (floors.excludes || []).filter(function (p) {
        return !kit.entries.some(function (e) { return hits(e.name, [p]); });
    });
    check("global excludes all match some unit", deadGlobal.length === 0,
        JSON.stringify(deadGlobal));
}

let result = null;
try {
    result = await runDriver(port);
} catch (error) {
    console.error(String(error.message || error));
    process.exitCode = 1;
    server.close();
    process.exit(process.exitCode);
}
server.close();

console.log("boot " + result.bootSeconds + "s, draw calls "
    + result.drawCalls + ", triangles " + result.triangles
    + ", placements " + result.determinism.placements
    + ", colliders " + result.determinism.colliders);

// 1. draw call budget (spec/02 §3 rule 3)
check("room draw calls < 120", result.drawCalls < 120, "calls=" + result.drawCalls);

// 2. fog / warm light tokens (spec/01 §5) — day volume
const key = light(result.env, "directional");
const hemi = light(result.env, "hemisphere");
check("day fog color = volume tint #c9e6e4",
    result.env.fog && result.env.fog.color === "c9e6e4",
    JSON.stringify(result.env.fog));
check("fog near/far = 13/27",
    result.env.fog && result.env.fog.near === 13 && result.env.fog.far === 27,
    JSON.stringify(result.env.fog));
check("background = fog color (edge melts into tint)",
    result.env.background === "c9e6e4", "bg=" + result.env.background);
check("key light #fff4e0 @ 1.0",
    key && key.color === "fff4e0" && Math.abs(key.intensity - 1.0) < 1e-6,
    JSON.stringify(key));
check("hemisphere ambient present (sky color)",
    hemi && hemi.intensity > 1.5, JSON.stringify(hemi));

// 3. night volume (spec/01 §5: 主光换月色, 环境光只降 20%)
const nKey = light(result.night, "directional");
const nHemi = light(result.night, "hemisphere");
check("night key light #c9d4f0", nKey && nKey.color === "c9d4f0",
    JSON.stringify(nKey));
check("night ambient only -20%",
    nHemi && Math.abs(nHemi.intensity - 2.1 * 0.8) < 0.02,
    "intensity=" + (nHemi && nHemi.intensity));
check("night fog = volume 5 tint #8a8aa8",
    result.night && result.night.fog === "8a8aa8", JSON.stringify(result.night && result.night.fog));

// 4. every kit mesh textured (spec/02 §4: 无纯色 plane)
check("no untextured kit meshes", result.untextured === 0, "n=" + result.untextured);

// 5. no Y rotation anywhere (paper cards, spec/01 §5 rule 1)
check("no Y rotations in scene", result.yRotations.length === 0,
    JSON.stringify(result.yRotations.slice(0, 5)));

// 6. determinism (same seed → same layout)
check("same room rebuilds identically", result.determinism.same === true);
check("room has placements", result.determinism.placements > 0,
    "n=" + result.determinism.placements);

// 7. 换层 build time (<1.5s bar; buildRoom after preload)
check("buildRoom < 1500ms", result.determinism.buildMs < 1500,
    result.determinism.buildMs + "ms");
check("50 room switches all < 1500ms",
    result.roomSwitches.maxMs < 1500,
    result.roomSwitches.maxMs + "ms rooms=" + JSON.stringify(result.roomSwitches.times));

// 8. memory stability across switches (renderer.info 不涨)
const memBase = result.memoryStable.base;
const memAfter = result.memoryStable.after;
check("geometry count stable across room cycles",
    memAfter.geometries <= memBase.geometries,
    memBase.geometries + " → " + memAfter.geometries);
check("texture count stable across room cycles",
    memAfter.textures === memBase.textures,
    memBase.textures + " → " + memAfter.textures);

// 8b. spec/08 long-room budget: 50 real room switches settle, then two whole
//     room cycles must return model/material/listener registrations to the
//     same plateau. Heap is sampled as evidence; the pass condition is the
//     managed scene and listener counts, because managed heap can dip for GC.
const initial = result.initial, after50 = result.after50;
const stableBase = result.stableBase, stableAfter = result.stableAfter;
check("50 switches do not grow scene models or materials",
    after50.meshes <= initial.meshes
        && after50.geometries <= initial.geometries
        && after50.materials <= initial.materials,
    JSON.stringify({ initial, after50 }));
check("50 switches return textures and renderer resources to baseline",
    after50.textures === initial.textures
        && after50.rendererGeometries <= initial.rendererGeometries
        && after50.rendererTextures === initial.rendererTextures,
    JSON.stringify({ initial, after50 }));
check("listeners do not leak across 50 switches",
    after50.listeners.active <= initial.listeners.active
        && after50.listeners.added - after50.listeners.removed
            === after50.listeners.active,
    JSON.stringify({ initial: initial.listeners, after50: after50.listeners }));
check("two settled cycles do not grow models, materials or listeners",
    stableAfter.meshes <= stableBase.meshes
        && stableAfter.geometries <= stableBase.geometries
        && stableAfter.materials <= stableBase.materials
        && stableAfter.listeners.active <= stableBase.listeners.active,
    JSON.stringify({ stableBase, stableAfter }));
check("two settled cycles keep renderer resources stable",
    stableAfter.rendererGeometries <= stableBase.rendererGeometries
        && stableAfter.rendererTextures === stableBase.rendererTextures,
    JSON.stringify({ stableBase, stableAfter }));

// 9. prop colliders block movement (mapview AABBs → world clamp), checked in
//    the boss room whose forced-collidable anchor guarantees an armed AABB
check("boss room armed a prop collider",
    result.colliderBlock.has === true);
check("player cannot walk into a prop AABB",
    result.colliderBlock.blocked === true,
    JSON.stringify(result.colliderBlock));

// 10. the boss room is dressed from the volume's own kits (there is no
//     separate boss kit any more: the 1015_* battle stages ship no props, only
//     a 3/4-perspective dais), and it is an `arena` room — 4 ground layers
//     (surround, room rect, rim, disc) against 2 for every other type — with
//     contact shadows under its ring. T22c widened the pair to a trio
//     (extra2).
const VOL1_KITS = ["1018_0", "1018_8", "1018_7"];
check("boss room dressed from the volume's kits",
    result.boss && result.boss.uniqueKits.length > 0
    && result.boss.uniqueKits.every(function (k) { return VOL1_KITS.indexOf(k) !== -1; }),
    JSON.stringify(result.boss && result.boss.uniqueKits));
check("boss room has the arena disc + rim",
    result.boss && result.boss.groundLayers === 4,
    "layers=" + (result.boss && result.boss.groundLayers));
// T21d: every door of the room got its lit strip in the ground group.
check("boss room door strips match its doors",
    result.boss && result.boss.doorStrips === result.boss.doorCount
        && result.boss.doorCount > 0,
    "strips=" + (result.boss && result.boss.doorStrips)
        + " doors=" + (result.boss && result.boss.doorCount));
check("boss room props cast contact shadows",
    result.boss && result.boss.shadows === true);

// 10b. Round and streak billboards both centre their circular core on the
//      bullet. The 2:1 streak texture uses a 4r by 2r quad, keeping the core
//      circular while its decorative tail remains behind the hitbox.
const st = result.streaks;
check("streak layer exists in the scene", st && st.hasMesh === true);
check("aimed routes to the streak layer", st && st.aimed.streak === 1 && st.aimed.points === 0,
    JSON.stringify(st && st.aimed));
check("volley routes to the streak layer", st && st.volley.streak === 3 && st.volley.points === 0,
    JSON.stringify(st && st.volley));
check("ring stays in the round batch", st && st.ring.streak === 0 && st.ring.points === 12,
    JSON.stringify(st && st.ring));
check("wall stays in the round batch", st && st.wall.streak === 0 && st.wall.points === 7,
    JSON.stringify(st && st.wall));
check("a cleared pool empties both layers", st && st.cleared.streak === 0 && st.cleared.points === 0,
    JSON.stringify(st && st.cleared));
(function () {
    if (!st || !st.inst || !st.bullet) {
        check("streak instance measured against its bullet", false);
        return;
    }
    const inst = st.inst, b = st.bullet;
    check("streak core centred on the actual bullet at torso height",
        Math.abs(inst.px - b.x) < 1e-6
            && Math.abs(inst.py - 1.0) < 1e-6 && Math.abs(inst.pz - b.y) < 1e-6,
        "inst=" + [inst.px.toFixed(3), inst.py.toFixed(3), inst.pz.toFixed(3)].join(",")
            + " bullet=" + [b.x.toFixed(3), b.y.toFixed(3)].join(","));
    check("streak core diameter is twice the actual radius on both axes",
        Math.abs(inst.sx - 4 * b.r) < 1e-6 && Math.abs(inst.sy - 2 * b.r) < 1e-6,
        "sx=" + inst.sx.toFixed(3) + " sy=" + inst.sy.toFixed(3) + " r=" + b.r);
})();

// 11. clean console. net::ERR_ABORTED on streamed model reads is a
//     documented accounting artefact of core/loader.js readModel (the driver
//     counts them under `aborted`, not errors).
check("no page errors / failed requests", result.errors.length === 0,
    JSON.stringify((result.errors || []).slice(0, 3)));
const consoleErrors = (result.console || []).filter(function (c) {
    return c.startsWith("error");
});
check("no console errors", consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 3)));

console.log("\nrl_view_harness: " + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
