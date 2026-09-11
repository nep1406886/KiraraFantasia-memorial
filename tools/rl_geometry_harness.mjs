// Swept bodies, true round corners and overlap recovery; no browser required.
import assert from "node:assert/strict";
import { moveCircle, circleOverlapsRect, sweepCircleTime } from "../site/game/rl/geometry.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("PASS " + name); }
const bounds = { minX: 0.45, minY: 0.45, maxX: 15.55, maxY: 11.55 };
const wall = { x: 8, y: 6, hw: 1, hh: 2 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);
function clear(p, walls) { assert.ok(walls.every(w => !circleOverlapsRect(p.x, p.y, .45, w)), JSON.stringify(p)); }

test("swept contact catches a thin target between frames", () => {
    near(sweepCircleTime(0, 0, 10, 0, 5, 0, .5), .45);
    assert.equal(sweepCircleTime(0, 1, 10, 1, 5, 0, .5), Infinity);
    assert.equal(sweepCircleTime(0, 0, 0, 0, 0, 0, .5), 0);
    assert.equal(sweepCircleTime(0, 0, 0, 0, 2, 0, .5), Infinity);
});
test("精确切线不因浮点舍入漏判，邻近真错过仍不命中", () => {
    for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16, dx = Math.cos(angle), dy = Math.sin(angle);
        for (const [gap, hit] of [[.7, true], [.70001, false]]) {
            const ax = 5 - dx * 5 - dy * gap, ay = 5 - dy * 5 + dx * gap;
            const bx = 5 + dx * 5 - dy * gap, by = 5 + dy * 5 + dx * gap;
            const t = sweepCircleTime(ax, ay, bx, by, 5, 5, .2 + .5);
            if (hit) { near(t, .5); } else { assert.equal(t, Infinity); }
        }
    }
});
test("high speed movement cannot tunnel through scenery", () => {
    const p = moveCircle({ x: 2, y: 6, radius: .45 }, 11, 0, [wall], bounds);
    near(p.x, 6.55); near(p.y, 6); clear(p, [wall]);
});
test("diagonal input slides along a wall without sticking", () => {
    const p = moveCircle({ x: 6.55, y: 5, radius: .45 }, 1, 2, [wall], bounds);
    near(p.x, 6.55); near(p.y, 7); clear(p, [wall]);
});
test("round corner leaves space the old square expansion blocked", () => {
    const p = moveCircle({ x: 6.66, y: 3.66, radius: .45 }, 0, 0, [wall], bounds);
    near(p.x, 6.66); near(p.y, 3.66); clear(p, [wall]);
});
test("can move away from a touching edge", () => {
    const p = moveCircle({ x: 6.55, y: 5, radius: .45 }, -1, 0, [wall], bounds);
    near(p.x, 5.55); clear(p, [wall]);
});
test("overlapping props recover once, without alternating push-outs", () => {
    const walls = [{ x: 6, y: 6, hw: 1.5, hh: 1 }, { x: 7, y: 6, hw: 1.5, hh: 1 }];
    const body = { x: 6.5, y: 6, radius: .45 };
    Object.assign(body, moveCircle(body, 0, 0, walls, bounds)); clear(body, walls);
    const first = { ...body };
    for (let i = 0; i < 240; i++) Object.assign(body, moveCircle(body, 0, 0, walls, bounds));
    near(body.x, first.x); near(body.y, first.y);
    Object.assign(body, moveCircle(body, 0, -2, walls, bounds));
    assert.ok(body.y < first.y); clear(body, walls);
});
test("one-body-wide corridor stays traversable", () => {
    const walls = [{ x: 5, y: 6, hw: 2.5, hh: 3 }, { x: 11, y: 6, hw: 2.5, hh: 3 }];
    const p = moveCircle({ x: 8, y: 2, radius: .45 }, 0, 8, walls, bounds);
    near(p.x, 8); near(p.y, 10); clear(p, walls);
});
test("closed corner stops both axes but permits retreat", () => {
    const walls = [{ x: 9, y: 6, hw: 1, hh: 4 }, { x: 6, y: 9, hw: 4, hh: 1 }];
    const p = moveCircle({ x: 6, y: 6, radius: .45 }, 4, 4, walls, bounds);
    near(p.x, 7.55); near(p.y, 7.55); clear(p, walls);
    const q = moveCircle({ ...p, radius: .45 }, -1, -1, walls, bounds);
    near(q.x, p.x - 1); near(q.y, p.y - 1);
});
test("deterministic mixed scenery stress: 20000 valid steps never penetrate", () => {
    let seed = 713;
    const rng = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
    for (let room = 0; room < 40; room++) {
        const walls = Array.from({ length: 12 }, () => ({ x: 2 + rng() * 12, y: 2 + rng() * 8, hw: .15 + rng(), hh: .15 + rng() }));
        const p = { x: 8, y: 6, radius: .45 };
        for (let i = 0; i < 500; i++) {
            Object.assign(p, moveCircle(p, (rng() - .5) * 2, (rng() - .5) * 2, walls, bounds));
            clear(p, walls);
            assert.ok(p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY);
        }
    }
});
console.log(`${passed} geometry checks passed`);
