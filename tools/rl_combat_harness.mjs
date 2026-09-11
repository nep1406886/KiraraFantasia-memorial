// Harness for game/rl combat: hit windows and i-frames (master plan 阶段 1).
//
//   node tools/rl_combat_harness.mjs
//
// 1. Melee boundaries (semantics fixed by combat.js inMeleeArc):
//      hit iff the target's circular body intersects the finite swing sector.
//    Range boundary: enemy radius 0.5, range 1.6 -> edge at 2.1. 2.05 hits,
//    2.15 misses. Half-arc 50°: a body at 60° overlaps, at 84° it misses.
// 2. The hit window opens at attackHitStart and closes at attackHitEnd —
//    ticks before/after it do no damage.
// 3. One swing hits each enemy exactly once even though the window spans
//    many ticks.
// 4. i-frames: during dodge, repeated contact checks resolve zero damage;
//    after they expire, the same contact lands.
// 5. Dead enemies take no further hits and stay dead.
// 6. Damage floor: atk 1 vs def 99 still deals 1.

import { createWorld } from "../site/game/rl/world.js";
import { PLAYER_TIMING } from "../site/game/rl/actorstate.js";
import { resolveDamage, inMeleeArc } from "../site/game/rl/combat.js";

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

function freshInput() {
    return { move: { x: 0, y: 0 }, attack: false, dodge: false, skill: [false, false, false], ultimate: false, menu: false };
}

function tick(world, n) {
    for (let i = 0; i < n; i++) { world.update(1 / 60); }
}

const DEG = Math.PI / 180;

// --- 0. pure arc predicate boundary (no state machine involved) -----------

{
    const attacker = { x: 0, y: 0, facing: 0 };
    const mk = (dist, angleDeg) => ({
        x: Math.cos(angleDeg * DEG) * dist,
        y: Math.sin(angleDeg * DEG) * dist,
        radius: 0.5
    });
    const R = PLAYER_TIMING.attackRange;
    const ARC = PLAYER_TIMING.attackArc;

    check("arc: dist 2.05 (inside range+radius 2.1) hits",
        inMeleeArc(attacker, mk(2.05, 0), R, ARC) === true);
    check("arc: dist 2.15 (outside range+radius 2.1) misses",
        inMeleeArc(attacker, mk(2.15, 0), R, ARC) === false);
    check("arc: 40° off facing (half-arc 50°) hits",
        inMeleeArc(attacker, mk(1.0, 40), R, ARC) === true);
    check("arc: body at 60° overlaps the radial blade edge",
        inMeleeArc(attacker, mk(1.0, 60), R, ARC) === true);
    check("arc: body at 84° stays outside the radial blade edge",
        inMeleeArc(attacker, mk(1.0, 84), R, ARC) === false);
    check("arc: the finite radial endpoint does not extend the blade",
        inMeleeArc(attacker, mk(2.1, 60), R, ARC) === false);
    check("arc: behind (180°) misses",
        inMeleeArc(attacker, mk(1.0, 180), R, ARC) === false);
    // vacuity guard: a degenerate 360° arc would make the 60°/180° checks
    // pass too, so prove the arc actually constrains: at 360°, 60° would hit.
    check("vacuity guard: a 360° arc WOULD hit at 60°",
        inMeleeArc(attacker, mk(1.0, 60), R, Math.PI * 2) === true);
}

// --- 1. the swing hit window ----------------------------------------------

{
    const world = createWorld({ width: 30, height: 30 });
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({ x: 15, y: 15 });
    const e = world.spawnEnemy({ model: "x", x: 16.2, y: 15, hp: 100 });

    input.attack = true;
    world.update(1 / 60);
    input.attack = false;
    // 0.12s = 7.2 ticks; tick 7 of the swing is the first that can damage.
    tick(world, 6);   // total swing time 7/60 < 0.12
    check("before the hit window: no damage", e.hp === 100, "hp=" + e.hp);
    tick(world, 5);   // now inside [0.12, 0.30]
    check("inside the hit window: damage landed", e.hp === 99, "hp=" + e.hp);
    tick(world, 30);  // long past the window
    check("after the window: no further damage from the same swing", e.hp === 99, "hp=" + e.hp);
}

// --- 2. one swing, one hit per enemy ---------------------------------------

{
    const world = createWorld({ width: 30, height: 30 });
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({ x: 15, y: 15 });
    const e1 = world.spawnEnemy({ model: "x", x: 16.2, y: 15, hp: 100 });
    const e2 = world.spawnEnemy({ model: "x", x: 13.8, y: 15, hp: 100 });
    // e2 is behind the player (facing +x): it must NOT be hit
    input.attack = true;
    world.update(1 / 60);
    input.attack = false;
    tick(world, 30);
    check("enemy in front damaged exactly once", e1.hp === 99, "hp=" + e1.hp);
    check("enemy behind untouched", e2.hp === 100, "hp=" + e2.hp);
    check("enemy behind not dead-flagged", e2.dead === false);
}

// --- 3. i-frames: repeated contact resolves once -----------------------------

{
    const world = createWorld({ width: 30, height: 30 });
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({ x: 15, y: 15, hp: 10 });
    const e = world.spawnEnemy({ model: "x", x: 15.6, y: 15, hp: 100 });

    // standing next to the enemy without dodging: contact hits land
    tick(world, 1);
    check("contact damage lands when vulnerable", p.hp === 9, "hp=" + p.hp);
    // post-hit invulnerability (0.6s = 36 ticks) AND the enemy's own contact
    // cooldown (0.8s = 48 ticks) must both expire before the next hit
    tick(world, 35);
    check("post-hit invuln blocks repeated contact", p.hp === 9, "hp=" + p.hp);
    tick(world, 20);
    check("after invuln and contact cooldown expire, contact lands again",
        p.hp === 8, "hp=" + p.hp);
}

// --- 4. dodge i-frames specifically -----------------------------------------

{
    const world = createWorld({ width: 30, height: 30 });
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({ x: 15, y: 15, hp: 10 });
    const e = world.spawnEnemy({ model: "x", x: 15.6, y: 15, hp: 100 });

    input.dodge = true;
    world.update(1 / 60);
    input.dodge = false;
    check("dodge started", p.sm.state === "dodge");
    // dodge dir = facing = +x, but movement clamps at the wall far away; the
    // enemy's contact check still runs every tick while iframes are up
    tick(world, 20);   // 0.35s worth of ticks, all inside the i-frame window
    check("no contact damage during dodge i-frames", p.hp === 10, "hp=" + p.hp);
    check("dodge iframes still active mid-dodge", p.iframes > 0, "iframes=" + p.iframes);
    tick(world, 60);
    check("i-frames fully expired after the dodge", p.iframes === 0);
    // the dodge burst carried the player out of contact range; step back in
    // and confirm the world still resolves contact normally afterwards
    // overlap by 0.01 so the contact check is unambiguously in range
    p.x = e.x - (e.radius + p.radius) + 0.01;
    p.y = e.y;
    tick(world, 2);
    check("contact damage resumes after i-frames", p.hp < 10, "hp=" + p.hp);
}

// --- 5. death is terminal ------------------------------------------------------

{
    const world = createWorld({ width: 30, height: 30 });
    const input = freshInput();
    world.inputState = input;
    const p = world.spawnPlayer({ x: 15, y: 15 });
    const e = world.spawnEnemy({ model: "x", x: 16.2, y: 15, hp: 1 });

    input.attack = true;
    world.update(1 / 60);
    input.attack = false;
    tick(world, 10);
    check("enemy died from the killing swing", e.dead === true && e.hp === 0);
    check("dead enemy state machine is in dead", e.sm.state === "dead", e.sm.state);
    const hpBefore = e.hp;
    // keep swinging at the corpse
    input.attack = true;
    world.update(1 / 60);
    input.attack = false;
    tick(world, 30);
    check("dead enemy takes no further hits", e.hp === hpBefore, "hp=" + e.hp);
}

// --- 6. damage floor -----------------------------------------------------------

{
    const floor = resolveDamage({ atk: 1, def: 99 });
    check("atk 1 vs def 99 deals exactly 1", floor === 1, "damage=" + floor);
    const normal = resolveDamage({ atk: 5, def: 0 });
    check("atk 5 vs def 0 deals 5", normal === 5, "damage=" + normal);
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall combat checks passed");
process.exit(failures ? 1 : 0);
