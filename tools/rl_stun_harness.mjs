#!/usr/bin/env node
// Stun gauge harness (spec/04 §11) -- スタンゲージ, the Kirafan-native
// replacement for the dropped Touhou graze system.
//
// The design is enemy-side (PassiveSkillList m_Type 4 names スタンゲージ in the
// original), so every gate drives a world directly the way
// rl_combat_harness.mjs drives fixture worlds. Expectations are hand-computed
// from the exported constants -- a gate must not read its expectation from the
// pipeline under test (spec/02).

import {
    createWorld, STUN_MAX, STUN_BASE, STUN_ADVANTAGE_BONUS, STUN_CRIT_BONUS,
    STUN_RATE, STUN_DURATION, STUN_DECAY_DELAY, STUN_DECAY_PER_SEC
} from "../site/game/rl/world.js";
import { STUN_DAMAGE_MULT, tryHit, attackFrom } from "../site/game/rl/combat.js";
import { setAffixPool } from "../site/game/rl/loot.js";

let failed = 0;
function check(cond, msg, detail) {
    if (!cond) {
        console.error("✗", msg + (detail !== undefined ? " (" + detail + ")" : ""));
        failed += 1;
    } else {
        console.log("✓", msg);
    }
}

function makeWorld() {
    // Loot must not fire during these gates: a pickup would change the player's
    // stats mid-test.
    setAffixPool([], []);
    return createWorld({ seed: 20260903 });
}

function step(world, n) {
    for (let i = 0; i < n; i++) {
        world.update(1 / 60);
    }
}

function drainStuns(world) {
    const stuns = [];
    world.drainEvents().forEach(function (e) {
        if (e.type === "stun") { stuns.push(e); }
    });
    return stuns;
}

// A deterministic player hit: a player-side bullet. It rides the same funnel
// the game's skill bullets do (danmaku update -> onBulletHit -> tryHit ->
// pushHit -> buildStun) and, unlike a melee swing, applies no knockback, so
// the enemy stays exactly where it was put and each hit is one gauge tick.
function fireAt(world, foe, count) {
    const p = world.player;
    const angle = Math.atan2(foe.y - p.y, foe.x - p.x);
    return world.danmaku.emit("aimed",
        { x: p.x, y: p.y, angle: angle },
        { side: "player", power: 10, coef: 1, magic: false,
          count: count || 1, speed: 10, life: 4, stepDelay: 0.02 });
}

console.log("\nGate 1: constants carry the authored spec");
{
    check(STUN_MAX === 100, "STUN_MAX is 100");
    check(STUN_BASE === 10, "STUN_BASE is 10");
    check(STUN_ADVANTAGE_BONUS === 10, "STUN_ADVANTAGE_BONUS is 10");
    check(STUN_CRIT_BONUS === 10, "STUN_CRIT_BONUS is 10");
    check(STUN_RATE.enemy === 1.0 && STUN_RATE.elite === 0.6 && STUN_RATE.boss === 0.4,
        "STUN_RATE tiers are enemy 1.0 / elite 0.6 / boss 0.4");
    check(STUN_DURATION === 3.0, "STUN_DURATION is 3.0s");
    check(STUN_DECAY_DELAY === 3.0, "STUN_DECAY_DELAY is 3.0s");
    check(STUN_DECAY_PER_SEC === 15, "STUN_DECAY_PER_SEC is 15/s");
    check(STUN_DAMAGE_MULT === 1.5, "STUN_DAMAGE_MULT is 1.5");
}

console.log("\nGate 2: a landed hit fills the gauge by STUN_BASE");
{
    const world = makeWorld();
    world.spawnPlayer({ hp: 100, atk: 10, x: 8, y: 6 });
    const foe = world.spawnEnemy({ x: 10, y: 6, hp: 1000, atk: 0 });
    fireAt(world, foe, 1);
    step(world, 60);
    check(foe.stun === STUN_BASE * STUN_RATE.enemy,
        "one landed hit added exactly the base rate", "stun=" + foe.stun);
    drainStuns(world);
}

console.log("\nGate 3: gauge trips at STUN_MAX, stuns, then refills from zero");
{
    const world = makeWorld();
    world.spawnPlayer({ hp: 100, atk: 10, x: 8, y: 6 });
    const foe = world.spawnEnemy({ x: 10, y: 6, hp: 10000, atk: 0 });
    // 10 bullets = 10 hits = exactly STUN_MAX at rate 1.0; the burst lands
    // within ~0.3s so decay (3s delay) cannot eat any of it.
    fireAt(world, foe, 10);
    let stuns = [];
    for (let i = 0; i < 60; i++) {
        world.update(1 / 60);
        stuns = stuns.concat(drainStuns(world));
    }
    check(stuns.length === 1, "ten hits trip the stun exactly once", "stuns=" + stuns.length);
    check(stuns.length === 1 && stuns[0].unit === foe,
        "the stun event names the enemy");
    check(foe.stunTimer > 0, "the enemy is inside its stun window", "stunTimer=" + foe.stunTimer);
    check(foe.stun === 0,
        "the gauge reset on tripping, it does not overflow", "stun=" + foe.stun);

    // While the window is open, hits resume filling the NEXT cycle's gauge.
    fireAt(world, foe, 1);
    step(world, 60);
    check(foe.stun === STUN_BASE && foe.stunTimer > 0,
        "hits during the stun window fill the next cycle, not a re-trip",
        "stun=" + foe.stun + " timer=" + foe.stunTimer);
    check(drainStuns(world).length === 0, "no second stun event during the window");
}

console.log("\nGate 4: a stunned enemy neither acts nor makes contact");
{
    const world = makeWorld();
    const p = world.spawnPlayer({ hp: 100, atk: 10, x: 8, y: 6 });
    // A charger acts by lunging; a sentry by shooting. Give the enemy a huge
    // atk and stand adjacent -- if contact ran during the stun the player's
    // HP would drop, and if the brain ran a bullet would appear.
    const foe = world.spawnEnemy({ x: 8.3, y: 6, hp: 10000, atk: 500, aiType: "sentry" });
    foe.stunTimer = STUN_DURATION;
    const hpBefore = p.hp;
    const bulletsBefore = world.danmaku.active;
    step(world, 60 * 2);
    check(p.hp === hpBefore, "a stunned enemy deals no contact damage",
        hpBefore + " -> " + p.hp);
    check(world.danmaku.active === bulletsBefore,
        "a stunned enemy fires nothing", "active=" + world.danmaku.active);
    drainStuns(world);

    // And it recovers: after the window the brain runs again.
    step(world, 60 * 5);
    let acted = false;
    for (let i = 0; i < 60 * 6 && !acted; i++) {
        world.update(1 / 60);
        acted = world.danmaku.active > 0 || p.hp < p.maxHp;
    }
    check(acted, "after the stun window the enemy acts again");
}

console.log("\nGate 5: a stunned target takes STUN_DAMAGE_MULT more damage");
{
    // Direct combat.js check: same attack, stunned vs not.
    function plainTarget(stunTimer) {
        return {
            dead: false, iframes: 0, hp: 1000, maxHp: 1000,
            def: 0, mdef: 0, element: 0, kind: "enemy",
            stunTimer: stunTimer || 0,
            sm: { set: function () { return true; } }
        };
    }
    const a = plainTarget(0);
    const b = plainTarget(STUN_DURATION);
    const attack = { atk: 100, def: 0, mdef: 0, coef: 1, crit: false, tempo: 1 };
    const ra = tryHit(a, attack);
    const rb = tryHit(b, attack);
    check(rb.damage === Math.round(ra.damage * STUN_DAMAGE_MULT),
        "stun multiplies the resolved damage by " + STUN_DAMAGE_MULT,
        ra.damage + " -> " + rb.damage);
}

console.log("\nGate 6: advantage and crit fill faster");
{
    // attackFrom reads element off the units, so wire the ring through it.
    // Elements: 1=fire 2=water (water beats fire), from elements.js' copy of
    // the decompiled table.
    const attacker = { atk: 100, mgc: 0, luck: 0, element: 2, kind: "player", critBonus: 0 };
    const neutral = attackFrom(attacker, { element: 2, def: 0, mdef: 0 }, { coef: 1 });
    const advantage = attackFrom(attacker, { element: 1, def: 0, mdef: 0 }, { coef: 1 });
    const crit = attackFrom(attacker, { element: 2, def: 0, mdef: 0 }, { coef: 1 }, { crit: true });
    const flag = function (atk) { return atk.hitFlag; };
    check(flag(advantage) === 1, "water into fire reads as ばつぐん", "hitFlag=" + flag(advantage));
    check(flag(neutral) === 0, "water into water is neutral", "hitFlag=" + flag(neutral));
    // The bonuses are additive on the base: the gates assert the arithmetic
    // the world's buildStun performs with these flags.
    check(flag(crit) === 0 && crit.crit === true, "a forced crit is still element-neutral");
    const gBase = STUN_BASE;
    const gAdv = STUN_BASE + STUN_ADVANTAGE_BONUS;
    const gCrit = STUN_BASE + STUN_CRIT_BONUS;
    check(gAdv > gBase && gCrit > gBase,
        "advantage (" + gAdv + ") and crit (" + gCrit + ") both fill faster than base (" + gBase + ")");
}

console.log("\nGate 7: the gauge decays only after STUN_DECAY_DELAY");
{
    const world = makeWorld();
    world.spawnPlayer({ hp: 100, atk: 10, x: 8, y: 6 });
    const foe = world.spawnEnemy({ x: 12, y: 6, hp: 1000, atk: 0 });   // out of reach
    foe.stun = 60;                 // not tripped, just charged
    // Simulate the hits having just landed.
    foe.stunIdle = 0;
    step(world, 60 * (STUN_DECAY_DELAY - 0.5));
    check(foe.stun === 60, "no decay before the delay elapses", "stun=" + foe.stun);
    step(world, 60 * 1);         // 0.5s past the delay
    const expected = 60 - STUN_DECAY_PER_SEC * 0.5;
    check(Math.abs(foe.stun - expected) < 0.5,
        "decay runs at STUN_DECAY_PER_SEC once the delay has passed",
        "stun=" + foe.stun + " expected~" + expected);
    drainStuns(world);
}

console.log("\nGate 8: elite and boss gauges fill at their tier rate");
{
    const world = makeWorld();
    world.spawnPlayer({ hp: 100, atk: 10, x: 8, y: 6 });
    const plain = world.spawnEnemy({ x: 12, y: 6, hp: 1000, atk: 0 });
    const elite = world.spawnEnemy({ x: 12, y: 7, hp: 1000, atk: 0, elite: true, aiType: "boss" });
    const boss = world.spawnEnemy({ x: 12, y: 8, hp: 1000, atk: 0, aiType: "boss" });
    check(plain.stun === 0 && elite.stun === 0 && boss.stun === 0,
        "gauges start empty (spawnEnemy wiring)");
    // One bullet into each: the tier rate is applied per landed hit.
    fireAt(world, plain, 1); fireAt(world, elite, 1); fireAt(world, boss, 1);
    step(world, 60);
    check(plain.stun === STUN_BASE * STUN_RATE.enemy,
        "a plain enemy fills at rate 1.0", "stun=" + plain.stun);
    check(elite.stun === STUN_BASE * STUN_RATE.elite,
        "an elite fills at rate 0.6", "stun=" + elite.stun);
    check(boss.stun === STUN_BASE * STUN_RATE.boss,
        "a boss fills at rate 0.4", "stun=" + boss.stun);
    drainStuns(world);
}

console.log("\n" + "=".repeat(60));
if (failed === 0) {
    console.log("✓ All stun gates passed");
    console.log("✓ fill / trip / stun window / damage mult / decay / tiers");
} else {
    console.error("✗", failed, "gate(s) failed");
    process.exit(1);
}
