import assert from "node:assert/strict";
import * as THREE from "../site/vendor/three/three.module.min.js";
import { UNIT_RULES, LEVELS } from "../site/etowaria-defense/data/campaign.js";
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
    assert.deepEqual(area.cells.map(cell => cell.col), [4,5,6]);
    assert.equal(area.cells[0].left, 3.8);
    assert.equal(area.cells[2].right, 6.2);
    assert.equal(attackContains(origin, { row: 2, x: 6.201 }, UNIT_RULES.U07), false);
    assert.equal(attackContains(origin, { row: 2, x: 6.2 }, UNIT_RULES.U07), true);
    assert.match(area.text, /近身攻击距离2.2格/);
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
    const run = relaxed => {
        const root = new THREE.Group(); const idle = new IdleMotion(THREE, root, 160004);
        idle.configure({ enabled: true, relaxed });
        for (let i = 0; i < 60 * 30; i++) { if (idle.apply(1/60, true)) { return true; } }
        return false;
    };
    assert.equal(run(false), false); assert.equal(run(true), true);
    const root = new THREE.Group(); const idle = new IdleMotion(THREE, root, 160004);
    idle.configure({ enabled: true, relaxed: true }); assert.equal(idle.apply(30, false), false);
});
test("relaxed room clip never cuts a tilt, and every phase completes one", () => {
    for (let resourceId = 160000; resourceId < 160040; resourceId++) {
        const root = new THREE.Group(); const head = new THREE.Bone(); head.name = "Head_root"; root.add(head);
        const idle = new IdleMotion(THREE, root, resourceId);
        idle.configure({ enabled: true, relaxed: true });
        let peak = 0; let switches = 0;
        for (let i = 0; i < 60 * 40; i++) {
            idle.restore();
            if (idle.apply(1/60, true)) { assert.equal(idle.weight, 0, `${resourceId} cut a tilt`); switches++; idle.reset(); }
            peak = Math.max(peak, idle.weight);
        }
        assert.ok(switches > 0, `${resourceId} never relaxed`);
        assert.ok(peak > .99, `${resourceId} never completed a tilt (gap ${idle.gap.toFixed(2)})`);
    }
});
test("a threatened lane eases the tilt out and returns the face at once", () => {
    const calls = [];
    const actor = { face: name => { calls.push(name); return true; }, faceAuto: () => { calls.push("auto"); return true; } };
    const root = new THREE.Group(); const head = new THREE.Bone(); head.name = "Head_root"; root.add(head);
    const idle = new IdleMotion(THREE, root, 160004, { actor });
    while (idle.weight < .95) { idle.restore(); idle.apply(1/60, true); }
    idle.configure({ enabled: false });
    assert.equal(calls.at(-1), "auto");
    let previous = idle.weight; let frames = 0;
    while (idle.weight > 0) {
        idle.restore(); idle.apply(1/60, true); frames++;
        assert.ok(previous - idle.weight <= 3 / 60 + 1e-9 && idle.weight <= previous);
        previous = idle.weight;
    }
    assert.ok(frames >= 15 && frames <= 21, `ease-out took ${frames} frames`);
    idle.restore(); assert.deepEqual(head.quaternion.toArray(), [0, 0, 0, 1]);
    assert.equal(calls.filter(name => name !== "auto").length, 1, "no new face while threatened");
});
test("idle tilt eases in and out instead of jumping mid-pose", () => {
    // A phase whose first window is already open at the 2 s settle time is
    // the case that used to snap; keep generating until three are covered.
    let critical = 0;
    for (let resourceId = 160000; critical < 3 || resourceId < 160008; resourceId++) {
        assert.ok(resourceId < 161000, "no critical idle phase generated");
        const root = new THREE.Group(); const head = new THREE.Bone(); head.name = "Head_root"; root.add(head);
        const idle = new IdleMotion(THREE, root, resourceId);
        if ((2 + idle.phase * 5) % 7 < 2.4) { critical++; }
        let previous = 0; let largest = 0; let peak = 0;
        for (let i = 0; i < 60 * 40; i++) {
            idle.restore(); idle.apply(1/60, true);
            largest = Math.max(largest, Math.abs(idle.weight - previous));
            peak = Math.max(peak, idle.weight); previous = idle.weight;
        }
        assert.ok(peak > .99, `${resourceId} never gestured`);
        assert.ok(largest < .05, `${resourceId} jumped by ${largest}`);
    }
});
test("idle face is pinned during the gesture and handed back afterwards", () => {
    const calls = [];
    const actor = { face: name => { calls.push(name); return true; }, faceAuto: () => { calls.push("auto"); return true; } };
    const root = new THREE.Group(); const head = new THREE.Bone(); head.name = "Head_root"; root.add(head);
    const idle = new IdleMotion(THREE, root, 160004, { actor });
    for (let i = 0; i < 60 * 30; i++) { idle.restore(); idle.apply(1/60, true); }
    assert.ok(calls.some(name => name === "happy" || name === "joy"));
    for (let i = 0; i < calls.length; i += 2) {
        assert.notEqual(calls[i], "auto"); assert.equal(calls[i + 1] ?? "auto", "auto");
    }
    while (!idle.faceOn) { idle.restore(); idle.apply(1/60, true); }
    const before = calls.length; idle.reset();
    assert.equal(calls.length, before, "a new action owns the face; reset must not hand it back");
    while (!idle.faceOn) { idle.restore(); idle.apply(1/60, true); }
    idle.configure({ enabled: false });
    assert.equal(calls.at(-1), "auto", "a threatened lane hands the face back while the idle clip continues");
});
test("idle refuses a head bone that does not face the camera", () => {
    const billboard = new THREE.Group(); const root = new THREE.Group(); billboard.add(root);
    const head = new THREE.Bone(); head.name = "Head_root"; head.rotation.y = .5; root.add(head);
    billboard.updateMatrixWorld(true);
    assert.equal(new IdleMotion(THREE, root, 160004, { billboard }).snapshot().bones, 0);
    head.rotation.y = 0; billboard.updateMatrixWorld(true);
    assert.equal(new IdleMotion(THREE, root, 160004, { billboard }).snapshot().bones, 1);
});
const catalogue = JSON.parse(await fs.readFile(new URL("../site/etowaria-defense/data/units.json", import.meta.url),"utf8"));
test("canonical full names preserve canonically single names", () => {
    assert.equal(catalogue.units.find(unit => unit.id === "U01").name, "本田珠辉");
    assert.equal(catalogue.units.find(unit => unit.id === "U19").name, "小野坂小春");
    assert.equal(catalogue.units.find(unit => unit.id === "U15").name, "由乃");
    assert.equal(UNIT_RULES.U07.name, "保登心爱");
});
// The real BattleView and battle simulation on a stub stage: WebGL is the only
// part left out, so these check the placement flow rather than a copy of it.
globalThis.window ??= globalThis;
globalThis.location ??= new URL("http://localhost/etowaria-defense/");
const { BattleView } = await import("../site/etowaria-defense/render/battle-view.js");
const testAsync = async (name, fn) => { await fn(); results.push({ name, passed: true }); };
const boardView = ({ manualClock = true, reducedMotion = false } = {}) => {
    const level = LEVELS[0];
    const view = new BattleView({ level, deck: ["F01", "U01"], catalogue, manualClock, audio: { settings: { reducedMotion } } });
    const pauseReasons = new Set();
    view.stage = { THREE, rows: 5, environment: new THREE.Group(), field: new THREE.Group(), scene: new THREE.Group(), grid: new THREE.Group(),
        players: [], enemies: [], pauseReasons, render() {}, resize() {}, makeShadow() {}, effects: { emit() {}, pools: new Map() }, items: { template: null },
        setPaused(reason, paused) { if (paused) { pauseReasons.add(reason); } else { pauseReasons.delete(reason); } },
        selection: Object.assign(new THREE.Group(), { material: { color: { set() {} } } }) };
    view.range = { show: () => null, clear() {} };
    view.desk = { group: new THREE.Group() }; view.book = { group: new THREE.Group() };
    view.makeStatus = () => {};
    view.markBoard(); view.ready = true;
    const grid = () => [view.board.lines.visible, Number(view.board.lines.material.opacity.toFixed(3))];
    return { view, grid, display: (row, col) => [row + level.rowOffset, col + level.colOffset] };
};
await testAsync("placement board lines appear only while a card or the recall tool is held", async () => {
    const { view, grid, display } = boardView();
    assert.deepEqual(grid(), [false, 0], "no card is held when the battle opens");
    view.pointCell(1, 0); assert.deepEqual(grid(), [false, 0], "hovering without a card");
    view.select("F01"); assert.deepEqual(grid(), [true, .42]);
    view.pointCell(1, 0); assert.deepEqual(grid(), [true, .42]);
    assert.equal((await view.deployCell(1, 0)).ok, true);
    assert.equal(view.selected, null, "a placed card goes back to the bank");
    assert.deepEqual(grid(), [false, 0]);
    view.select("U01"); view.select("U01");
    assert.equal(view.selected, null, "picking the held card again puts it back");
    assert.deepEqual(grid(), [false, 0]);
    view.setRecall(true); assert.deepEqual(grid(), [true, .42]);
    assert.equal((await view.deployCell(1, 0)).ok, true);
    assert.equal(view.recallMode, false, "the recall tool is used once");
    assert.deepEqual(grid(), [false, 0]);
    view.select("F01"); await view.input(...display(0, 0), "touch");
    assert.equal(view.touchTarget?.row, 0);
    assert.deepEqual(grid(), [true, .42], "a touch placement awaiting confirmation");
    assert.equal((await view.confirmPlacement()).ok, true); assert.deepEqual(grid(), [false, 0]);
    view.select("F01"); view.setPaused("deploy-load", true);
    assert.deepEqual(grid(), [true, .42], "loading a model mid-placement keeps the lines");
    view.setPaused("deploy-load", false); view.setPaused("manual", true);
    assert.deepEqual(grid(), [false, 0], "a pause hides the lines");
    view.setPaused("manual", false); assert.deepEqual(grid(), [true, .42], "the card is still held after the pause");
    view.cancelPlacement(); assert.deepEqual(grid(), [false, 0]);
});
await testAsync("board lines fade with frames, and leave at once when frames stop", async () => {
    const { view, grid } = boardView({ manualClock: false });
    view.select("F01"); assert.deepEqual(grid(), [false, 0], "the fade starts on the next frame");
    view.afterFrame(.07); assert.deepEqual(grid(), [true, .21]);
    view.afterFrame(.08); assert.deepEqual(grid(), [true, .42]);
    view.cancelPlacement(); assert.deepEqual(grid(), [true, .42], "the fade-out also runs on frames");
    view.afterFrame(.11); assert.deepEqual(grid(), [true, .21]);
    view.afterFrame(.12); assert.deepEqual(grid(), [false, 0]);
    view.select("F01"); view.afterFrame(1); assert.deepEqual(grid(), [true, .42]);
    view.setPaused("manual", true);
    assert.deepEqual(grid(), [false, 0], "no frames run while paused");
    const reduced = boardView({ manualClock: false, reducedMotion: true });
    reduced.view.select("F01"); assert.deepEqual(reduced.grid(), [true, .42], "reduced motion skips the fade");
});
await fs.writeFile(new URL("../docs/etowaria-defense/research/presentation-contracts.json", import.meta.url), JSON.stringify({ scope:"Range, motion and naming contracts; separate browser proof required", results },null,2)+"\n");
console.log(`${results.length} presentation contracts passed`);
