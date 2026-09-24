import assert from "node:assert/strict";
import * as THREE from "../site/vendor/three/three.module.min.js";
import { UNIT_RULES } from "../site/etowaria-defense/data/campaign.js";
import { placementCoverage, attackContains, healingContains, burstContains } from "../site/etowaria-defense/sim/targeting.js";
import { createEnemyMotion } from "../site/etowaria-defense/render/enemy-motion.js";
import { IdleMotion } from "../site/etowaria-defense/render/idle-motion.js";
import fs from "node:fs/promises";

const results = [];
const test = (name, fn) => { fn(); results.push({ name, passed: true }); };
const board = { rows: 5, cols: 9 };
const origin = { row: 2, col: 4 };

test("healing preview includes only same-lane fixed targets, clipped at edge", () => {
    const middle = placementCoverage(UNIT_RULES.U15, 2, 4, board);
    assert.deepEqual(middle.cells.map(cell => [cell.row, cell.col]), [[2,1],[2,2],[2,3],[2,4],[2,5],[2,6],[2,7]]);
    assert.deepEqual(placementCoverage(UNIT_RULES.U15, 0, 0, board).cells.map(cell => cell.col), [0,1,2,3]);
    assert.equal(healingContains(origin, { row: 2, col: 0 }, UNIT_RULES.U15), false);
    assert.equal(healingContains(origin, { row: 1, col: 4 }, UNIT_RULES.U15), false);
    assert.equal(healingContains(origin, origin, UNIT_RULES.U15), true);
});
test("burst has exact 3x3 footprint and four cells at a corner", () => {
    assert.equal(placementCoverage(UNIT_RULES.F10, 2, 4, board).cells.length, 9);
    assert.deepEqual(placementCoverage(UNIT_RULES.F10, 0, 0, board).cells.map(cell => [cell.row,cell.col]), [[0,0],[0,1],[1,0],[1,1]]);
    assert.equal(burstContains(origin, { row: 1, x: 5.5 }, UNIT_RULES.F10), true);
    assert.equal(burstContains(origin, { row: 1, x: 5.501 }, UNIT_RULES.F10), false);
    assert.equal(burstContains(origin, { row: 0, x: 4 }, UNIT_RULES.F10), false);
});
test("melee preview represents fractional reach, not two full cells", () => {
    const area = placementCoverage(UNIT_RULES.U07, 2, 4, board);
    assert.deepEqual(area.cells.map(cell => cell.col), [4,5,6]);
    assert.equal(area.cells[0].left, 3.8);
    assert.equal(area.cells[2].right, 5.6);
    assert.equal(attackContains(origin, { row: 2, x: 5.601 }, UNIT_RULES.U07), false);
    assert.equal(attackContains(origin, { row: 2, x: 5.6 }, UNIT_RULES.U07), true);
});
test("producer has no aura and invalid cells have no preview", () => {
    assert.equal(placementCoverage(UNIT_RULES.F01, 2, 4, board).cells.length, 0);
    assert.equal(placementCoverage(UNIT_RULES.F10, -1, 0, board), null);
    assert.equal(placementCoverage(UNIT_RULES.F10, 0, 9, board), null);
});
test("guard preview documents self-only defense", () => {
    const area = placementCoverage(UNIT_RULES.U11, 2, 4, board);
    assert.match(area.text, /仅作用于自身/);
    assert.ok(area.cells.every(cell => cell.row === 2));
});

for (const [id, names] of [[10000,["leg_L","leg_R","arm_L","arm_R"]],
    [10100,["leg_L","leg_R","arm_L","arm_R"]],
    [10200,["front_leg_L","front_leg_R","back_leg_L","back_leg_R"]]]) {
    for (const mirror of [-1, 1]) {
        test(`support-foot world movement matches leftward velocity ${id}/${mirror}`, () => {
            const position = new THREE.Group(); const root = new THREE.Group(); root.scale.set(mirror * 2, 2, 2); position.add(root);
            const hips = new THREE.Bone(); hips.name = "Hips"; root.add(hips);
            for (const name of names) { const bone = new THREE.Bone(); bone.name = name; hips.add(bone); }
            const motion = createEnemyMotion(THREE, root, id, 2, mirror);
            motion.apply(.05); position.updateMatrixWorld(true);
            const before = root.getObjectByName(names[0]).getWorldPosition(new THREE.Vector3());
            motion.restore(); motion.apply(.01); position.position.x -= motion.speed * .01; position.updateMatrixWorld(true);
            const after = root.getObjectByName(names[0]).getWorldPosition(new THREE.Vector3());
            assert.ok(Math.abs(after.x - before.x) < 1e-10);
            assert.ok(motion.speed > 0);
            motion.restore(); assert.equal(root.getObjectByName(names[0]).position.x, 0);
        });
    }
}
test("idle perturbations restore completely and instances are staggered", () => {
    const root = new THREE.Group(); const neck = new THREE.Bone(); neck.name = "Neck"; root.add(neck);
    const head = new THREE.Bone(); head.name = "Head_root"; root.add(head);
    const idle = new IdleMotion(THREE, root, 160004); const other = new IdleMotion(THREE, root, 160004);
    assert.notEqual(idle.phase, other.phase);
    let moved = false;
    for (let i = 0; i < 1000; i++) {
        idle.restore(); idle.apply(1/60, true);
        if (Math.abs(head.quaternion.z) > .001) { moved = true; }
    }
    assert.ok(moved); idle.reset();
    assert.deepEqual(head.quaternion.toArray(), [0,0,0,1]);
    idle.configure({enabled:false}); idle.apply(10, true); assert.equal(idle.weight, 0);
    assert.deepEqual(head.position.toArray(), [0,0,0]);
});
test("idle actions request original relaxed clip only outside combat", () => {
    const root = new THREE.Group(); const idle = new IdleMotion(THREE, root, 160004);
    idle.configure({enabled:true,relaxed:false}); assert.equal(idle.apply(30,true),false);
    idle.configure({enabled:true,relaxed:true}); assert.equal(idle.apply(30,true),true);
    idle.reset(); assert.equal(idle.apply(30,false),false);
});
const catalogue = JSON.parse(await fs.readFile(new URL("../site/etowaria-defense/data/units.json", import.meta.url),"utf8"));
test("canonical full names preserve canonically single names", () => {
    assert.equal(catalogue.units.find(unit => unit.id === "U01").name, "本田珠辉");
    assert.equal(catalogue.units.find(unit => unit.id === "U19").name, "小野坂小春");
    assert.equal(catalogue.units.find(unit => unit.id === "U15").name, "由乃");
    assert.equal(UNIT_RULES.U07.name, "保登心爱");
});
await fs.writeFile(new URL("../docs/etowaria-defense/research/presentation-contracts.json", import.meta.url), JSON.stringify({ scope:"Range, motion and naming contracts; separate browser proof required", results },null,2)+"\n");
console.log(`${results.length} presentation contracts passed`);
