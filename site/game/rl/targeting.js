// One selector for previews and settlement. A pointer near a body expresses
// an explicit choice; otherwise auto-lock the nearest living enemy, stably.
export function selectEnemyTarget(player, enemies, aim) {
    let nearest = null, nearestDistance = Infinity;
    let pointed = null, pointerDistance = Infinity;
    for (const enemy of enemies || []) {
        if (enemy.dead || enemy.hp <= 0) { continue; }
        const distance = Math.hypot(enemy.x - player.x, enemy.y - player.y);
        if (distance < nearestDistance || distance === nearestDistance && enemy.id < nearest.id) {
            nearest = enemy; nearestDistance = distance;
        }
        if (aim) {
            const d = Math.hypot(enemy.x - aim.x, enemy.y - aim.y) - (enemy.radius || 0);
            if (d <= 1.5 && (d < pointerDistance || d === pointerDistance && enemy.id < pointed.id)) {
                pointed = enemy; pointerDistance = d;
            }
        }
    }
    return pointed || nearest;
}

export function ultimatePreview(player, enemies, aim) {
    const skill = player?.skills?.ultimate;
    if (!skill || player.dead) { return null; }
    const effects = skill.effects || [];
    const single = effects.some(effect => effect.target === 1);
    const all = effects.some(effect => effect.target === 2);
    const self = effects.some(effect => [0, 3, 4].includes(effect.target));
    const target = single ? selectEnemyTarget(player, enemies, aim) : null;
    const targets = all ? enemies.filter(enemy => !enemy.dead && enemy.hp > 0) : target ? [target] : [];
    const name = target && (target.nameZh || target.name || (target.kind === "boss" ? "首领" : "敌人"));
    const description = [all ? "全体敌人（" + targets.length + "）" : single ? (name ? "锁定：" + name : "没有敌方目标") : "",
        self ? "自身回复／增益" : ""].filter(Boolean).join(" ＋ ");
    return { target, targets, self, scope: all ? "全体" : single ? "单体" : "自身", description };
}
