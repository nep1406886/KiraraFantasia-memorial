// Play rooms with a scripted hand and print JSON. No renderer.
//
// Module paths as argv[2] (lbfight) and argv[3] (lbstat) so the negative cases
// can hand over patched copies.
//
// The scripted hand stands in for a competent player: strafe perpendicular to
// the nearest enemy, keep firing, dash when a shot is close. It is not meant to
// be optimal -- it is meant to be *consistent*, so a change in the numbers
// shows up as a change in clear time rather than as a change in how well the
// harness happens to play.

import { pathToFileURL } from "node:url";

const fightPath = process.argv[2];
const statPath = process.argv[3];
if (!fightPath || !statPath || !process.argv[4]) {
    console.error("usage: lb_fight_harness.mjs <lbfight> <lbstat> <lbskill>");
    process.exit(2);
}
const skillPath = process.argv[4];
const F = await import(pathToFileURL(fightPath).href);
const S = await import(pathToFileURL(statPath).href);
// Required, not optional. Making it optional and skipping the skill section
// when absent would mean a caller that forgot the argument still exits 0 with
// every skill assertion silently gone -- a check that cannot fail.
const SK = await import(pathToFileURL(skillPath).href);

const DT = 1 / 60;
const TIMEOUT = 180;

// --- the scripted hand -------------------------------------------------------

function playRoom(fighter, enemies, seed, obstacles, opts) {
    const options = opts || {};
    const st = F.createFight(fighter, enemies, seed, obstacles);
    let t = 0;
    let dashes = 0;

    // Charge bookkeeping. `heroTaken` alone cannot answer "did the body-slam
    // land" -- swarm shots are mixed into the same total. A charge counts as a
    // hit if heroTaken rose at any point between the dash starting and ending.
    let chargeAttempts = 0;
    let chargeHits = 0;
    let prevPhase = null;
    let inDash = false;
    let takenAtDashStart = 0;

    while (t < TIMEOUT && !F.isCleared(st) && !F.isDead(st)) {
        const sn = F.snapshot(st);
        const h = sn.hero;

        // nearest live enemy
        let ax = 1;
        let ay = 0;
        let best = Infinity;
        sn.enemies.forEach(function (e) {
            const d = Math.hypot(e.x - h.x, e.y - h.y);
            if (d < best) { best = d; ax = e.x - h.x; ay = e.y - h.y; }
        });
        const al = Math.hypot(ax, ay) || 1;
        ax /= al;
        ay /= al;

        // strafe perpendicular; back off when very close
        let mx = -ay;
        let my = ax;
        if (best < 3.0) { mx -= ax * 0.9; my -= ay * 0.9; }

        // dash away from the closest incoming shot
        let dash = false;
        if (!options.noDash) {
            for (let i = 0; i < sn.shots.length; i++) {
                const s = sn.shots[i];
                if (s.from !== "enemy") { continue; }
                if (Math.hypot(s.x - h.x, s.y - h.y) < 1.4) {
                    dash = true;
                    mx = -ay;
                    my = ax;
                    break;
                }
            }
        }

        // opts.readTelegraph: also react to a boss winding up for a charge, by
        // cutting sideways out of the charge line.
        //
        // Two hands exist because one hand cannot tell "the charge is fair" from
        // "the charge is decoration". The default hand ignores the wind-up, so it
        // measures what happens to a player who does not read the tell; this hand
        // measures what happens to one who does. The *gap between them* is the
        // mechanic. A single hand only ever produces one number, and one number
        // is consistent with both a working telegraph and no telegraph at all.
        if (options.readTelegraph) {
            const w = sn.enemies.find(function (e) { return e.phase === "wind"; });
            if (w) {
                const vx = h.x - w.x;
                const vy = h.y - w.y;
                const l = Math.hypot(vx, vy) || 1;
                // perpendicular to the charge line, biased toward room centre so
                // the hand does not corner itself against a wall
                let px = -vy / l;
                let py = vx / l;
                if ((F.ROOM_W / 2 - h.x) * px + (F.ROOM_H / 2 - h.y) * py < 0) {
                    px = -px;
                    py = -py;
                }
                mx = px;
                my = py;
                if (!options.noDash) { dash = true; }
            }
        }
        if (dash) { dashes += 1; }

        const boss = st.enemies.find(function (e) {
            return e.kind === "boss" && e.alive;
        });
        const takenBefore = st.stat.heroTaken;

        F.step(st, DT, {
            moveX: mx, moveY: my, aimX: ax, aimY: ay,
            fire: !options.noFire, dash: dash
        });

        if (boss && boss.alive) {
            if (prevPhase !== "dash" && boss.phase === "dash") {
                chargeAttempts += 1;
                inDash = true;
                takenAtDashStart = takenBefore;
            }
            if (inDash && boss.phase !== "dash") {
                if (st.stat.heroTaken > takenAtDashStart) { chargeHits += 1; }
                inDash = false;
            }
            prevPhase = boss.phase;
        }
        t += DT;
    }
    // A dash still in flight when the loop ended (boss died, hero died, timeout).
    if (inDash && st.stat.heroTaken > takenAtDashStart) { chargeHits += 1; }

    return {
        seconds: Math.round(t * 10) / 10,
        cleared: F.isCleared(st),
        dead: F.isDead(st),
        hpLeft: Math.round(st.hero.hp * 10) / 10,
        hpMax: st.hero.hpMax,
        hpFraction: Math.round((st.hero.hp / st.hero.hpMax) * 100) / 100,
        dashes: dashes,
        stat: st.stat,
        obstacles: st.obstacles.length,
        chargeAttempts: chargeAttempts,
        chargeHits: chargeHits
    };
}

const out = {};
out.tiers = F.ENEMY_TIERS;
out.roomW = F.ROOM_W;
out.roomH = F.ROOM_H;

// --- battle rooms, every character, level 5 ----------------------------------

const CHARS = S.ROSTER.map(function (r) { return r.id; });
out.battleRooms = {};
CHARS.forEach(function (id) {
    const f = S.createFighter(id, 5, []);
    const runs = [];
    for (let seed = 1; seed <= 6; seed++) {
        runs.push(playRoom(f, F.makeEnemies("swarm", 8, 0.5), seed * 7919, undefined));
    }
    const secs = runs.map(function (r) { return r.seconds; });
    out.battleRooms[id] = {
        hp: f.hp,
        atk: Math.round(f.stats.atk * 100) / 100,
        rate: Math.round(f.stats.rate * 100) / 100,
        speed: Math.round(f.stats.speed * 100) / 100,
        cleared: runs.filter(function (r) { return r.cleared; }).length,
        died: runs.filter(function (r) { return r.dead; }).length,
        secondsMin: Math.min.apply(null, secs),
        secondsMax: Math.max.apply(null, secs),
        secondsAvg: Math.round(secs.reduce(function (a, b) { return a + b; }, 0)
                               / secs.length * 10) / 10,
        hpFractionAvg: Math.round(runs.reduce(function (a, r) {
            return a + r.hpFraction;
        }, 0) / runs.length * 100) / 100
    };
});

// --- mixed room and boss room ------------------------------------------------

const polka = S.createFighter("polka", 8, []);
out.mixedRoom = playRoom(
    polka,
    F.makeEnemies("swarm", 5, 0.6).concat(F.makeEnemies("adept", 2, 0)),
    4242, 3
);
// The boss room, over eight seeds, played by both hands.
//
// Why not one seed: a single-seed boss room reported the hero finishing at
// **28/28, untouched**, which read as "the boss cannot hurt anyone". Over eight
// seeds the same hand averages ~11 of 28 lost. The one seed was lucky, and the
// conclusion drawn from it -- that the charge needed to lead its target -- was
// wrong. Leading it made the room unwinnable and inverted the skill gradient.
// So: seeds are a range, and a range is what gets reported.
// Sixteen, not eight. The charge hit rate is a ratio of two small counts: eight
// seeds gave only ~26 charge attempts per hand, and the resulting 0.23-vs-0.12
// sat one unlucky seed away from tripping a 1.8x threshold. A gate that goes red
// from sampling noise trains you to ignore it.
const BOSS_SEEDS = [8484, 111, 222, 333, 444, 555, 666, 777,
                    1213, 2426, 3639, 4852, 6065, 7278, 8491, 9704];

function bossSuite(readTelegraph) {
    const runs = BOSS_SEEDS.map(function (seed) {
        return playRoom(
            polka,
            F.makeEnemies("boss", 1, 0).concat(F.makeEnemies("swarm", 4, 0.5)),
            seed, 2, { readTelegraph: readTelegraph }
        );
    });
    const secs = runs.map(function (r) { return r.seconds; });
    const attempts = runs.reduce(function (a, r) { return a + r.chargeAttempts; }, 0);
    const hits = runs.reduce(function (a, r) { return a + r.chargeHits; }, 0);
    return {
        seeds: BOSS_SEEDS.length,
        cleared: runs.filter(function (r) { return r.cleared; }).length,
        died: runs.filter(function (r) { return r.dead; }).length,
        secondsMin: Math.min.apply(null, secs),
        secondsMax: Math.max.apply(null, secs),
        secondsAvg: Math.round(secs.reduce(function (a, b) { return a + b; }, 0)
                               / secs.length * 10) / 10,
        takenAvg: Math.round(runs.reduce(function (a, r) {
            return a + r.stat.heroTaken;
        }, 0) / runs.length * 10) / 10,
        hpMax: polka.hp,
        chargeAttempts: attempts,
        chargeHits: hits,
        chargeHitRate: attempts ? Math.round(100 * hits / attempts) / 100 : null
    };
}

out.bossNaive = bossSuite(false);
out.bossReader = bossSuite(true);

// --- the room must be losable and winnable ----------------------------------
//
// A room that cannot be lost is not a fight, and a room that cannot be won is
// not a room. Both directions get measured.

const f5 = S.createFighter("polka", 5, []);
out.passive = playRoom(f5, F.makeEnemies("swarm", 8, 0.5), 12345, 3,
                       { noFire: true, noDash: true });
out.noDash = playRoom(f5, F.makeEnemies("swarm", 8, 0.5), 12345, 3,
                      { noDash: true });

// --- resources actually move -------------------------------------------------

const st = F.createFight(f5, F.makeEnemies("swarm", 4, 0), 77, 0);
const breathStart = st.hero.breath;
let dashed = 0;
for (let i = 0; i < 40; i++) {
    F.step(st, DT, { moveX: 1, moveY: 0, dash: i % 20 === 0 });
    if (i % 20 === 0) { dashed += 1; }
}
out.breath = {
    start: breathStart,
    afterDashes: Math.round(st.hero.breath * 100) / 100,
    dashesRequested: dashed,
    regenPerSec: f5.stats.breathRegen
};

// --- skills (plans/labyrinth.md §3.4 / §3.6) ---------------------------------

// A rig with enemies parked at chosen offsets from the hero and no obstacles,
// so "did this skill reach anything" is a question about the skill and not
// about where the room generator happened to put a crate.
function rig(charId, spots, enemyOpts) {
    const f = S.createFighter(charId, 1, []);
    const specs = spots.map(function () {
        return Object.assign({ kind: "swarm", hp: 99999, atk: 0, speed: 0,
                               rate: 0 }, enemyOpts || {});
    });
    const st = F.createFight(f, specs, 3, 0);
    st.hero.x = F.ROOM_W / 2;
    st.hero.y = F.ROOM_H / 2;
    st.enemies.forEach(function (e, i) {
        e.x = st.hero.x + spots[i][0];
        e.y = st.hero.y + spots[i][1];
    });
    return st;
}

const IDLE = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, fire: false, dash: false };

function press(i) {
    const p = [false, false, false];
    p[i] = true;
    return Object.assign({}, IDLE, { skill: p });
}

function dealt(st) {
    return st.enemies.reduce(function (sum, e) {
        return sum + (99999 - e.hp);
    }, 0);
}

// Every skill of every hero, one press each. Enemies are ringed around the
// hero AND strung out along the aim line so a bolt, a fan, a nova and a wave
// all have something to hit; damage is summed, so "0" means the skill did
// nothing at all -- which is what a mistyped act kind looks like.
const SPOTS = [[1.2, 0], [2.6, 0], [4.0, 0], [0, 1.4], [-1.5, 0], [0, -1.6]];

out.skills = { checkTable: null, perHero: {} };
out.skills.checkTable = SK.checkSkills();

S.ROSTER.forEach(function (spec) {
    const list = SK.skillsFor(spec.id);
    const rows = list.map(function (sk, idx) {
        const st = rig(spec.id, SPOTS);
        // Instants that read missing hp need the hero hurt to show their
        // scaling, but a full-hp reading is the honest floor. Keep full hp.
        const ink0 = st.hero.ink;
        F.step(st, DT, press(idx));
        const row = {
            id: sk.id, kind: sk.kind, cost: sk.cost,
            inkBefore: Math.round(ink0 * 100) / 100,
            inkAfter: Math.round(st.hero.ink * 100) / 100,
            uses: st.stat.skillUses,
            // Two readings, because they are two different claims. `on` is the
            // state one frame after the press -- a toggle must be lit here, an
            // instant must not. `onAfter` is the state once the burn loop below
            // has run the pool dry, which is where §3.6's "breaks at 0" shows.
            // One field cannot carry both: reading it once after the press says
            // nothing about the break, and reading it once at the end says
            // nothing about whether it ever lit.
            on: !!st.skillRun[idx].on,
            onAfter: null,
            cool: Math.round(st.skillRun[idx].cool * 100) / 100,
            // damage from the press itself (instants), or from one further
            // second of burning (toggles, whose aura ticks per second)
            dmg: 0,
            broke: 0,
            inkEnd: null,
            upSeconds: null,
            // pressing again while cooling must be refused
            rejectedWhileCooling: null,
            // which act kinds it carries. The gate derives "should this have
            // dealt damage" from this rather than from a hand-kept list of
            // skill names, which would rot the first time a skill changed.
            acts: sk.acts.map(function (a) { return a.t; })
        };
        if (sk.kind === "instant") {
            // let the bullets fly before reading damage
            for (let i = 0; i < 40; i++) { F.step(st, DT, IDLE); }
            row.dmg = Math.round(dealt(st) * 100) / 100;
            const before = st.stat.skillUses;
            // still cooling? cool was set to sk.cool and 41 frames is 0.68s,
            // so anything with cool > 0.7 is provably still down.
            if (st.skillRun[idx].cool > 0) {
                F.step(st, DT, press(idx));
                row.rejectedWhileCooling = st.stat.skillUses === before
                    && st.skillSaid && st.skillSaid.result === "cool";
            }
        } else {
            // burn it until the ink runs out; record how long it lasted and
            // that it broke by itself (§3.6).
            let t = 0;
            while (st.skillRun[idx].on && t < 300) {
                F.step(st, DT, IDLE);
                t += DT;
            }
            row.upSeconds = Math.round(t * 10) / 10;
            row.broke = st.stat.toggleBroke;
            row.onAfter = !!st.skillRun[idx].on;
            // Separate from inkAfter, which stays the reading from just after
            // the press so `inkBefore - inkAfter` is the light's own cost. If
            // this overwrote it, a module with no drain at all would look like
            // it charged nothing to light either: 300s of regen refills the
            // pool to full, so the subtraction comes out 0 for the wrong
            // reason and the cost assertion stops meaning anything.
            row.inkEnd = Math.round(st.hero.ink * 100) / 100;
            row.dmg = Math.round(dealt(st) * 100) / 100;
        }
        return row;
    });
    out.skills.perHero[spec.id] = rows;
});

// §3.6: a toggle cannot be lit with no enemy on screen. Instants still work --
// without that split, a hero who cleared the room could not heal.
{
    const st = rig("sola", [[1.2, 0]]);
    st.enemies.forEach(function (e) { e.alive = false; });
    st.hero.hp = 1;
    F.step(st, DT, press(1));             // quiet_tide, a toggle
    const toggleSaid = st.skillSaid && st.skillSaid.result;
    const toggleOn = st.skillRun[1].on;
    F.step(st, DT, press(0));             // mend_page, an instant heal
    out.skills.emptyRoom = {
        toggleSaid: toggleSaid, toggleOn: toggleOn,
        instantSaid: st.skillSaid && st.skillSaid.result,
        healed: Math.round(st.hero.hp * 100) / 100
    };
}

// Ink is the only gate on an instant once it is off cooldown: drain the pool
// and the press must be refused with "ink", not silently fire for free.
{
    const st = rig("arcive", [[2, 0]]);
    st.hero.ink = 0;
    F.step(st, DT, press(2));             // final_entry, cost 13
    out.skills.noInk = {
        said: st.skillSaid && st.skillSaid.result,
        uses: st.stat.skillUses,
        dmg: Math.round(dealt(st) * 100) / 100
    };
}

// Toggles must not be free to hold: net drain per second, measured, has to be
// positive or "breaks at 0" is unreachable.
out.skills.netDrain = {};
S.ROSTER.forEach(function (spec) {
    const stats = S.baseStats({ classId: spec.classId,
                                elementId: spec.elementId, level: 1 });
    SK.skillsFor(spec.id).forEach(function (sk) {
        if (sk.kind !== "toggle") { return; }
        out.skills.netDrain[spec.id + "/" + sk.id] =
            Math.round((sk.drain - stats.inkRegen) * 100) / 100;
    });
});

// --- geometry ---------------------------------------------------------------

// Nobody -- hero or enemy -- may leave the room or sit inside an obstacle.
//
// This check used to be blind in two ways, and a boss spawned inside a box
// survived both for two sessions:
//
//  1. It ran with an EMPTY enemy list, so it could not observe an enemy at all.
//     Enemies were placed on a ring by index with no obstacle test, and one
//     landed 0.174 deep in a box. `moveWithCollision` only ever *rejects*
//     overlapping destinations, so an already-overlapping body is refused every
//     direction and freezes. The room then ran 180s with nobody able to die.
//  2. It tested centre-point containment (`h.x > o.x && ...`). A body wedged on
//     an edge has its centre OUTSIDE the box, so the wedged boss read as clean.
//     Overlap is a radius question, not a point question.
//
// So: enemies present, and overlap measured against the radius.
function overlapsBox(o, x, y, r) {
    const nx = Math.max(o.x, Math.min(x, o.x + o.w));
    const ny = Math.max(o.y, Math.min(y, o.y + o.h));
    return Math.hypot(x - nx, y - ny) < r - 1e-9;
}

const gst = F.createFight(
    f5,
    F.makeEnemies("boss", 1, 0).concat(F.makeEnemies("swarm", 6, 0.5)),
    31337, 4
);
let escaped = 0;
let inside = 0;
let enemyEscaped = 0;
let enemyInside = 0;
// Spawn frame counts too -- the defect was present at t=0, before any step.
gst.enemies.forEach(function (e) {
    gst.obstacles.forEach(function (o) {
        if (overlapsBox(o, e.x, e.y, e.r)) { enemyInside += 1; }
    });
});
for (let i = 0; i < 2000; i++) {
    const ang = (i / 2000) * Math.PI * 8;
    F.step(gst, DT, { moveX: Math.cos(ang), moveY: Math.sin(ang), dash: i % 37 === 0 });
    const h = gst.hero;
    if (h.x < 0 || h.x > F.ROOM_W || h.y < 0 || h.y > F.ROOM_H) { escaped += 1; }
    gst.obstacles.forEach(function (o) {
        if (overlapsBox(o, h.x, h.y, h.r)) { inside += 1; }
    });
    gst.enemies.forEach(function (e) {
        if (!e.alive) { return; }
        if (e.x < 0 || e.x > F.ROOM_W || e.y < 0 || e.y > F.ROOM_H) { enemyEscaped += 1; }
        gst.obstacles.forEach(function (o) {
            if (overlapsBox(o, e.x, e.y, e.r)) { enemyInside += 1; }
        });
    });
}
out.geometry = {
    escaped: escaped,
    insideObstacle: inside,
    enemyEscaped: enemyEscaped,
    enemyInsideObstacle: enemyInside,
    obstacles: gst.obstacles.length,
    unstuck: gst.stat.unstuck
};

// Enemy spawn placement, swept over many seeds and obstacle counts. One room
// cannot show this: seed 222 had the overlap and seed 8484 did not, and the
// earlier "fix" was verified only on 8484, so it was never a fix at all.
let spawnOverlaps = 0;
let spawnRooms = 0;
for (let seed = 0; seed < 300; seed++) {
    for (let obs = 0; obs <= 4; obs++) {
        const s = F.createFight(
            f5,
            F.makeEnemies("boss", 1, 0).concat(F.makeEnemies("swarm", 5, 0.5)),
            seed * 7717 + obs, obs
        );
        spawnRooms += 1;
        s.enemies.forEach(function (e) {
            s.obstacles.forEach(function (o) {
                if (overlapsBox(o, e.x, e.y, e.r)) { spawnOverlaps += 1; }
            });
        });
    }
}
out.spawnPlacement = { rooms: spawnRooms, overlaps: spawnOverlaps };

// Diagonal movement must not be faster than straight movement.
function travel(mx, my) {
    const s = F.createFight(S.createFighter("polka", 5, []), [], 5, 0);
    s.hero.x = 1.0;
    s.hero.y = 1.0;
    for (let i = 0; i < 60; i++) { F.step(s, DT, { moveX: mx, moveY: my }); }
    return Math.hypot(s.hero.x - 1.0, s.hero.y - 1.0);
}
out.movement = {
    straight: Math.round(travel(1, 0) * 1000) / 1000,
    diagonal: Math.round(travel(1, 1) * 1000) / 1000
};

// Obstacle count stays inside the planned 0-4 band (§5.3).
const counts = {};
for (let seed = 0; seed < 200; seed++) {
    const s = F.createFight(f5, [], seed * 131, undefined);
    counts[s.obstacles.length] = (counts[s.obstacles.length] || 0) + 1;
}
out.obstacleCounts = counts;

// Same seed -> same room.
function roomShape(seed) {
    const s = F.createFight(f5, F.makeEnemies("swarm", 4, 0.5), seed, 3);
    return JSON.stringify({
        obstacles: s.obstacles,
        enemies: s.enemies.map(function (e) {
            return { x: Math.round(e.x * 1e6), y: Math.round(e.y * 1e6) };
        })
    });
}
out.deterministic = roomShape(999) === roomShape(999);
out.seedMatters = roomShape(999) !== roomShape(1000);

console.log(JSON.stringify(out, null, 1));
