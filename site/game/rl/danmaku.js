// Danmaku: the bullet layer for both sides.
//
// HARD RULE (master plan §4.1): no three.js, no DOM. The view reads bullets out
// of here and never writes back. Collision resolution is *reported*, not
// applied -- update() calls the onHit callback and world.js decides what a hit
// means (combat.js resolveDamage, i-frames, events). That split is what lets
// a node harness fire 10^4 bullets with no world at all.
//
// Bullets come out of a fixed pool (pool.js): a boss spiral asks for hundreds
// of objects a second and GC pauses are unaffordable in a dodge-timing game.
//
// Room geometry (dungeon.js ROOM_SIZE) is 16x12 world units, the player walks
// at 3.5 u/s and dodges at 8.4 u/s, so the defaults below (5.5 u/s, 4 s life)
// give bullets that outrun a walk, lose to a dodge, and always leave the room.

import { createPool } from "./pool.js";
import { sweepCircleTime } from "./geometry.js";

// The shapes the enemy skill table classifies into (build_rl_data.py's
// danmaku_pattern()); "charge" in that table is a melee lunge and never
// reaches this file. Kept exported so the enemy harness can assert the shipped
// data only ever names a pattern that exists here.
export const PATTERNS = ["aimed", "fan", "ring", "spiral",
    "volley", "wave", "cross", "wall"];

export const DANMAKU_DEFAULTS = {
    capacity: 1024,
    speed: 5.5,
    radius: 0.18,
    life: 4.0,
    // Fan opening and spiral step, in radians.
    spread: Math.PI / 3,
    turn: 0.42,
    // How far outside the room a bullet flies before it is recycled. One
    // bullet radius would pop them on the wall line, which reads as a bullet
    // being eaten by the wall mid-sprite.
    margin: 1.0,
    // Spiral: bullets per arm and the delay between steps.
    steps: 6,
    stepDelay: 0.09
};

// Preserve valid count defaults/minima, but never loop on a non-finite request.
function quantity(value, fallback, minimum) {
    const n = value === undefined || value === null || value === 0 ? fallback : value;
    return Number.isFinite(n) ? Math.max(minimum, Math.ceil(n)) : NaN;
}

function bulletFactory() {
    return {
        x: 0, y: 0, vx: 0, vy: 0,
        radius: DANMAKU_DEFAULTS.radius,
        life: 0,
        maxLife: 0,
        delay: 0,            // spiral steps start pending, then wake up
        curve: 0,            // rad/s applied to the velocity direction
        side: "enemy",       // "enemy" bullets hurt the player, "player" ones enemies
        element: 0,
        // Offence snapshot taken at emit time: the shooter may be dead before
        // the bullet lands, and re-looking-up its stats per hit is a scan.
        power: 0,            // atk or mgc, already chosen by `magic`
        coef: 1,
        magic: false,
        critChance: 0,
        forceCritical: false,
        noCrit: false,
        noAdvantage: false,
        weakElementBonus: 0,
        healingLockChance: 0,
        healingLockSeconds: 0,
        hitStatResets: null,
        srcId: 0,
        skillId: 0,
        pattern: "aimed",
        pierce: 0,           // extra targets a player bullet may pass through
        hitIds: null,        // Set, only allocated for piercing bullets
        // T25 skill riders: slow is pct 0..1, applied to whatever the bullet
        // hits; resistEffect is { by:{elementId: fraction}, seconds } and
        // lands on the hit target as a timed entry. Enemy bullets leave
        // these at the factory defaults.
        slow: 0,
        slowSeconds: 0,
        resistEffect: null,
        statEffects: null
    };
}

export function createDanmaku(options) {
    const cfg = Object.assign({}, DANMAKU_DEFAULTS, options || {});
    const pool = createPool(cfg.capacity, bulletFactory);
    // Requests the pool could not satisfy. A saturated screen is a design
    // signal, not an error, so it is counted rather than thrown.
    let dropped = 0;
    let rejectedGroups = 0;
    let invalidGroups = 0;
    let spawnId = 0; // render snapshots must distinguish a recycled pool slot

    function spawn(x, y, angle, mods, delay) {
        const b = pool.acquire();
        if (!b) {
            dropped += 1;
            return null;
        }
        const speed = mods.speed !== undefined ? mods.speed : cfg.speed;
        b.spawnId = ++spawnId;
        b.x = x;
        b.y = y;
        b.vx = Math.cos(angle) * speed;
        b.vy = Math.sin(angle) * speed;
        b.radius = mods.radius !== undefined ? mods.radius : cfg.radius;
        b.life = mods.life !== undefined ? mods.life : cfg.life;
        b.maxLife = b.life;
        b.delay = delay || 0;
        b.curve = mods.curve || 0;
        b.side = mods.side === "player" ? "player" : "enemy";
        b.element = mods.element || 0;
        b.power = mods.power || 0;
        b.coef = mods.coef !== undefined ? mods.coef : 1;
        b.magic = !!mods.magic;
        b.critChance = mods.critChance || 0;
        b.forceCritical = mods.forceCritical === true;
        b.noCrit = mods.noCrit === true;
        b.noAdvantage = mods.noAdvantage === true;
        b.critDamage = mods.critDamage || 0;
        b.weakElementBonus = Number.isFinite(mods.weakElementBonus) ? Math.max(0, mods.weakElementBonus) : 0;
        b.healingLockChance = Number.isFinite(mods.healingLockChance)
            ? Math.min(1, Math.max(0, mods.healingLockChance)) : 0;
        b.healingLockSeconds = Number.isFinite(mods.healingLockSeconds)
            ? Math.max(0, mods.healingLockSeconds) : 0;
        // Reset definitions are immutable; the list is an emission snapshot.
        b.hitStatResets = mods.hitStatResets && mods.hitStatResets.length
            ? mods.hitStatResets.slice() : null;
        b.normalContext = mods.normalContext || null;
        b.blastRadius = mods.blastRadius || 0;
        b.srcId = mods.srcId || 0;
        b.skillId = mods.skillId || 0;
        b.pattern = mods.pattern || "aimed";
        b.pierce = mods.pierce || 0;
        b.slow = mods.slow || 0;
        b.slowSeconds = mods.slowSeconds || 0;
        b.resistEffect = mods.resistEffect || null;
        b.statEffects = mods.statEffects || null;
        if (b.pierce > 0) {
            if (b.hitIds) { b.hitIds.clear(); } else { b.hitIds = new Set(); }
        } else {
            b.hitIds = null; // a recycled non-piercing shot has no old victims
        }
        return b;
    }

    // emit(pattern, origin, mods) -> bullets actually created (T07 contract).
    //
    //   origin { x, y, angle }   angle 0 = +x, same convention as unit.facing
    //   mods   { count, speed, spread, radius, life, curve, side, element,
    //            power, coef, magic, critChance, srcId, skillId, pierce,
    //            arms, steps, stepDelay, turn }
    function emit(pattern, origin, mods) {
        const m = mods || {};
        let count, arms = 1;
        switch (pattern) {
        case "aimed": case "cross": count = quantity(m.count, 1, 1); break;
        case "fan": count = quantity(m.count, 5, 2); break;
        case "ring": count = quantity(m.count, 12, 3); break;
        case "volley": case "wave": count = quantity(m.count, 3, 2); break;
        case "wall": count = quantity(m.count, 7, 3); break;
        case "spiral":
            arms = quantity(m.arms, 3, 1);
            count = quantity(m.steps !== undefined ? m.steps : cfg.steps, 1, 1);
            break;
        default: return 0;
        }
        const required = count * (pattern === "cross" ? 4 : arms);
        if (!Number.isSafeInteger(required) || required <= 0) {
            invalidGroups += 1;
            return 0;
        }
        // This synchronous call owns the whole group, including delayed shots.
        // Refusing before the first acquire preserves all existing safe lanes.
        if (required > pool.free) {
            dropped += required;
            rejectedGroups += 1;
            return 0;
        }
        const o = origin || { x: 0, y: 0, angle: 0 };
        const base = o.angle || 0;
        // Muzzle offset: bullets that start inside the shooter's own body read
        // as spawning on top of the player when the shooter is adjacent.
        const off = m.offset !== undefined ? m.offset : 0.35;
        const ox = o.x + Math.cos(base) * off;
        const oy = o.y + Math.sin(base) * off;
        const withPattern = Object.assign({}, m, { pattern: pattern });
        let made = 0;

        if (pattern === "aimed") {
            // A short line of shots down one bearing; count > 1 staggers them
            // in time so it reads as a burst, not a wall.
            const delay = m.stepDelay !== undefined ? m.stepDelay : 0.08;
            for (let i = 0; i < count; i++) {
                if (spawn(ox, oy, base, withPattern, i * delay)) { made += 1; }
            }
            return made;
        }

        if (pattern === "fan") {
            const spread = m.spread !== undefined ? m.spread : cfg.spread;
            const start = base - spread / 2;
            const step = spread / (count - 1);
            for (let i = 0; i < count; i++) {
                if (spawn(ox, oy, start + step * i, withPattern, 0)) { made += 1; }
            }
            return made;
        }

        if (pattern === "ring") {
            const step = (Math.PI * 2) / count;
            for (let i = 0; i < count; i++) {
                const angle = base + step * i;
                const x = o.x + Math.cos(angle) * off;
                const y = o.y + Math.sin(angle) * off;
                if (spawn(x, y, angle, withPattern, 0)) { made += 1; }
            }
            return made;
        }

        if (pattern === "spiral") {
            // One call lays down a whole rotating spiral: `arms` bearings, each
            // stepping `turn` radians per `steps` and starting `stepDelay`
            // later, so later bullets are still near the source when the
            // earlier ones are out -- the classic arm shape. Pending bullets
            // hold a slot, which is exactly why the pool is sized for it.
            const steps = count;
            const turn = m.turn !== undefined ? m.turn : cfg.turn;
            const stepDelay = m.stepDelay !== undefined ? m.stepDelay : cfg.stepDelay;
            const armStep = (Math.PI * 2) / arms;
            for (let s = 0; s < steps; s++) {
                for (let a = 0; a < arms; a++) {
                    const angle = base + armStep * a + turn * s;
                    const x = o.x + Math.cos(angle) * off;
                    const y = o.y + Math.sin(angle) * off;
                    if (spawn(x, y, angle, withPattern, s * stepDelay)) { made += 1; }
                }
            }
            return made;
        }

        if (pattern === "volley") {
            // A longer, faster burst than aimed's stagger: three shots down
            // one bearing with enough gap to walk between reading them.
            const delay = m.stepDelay !== undefined ? m.stepDelay : 0.15;
            for (let i = 0; i < count; i++) {
                if (spawn(ox, oy, base, withPattern, i * delay)) { made += 1; }
            }
            return made;
        }

        if (pattern === "wave") {
            // A fan whose bullets curve in alternating directions: the spread
            // weaves instead of widening, so the safe lane moves with time.
            const spread = m.spread !== undefined ? m.spread : Math.PI / 2;
            const curve = m.curve !== undefined ? m.curve : 0.9;
            const start = base - spread / 2;
            const step = spread / (count - 1);
            for (let i = 0; i < count; i++) {
                const mods = Object.assign({}, withPattern,
                    { curve: (i % 2 === 0 ? 1 : -1) * curve });
                if (spawn(ox, oy, start + step * i, mods, 0)) { made += 1; }
            }
            return made;
        }

        if (pattern === "cross") {
            // Four bearings at right angles: the dodge direction that works
            // against an aimed shot is the trap here, and vice versa.
            const delay = m.stepDelay !== undefined ? m.stepDelay : 0.08;
            for (let k = 0; k < 4; k++) {
                const angle = base + (Math.PI / 2) * k;
                const x = o.x + Math.cos(angle) * off;
                const y = o.y + Math.sin(angle) * off;
                for (let i = 0; i < count; i++) {
                    if (spawn(x, y, angle, withPattern, i * delay)) { made += 1; }
                }
            }
            return made;
        }

        if (pattern === "wall") {
            // A slow curtain across the whole lane: bullets line up
            // perpendicular to the bearing and advance in step. Slow enough
            // that the read is "walk to the gap", not "dodge the bullet".
            const spacing = m.spacing !== undefined ? m.spacing : 0.8;
            const mods = Object.assign({}, withPattern, {
                radius: m.radius !== undefined ? m.radius : 0.22,
                life: m.life !== undefined ? m.life : 5.0
            });
            const px = Math.cos(base + Math.PI / 2);
            const py = Math.sin(base + Math.PI / 2);
            for (let i = 0; i < count; i++) {
                const t = (i - (count - 1) / 2) * spacing;
                if (spawn(ox + px * t, oy + py * t, base, mods, 0)) { made += 1; }
            }
            return made;
        }

        // Unknown pattern: create nothing and say so. Callers route "charge"
        // to the melee path instead of here.
        return 0;
    }

    // update(dt, ctx)
    //   ctx { width, height, player, enemies, previousPosition, onHit(bullet, target, contact) }
    //
    // Enemy bullets pass straight through an invulnerable player (i-frames)
    // instead of being consumed: a dodge should be a dodge, not a screen wipe.
    function update(dt, ctx) {
        const c = ctx || {};
        const width = c.width !== undefined ? c.width : 16;
        const height = c.height !== undefined ? c.height : 12;
        const player = c.player || null;
        const enemies = c.enemies || null;
        const margin = cfg.margin;

        pool.forEach(function (b) {
            // Pending spiral step: no motion, no collision. When the countdown
            // crosses zero the overshoot is spent on this frame, so steps stay
            // evenly spaced instead of quantising to the frame grid.
            let step = dt, offset = 0;
            if (b.delay > 0) {
                b.delay -= dt;
                if (b.delay > 0) {
                    return;
                }
                step = Math.min(dt, -b.delay);
                offset = dt - step;
                b.delay = 0;
            }

            step = Math.min(step, Math.max(0, b.life));
            const ax = b.x, ay = b.y;

            if (b.curve) {
                const angle = Math.atan2(b.vy, b.vx) + b.curve * step;
                const speed = Math.hypot(b.vx, b.vy);
                b.vx = Math.cos(angle) * speed;
                b.vy = Math.sin(angle) * speed;
            }
            b.x += b.vx * step;
            b.y += b.vy * step;
            b.life -= step;

            // Relative sweep also catches a moving body crossing a slow shot.
            // Delayed shots test only the active part of the fixed step.
            function contactTime(target) {
                const previous = c.previousPosition ? c.previousPosition(target) : null;
                const tx = previous ? target.x - previous.x : 0;
                const ty = previous ? target.y - previous.y : 0;
                const start = dt > 0 ? offset / dt : 0;
                const end = dt > 0 ? (offset + step) / dt : 1;
                return sweepCircleTime(ax - target.x + tx * (1 - start),
                    ay - target.y + ty * (1 - start),
                    b.x - target.x + tx * (1 - end), b.y - target.y + ty * (1 - end),
                    0, 0, b.radius + target.radius);
            }
            function contactPoint(target, t) {
                const previous = c.previousPosition ? c.previousPosition(target) : null;
                const phase = dt > 0 ? (offset + step * t) / dt : 1;
                const x = previous ? previous.x + (target.x - previous.x) * phase : target.x;
                const y = previous ? previous.y + (target.y - previous.y) * phase : target.y;
                const dx = ax + (b.x - ax) * t - x;
                const dy = ay + (b.y - ay) * t - y;
                const distance = Math.hypot(dx, dy);
                // The nearest point in the target disc touches the projectile
                // at first contact. Already-overlapping centres stay inside.
                const scale = distance > target.radius ? target.radius / distance : 1;
                return { x: x + dx * scale, y: y + dy * scale };
            }

            if (b.side === "enemy") {
                if (player && !player.dead && !(player.iframes > 0)) {
                    const t = contactTime(player);
                    if (Number.isFinite(t)) {
                        if (c.onHit) { c.onHit(b, player, contactPoint(player, t)); }
                        pool.release(b);
                        return;
                    }
                }
            } else if (enemies) {
                const contacts = [];
                for (const e of enemies) {
                    if (e.dead || e.iframes > 0 || (b.hitIds && b.hitIds.has(e.id))) { continue; }
                    const t = contactTime(e);
                    if (Number.isFinite(t)) { contacts.push({ e, t }); }
                }
                // The closest hit wins, not the enemy's array/spawn order.
                contacts.sort((a, b) => a.t - b.t || a.e.id - b.e.id);
                for (const { e, t } of contacts) {
                    if (e.dead) { continue; }
                    if (c.onHit) { c.onHit(b, e, contactPoint(e, t)); }
                    if (b.pierce > 0) {
                        b.pierce -= 1;
                        if (b.hitIds) { b.hitIds.add(e.id); }
                    } else {
                        pool.release(b);
                        return;
                    }
                }
            }
            // A final lifetime/room-crossing segment can still land a hit.
            if (b.life <= 0 || b.x < -margin || b.x > width + margin
                    || b.y < -margin || b.y > height + margin) { pool.release(b); }
        });
    }

    return {
        emit: emit,
        update: update,
        clear: function () { pool.clear(); },
        get active() { return pool.active; },
        get capacity() { return pool.capacity; },
        get dropped() { return dropped; },
        get rejectedGroups() { return rejectedGroups; },
        get invalidGroups() { return invalidGroups; },
        resetDropped: function () { dropped = 0; rejectedGroups = 0; invalidGroups = 0; },
        // Views walk this; it never mutates.
        forEach: function (fn) { pool.forEachStable(fn); },
        // Harness only.
        get pool() { return pool; }
    };
}
