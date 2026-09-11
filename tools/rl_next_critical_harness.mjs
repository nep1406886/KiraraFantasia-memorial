// T30 kind 12: authored passive entry, explicit action commitment and crit damage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSkills, decodeSkill, enemyMoveset } from "../site/game/rl/skills.js";
import { createWorld } from "../site/game/rl/world.js";
import { createDanmaku } from "../site/game/rl/danmaku.js";
import { attackFrom, resolveDamage, tryHit, rollCrit } from "../site/game/rl/combat.js";
import { skillWords } from "../site/game/rl/ui/infocard.js";
import { setAffixTable, affixTableFromPassives } from "../site/game/rl/equipment.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const shipped = read("skills-rl.json"), weapons = read("weapons-rl.json"), data = read("cards-rl.json");
const table = { ...shipped, weaponChildren: weapons.childSkills };
const cards = Array.isArray(data) ? data : data.cards;
const karen = cards.find(card => card.id === 14002001);
const decode = id => decodeSkill(table.player[id] || table.weaponChildren[id], id, .35, table.skillCards);
let checks = 0;
function test(label, run) { run(); checks++; console.log("PASS " + label); }
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-7, a + " != " + b); }

test("real weapon replacement 320320013 no longer drops its guaranteed-critical effect", () => {
    assert.deepEqual(weapons.childSkills[320320013].effects[1], { kind: 12, target: 3, args: [] });
    const slot = decode(320320013);
    assert.ok(!slot.unhandled.includes(12), "320320013 still cannot grant the next guaranteed critical");
    assert.deepEqual(slot.nextCriticals, [{ target: 3, index: 1 }]);
    near(slot.cooldown, 11.2); near(slot.nextAtk, .35); near(slot.recastMod, -.35);
});
// Import after the authored red test, so a missing module is not mistaken for evidence.
const { decodeNextCritical, grantNextCritical, consumeNextCritical, clearNextCritical } =
    await import("../site/game/rl/nextcritical.js");
setAffixTable(affixTableFromPassives(weapons.passives));
const stats = { statsFor: () => ({ hp: 1000, atk: 100, mgc: 100, def: 100, mdef: 100, spd: 100, luck: 0 }) };
const stepSize = 1 / 120;
const grant = (target = 0) => ({ kind: 12, target, args: [] });
const damage = (target = 1, magic = false, coef = 1000) => ({ kind: 0, target, args: [coef, +magic] });
function makeWorld(extra = {}) {
    const w = createWorld({ width: 32, height: 24, seed: 300913,
        tables: { stats, skills: extra.table || table } });
    w.spawnPlayer({ card: extra.card || karen, x: 15, y: 12, level: 1 });
    w.inputState = { move: { x: 0, y: 0 }, attack: false, dodge: false,
        skill: [false, false, false], ultimate: false };
    w.rng = () => .99;
    return w;
}
function step(w, seconds) {
    for (let left = seconds; left > 1e-9; left -= stepSize) w.update(Math.min(left, stepSize));
}
function cast(w, index = 2) {
    w.inputState.skill[index] = true; w.update(stepSize);
    w.inputState.skill[index] = false; w.update(stepSize);
}
function swing(w, wait = .18) {
    w.inputState.attack = true; w.update(stepSize); w.inputState.attack = false;
    step(w, wait);
}
function foe(w, extra = {}) {
    const e = w.spawnEnemy({ x: 19, y: 12, hp: 100000, atk: 100, mgc: 100,
        def: 100, mdef: 100, luck: 0, element: w.player.element, ...extra });
    e.actionTimer = 1e9;
    return e;
}
function equip(w, affix = 32032001) {
    const p = w.player, item = { slot: "armor", rarity: "rare", affixes: affix ? [affix] : [] };
    const before = JSON.stringify([p.equipment, p.nextCritical, p.skills.slots.map(s => s.id)]);
    assert.ok(w.previewEquipment(item));
    assert.equal(JSON.stringify([p.equipment, p.nextCritical, p.skills.slots.map(s => s.id)]), before);
    const drop = { x: p.x, y: p.y, items: [item] }; w.drops.push(drop);
    assert.ok(w.takeDrop(drop, item));
    return item;
}
function arm(w) {
    equip(w); cast(w); assert.equal(w.player.nextCritical, true); step(w, .45);
}
function fixture(effects, ultimate = false, card = karen) {
    const id = ultimate ? card.skillIds.chara : card.skillIds.class[0];
    const hit = effects.find(e => e.kind === 0);
    const row = { name: "critical fixture", target: hit ? hit.target : effects[0].target,
        coef: hit ? hit.args[0] / 1000 : 0, magic: !!hit?.args[1], recasts: [28], effects };
    return { ...table, player: { ...table.player, [id]: row } };
}
function hits(w) { return w.events.filter(e => e.type === "hit" && e.target.kind !== "player"); }
function bullets(w) { const result = []; w.danmaku.forEach(b => result.push(b)); return result; }
function used(w) { return w.events.filter(e => e.type === "nextCritical" && e.action === "used"); }

for (const target of [0, 3, 4]) test("strict empty-argument ally target " + target, () => {
    const effect = grant(target), s = decodeSkill({ target, effects: [effect] }, 9, .35);
    assert.equal(s.usable, true); assert.deepEqual(s.nextCriticals, [{ target, index: 0 }]);
    assert.deepEqual(s.unhandled, []); assert.ok(Object.isFrozen(s.nextCriticals[0]));
    effect.target = 1; assert.equal(s.nextCriticals[0].target, target);
});
for (const bad of [
    { target: 1 }, { target: 2 }, { target: 5 }, { target: -1 }, { target: "0" },
    { target: null }, { args: undefined }, { args: null }, { args: {} }, { args: "" },
    { args: [0] }, { args: [1] }, { args: [NaN] }, { args: Array(1) }
]) test("unknown critical format remains unsupported: " + JSON.stringify(bad), () => {
    const effect = { ...grant(), ...bad };
    const s = decodeSkill({ target: effect.target, effects: [effect] }, 9, .35);
    assert.equal(decodeNextCritical(effect), null); assert.deepEqual(s.nextCriticals, []);
    assert.equal(s.usable, false); assert.ok(s.unhandled.includes(12));
});
test("pending state refreshes without stacking or sharing a buff container", () => {
    const p = { kind: "player", hp: 100, nextAtkBonus: .35, buffs: [{ atk: .2, remaining: 4 }] };
    const unchanged = JSON.stringify([p.hp, p.nextAtkBonus, p.buffs]);
    assert.equal(grantNextCritical(p), "ready"); assert.equal(grantNextCritical(p), "refreshed");
    assert.equal(consumeNextCritical(p), true); assert.equal(consumeNextCritical(p), false);
    grantNextCritical(p); clearNextCritical(p); assert.equal(p.nextCritical, false);
    assert.equal(JSON.stringify([p.hp, p.nextAtkBonus, p.buffs]), unchanged);
    for (const target of [null, { kind: "enemy" }, { kind: "player", dead: true }]) {
        assert.equal(grantNextCritical(target), null); assert.equal(consumeNextCritical(target), false);
    }
});
test("forced crit returns before randomness, probability and resisted-element rules", () => {
    let rolls = 0; const rng = () => { rolls++; return .99; };
    for (const chance of [0, .2, 1]) assert.equal(rollCrit(chance, rng, true), true);
    assert.equal(rolls, 0);
    assert.equal(rollCrit(0, rng), false); assert.equal(rolls, 0);
    assert.equal(rollCrit(.5, rng, false), false); assert.equal(rolls, 1);
    assert.equal(rollCrit(1, rng), true); assert.equal(rolls, 2);
    assert.equal(rollCrit(0, rng, "true"), false); assert.equal(rolls, 2);
});
const advantage = new Map([[0, 3], [1, 0], [2, 1], [3, 2], [4, 5], [5, 4]]);
for (let a = 0; a < 6; a++) for (let d = 0; d < 6; d++) test("forced-crit element pair " + a + "/" + d, () => {
    const ring = advantage.get(a) === d ? 2 : advantage.get(d) === a ? .5 : 1;
    const attacker = { kind: "player", atk: 100, mgc: 100, element: a, luck: 0, critBonus: 0, critDamage: .33 };
    const target = { def: 100, mdef: 100, element: d, resists: [{ element: a, pct: .2 }] };
    for (const magic of [false, true]) {
        const force = attackFrom(attacker, target, { coef: 1, magic }, { forceCritical: true, rng: () => { throw Error("no forced RNG"); } });
        assert.equal(force.crit, true);
        assert.equal(resolveDamage(force), Math.max(1, Math.round(100 * ring * 2.6 * 1.83 * .8 - 60)));
        const normal = attackFrom(attacker, target, { coef: 1, magic }, { rng: () => .99 });
        assert.equal(normal.crit, false); assert.equal(resolveDamage(normal), Math.max(1, Math.round(100 * ring * 2.6 * .8 - 60)));
    }
});
test("real confirmed type-8 item grants once without changing base stats or cooldown", () => {
    const w = makeWorld(), p = w.player; equip(w);
    assert.deepEqual(p.skills.slots.slice(1).map(s => s.id), [320320012, 320320013]);
    assert.equal(p.skills.normal.id, 320320011); p.skills.addGauge(100);
    const before = JSON.stringify([p.base, p.hp, p.speed]); cast(w);
    assert.equal(p.nextCritical, true); near(p.nextAtkBonus, .35);
    near(p.skills.slots[2].remaining, 11.2 - stepSize);
    assert.equal(p.skills.gauge, 100); assert.equal(JSON.stringify([p.base, p.hp, p.speed]), before);
    cast(w); assert.equal(w.events.filter(e => e.type === "nextCritical" && e.action === "ready").length, 1);
});
test("real slash shares one 243 damage critical with every target, then returns to 90", () => {
    const w = makeWorld(), p = w.player; arm(w);
    const a = foe(w, { x: 16.6 }), b = foe(w, { x: 16.7, y: 12.25 });
    w.aim = a; swing(w); assert.equal(100000 - a.hp, 243); assert.equal(100000 - b.hp, 243);
    assert.ok(hits(w).every(e => e.crit)); assert.equal(p.nextCritical, false);
    assert.equal(p.nextAtkBonus, 0); assert.equal(used(w).length, 1); assert.equal(p.skills.gauge, 486);
    step(w, .3); a.x = 16.6; b.x = 23; swing(w); assert.equal(hits(w).at(-1).damage, 90);
    assert.equal(hits(w).at(-1).crit, false);
});
test("real knight thrust uses the same committed critical rather than a melee-only branch", () => {
    const w = makeWorld({ card: cards.find(c => c.id === 29002001) }); arm(w);
    const e = foe(w, { x: 17.4 }); w.aim = e; swing(w);
    assert.equal(hits(w)[0].damage, 243); assert.equal(hits(w)[0].crit, true); assert.equal(used(w).length, 1);
});
test("melee whiff spends critical at the active window but preserves hit-owned kind 11", () => {
    const w = makeWorld(); arm(w); swing(w);
    assert.equal(w.player.nextCritical, false); near(w.player.nextAtkBonus, .35);
    assert.equal(hits(w).length, 0); assert.equal(used(w).length, 1);
});
test("wind-up interrupted by a real incoming hit never commits the critical", () => {
    const w = makeWorld(); arm(w); const p = w.player, e = foe(w);
    w.inputState.attack = true; w.update(.02); w.inputState.attack = false;
    assert.ok(w.hitPlayerFrom(e, { coef: .2, magic: false }).hit);
    step(w, .15); assert.equal(p.nextCritical, true); assert.equal(used(w).length, 0);
});
for (const guard of ["iframes", "shield"]) test("committed swing is not refunded by " + guard, () => {
    const w = makeWorld(); arm(w); const e = foe(w, { x: 16.6 });
    if (guard === "iframes") e.iframes = 10; else e.skills = { absorb: () => 0 };
    w.aim = e; swing(w); assert.equal(w.player.nextCritical, false); assert.equal(e.hp, 100000);
    assert.equal(used(w).length, 1);
    near(w.player.nextAtkBonus, guard === "iframes" ? .35 : 0);
});
test("damage skill spends critical, snapshots force and does not consume the normal-only amplifier", () => {
    const w = makeWorld(); arm(w); const p = w.player, e = foe(w); w.aim = e; cast(w, 1);
    assert.equal(p.nextCritical, false); near(p.nextAtkBonus, .35);
    assert.equal(bullets(w)[0].forceCritical, true); near(p.skills.slots[1].remaining, 10.5 - stepSize);
    step(w, 1); assert.equal(100000 - e.hp, 498); assert.equal(hits(w)[0].crit, true);
    near(p.nextAtkBonus, .35); assert.equal(used(w).length, 1);
});
for (const kind of ["skill", "normal"]) test("a rejected whole projectile group preserves pending critical: " + kind, () => {
    const w = makeWorld({ card: cards.find(c => c.id === 15002001) }); arm(w);
    w.danmaku = createDanmaku({ capacity: 1 });
    w.danmaku.emit("aimed", { x: 2, y: 2 }, { speed: 0, life: 100 });
    if (kind === "skill") cast(w, 1); else swing(w);
    assert.equal(w.player.nextCritical, true); assert.equal(used(w).length, 0);
    assert.equal(w.danmaku.rejectedGroups, 1);
});
test("normal explosion uses a launch snapshot and cannot consume a newly granted pending critical", () => {
    const w = makeWorld({ card: cards.find(c => c.id === 15002001) }); arm(w);
    const p = w.player, a = foe(w, { x: 20 }), b = foe(w, { x: 20.5, y: 12.7 });
    w.aim = a; swing(w); assert.equal(p.nextCritical, false);
    assert.equal(bullets(w)[0].forceCritical, true); grantNextCritical(p);
    equip(w, 0); step(w, .7);
    assert.equal(100000 - a.hp, 243); assert.equal(100000 - b.hp, 243);
    assert.equal(p.nextCritical, true); assert.equal(used(w).length, 1);
});
test("priest piercing bullets retain one forced snapshot for all touched targets", () => {
    const w = makeWorld({ card: cards.find(c => c.id === 10002001) }); arm(w);
    const a = foe(w, { x: 19 }), b = foe(w, { x: 21 }); w.aim = a; swing(w); step(w, .8);
    assert.equal(100000 - a.hp, 243); assert.equal(100000 - b.hp, 243); assert.equal(used(w).length, 1);
});
test("alchemist delivery keeps its own blast and slow while using the shared critical", () => {
    const w = makeWorld({ card: cards.find(c => c.id === 38002001) }); arm(w);
    const a = foe(w, { x: 19 }), b = foe(w, { x: 19.5, y: 12.5 });
    w.aim = a; swing(w); step(w, .8);
    assert.equal(100000 - a.hp, 243); assert.equal(100000 - b.hp, 243);
    assert.ok(a.slow && b.slow); assert.equal(used(w).length, 1);
});
test("later critical grant never retroactively changes an already launched ordinary shot", () => {
    const w = makeWorld({ card: cards.find(c => c.id === 15002001) });
    const e = foe(w, { x: 20 }); w.aim = e; swing(w);
    assert.equal(bullets(w)[0].forceCritical, false); grantNextCritical(w.player); step(w, .7);
    assert.equal(hits(w)[0].crit, false); assert.equal(100000 - e.hp, 70); assert.equal(w.player.nextCritical, true);
});
test("all-target magical skill consumes once and forces every emitted arm", () => {
    const card = cards.find(c => c.id === 15002001), w = makeWorld({ card });
    arm(w); equip(w, 0); const a = foe(w, { x: 20 }), b = foe(w, { x: 10 });
    w.aim = a; cast(w, 1); assert.equal(bullets(w).length, 12); assert.ok(bullets(w).every(b => b.forceCritical));
    assert.equal(w.player.nextCritical, false); step(w, 1);
    assert.equal(hits(w).length, 2); assert.equal(100000 - a.hp, 416); assert.equal(100000 - b.hp, 416);
    near(w.player.nextAtkBonus, .35); assert.equal(used(w).length, 1);
});
test("committed forced projectile survives source death and pool reuse resets the flag", () => {
    const w = makeWorld(); arm(w); const p = w.player, e = foe(w, { x: 20 }); w.aim = e; cast(w, 1);
    p.dead = true; p.sm.force("dead"); step(w, 1);
    assert.equal(100000 - e.hp, 498); assert.equal(p.nextCritical, false);
    const pool = createDanmaku({ capacity: 1 });
    pool.emit("aimed", { x: 1, y: 1 }, { side: "player", forceCritical: true });
    let first; pool.forEach(b => first = b); assert.equal(first.forceCritical, true);
    pool.clear(); pool.emit("aimed", { x: 1, y: 1 }, { side: "enemy" });
    pool.forEach(b => { assert.equal(b, first); assert.equal(b.forceCritical, false); });
});
test("real ultimate consumes once, deals 1114, and retains normal-only 35 percent", () => {
    const w = makeWorld(); arm(w); const p = w.player, e = foe(w); p.skills.addGauge(p.skills.gaugeMax);
    assert.ok(w.useUltimate()); assert.equal(w.useUltimate(), false);
    assert.equal(100000 - e.hp, 1114); assert.equal(hits(w)[0].crit, true);
    assert.equal(p.skills.gauge, 0); assert.equal(p.nextCritical, false); near(p.nextAtkBonus, .35);
    assert.equal(used(w).length, 1);
});
for (const first of [true, false]) test("ordinary grant order relative to its single existing damage delivery: " + first, () => {
    const effects = first ? [grant(), damage()] : [damage(), grant()];
    const w = makeWorld({ table: fixture(effects) }), e = foe(w); w.aim = e; cast(w, 1);
    assert.equal(bullets(w)[0].forceCritical, first); assert.equal(w.player.nextCritical, !first);
    step(w, 1); assert.equal(100000 - e.hp, first ? 330 : 200);
});
for (const first of [true, false]) test("ultimate grant order stays atomic instead of multiplying an earlier hit: " + first, () => {
    const effects = first ? [grant(), damage()] : [damage(), grant()];
    const w = makeWorld({ table: fixture(effects, true) }), e = foe(w);
    w.player.skills.addGauge(w.player.skills.gaugeMax); assert.ok(w.useUltimate());
    assert.equal(100000 - e.hp, first ? 330 : 200); assert.equal(w.player.nextCritical, !first);
});
test("one ultimate critical is shared across live targets and segments, with later grants consumed in order", () => {
    const effects = [damage(2), grant(), damage(2), grant()];
    const w = makeWorld({ table: fixture(effects, true) }), a = foe(w), b = foe(w, { x: 21 });
    const p = w.player; grantNextCritical(p); p.skills.addGauge(p.skills.gaugeMax); assert.ok(w.useUltimate());
    assert.equal(100000 - a.hp, 660); assert.equal(100000 - b.hp, 660);
    assert.equal(hits(w).length, 4); assert.ok(hits(w).every(e => e.crit));
    assert.equal(p.nextCritical, true); assert.equal(used(w).length, 2); assert.equal(p.skills.gauge, 0);
});
test("a dead locked target cannot consume a later grant or redirect the remaining segment", () => {
    const w = makeWorld({ table: fixture([damage(), grant(), damage()], true) });
    const p = w.player, a = foe(w, { x: 18, hp: 1 }), b = foe(w, { x: 21 });
    p.skills.addGauge(p.skills.gaugeMax); assert.ok(w.useUltimate());
    assert.equal(a.dead, true); assert.equal(b.hp, 100000); assert.equal(p.nextCritical, true);
    assert.equal(used(w).length, 0); assert.equal(hits(w).length, 1);
});
test("a refused targetless ultimate and a heal-only ultimate preserve pending critical", () => {
    const empty = makeWorld({ table: fixture([damage()], true) }); grantNextCritical(empty.player);
    empty.player.skills.addGauge(empty.player.skills.gaugeMax); assert.equal(empty.useUltimate(), false);
    assert.equal(empty.player.nextCritical, true); assert.equal(empty.player.skills.gauge, empty.player.skills.gaugeMax);
    const heal = makeWorld({ table: fixture([{ kind: 1, target: 0, args: [20] }], true) });
    grantNextCritical(heal.player); heal.player.hp = 500; heal.player.skills.addGauge(heal.player.skills.gaugeMax);
    assert.ok(heal.useUltimate()); assert.equal(heal.player.hp, 700); assert.equal(heal.player.nextCritical, true);
});
test("autonomous real CARD neither uses nor consumes a pending critical", () => {
    const card = cards.find(c => c.id === 39002001), w = makeWorld({ card }), e = foe(w);
    w.aim = e; cast(w, 1); assert.ok(w.player.skillCards?.length);
    grantNextCritical(w.player); step(w, 3);
    const cardHits = hits(w).filter(e => e.skillCard);
    assert.equal(cardHits.length, 1); assert.equal(cardHits[0].damage, 70); assert.equal(cardHits[0].crit, false);
    assert.equal(w.player.nextCritical, true); assert.equal(used(w).length, 0);
});
test("six-stat reset, elapsed time, equip and non-damage skill do not clear pending critical", () => {
    const w = makeWorld(), p = w.player; arm(w);
    p.skills.applySelf(decodeSkill({ target: 0, effects: [{ kind: 3, target: 0, args: [1, 1, 1, 1, 1, 1] }] }, 1, .35));
    step(w, 20); assert.equal(p.nextCritical, true);
    equip(w, 0); cast(w, 2); assert.equal(p.nextCritical, true);
    assert.equal(used(w).length, 0); near(p.nextAtkBonus, .35);
});
test("pause/hit-stop keep pending state and room/death clear only temporary effects", () => {
    const w = makeWorld(), p = w.player; arm(w); p.skills.addGauge(100);
    const before = JSON.stringify([p.nextCritical, p.skills.slots.map(s => s.remaining), p.skills.gauge]);
    w.frozen = true; w.inputState.attack = true; step(w, 10);
    assert.equal(JSON.stringify([p.nextCritical, p.skills.slots.map(s => s.remaining), p.skills.gauge]), before);
    w.inputState.attack = false; w.frozen = false; w.applyHitStop(.5); step(w, .2);
    assert.equal(p.nextCritical, true); w.hitStop = 0;
    const cooldown = p.skills.slots[2].remaining;
    w.setDungeon({ start: 0, rooms: [{ id: 0, type: "start", seed: 1, enemies: [], doors: {} },
        { id: 1, type: "start", seed: 2, enemies: [], doors: {} }] }); w.enterRoom(1);
    assert.equal(p.nextCritical, false); near(p.skills.slots[2].remaining, cooldown); assert.equal(p.skills.gauge, 100);
    grantNextCritical(p); p.dead = true; p.sm.force("dead"); w.update(stepSize); assert.equal(p.nextCritical, false);
});
test("player pending state and a stray projectile flag cannot enable an enemy critical", () => {
    const w = makeWorld(), p = w.player; grantNextCritical(p);
    w.danmaku.emit("aimed", { x: p.x + 2, y: p.y, angle: Math.PI },
        { side: "enemy", power: 100, coef: 1, element: p.element, forceCritical: true });
    step(w, .6); assert.equal(p.hp, 960); assert.equal(p.nextCritical, true);
    assert.equal(w.events.filter(e => e.type === "hit" && e.target === p)[0].crit, false);
});
test("self-targeted enemy support is not misreported as a newly executable critical attack", () => {
    const moves = enemyMoveset(table, [16069, 134004, 162004]);
    assert.equal(moves.attacks.length, 0); assert.equal(moves.support.length, 3);
    assert.ok(Object.values(shipped.player).every(row => !row.effects.some(e => e.kind === 12)));
    assert.ok(Object.values(shipped.skillCards).every(row => !row.effects.some(e => e.kind === 12)));
});
test("player words distinguish kind 11 from action-owned critical and disclose exclusions", () => {
    const words = skillWords(decode(320320013)).join("；");
    for (const text of ["下次普攻 +35%（命中后消耗）", "下次伤害行动必定暴击", "普通技能", "必杀", "出手消耗", "挥空", "技能卡", "不利属性"])
        assert.ok(words.includes(text), words + " missing " + text);
    assert.ok(!words.includes("未适配：必定暴击"));
});
console.log("Next critical: " + checks + " checks passed.");
