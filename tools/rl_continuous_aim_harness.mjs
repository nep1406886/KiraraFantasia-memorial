import assert from "node:assert/strict";
import { createWorld } from "../site/game/rl/world.js";
import { inWeaponReach, weaponProfile } from "../site/game/rl/weaponprofile.js";
import { createDanmaku } from "../site/game/rl/danmaku.js";

let count = 0;
const angleError = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
function test(name, fn) { fn(); count++; console.log("PASS " + name); }
test("一千个非整角度的剑扇形和枪通道保留方向，不变成周身伤害", () => {
    for (const cls of [0, 3]) {
        const profile = weaponProfile({ class: cls });
        for (let i = 0; i < 1000; i++) {
            const facing = (i + .173) * 2 * Math.PI / 1000;
            const p = { x: 10, y: 10, facing }, dx = Math.cos(facing), dy = Math.sin(facing);
            const enemy = (x, y) => ({ x, y, radius: .2 });
            assert.ok(inWeaponReach(p, enemy(10 + dx * 2, 10 + dy * 2), profile));
            assert.ok(!inWeaponReach(p, enemy(10 - dx * 2, 10 - dy * 2), profile));
            assert.ok(!inWeaponReach(p, enemy(10 + dx * 5, 10 + dy * 5), profile));
        }
    }
});
test("一千个非整角度的弹体速度与发射方向完全相同", () => {
    const pool = createDanmaku({ capacity: 2 });
    for (let i = 0; i < 1000; i++) {
        const angle = (i + .173) * 2 * Math.PI / 1000;
        pool.emit("aimed", { x: 10, y: 10, angle }, { count: 1, speed: 10, offset: 0 });
        pool.forEach(b => assert.ok(angleError(Math.atan2(b.vy, b.vx), angle) < 1e-12));
        pool.clear();
    }
});
test("触控可在第一击前摇选择角度，生效后的伤害区域保持锁定", () => {
    const world = createWorld({ width: 30, height: 30, rng: () => .99 });
    const p = world.spawnPlayer({ x: 15, y: 15 });
    world.inputState = { attack: true, move: { x: 0, y: 0 }, aimStick: { active: false } };
    world.update(1 / 60); assert.equal(p.facing, 0);
    const aim = a => ({ x: p.x + Math.cos(a) * 3, y: p.y + Math.sin(a) * 3 });
    world.inputState.aimStick.active = true; world.aim = aim(1.173);
    world.update(1 / 60); assert.ok(angleError(p.facing, 1.173) < 1e-12);
    for (let i = 0; i < 7; i++) world.update(1 / 60);
    assert.ok(p.swingHits); world.aim = aim(2.413);
    world.update(1 / 60); assert.ok(angleError(p.facing, 1.173) < 1e-12);
    const first = p.swingId;
    for (let i = 0; i < 24 && p.swingId === first; i++) world.update(1 / 60);
    assert.equal(p.swingId, first + 1); assert.ok(angleError(p.facing, 2.413) < 1e-12);
});
test("鼠标与纯键盘沿用既有承诺时点，不被触控适配旋转", () => {
    const world = createWorld({ width: 30, height: 30 });
    const p = world.spawnPlayer({ x: 15, y: 15 });
    world.inputState = { attack: true, move: { x: 0, y: 0 }, aimStick: { active: false } };
    world.aim = { x: 17, y: 16 }; world.update(1 / 60); const first = p.facing;
    world.aim = { x: 12, y: 16 }; world.update(1 / 60); assert.equal(p.facing, first);
});
console.log(count + " 项连续角度逻辑检查通过。");
