// T30: one explicit player ailment, Unhappy (healing lock), not a generic
// implementation of the original's eight ailments. State belongs to the unit.
// No rendering, storage, timers, or independent random stream.
export const HEALING_LOCK_INDEX = 5;
export const HEALING_LOCK_TURNS = 2;

const positive = value => Number.isFinite(value) && value > 0;
const alive = unit => unit && unit.kind === "player" && !unit.dead;
const remaining = value => positive(value) ? value : 0;

export function healingLocked(unit) {
    return !!(unit && positive(unit.healingLock));
}

export function applyHealingLock(unit, chance, seconds, rng) {
    if (!alive(unit) || !positive(chance) || chance > 1 || !positive(seconds)) return null;
    if (positive(unit.healingLockImmunity) || (unit.passives && unit.passives.healingLockImmune)) {
        return { action: "immune" };
    }
    if (chance < 1) {
        const roll = (typeof rng === "function" ? rng : Math.random)();
        if (!Number.isFinite(roll) || roll < 0 || roll >= chance) return { action: "miss" };
    }
    unit.healingLock = Math.max(remaining(unit.healingLock), seconds);
    return { action: "applied", remaining: unit.healingLock };
}

export function cleanseHealingLock(unit) {
    if (!alive(unit) || !healingLocked(unit)) return null;
    unit.healingLock = 0;
    return { action: "cleared" };
}

export function grantHealingLockImmunity(unit, seconds) {
    if (!alive(unit) || !positive(seconds)) return null;
    // Protection never removes an already active ailment. In particular,
    // Hanako's self-inflicted Unhappy precedes her immunity in the source row.
    unit.healingLockImmunity = Math.max(remaining(unit.healingLockImmunity), seconds);
    return { action: "protected", remaining: unit.healingLockImmunity };
}

export function updatePlayerStatus(unit, dt) {
    if (!unit || !positive(dt)) return;
    for (const key of ["healingLock", "healingLockImmunity"]) {
        const left = remaining(unit[key]) - dt;
        unit[key] = left > 1e-9 ? left : 0;
    }
}

export function clearPlayerStatus(unit) {
    if (!unit) return;
    unit.healingLock = 0;
    unit.healingLockImmunity = 0;
}
