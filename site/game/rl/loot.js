// Drop tables and item generation (spec/04 §4, plan 阶段 4).
//
// 词条只做乘区；原作武器的四属性由 catalogId 引用 WeaponList 的阶段满级值。
// 掉落语义由三张手写表驱动——掉率、稀有度权重、每稀有度词条数——
// 词缀 id 池由外部注入（setAffixPool）：weapons-rl.json 的 162 条
// PassiveSkillList_WPN 是词缀的唯一来源，loot.js 不认识它们的语义
// （equipment.js 认）。
//
// luck 进掉落权重（spec/04 §2 规则 3，原作语义保留）：既抬掉率也抬稀有度
// 权重，两个方向都是乘性的，且 clamp 上限——运气不能把保底变成必掉传奇。
//
// Pure data functions — no three, no DOM, so node harnesses can drive it.

import { rollWeapon } from "./weaponcatalog.js";
import { rollGadget } from './gadgets.js';

export const SLOTS = ["weapon", "amulet", "armor", "charm"];

export const RARITIES = ["common", "rare", "epic", "legendary"];

// Authored rarity weights per floor band. Floor numbers grow inside a run
// (1→5), so the table is indexed by floor directly; deeper floors lean rare.
// These are the distribution the harness's 1e5 rolls are checked against.
const RARITY_WEIGHTS = {
    1: [68, 24, 7.0, 1.0],
    2: [62, 26, 9.5, 2.5],
    3: [56, 28, 12.0, 4.0],
    4: [50, 30, 15.0, 5.0],
    5: [44, 32, 18.0, 6.0]
};

// Affix count per rarity (legendary's own passive rides on weaponId, so it
// rolls the same 3 generic affixes as epic on top of the guaranteed one).
// One affix per item at every rarity (2026-09-22): the pool is mostly skill
// rewrites, and stacking two or three of them on one drop made a single item
// replace the normal attack plus both skills at once — unreadable for anyone
// not studying the sheet. Rarity now says how strong the one effect is, not
// how many effects are crammed together. The native weapon passive rides on
// top of this one roll, exactly as before.
const AFFIX_COUNT = { common: 1, rare: 1, epic: 1, legendary: 1 };

const BASE_DROP_CHANCE = 0.25;
const DROP_CHANCE_PER_FLOOR = 0.05;
const DROP_CHANCE_MAX = 0.7;
const LUCK_CHANCE_FACTOR = 0.0006;     // luck 300 → +18% chance
const LUCK_RARITY_FACTOR = 0.004;      // luck 300 → ×2.2 on rare+ weights
const LUCK_RARITY_MAX = 3.0;

// Source owns guarantees and the mechanic share. Item identity is then drawn
// from that channel, never rewritten from an unrelated affix combination.
const SOURCES = {
    enemy: { gadgetChance: 0 },
    chest: { guaranteed: true, minRarity: 'rare', gadgetChance: .45 },
    elite: { guaranteed: true, minRarity: 'rare', gadgetChance: .35 },
    guardian: { guaranteed: true, minRarity: 'rare', gadgetChance: .25, weapon: true },
    boss: { guaranteed: true, minRarity: 'epic', gadgetChance: .4, weapon: true },
    shop: { guaranteed: true, gadgetChance: 0 }
};

let affixPool = [];
let weaponPool = [];

// setAffixPool(ids, weaponIds)
//   Injects the rollable affix ids (weapons-rl.json passives keys) and the
//   legendary weapon ids (weapons[].id — same numbers, kept as two lists so
//   a test can trim them independently). Called once at boot; an empty pool
//   means no item ever rolls (and rollLoot returns []), which keeps the
//   module usable before tables load.
export function setAffixPool(ids, weaponIds) {
    affixPool = (ids || []).slice();
    weaponPool = (weaponIds || []).slice();
}

function rarityWeights(floor, luck) {
    const weights = RARITY_WEIGHTS[Math.min(5, Math.max(1, floor))];
    // Luck only lifts the rare+ tiers, multiplicatively, with a clamp: it
    // shifts what a drop IS, never whether one happened beyond the chance.
    const factor = Math.min(LUCK_RARITY_MAX, 1 + luck * LUCK_RARITY_FACTOR);
    return [
        weights[0],
        weights[1] * factor,
        weights[2] * factor,
        weights[3] * factor
    ];
}

function rollRarity(rng, floor, luck) {
    const weights = rarityWeights(floor, luck);
    let total = 0;
    for (let i = 0; i < weights.length; i++) { total += weights[i]; }
    let roll = rng() * total;
    for (let i = 0; i < weights.length; i++) {
        roll -= weights[i];
        if (roll < 0) { return RARITIES[i]; }
    }
    return RARITIES[0];
}

function pickAffixes(rng, count, excludeId) {
    // With-replacement sampling over the pool would double-roll the same
    // passive onto one item; shuffle-draw without replacement instead. The
    // pool (162) is always ≥ the max count (3), but the guard keeps a
    // hand-trimmed test pool honest.
    const picks = [];
    const used = new Set();
    const pool = excludeId ? affixPool.filter(id => id !== excludeId) : affixPool;
    while (picks.length < count && used.size < pool.length) {
        const id = pool[Math.floor(rng() * pool.length)];
        if (!used.has(id)) {
            used.add(id);
            picks.push(id);
        }
    }
    return picks;
}

// rollLoot(rng, floor, luck, card?, options?) → Item[]
//   One drop event: a kill or a chest. Returns [] when nothing dropped.
//   Native weapons carry catalogId, resolving their original stage and passive.
//   Without a catalog/card, the legacy generator preserves weaponId as a passive key.
//   options.slot reserves a shop position; weaponFloor separates stage progression
//   from the chest/shop rarity bonus.
export function rollLoot(rng, floor, luck, card, options = {}) {
    const sourceName = options.source || 'enemy';
    if (!Object.hasOwn(SOURCES, sourceName)) throw new Error('未知掉落来源：' + sourceName);
    const source = SOURCES[sourceName];
    if (!affixPool.length) { return []; }
    const chance = Math.min(DROP_CHANCE_MAX,
        BASE_DROP_CHANCE + floor * DROP_CHANCE_PER_FLOOR
            + luck * LUCK_CHANCE_FACTOR);
    const chanceRoll = rng();
    if (!options.guaranteed && !source.guaranteed && chanceRoll >= chance) { return []; }

    const rolled = rollRarity(rng, floor, luck);
    const minRarity = RARITIES[Math.max(0, RARITIES.indexOf(source.minRarity), RARITIES.indexOf(options.minRarity))];
    const rarity = RARITIES[Math.max(RARITIES.indexOf(rolled), RARITIES.indexOf(minRarity))];
    if (!options.slot && source.gadgetChance && rng() < source.gadgetChance) {
        const gadget = rollGadget(rng, sourceName, options.weaponFloor ?? floor, minRarity);
        if (gadget) return [gadget];
    }
    const slot = options.slot || (source.weapon ? 'weapon' : SLOTS[Math.floor(rng() * SLOTS.length)]);
    const weapon = slot === "weapon" && rollWeapon(rng, options.weaponFloor ?? floor, rarity, card);
    const item = {
        slot: slot,
        rarity: rarity,
        affixes: pickAffixes(rng, AFFIX_COUNT[rarity], weapon && String(weapon.passiveId))
    };
    if (weapon) {
        item.catalogId = weapon.id;
    } else if (rarity === "legendary" && slot === "weapon") {
        // weapons-rl.json: weapons[i].id == its passive key, so weaponId is
        // both the named weapon and the guaranteed affix appended on top of
        // the generic rolls. The caller's seed decides which weapon dropped.
        const weaponId = weaponPool[Math.floor(rng() * weaponPool.length)];
        if (weaponId !== undefined) {
            item.weaponId = weaponId;
            if (!item.affixes.includes(String(weaponId))) {
                item.affixes.unshift(String(weaponId));
            }
        }
    }
    return [item];
}
