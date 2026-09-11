// Whole-volley capacity contract; expected counts are independent of emit().
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDanmaku } from "../site/game/rl/danmaku.js";
import { createWorld } from "../site/game/rl/world.js";
const cases = [
    ["aimed", { count: 3 }, 3], ["fan", { count: 5 }, 5],
    ["ring", { count: 12 }, 12], ["spiral", { arms: 3, steps: 6 }, 18],
    ["volley", { count: 3 }, 3], ["wave", { count: 3 }, 3],
    ["cross", { count: 2 }, 8], ["wall", { count: 7 }, 7]
];
const origin = { x: 8, y: 6, angle: .4 };
const snapshot = dm => { const rows = []; dm.forEach(b => rows.push({ ...b })); return rows; };
let tests = 0, failures = 0;
function test(label, fn) {
    tests++;
    try { fn(); console.log("PASS " + label); }
    catch (error) { failures++; console.error("FAIL " + label + ": " + error.message); }
}
for (const [pattern, mods, need] of cases) test(pattern + " never emits an incomplete group", () => {
    const dm = createDanmaku({ capacity: need + 2 });
    assert.equal(dm.emit("aimed", origin, { count: 3, speed: .1, life: 10 }), 3);
    const before = snapshot(dm), slots = dm.pool.slots.slice();
    assert.equal(dm.emit(pattern, origin, mods), 0);
    assert.deepEqual(snapshot(dm), before);
    assert.deepEqual(dm.pool.slots, slots);
    assert.equal(dm.active, 3); assert.equal(dm.dropped, need);
    assert.equal(dm.rejectedGroups, 1);
});
for (const [pattern, mods, need] of cases) test(pattern + " admits an exact fit with unchanged geometry", () => {
    const dm = createDanmaku({ capacity: need + 2 });
    dm.emit("aimed", origin, { count: 2, side: "player" });
    const old = snapshot(dm);
    assert.equal(dm.emit(pattern, origin, mods), need);
    assert.equal(dm.active, dm.capacity); assert.equal(dm.dropped, 0);
    assert.deepEqual(snapshot(dm).slice(0, 2), old);
    const clean = createDanmaku({ capacity: need });
    assert.equal(clean.emit(pattern, origin, mods), need);
    const geometry = b => [b.x, b.y, b.vx, b.vy, b.delay, b.curve, b.life, b.radius, b.pattern];
    assert.deepEqual(snapshot(dm).slice(2).map(geometry), snapshot(clean).map(geometry));
    assert.equal(dm.emit(pattern, origin, mods), 0);
    assert.equal(dm.rejectedGroups, 1); assert.equal(dm.dropped, need);
});
test("delayed spiral shots reserve capacity until they actually expire", () => {
    const dm = createDanmaku({ capacity: 7 });
    assert.equal(dm.emit("spiral", origin, { arms: 2, steps: 3, stepDelay: 1, speed: 0, life: .1 }), 6);
    assert.equal(snapshot(dm).filter(b => b.delay > 0).length, 4);
    assert.equal(dm.emit("aimed", origin, { count: 2 }), 0);
    dm.update(.2, {});
    assert.equal(dm.active, 4);
    assert.equal(dm.emit("aimed", origin, { count: 3 }), 3);
});
test("rejection does not consume spawn identities or clear existing payloads", () => {
    const dm = createDanmaku({ capacity: 5 });
    dm.emit("aimed", origin, { count: 3, side: "player", power: 420, slow: .4 });
    assert.equal(dm.emit("ring", origin, { count: 3, side: "enemy" }), 0);
    const before = snapshot(dm);
    assert.equal(dm.emit("aimed", origin, { count: 2, side: "enemy" }), 2);
    assert.deepEqual(snapshot(dm).slice(0, 3), before);
    assert.deepEqual(snapshot(dm).map(b => b.spawnId), [1, 2, 3, 4, 5]);
});
test("clear retains diagnostics; diagnostic reset does not clear in-flight shots", () => {
    const dm = createDanmaku({ capacity: 3 });
    dm.emit("ring", origin, { count: 4 }); dm.emit("aimed", origin, { count: NaN });
    dm.clear(); assert.equal(dm.dropped, 4); assert.equal(dm.rejectedGroups, 1); assert.equal(dm.invalidGroups, 1);
    dm.emit("aimed", origin); dm.resetDropped();
    assert.equal(dm.active, 1); assert.equal(dm.dropped, 0); assert.equal(dm.rejectedGroups, 0); assert.equal(dm.invalidGroups, 0);
});
test("valid fractional counts are normalized once for both budget and geometry", () => {
    for (const [pattern, mods, need] of [["fan", { count: 2.1 }, 3], ["cross", { count: 1.1 }, 8],
        ["spiral", { arms: 1.1, steps: 2.1 }, 6]]) {
        const tooSmall = createDanmaku({ capacity: need - 1 }), exact = createDanmaku({ capacity: need });
        assert.equal(tooSmall.emit(pattern, origin, mods), 0);
        assert.equal(exact.emit(pattern, origin, mods), need);
        if (pattern === "fan") {
            const rows = snapshot(exact), angles = rows.map(b => Math.atan2(b.vy, b.vx));
            assert.ok(Math.abs(angles[2] - angles[0] - Math.PI / 3) < 1e-9);
        }
    }
});
test("legacy zero/default and minimum quantities remain well-defined", () => {
    for (const [pattern, mods, expected] of [["aimed",{count:0},1],["fan",{count:0},5],
        ["ring",{count:0},12],["spiral",{arms:0,steps:0},3],["volley",{count:1},2],
        ["wave",{count:-1},2],["cross",{count:0},4],["wall",{count:1},3]]) {
        const dm=createDanmaku({capacity:expected}); assert.equal(dm.emit(pattern,origin,mods),expected);
    }
});
test("non-finite, unsafe, and non-numeric counts are bounded invalid requests", () => {
    const dm = createDanmaku({ capacity: 8 });
    for (const value of [Infinity, -Infinity, NaN, "5", {}, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(dm.emit("aimed", origin, { count: value }), 0);
    }
    assert.equal(dm.emit("spiral", origin, { arms: Number.MAX_SAFE_INTEGER, steps: 2 }), 0);
    assert.equal(dm.invalidGroups, 7); assert.equal(dm.active, 0); assert.equal(dm.dropped, 0);
    assert.equal(dm.emit("aimed", origin, { count: 1e12 }), 0);
    assert.equal(dm.rejectedGroups, 1); assert.equal(dm.dropped, 1e12);
});
test("unknown patterns and unused quantity fields cannot poison accounting", () => {
    const dm = createDanmaku({ capacity: 8 });
    assert.equal(dm.emit("charge", origin, { count: Infinity }), 0);
    assert.equal(dm.invalidGroups, 0); assert.equal(dm.rejectedGroups, 0);
    assert.equal(dm.emit("aimed", origin, { arms: Infinity, steps: NaN }), 1);
    assert.equal(dm.emit("spiral", origin, { count: Infinity, arms: 1, steps: 1 }), 1);
});
const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const skills = read("skills-rl.json"), card = read("cards-rl.json").cards.find(c => c.id === 23002001);
function world(capacity = 20) {
    const w = createWorld({ width: 30, height: 30, seed: 908, danmaku: { capacity },
        tables: { skills, stats: { statsFor: () => ({ hp: 1000, atk: 100, mgc: 100, def: 10, mdef: 10, spd: 100, luck: 0 }) } } });
    w.spawnPlayer({ card, x: 15, y: 15, level: 1 });
    w.inputState = { move: {x:0,y:0}, attack:false, dodge:false, skill:[false,false,false], ultimate:false };
    return w;
}
function fill(w, count) { return w.danmaku.emit("aimed", { x:1,y:1,angle:0 }, {count,speed:0,life:30,stepDelay:0}); }
function ticks(w, count) { for (let i=0;i<count;i++) w.update(1/60); }
test("real player skill input consumes one cooldown but never launches a partial ring", () => {
    const w=world(); fill(w,9);
    w.inputState.skill[1]=true; ticks(w,1); w.inputState.skill[1]=false;
    const shot=w.drainEvents().find(e=>e.type==='playerShot');
    assert.equal(shot.pattern,'ring'); assert.equal(shot.bullets,0);
    assert.ok(w.player.skills.slots[1].remaining>0); assert.equal(w.danmaku.active,9);
    assert.equal(w.danmaku.rejectedGroups,1); assert.equal(w.danmaku.dropped,12);
    w.danmaku.clear(); ticks(w,60); w.player.skills.slots[1].remaining=0;
    w.inputState.skill[1]=true; ticks(w,1);
    assert.equal(w.drainEvents().find(e=>e.type==='playerShot').bullets,12);
});
test("real enemy telegraph resolves a rejected group once and retains its recovery clock", () => {
    const w=world(); fill(w,17);
    const e=w.spawnEnemy({x:20,y:15,hp:1000,atk:10,def:0,mdef:0});
    e.moveset={attacks:[{id:99,coef:1,pattern:'fan'}]};e.actionTimer=0;
    ticks(w,60);
    const events=w.drainEvents();
    assert.equal(events.filter(x=>x.type==='telegraph').length,1);
    const shots=events.filter(x=>x.type==='enemySkill');assert.equal(shots.length,1);assert.equal(shots[0].bullets,0);
    assert.ok(e.actionTimer>0);assert.equal(e.pending,null);assert.equal(w.danmaku.active,17);
    w.danmaku.clear();ticks(w,180);
    assert.equal(w.drainEvents().find(x=>x.type==='enemySkill').bullets,5);
});
test("a boss phase burst is rejected whole while the phase transition still commits once", () => {
    const w=world(32);fill(w,9);
    const e=w.spawnEnemy({x:20,y:15,hp:1000,atk:10,def:0,mdef:0,aiType:'boss'});
    e.hp=600;e.actionTimer=1e9;
    ticks(w,1);
    assert.equal(e.phase,2);assert.equal(w.danmaku.active,9);assert.equal(w.danmaku.dropped,24);
    assert.equal(w.drainEvents().filter(x=>x.type==='bossPhase').length,1);
    ticks(w,1);assert.equal(w.danmaku.rejectedGroups,1);
});
console.log("Admission: " + (tests - failures) + "/" + tests + " passed");
process.exitCode = failures ? 1 : 0;
