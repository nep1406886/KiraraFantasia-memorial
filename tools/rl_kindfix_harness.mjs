// T25: real table rows, independent arithmetic, and the live input/hit paths.
// Run: node tools/rl_kindfix_harness.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWorld } from "../site/game/rl/world.js";
import { createSkills, decodeSkill } from "../site/game/rl/skills.js";
import { attackFrom, resolveDamage, sumResists } from "../site/game/rl/combat.js";
import { actionInterval } from "../site/game/rl/enemyai.js";
import * as infocard from "../site/game/rl/ui/infocard.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const table = read("skills-rl.json");
const cardsData = read("cards-rl.json");
const cards = Array.isArray(cardsData) ? cardsData : cardsData.cards;
const card = id => {
    const value = cards.find(c => c.id === id);
    assert.ok(value, "real card " + id);
    return value;
};
const decode = id => decodeSkill(table.player[id], id, 0.35);
const stats = { statsFor: () => ({ hp: 1000, atk: 100, mgc: 100,
    def: 10, mdef: 10, spd: 100, luck: 0 }) };
let checks = 0;
let failures = 0;
function test(label, run) {
    checks++;
    try { run(); console.log("PASS " + label); }
    catch (error) { failures++; console.error("FAIL " + label + ": " + error.message); }
}
function near(actual, expected) {
    assert.ok(Math.abs(actual - expected) < 1e-7, actual + " != " + expected);
}
function makeWorld(id = 15000000) {
    const w = createWorld({ width: 30, height: 30, seed: 20260907,
        tables: { stats, skills: table } });
    w.spawnPlayer({ card: card(id), x: 15, y: 15, level: 1 });
    w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false,
        skill: [false, false, false], ultimate: false };
    return w;
}
function ticks(w, n) { for (let i = 0; i < n; i++) w.update(1 / 60); }
function step(w, seconds, dt = 1 / 60) {
    const until = w.time + seconds;
    for (let i = 0; w.time + 1e-9 < until && i < 20000; i++) {
        w.update(Math.min(dt, until - w.time));
    }
    near(w.time, until);
}
function cast(w, slot, settle = true) {
    const ultimate = w.player.skills.slots[slot].ultimate;
    if (ultimate) w.player.skills.addGauge(w.player.skills.gaugeMax);
    w.inputState.skill[slot] = true;
    ticks(w, 1);
    w.inputState.skill[slot] = false;
    if (ultimate) {
        assert.ok(w.events.some(e => e.type === "ultimate" && e.ready), "legacy key requests ultimate");
        assert.equal(w.useUltimate().id, w.player.skills.ultimate.id, "original ultimate accepted");
        assert.equal(w.player.skills.slots[slot].remaining, 0, "ultimate never starts a cooldown");
    } else {
        assert.ok(w.player.skills.slots[slot].remaining > 0, "cast entered cooldown");
    }
    if (settle) step(w, 0.6);
}
function swing(w) {
    w.inputState.attack = true;
    ticks(w, 1);
    w.inputState.attack = false;
    step(w, 0.65);
}
function foe(w, options = {}) {
    const e = w.spawnEnemy(Object.assign({ x: 18, y: 15, hp: 100000,
        atk: 100, mgc: 100, def: 0, mdef: 0, luck: 0 }, options));
    e.actionTimer = 1e9;
    return e;
}
function bullet(w, target, element, enemy = false, extra = {}) {
    const source = enemy ? w.enemies[0] : w.player;
    const before = target.hp;
    w.danmaku.emit("aimed", { x: source.x, y: source.y,
        angle: Math.atan2(target.y - source.y, target.x - source.x) },
    Object.assign({ side: enemy ? "enemy" : "player", power: 100, coef: 1,
        magic: false, count: 1, speed: 10, life: 4, element, srcId: source.id,
        critChance: 0 }, extra));
    step(w, 0.55);
    return before - target.hp;
}
function roomChange(w) {
    w.setDungeon({ start: 0, rooms: [
        { id: 0, type: "start", seed: 1, enemies: [], doors: {} },
        { id: 1, type: "start", seed: 2, enemies: [], doors: {} }
    ] });
    w.enterRoom(1);
}

test("literal decoding: +20% defence, -20% sun resistance, +60% next attack", () => {
    near(decode(100000002).buff.def, 0.2);
    near(decode(140110002).resists.by[5], -0.2);
    near(decode(100020102).nextAtk, 0.6);
    near(decode(100000102).slow.pct, 0.4);
});
test("speed is a duration multiplier; regeneration [3,27] lasts three turns", () => {
    near(decode(230010002).buff.spd, 1 / 0.7 - 1);
    assert.equal(decode(100020002).regen.turns, 3);
    near(decode(100020002).regen.pct, 0.27);
});
test("real +20% buff gives 1.2, expires at 8.4 seconds", () => {
    const s = createSkills({ table, card: card(10000000), maxHp: 1000 });
    s.use(2); near(s.statMult("def"), 1.2);
    s.update(8.39); near(s.statMult("def"), 1.2);
    s.update(0.02); near(s.statMult("def"), 1);
});
test("enemy attack reduction changes the enemy, never the caster", () => {
    const w = makeWorld(19000000), e = foe(w);
    cast(w, 0);
    near(w.player.atk, 100);
    near(attackFrom(e, w.player, { coef: 1 }, { crit: false }).atk, 90);
    step(w, 8.5);
    near(attackFrom(e, w.player, { coef: 1 }, { crit: false }).atk, 100);
});
test("enemy projectiles snapshot the debuffed attack when emitted", () => {
    const w = makeWorld(19000000), e = foe(w);
    w.player.element = undefined;
    cast(w, 0);
    e.moveset = { attacks: [{ id: 1, coef: 1, magic: false, pattern: "aimed" }] };
    e.actionTimer = 0;
    step(w, 2);
    assert.equal(1000 - w.player.hp, 84); // 90 attack - 10 defence*.6
});
test("multiple stat effects keep their own targets and values", () => {
    const w = makeWorld(37002000), e = foe(w);
    cast(w, 2);
    near(w.player.atk, 100); near(w.player.mgc, 100);
    const a = attackFrom(e, w.player, { coef: 1 }, { crit: false });
    near(a.atk, 85); near(a.mgc, 85);
    near(actionInterval(e), 9.8); // 2.8 * 0.7 / (1 - 0.8)
});
test("self abnormal effects are not transferred onto enemies", () => {
    const w = makeWorld(32172000), e = foe(w);
    cast(w, 1);
    assert.ok(e.hp < 100000, "ring actually hit");
    assert.ok(!e.slow, "self-only abnormal must not slow a foe");
    assert.ok(decode(321720001).unhandled.includes(4));
});
test("damage-borne resistance affects subsequent hits of its element only", () => {
    const w = makeWorld(14011000), e = foe(w);
    cast(w, 2);
    assert.equal(100000 - e.hp, 234); // 100 * 0.9 * 2.6, before the debuff
    near(sumResists(e, 5), -0.2);
    assert.equal(bullet(w, e, 5), 312);
    assert.equal(bullet(w, e, 0), 260);
    step(w, 8.5);
    near(sumResists(e, 5), 0);
    assert.equal(bullet(w, e, 5), 260);
});
test("self resistance reduces only matching incoming damage", () => {
    const w = makeWorld(10001000), e = foe(w);
    w.player.element = undefined; // isolate resistance from the element ring
    cast(w, 2);
    near(w.player.skills.resistFor(2), 0.2);
    assert.equal(bullet(w, w.player, 2, true), 74); // 100*.8 - 10*.6
    step(w, 0.65);
    assert.equal(bullet(w, w.player, 0, true), 94);
});
test("self resistance re-casting refreshes its duration without stacking", () => {
    const s = createSkills({ table, card: card(10001000), maxHp: 1000 });
    assert.ok(s.use(2));
    s.update(2.8);
    s.slots[2].remaining = 0;
    assert.ok(s.use(2));
    near(s.resistFor(2), 0.2);
    s.update(8.39); near(s.resistFor(2), 0.2);
    s.update(0.02); near(s.resistFor(2), 0);
});
test("self resistance keeps the stronger sign and independent opposite expiry", () => {
    // Vary only resistance strength/duration on a decoded real self-target row.
    for (const values of [
        [[0.2, 3], [-0.1, 1], [0.1, 1]],
        [[-0.1, 1], [0.1, 1], [0.2, 3]]
    ]) {
        const s = createSkills({ table, card: card(10001000), maxHp: 1000 });
        for (const [pct, turns] of values) {
            const slot = decode(100010002);
            slot.resists = { target: 0, turns, by: { 2: pct } };
            s.slots[2] = slot;
            assert.ok(s.use(2));
        }
        near(s.resistFor(2), 0.1);
        near(s.resistFor(0), 0);
        s.update(2.81); near(s.resistFor(2), 0.2);
        s.update(5.6); near(s.resistFor(2), 0);
    }
});
test("direct vulnerability chooses nearest live enemy and expires during stun", () => {
    const w = makeWorld(19000000), e = foe(w), far = foe(w, { x: 22 });
    cast(w, 2);
    near(sumResists(e, 1), -0.1); near(sumResists(far, 1), 0);
    assert.equal(bullet(w, e, 1), 286);
    e.stunTimer = 20;
    step(w, 8.5);
    near(sumResists(e, 1), 0);
});
for (const [rank, options, expected] of [
    ["normal", {}, 0.4], ["elite", { aiType: "boss", elite: true }, 0.22],
    ["boss", { aiType: "boss" }, 0.12]
]) test("non-damaging slow: " + rank + " rank", () => {
    const w = makeWorld(10000010), e = foe(w, options);
    const interval = actionInterval(e);
    cast(w, 2);
    assert.equal(e.hp, 100000);
    near(e.slow.pct, expected);
    near(actionInterval(e), interval / (1 - expected));
});
test("damaging slow travels on the bullet and expires while stunned", () => {
    const w = makeWorld(20002010), e = foe(w);
    cast(w, 2);
    assert.ok(e.hp < 100000);
    near(e.slow.pct, 0.8); // 100% original poison chance, capped by the slow adapter
    e.stunTimer = 20;
    step(w, 5.7);
    assert.ok(!e.slow);
});
test("same-sign resistance refresh and opposite signs are order independent", () => {
    function run(values) {
        const w = makeWorld(), e = foe(w);
        for (const pct of values) bullet(w, e, 0, false,
            { resistEffect: { by: { 5: pct }, seconds: 8.4 } });
        return sumResists(e, 5);
    }
    near(run([0.2, -0.2]), 0); near(run([-0.2, 0.2]), 0);
    near(run([-0.2, -0.1]), -0.2); near(run([-0.1, -0.2]), -0.2);
});
test("resistance total is capped in both directions", () => {
    near(sumResists({ resists: [{ element: 5, pct: 2 }] }, 5), 0.8);
    near(sumResists({ resists: [{ element: 5, pct: -2 }] }, 5), -0.8);
});
test("warrior: one +35% swing boosts both targets; the next swing is normal", () => {
    const w = makeWorld(), a = foe(w, { x: 16.3 }), b = foe(w, { x: 16.3, y: 15.3 });
    cast(w, 2); swing(w);
    assert.equal(100000 - a.hp, 176); assert.equal(100000 - b.hp, 176);
    near(w.player.nextAtkBonus, 0);
    a.x = b.x = 16.3; a.y = 15; b.y = 15.3; a.kx = a.ky = b.kx = b.ky = 0;
    swing(w);
    assert.equal(100000 - a.hp, 306); assert.equal(100000 - b.hp, 306);
});
test("whiff, skill bullets and ultimate gauge spending preserve next attack", () => {
    const w = makeWorld(); cast(w, 2); swing(w);
    near(w.player.nextAtkBonus, 0.35);
    foe(w); cast(w, 1); near(w.player.nextAtkBonus, 0.35);
    w.player.skills.addGauge(1400);
    assert.equal(w.useUltimate().id, 150000000); near(w.player.nextAtkBonus, 0.35);
});
test("an invulnerable target cannot consume the next successful attack", () => {
    const w = makeWorld(), e = foe(w, { x: 16.3 });
    e.iframes = 10;
    cast(w, 2); swing(w);
    assert.equal(e.hp, 100000); near(w.player.nextAtkBonus, 0.35);
});
test("next attack and critical damage multiply without a second consumption", () => {
    const w = makeWorld(), e = foe(w, { x: 16.3 });
    w.player.critBonus = 1;
    cast(w, 2); swing(w);
    assert.equal(100000 - e.hp, 263); // round(100*.5*2.6*1.35*1.5)
    near(w.player.nextAtkBonus, 0);
});
test("mage: original ultimate hits beyond normal projectile reach and shortens later cooldowns", () => {
    // The mage now has a ten-unit normal projectile, not a melee swing.
    const w = makeWorld(23001000), e = foe(w, { x: 27 });
    swing(w); assert.equal(e.hp, 100000);
    // RecastChange shortens cooldown that already exists, so skill 1 must be
    // cast before the ultimate applies its ordered RecastChange sub-effect.
    cast(w, 1);
    const beforeRecast = w.player.skills.slots[1].remaining;
    cast(w, 0, false);
    const afterRecast = w.player.skills.slots[1].remaining;
    step(w, 1); assert.ok(e.hp < 100000);
    near(beforeRecast, 10.6); // 11.2 less the return-to-idle settle
    near(beforeRecast - afterRecast, 3.85 + 1 / 60); // RecastChange plus the ultimate request tick
});
test("a full bullet pool consumes cooldown safely; recycled bullets lose old effects", () => {
    const w = makeWorld(23001000), e = foe(w);
    const count = w.danmaku.capacity;
    const made = w.danmaku.emit("ring", { x: 15, y: 15, angle: 0 }, {
        side: "player", count, power: 1, coef: 1, speed: 0.1, life: 10,
        slow: 0.5, slowSeconds: 5.6,
        resistEffect: { by: { 5: -0.2 }, seconds: 8.4 },
        statEffects: [{ index: 0, buff: { target: 1, turns: 3, atk: -0.2 } }]
    });
    assert.equal(made, count);
    cast(w, 1, false);
    const castEvent = w.drainEvents().find(event => event.type === "playerShot");
    assert.ok(castEvent && castEvent.bullets === 0, "no allocation past capacity");
    w.danmaku.clear(); step(w, 0.6);
    assert.equal(bullet(w, e, 0), 260);
    assert.ok(!e.slow && !e.resists?.length && !e.debuffs?.length,
        "fresh ordinary bullet must not inherit recycled payloads");
});
test("cleric: healing and magic defence have independent, bounded effects", () => {
    const w = makeWorld(20000000);
    w.player.hp = 500; cast(w, 1); assert.equal(w.player.hp, 770);
    cast(w, 2); near(w.player.mdef, 12);
    const hp = w.player.hp, buffs = JSON.stringify(w.player.skills.buffs);
    w.frozen = true; ticks(w, 600);
    assert.equal(w.player.hp, hp); assert.equal(JSON.stringify(w.player.skills.buffs), buffs);
    w.frozen = false;
    step(w, 9); w.player.hp = 950; cast(w, 1); assert.equal(w.player.hp, 1000);
    step(w, 7); cast(w, 1); assert.equal(w.player.hp, 1000);
});
test("knight: i-frames preserve the shield; one zero-damage block spends it", () => {
    const w = makeWorld(29001000); foe(w); w.player.element = undefined;
    cast(w, 0); w.player.iframes = 1;
    assert.equal(bullet(w, w.player, 0, true), 0);
    assert.equal(w.player.skills.barrier.hits, 1);
    step(w, 1); assert.equal(bullet(w, w.player, 0, true), 0);
    assert.equal(w.player.skills.barrier, null);
    step(w, 1); assert.equal(bullet(w, w.player, 0, true), 94);
});
test("regeneration has three discrete 27% ticks, independent of frame size", () => {
    for (const dt of [1 / 60, 1 / 30, 0.25]) {
        const w = makeWorld(10002000); w.player.hp = 100;
        cast(w, 2, false); assert.equal(w.player.hp, 100);
        step(w, 2.79, dt); assert.equal(w.player.hp, 100);
        step(w, 0.02, dt); assert.equal(w.player.hp, 370);
        step(w, 5.6, dt); assert.equal(w.player.hp, 910);
        assert.equal(w.player.regen, null);
        assert.equal(w.drainEvents().filter(e => e.type === "heal").length, 3);
    }
});
test("regeneration pauses and re-casting replaces its schedule", () => {
    const w = makeWorld(10002000); w.player.hp = 100;
    cast(w, 2, false); step(w, 1.4);
    const before = JSON.stringify(w.player.regen);
    w.frozen = true; ticks(w, 600);
    assert.equal(JSON.stringify(w.player.regen), before);
    assert.equal(w.player.hp, 100);
    w.frozen = false;
    // A fixture cooldown reset isolates refresh from other recast effects.
    w.player.skills.slots[2].remaining = 0;
    cast(w, 2, false); step(w, 1.5);
    assert.equal(w.player.hp, 100, "old schedule was replaced");
    step(w, 1.31); assert.equal(w.player.hp, 370, "one tick, never two stacked copies");
});
test("regeneration never removes existing over-heal or exceeds normal maximum HP", () => {
    const w = makeWorld(10002000);
    w.player.hp = 1100;
    cast(w, 2, false); step(w, 2.81);
    assert.equal(w.player.hp, 1100, "regeneration must not remove existing HP");
    w.player.hp = 950;
    step(w, 2.8);
    assert.equal(w.player.hp, 1000, "recovery ticks stop at ordinary maximum HP");
});
test("room change clears temporary effects but retains cooldown and gauge", () => {
    const w = makeWorld(29001000); cast(w, 0);
    w.player.skills.slots[1] = decode(100000002); cast(w, 1);
    w.player.skills.addGauge(700);
    const remaining = w.player.skills.slots[1].remaining;
    roomChange(w);
    assert.equal(w.player.skills.barrier, null);
    assert.equal(w.player.skills.buffs.length, 0);
    near(w.player.def, 10);
    near(w.player.skills.slots[1].remaining, remaining);
    near(w.player.skills.gauge, 700);
});
test("death clears regeneration and can never heal a dead actor", () => {
    const w = makeWorld(10002000); foe(w); w.player.hp = 100;
    cast(w, 2);
    bullet(w, w.player, 0, true, { power: 100000 });
    assert.ok(w.player.dead);
    step(w, 10);
    assert.equal(w.player.hp, 0); assert.equal(w.player.regen, null);
    assert.equal(w.player.skills.buffs.length, 0);
});
test("a fatal charger lunge clears effects before the page freezes the death frame", () => {
    const w = makeWorld(10002000), e = foe(w, { aiType: "charger", atk: 10000 });
    w.player.hp = 100;
    cast(w, 2);
    e.moveset = { attacks: [{ id: 1, coef: 1, magic: false, pattern: "charge" }] };
    e.actionTimer = 0;
    for (let i = 0; i < 240 && !w.player.dead; i++) ticks(w, 1);
    assert.ok(w.player.dead, "real charger AI landed a fatal lunge");
    assert.equal(w.player.regen, null, "cleanup completes in the fatal frame");
});
test("skill chips state actual percentages and disclose unsupported effects", () => {
    assert.ok(infocard.skillWords(decode(140110002)).some(s => s.includes("-20%")));
    assert.ok(infocard.skillWords(decode(150000002)).some(s => s.includes("35%")));
    assert.ok(infocard.skillWords(decode(100020002)).some(s => s.includes("27%") && s.includes("3")));
    assert.ok(infocard.skillWords(decode(321720001)).some(s => s.includes("未适配")));
});

console.log("T25: " + (checks - failures) + "/" + checks + " passed");
process.exitCode = failures ? 1 : 0;
