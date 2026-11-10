// Realtime-only equipment. Stable IDs/sealed slots persist, derived numbers do not.
// These mechanics are explicitly separate from original weapon passives.
export const GADGETS = Object.freeze([
    { id: 'rhythm', name: '轻击腕带', slot: 'charm', rarity: 'rare', price: 40, minFloor: 1, rate: 1.2, normalDamage: .9,
        benefit: '普攻节拍加快20%，连续攻击伤害约提升8%', cost: '普攻每击伤害降低10%' },
    { id: 'strider', name: '游走护符', slot: 'amulet', rarity: 'rare', price: 45, minFloor: 1, attackMove: .75, normalDamage: .9,
        benefit: '普攻时的移动速度由45%提高至75%', cost: '普攻伤害降低10%' },
    { id: 'reach', name: '延展刻印', slot: 'amulet', rarity: 'rare', price: 45, minFloor: 1, range: 1.25, defense: .9,
        benefit: '普通攻击射程或挥击长度增加25%', cost: '物防、魔防降低10%；不扩大技能范围' },
    { id: 'wide', name: '宽弧指环', slot: 'charm', rarity: 'rare', price: 40, minFloor: 1, width: 1.3, normalDamage: .88,
        benefit: '普攻扇面、突刺厚度或弹体半径增加30%', cost: '普攻伤害降低12%；不延长射程' },
    { id: 'aim', name: '聚焦饰章', slot: 'charm', rarity: 'rare', price: 30, minFloor: 1, range: 1.12,
        benefit: '普通攻击距离增加12%', cost: '占用饰品栏；不改变技能范围' },
    { id: 'sentry', name: '守望机关', slot: 'armor', rarity: 'epic', price: 90, minFloor: 5, assist: 2, damage: .8,
        benefit: '可开启自动索敌和普攻，角色不会自动移动', cost: '物攻、魔攻降低20%；不自动使用技能或必杀' },
    { id: 'hunter', name: '巡猎罗盘', slot: 'armor', rarity: 'epic', price: 130, minFloor: 9, assist: 3, damage: .75, defense: .8,
        benefit: '可开启当前房间内的寻路接敌与普攻', cost: '物攻、魔攻降低25%，物防、魔防降低20%；不自动过门或交互' },
    { id: 'steady', name: '定心机关', slot: 'armor', rarity: 'epic', price: 120, minFloor: 9, assist: 2, noCrit: true, contract: true,
        benefit: '可开启自动索敌与普攻，不自动移动，不降低面板攻击',
        cost: '自身伤害不能暴击，包含必暴；必暴仍在伤害出手时消耗，卸装后解除' },
    { id: 'prism', name: '无相罗盘', slot: 'armor', rarity: 'epic', price: 160, minFloor: 13, assist: 3, noAdvantage: true, contract: true,
        benefit: '可开启当前房间内的寻路接敌与普攻，不降低面板攻防',
        cost: '攻击失去有利属性倍率与克制增幅；不利属性和敌方耐性照常生效，卸装后解除' },
    { id: 'binding', name: '缚技罗盘', slot: 'armor', rarity: 'epic', price: 180, minFloor: 13, assist: 3, sealSkill: true, contract: true,
        benefit: '可开启当前房间内的寻路接敌与普攻，不降低面板攻防',
        cost: '生成时固定封印技能2或3，不封印必杀；冷却照常恢复，卸装后解除' },
    // 追加的基础机制追加在表尾：前 10 行的序号被 rl_item_art_browser 的
    // 地面图版夹具（__artDrops[10] = 巡猎罗盘）按位置引用，插入会错位。
    { id: 'aegis', name: '坚壁徽章', slot: 'armor', rarity: 'rare', price: 45, minFloor: 1, defense: 1.2, normalDamage: .9,
        benefit: '物防、魔防提升20%，正面承受更稳',
        cost: '普攻伤害降低10%；不提升生命上限' },
    { id: 'kite', name: '纸翼护符', slot: 'amulet', rarity: 'rare', price: 45, minFloor: 1, attackMove: .65, range: 1.1, defense: .85,
        benefit: '普攻中可用65%移速走位，普攻距离增加10%',
        cost: '物防、魔防降低15%；不影响技能施法与受击硬直' },
    { id: 'comet', name: '流星缎带', slot: 'charm', rarity: 'epic', price: 110, minFloor: 5, rate: 1.3, normalDamage: .9, defense:.9,
        benefit: '普攻节拍加快30%，连续攻击伤害约提升17%',
        cost: '普攻每击伤害与物防、魔防各降低10%' },
    { id:'cotton', name:'旅人软披肩', slot:'armor', rarity:'common', price:25, minFloor:1, relic:true, hp:1.12,
        benefit:'生命上限提升12%，适合旅途初始的稳妥选择', cost:'占用护甲栏；换装保持当前生命比例' },
    { id:'ribbon', name:'晨光发结', slot:'charm', rarity:'common', price:25, minFloor:1, relic:true, crit:.04,
        benefit:'暴击率提高4个百分点', cost:'占用饰品栏；不能突破100%暴击上限' },
    { id:'leaf', name:'新叶书签', slot:'amulet', rarity:'common', price:25, minFloor:1, relic:true, gauge:1.12,
        benefit:'必杀槽获取速度提升12%', cost:'占用护符栏；不会立即补满必杀槽' },
    { id:'bloom', name:'花庭斗篷', slot:'armor', rarity:'rare', price:60, minFloor:1, relic:true, hp:1.25, defense:1.08, damage:.95,
        benefit:'生命上限提升25%，物防、魔防提升8%', cost:'物攻、魔攻降低5%；换装保持当前生命比例' },
    { id:'bell', name:'星灯风铃', slot:'amulet', rarity:'rare', price:60, minFloor:1, relic:true, gauge:1.3, normalDamage:.94,
        benefit:'必杀槽获取速度提升30%，更快迎来下一次必杀', cost:'普攻每击伤害降低6%' },
    { id:'edge', name:'蔷薇胸针', slot:'charm', rarity:'rare', price:60, minFloor:1, relic:true, crit:.1, defense:.92,
        benefit:'暴击率提高10个百分点，普攻与技能均可受益', cost:'物防、魔防降低8%' },
    { id:'petal', name:'花守礼装', slot:'armor', rarity:'epic', price:110, minFloor:1, relic:true, hp:1.35, defense:1.15, rate:.94,
        benefit:'生命上限提升35%，物防、魔防提升15%', cost:'普攻节拍减慢6%；换装保持当前生命比例' },
    { id:'moon', name:'月露怀表', slot:'amulet', rarity:'epic', price:110, minFloor:1, relic:true, lifesteal:.035, damage:.94,
        benefit:'造成伤害时回复其3.5%的生命，可由普攻与技能触发', cost:'物攻、魔攻降低6%；治疗封锁期间不能回血' },
    { id:'solstice', name:'映日花冠', slot:'charm', rarity:'epic', price:110, minFloor:1, relic:true, crit:.14, damage:1.08, hp:.9,
        benefit:'暴击率提高14个百分点，物攻、魔攻提升8%', cost:'生命上限降低10%；换装保持当前生命比例' }
].map(Object.freeze));
export const GADGET_IDS = Object.freeze(GADGETS.map(row => row.id));
const BY_ID = new Map(GADGETS.map(row => [row.id, row]));

export function gadgetDefinition(item) {
    if (!item) return null;
    if (item.gadgetId === undefined) {
        if (item.sealedSlot !== undefined) throw new Error('非契约装备不能携带封印槽');
        return null;
    }
    const row = BY_ID.get(item.gadgetId);
    if (!row || item.slot !== row.slot || item.catalogId !== undefined || item.weaponId !== undefined
            || !Array.isArray(item.affixes) || item.affixes.length
            || (row.sealSkill ? ![1, 2].includes(item.sealedSlot) : item.sealedSlot !== undefined)) {
        throw new Error('无效的机制装备：' + String(item.gadgetId));
    }
    return row;
}

export function makeGadget(id, rarity, sealedSlot) {
    const row = BY_ID.get(id);
    rarity = rarity === undefined ? row?.rarity : rarity;
    if (!row || !['common', 'rare', 'epic', 'legendary'].includes(rarity)) throw new Error('未知机制装备');
    const item = { slot: row.slot, rarity, affixes: [], gadgetId: row.id };
    if (sealedSlot !== undefined) item.sealedSlot = sealedSlot;
    gadgetDefinition(item);
    return item;
}

// Skill names are supplied by the world's read-only loadout preview. A seal
// belongs to a key slot, not the skill ID a weapon may replace in that slot.
export function gadgetTerms(item, skillNames = []) {
    const row = gadgetDefinition(item);
    if (!row) return null;
    if (!row.sealSkill) return { benefit: row.benefit, cost: row.cost };
    const name = skillNames[item.sealedSlot];
    return { benefit: row.benefit, cost: '封印技能' + (item.sealedSlot + 1)
        + (name ? '「' + name + '」' : '')
        + '；封印槽生成时固定，换武器仍封同一槽。不封印必杀，冷却照常恢复，卸装后解除' };
}

export function gadgetRuntime(items) {
    const result = { rate: 1, attackMove: .45, range: 1, width: 1, normalDamage: 1,
        damage: 1, defense: 1, hp:1, gauge:1, crit:0, lifesteal:0,
        assist: 1, noCrit: false, noAdvantage: false, sealedSlots: [] };
    for (const item of items || []) {
        const row = gadgetDefinition(item);
        if (!row) continue;
        for (const key of ['rate', 'range', 'width', 'normalDamage', 'damage', 'defense', 'hp', 'gauge']) result[key] *= row[key] || 1;
        result.crit += row.crit || 0; result.lifesteal += row.lifesteal || 0;
        result.attackMove = Math.max(result.attackMove, row.attackMove || 0);
        result.assist = Math.max(result.assist, row.assist || 0);
        result.noCrit ||= row.noCrit === true;
        result.noAdvantage ||= row.noAdvantage === true;
        if (row.sealSkill && !result.sealedSlots.includes(item.sealedSlot)) result.sealedSlots.push(item.sealedSlot);
    }
    return result;
}

// Named channels are deliberate acquisition rules, not a hash of rolled affixes.
// Weight sets stay independent of the player's loadout, so swapping gear or
// reopening a menu cannot reroll a room's offer. Saved stock is never rebuilt.
const BASIC_WEIGHTS = { rhythm: 4, strider: 4, reach: 4, wide: 4, aim: 4, aegis: 4, kite: 4, comet: 2 };
const SOURCE_WEIGHTS = {
    chest: BASIC_WEIGHTS,
    elite: { ...BASIC_WEIGHTS, sentry: 3 },
    guardian: { sentry: 3, hunter: 2, steady: 2, prism: 1, binding: 1 },
    boss: { sentry: 2, hunter: 3, steady: 2, prism: 2, binding: 2 },
    shop: { ...BASIC_WEIGHTS, sentry: 3, hunter: 2, steady: 2, prism: 1, binding: 1 }
};
const RARITIES = ['common', 'rare', 'epic', 'legendary'];

// New ordinary accessories have a fixed identity and one coherent purpose.
// Legacy affix items still resolve through equipment.js and are never rewritten.
export function rollAccessory(rng, slot, rarity) {
    const tier = Math.min(2, RARITIES.indexOf(rarity));
    const choices = GADGETS.filter(row => row.relic && row.slot === slot
        && RARITIES.indexOf(row.rarity) === tier);
    if (!choices.length) throw new Error('未知旅装槽位或品质');
    return makeGadget(choices[Math.floor(rng() * choices.length)].id);
}

export function rollGadget(rng, source, floor, minRarity = 'common') {
    if (!Object.hasOwn(SOURCE_WEIGHTS, source)) throw new Error('未知机制来源：' + source);
    const weights = SOURCE_WEIGHTS[source];
    const choices = Object.entries(weights).filter(([id]) => {
        const row = BY_ID.get(id);
        return floor >= row.minFloor && RARITIES.indexOf(row.rarity) >= RARITIES.indexOf(minRarity);
    });
    if (!choices.length) return null;
    let roll = rng() * choices.reduce((total, [, weight]) => total + weight, 0);
    let selected = choices[choices.length - 1][0];
    for (const [id, weight] of choices) {
        roll -= weight;
        if (roll < 0) { selected = id; break; }
    }
    return makeGadget(selected, undefined, BY_ID.get(selected).sealSkill ? 1 + Math.floor(rng() * 2) : undefined);
}

export function sameGadgetEffect(left, right) {
    const a = gadgetDefinition(left), b = gadgetDefinition(right);
    // Old saves may assign different rarity strings to the same fixed mechanic.
    return !!a && !!b && a.id === b.id && left.sealedSlot === right.sealedSlot;
}

export function gadgetAcquisition(row) {
    if (row.relic) return '旅途掉落、宝箱、精英与商店；同名旅装的效果固定';
    if (row.contract) return '第' + row.minFloor + '层起：守卫、首领、商店、营地修缮与祭坛誓约';
    if (row.id === 'hunter') return '第9层起：守卫、首领、商店、营地与祭坛誓约';
    if (row.id === 'sentry') return '第5层起：精英、守卫、首领、商店、营地与祭坛誓约';
    // 追加的三件不在 SMALL 池里，营地调校与祭坛刻印不会给出它们，措辞如实收窄。
    if (row.id === 'comet') return '第5层起：宝箱、精英与商店；普通敌人不掉落';
    if (row.id === 'aegis' || row.id === 'kite') return '宝箱、精英与商店；普通敌人不掉落';
    return '宝箱、精英、商店、营地调校与祭坛刻印；普通敌人不掉落';
}
