// T30: the player abnormal layer. The original's enum (game-source
// Star/eStateAbnormal.cs) is 0 Confusion 1 Paralysis 2 Poison 3 Bearish
// 4 Sleep 5 Unhappy 6 Silence 7 Isolation; this game registers the slots it
// actually runs, and the cleanse/immunity masks are read against the
// registry instead of a hardcoded index. State belongs to the unit. No
// rendering, storage, timers, or independent random stream.
//
// 2026-09-17: kind 6 is the original's blanket disable, not a per-ailment
// grant — BattleCommandParser.SolveSkillContent_AbnormalDisable writes
// [turnConsume, turn] into CharacterBattleParam.SetStateAbnormalDisableBuff
// and GetStateAbnormalDisableBuffValue() protects EVERY eStateAbnormal while
// it runs. kind 5 (SolveSkillContent_AbnormalRecover) resets one
// eStateAbnormal per non-zero m_Args slot.
export const HEALING_LOCK_INDEX = 5;
export const HEALING_LOCK_TURNS = 2;
export const POISON_INDEX = 2;
export const BEARISH_INDEX = 3;
// The shipped rows carry a chance per ailment and no duration/amount, so the
// action fold owns them the same way the healing lock owns its timer.
export const POISON_TURNS = 3;
export const POISON_PCT_PER_TURN = 0.03;
export const BEARISH_TURNS = 3;

// Registered player ailments: index = the original's eStateAbnormal slot.
export const AILMENTS = Object.freeze([
    Object.freeze({ index: HEALING_LOCK_INDEX, key: "healingLock", name: "治疗封锁" }),
    Object.freeze({ index: POISON_INDEX, key: "poison", name: "中毒" }),
    Object.freeze({ index: BEARISH_INDEX, key: "bearish", name: "弱守" })
]);

const positive = value => Number.isFinite(value) && value > 0;
const alive = unit => unit && unit.kind === "player" && !unit.dead;
const remaining = value => positive(value) ? value : 0;

export function healingLocked(unit) {
    return !!(unit && positive(unit.healingLock));
}

// The kind-6 blanket: while it runs, no registered ailment can land.
export function abnormalDisabled(unit) {
    return !!(unit && positive(unit.abnormalDisable));
}

export function applyHealingLock(unit, chance, seconds, rng) {
    if (!alive(unit) || !positive(chance) || chance > 1 || !positive(seconds)) return null;
    if (abnormalDisabled(unit) || positive(unit.healingLockImmunity)
            || (unit.passives && unit.passives.healingLockImmune)) {
        return { action: "immune" };
    }
    if (chance < 1) {
        const roll = (typeof rng === "function" ? rng : Math.random)();
        if (!Number.isFinite(roll) || roll < 0 || roll >= chance) return { action: "miss" };
    }
    unit.healingLock = Math.max(remaining(unit.healingLock), seconds);
    return { action: "applied", remaining: unit.healingLock };
}

export function poisoned(unit) {
    return !!(unit && positive(unit.poison));
}

export function bearished(unit) {
    return !!(unit && positive(unit.bearish));
}

// kind 4 with the Poison slot flagged. Same guards as the healing lock; the
// per-ailment equipment passive covers Unhappy only, so it never blocks this.
export function applyPoison(unit, chance, seconds, rng) {
    if (!alive(unit) || !positive(chance) || chance > 1 || !positive(seconds)) return null;
    if (abnormalDisabled(unit)) {
        return { action: "immune" };
    }
    if (chance < 1) {
        const roll = (typeof rng === "function" ? rng : Math.random)();
        if (!Number.isFinite(roll) || roll < 0 || roll >= chance) return { action: "miss" };
    }
    unit.poison = Math.max(remaining(unit.poison), seconds);
    return { action: "applied", remaining: unit.poison };
}

// kind 4 with the Bearish slot flagged: the original's own critical rule
// (BattleCommandParser.CalcCritical) returns true for any hit on a Bearish
// target, so every incoming hit crits while it runs.
export function applyBearish(unit, chance, seconds, rng) {
    if (!alive(unit) || !positive(chance) || chance > 1 || !positive(seconds)) return null;
    if (abnormalDisabled(unit)) {
        return { action: "immune" };
    }
    if (chance < 1) {
        const roll = (typeof rng === "function" ? rng : Math.random)();
        if (!Number.isFinite(roll) || roll < 0 || roll >= chance) return { action: "miss" };
    }
    unit.bearish = Math.max(remaining(unit.bearish), seconds);
    return { action: "applied", remaining: unit.bearish };
}

// kind 5: clears every REGISTERED ailment the mask flags. Slots the game
// does not run can never be active, so a flagged unregistered slot clears
// nothing rather than leaving the row half-decoded.
export function cleanseAbnormals(unit, mask) {
    if (!alive(unit)) return null;
    const cleared = [];
    for (const ailment of AILMENTS) {
        if (mask && !mask.includes(ailment.index)) continue;
        if (positive(unit[ailment.key])) {
            unit[ailment.key] = 0;
            cleared.push(ailment.key);
        }
    }
    return cleared.length ? { action: "cleared", cleared: cleared } : null;
}

export function cleanseHealingLock(unit) {
    const result = cleanseAbnormals(unit, [HEALING_LOCK_INDEX]);
    return result ? { action: "cleared" } : null;
}

// kind 6 per the original: one buff protects against every abnormal state
// for its duration. Never removes an already active ailment — Hanako's
// self-inflicted Unhappy precedes her immunity in the source row.
export function grantAbnormalDisable(unit, seconds) {
    if (!alive(unit) || !positive(seconds)) return null;
    unit.abnormalDisable = Math.max(remaining(unit.abnormalDisable), seconds);
    return { action: "protected", remaining: unit.abnormalDisable };
}

// Per-ailment protection (equipment passive / legacy rows): Unhappy only.
export function grantHealingLockImmunity(unit, seconds) {
    if (!alive(unit) || !positive(seconds)) return null;
    unit.healingLockImmunity = Math.max(remaining(unit.healingLockImmunity), seconds);
    return { action: "protected", remaining: unit.healingLockImmunity };
}

// dt in seconds. The poison tick needs to touch HP, which belongs to the
// world, so the caller supplies onPoisonTick(amountFraction); returning
// false from it stops further ticks this frame (the unit died).
export function updatePlayerStatus(unit, dt, turnSeconds, onPoisonTick) {
    if (!unit || !positive(dt)) return;
    for (const key of ["healingLock", "healingLockImmunity", "abnormalDisable", "bearish"]) {
        const left = remaining(unit[key]) - dt;
        unit[key] = left > 1e-9 ? left : 0;
    }
    if (positive(unit.poison)) {
        // One tick per authored turn: the tick consumes that much of the
        // ailment, so a 3-turn poison ticks exactly three times and the
        // final tick is not lost to the expiry frame.
        const window = positive(turnSeconds) ? turnSeconds : 2.8;
        unit.poisonElapsed = (unit.poisonElapsed || 0) + dt;
        while (unit.poison > 1e-9 && unit.poisonElapsed + 1e-9 >= window) {
            unit.poisonElapsed -= window;
            unit.poison = remaining(unit.poison) - window;
            if (onPoisonTick && onPoisonTick(POISON_PCT_PER_TURN) === false) { break; }
        }
        if (unit.poison <= 1e-9) { unit.poison = 0; unit.poisonElapsed = 0; }
    } else {
        unit.poison = 0;
        unit.poisonElapsed = 0;
    }
}

export function clearPlayerStatus(unit) {
    if (!unit) return;
    unit.healingLock = 0;
    unit.healingLockImmunity = 0;
    unit.abnormalDisable = 0;
    unit.bearish = 0;
    unit.poison = 0;
    unit.poisonElapsed = 0;
}