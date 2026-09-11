// Original kind 3, versioned masks. Only temporary six-stat fields belong here.
// No DOM, timers, equipment, mutation of source rows, or reset of other effects.
export const STAT_KEYS = Object.freeze(["atk", "mgc", "def", "mdef", "spd", "luck"]);

export function decodeStatReset(effect) {
    const args = effect && effect.args;
    if (!effect || effect.kind !== 3 || ![0, 1, 2, 3, 4].includes(effect.target)
            || !Array.isArray(args) || (args.length !== 6 && args.length !== 7)
            || ![...args].every(value => value === 0 || value === 1)) return null;
    const stats = STAT_KEYS.filter((key, index) => args[index] === 1);
    if (!stats.length) return null;
    return Object.freeze({ target: effect.target, stats: Object.freeze(stats),
        mode: args.length === 6 ? "all" : args[6] === 0 ? "down" : "up" });
}

// Entries may contain both signs and unrelated effects. Clear selected fields,
// never a whole row or its timer; zeroed rows expire on the existing clock.
export function resetStatChanges(buffs, reset) {
    const changed = [];
    if (!Array.isArray(buffs) || !reset || !["all", "down", "up"].includes(reset.mode)
            || !Array.isArray(reset.stats) || reset.stats.some(key => !STAT_KEYS.includes(key))) return changed;
    for (const key of reset.stats) {
        for (const buff of buffs) {
            const value = buff[key];
            if (!(buff.remaining > 0) || !Number.isFinite(value) || value === 0) continue;
            if ((reset.mode === "down" && value > 0) || (reset.mode === "up" && value < 0)) continue;
            buff[key] = 0;
            if (!changed.includes(key)) changed.push(key);
        }
    }
    return changed;
}
