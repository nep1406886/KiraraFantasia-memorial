const METRICS = Object.freeze({
    gates: stats => Math.max(0, Number(stats?.gatesUsed) || 0),
    healed: stats => Math.max(0, Number(stats?.healed) || 0)
});

export function evaluateChallenge(level, stats, phase) {
    const rule = level?.challenge;
    if (!rule) { return null; }
    const metric = METRICS[rule.type];
    if (!metric || !Number.isFinite(rule.target) || rule.target < 0) { return null; }
    const value = metric(stats);
    const reached = rule.type === "gates" ? value <= rule.target : value >= rule.target;
    return { ...rule, label: level.optional, value, complete: phase === "won" && reached };
}
