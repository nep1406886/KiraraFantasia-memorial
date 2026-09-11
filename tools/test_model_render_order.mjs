// No package.json/type flag required: the browser module has no imports.
// Run: node --test tools/test_model_render_order.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const source = readFileSync(new URL("../site/core/model-render-order.js", import.meta.url));
const { alphaQueue, compareModelRenderItems: compare, installModelRenderOrder: install } =
    await import("data:text/javascript;base64," + source.toString("base64"));
const layerSource = readFileSync(new URL("../site/game/rl/view/layers.js", import.meta.url));
const { applyLayer, LAYER } = await import("data:text/javascript;base64," + layerSource.toString("base64"));

function item(order, z, id = 1, material = id, group = 0) {
    return { renderOrder: order, z, id, material: { id: material }, groupOrder: group, object: {} };
}
const face = () => item(22004075, -0.958, 1, 10);
const neck = () => item(22004174, -0.956, 2, 20);

test("published face/chest_line share queue 2755; hierarchy is not a queue", () => {
    assert.equal(alphaQueue(face().renderOrder), 2755);
    assert.equal(alphaQueue(neck().renderOrder), 2755);
});
test("alpha stages and Unity's 2500 boundary are decoded conservatively", () => {
    assert.equal(alphaQueue(20000001), null);
    assert.equal(alphaQueue(20001001), 2501);
    assert.equal(alphaQueue(21000001), 2625);
    assert.equal(alphaQueue(22124001), 2875);
    for (const n of [0, 7000175, 11000001, 19999000, 25000001, 22125001,
        -1, NaN, Infinity, 22004075.5, "22004075", undefined]) {
        assert.equal(alphaQueue(n), null, String(n));
    }
});
test("far neck draws before near face despite hierarchy and material IDs", () => {
    assert.ok(compare(neck(), face()) < 0);
    assert.ok(compare(face(), neck()) > 0);
});
test("current posed depth overrides Three's cached render-item depth", () => {
    const a = neck(), b = face();
    const depths = new Map([[a.object, -0.960], [b.object, -0.955]]);
    assert.ok(compare(a, b, depths) > 0);
});
test("cross-queue, opaque, legacy and group ordering stay unchanged", () => {
    assert.ok(compare(item(22003099, -0.999), item(22004001, -0.1)) < 0);
    assert.ok(compare(item(7000100, -0.999), item(7000200, -0.1)) < 0);
    assert.ok(compare(item(100, -0.999), item(200, -0.1)) < 0);
    assert.ok(compare(item(22004174, -0.1, 1, 1, 1), item(22004075, -0.9, 2, 2, 2)) < 0);
});
test("equal depth keeps deterministic hierarchy; exact-key fallbacks match Three", () => {
    assert.ok(compare(item(22004075, 0), item(22004174, 0)) < 0);
    assert.ok(compare(item(22004075, 0, 2, 1), item(22004075, 0, 1, 2)) < 0);
    assert.ok(compare(item(1, 0, 1, 1), item(1, 1, 2, 1)) < 0);
    assert.ok(compare(item(1, 0, 1, 1), item(1, 0, 2, 1)) < 0);
});
test("mixed queues form a transitive, antisymmetric order", () => {
    const items = [0, 7, 20, 21, 22, 23, 24, 25].flatMap(stage =>
        [0, 1, 4, 124].flatMap(layer => [1, 75, 174].map((h, i) =>
            item(stage * 1000000 + layer * 1000 + h, -0.9 + i * 0.01, h))));
    const sorted = items.slice().sort(compare);
    for (let a = 0; a < sorted.length; a++) {
        assert.equal(compare(sorted[a], sorted[a]), 0);
        for (let b = a + 1; b < sorted.length; b++) {
            assert.ok(compare(sorted[a], sorted[b]) <= 0);
            assert.equal(Math.sign(compare(sorted[a], sorted[b])), -Math.sign(compare(sorted[b], sorted[a])));
        }
    }
});

// Small scene doubles keep these lifecycle tests independent of WebGL. Actual
// skinned geometry and camera projection are covered by check_model_order.py.
class Vector3 {
    applyMatrix4(matrix) { this.z += matrix.z; return this; }
    project(camera) { this.z = (this.z - camera.z) * camera.direction; return this; }
}
function box(z, empty = false) {
    return { isEmpty: () => empty, getCenter: out => { out.z = z; return out; } };
}
function mesh(order, z, options = {}) {
    const m = {
        isMesh: true, isSkinnedMesh: true, visible: true, layers: 1,
        renderOrder: order, userData: {}, poseZ: z, computations: 0, matrixWorld: { z: 0 },
        material: { visible: true, transparent: false, depthWrite: false },
        geometry: { boundingBox: null, computations: 0,
            computeBoundingBox() { this.computations++; this.boundingBox = box(z); } },
        computeBoundingBox() { this.computations++; this.boundingBox = box(this.poseZ); },
        ...options
    };
    return m;
}
function fixture(meshes, options) {
    const f = { originalCalls: 0, compare: null };
    f.previous = function () { f.originalCalls++; assert.equal(this, f.scene); };
    f.scene = {
        onBeforeRender: f.previous,
        traverseVisible(fn) { meshes.filter(m => m.visible).forEach(fn); }
    };
    f.renderer = { setOpaqueSort(fn) { f.compare = fn; } };
    f.camera = { z: 0, direction: 1, layers: { test: layer => layer === 1 } };
    f.dispose = install(f.renderer, f.scene, { Vector3 }, options);
    f.render = () => f.scene.onBeforeRender(f.renderer, f.scene, f.camera);
    f.item = m => ({ ...item(m.renderOrder, 100, meshes.indexOf(m)), object: m });
    return f;
}
test("animation, world transforms and camera changes refresh sort depths", () => {
    const a = mesh(22004075, -0.958), b = mesh(22004174, -0.956);
    const f = fixture([a, b]);
    f.render();
    assert.ok(f.compare(f.item(b), f.item(a)) < 0);
    a.poseZ = -0.954;
    f.render();
    assert.ok(f.compare(f.item(a), f.item(b)) < 0);
    a.matrixWorld.z = -0.01;
    f.render();
    assert.ok(f.compare(f.item(b), f.item(a)) < 0);
    f.camera.direction = -1;
    f.render();
    assert.ok(f.compare(f.item(a), f.item(b)) < 0);
    assert.equal(a.computations, 4);
    assert.equal(f.originalCalls, 4);
    f.dispose();
});
test("only visible, camera-visible, opaque-list peers are rescanned", () => {
    const a = mesh(22004075, 0), b = mesh(22004174, 1);
    const ignored = [mesh(22004076, 0, { visible: false }),
        mesh(22004077, 0, { layers: 2 }), mesh(22005001, 0), mesh(7000001, 0),
        mesh(22004078, 0, { material: { visible: false, transparent: false } }),
        mesh(22004079, 0, { material: { visible: true, transparent: true } })];
    const f = fixture([a, b, ...ignored]);
    f.render();
    assert.equal(a.computations, 1);
    assert.equal(b.computations, 1);
    ignored.forEach(m => assert.equal(m.computations, 0));
    b.visible = false;
    f.render();
    assert.equal(a.computations, 1, "a singleton must not be recomputed");
    f.dispose();
});
test("static bounds are cached; material arrays and depth state are untouched", () => {
    const a = mesh(22004075, -1, { isSkinnedMesh: false });
    a.material = [a.material];
    const before = JSON.stringify(a.material);
    const b = mesh(22004174, 1);
    const f = fixture([a, b]);
    f.render(); f.render();
    assert.equal(a.geometry.computations, 1);
    assert.equal(JSON.stringify(a.material), before);
    f.dispose();
});
test("new/removed models cannot reuse another frame's depth map", () => {
    const a = mesh(22004075, 1), b = mesh(22004174, 0);
    const meshes = [a, b], f = fixture(meshes);
    f.render();
    assert.ok(f.compare(f.item(a), f.item(b)) < 0);
    meshes.pop();
    a.poseZ = -1;
    f.render();
    const c = mesh(22004174, 2);
    meshes.push(c);
    f.render();
    assert.ok(f.compare(f.item(c), f.item(a)) < 0);
    f.dispose();
});
test("dispose restores scene hook and default sorting without clearing a newer hook", () => {
    const f = fixture([]);
    f.dispose();
    assert.equal(f.scene.onBeforeRender, f.previous);
    assert.equal(f.compare, null);
    f.dispose();
    const g = fixture([]), newer = () => {};
    g.scene.onBeforeRender = newer;
    g.dispose();
    assert.equal(g.scene.onBeforeRender, newer);
});

const gameOptions = { getAuthoredOrder: m => m.userData.rlAuthoredOrder };
function layered(meshes, base, noDepth = false) {
    applyLayer({ traverse: fn => meshes.forEach(fn) }, base, noDepth);
    return meshes;
}
test("game's saved authored order fixes player and enemy bands without accumulating offsets", () => {
    for (const base of [LAYER.enemy, LAYER.player]) {
        const meshes = [mesh(22004075, -0.958), mesh(22004174, -0.956)];
        layered(meshes, base, base === LAYER.player);
        layered(meshes, base, base === LAYER.player);
        assert.equal(meshes[0].renderOrder, 22004075 + base);
        assert.equal(meshes[0].userData.rlAuthoredOrder, 22004075);
        if (base === LAYER.player) assert.equal(alphaQueue(meshes[0].renderOrder), null);
        const before = JSON.stringify(meshes.map(m => [m.renderOrder, m.material, m.userData]));
        const f = fixture(meshes, gameOptions);
        f.render();
        assert.ok(f.compare(f.item(meshes[1]), f.item(meshes[0])) < 0);
        assert.equal(JSON.stringify(meshes.map(m => [m.renderOrder, m.material, m.userData])), before);
        f.dispose();
    }
});
test("multiple actors retain effective role, cross-queue, prop and weapon order", () => {
    const enemies = layered([mesh(22004075, -0.96), mesh(22004174, -0.95),
        mesh(22004075, -0.93), mesh(22004174, -0.92)], LAYER.enemy);
    const players = layered([mesh(22004075, -0.99), mesh(22004174, -0.98),
        mesh(22005001, -0.9), mesh(7000123, -0.8)], LAYER.player, true);
    const prop = mesh(0, -0.8, { isSkinnedMesh: false });
    const bullet = mesh(LAYER.danmaku, -0.7, { material: { visible: true, transparent: true } });
    const meshes = [prop, bullet, ...enemies, ...players], f = fixture(meshes, gameOptions);
    f.render();
    const sorted = meshes.map(f.item).sort(f.compare);
    for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
        assert.ok(f.compare(sorted[i], sorted[j]) <= 0, "transitive for every pair");
        assert.equal(Math.sign(f.compare(sorted[i], sorted[j])), -Math.sign(f.compare(sorted[j], sorted[i])));
        if (Math.floor(sorted[i].renderOrder / 1000) !== Math.floor(sorted[j].renderOrder / 1000)) {
            assert.ok(sorted[i].renderOrder < sorted[j].renderOrder, "effective ladder unchanged");
        }
    }
    assert.equal(prop.computations, 0);
    assert.equal(bullet.computations, 0);
    assert.equal(players[2].computations, 0);
    assert.equal(players[3].computations, 0);
    f.dispose();
});
test("conflicting role offsets in one effective interval conservatively keep the entire ladder", () => {
    const players = layered([mesh(22004075, -0.99), mesh(22004174, -0.9)], LAYER.player);
    const enemies = layered([mesh(22104120, -0.94)], LAYER.enemy);
    const meshes = [...players, ...enemies], f = fixture(meshes, gameOptions);
    f.render();
    const sorted = meshes.map(f.item).sort(f.compare);
    assert.deepEqual(sorted.map(n => n.renderOrder), [22204075, 22204120, 22204174]);
    meshes.forEach(m => assert.equal(m.computations, 0));
    f.dispose();
});
test("unsupported interleaved meshes disable only their ambiguous interval", () => {
    for (const badOrder of [22204120, 22204120.25]) {
        const meshes = layered([mesh(22004075, -0.99), mesh(22004174, -0.9),
            mesh(22005075, -0.99), mesh(22005174, -0.9)], LAYER.player);
        meshes.push(mesh(badOrder, -0.94));
        const f = fixture(meshes, gameOptions);
        f.render();
        assert.ok(f.compare(f.item(meshes[0]), f.item(meshes[1])) < 0);
        assert.ok(f.compare(f.item(meshes[2]), f.item(meshes[3])) > 0);
        assert.equal(meshes[0].computations, 0);
        assert.equal(meshes[2].computations, 1);
        f.dispose();
    }
});
test("the scene restores default sorting after rendering and preserves the existing after hook", () => {
    const f = fixture([mesh(22004075, -0.99), mesh(22004174, -0.9)]);
    f.render();
    assert.equal(typeof f.compare, "function");
    f.scene.onAfterRender(f.renderer, f.scene, f.camera);
    assert.equal(f.compare, null, "a cinematic/overlay must not inherit a stale depth map");
    f.render();
    assert.equal(typeof f.compare, "function");
    f.dispose();
    let calls = 0;
    const after = function () { calls++; assert.equal(this, f.scene); };
    f.scene.onAfterRender = after;
    const dispose = install(f.renderer, f.scene, { Vector3 });
    f.scene.onAfterRender(f.renderer, f.scene, f.camera);
    assert.equal(calls, 1);
    dispose();
    assert.equal(f.scene.onAfterRender, after);
});
