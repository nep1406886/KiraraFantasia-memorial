#!/usr/bin/env node
// Weapon passive harness (spec/04 §4.2) -- the behavioral half of
// PassiveSkillList_WPN that 阶段 4's 词条乘区 deliberately deferred: crit
// damage, gauge effects, stun fill, overheal, lifesteal, 踏みとどまり,
// stacking rows, type-14 debuffs, and the type-8 child-row swaps.
//
// Four gates:
//   1. data     -- weapons-rl.json's childSkills covers exactly the type-8
//                  referenced SkillList_PL rows, and every passive type the
//                  162 rows use is accounted for (0..14, no unknowns).
//   2. runtime  -- passiveRuntime() aggregation per type, with the real affix
//                  table and the pinned magnitude readings documented in
//                  equipment.js (0.33 crit damage, [1] gauge, [0.15] on-hit,
//                  [0.25] stun, [100] overheal, [2.5] lifesteal, ...).
//   3. skills   -- applyWeapon() swaps and restores normal/skill rows against
//                  the real skills table.
//   4. world    -- the wiring through pushHit / creditGauge / buildStun /
//                  reapplyEquipment, driven with fixture worlds whose foes
//                  never act (actionTimer 1e9), so every expectation is
//                  hand-computed -- a gate must not read its expectation from
//                  the pipeline under test (spec/02).
//
// Pure-logic: no three.js, no DOM (master plan §4.1).

import { readFileSync } from "node:fs";
import {
    createWorld, STUN_BASE, STUN_RATE
} from "../site/game/rl/world.js";
import {
    affixTableFromPassives, passiveRuntime, setAffixTable
} from "../site/game/rl/equipment.js";
import { setAffixPool } from "../site/game/rl/loot.js";
import { createSkills } from "../site/game/rl/skills.js";
import { resolveDamage, attackFrom } from "../site/game/rl/combat.js";

let failed = 0;
function check(cond, msg, detail) {
    if (!cond) {
        console.error("✗", msg + (detail !== undefined ? " (" + detail + ")" : ""));
        failed += 1;
    } else {
        console.log("✓", msg);
    }
}
function near(a, b, msg, eps) {
    check(Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps), msg, a + " vs " + b);
}
function hasNaN(v) {
    if (typeof v === "number") { return Number.isNaN(v); }
    if (v && typeof v === "object") {
        return Object.keys(v).some(function (k) { return hasNaN(v[k]); });
    }
    return false;
}

// --- fixtures ----------------------------------------------------------------

const weapons = JSON.parse(readFileSync(
    new URL("../site/asset/rl/weapons-rl.json", import.meta.url), "utf8"));
const skillsTable = JSON.parse(readFileSync(
    new URL("../site/asset/rl/skills-rl.json", import.meta.url), "utf8"));
const cardsRaw = JSON.parse(readFileSync(
    new URL("../site/asset/rl/cards-rl.json", import.meta.url), "utf8"));
const cards = Array.isArray(cardsRaw) ? cardsRaw : cardsRaw.cards;

// The real affix table and an empty loot pool: kill drops must never fire
// during these gates (a pickup would change stats mid-test).
setAffixPool([], []);
setAffixTable(affixTableFromPassives(weapons.passives));
const children = weapons.childSkills || {};

// Pinned real rows, one per behavioral type (read from the shipped table,
// magnitudes documented in equipment.js passiveRuntime).
const ID = {
    critDamage: "11022001",      // type 7  [0.33]
    critDamage2: "14002001",     // type 7  [0.33]
    gaugeMult: "11002001",       // type 6  [1]
    gaugeOnHit: "10002021",      // type 5  [0.15], trigger 1
    stunFill: "13002001",        // type 4  [0.25]
    overheal: "10002001",        // type 9  [100]
    lifesteal: "12012001",       // type 10 [2.5, ...]
    survival: "12012011",        // type 11 [0, 100]
    taunt: "10012011",           // type 1  [20]
    hitStack: "29002001",        // trigger 1 type 0 [3,0,0,0,0,0]
    killStack: "14012001",       // trigger 2 type 0 [0,5,0,0,0,0]
    debuff: "11012001",          // type 14 [2,1,3,0,-15,...] → mgc -15%, 3 turns
    normalOnly: "10002011",      // type 8  [100020111, -1, -1]
    skillsOnly: "10022001",      // type 8  [-1, 100220012, 100220013]
    normalAndSkills: "10012001", // type 8+9+13 [100120011, 100120012, 100120013]
    noopStun: "11032001",        // type 2
    noopPlace: "21002001"        // type 12
};

function rtOf(ids, slot) {
    return passiveRuntime([{ slot: slot || "weapon", affixes: ids }]);
}

// --- Gate 1: data ------------------------------------------------------------

console.log("\nGate 1: childSkills covers the type-8 references");
{
    const referenced = new Set();
    Object.keys(weapons.passives).forEach(function (pid) {
        (weapons.passives[pid].effects || []).forEach(function (e) {
            if (e.type === 8) {
                (e.args || []).forEach(function (a) {
                    if (a && a > 0) { referenced.add(String(a)); }
                });
            }
        });
    });
    const shipped = new Set(Object.keys(children));
    check(referenced.size === 234,
        "234 child rows referenced by type-8 args", referenced.size);
    let missing = [];
    referenced.forEach(function (id) {
        if (!shipped.has(id)) { missing.push(id); }
    });
    check(missing.length === 0, "every referenced child ships", missing.join(","));
    let phantom = [];
    shipped.forEach(function (id) {
        if (!referenced.has(id)) { phantom.push(id); }
    });
    check(phantom.length === 0, "no phantom children", phantom.join(","));

    let bad = [];
    Object.keys(children).forEach(function (id) {
        const row = children[id];
        if (!row.name || typeof row.target !== "number"
                || !Array.isArray(row.effects)) {
            bad.push(id);
        }
    });
    check(bad.length === 0, "every child row decodes (name/target/effects)",
        bad.join(","));

    // Accounting completeness: the 162 rows use exactly types 0..14 -- the
    // four no-ops here (1 狙われ率, 2/3 状態/スタン無効, 12 配置回数) and 13
    // (HP-scaling, no readable payload) are design decisions, not gaps.
    const types = new Set();
    Object.keys(weapons.passives).forEach(function (pid) {
        (weapons.passives[pid].effects || []).forEach(function (e) {
            types.add(e.type);
        });
    });
    const wanted = [];
    for (let t = 0; t <= 14; t++) { wanted.push(t); }
    check(Array.from(types).sort(function (a, b) { return a - b; }).join()
            === wanted.join(),
        "passive types are exactly 0..14 (nothing unaccounted)",
        Array.from(types).join(","));
}

// --- Gate 2: passiveRuntime aggregation ---------------------------------------

console.log("\nGate 2: passiveRuntime per behavioral type");
{
    near(rtOf([ID.critDamage]).critDamage, 0.33, "type 7 [0.33] → critDamage 0.33");
    near(rtOf([ID.critDamage, ID.critDamage2]).critDamage, 0.66,
        "two type 7 rows sum");
    check(rtOf([ID.gaugeMult]).gaugeMult === 2,
        "type 6 [1] → gaugeMult 2", rtOf([ID.gaugeMult]).gaugeMult);
    near(rtOf([ID.gaugeOnHit]).gaugeOnHit, 0.15,
        "type 5 [0.15] → gaugeOnHit 0.15");
    check(rtOf([ID.stunFill]).stunFill === 1.25,
        "type 4 [0.25] → stunFill 1.25", rtOf([ID.stunFill]).stunFill);
    near(rtOf([ID.overheal]).overheal, 1, "type 9 [100] → overheal +100%");
    near(rtOf([ID.lifesteal]).lifesteal, 0.025, "type 10 [2.5] → lifesteal 2.5%");
    check(rtOf([ID.survival]).survival === 1, "type 11 → 1 survival charge");
    near(rtOf([ID.taunt]).taunt, 0.2, "type 1 [20] → taunt recorded (no-op by design)");
    check(rtOf([ID.hitStack]).hitStack && Math.abs(rtOf([ID.hitStack]).hitStack.atk - 0.03) < 1e-9,
        "trigger 1 type 0 [3,...] → hitStack atk 3%");
    check(rtOf([ID.killStack]).killStack && Math.abs(rtOf([ID.killStack]).killStack.mgc - 0.05) < 1e-9,
        "trigger 2 type 0 [0,5,...] → killStack mgc 5%");

    const db = rtOf([ID.debuff]).debuffOnHit;
    check(db && Math.abs(db.atk - 0) < 1e-9 && Math.abs(db.mgc - (-0.15)) < 1e-9
            && db.turns === 3,
        "type 14 [2,1,3,0,-15] → debuff atk 0 / mgc -15% / 3 turns",
        JSON.stringify(db));

    const no = rtOf([ID.normalOnly]);
    check(no.normalOverride === 100020111 && no.skillOverrides.length === 0,
        "type 8 [id,-1,-1] → normal override only",
        JSON.stringify([no.normalOverride, no.skillOverrides]));
    const so = rtOf([ID.skillsOnly]);
    check(so.normalOverride === null
            && so.skillOverrides.join() === "100220012,100220013",
        "type 8 [-1,id,id] → two skill overrides, no normal");
    const both = rtOf([ID.normalAndSkills]);
    check(both.normalOverride === 100120011
            && both.skillOverrides.join() === "100120012,100120013",
        "type 8 [id,id,id] → normal + two skill overrides");

    // Weapon-slot identity wins over a rolled type-8 on another slot: the
    // weapon item is read last, so its own rows overwrite the off-slot's.
    const winner = passiveRuntime([
        { slot: "armor", affixes: [ID.normalAndSkills] },
        { slot: "weapon", affixes: [ID.normalOnly] }
    ]);
    check(winner.normalOverride === 100020111,
        "weapon slot's type 8 beats an armor-rolled type 8",
        winner.normalOverride);
    // ...in any array order.
    const winner2 = passiveRuntime([
        { slot: "weapon", affixes: [ID.normalOnly] },
        { slot: "armor", affixes: [ID.normalAndSkills] }
    ]);
    check(JSON.stringify(winner) === JSON.stringify(winner2),
        "aggregation is order-independent (weapon always read last)");

    const noops = rtOf([ID.noopStun, ID.noopPlace]).noops
        .sort(function (a, b) { return a - b; });
    check(noops.join() === "3",
        "type 3 remains noop; healing-lock immunity and card-count passives execute",
        noops.join(","));
    check(rtOf([ID.noopStun]).healingLockImmune === true,
        "11032001 type 2 has an executable healing-lock immunity payload");
    check(rtOf([ID.noopPlace]).extraCardTriggers === 2,
        "21002001 type 12 adds two activations at card placement/refresh");
    check(rtOf([ID.normalAndSkills]).noops.indexOf(13) >= 0,
        "type 13 (HP-scaling, unreadable) lands in noops");

    // Purity + no NaN across every shipped passive, alone and with the
    // aggregation recomputed twice.
    let nanBad = [];
    let orderBad = null;
    Object.keys(weapons.passives).forEach(function (pid) {
        const once = rtOf([pid]);
        const again = rtOf([pid]);
        if (hasNaN(once) || JSON.stringify(once) !== JSON.stringify(again)) {
            nanBad.push(pid);
        }
    });
    check(nanBad.length === 0,
        "all 162 passives aggregate NaN-free and deterministically",
        nanBad.slice(0, 5).join(","));
}

// --- Gate 3: applyWeapon swap/restore -----------------------------------------

console.log("\nGate 3: applyWeapon swaps and restores skill rows");
const table = Object.assign({}, skillsTable, { weaponChildren: children });
const realCard = cards.find(function (c) {
    return c.skillIds && c.skillIds.chara
        && c.skillIds.class && c.skillIds.class.length >= 2
        && table.normalAttacks[String(c.class)];
});
check(!!realCard, "a roster card with chara + 2 class skills exists");
{
    const sk = createSkills({ table: table, card: realCard, maxHp: 1000 });
    const baseIds = [
        realCard.skillIds.chara,
        realCard.skillIds.class[0],
        realCard.skillIds.class[1]
    ];
    check(sk.slots.map(function (s) { return s.id; }).join() === baseIds.join(),
        "base slots are the card's rows");
    const baseNormal = sk.normal;
    check(baseNormal.id === table.normalAttacks[String(realCard.class)].id
            && baseNormal.coef === table.normalAttacks[String(realCard.class)].coef,
        "base normal attack is the class row");

    sk.applyWeapon({ normalOverride: 100020111 });
    check(sk.normal.id === 100020111
            && sk.normal.name === children["100020111"].name,
        "normalOverride swaps the normal attack", sk.normal.id);
    check(sk.slots.map(function (s) { return s.id; }).join() === baseIds.join(),
        "normal override leaves the slots alone");

    sk.applyWeapon({ skillOverrides: [100220012, 100220013] });
    check(sk.slots[0].id === baseIds[0],
        "skill overrides start after the character skill");
    check(sk.slots[1].id === 100220012 && sk.slots[2].id === 100220013,
        "skill overrides replace the class rows in order",
        sk.slots.map(function (s) { return s.id; }).join(","));

    sk.applyWeapon({});
    check(sk.normal.id === baseNormal.id && sk.normal.coef === baseNormal.coef,
        "empty runtime restores the base normal");
    check(sk.slots.map(function (s) { return s.id; }).join() === baseIds.join(),
        "empty runtime restores the base slots");

    // Swap cycles must not accumulate residue (same property applyEquipment
    // is hammered for).
    for (let i = 0; i < 100; i++) {
        sk.applyWeapon({ normalOverride: 100020111,
            skillOverrides: [100220012, 100220013] });
        sk.applyWeapon({});
    }
    check(sk.normal.id === baseNormal.id && sk.normal.coef === baseNormal.coef
            && sk.slots.map(function (s) { return s.id; }).join() === baseIds.join(),
        "100 swap cycles leave no residue");
}

// --- Gate 4: world wiring ------------------------------------------------------

console.log("\nGate 4: world wiring through the hit/gauge/stun funnels");

// Fixture stats: every number below is hand-computed from these literals.
// luck 0 → crit chance 0, so no roll ever crits and damage is exact.
const mockStats = {
    statsFor: function () {
        return { hp: 1000, atk: 100, mgc: 50, def: 10, mdef: 10, spd: 100, luck: 0 };
    },
    card: function () { return null; }
};
const CARD = {
    id: realCard.id, class: realCard.class, skillIds: realCard.skillIds
};
// gaugeMax = round(1000 × 1.4)
const GAUGE_MAX = 1400;

function makeWorld(equipment) {
    const world = createWorld({
        seed: 20260904,
        tables: { stats: mockStats, skills: table }
    });
    world.spawnPlayer({
        card: CARD, x: 8, y: 6, level: 1, equipment: equipment || []
    });
    return world;
}
// A foe that never acts: actionTimer 1e9 keeps the brain idle, so the only
// events are the bullets this gate fires on purpose.
function quietFoe(world, x, y, hp) {
    const foe = world.spawnEnemy({
        x: x, y: y, hp: hp === undefined ? 100000 : hp,
        atk: 100, mgc: 100, def: 0, mdef: 0
    });
    foe.actionTimer = 1e9;
    return foe;
}
function firePlayerBullet(world, foe, power) {
    const p = world.player;
    return world.danmaku.emit("aimed",
        { x: p.x, y: p.y, angle: Math.atan2(foe.y - p.y, foe.x - p.x) },
        { side: "player", power: power, coef: 1, magic: false,
          count: 1, speed: 10, life: 4, srcId: p.id });
}
function fireEnemyBullet(world, foe, power) {
    const p = world.player;
    world.danmaku.emit("aimed",
        { x: foe.x, y: foe.y, angle: Math.atan2(p.y - foe.y, p.x - foe.x) },
        { side: "enemy", power: power, coef: 1, magic: false,
          count: 1, speed: 10, life: 4, srcId: foe.id });
}
function step(world, n) {
    for (let i = 0; i < n; i++) {
        world.update(1 / 60);
    }
}
function eventsOf(world, type) {
    return world.drainEvents().filter(function (e) { return e.type === type; });
}

// 4a. Gauge multiplier: player bullet power 100 × tempo 4.15 = 415 damage;
//     type 6 [1] doubles the credit.
{
    const plain = makeWorld([]);
    const buffed = makeWorld([{ slot: "weapon", affixes: [ID.gaugeMult] }]);
    const fa = quietFoe(plain, 11, 6);
    const fb = quietFoe(buffed, 11, 6);
    step(plain, 3); step(buffed, 3);
    firePlayerBullet(plain, fa, 100);
    firePlayerBullet(buffed, fb, 100);
    step(plain, 60); step(buffed, 60);
    plain.drainEvents(); buffed.drainEvents();
    check(plain.player.skills.gauge === 415,
        "gauge baseline: 415 damage credits 415 gauge",
        plain.player.skills.gauge);
    check(buffed.player.skills.gauge === 830,
        "type 6 大アップ [1] doubles gauge credit",
        buffed.player.skills.gauge);
}

// 4b. Gauge on hit taken: enemy bullet power 10 vs def 10 = 4 damage credited
//     both ways; the type 5 row adds 15% of the ceiling per hit taken.
{
    const plain = makeWorld([]);
    const armed = makeWorld([{ slot: "weapon", affixes: [ID.gaugeOnHit] }]);
    const fa = quietFoe(plain, 11, 6);
    const fb = quietFoe(armed, 11, 6);
    step(plain, 3); step(armed, 3);
    fireEnemyBullet(plain, fa, 10);
    fireEnemyBullet(armed, fb, 10);
    step(plain, 60); step(armed, 60);
    plain.drainEvents(); armed.drainEvents();
    check(plain.player.skills.gauge === 4,
        "damage taken credits the gauge too (4)",
        plain.player.skills.gauge);
    near(armed.player.skills.gauge - plain.player.skills.gauge,
        GAUGE_MAX * 0.15,
        "type 5 [0.15] adds 15% of the ceiling per hit taken");
}

// 4c. Stun fill: one player hit fills STUN_BASE × enemy rate; type 4 [0.25]
//     multiplies the player's contribution by 1.25.
{
    const plain = makeWorld([]);
    const armed = makeWorld([{ slot: "weapon", affixes: [ID.stunFill] }]);
    const fa = quietFoe(plain, 11, 6);
    const fb = quietFoe(armed, 11, 6);
    step(plain, 3); step(armed, 3);
    firePlayerBullet(plain, fa, 100);
    firePlayerBullet(armed, fb, 100);
    step(plain, 60); step(armed, 60);
    plain.drainEvents(); armed.drainEvents();
    near(plain.enemies[0].stun, STUN_BASE * STUN_RATE.enemy,
        "stun baseline: one hit fills STUN_BASE × enemy rate");
    near(armed.enemies[0].stun, plain.enemies[0].stun * 1.25,
        "type 4 [0.25] fills the stun gauge 1.25×");
}

// 4d. Lifesteal: 415 damage × 2.5% = 10.4 → 10 HP back (max(1, round)).
{
    const world = makeWorld([{ slot: "weapon", affixes: [ID.lifesteal] }]);
    const foe = quietFoe(world, 11, 6);
    step(world, 3);
    fireEnemyBullet(world, foe, 200);          // 200 − 10×0.6 = 194 damage
    step(world, 60);
    world.drainEvents();
    check(world.player.hp === 1000 - 194, "player at 806 after the setup hit",
        world.player.hp);
    firePlayerBullet(world, foe, 100);
    step(world, 60);
    const heals = eventsOf(world, "heal");
    check(heals.length === 1 && heals[0].amount === 10,
        "lifesteal heals round(415 × 2.5%) = 10",
        JSON.stringify(heals.map(function (h) { return h.amount; })));
    check(world.player.hp === 1000 - 194 + 10, "heal landed on the unit",
        world.player.hp);
}

// 4e. Overheal: type 9 [100] raises the heal ceiling to 2 × maxHp; without
//     it the same heal clips at maxHp.
{
    const world = makeWorld([
        { slot: "armor", affixes: [ID.overheal] },
        { slot: "weapon", affixes: [ID.lifesteal] }
    ]);
    const foe = quietFoe(world, 11, 6);
    step(world, 3);
    fireEnemyBullet(world, foe, 200);
    step(world, 60);
    world.drainEvents();                        // 806 hp
    firePlayerBullet(world, foe, 100000);       // heal 6500, ceiling 2000
    step(world, 60);
    world.drainEvents();
    check(world.player.maxHp === 1000, "overheal never touches maxHp");
    check(world.player.hp === 2000,
        "overheal [100] lifts the heal ceiling to 2× maxHp",
        world.player.hp);
    const control = makeWorld([{ slot: "weapon", affixes: [ID.lifesteal] }]);
    const foe2 = quietFoe(control, 11, 6);
    step(control, 3);
    fireEnemyBullet(control, foe2, 200);
    step(control, 60);
    control.drainEvents();
    firePlayerBullet(control, foe2, 100000);
    step(control, 60);
    control.drainEvents();
    check(control.player.hp === 1000,
        "without the row the same heal clips at maxHp", control.player.hp);
}

// 4f. 踏みとどまり: the fatal hit is survived with a full heal, one charge per
//     floor, and setDungeon re-arms the charge.
{
    const world = makeWorld([{ slot: "weapon", affixes: [ID.survival] }]);
    let foe = quietFoe(world, 11, 6);
    step(world, 3);
    fireEnemyBullet(world, foe, 100000);
    step(world, 60);
    let survivals = eventsOf(world, "survival");
    check(survivals.length === 1, "one survival event on the fatal hit");
    check(!world.player.dead && world.player.hp === world.player.maxHp,
        "survived with a full heal",
        "dead=" + world.player.dead + " hp=" + world.player.hp);
    check(world.player.survivalUsed === 1, "the charge is spent");

    step(world, 90);                            // iframes (0.6 s) expire

    // A new dungeon is a new floor: the charge re-arms (setDungeon) while
    // the player is still standing -- the descent happens between fights,
    // not after death.
    world.setDungeon({
        rooms: [{ id: "r0", type: "battle", enemies: [], doors: [] }],
        start: "r0"
    });
    check(world.player.survivalUsed === 0,
        "setDungeon re-arms the charge for the new floor");
    check(!world.player.dead, "the player is still alive to descend");
    foe = quietFoe(world, 11, 6);
    step(world, 3);
    fireEnemyBullet(world, foe, 100000);
    step(world, 60);
    survivals = eventsOf(world, "survival");
    check(survivals.length === 1 && !world.player.dead,
        "the re-armed charge survives again");

    step(world, 90);
    fireEnemyBullet(world, foe, 100000);
    step(world, 60);
    eventsOf(world, "survival");
    check(world.player.dead,
        "with the charge spent again, the fatal hit kills");
}

// 4g. Hit stack: trigger 1 type 0 [3,...] → +3% atk per hit taken, applied
//     through reapplyEquipment as a permanent run buff.
{
    const world = makeWorld([{ slot: "weapon", affixes: [ID.hitStack] }]);
    const foe = quietFoe(world, 11, 6);
    step(world, 3);
    const atk0 = world.player.atk;
    fireEnemyBullet(world, foe, 10);
    step(world, 60);
    world.drainEvents();
    check(world.player.stackHits === 1, "one hit taken = one stack");
    near(world.player.atk, atk0 * 1.03, "the stack lifts atk by 3%");
}

// 4h. Kill stack: trigger 2 type 0 [0,5,...] → +5% mgc per kill.
{
    const world = makeWorld([{ slot: "weapon", affixes: [ID.killStack] }]);
    const foe = quietFoe(world, 11, 6, 1);
    step(world, 3);
    const mgc0 = world.player.mgc;
    firePlayerBullet(world, foe, 100);
    step(world, 60);
    world.drainEvents();
    check(foe.dead, "the foe died");
    check(world.player.stackKills === 1, "one kill = one stack");
    near(world.player.mgc, mgc0 * 1.05, "the stack lifts mgc by 5%");
}

// 4i. Type 14 debuff: taking a hit debuffs every living enemy; the debuff is
//     consumed by combat.attackFrom, refreshes instead of stacking, and
//     expires through updateEnemy's tick.
{
    const world = makeWorld([{ slot: "weapon", affixes: [ID.debuff] }]);
    const f1 = quietFoe(world, 11, 6);
    const f2 = quietFoe(world, 5, 6);
    step(world, 3);
    fireEnemyBullet(world, f1, 10);
    step(world, 60);
    world.drainEvents();
    const seconds = 3 * table.turnSeconds;
    [f1, f2].forEach(function (foe, i) {
        const d = (foe.debuffs || [])[0];
        // The remaining time is read after the settling steps, so it has
        // already decayed a little -- pin the shape, not the exact clock.
        check(d && d.tag === "weapon14" && Math.abs(d.atk - 0) < 1e-9
                && Math.abs(d.mgc - (-0.15)) < 1e-9
                && d.remaining > seconds - 1 && d.remaining <= seconds,
            "foe " + (i + 1) + " carries the -15% mgc debuff", JSON.stringify(d));
    });
    const spec = attackFrom(f1, world.player, { coef: 1, magic: false });
    check(spec.atk === 100 && spec.mgc === 85,
        "attackFrom consumes the debuff (atk 0% / mgc -15%)",
        spec.atk + "/" + spec.mgc);

    step(world, 90);                            // iframes expire
    fireEnemyBullet(world, f1, 10);
    step(world, 60);
    world.drainEvents();
    check(f1.debuffs.length === 1,
        "a second hit refreshes the debuff instead of stacking",
        f1.debuffs.length);

    step(world, Math.ceil((seconds + 1) * 60));
    check((f1.debuffs || []).length === 0 && (f2.debuffs || []).length === 0,
        "the debuff expires after 3 turns");
}

// 4j. Crit damage: type 7 [0.33] rides the attacker into resolveDamage.
{
    check(resolveDamage({ atk: 100, skill: 1, crit: true, critDamage: 0.33 }) === 183,
        "resolveDamage: crit × (1.5 + 0.33) = 183");
    const spec = attackFrom(
        { kind: "player", atk: 100, mgc: 0, luck: 0, critBonus: 0, critDamage: 0.33 },
        { def: 0, mdef: 0 },
        { coef: 1, magic: false },
        { crit: true });
    check(spec.critDamage === 0.33,
        "attackFrom carries attacker.critDamage into the spec");
    const world = makeWorld([{ slot: "weapon", affixes: [ID.critDamage] }]);
    check(world.player.critDamage === 0.33,
        "the unit carries critDamage from spawn", world.player.critDamage);
}

// 4k. Type 8 through the real funnel: the weapon's own rows are live from
//     spawn, and a same-slot pickup (the only unequip path) restores them.
{
    const world = makeWorld([{ slot: "weapon", affixes: [ID.normalAndSkills] }]);
    const sk = world.player.skills;
    check(sk.normal.id === 100120011,
        "the evolved normal attack is live from spawn", sk.normal.id);
    check(sk.slots[1].id === 100120012 && sk.slots[2].id === 100120013,
        "the evolved class skills are live from spawn",
        sk.slots.map(function (s) { return s.id; }).join(","));
    const baseIds = [
        CARD.skillIds.chara, CARD.skillIds.class[0], CARD.skillIds.class[1]
    ];
    const baseNormalId = table.normalAttacks[String(CARD.class)].id;
    world.drops.push({
        x: world.player.x, y: world.player.y,
        // a pure type-5 row: no type-8 of its own, so the swap must restore
        items: [{ slot: "weapon", affixes: [ID.gaugeOnHit] }]
    });
    step(world, 3);
    world.takeDrop(world.drops[0], world.drops[0].items[0]);
    const pickups = eventsOf(world, "pickup");
    check(pickups.length === 1, "the replacement weapon was picked up");
    check(world.player.skills.normal.id === baseNormalId
            && world.player.skills.slots.map(function (s) { return s.id; }).join()
                === baseIds.join(),
        "swapping the weapon out restores the base rows");
}

console.log("\n" + "=".repeat(60));
if (failed === 0) {
    console.log("✓ All weapon gates passed");
    console.log("✓ data / runtime / applyWeapon / world wiring");
} else {
    console.error("✗", failed, "gate(s) failed");
    process.exit(1);
}
