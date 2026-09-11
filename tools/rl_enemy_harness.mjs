// Harness for the enemy layer -- game/rl/enemyai.js and the danmaku contract
// it drives (master plan 阶段 3 acceptance).
//
//   node tools/rl_enemy_harness.mjs
//
// What it gates:
//
// 1. The shipped tables only ever name behaviour this code implements: every
//    encounters.json aiType is one of the three, every attack pattern is a
//    danmaku.js PATTERNS entry or the melee "charge", and nothing slips past
//    skills.js's two cuts -- the confusion self-hit 999999 and SANE_ENEMY_COEF,
//    which exists for exactly two scripted rows (メカこけし's 英国式イレイザー
//    ショット at coef 30 and ハイプリス's 絶望の世界 at 9.999).
// 2. actionInterval reads cadence out of the row's own Spd, and a boss's phase
//    is also its tempo.
// 3. sentry: holds position, telegraphs, then fires -- with the telegraph
//    longer than the player's dodge, which is the whole dodge contract.
// 4. charger: the lunge commits to where the player stood when the telegraph
//    began, so walking during the tell beats it; a charger with nothing in
//    reach falls back to something ranged instead of freezing.
// 5. boss: phases on HP, tightens cadence, escalates ring -> spiral, asks the
//    world for reinforcements on a flip, and never flinches out of a telegraph.
// 6. The emit(pattern, origin, mods) contract: the bullet count each pattern
//    lays down, the offence snapshot that lands on every bullet, unknown
//    patterns creating nothing, and the pool draining back to zero after an
//    AI-driven fight.
//
// enemyai takes *a* world, not the world: it only ever touches player,
// enemies, events, rng, danmaku, width, height and requestSummon, so a stub is
// the honest unit under test. world.js's own wiring is gated separately by
// tools/rl_move_harness.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
    createStateMachine, ENEMY_STATES, BOSS_STATES, ENEMY_TIMING, PLAYER_TIMING
} from "../site/game/rl/actorstate.js";
import {
    enemyai, actionInterval, decayKnockback, SPD_BASELINE, BOSS_PHASES
} from "../site/game/rl/enemyai.js";
import {
    enemyMoveset, contactCoefOf, CONFUSION_SKILL_ID, SANE_ENEMY_COEF
} from "../site/game/rl/skills.js";
import { createDanmaku, PATTERNS, DANMAKU_DEFAULTS } from "../site/game/rl/danmaku.js";
import { ROOM_SIZE } from "../site/game/rl/dungeon.js";
import { createRandom } from "../site/game/rl/random.js";
import { CONTACT_FALLBACK_COEF, angleDiff, tryHit } from "../site/game/rl/combat.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

function table(name) {
    return JSON.parse(readFileSync(join(ROOT, "asset", "rl", name), "utf8"));
}
const skillTable = table("skills-rl.json");
const encounters = table("encounters.json").volumes;

// Every enemy the campaign can spawn, flattened once.
const allSpecs = [];
encounters.forEach(function (vol) {
    allSpecs.push(vol.boss);
    vol.elites.forEach(function (e) { allSpecs.push(e); });
    vol.mobs.forEach(function (m) { allSpecs.push(m); });
});

// --- the unit under test ----------------------------------------------------

// The enemy shape world.js builds at spawn, with only the fields enemyai and
// combat.js read. Stats are literals here on purpose: this file gates
// behaviour, and asset/rl/stats.js is gated by rl_stats_harness.mjs.
function mkEnemy(over) {
    const spec = Object.assign({
        id: 1, x: 8, y: 6, radius: 0.5, facing: Math.PI,
        hp: 1000, maxHp: 1000,
        atk: 300, mgc: 300, def: 50, mdef: 50, spd: SPD_BASELINE,
        element: 0, aiType: "sentry", phase: 1,
        turnSeconds: skillTable.turnSeconds,
        moveset: { attacks: [], support: [], gimmicks: [] },
        iframes: 0, dead: false, contactCooldown: 0, kx: 0, ky: 0,
        actionTimer: 0, pending: null, aimAt: null, dash: null
    }, over || {});
    spec.kind = "enemy";
    spec.sm = createStateMachine("idle",
        spec.aiType === "boss" ? BOSS_STATES : ENEMY_STATES);
    return spec;
}

function mkPlayer(over) {
    const p = Object.assign({
        id: 99, kind: "player", x: 4, y: 6, radius: 0.45, facing: 0,
        hp: 100000, maxHp: 100000,
        atk: 100, mgc: 100, def: 10, mdef: 10, element: 0, luck: 0,
        iframes: 0, dead: false
    }, over || {});
    p.sm = createStateMachine("idle", ENEMY_STATES);   // only "hit"/"dead" matter
    return p;
}

function stubWorld(over) {
    const rng = createRandom(20260902);
    const world = Object.assign({
        width: ROOM_SIZE.w, height: ROOM_SIZE.h,
        player: null, enemies: [], events: [],
        rng: rng, danmaku: createDanmaku({}), summons: []
    }, over || {});
    world.requestSummon = function (unit, phase) {
        world.summons.push({ id: unit.id, phase: phase });
    };
    return world;
}

// world.js's update order, so the harness measures the same sequencing the
// game does: the state machine advances, then the AI decides.
function tick(world, dt) {
    world.enemies.forEach(function (e) {
        if (e.dead) { return; }
        e.iframes = Math.max(0, e.iframes - dt);
        e.contactCooldown = Math.max(0, e.contactCooldown - dt);
        e.sm.update(dt);
        enemyai(e, world, dt);
        decayKnockback(e, dt, world);
    });
    if (world.danmaku) {
        world.danmaku.update(dt, {
            width: world.width, height: world.height,
            player: world.player, enemies: world.enemies
        });
    }
}

function events(world, type) {
    return world.events.filter(function (e) { return e.type === type; });
}

// --- 1. the shipped tables name only implemented behaviour -------------------

{
    const AI_TYPES = ["sentry", "charger", "boss"];
    const MELEE = "charge";
    const badAi = allSpecs.filter(function (s) { return AI_TYPES.indexOf(s.aiType) < 0; });
    check("every encounters.json aiType is one of the three", badAi.length === 0,
        badAi.map(function (s) { return s.name + ":" + s.aiType; }).join(",")
            || allSpecs.length + " specs");

    const badPattern = [];
    const overCoef = [];
    const confusion = [];
    let noAttacks = 0;
    const gimmicks = [];
    allSpecs.forEach(function (spec) {
        const ms = enemyMoveset(skillTable, spec.skills);
        ms.attacks.forEach(function (a) {
            if (PATTERNS.indexOf(a.pattern) < 0 && a.pattern !== MELEE) {
                badPattern.push(spec.name + ":" + a.pattern);
            }
            if (a.coef > SANE_ENEMY_COEF) {
                overCoef.push(spec.name + ":" + a.name + "=" + a.coef);
            }
        });
        ms.attacks.concat(ms.support).forEach(function (a) {
            if (a.id === CONFUSION_SKILL_ID) { confusion.push(spec.name); }
        });
        if (!ms.attacks.length) { noAttacks += 1; }
        ms.gimmicks.forEach(function (g) {
            gimmicks.push({ owner: spec.name, name: g.name, coef: g.coef });
        });
    });
    check("every attack pattern is a danmaku pattern or the melee lunge",
        badPattern.length === 0, badPattern.join(",") || PATTERNS.join("/") + "/charge");
    check("no attack survives above SANE_ENEMY_COEF " + SANE_ENEMY_COEF,
        overCoef.length === 0, overCoef.join(",") || "0 of " + allSpecs.length);
    check("the confusion self-hit " + CONFUSION_SKILL_ID + " is never an AI option",
        confusion.length === 0, confusion.join(",") || "cut from all specs");

    // The cut has to *fire*, and it has to fire on the whole table rather than
    // on whichever rows this month's encounter dials happen to select. Four of
    // the 335 shipped rows are scripted battle-enders; the highest real attack
    // is 0.6, so the cap at 1.0 sits in an empty band and the gate asserts both
    // of its edges.
    const enemyRows = Object.keys(skillTable.enemy);
    const above = enemyRows.filter(function (id) {
        return (skillTable.enemy[id].coef || 0) > SANE_ENEMY_COEF;
    });
    let topSurvivor = 0;
    enemyRows.forEach(function (id) {
        const coef = skillTable.enemy[id].coef || 0;
        if (coef <= SANE_ENEMY_COEF && coef > topSurvivor) { topSurvivor = coef; }
    });
    const SCRIPTED = ["12017", "12034", "83023", "19050"];
    check("the four scripted rows are the only ones above the cap",
        above.length === SCRIPTED.length
            && SCRIPTED.every(function (id) { return above.indexOf(id) >= 0; }),
        above.map(function (id) {
            return id + "=" + skillTable.enemy[id].coef;
        }).join(" ") || "none");
    check("the cap sits in the gap above every real attack",
        topSurvivor < SANE_ENEMY_COEF,
        "top survivor " + topSurvivor + " < cap " + SANE_ENEMY_COEF
            + " < lowest cut " + Math.min.apply(null, above.map(function (id) {
                return skillTable.enemy[id].coef;
            })));
    // 英国式イレイザーショット is the row skills.js names by hand; assert the cut
    // through the public API, not by reading the table twice.
    const eraser = enemyMoveset(skillTable, [19050]);
    check("enemyMoveset cuts 英国式イレイザーショット (coef 30) to gimmicks",
        eraser.attacks.length === 0 && eraser.gimmicks.length === 1
            && eraser.gimmicks[0].coef === 30,
        "attacks=" + eraser.attacks.length + " gimmicks=" + eraser.gimmicks.length);

    // The hazard the cut creates: a unit whose only damage rows were scripted
    // would stand there forever. Every campaign spec that loses rows must keep
    // real ones.
    const disarmed = allSpecs.filter(function (spec) {
        const ms = enemyMoveset(skillTable, spec.skills);
        return ms.gimmicks.length > 0 && ms.attacks.length === 0;
    });
    check("the cut never disarms a unit", disarmed.length === 0,
        disarmed.map(function (s) { return s.name; }).join(",")
            || gimmicks.length + " cut rows across "
                + new Set(gimmicks.map(function (g) { return g.owner; })).size + " units");

    // Body contact: a positive coefficient out of the row's own list, or the
    // table-sourced fallback for the rows that carry no attack at all.
    const badContact = allSpecs.filter(function (spec) {
        const coef = contactCoefOf(enemyMoveset(skillTable, spec.skills));
        return coef < 0 || coef > SANE_ENEMY_COEF;
    });
    check("contactCoefOf stays inside the sane band", badContact.length === 0,
        badContact.map(function (s) { return s.name; }).join(",")
            || noAttacks + " specs fall back to " + CONTACT_FALLBACK_COEF);
}

// --- 2. cadence comes out of the row's own Spd -------------------------------

{
    const turn = skillTable.turnSeconds;
    check("skills-rl.json ships turnSeconds", turn > 0, "turnSeconds=" + turn);
    const base = mkEnemy({ spd: SPD_BASELINE });
    check("a median-Spd enemy acts once per shipped turn",
        Math.abs(actionInterval(base) - turn) < 1e-9,
        actionInterval(base).toFixed(3) + "s vs turnSeconds " + turn);
    const fast = mkEnemy({ spd: SPD_BASELINE * 2 });
    const slow = mkEnemy({ spd: SPD_BASELINE / 2 });
    check("twice the Spd is twice the cadence",
        Math.abs(actionInterval(fast) - turn / 2) < 1e-9,
        actionInterval(fast).toFixed(3) + "s");
    check("half the Spd is half the cadence",
        Math.abs(actionInterval(slow) - turn * 2) < 1e-9,
        actionInterval(slow).toFixed(3) + "s");
    const zero = mkEnemy({ spd: 0 });
    check("a missing Spd falls back to the baseline, never to a divide by zero",
        Math.abs(actionInterval(zero) - turn) < 1e-9, actionInterval(zero) + "s");

    // A boss's phase is also its tempo (enemyai's own comment): phase 2 acts
    // twice per turn, phase 3 three times.
    const intervals = [1, 2, 3].map(function (phase) {
        return actionInterval(mkEnemy({ aiType: "boss", phase: phase }));
    });
    check("a boss's phase divides its interval",
        Math.abs(intervals[0] - turn) < 1e-9
            && Math.abs(intervals[1] - turn / 2) < 1e-9
            && Math.abs(intervals[2] - turn / 3) < 1e-9,
        intervals.map(function (v) { return v.toFixed(2) + "s"; }).join(" > "));
    check("phase never divides a non-boss interval",
        Math.abs(actionInterval(mkEnemy({ aiType: "sentry", phase: 3 })) - turn) < 1e-9);
}

// --- 3. sentry: hold position, telegraph, fire --------------------------------

const AIMED = { id: 1, name: "test aimed", target: 1, coef: 0.2, magic: false, pattern: "aimed", sap: "" };
const RING = { id: 2, name: "test ring", target: 2, coef: 0.15, magic: true, pattern: "ring", sap: "" };
const CHARGE = { id: 3, name: "test charge", target: 1, coef: 0.3, magic: false, pattern: "charge", sap: "" };
// enemyai's PATTERN_MODS leaves the spiral's steps at the danmaku default, so a
// spiral lays down arms x steps bullets; the boss assertions read the arm count
// through this rather than hardcoding the product.
const PATTERN_STEPS = DANMAKU_DEFAULTS.steps;

{
    check("the telegraph outlasts the player's dodge (the dodge contract)",
        ENEMY_TIMING.telegraph > PLAYER_TIMING.dodgeDuration,
        ENEMY_TIMING.telegraph + "s tell vs " + PLAYER_TIMING.dodgeDuration + "s dodge");

    const world = stubWorld();
    world.player = mkPlayer({ x: 8, y: 2 });      // due north of the enemy
    const e = mkEnemy({ moveset: { attacks: [AIMED], support: [], gimmicks: [] } });
    world.enemies = [e];
    const x0 = e.x;
    const y0 = e.y;
    let moved = 0;
    const states = [];
    for (let i = 0; i < 600; i++) {               // 10 s at 60 Hz
        tick(world, 1 / 60);
        moved = Math.max(moved, Math.hypot(e.x - x0, e.y - y0));
        if (states[states.length - 1] !== e.sm.state) { states.push(e.sm.state); }
    }
    check("a sentry never moves", moved === 0, "max displacement " + moved);
    // faceToward accumulates, so the raw radian can leave (-pi, pi]; what the
    // view and every geometry test read is the direction.
    check("a sentry turns to face the player",
        Math.abs(angleDiff(e.facing, -Math.PI / 2)) < 0.05,
        "facing " + e.facing.toFixed(3) + " want " + (-Math.PI / 2).toFixed(3)
            + " (off by " + angleDiff(e.facing, -Math.PI / 2).toFixed(4) + ")");
    const tells = events(world, "telegraph");
    const shots = events(world, "enemySkill");
    check("a sentry telegraphs before every shot",
        tells.length > 0 && shots.length > 0 && tells.length >= shots.length,
        tells.length + " tells / " + shots.length + " shots in 10s");
    // The first decision lands on the first tick, so the first state sampled
    // after a tick is already the telegraph.
    check("the telegraph precedes the skill state",
        states.slice(0, 3).join(">") === "telegraph>skill>idle", states.slice(0, 5).join(">"));
    check("every shot laid down bullets",
        shots.every(function (s) { return s.bullets >= 1; }),
        shots.map(function (s) { return s.pattern + ":" + s.bullets; }).slice(0, 4).join(" "));
    // Cadence: one decision per actionInterval, so 10 s at Spd 100 is 3-4 tells.
    check("the shot cadence matches actionInterval",
        tells.length === Math.floor(10 / actionInterval(e)) + 1,
        tells.length + " tells, interval " + actionInterval(e).toFixed(2) + "s");
}

{
    // A sentry that only owns a melee row still fights: enemyai rewrites the
    // pattern to an aimed shot rather than dropping the skill.
    const world = stubWorld();
    world.player = mkPlayer({ x: 4, y: 6 });
    const e = mkEnemy({ moveset: { attacks: [CHARGE], support: [], gimmicks: [] } });
    world.enemies = [e];
    let sawDash = false;
    for (let i = 0; i < 240; i++) {
        tick(world, 1 / 60);
        if (e.sm.state === "dash") { sawDash = true; }
    }
    const shots = events(world, "enemySkill");
    check("a sentry never lunges, even holding a charge row", !sawDash && !e.dash);
    check("its charge row is fired as an aimed shot instead",
        shots.length > 0 && shots.every(function (s) { return s.pattern === "aimed"; }),
        shots.map(function (s) { return s.pattern; }).join(",") || "no shots");
}

// --- 4. charger: the lunge commits to the snapshot ----------------------------

// Runs one charger against a player that either holds still or walks away the
// moment the telegraph goes up, and reports what the lunge did.
function lungeRun(walkAway) {
    const world = stubWorld();
    const p = mkPlayer({ x: 4, y: 6 });
    world.player = p;
    const e = mkEnemy({
        aiType: "charger", x: 8, y: 6,
        moveset: { attacks: [CHARGE], support: [], gimmicks: [] }
    });
    world.enemies = [e];
    const dt = 1 / 60;
    let closest = Infinity;
    const states = [];
    for (let i = 0; i < 120; i++) {                 // 2 s: tell + dash + recover
        // The read: the player only starts moving once the tell is up, and
        // walks at the shipped move speed -- no teleporting out of the line.
        if (walkAway && e.sm.state === "telegraph") {
            p.y += PLAYER_TIMING.moveSpeed * dt;
        }
        tick(world, dt);
        if (states[states.length - 1] !== e.sm.state) { states.push(e.sm.state); }
        if (e.sm.state === "dash") {
            closest = Math.min(closest, Math.hypot(p.x - e.x, p.y - e.y));
        }
    }
    return {
        world: world, enemy: e, player: p, closest: closest, states: states,
        dashes: events(world, "dash"), hits: events(world, "hit")
    };
}

{
    const still = lungeRun(false);
    check("a charger lunges at a charge row", still.dashes.length >= 1,
        still.dashes.length + " lunges in 2s");
    check("the lunge passes through a player who stands there",
        still.hits.length === 1 && still.hits[0].damage > 0,
        still.hits.length + " hits, damage "
            + (still.hits[0] ? still.hits[0].damage : "-")
            + ", closest approach " + still.closest.toFixed(2));
    check("the lunge travelled past the player, not up to them",
        still.enemy.x < still.player.x,
        "ended at x=" + still.enemy.x.toFixed(2)
            + " vs player x=" + still.player.x.toFixed(2));

    const walked = lungeRun(true);
    check("walking during the tell beats the lunge (the snapshot contract)",
        walked.dashes.length >= 1 && walked.hits.length === 0,
        walked.dashes.length + " lunges, " + walked.hits.length
            + " hits, closest approach " + walked.closest.toFixed(2));
    check("the lunge still committed to where the player stood",
        Math.abs(walked.enemy.y - 6) < 0.01 && walked.player.y > 6.9,
        "lunge held y=" + walked.enemy.y.toFixed(2)
            + " while the player reached y=" + walked.player.y.toFixed(2));
    check("the lunge is spent after one pass-through",
        still.hits.length === 1 && still.enemy.dash && still.enemy.dash.hit === true,
        "one hit out of " + Math.round(ENEMY_TIMING.dash * 60) + " dash frames");
    // The lunge's price: a charger that commits is open through the recover
    // window, which is where the player's swing goes. "skill" never shows up in
    // the trace because the lunge starts on the same tick the skill window
    // opens -- the state machine passes straight through it.
    check("a lunge costs the charger a recover window",
        walked.states.slice(0, 4).join(">") === "telegraph>dash>recover>idle",
        walked.states.slice(0, 4).join(">"));
}

{
    // Out of lunge reach (>7.5): a charger that owns anything ranged fires it
    // rather than lunging into empty floor.
    const world = stubWorld();
    world.player = mkPlayer({ x: 2, y: 6 });
    const e = mkEnemy({
        aiType: "charger", x: 14, y: 6,
        moveset: { attacks: [CHARGE, RING], support: [], gimmicks: [] }
    });
    world.enemies = [e];
    for (let i = 0; i < 600; i++) { tick(world, 1 / 60); }
    const shots = events(world, "enemySkill");
    check("an out-of-reach charger shoots instead of lunging",
        events(world, "dash").length === 0 && shots.length > 0
            && shots.every(function (s) { return s.pattern === "ring"; }),
        shots.length + " shots ("
            + shots.map(function (s) { return s.pattern; }).join(",")
            + "), " + events(world, "dash").length + " lunges at range "
            + Math.hypot(14 - 2, 0).toFixed(1));
}

{
    // The same charger with nothing but the lunge waits a half beat and retries;
    // it must not freeze, and it must not lunge from across the room either.
    const world = stubWorld();
    const p = mkPlayer({ x: 2, y: 6 });
    world.player = p;
    const e = mkEnemy({
        aiType: "charger", x: 14, y: 6,
        moveset: { attacks: [CHARGE], support: [], gimmicks: [] }
    });
    world.enemies = [e];
    for (let i = 0; i < 180; i++) { tick(world, 1 / 60); }
    check("a charger with nothing in reach neither lunges nor shoots",
        events(world, "dash").length === 0 && events(world, "enemySkill").length === 0,
        "after 3s out of reach");
    check("it retries on a half beat rather than freezing",
        e.actionTimer <= actionInterval(e) * 0.5 + 1e-9,
        "timer " + e.actionTimer.toFixed(2) + "s <= half of "
            + actionInterval(e).toFixed(2) + "s");
    // Walk into reach: the wait was a wait, not a deadlock.
    p.x = 10;
    for (let i = 0; i < 180; i++) { tick(world, 1 / 60); }
    check("it lunges once the player steps into reach",
        events(world, "dash").length >= 1,
        events(world, "dash").length + " lunges at range 4.0");
}

// --- 5. boss: phases on HP, escalates, calls for help -------------------------

// A boss held at one phase by its HP, run for `seconds`, reporting what it did.
function bossRun(attack, hpFrac, seconds) {
    const world = stubWorld();
    world.player = mkPlayer({ x: 4, y: 6 });
    const b = mkEnemy({
        aiType: "boss", hp: Math.round(1000 * hpFrac), maxHp: 1000,
        moveset: { attacks: [attack], support: [], gimmicks: [] }
    });
    world.enemies = [b];
    for (let i = 0; i < Math.round(seconds * 60); i++) { tick(world, 1 / 60); }
    return {
        boss: b, world: world,
        tells: events(world, "telegraph"), shots: events(world, "enemySkill")
    };
}

{
    const world = stubWorld();
    world.player = mkPlayer({ x: 4, y: 6 });
    const b = mkEnemy({
        aiType: "boss", hp: 1000, maxHp: 1000,
        moveset: { attacks: [RING], support: [], gimmicks: [] }
    });
    world.enemies = [b];
    const seen = [];
    const note = function () {
        if (seen[seen.length - 1] !== b.phase) { seen.push(b.phase); }
    };
    note();
    tick(world, 1 / 60);
    // Step the HP onto each threshold exactly: the flip is <=, so 0.7 flips.
    b.hp = Math.round(1000 * BOSS_PHASES[0]);
    tick(world, 1 / 60);
    note();
    const afterFirst = world.danmaku.active;
    b.hp = Math.round(1000 * BOSS_PHASES[1]);
    tick(world, 1 / 60);
    note();
    const flips = events(world, "bossPhase");
    check("a boss phases at " + BOSS_PHASES.join("/") + " HP",
        seen.join(">") === "1>2>3", "phases " + seen.join(">"));
    check("each flip raises exactly one bossPhase event",
        flips.length === 2 && flips[0].phase === 2 && flips[1].phase === 3,
        flips.map(function (f) { return f.phase; }).join(",") || "none");
    check("a flip clears the floor with a ring",
        afterFirst >= 16 + 2 * 4 && world.danmaku.active > afterFirst,
        afterFirst + " bullets on the first flip, "
            + world.danmaku.active + " after the second");
    check("a flip asks the world for reinforcements",
        world.summons.length === 2 && world.summons[0].phase === 2
            && world.summons[1].phase === 3 && world.summons[0].id === b.id,
        world.summons.map(function (s) { return "p" + s.phase; }).join(",") || "none");
    check("a flip costs the boss a recover beat before it acts again",
        b.actionTimer > 0, "timer " + b.actionTimer.toFixed(2) + "s");
}

{
    // Cadence: phase divides the interval, so the same window holds more tells
    // each phase -- until telegraph+skill (1.15s) becomes the floor, which is
    // the honest ceiling on how fast a telegraphing enemy can act at all.
    const counts = [1.0, BOSS_PHASES[0], BOSS_PHASES[1]].map(function (frac) {
        return bossRun(RING, frac, 8).tells.length;
    });
    check("a boss tightens its cadence phase over phase",
        counts[0] < counts[1] && counts[1] < counts[2],
        counts.join(" < ") + " tells in 8s (floor "
            + (ENEMY_TIMING.telegraph + ENEMY_TIMING.skill).toFixed(2) + "s)");

    // Escalation: a ring becomes a spiral from phase 2, with an extra arm per
    // phase; an aimed shot becomes a burst of 1+phase.
    const rings = [1.0, BOSS_PHASES[0], BOSS_PHASES[1]].map(function (frac) {
        return bossRun(RING, frac, 2).shots[0] || { pattern: "-", bullets: 0 };
    });
    check("a boss's ring becomes a spiral from phase 2",
        rings[0].pattern === "ring" && rings[1].pattern === "spiral"
            && rings[2].pattern === "spiral",
        rings.map(function (s) { return s.pattern + ":" + s.bullets; }).join(" > "));
    check("each phase adds an arm to the spiral",
        rings[1].bullets === 4 * PATTERN_STEPS && rings[2].bullets === 5 * PATTERN_STEPS,
        rings[1].bullets + " then " + rings[2].bullets + " bullets ("
            + PATTERN_STEPS + " steps per arm)");
    const bursts = [1.0, BOSS_PHASES[0], BOSS_PHASES[1]].map(function (frac) {
        return (bossRun(AIMED, frac, 2).shots[0] || { bullets: 0 }).bullets;
    });
    check("a boss's aimed shot becomes a burst of 1+phase",
        bursts.join(",") === "2,3,4", bursts.join(","));
}

{
    // A boss never flinches: BOSS_STATES has no damage state, so a hit lands but
    // cannot cancel a telegraph. Otherwise the player's ~0.62s swing cadence
    // would stunlock every boss out of every attack it ever tried.
    const world = stubWorld();
    world.player = mkPlayer({ x: 4, y: 6 });
    const b = mkEnemy({
        aiType: "boss", hp: 100000, maxHp: 100000,
        moveset: { attacks: [AIMED], support: [], gimmicks: [] }
    });
    world.enemies = [b];
    let hitWhileTelling = false;
    let refused = null;
    let stateDuringHits = "";
    for (let i = 0; i < 240; i++) {
        tick(world, 1 / 60);
        if (b.sm.state === "telegraph" && !hitWhileTelling) {
            hitWhileTelling = true;
            const before = b.hp;
            tryHit(b, 100);
            refused = b.sm.set("damage");
            stateDuringHits = b.sm.state;
            check("a hit on a telegraphing boss still deals damage",
                b.hp === before - 100, before + " -> " + b.hp);
        }
    }
    check("a boss cannot be flinched out of its telegraph",
        hitWhileTelling && refused === false && stateDuringHits === "telegraph",
        "set(\"damage\") returned " + refused + ", state stayed " + stateDuringHits);
    check("the interrupted telegraph still fires",
        events(world, "enemySkill").length >= 1,
        events(world, "enemySkill").length + " shots after being hit mid-tell");
}

// --- 6. the emit(pattern, origin, mods) contract ------------------------------

{
    // The density each pattern lays down, measured through the AI rather than by
    // calling emit by hand: this is the number that reaches the screen.
    const density = {};
    ["aimed", "fan", "ring", "spiral"].forEach(function (pattern) {
        const world = stubWorld();
        world.player = mkPlayer({ x: 4, y: 6 });
        const e = mkEnemy({
            moveset: {
                attacks: [{ id: 7, name: "test " + pattern, target: 1, coef: 0.2,
                    magic: false, pattern: pattern, sap: "" }],
                support: [], gimmicks: []
            }
        });
        world.enemies = [e];
        for (let i = 0; i < 120; i++) { tick(world, 1 / 60); }
        const shot = events(world, "enemySkill")[0];
        density[pattern] = shot ? shot.bullets : 0;
    });
    check("each pattern lays down its own density",
        density.aimed === 1 && density.fan === 5 && density.ring === 12
            && density.spiral === 3 * PATTERN_STEPS,
        "aimed " + density.aimed + " / fan " + density.fan + " / ring "
            + density.ring + " / spiral " + density.spiral);

    // The offence snapshot: every bullet carries the shooter's numbers, because
    // the shooter may be dead before the bullet lands (danmaku.js bulletFactory).
    const world = stubWorld();
    world.player = mkPlayer({ x: 4, y: 6 });
    const e = mkEnemy({
        element: 3, atk: 300, mgc: 321,
        moveset: { attacks: [RING], support: [], gimmicks: [] }
    });
    world.enemies = [e];
    // Stop on the frame the ring lands, before any bullet can reach the player
    // and be consumed -- this measures what emit wrote, not what survived.
    for (let i = 0; i < 120 && !events(world, "enemySkill").length; i++) {
        tick(world, 1 / 60);
    }
    const bullets = [];
    world.danmaku.forEach(function (b) { bullets.push(b); });
    const snapshot = bullets.every(function (b) {
        return b.side === "enemy" && b.element === 3 && b.power === 321
            && b.magic === true && Math.abs(b.coef - RING.coef) < 1e-9
            && b.critChance === 0 && b.srcId === e.id && b.skillId === RING.id
            && b.pattern === "ring";
    });
    check("every bullet carries the shooter's offence snapshot",
        bullets.length === 12 && snapshot,
        bullets.length + " bullets, power " + (bullets[0] || {}).power
            + " (mgc, magic row) element " + (bullets[0] || {}).element
            + " src " + (bullets[0] || {}).srcId
            + " crit " + (bullets[0] || {}).critChance);
    check("enemies never crit (the luck term is the player's)",
        bullets.every(function (b) { return b.critChance === 0; }));
}

{
    // Unknown shapes create nothing rather than defaulting to something. The
    // melee lunge is the one the table can actually name, and it must never
    // reach the bullet layer.
    const danmaku = createDanmaku({});
    const origin = { x: 8, y: 6, angle: 0 };
    const mods = { side: "enemy", power: 100, coef: 0.2 };
    check("emit(\"charge\") creates nothing -- the lunge is not a bullet",
        danmaku.emit("charge", origin, mods) === 0 && danmaku.active === 0);
    check("an unknown pattern creates nothing",
        danmaku.emit("nonesuch", origin, mods) === 0
            && danmaku.emit("", origin, mods) === 0
            && danmaku.emit(undefined, origin, mods) === 0
            && danmaku.active === 0,
        "active " + danmaku.active);
    check("every PATTERNS entry does create bullets",
        PATTERNS.every(function (pattern) {
            return danmaku.emit(pattern, origin, mods) > 0;
        }), PATTERNS.join("/") + " -> " + danmaku.active + " bullets");
}

// --- 7. the pool survives a real fight ----------------------------------------

{
    // A mixed room driven by the AI for a minute, then left to drain. Nothing
    // here calls emit by hand: every bullet on the floor was decided by
    // enemyai, which is the case rl_danmaku_harness.mjs cannot cover.
    const world = stubWorld();
    const p = mkPlayer({ x: 4, y: 6 });
    world.player = p;
    world.enemies = [
        mkEnemy({ id: 11, x: 3, y: 3, aiType: "sentry", spd: 140,
            moveset: { attacks: [RING, AIMED], support: [], gimmicks: [] } }),
        mkEnemy({ id: 12, x: 13, y: 3, aiType: "sentry", spd: 90,
            moveset: { attacks: [{ id: 4, name: "test fan", target: 1, coef: 0.2,
                magic: false, pattern: "fan", sap: "" }], support: [], gimmicks: [] } }),
        mkEnemy({ id: 13, x: 13, y: 9, aiType: "charger", spd: 120,
            moveset: { attacks: [CHARGE, AIMED], support: [], gimmicks: [] } }),
        mkEnemy({ id: 14, x: 8, y: 6, aiType: "boss", spd: 100, hp: 4000, maxHp: 4000,
            moveset: { attacks: [RING], support: [], gimmicks: [] } })
    ];
    let peak = 0;
    for (let i = 0; i < 3600; i++) {                 // 60 s at 60 Hz
        // Keep the player alive and walking so the fight keeps running: this
        // gate is about the pool, not about who wins.
        p.hp = p.maxHp;
        p.x = 4 + Math.sin(i / 37) * 2.5;
        p.y = 6 + Math.cos(i / 53) * 3.0;
        // Walk the boss down its phases so the flip bursts land in here too.
        world.enemies[3].hp = Math.max(1, 4000 - i);
        tick(world, 1 / 60);
        peak = Math.max(peak, world.danmaku.active);
    }
    const shots = events(world, "enemySkill").length;
    check("an AI-driven fight fills the floor without saturating the pool",
        shots > 40 && peak > 0 && peak < world.danmaku.capacity
            && world.danmaku.dropped === 0,
        shots + " shots, peak " + peak + "/" + world.danmaku.capacity
            + " bullets, " + world.danmaku.dropped + " dropped");
    check("the boss walked its phases inside the fight",
        events(world, "bossPhase").length === 2 && world.summons.length === 2,
        events(world, "bossPhase").map(function (f) { return "p" + f.phase; }).join(","));

    // Drain: with nothing left to shoot at, every bullet must leave or expire.
    world.player = null;
    world.enemies = [];
    let drainFrames = 0;
    while (world.danmaku.active > 0 && drainFrames < 600) {
        world.danmaku.update(1 / 60, { width: world.width, height: world.height });
        drainFrames += 1;
    }
    check("the pool drains back to zero when the fight ends",
        world.danmaku.active === 0,
        "active " + world.danmaku.active + " after " + drainFrames + " frames ("
            + (drainFrames / 60).toFixed(2) + "s, life "
            + DANMAKU_DEFAULTS.life + "s)");
}

console.log(failures
    ? failures + " enemy check(s) FAILED"
    : "all enemy checks passed");
process.exit(failures ? 1 : 0);

