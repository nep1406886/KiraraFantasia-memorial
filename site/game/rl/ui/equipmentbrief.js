// A short, read-only projection of the same resolved loadout used by combat.
// Only positive/neutral changes may be elided; costs always stay in the brief.
const STATS = [['atk', '物攻'], ['mgc', '魔攻'], ['hp', '生命上限'],
    ['def', '物防'], ['mdef', '魔防'], ['spd', '速度'], ['luck', '幸运']];
const round = value => Math.round(value * 10) / 10;
const label = (slot, index) => slot.ultimate ? 'R 必杀' : '技能 ' + (index + 1);

export function equipmentBrief(preview) {
    const benefits = [], costs = [], notes = [];
    if (!preview) return { benefits, costs, notes, more: 0 };
    function delta(name, from, to, scale = 1, suffix = '', relative = false) {
        const value = round((relative ? to / from - 1 : to - from) * scale);
        if (!Number.isFinite(value) || !value) return;
        (value > 0 ? benefits : costs).push(name + ' ' + (value > 0 ? '+' : '−') + Math.abs(value) + suffix);
    }
    const gadgets = preview.gadgets;
    if (gadgets) {
        const from = gadgets.current, to = gadgets.candidate;
        for (const [key, name] of [['rate', '普攻速度'], ['range', '普攻距离'],
            ['width', '普攻宽度'], ['normalDamage', '普攻伤害']]) {
            delta(name, from[key], to[key], 100, '%', true);
        }
        if (to.attackMove !== from.attackMove) {
            if (to.attackMove) (to.attackMove > from.attackMove ? benefits : costs).push('普攻中可走位（' + round(to.attackMove * 100) + '%移速）');
            else costs.push('普攻时不能移动');
        }
        if (to.assist !== from.assist) {
            if (to.assist === 3) benefits.push('可开启自动追敌与普攻');
            else if (to.assist === 2) benefits.push('可开启原地自动普攻');
            else if (to.assist === 1) benefits.push('普攻辅助瞄准');
            if (from.assist === 3 && to.assist < 3) costs.push('不再自动追敌');
            if (from.assist >= 2 && to.assist < 2) costs.push('不再自动普攻');
            if (from.assist === 1 && !to.assist) costs.push('不再辅助瞄准');
        }
        // A contract still matters when swapping a different equipment slot.
        if (to.noCrit) costs.push('不能暴击（含必暴）');
        else if (from.noCrit) benefits.push('恢复暴击');
        if (to.noAdvantage) costs.push('失去有利属性加成');
        else if (from.noAdvantage) benefits.push('恢复有利属性加成');
    }
    const style = preview.style;
    if (preview.item?.slot === 'weapon' && style) {
        if (style.current.name !== style.candidate.name) benefits.push('普攻改为' + style.candidate.name);
        if (style.candidate.proficiency < 1) costs.push('跨职业：武器属性加成仅' + round(style.candidate.proficiency * 100) + '%');
    }
    if (preview.skills) {
        const from = preview.skills.current, to = preview.skills.candidate;
        to.slots.forEach((skill, index) => {
            const name = label(skill, index), sealed = to.sealedSlots.includes(index);
            if (sealed) costs.push(name + '「' + skill.name + '」被封印');
            else {
                if (from.slots[index]?.id !== skill.id) {
                    (skill.usable ? benefits : costs).push(name + ' → ' + skill.name + (skill.usable ? '' : '（暂不可用）'));
                }
                if (from.sealedSlots.includes(index)) benefits.push(name + '恢复可用');
            }
        });
        if (from.normal?.id !== to.normal?.id && style?.current.name === style?.candidate.name) {
            benefits.push('普攻 → ' + to.normal.name);
        }
        const blocked = new Set(to.replacements.filter(change => !change.active
            && change.source.slot === preview.item?.slot).map(change => change.target));
        if (blocked.size) notes.push([...blocked].map(target => ['普攻', '技能 2', '技能 3'][target]).join('、') + '改写被覆盖');
    }
    if (preview.passives) {
        const from = preview.passives.current, to = preview.passives.candidate;
        for (const [key, name, scale, suffix] of [
            ['lifesteal', '伤害回血', 100, '%'], ['survival', '每层致死保护', 1, '次'],
            ['extraCardTriggers', '技能卡触发', 1, '次'], ['critDamage', '暴击倍率', 100, '%'],
            ['gaugeOnHit', '受击回复必杀槽', 100, '%'], ['overheal', '治疗上限', 100, '%']
        ]) delta(name, from[key], to[key], scale, suffix);
        for (const [key, name] of [['gaugeMult', '必杀槽获取'], ['stunFill', '眩晕累积']]) {
            delta(name, from[key], to[key], 100, '%', true);
        }
        if (from.healingLockImmune !== to.healingLockImmune) {
            (to.healingLockImmune ? benefits : costs).push(to.healingLockImmune ? '免疫治疗封锁' : '失去治疗封锁免疫');
        }
        for (const [key, name] of [['hitStack', '每次受击'], ['killStack', '每次击杀']]) {
            for (const [stat, word] of STATS.filter(([key]) => ['atk', 'mgc', 'def', 'mdef'].includes(key))) {
                delta(name + word, from[key]?.[stat] || 0, to[key]?.[stat] || 0, 100, '%');
            }
        }
        if (JSON.stringify(from.debuffOnHit) !== JSON.stringify(to.debuffOnHit)) {
            if (!to.debuffOnHit) costs.push('失去受击削弱敌方攻击');
            else {
                const strength = row => Math.abs(row?.atk || 0) + Math.abs(row?.mgc || 0);
                if (strength(to.debuffOnHit) < strength(from.debuffOnHit)) costs.push('受击削弱敌方攻击的效果减弱');
                else benefits.push('受击时削弱敌方攻击');
                if (to.debuffOnHit.turns < (from.debuffOnHit?.turns || 0)) costs.push('受击削弱的持续时间缩短');
            }
        }
        if (to.noops.some(kind => !from.noops.includes(kind))) notes.push('含未适配效果');
    }
    for (const [key, name] of STATS) delta(name, preview.current[key] || 0, preview.candidate[key] || 0);
    // No-crit already explains the loss without a second, misleading rate line.
    if (!gadgets?.candidate.noCrit) delta('暴击率', preview.current.critChance || 0, preview.candidate.critChance || 0, 100, '%');
    // Two lines of benefit, the rest behind the detail fold: a casual reader
    // gets the headline change and nothing more (2026-09-22).
    const more = Math.max(0, benefits.length - 2);
    return { benefits: benefits.slice(0, 2), costs, notes, more };
}
