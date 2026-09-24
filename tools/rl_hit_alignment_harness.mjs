import assert from "node:assert/strict";
import { createDanmaku } from "../site/game/rl/danmaku.js";
import { createWorld } from "../site/game/rl/world.js";

let count = 0;
function test(label, fn) { fn(); count++; console.log("PASS " + label); }
function near(value, expected, label = "contact") { assert.ok(Number.isFinite(value) && Math.abs(value - expected) < 1e-8, label + ": " + value + " != " + expected); }
function target(id, x, y, radius = .5) { return { id, x, y, radius, hp: 100, dead: false, iframes: 0 }; }
function shot(origin, mods = {}) {
    const pool = createDanmaku({ capacity: 8 });
    pool.emit("aimed", origin, { count: 1, offset: 0, side: "player", radius: .2, speed: 10, life: 2, ...mods });
    return pool;
}
function contacts(pool, dt, ctx) {
    const rows = []; pool.update(dt, { width: 40, height: 40, ...ctx,
        onHit(b, e, point) { rows.push({ id: e.id, point, bullet: { x: b.x, y: b.y }, radius: e.radius }); } });
    return rows;
}
test("扫掠返回首次接触点而非帧末弹心或目标中心", () => {
    const pool = shot({ x: 0, y: 5, angle: 0 }), e = target(1, 5, 5);
    const rows = contacts(pool, 1, { enemies: [e] });
    assert.equal(rows.length, 1); assert.ok(rows[0].point);
    near(rows[0].point.x, 4.5); near(rows[0].point.y, 5);
    assert.equal(pool.active, 0); assert.equal(rows[0].bullet.x, 10);
});
test("移动目标使用碰撞时的位置而非一步后的终点", () => {
    const pool = shot({ x: 5, y: 5, angle: 0 }, { speed: 0 }), e = target(1, 7, 5);
    const rows = contacts(pool, 1, { enemies: [e], previousPosition: () => ({ x: 3, y: 5 }) });
    assert.equal(rows.length, 1); near(rows[0].point.x, 4.8); near(rows[0].point.y, 5);
});
test("切线命中与邻近错过严格区分，不扩大伤害圆", () => {
    const e = target(1, 5, 5);
    const tangent = contacts(shot({ x: 0, y: 5.7, angle: 0 }), 1, { enemies: [e] });
    assert.equal(tangent.length, 1); near(tangent[0].point.x, 5); near(tangent[0].point.y, 5.5);
    assert.equal(contacts(shot({ x: 0, y: 5.70001, angle: 0 }), 1, { enemies: [e] }).length, 0);
});
test("斜向接触位于目标表面并且八方向旋转一致", () => {
    for (let i = 0; i < 8; i++) {
        const angle = i * Math.PI / 4, dx = Math.cos(angle), dy = Math.sin(angle);
        const pool = shot({ x: 10 - dx * 5, y: 10 - dy * 5, angle });
        const rows = contacts(pool, 1, { enemies: [target(1, 10, 10)] });
        assert.equal(rows.length, 1); near(rows[0].point.x, 10 - dx * .5); near(rows[0].point.y, 10 - dy * .5);
    }
});
test("穿透按接触时间排序，每个目标取得独立值快照", () => {
    const pool = shot({ x: 0, y: 5, angle: 0 }, { pierce: 2 });
    const rows = contacts(pool, 1, { enemies: [target(3, 8, 5), target(2, 5, 5), target(1, 2, 5)] });
    assert.deepEqual(rows.map(row => row.id), [1, 2, 3]);
    assert.deepEqual(rows.map(row => row.point.x), [1.5, 4.5, 7.5]);
    assert.notEqual(rows[0].point, rows[1].point); assert.equal(pool.active, 0);
    const before = JSON.stringify(rows); pool.emit("aimed", { x: 20, y: 30, angle: 1 }, { side: "enemy", count: 1 });
    assert.equal(JSON.stringify(rows), before);
});
test("已有重叠的弹心在圆盘内时不伪造另一侧边缘", () => {
    for (const x of [5, 5.2]) {
        const rows = contacts(shot({ x, y: 5, angle: 0 }, { speed: 0 }), .1, { enemies: [target(1, 5, 5)] });
        assert.equal(rows.length, 1); near(rows[0].point.x, x); near(rows[0].point.y, 5);
    }
});
test("延迟弹只在激活区间判定，生命末段仍返回精确接触", () => {
    const pool = shot({ x: 5, y: 5, angle: 0 }, { speed: 0 }); pool.forEach(b => b.delay = .75);
    assert.equal(contacts(pool, 1, { enemies: [target(1, 7, 5)], previousPosition: () => ({ x: 3, y: 5 }) }).length, 0);
    const final = shot({ x: 0, y: 5, angle: 0 }, { life: .5 });
    const rows = contacts(final, 1, { enemies: [target(1, 5, 5)] });
    assert.equal(rows.length, 1); near(rows[0].point.x, 4.5); assert.equal(final.active, 0);
});
test("延迟激活后的移动目标以同一个时间区间计算接触点", () => {
    const pool = shot({ x: 5, y: 5, angle: 0 }, { speed: 0 }); pool.forEach(b => b.delay = .25);
    const rows = contacts(pool, 1, { enemies: [target(1, 6, 5)], previousPosition: () => ({ x: 2, y: 5 }) });
    assert.equal(rows.length, 1); near(rows[0].point.x, 4.8); near(rows[0].point.y, 5);
});
test("敌方子弹同样报告实际接触，无敌时不消费或伪造命中", () => {
    const player = target(1, 5, 5, .45), pool = shot({ x: 0, y: 5, angle: 0 }, { side: "enemy" });
    const rows = contacts(pool, 1, { player }); near(rows[0].point.x, 4.55);
    const immune = shot({ x: 0, y: 5, angle: 0 }, { side: "enemy" }); player.iframes = 1;
    assert.equal(contacts(immune, 1, { player }).length, 0); assert.equal(immune.active, 1);
});
test("世界弹体命中事件保存接触值，后续移动不改变它", () => {
    const world = createWorld({ width: 30, height: 30, rng: () => .99 });
    const p = world.spawnPlayer({ x: 4, y: 10, hp: 100 });
    const e = world.spawnEnemy({ x: 10, y: 10, hp: 100, radius: .5 }); e.actionTimer = 1e9;
    world.danmaku.emit("aimed", { x: 8.9, y: 10, angle: 0 }, { count: 1, offset: 0, side: "player",
        speed: 30, power: 1, coef: 1, radius: .2, srcId: p.id });
    world.update(.05);
    const event = world.drainEvents().find(row => row.type === "hit" && row.target === e);
    assert.ok(event?.impact); near(event.impact.x, 9.5); near(event.impact.y, 10);
    const before = JSON.stringify(event.impact); e.x += 3; e.y += 4;
    assert.equal(JSON.stringify(event.impact), before); assert.equal(event.damage, 4);
});
test("非弹体受击同样快照位置，不改变伤害与冻结约束", () => {
    const world = createWorld({ width: 30, height: 30, rng: () => .99 });
    const p = world.spawnPlayer({ x: 10, y: 10, hp: 100 }), e = world.spawnEnemy({ x: 13, y: 10, atk: 10 });
    const result = world.hitPlayerFrom(e, { coef: 1, magic: false }, { contact: true });
    assert.ok(result.hit); const event = world.drainEvents().find(row => row.type === "hit");
    assert.deepEqual(event.impact, { x: 10, y: 10 });
    p.x = 14; assert.equal(event.impact.x, 10);
    p.iframes = 0; world.frozen = true; const hp = p.hp;
    world.danmaku.emit("aimed", { x: 13, y: 10, angle: 0 }, { count: 1, offset: 0, side: "enemy", speed: 30, power: 999 });
    world.update(1); assert.equal(p.hp, hp); assert.equal(world.drainEvents().length, 0);
});
test("爆炸溅射仍触发一次并使用各目标中心，接触参数不误作递归标记", () => {
    const world = createWorld({ width: 30, height: 30, rng: () => .99 });
    const p = world.spawnPlayer({ x: 4, y: 10, hp: 100 });
    const first = world.spawnEnemy({ x: 10, y: 10, hp: 100, radius: .5 });
    const splash = world.spawnEnemy({ x: 10, y: 11.2, hp: 100, radius: .5 });
    for (const e of [first, splash]) { e.actionTimer = 1e9; }
    world.danmaku.emit("aimed", { x: 8.9, y: 10, angle: 0 }, { count: 1, offset: 0, side: "player",
        speed: 30, power: 1, coef: 1, radius: .2, srcId: p.id, blastRadius: 1 });
    world.update(.05);
    const events = world.drainEvents(), hits = events.filter(e => e.type === "hit");
    assert.equal(hits.length, 2); assert.equal(events.filter(e => e.type === "blast").length, 1);
    near(hits.find(e => e.target === first).impact.x, 9.5);
    assert.deepEqual(hits.find(e => e.target === splash).impact, { x: 10, y: 11.2 });
    assert.ok(hits.every(e => e.damage === 4));
});
console.log("\n" + count + " 项命中位置逻辑检查通过。");
