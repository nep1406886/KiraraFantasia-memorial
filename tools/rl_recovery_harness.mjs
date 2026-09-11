// T30: exact cooldown arithmetic, real source rows, input and time boundaries.
// node tools/rl_recovery_harness.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSkills, decodeSkill } from "../site/game/rl/skills.js";
import { createWorld } from "../site/game/rl/world.js";
import { skillWords } from "../site/game/rl/ui/infocard.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const cards = read("cards-rl.json").cards, table = read("skills-rl.json");
const card = id => { const row = cards.find(row => row.id === id); assert.ok(row); return row; };
const fresh = (id = 15002001) => createSkills({ table, card: card(id), maxHp: 1000 });
const decode = id => decodeSkill(table.player[id], id, table.recastSeconds);
const speed = (ratio, turns = 3, target = 0) => decodeSkill({ target,
    effects: [{ kind: 2, target, args: [1, turns, 0, 0, 0, 0, ratio, 0] }] }, 1, .35);
const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) < epsilon,
    String(actual) + " != " + expected);
let checks = 0, failures = 0;
function test(name, run) { checks++; try { run(); console.log("PASS " + name); }
    catch (error) { failures++; console.error("FAIL " + name + ": " + error.message); } }
function world(id = 36002001) {
    const stats = { statsFor: () => ({ hp: 1000, atk: 100, mgc: 100, def: 10, mdef: 10, spd: 100, luck: 0 }) };
    const w = createWorld({ width: 100, height: 100, seed: 20260908, tables: { stats, skills: table } });
    w.spawnPlayer({ card: card(id), level: 1, x: 50, y: 50 });
    w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false, ultimate: false, skill: [false, false, false] };
    return w;
}
function step(w, seconds, dt = 1 / 60) {
    let left = seconds;
    while (left > 1e-10) { const span = Math.min(left, dt); w.update(span); left -= span; }
}

test("Harumi's authored second skill is usable, not an empty charged slot", () => {
    const s = fresh(36002001);
    assert.equal(s.ready(2), true);
    assert.equal(s.use(2).id, 360020002);
    near(s.slots[2].remaining, 8.75);
    near(s.cooldownRate, 23 / 17);
    assert.deepEqual(s.slots[2].unhandled, [5], "unsupported cleansing stays disclosed");
});
for (const [id, ratio] of [[320220002, .85], [410020001, .7], [230020010, .62]]) {
    test("true-table speed ratio " + ratio, () => {
        const s = fresh(); s.applySelf(decode(id));
        near(s.cooldownRate, 1 / ratio);
        s.slots[1].remaining = 10; s.update(1);
        near(s.slots[1].remaining, 10 - 1 / ratio);
        near(s.buffs.find(buff => buff.spd).remaining, 7.4);
    });
}
for (const target of [0, 3, 4]) test("self and ally target " + target + " recover player skills", () => {
    const s = fresh(); s.applySelf(speed(.5, 3, target)); near(s.cooldownRate, 2);
});
for (const target of [1, 2]) test("enemy target " + target + " cannot accelerate the player", () => {
    const s = fresh(); s.applySelf(speed(.5, 3, target)); near(s.cooldownRate, 1);
});
test("unbuffed cooldowns retain ordinary seconds", () => {
    const s = fresh(); s.slots[1].remaining = 10;
    near(s.cooldownRate, 1); near(s.cooldownSeconds(1), 10); s.update(2.5); near(s.slots[1].remaining, 7.5);
});
test("positive stacking is capped at two times, never instant", () => {
    const s = fresh(); s.applySelf(speed(.1)); s.applySelf(speed(.1));
    near(s.cooldownRate, 2); s.slots[1].remaining = 10; s.update(1); near(s.slots[1].remaining, 8);
});
test("negative speed is bounded at half recovery", () => {
    const s = fresh(); s.applySelf(speed(10)); s.applySelf(speed(10));
    near(s.cooldownRate, .5); s.slots[1].remaining = 2; near(s.cooldownSeconds(1), 4);
    s.update(1); near(s.slots[1].remaining, 1.5);
});
test("opposite speed changes add rather than multiply", () => {
    const s = fresh(); s.applySelf(speed(.5)); s.applySelf(speed(2)); near(s.cooldownRate, 1.5);
});
test("expired speed entries have no effect even before cleanup", () => {
    const s = fresh(); s.buffs.push({ spd: 5, remaining: 0 }); near(s.cooldownRate, 1);
    s.slots[1].remaining = 3; near(s.cooldownSeconds(1), 3);
});
test("large dt integrates only the live part of a speed buff", () => {
    const s = fresh(); s.slots[1].remaining = 20; s.applySelf(speed(.5, 1));
    near(s.cooldownSeconds(1), 17.2); s.update(10);
    near(s.slots[1].remaining, 7.2); near(s.cooldownRate, 1); near(s.cooldownSeconds(1), 7.2);
});
test("separate expiry boundaries are integrated independently", () => {
    const s = fresh(); s.buffs.push({ spd: .5, remaining: 2 }, { spd: .25, remaining: 4 });
    s.slots[1].remaining = 15; near(s.cooldownSeconds(1), 13); s.update(6); near(s.slots[1].remaining, 7);
});
test("split dt and one large dt produce the same work and expiry", () => {
    const a = fresh(), b = fresh();
    for (const s of [a, b]) { s.slots[1].remaining = 20; s.applySelf(speed(.5, 1)); }
    a.update(10); for (let i = 0; i < 100; i++) b.update(.1);
    near(a.slots[1].remaining, 7.2); near(b.slots[1].remaining, 7.2);
    assert.equal(a.buffs.length, 0); assert.equal(b.buffs.length, 0);
});
test("prediction is read-only and reaches exact readiness across expiry", () => {
    const s = fresh(); s.applySelf(speed(.5, 1)); s.slots[1].remaining = 20;
    const before = JSON.stringify([s.slots, s.buffs]); const seconds = s.cooldownSeconds(1);
    assert.equal(JSON.stringify([s.slots, s.buffs]), before); near(seconds, 17.2);
    s.update(seconds); assert.equal(s.ready(1), true); assert.equal(s.slots[1].remaining, 0);
    near(s.cooldownSeconds(-1), 0); near(s.cooldownSeconds(0), 0);
});
test("kind 14 changes current work once; speed only changes subsequent recovery", () => {
    const immediate = decodeSkill({ effects: [{kind:14,target:0,args:[-.35]}] }, 1, .35);
    const s = fresh(); s.applySelf(immediate); s.applySelf(speed(.5, 10)); s.use(1);
    near(s.slots[1].remaining, 16.8); // no stored discount from an earlier effect
    s.applySelf(immediate); // 48 authored recast units: trunc(48*.35)=16 -> 5.6s
    near(s.slots[1].remaining, 11.2); near(s.cooldownSeconds(1), 5.6);
    s.update(1); near(s.slots[1].remaining, 9.2);
});
test("a speed skill accelerates its own just-started cooldown", () => {
    const s = fresh(36002001); s.use(2);
    near(s.cooldownSeconds(2), 8.75 * 17 / 23); s.update(1);
    near(s.slots[2].remaining, 8.75 - 23 / 17);
});
test("clearEffects removes speed but preserves work and gauge", () => {
    const s = fresh(); s.applySelf(speed(.5)); s.slots[1].remaining = 8; s.addGauge(345);
    s.clearEffects(); near(s.cooldownRate, 1); near(s.slots[1].remaining, 8); near(s.gauge, 345);
});
test("invalid or nonpositive dt cannot corrupt timers", () => {
    const s = fresh(); s.applySelf(speed(.5)); s.slots[1].remaining = 8;
    const before = JSON.stringify([s.slots, s.buffs]);
    for (const dt of [0, -1, NaN, Infinity]) s.update(dt);
    assert.equal(JSON.stringify([s.slots, s.buffs]), before);
});
test("normal input accepts Harumi's skill exactly once while held", () => {
    const w = world(); w.inputState.skill[2] = true; step(w, .5);
    assert.equal(w.events.filter(event => event.type === "skill" && event.skill.id === 360020002).length, 1);
    near(w.player.skills.cooldownRate, 23 / 17); assert.ok(w.player.skills.slots[2].remaining > 0);
});
test("pause stops both work and duration without retroactive catch-up", () => {
    const w = world(); w.player.skills.applySelf(speed(.5)); w.player.skills.slots[1].remaining = 10;
    const before = JSON.stringify([w.player.skills.slots, w.player.skills.buffs]);
    w.frozen = true; step(w, 2); assert.equal(JSON.stringify([w.player.skills.slots, w.player.skills.buffs]), before);
    w.frozen = false; step(w, 1); near(w.player.skills.slots[1].remaining, 8);
});
test("room change and death remove speed without clearing cooldowns", () => {
    const w = world(); w.player.skills.applySelf(speed(.5)); w.player.skills.slots[1].remaining = 8;
    w.setDungeon({ start: 1, rooms: [{ id: 1, type: "start", seed: 1, enemies: [] }] });
    near(w.player.skills.cooldownRate, 1); near(w.player.skills.slots[1].remaining, 8);
    w.player.skills.applySelf(speed(.5)); w.player.hp = 0; w.player.dead = true; w.player.sm.force("dead");
    w.update(1 / 60); near(w.player.skills.cooldownRate, 1);
});
test("movement distance remains 3.5 units per second", () => {
    const w = world(); w.player.skills.applySelf(speed(.5)); w.inputState.move.x = 1;
    step(w, 1); near(w.player.x, 53.5); near(w.player.y, 50); near(w.player.speed, 3.5);
});
test("dodge distance and invulnerability are unchanged", () => {
    const a = world(), b = world(); b.player.skills.applySelf(speed(.5));
    for (const w of [a, b]) { w.inputState.move.x = 1; w.inputState.dodge = true; step(w, .3); }
    near(a.player.x, b.player.x); near(a.player.iframes, b.player.iframes); near(b.player.iframes, 1 / 15);
});
test("basic attack frequency is unchanged over sixty simulated seconds", () => {
    const a = world(), b = world(); b.player.skills.applySelf(speed(.5, 100));
    for (const w of [a, b]) { w.inputState.attack = true; step(w, 60); }
    const swings = w => w.events.filter(event => event.type === "swing").length;
    assert.ok(swings(a) > 100); assert.equal(swings(a), swings(b));
});
test("speed increases real-input ordinary casts per minute", () => {
    const count = accelerated => {
        const w = world(15002001); if (accelerated) w.player.skills.applySelf(speed(.5, 100));
        for (let tick = 0; tick < 3600; tick++) { w.inputState.skill[1] = tick % 2 === 0; w.update(1 / 60); }
        return w.events.filter(event => event.type === "skill").length;
    };
    assert.equal(count(false), 4); assert.equal(count(true), 8);
});
test("Rin's original ultimate speed reaches the same cooldown owner once", () => {
    const w = world(23002001); const p = w.player;
    w.spawnEnemy({ x: 60, y: 50, hp: 100000, def: 10, mdef: 10 }).actionTimer = 1e9;
    p.skills.addGauge(p.skills.gaugeMax); assert.ok(w.useUltimate());
    near(p.skills.cooldownRate, 1 / .62); near(p.skills.gauge, 0);
    assert.equal(w.useUltimate(), false); assert.equal(p.skills.buffs.filter(buff => buff.spd).length, 1);
});
test("skill chips describe recovery, limits and unchanged movement", () => {
    const words = skillWords(decode(360020002)).join("；");
    assert.ok(words.includes("技能恢复速度")); assert.ok(words.includes("0.5–2倍"));
    assert.ok(words.includes("不改变移动")); assert.ok(words.includes("异常解除"));
    assert.equal(words.includes("自身行动速度：未适配"), false);
});
console.log("Recovery: " + (checks - failures) + "/" + checks + " checks passed.");
if (failures) process.exit(1);
