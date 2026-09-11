// Bounded, ground-space enemy commitments. Damage goes back through the
// world's hit funnel; the view consumes shapes, never recomputes their reach.
import { inMeleeArc, effectiveStat } from "./combat.js";
import { segmentDistanceSquared, stopCircle, sweepCircleTime } from "./geometry.js";

export const SPECIAL_THREAT_LIMIT = 2;
export const PHASE_RECOVERY = 1.1;
export const CHOREOGRAPHY_STATES = {
    idle: { duration: 0, exits: ["telegraph", "recover", "dead"] },
    telegraph: { duration: 0, exits: ["skill", "dash", "recover", "dead"] },
    skill: { duration: 0, exits: ["recover", "dead"] },
    dash: { duration: 0, exits: ["recover", "dead"] },
    recover: { duration: 0, exits: ["idle", "dead"] },
    dead: { duration: 0, exits: [] }
};

export function inEnemyArea(area, body) {
    const radius = body.radius || 0;
    if (area.kind === "lane") {
        return segmentDistanceSquared(body.x, body.y, area.x1, area.y1, area.x2, area.y2)
            <= (area.radius + radius) ** 2;
    }
    const distance = Math.hypot(body.x - area.x, body.y - area.y);
    if (area.kind === "annulus") { return distance + radius >= area.inner && distance - radius <= area.outer; }
    if (area.kind === "disc") { return distance <= area.radius + radius; }
    if (area.kind === "sector") {
        return inMeleeArc({ x: area.x, y: area.y, facing: area.angle }, body, area.radius, area.arc);
    }
    return false;
}

function lane(x, y, angle, distance, radius, behind = 0) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    return { kind: "lane", x1: x - dx * behind, y1: y - dy * behind,
        x2: x + dx * distance, y2: y + dy * distance, radius };
}
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function planEnemyAction(unit, world, move) {
    const p = world.player, x = unit.x, y = unit.y;
    const angle = Math.atan2(p.y - y, p.x - x);
    let shapes;
    if (move.kind === "charge") {
        const distance = Math.min(move.range, Math.hypot(p.x - x, p.y - y) + .6);
        const end = stopCircle(unit, Math.cos(angle) * distance, Math.sin(angle) * distance,
            world.roomColliders, { minX: unit.radius, maxX: world.width - unit.radius,
                minY: unit.radius, maxY: world.height - unit.radius });
        shapes = [{ kind: "lane", x1: x, y1: y, x2: end.x, y2: end.y, radius: unit.radius }];
    } else if (move.kind === "sector") {
        shapes = [{ kind: "sector", x, y, angle, radius: move.radius, arc: move.arc }];
    } else if (move.kind === "disc") {
        shapes = [{ kind: "disc", x, y, radius: move.radius }];
    } else if (move.kind === "annulus") {
        shapes = [{ kind: "annulus", x, y, inner: move.inner, outer: move.outer }];
    } else if (move.kind === "spots") {
        const offsets = move.count === 3 ? [0, -move.spacing, move.spacing] : [0, move.spacing];
        shapes = offsets.map(offset => ({ kind: "disc", radius: move.radius,
            x: clamp(p.x - Math.sin(angle) * offset, move.radius, world.width - move.radius),
            y: clamp(p.y + Math.cos(angle) * offset, move.radius, world.height - move.radius) }));
    } else if (move.kind === "line") {
        shapes = [lane(x, y, angle, move.range, move.radius)];
    } else if (move.kind === "lanes") {
        shapes = [-move.spacing, move.spacing].map(offset => lane(x - Math.sin(angle) * offset,
            y + Math.cos(angle) * offset, angle, move.range, move.radius));
    } else if (move.kind === "cross") {
        const at = move.onPlayer ? p : unit;
        shapes = [0, Math.PI / 2].map(turn => lane(at.x, at.y, angle + turn,
            move.range, move.radius, move.range));
    } else { throw new Error("Unknown enemy action: " + move.kind); }
    return { move, angle, shapes: Object.freeze(shapes.map(shape => Object.freeze(shape))),
        stage: "windup", age: 0, hit: false, previousPlayer: { x: p.x, y: p.y } };
}

export function cancelEnemyAction(unit, recovery = .8) {
    if (!unit.choreography) { return; }
    unit.action = null;
    unit.pending = null;
    unit.aimAt = null;
    unit.dash = null;
    unit.kx = 0; unit.ky = 0;
    unit.recoveryWindow = unit.dead ? 0 : recovery;
    if (!unit.dead) { unit.sm.set("recover"); }
}

function recoverDuration(unit, move) {
    const spd = effectiveStat(unit, "spd") || 100;
    const slow = unit.slow?.pct || 0;
    return Math.max(.8, move.recovery * 100 / spd / Math.max(.2, 1 - slow));
}

function nextMove(unit, world) {
    const profile = unit.choreography;
    const rotation = profile.rotations[Math.min((unit.phase || 1) - 1, profile.rotations.length - 1)];
    const distance = Math.hypot(world.player.x - unit.x, world.player.y - unit.y);
    for (let tries = 0; tries < rotation.length; tries++) {
        const key = rotation[unit.choreographyCursor % rotation.length];
        unit.choreographyCursor++;
        const move = profile.moves.find(candidate => candidate.key === key);
        if (!move) { continue; }
        if (["sector", "disc"].includes(move.kind) && distance > move.radius + world.player.radius + .7) { continue; }
        return move;
    }
    return null;
}

function busy(unit) {
    return !unit.dead && unit.stunTimer <= 0 && unit.action
        && (unit.action.stage === "windup" || unit.action.stage === "active");
}

// Rotate admission, not update order. A released slot belongs to the next
// ready unit after the last grant, even when warnings have different lengths.
// The cursor is room-local and the scan is bounded by the live enemy array.
function hasActionTurn(unit, world) {
    const enemies = world.enemies;
    let threats = 0;
    for (const enemy of enemies) { if (busy(enemy)) { threats++; } }
    if (threats >= SPECIAL_THREAT_LIMIT) { return false; }
    const start = (world.enemyActionCursor || 0) % enemies.length;
    for (let offset = 0; offset < enemies.length; offset++) {
        const index = (start + offset) % enemies.length, candidate = enemies[index];
        if (candidate.dead || candidate.stunTimer > 0 || !candidate.choreography
                || candidate.action || candidate.recoveryWindow > 0
                || candidate.sm.state !== "idle" || candidate.actionTimer > 0) { continue; }
        if (candidate !== unit) { return false; }
        world.enemyActionCursor = (index + 1) % enemies.length;
        return true;
    }
    return false;
}

export function updateEnemyAction(unit, world, dt, thresholds) {
    if (unit.dead) { cancelEnemyAction(unit); return; }
    if (unit.stunTimer > 0) { cancelEnemyAction(unit); return; }
    const p = world.player;
    if (!p || p.dead) { cancelEnemyAction(unit); return; }
    // Elites are two-move duels, not small copies of the three-phase boss.
    if (unit.kind === "boss") {
        let phase = 1;
        for (let i = 0; i < thresholds.length; i++) {
            if (unit.hp / unit.maxHp <= thresholds[i]) { phase = i + 2; }
        }
        if (phase > unit.phase) {
            unit.phase = phase;
            unit.choreographyCursor = 0;
            cancelEnemyAction(unit, PHASE_RECOVERY);
            world.events.push({ type: "bossPhase", unit, phase });
            return;
        }
    }
    if (unit.recoveryWindow > 0) {
        unit.recoveryWindow = Math.max(0, unit.recoveryWindow - dt);
        if (unit.recoveryWindow <= 1e-9) { unit.recoveryWindow = 0; unit.sm.set("idle"); }
        return;
    }
    const action = unit.action;
    if (!action) {
        unit.actionTimer = (unit.actionTimer || 0) - dt;
        if (unit.actionTimer > 0 || unit.sm.state !== "idle") { return; }
        if (!hasActionTurn(unit, world)) { return; }
        const move = nextMove(unit, world);
        if (!move) { unit.actionTimer = .2; return; }
        unit.action = planEnemyAction(unit, world, move);
        unit.facing = unit.action.angle;
        unit.kx = 0; unit.ky = 0;
        unit.pending = { ...move.skill, pattern: move.kind };
        unit.sm.set("telegraph");
        world.events.push({ type: "telegraph", unit, skill: move.skill, pattern: move.kind,
            duration: move.warning, label: move.label, counter: move.counter });
        return;
    }
    action.age += dt;
    if (action.stage !== "recover") { unit.kx = 0; unit.ky = 0; }
    if (action.stage === "windup") {
        if (action.age + 1e-9 >= action.move.warning) {
            action.stage = "active"; action.age = 0;
            unit.pending = null;
            unit.sm.set(action.move.kind === "charge" ? "dash" : "skill");
            world.events.push({ type: "enemySkill", unit, skill: action.move.skill,
                pattern: action.move.kind, bullets: 0, label: action.move.label });
        }
    } else if (action.stage === "active") {
        let touches = false;
        if (action.move.kind === "charge") {
            const path = action.shapes[0], progress = Math.min(1, action.age / action.move.active);
            const fromX = unit.x, fromY = unit.y;
            unit.x = path.x1 + (path.x2 - path.x1) * progress;
            unit.y = path.y1 + (path.y2 - path.y1) * progress;
            // Both bodies move. Relative sweep prevents a crossing player from
            // slipping through a fast lunge between fixed-step boundaries.
            touches = Number.isFinite(sweepCircleTime(fromX - action.previousPlayer.x,
                fromY - action.previousPlayer.y, unit.x - p.x, unit.y - p.y, 0, 0, unit.radius + p.radius));
        } else { touches = action.shapes.some(shape => inEnemyArea(shape, p)); }
        if (touches && !action.hit) {
            const result = world.hitPlayerFrom(unit, action.move.skill, { enemyAction: action.move.key });
            if (result.hit) { action.hit = true; }
            if (p.dead) { cancelEnemyAction(unit); return; }
        }
        if (action.age + 1e-9 >= action.move.active) {
            action.stage = "recover"; action.age = 0;
            action.recovery = recoverDuration(unit, action.move);
            unit.sm.set("recover");
            world.events.push({ type: "enemyRecovery", unit, duration: action.recovery });
        }
    } else if (action.stage === "recover" && action.age + 1e-9 >= action.recovery) {
        unit.action = null;
        unit.sm.set("idle");
        unit.actionTimer = .18;
    }
    action.previousPlayer.x = p.x; action.previousPlayer.y = p.y;
}
