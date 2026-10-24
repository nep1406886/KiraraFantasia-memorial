// 关卡「可选挑战」的判定：从 battle.stats 里取一个指标，和 target 比。
// 原来只有 gates 与 healed 两种，20 关里 17 关都是「不用结界」，玩家
// 读起来像同一个目标重播了 17 次。这里把 battle.stats 里已有的计数器
// 全部暴露成挑战指标，让关卡能用「不倒下任何人」「挡下若干次」这类
// 与关卡机制对得上的目标。
const METRICS = Object.freeze({
    gates: stats => Math.max(0, Number(stats?.gatesUsed) || 0),
    healed: stats => Math.max(0, Number(stats?.healed) || 0),
    kills: stats => Math.max(0, Number(stats?.kills) || 0),
    blocked: stats => Math.max(0, Number(stats?.blocked) || 0),
    shielded: stats => Math.max(0, Number(stats?.shielded) || 0),
    deployed: stats => Math.max(0, Number(stats?.deployed) || 0),
    defeated: stats => Math.max(0, Number(stats?.defeatedUnits) || 0),
    collected: stats => Math.max(0, Number(stats?.collected) || 0),
    recalls: stats => Math.max(0, Number(stats?.recalls) || 0),
    spent: stats => Math.max(0, Number(stats?.spent) || 0)
});

// 这些指标「越小越好」，其余都是「越大越好」。
const LOWER_IS_BETTER = new Set(["gates", "defeated", "recalls"]);

export function evaluateChallenge(level, stats, phase) {
    const rule = level?.challenge;
    if (!rule) { return null; }
    const metric = METRICS[rule.type];
    if (!metric || !Number.isFinite(rule.target) || rule.target < 0) { return null; }
    const value = metric(stats);
    const reached = LOWER_IS_BETTER.has(rule.type) ? value <= rule.target : value >= rule.target;
    return { ...rule, label: level.optional, value, complete: phase === "won" && reached };
}
