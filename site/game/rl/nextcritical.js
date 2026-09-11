// Kind 12 is one pending action, separate from kind 11 and timed stat buffs.
// Only explicit player attack delivery commits it; CARD never reads this state.
export function decodeNextCritical(effect) {
    if (!effect || effect.kind !== 12 || ![0, 3, 4].includes(effect.target)
            || !Array.isArray(effect.args) || effect.args.length !== 0) return null;
    return Object.freeze({ target: effect.target });
}

export function grantNextCritical(unit) {
    if (!unit || unit.kind !== "player" || unit.dead) return null;
    const action = unit.nextCritical === true ? "refreshed" : "ready";
    unit.nextCritical = true;
    return action;
}

export function consumeNextCritical(unit) {
    if (!unit || unit.kind !== "player" || unit.dead || unit.nextCritical !== true) return false;
    unit.nextCritical = false;
    return true;
}

export function clearNextCritical(unit) {
    if (unit) unit.nextCritical = false;
}
