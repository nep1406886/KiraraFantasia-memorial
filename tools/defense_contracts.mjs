// Asset/identity and isolated locomotion contracts. Browser playback is checked
// separately through the real page; these checks do not claim visual success.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../site/vendor/three/three.module.min.js";
import { createEnemyMotion } from "../site/etowaria-defense/render/enemy-motion.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const APP = path.join(SITE, "etowaria-defense");
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const catalogue = await read(path.join(APP, "data/units.json"));
const models = await read(path.join(APP, "data/models.json"));
const native = await read(path.join(APP, "data/native.json"));
const playback = await read(path.join(APP, "data/playback.json"));
const results = [];
function check(name, fn) {
    fn();
    results.push({ name, passed: true });
}

check("24 unique exact card identities", () => {
    assert.equal(catalogue.units.length, 24);
    assert.equal(new Set(catalogue.units.map(unit => unit.cardId)).size, 24);
    assert.equal(new Set(catalogue.units.map(unit => unit.id)).size, 24);
});

const golden = {
    U01: [16002001, 160004, 1, 2],
    U07: [30002001, 300004, 0, 3],
    U11: [17002001, 170004, 3, 0],
    U16: [12002001, 120004, 2, 1],
    U19: [43002001, 430002, 4, 1]
};
check("independent class and element golden cases", () => {
    for (const [id, expected] of Object.entries(golden)) {
        const unit = catalogue.units.find(row => row.id === id);
        assert.deepEqual([unit.cardId, unit.resourceId, unit.classId, unit.elementId], expected);
    }
});

for (const entry of Object.values(models.models)) {
    await fs.access(path.join(SITE, entry.file.split("?")[0]));
}
check("model/action/ultimate identity bindings", () => {
    for (const unit of catalogue.units) {
        assert.ok(models.models[`model/player/model_pl_${unit.resourceId}.muast`]);
        assert.ok(models.classActions[`${unit.classId}:${unit.headId}`]);
        assert.equal(playback[unit.cardId].resourceId, unit.resourceId);
        assert.equal(playback[unit.cardId].ultimate.id, unit.skills[0].id);
        assert.ok(Number.isFinite(unit.displayScale) && unit.displayScale > 0);
    }
});

for (const [name, size] of [["CommonWindow", [64, 64]], ["CommonButton", [70, 70]], ["LargeDecisionButtonYellow", [126, 106]]]) {
    const png = await fs.readFile(path.join(APP, `assets/ui/${name}.png`));
    check(`native sprite trim restored: ${name}`, () => {
        assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], size);
    });
}

// The module's browser-only loader checks window.location at import time; no
// renderer, fetch, canvas, audio or fake browser interaction runs in this test.
globalThis.window = { location: { protocol: "http:" } };
const { NativeEffects } = await import("../site/etowaria-defense/render/native-effects.js");
const effects = new NativeEffects({ THREE, native, playback }, null);
check("all default-party native effects resolve", () => {
    for (const id of catalogue.defaultParty) {
        const unit = catalogue.units.find(row => row.id === id);
        for (const kind of ["attack", "skill"]) {
            const plan = effects.actionPlan(unit, kind);
            assert.ok(plan.action);
            assert.ok(plan.events.length > 0, `${id}/${kind}`);
            for (const event of plan.events) {
                if (event.kind === "TrailAttach") {
                    const element = ["fire", "water", "earth", "wind", "moon", "sun"][unit.elementId];
                    assert.ok(native.trails[element]?.file);
                } else { assert.ok(native.effects[event.effect]?.file); }
            }
        }
    }
});
check("defense buff is not falsely promoted to barrier", () => {
    for (const id of ["U11", "U12"]) {
        const unit = catalogue.units.find(row => row.id === id);
        const plan = effects.actionPlan(unit, "skill");
        assert.equal(plan.support, "buff");
        assert.ok(plan.events.some(event => event.effect === "ef_btl_buff_line"));
        assert.ok(!plan.events.some(event => event.effect === "ef_btl_barrier_00"));
    }
});
check("Yuno heals; Tamaki and Cocoa keep exact elements", () => {
    const unit = id => catalogue.units.find(row => row.id === id);
    assert.equal(effects.actionPlan(unit("U15"), "skill").support, "heal");
    assert.ok(effects.actionPlan(unit("U01"), "attack").events.some(event => event.effect === "ef_btl_magician_attack_earth_01" && event.frame === 19));
    assert.ok(effects.actionPlan(unit("U07"), "attack").events.some(event => event.effect === "ef_btl_fighter_attack_wind_00"));
});

for (const [id, names] of [[10000, ["leg_L", "leg_R", "arm_L", "arm_R"]],
    [10100, ["leg_L", "leg_R", "arm_L", "arm_R"]],
    [10200, ["front_leg_L", "front_leg_R", "back_leg_L", "back_leg_R"]]]) {
    check(`locomotion modifies and restores exact bones: ${id}`, () => {
        const root = new THREE.Group();
        const hips = new THREE.Bone(); hips.name = "Hips"; root.add(hips);
        for (const name of names) { const bone = new THREE.Bone(); bone.name = name; hips.add(bone); }
        const initial = root.children[0].children.map(node => node.position.clone());
        const motion = createEnemyMotion(THREE, root, id, 2);
        motion.apply(.13);
        assert.ok(names.some((name, index) => root.getObjectByName(name).position.distanceTo(initial[index]) > .0001));
        assert.ok(motion.speed > 0 && motion.phase > 0);
        motion.restore();
        names.forEach((name, index) => assert.ok(root.getObjectByName(name).position.distanceTo(initial[index]) < 1e-10));
        for (let i = 0; i < 200; i++) { motion.apply(1 / 60); motion.restore(); }
        names.forEach((name, index) => assert.ok(root.getObjectByName(name).position.distanceTo(initial[index]) < 1e-10));
    });
}
check("unknown locomotion rig is rejected, not guessed", () => {
    assert.throws(() => createEnemyMotion(THREE, new THREE.Group(), 99999, 1), /尚未核验/);
});

const rooms = await read(path.join(APP, "data/room-assets.json"));
check("required original room resources are present", () => {
    for (const key of ["desk_1001", "goods_1001", "goods_1043", "hobby_1014"]) {
        assert.ok(rooms[key]?.file && rooms[key].stats.meshes > 0);
        assert.match(rooms[key].sha256, /^[a-f0-9]{64}$/);
    }
});
const report = { date: "2026-09-24", scope: "identity, asset and isolated motion contracts; not gameplay or visual acceptance", results };
await fs.writeFile(path.join(ROOT, "docs/etowaria-defense/research/p0-contract-results.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`${results.length} P0 contracts passed`);
