// T30 kind 10: authored values, independent arithmetic, and real world delivery.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSkills, decodeSkill } from "../site/game/rl/skills.js";
import { createWorld } from "../site/game/rl/world.js";
import { createDanmaku } from "../site/game/rl/danmaku.js";
import { attackFrom, resolveDamage, tryHit } from "../site/game/rl/combat.js";
import { skillWords } from "../site/game/rl/ui/infocard.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const table = read("skills-rl.json"), cardData = read("cards-rl.json");
const cards = Array.isArray(cardData) ? cardData : cardData.cards;
const kotone = cards.find(c => c.id === 45002001);
const decode = id => decodeSkill(table.player[id], id, table.recastSeconds);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
let checks = 0;
function test(label, run) { run(); checks++; console.log("PASS " + label); }
const stats = { statsFor: () => ({ hp: 1000, atk: 100, mgc: 100,
    def: 10, mdef: 10, spd: 100, luck: 0 }) };
function makeWorld(extra = {}) {
    const w = createWorld({ width: 32, height: 24, seed: 300909,
        tables: { stats, skills: extra.table || table } });
    w.spawnPlayer({ card: extra.card || kotone, x: 15, y: 12, level: 1 });
    w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false,
        skill: [false, false, false], ultimate: false };
    w.player.element = 0;
    w.player.iframes = 100;
    return w;
}
function step(w, seconds) {
    for (let left = seconds; left > 1e-9; left -= 1 / 120) w.update(Math.min(left, 1 / 120));
}
function cast(w, slot = 2) {
    w.inputState.skill[slot] = true; w.update(1 / 120);
    w.inputState.skill[slot] = false; w.update(1 / 120);
    assert.ok(w.events.some(e => e.type === "skill" && e.slot === slot), "input cast accepted");
}
function foe(w, props = {}) {
    const e = w.spawnEnemy({ x: 19, y: 12, hp: 100000, atk: 1, mgc: 1,
        def: 10, mdef: 10, element: 3, luck: 0, ...props });
    e.actionTimer = 1e9; return e;
}
function addBonus(s, pct = .35, turns = 3) {
    s.applySelf(decodeSkill({ target: 0, effects: [{ kind: 10, target: 0,
        args: [1, turns, pct * 100] }] }, 123, .35));
}

test("current Kotone row decodes 35 points as +0.35, never a percent damage multiplier", () => {
    assert.deepEqual(table.player[450020002].effects[1], { kind: 10, target: 0, args: [1, 3, 35] });
    const slot = decode(450020002);
    assert.ok(!slot.unhandled.includes(10), "kind 10 is still unimplemented");
    assert.deepEqual(slot.weakBonuses, [{ target: 0, turns: 3, pct: .35 }]);
    assert.equal(slot.usable, true);
});
for (const [id, pct] of [[130020310, .15], [240020310, .25], [450020002, .35]]) {
    test("authored increment " + id, () => near(decode(id).weakBonuses[0].pct, pct));
}
for (const target of [0, 3, 4]) test("single-player target " + target, () => {
    const slot = decodeSkill({ target, effects: [{ kind: 10, target, args: [1, 3, -35] }] }, 1, .35);
    const s = createSkills({ table, card: kotone, maxHp: 1000 });
    s.applySelf(slot); near(s.weakElementBonus, .35); assert.equal(slot.usable, true);
});
for (const effect of [
    { kind: 10, target: 1, args: [1, 3, 35] }, { kind: 10, target: 9, args: [1, 3, 35] },
    { kind: 10, target: 0, args: [1, 0, 35] }, { kind: 10, target: 0, args: [1, 3, Infinity] },
    { kind: 10, target: 0, args: [1, NaN, 35] }, { kind: 10, target: 0, args: [1, 3, "35"] }
]) test("invalid or unsupported effect remains unavailable " + JSON.stringify(effect), () => {
    const slot = decodeSkill({ target: effect.target, effects: [effect] }, 1, .35);
    assert.equal(slot.usable, false); assert.ok(slot.unhandled.includes(10));
});
test("independent stacks expire independently without changing cooldown recovery", () => {
    const s = createSkills({ table, card: kotone, maxHp: 1000 });
    s.slots[1].remaining = 20; s.addGauge(101);
    addBonus(s, .35, 3); s.update(2.8); addBonus(s, .15, 1);
    near(s.weakElementBonus, .5); near(s.cooldownRate, 1);
    s.update(2.8); near(s.weakElementBonus, .35);
    s.update(2.8); near(s.weakElementBonus, 0);
    near(s.slots[1].remaining, 11.6); assert.equal(s.gauge, 101);
});
test("same real ordinary cast cannot stack through a running cooldown", () => {
    const s = createSkills({ table, card: kotone, maxHp: 1000 });
    assert.ok(s.use(2)); assert.equal(s.use(2), null); near(s.weakElementBonus, .35);
    near(s.slots[2].remaining, 14);
});
const advantage = new Map([[0, 3], [1, 0], [2, 1], [3, 2], [4, 5], [5, 4]]);
for (let a = 0; a < 6; a++) for (let d = 0; d < 6; d++) {
    test(`element pair ${a}/${d} adds only to a favourable base multiplier`, () => {
        const favourable = advantage.get(a) === d;
        const factor = favourable ? 2 : advantage.get(d) === a ? .5 : 1;
        for (const magic of [false, true]) {
            const spec = { atk: 100, mgc: 100, def: 100, mdef: 100, skill: { coef: 1, magic },
                element: a, targetElement: d, tempo: 4.15, weakElementBonus: .35 };
            assert.equal(resolveDamage(spec), Math.max(1, Math.round(415 * (factor + (favourable ? .35 : 0)) - 60)));
            assert.equal(resolveDamage({ ...spec, weakElementBonus: 0 }), Math.max(1, Math.round(415 * factor - 60)));
        }
    });
}
test("resistance and defence keep their existing order, favourable result is 429", () => {
    const spec = { atk: 100, def: 100, skill: 1, element: 0, targetElement: 3,
        tempo: 4.15, defenderResist: .2, weakElementBonus: .35 };
    assert.equal(resolveDamage(spec), 720); // crit row: 100*2.35*4.15*.8 - 60, ×1.5 crit
    assert.equal(resolveDamage({ ...spec, crit: true }), 1110);
    assert.equal(resolveDamage({ ...spec, def: 100000 }), 1);
    assert.equal(resolveDamage({ ...spec, element: { attacker: 0, defender: 3 } }), 720);
});
test("absent elements and non-finite bonuses cannot amplify or poison a hit", () => {
    for (const weakElementBonus of [undefined, NaN, Infinity, -.35, ".35"]) {
        assert.equal(resolveDamage({ atk: 100, element: 0, targetElement: 3, weakElementBonus }), 200);
    }
    assert.equal(resolveDamage({ atk: 100, weakElementBonus: .35 }), 100);
});
test("attackFrom and barriers preserve their shared damage contract", () => {
    const w = makeWorld(), e = foe(w); addBonus(w.player.skills);
    const attack = attackFrom(w.player, e, { coef: 1, magic: false }, { crit: false });
    near(attack.weakElementBonus, .35); assert.equal(resolveDamage(attack), 969);
    const s = createSkills({ table, card: kotone, maxHp: 1000 });
    s.applySelf({ barrier: { cut: 1, hits: 1 } }); e.skills = s;
    assert.equal(tryHit(e, attack).damage, 0);
    assert.equal(tryHit(e, attack).damage, 969);
});
test("normal shot carries cast-time bonus after the caster loses the effect", () => {
    const w = makeWorld(), e = foe(w); cast(w); step(w, .45);
    w.aim = { x: e.x, y: e.y }; w.events.length = 0;
    w.inputState.attack = true; w.update(1 / 120); w.inputState.attack = false;
    step(w, .2);
    let bullet; w.danmaku.forEach(b => { if (b.side === "player") bullet = b; });
    assert.ok(bullet, "normal projectile launched"); near(bullet.weakElementBonus, .35);
    assert.equal(bullet.coef, .5); assert.equal(bullet.power, 100);
    w.player.skills.clearEffects(); near(w.player.skills.weakElementBonus, 0);
    step(w, .65); assert.equal(100000 - e.hp, 482);
});
test("ordinary skill projectile snapshots bonus, target resistance is live", () => {
    const w = makeWorld(), e = foe(w); cast(w); step(w, .45);
    w.aim = { x: e.x, y: e.y }; cast(w, 1);
    let b; w.danmaku.forEach(x => { if (x.side === "player") b = x; });
    assert.ok(b); near(b.weakElementBonus, .35);
    const coef = table.player[450020001].coef;
    w.player.skills.clearEffects(); e.resists = [{ element: 0, pct: .2, remaining: 10 }];
    step(w, 1);
    assert.equal(100000 - e.hp, Math.round(100 * coef * 2.35 * 4.15 * .8 - 6));
});
test("pool reuse does not leak a previous attack's bonus to enemy or ordinary shots", () => {
    const d = createDanmaku({ capacity: 1 });
    d.emit("aimed", { x: 1, y: 1 }, { weakElementBonus: .35 });
    let before; d.forEach(b => { before = b; }); near(before.weakElementBonus, .35);
    d.clear(); d.emit("aimed", { x: 1, y: 1 }, { side: "enemy" });
    d.forEach(b => { assert.equal(b, before); assert.equal(b.weakElementBonus, 0); });
});
for (const bonusFirst of [false, true]) test("ultimate obeys original sub-effect order " + bonusFirst, () => {
    const damage = { kind: 0, target: 2, args: [1000, 1] };
    const bonus = { kind: 10, target: 0, args: [1, 3, 35] };
    const id = kotone.skillIds.chara;
    const fixture = { ...table, player: { ...table.player, [id]: { ...table.player[id],
        coef: 1, magic: true, target: 2, effects: bonusFirst ? [bonus, damage] : [damage, bonus] } } };
    const w = makeWorld({ table: fixture }), e = foe(w);
    w.player.skills.addGauge(w.player.skills.gaugeMax);
    assert.ok(w.useUltimate()); assert.equal(w.useUltimate(), false);
    assert.equal(w.player.skills.gauge, 0); near(w.player.skills.weakElementBonus, .35);
    assert.equal(100000 - e.hp, bonusFirst ? 969 : 824);
});
test("pause, room change and death obey existing temporary-state boundaries", () => {
    const w = makeWorld(); cast(w); step(w, .45);
    const before = JSON.stringify(w.player.skills.buffs), cooldown = w.player.skills.slots[2].remaining;
    w.frozen = true; step(w, 20);
    assert.equal(JSON.stringify(w.player.skills.buffs), before); near(w.player.skills.slots[2].remaining, cooldown);
    w.frozen = false; w.player.skills.addGauge(123);
    w.setDungeon({ start: 0, rooms: [{ id: 0, type: "start", seed: 1, enemies: [], doors: {} },
        { id: 1, type: "start", seed: 2, enemies: [], doors: {} }] }); w.enterRoom(1);
    near(w.player.skills.weakElementBonus, 0); near(w.player.skills.slots[2].remaining, cooldown);
    assert.equal(w.player.skills.gauge, 123);
    addBonus(w.player.skills); w.player.dead = true; w.player.sm.force("dead"); w.update(1 / 60);
    near(w.player.skills.weakElementBonus, 0); assert.equal(w.player.skills.gauge, 123);
});
test("player description distinguishes an additive favourable coefficient", () => {
    const words = skillWords(decode(450020002)).join("；");
    assert.match(words, /克制倍率\+0\.35/); assert.match(words, /2→2\.35/);
    assert.match(words, /有利属性/); assert.ok(!words.includes("未适配：克制强化"));
});
console.log(`Weak-element bonus: ${checks} checks passed.`);
