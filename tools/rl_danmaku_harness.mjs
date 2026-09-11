// Harness for the danmaku layer and its object pool (阶段 3, T07).
//
//   node tools/rl_danmaku_harness.mjs
//
// The stage's own acceptance line is check 5: 发射 10000 发后活跃数归零 -- fire
// ten thousand bullets through the pool and the active count must come back to
// zero, with the slot table still a clean permutation of the original objects.
// A leak here is not a slow memory creep, it is a dead screen: every leaked
// bullet permanently costs one slot out of 1024.
//
// 1. pool.js invariants: acquire/release/clear bookkeeping, the swap-with-last
//    release, and releasing the object a forEach callback is looking at.
// 2. Pattern geometry, hand-computed: aimed staggers in time along one bearing,
//    fan spans exactly `spread`, ring is evenly spaced over 2π, spiral is
//    arms × steps with a `turn` per step and a `stepDelay` per step.
// 3. Motion: bullets travel speed × time, pending bullets do not move at all,
//    and the delay overshoot is spent on the waking frame (so a bullet is never
//    a frame late), and they are recycled on life expiry and at the margin.
// 4. Collisions are *reported*, never applied: onHit fires, i-frames let
//    an enemy bullet pass through without being consumed, and player bullets
//    honour pierce.
// 5. The leak gate (above), plus saturation: a full pool counts `dropped`
//    instead of throwing, and clear() returns everything.
// 6. An unknown pattern -- "charge", which is a melee lunge -- creates nothing.

import { createPool } from "../site/game/rl/pool.js";
import { createDanmaku, DANMAKU_DEFAULTS, PATTERNS } from "../site/game/rl/danmaku.js";

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

const TAU = Math.PI * 2;
function near(a, b, eps) {
    return Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);
}
// Smallest signed difference between two bearings.
function angleGap(a, b) {
    let d = a - b;
    while (d > Math.PI) { d -= TAU; }
    while (d < -Math.PI) { d += TAU; }
    return d;
}
function bulletsOf(dm) {
    const out = [];
    dm.forEach(function (b) { out.push(b); });
    return out;
}

// --- 1. the pool -----------------------------------------------------------

{
    const pool = createPool(4, function (i) { return { tag: i }; });
    check("pool starts empty", pool.active === 0 && pool.free === 4);
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    check("three acquires -> active 3", pool.active === 3 && pool.free === 1);
    check("acquired objects are distinct", a !== b && b !== c && a !== c);
    check("acquired objects are alive", a.alive && b.alive && c.alive);

    // Releasing the middle one swaps the last live slot into its place.
    pool.release(b);
    check("release -> active 2", pool.active === 2, "active=" + pool.active);
    check("released object is not alive", b.alive === false);
    const live = [];
    pool.forEachStable(function (obj) { live.push(obj); });
    check("the survivors are exactly a and c", live.length === 2
        && live.indexOf(a) >= 0 && live.indexOf(c) >= 0);
    check("double release is a no-op", pool.release(b) === false && pool.active === 2);

    const d = pool.acquire();
    const e = pool.acquire();
    check("the freed slot is reused before capacity", pool.active === 4 && pool.free === 0);
    check("a full pool hands out null", pool.acquire() === null);
    check("no object was allocated beyond capacity", pool.slots.length === 4);

    // forEach must survive a callback that releases the very object it holds
    // (danmaku.update does exactly that when a bullet expires).
    let seen = 0;
    pool.forEach(function (obj) {
        seen += 1;
        pool.release(obj);
    });
    check("forEach visited all 4 while releasing each", seen === 4, "seen=" + seen);
    check("releasing during forEach drains the pool", pool.active === 0, "active=" + pool.active);

    pool.acquire();
    pool.acquire();
    pool.clear();
    check("clear() empties the pool", pool.active === 0 && pool.free === 4);
    const slotIds = pool.slots.map(function (o) { return o._slot; }).sort();
    check("slot indices are still 0..3 after all that", slotIds.join(",") === "0,1,2,3", slotIds.join(","));
    check("d and e are the same objects the pool started with",
        pool.slots.indexOf(d) >= 0 && pool.slots.indexOf(e) >= 0);
}

// --- 2. pattern geometry ---------------------------------------------------

{
    const dm = createDanmaku({ capacity: 64 });
    const OFF = 0.35;                        // default muzzle offset

    // aimed: one bearing, `count` shots staggered by stepDelay.
    let made = dm.emit("aimed", { x: 0, y: 0, angle: 0 }, { count: 3, speed: 6, stepDelay: 0.05 });
    let list = bulletsOf(dm);
    check("aimed: 3 bullets created", made === 3 && list.length === 3, "made=" + made);
    check("aimed: all start at the muzzle offset", list.every(function (b) {
        return near(b.x, OFF) && near(b.y, 0);
    }), list.map(function (b) { return b.x.toFixed(2); }).join(","));
    check("aimed: all fly down the base bearing at the given speed", list.every(function (b) {
        return near(b.vx, 6) && near(b.vy, 0);
    }));
    const delays = list.map(function (b) { return b.delay; }).sort(function (p, q) { return p - q; });
    check("aimed: delays are 0 / 0.05 / 0.10", near(delays[0], 0) && near(delays[1], 0.05)
        && near(delays[2], 0.1), delays.join(","));
    dm.clear();

    // fan: `count` bullets spanning exactly `spread`, centred on the bearing.
    made = dm.emit("fan", { x: 1, y: 2, angle: Math.PI / 2 }, { count: 5, spread: Math.PI / 3, speed: 5 });
    list = bulletsOf(dm);
    check("fan: 5 bullets created", made === 5, "made=" + made);
    const bearings = list.map(function (b) { return Math.atan2(b.vy, b.vx); })
        .sort(function (p, q) { return p - q; });
    check("fan: spans exactly the spread", near(bearings[4] - bearings[0], Math.PI / 3, 1e-9),
        (bearings[4] - bearings[0]).toFixed(6));
    check("fan: centred on the emit bearing",
        near((bearings[0] + bearings[4]) / 2, Math.PI / 2, 1e-9));
    check("fan: evenly spaced (spread / (count-1))", [1, 2, 3, 4].every(function (i) {
        return near(bearings[i] - bearings[i - 1], (Math.PI / 3) / 4, 1e-9);
    }));
    check("fan: every bullet leaves at the requested speed", list.every(function (b) {
        return near(Math.hypot(b.vx, b.vy), 5, 1e-9);
    }));
    check("fan: nothing is delayed", list.every(function (b) { return b.delay === 0; }));
    check("fan: a count below 2 is raised to 2 (a one-bullet fan is a divide by zero)",
        (function () { dm.clear(); const n = dm.emit("fan", { x: 0, y: 0, angle: 0 }, { count: 1 }); dm.clear(); return n; })() === 2);
    dm.clear();

    // ring: evenly spaced over the full circle, each bullet pushed outward.
    made = dm.emit("ring", { x: 4, y: 4, angle: 0 }, { count: 12, speed: 4 });
    list = bulletsOf(dm);
    check("ring: 12 bullets created", made === 12, "made=" + made);
    const ringAng = list.map(function (b) { return Math.atan2(b.vy, b.vx); })
        .sort(function (p, q) { return p - q; });
    check("ring: evenly spaced by 2π/12", (function () {
        for (let i = 1; i < ringAng.length; i++) {
            if (!near(ringAng[i] - ringAng[i - 1], TAU / 12, 1e-9)) { return false; }
        }
        return true;
    })());
    check("ring: each bullet starts one offset out along its own bearing",
        list.every(function (b) {
            const ang = Math.atan2(b.vy, b.vx);
            return near(b.x, 4 + Math.cos(ang) * OFF, 1e-9) && near(b.y, 4 + Math.sin(ang) * OFF, 1e-9);
        }));
    check("ring: velocity points away from the centre", list.every(function (b) {
        return (b.x - 4) * b.vx + (b.y - 4) * b.vy > 0;
    }));
    dm.clear();

    // spiral: arms × steps, each step rotated by `turn` and delayed stepDelay.
    made = dm.emit("spiral", { x: 8, y: 6, angle: 0 }, { arms: 3, steps: 6, turn: 0.42, stepDelay: 0.09 });
    list = bulletsOf(dm);
    check("spiral: arms × steps = 18 bullets", made === 18, "made=" + made);
    const byDelay = new Map();
    list.forEach(function (b) {
        const key = Math.round(b.delay / 0.09);
        byDelay.set(key, (byDelay.get(key) || 0) + 1);
    });
    check("spiral: 6 delay steps of 3 bullets each", byDelay.size === 6
        && [0, 1, 2, 3, 4, 5].every(function (k) { return byDelay.get(k) === 3; }),
        JSON.stringify(Array.from(byDelay.entries())));
    check("spiral: step delays are exact multiples of stepDelay", list.every(function (b) {
        return near(b.delay, Math.round(b.delay / 0.09) * 0.09, 1e-9);
    }));
    // Within one step the three arms are 2π/3 apart; between steps the whole
    // set rotates by `turn`.
    const step0 = list.filter(function (b) { return b.delay < 1e-9; })
        .map(function (b) { return Math.atan2(b.vy, b.vx); }).sort(function (p, q) { return p - q; });
    check("spiral: the 3 arms of one step are 2π/3 apart",
        near(angleGap(step0[1], step0[0]), TAU / 3, 1e-9)
        && near(angleGap(step0[2], step0[1]), TAU / 3, 1e-9), step0.join(","));
    const step1 = list.filter(function (b) { return near(b.delay, 0.09); })
        .map(function (b) { return Math.atan2(b.vy, b.vx); }).sort(function (p, q) { return p - q; });
    const rotated = step1.some(function (ang) {
        return step0.some(function (base) { return near(Math.abs(angleGap(ang, base)), 0.42, 1e-9); });
    });
    check("spiral: the next step is rotated by `turn`", rotated,
        "step0=" + step0.map(function (v) { return v.toFixed(3); }).join(","));
    dm.clear();

    // volley: a longer, faster burst than aimed's stagger down one bearing.
    made = dm.emit("volley", { x: 2, y: 3, angle: Math.PI / 4 }, { count: 3, speed: 6.2, stepDelay: 0.15 });
    list = bulletsOf(dm);
    check("volley: 3 bullets created", made === 3, "made=" + made);
    check("volley: all start at the muzzle offset",
        list.every(function (b) {
            return near(b.x, 2 + Math.cos(Math.PI / 4) * OFF)
                && near(b.y, 3 + Math.sin(Math.PI / 4) * OFF);
        }));
    check("volley: all fly down the base bearing at the given speed", list.every(function (b) {
        return near(b.vx, 6.2 * Math.SQRT1_2) && near(b.vy, 6.2 * Math.SQRT1_2);
    }));
    const vDelays = list.map(function (b) { return b.delay; }).sort(function (p, q) { return p - q; });
    check("volley: delays are 0 / 0.15 / 0.30", near(vDelays[0], 0) && near(vDelays[1], 0.15)
        && near(vDelays[2], 0.3), vDelays.join(","));
    check("volley: a count below 2 is raised to 2",
        (function () { dm.clear(); const n = dm.emit("volley", { x: 0, y: 0, angle: 0 }, { count: 1 }); dm.clear(); return n; })() === 2);
    dm.clear();

    // wave: a fan whose bullets curve in alternating directions.
    made = dm.emit("wave", { x: 5, y: 5, angle: 0 }, { count: 3, spread: Math.PI / 2, curve: 0.9, speed: 5 });
    list = bulletsOf(dm);
    check("wave: 3 bullets created", made === 3, "made=" + made);
    const wAng = list.map(function (b) { return Math.atan2(b.vy, b.vx); })
        .sort(function (p, q) { return p - q; });
    check("wave: spans exactly the spread, centred on the bearing",
        near(wAng[2] - wAng[0], Math.PI / 2, 1e-9) && near((wAng[0] + wAng[2]) / 2, 0, 1e-9));
    const wCurves = list.slice().sort(function (p, q) { return p.curve - q.curve; })
        .map(function (b) { return b.curve; });
    check("wave: curves alternate +0.9 / -0.9 across the spread",
        near(wCurves[0], -0.9) && near(wCurves[2], 0.9)
            && near(Math.abs(wCurves[1]), 0.9), wCurves.join(","));
    check("wave: nothing is delayed", list.every(function (b) { return b.delay === 0; }));
    dm.clear();

    // cross: four bearings at right angles, each an aimed stagger.
    made = dm.emit("cross", { x: 6, y: 4, angle: 0 }, { count: 1, speed: 5.4 });
    list = bulletsOf(dm);
    check("cross: 4 bullets created (one per bearing)", made === 4, "made=" + made);
    const cAng = list.map(function (b) { return Math.atan2(b.vy, b.vx); }).sort(function (p, q) { return p - q; });
    check("cross: bearings are the base and base + k·π/2",
        near(cAng[0], -Math.PI / 2) && near(cAng[1], 0) && near(cAng[2], Math.PI / 2)
            && near(cAng[3], Math.PI), cAng.map(function (v) { return v.toFixed(3); }).join(","));
    check("cross: each bullet starts one offset out along its own bearing",
        list.every(function (b) {
            const ang = Math.atan2(b.vy, b.vx);
            return near(b.x, 6 + Math.cos(ang) * OFF) && near(b.y, 4 + Math.sin(ang) * OFF);
        }));
    dm.clear();

    // wall: a perpendicular curtain, slower and fatter, advancing in step.
    made = dm.emit("wall", { x: 3, y: 6, angle: 0 }, { count: 7, spacing: 0.8, speed: 2.6 });
    list = bulletsOf(dm);
    check("wall: 7 bullets created", made === 7, "made=" + made);
    check("wall: lined up perpendicular to the bearing, evenly spaced",
        (function () {
            const ys = list.map(function (b) { return b.y; }).sort(function (p, q) { return p - q; });
            if (!near(ys[0], 6 - 3 * 0.8, 1e-9) || !near(ys[6], 6 + 3 * 0.8, 1e-9)) { return false; }
            for (let i = 1; i < 7; i++) {
                if (!near(ys[i] - ys[i - 1], 0.8, 1e-9)) { return false; }
            }
            return true;
        })(), list.map(function (b) { return b.y.toFixed(2); }).join(","));
    check("wall: every bullet advances down the base bearing at the given speed",
        list.every(function (b) { return near(b.vx, 2.6) && near(b.vy, 0); }));
    check("wall: the curtain's bullets are fatter and longer-lived than the default",
        list.every(function (b) { return near(b.radius, 0.22) && near(b.life, 5.0); }));
    check("wall: nothing is delayed", list.every(function (b) { return b.delay === 0; }));
    check("wall: a count below 3 is raised to 3",
        (function () { dm.clear(); const n = dm.emit("wall", { x: 0, y: 0, angle: 0 }, { count: 2 }); dm.clear(); return n; })() === 3);
    dm.clear();

    // 6. unknown patterns
    check("an unknown pattern creates nothing",
        dm.emit("charge", { x: 0, y: 0, angle: 0 }, { count: 8 }) === 0 && dm.active === 0);
    check("PATTERNS lists exactly the eight shapes that exist",
        PATTERNS.join(",") === "aimed,fan,ring,spiral,volley,wave,cross,wall", PATTERNS.join(","));
}

// --- 3. motion, delay accounting, recycling --------------------------------

{
    const dm = createDanmaku({ capacity: 32 });
    const ctx = { width: 16, height: 12, player: null, enemies: null };

    dm.emit("aimed", { x: 1, y: 6, angle: 0 }, { count: 1, speed: 10, life: 4 });
    let b = bulletsOf(dm)[0];
    dm.update(0.1, ctx);
    check("a bullet travels speed × dt", near(b.x, 0.35 + 1 + 1.0, 1e-9), "x=" + b.x);
    check("life is spent as it flies", near(b.life, 3.9, 1e-9), "life=" + b.life);
    dm.clear();

    // A pending bullet holds a slot but must not move or age.
    dm.emit("aimed", { x: 1, y: 6, angle: 0 }, { count: 2, speed: 10, stepDelay: 0.1, life: 4 });
    const pending = bulletsOf(dm).filter(function (bb) { return bb.delay > 0; })[0];
    const x0 = pending.x;
    dm.update(0.06, ctx);
    check("a pending bullet does not move", near(pending.x, x0, 1e-12), "x=" + pending.x);
    check("a pending bullet does not age", near(pending.life, 4, 1e-12), "life=" + pending.life);
    check("its delay counts down", near(pending.delay, 0.04, 1e-9), "delay=" + pending.delay);
    // Waking frame: the overshoot past zero is spent, not the whole dt, so a
    // spiral's steps stay evenly spaced instead of quantising to the frame grid.
    dm.update(0.06, ctx);
    check("the waking frame spends only the overshoot (0.02 s of travel)",
        near(pending.x - x0, 10 * 0.02, 1e-9), "moved=" + (pending.x - x0));
    check("and only the overshoot of life", near(pending.life, 4 - 0.02, 1e-9), "life=" + pending.life);
    dm.clear();

    // Recycling: life expiry and the out-of-room margin.
    dm.emit("aimed", { x: 8, y: 6, angle: 0 }, { count: 1, speed: 0.001, life: 0.05 });
    dm.update(0.06, ctx);
    check("a bullet whose life runs out is recycled", dm.active === 0, "active=" + dm.active);
    dm.emit("aimed", { x: 15, y: 6, angle: 0 }, { count: 1, speed: 10, life: 9 });
    dm.update(0.2, ctx);          // 15 + 0.35 + 2 = 17.35 > 16 + margin 1.0
    check("a bullet that leaves the room is recycled", dm.active === 0, "active=" + dm.active);
    dm.emit("aimed", { x: 15, y: 6, angle: 0 }, { count: 1, speed: 10, life: 9 });
    dm.update(0.05, ctx);         // 15.85 -- still inside width + margin
    check("a bullet inside the margin is kept", dm.active === 1, "active=" + dm.active);
    check("the margin is one world unit past the wall", DANMAKU_DEFAULTS.margin === 1.0);
    dm.clear();

    // A curving bullet keeps its speed and turns at `curve` rad/s.
    dm.emit("aimed", { x: 8, y: 6, angle: 0 }, { count: 1, speed: 5, curve: 1.0, life: 4 });
    b = bulletsOf(dm)[0];
    dm.update(0.5, ctx);
    check("curve turns the velocity, not the speed", near(Math.hypot(b.vx, b.vy), 5, 1e-9)
        && near(Math.atan2(b.vy, b.vx), 0.5, 1e-9), "ang=" + Math.atan2(b.vy, b.vx).toFixed(4));
}

// --- 4. collisions are reported, never applied -----------------------------

{
    const dm = createDanmaku({ capacity: 64 });
    const player = { x: 8, y: 6, radius: 0.45, iframes: 0, dead: false, hp: 100 };
    const hits = [];
    const ctx = {
        width: 16, height: 12, player: player, enemies: null,
        onHit: function (bullet, target) { hits.push({ bullet: bullet, target: target }); }
    };

    // Straight into the player from the left.
    dm.emit("aimed", { x: 6, y: 6, angle: 0 }, { count: 1, speed: 10, life: 4, power: 400, coef: 1.9, magic: true });
    for (let i = 0; i < 30 && dm.active > 0; i++) { dm.update(1 / 60, ctx); }
    check("an enemy bullet reports exactly one hit", hits.length === 1, "hits=" + hits.length);
    check("the hit carries the offence snapshot taken at emit time",
        hits.length === 1 && hits[0].bullet.power === 400 && hits[0].bullet.coef === 1.9
        && hits[0].bullet.magic === true);
    check("the player's HP was NOT touched by the danmaku layer", player.hp === 100);
    check("the bullet was consumed by the hit", dm.active === 0, "active=" + dm.active);
    hits.length = 0;
    dm.clear();

    // i-frames: the bullet passes through and keeps flying.
    player.iframes = 1.0;
    dm.emit("aimed", { x: 6, y: 6, angle: 0 }, { count: 1, speed: 10, life: 4 });
    for (let i = 0; i < 8; i++) { dm.update(1 / 60, ctx); }
    check("an invulnerable player is not hit", hits.length === 0, "hits=" + hits.length);
    check("and the bullet is not eaten -- a dodge is a dodge, not a screen wipe",
        dm.active === 1, "active=" + dm.active);
    player.iframes = 0;
    hits.length = 0;
    dm.clear();

    // The hitbox edge is a clean boundary: the graze band is gone with the
    // graze system (spec/04 §11's stun gauge replaced it), so just outside the
    // touch distance must be a strict no-op. offset 0 puts the bullet exactly
    // where it is asked for -- the default 0.35 muzzle push would otherwise
    // move it off the point being measured.
    const touch = DANMAKU_DEFAULTS.radius + player.radius;
    dm.emit("aimed", { x: 8, y: 6 - touch * 1.5, angle: -Math.PI / 2 },
        { count: 1, speed: 0.0001, life: 4, offset: 0 });
    dm.update(1 / 60, ctx);
    check("a bullet just outside the hitbox does nothing at all",
        hits.length === 0, "hits=" + hits.length);
    dm.clear();
    dm.emit("aimed", { x: 8, y: 6 - touch * 0.5, angle: -Math.PI / 2 },
        { count: 1, speed: 0.0001, life: 4, offset: 0 });
    dm.update(1 / 60, ctx);
    check("a bullet inside the hitbox hits", hits.length === 1, "hits=" + hits.length);
    hits.length = 0;
    dm.clear();

    // A dead player stops it too.
    player.dead = true;
    dm.emit("aimed", { x: 6, y: 6, angle: 0 }, { count: 1, speed: 10, life: 4 });
    for (let i = 0; i < 20; i++) { dm.update(1 / 60, ctx); }
    check("a dead player is not hit", hits.length === 0, "hits=" + hits.length);
    player.dead = false;
    dm.clear();
}

// --- 4b. player bullets and pierce -----------------------------------------

{
    const dm = createDanmaku({ capacity: 64 });
    const enemies = [
        { id: 11, x: 7, y: 6, radius: 0.5, dead: false },
        { id: 12, x: 9, y: 6, radius: 0.5, dead: false },
        { id: 13, x: 11, y: 6, radius: 0.5, dead: true }
    ];
    const hits = [];
    const ctx = {
        width: 16, height: 12, player: null, enemies: enemies,
        onHit: function (bullet, target) { hits.push(target.id); }
    };

    dm.emit("aimed", { x: 5, y: 6, angle: 0 }, { count: 1, speed: 8, life: 4, side: "player" });
    for (let i = 0; i < 60 && dm.active > 0; i++) { dm.update(1 / 60, ctx); }
    check("a player bullet stops on the first enemy", hits.join(",") === "11", hits.join(","));
    check("and is consumed", dm.active === 0, "active=" + dm.active);
    hits.length = 0;
    dm.clear();

    dm.emit("aimed", { x: 5, y: 6, angle: 0 }, { count: 1, speed: 8, life: 4, side: "player", pierce: 2 });
    for (let i = 0; i < 120 && dm.active > 0; i++) { dm.update(1 / 60, ctx); }
    check("pierce 2 passes through both live enemies", hits.join(",") === "11,12", hits.join(","));
    check("a dead enemy is never hit", hits.indexOf(13) < 0);
    check("each enemy is hit at most once by one piercing bullet",
        new Set(hits).size === hits.length);
    hits.length = 0;
    dm.clear();
}

// --- 5. the leak gate: 10000 bullets, active must return to zero ------------

{
    const dm = createDanmaku({ capacity: 1024 });
    const ctx = { width: 16, height: 12, player: null, enemies: null };
    const TARGET = 10000;
    let emitted = 0;
    let volleys = 0;
    let peak = 0;
    let frames = 0;

    // Fire from a random spot in the room with a random bearing, cycling every
    // pattern, and let each volley fly out before the next -- the shape a
    // long fight has. Nothing consumes these bullets: they leave only by life
    // expiry or by crossing the margin, which is the path a leak would hide in.
    let seed = 20260902;
    const rnd = function () {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    while (emitted < TARGET) {
        const pattern = PATTERNS[volleys % PATTERNS.length];
        const origin = { x: 1 + rnd() * 14, y: 1 + rnd() * 10, angle: rnd() * TAU };
        emitted += dm.emit(pattern, origin, {
            count: 12, arms: 4, steps: 6, speed: 5.5, life: 4.0
        });
        volleys += 1;
        peak = Math.max(peak, dm.active);
        // A tenth of a bullet's life between volleys, so several volleys are
        // always in flight together -- a leak that only shows under overlap
        // (double release, a slot handed out twice) has to show here.
        for (let i = 0; i < 24; i++) {
            dm.update(1 / 60, ctx);
            frames += 1;
            peak = Math.max(peak, dm.active);
        }
    }
    // Nothing else consumes these bullets, so the only way out is life expiry
    // or the room margin. The drain is bounded: an immortal bullet leaves the
    // loop with active > 0 instead of hanging the harness.
    let drainFrames = 0;
    while (dm.active > 0 && drainFrames < 900) {
        dm.update(1 / 60, ctx);
        drainFrames += 1;
        frames += 1;
    }

    check("fired at least 10000 bullets", emitted >= TARGET,
        emitted + " bullets in " + volleys + " volleys over " + frames + " frames");
    check("volleys really did overlap in flight", peak > 50, "peak=" + peak);
    check("弹幕池不泄漏：发射 10000 发后活跃数归零", dm.active === 0, "active=" + dm.active);
    check("the last volley drained on its own, well inside the 4 s life",
        drainFrames > 0 && drainFrames < 300, "drainFrames=" + drainFrames);
    check("nothing was dropped -- the pool was never oversubscribed",
        dm.dropped === 0, "dropped=" + dm.dropped);
    check("peak concurrency stayed under capacity", peak > 0 && peak <= dm.capacity,
        "peak=" + peak + "/" + dm.capacity);
    check("the pool still owns exactly `capacity` objects", dm.pool.slots.length === 1024);
    const slotIds = dm.pool.slots.map(function (o) { return o._slot; }).sort(function (a, b) { return a - b; });
    let permutation = slotIds.length === 1024;
    for (let i = 0; i < slotIds.length && permutation; i++) {
        if (slotIds[i] !== i) { permutation = false; }
    }
    check("slot indices are still a clean 0..1023 permutation", permutation);
    check("no bullet is left flagged alive", dm.pool.slots.every(function (o) { return o.alive === false; }));
    check("every slot is free again", dm.pool.free === dm.capacity,
        dm.pool.free + "/" + dm.capacity);
}

// --- 5b. saturation is counted, not thrown ---------------------------------

{
    const dm = createDanmaku({ capacity: 40 });
    let made = 0;
    for (let i = 0; i < 10; i++) {
        made += dm.emit("ring", { x: 8, y: 6, angle: i }, { count: 12, speed: 4 });
    }
    check("a saturated pool retains three whole rings, never a partial fourth",
        dm.active === 36 && made === 36 && dm.rejectedGroups === 7, "active=" + dm.active + " made=" + made);
    check("the shortfall is counted as `dropped`, not thrown",
        dm.dropped === 120 - 36, "dropped=" + dm.dropped);
    dm.resetDropped();
    check("resetDropped clears the counter", dm.dropped === 0);
    dm.clear();
    check("clear() returns every bullet to the pool", dm.active === 0, "active=" + dm.active);
    check("and the pool is immediately reusable",
        dm.emit("ring", { x: 8, y: 6, angle: 0 }, { count: 12 }) === 12 && dm.active === 12);
}

// --- 5c. hits cannot leak either ---------------------------------------------

{
    // The same volume again, but with a player in the room eating a good share
    // of it: the hit path releases bullets too, and it is the path that would
    // double-release (and corrupt the pool) if it were wrong. The emitter sits
    // four units away so bullets fly in -- some land, some sail past.
    const dm = createDanmaku({ capacity: 512 });
    const player = { x: 8, y: 6, radius: 0.45, iframes: 0, dead: false };
    let hits = 0;
    const ctx = {
        width: 16, height: 12, player: player, enemies: null,
        onHit: function () { hits += 1; }
    };
    let emitted = 0;
    let volleys = 0;
    while (emitted < 10000) {
        emitted += dm.emit(PATTERNS[volleys % PATTERNS.length],
            { x: 4, y: 6, angle: Math.sin(volleys * 0.37) * 0.5 },
            { count: 16, arms: 4, steps: 6, speed: 5.0, life: 4.0 });
        volleys += 1;
        for (let i = 0; i < 24; i++) { dm.update(1 / 60, ctx); }
    }
    let drainFrames = 0;
    while (dm.active > 0 && drainFrames < 900) { dm.update(1 / 60, ctx); drainFrames += 1; }

    check("10000 more bullets fired at a player standing four units away",
        emitted >= 10000, "emitted=" + emitted);
    check("many of them hit", hits > 100, "hits=" + hits);
    check("the pool still drains to zero through the hit path", dm.active === 0, "active=" + dm.active);
    check("the drain finished on its own", drainFrames < 300, "drainFrames=" + drainFrames);
    check("no bullet is left flagged alive", dm.pool.slots.every(function (o) { return o.alive === false; }));
    const ids = dm.pool.slots.map(function (o) { return o._slot; }).sort(function (a, b) { return a - b; });
    check("slot indices are intact", ids[0] === 0 && ids[511] === 511 && new Set(ids).size === 512);
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall danmaku checks passed");
process.exit(failures ? 1 : 0);
