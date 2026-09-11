// Card database access for the fan-game layer.
//
// Reads the same window.kirafanGachaData that gacha.html already loads, so
// there is one source of truth for the 685 cards. Load asset/gacha/cards.js
// with a plain <script> before importing this.

export const CLASS_IDS = { FIGHTER: 0, MAGICIAN: 1, PRIEST: 2, KNIGHT: 3, ALCHEMIST: 4 };

// Order matches gacha.js's classIconFiles, which came from the asset names.
export const CLASSES = [
    { id: 0, ja: "せんし", zh: "战士", icon: "ClassIconFighter", role: "高威力の単体攻撃" },
    { id: 1, ja: "まほうつかい", zh: "魔法使", icon: "ClassIconMagician", role: "高威力の全体攻撃" },
    { id: 2, ja: "そうりょ", zh: "僧侣", icon: "ClassIconPriest", role: "味方のHP回復" },
    { id: 3, ja: "ナイト", zh: "骑士", icon: "ClassIconKnight", role: "高い防御力・かばう" },
    { id: 4, ja: "アルケミスト", zh: "炼金术士", icon: "ClassIconAlchemist", role: "状態異常・能力低下" }
];

export const ELEMENT_IDS = { FIRE: 0, WATER: 1, EARTH: 2, WIND: 3, MOON: 4, SUN: 5 };

export const ELEMENTS = [
    { id: 0, ja: "炎", zh: "炎", icon: "ElementIconFire" },
    { id: 1, ja: "水", zh: "水", icon: "ElementIconWater" },
    { id: 2, ja: "土", zh: "土", icon: "ElementIconEarth" },
    { id: 3, ja: "風", zh: "风", icon: "ElementIconWind" },
    { id: 4, ja: "月", zh: "月", icon: "ElementIconMoon" },
    { id: 5, ja: "陽", zh: "阳", icon: "ElementIconSun" }
];

// Element advantage, taken from the decompiled original:
// BattleCommandParser.GetStrongElementType / GetWeakElementType.
// The four-element ring is 水 -> 炎 -> 風 -> 土 -> 水 (arrow = beats).
// 月 and 陽 sit outside the ring and are mutually super-effective: the original
// assigns "weak" after "regist" in SetupDefaultElementCoef, so 2x wins for both
// directions of that pairing.
const ADVANTAGE = {
    1: 0,  // 水 > 炎
    0: 3,  // 炎 > 風
    3: 2,  // 風 > 土
    2: 1,  // 土 > 水
    4: 5,  // 月 <> 陽, mutually 2x
    5: 4
};

// Confirmed constants. The original clamps the final coefficient after
// resistance buffs/debuffs are applied; the clamp bands are exported so the
// battle sim can apply them at the right point rather than re-deriving them.
export const ELEMENT_COEF = {
    weak: 2.0,
    regist: 0.5,
    neutral: 1.0,
    clamp: {
        weak: [1.6, 2.4],
        neutral: [0.6, 1.4],
        regist: [0.1, 0.9]
    }
};

// Returns 2.0 (ばつぐん), 0.5 (いまいち) or 1.0. Note 月/陽 return 2.0 both ways.
export function elementMultiplier(attacker, defender) {
    if (ADVANTAGE[attacker] === defender) {
        return ELEMENT_COEF.weak;
    }
    if (ADVANTAGE[defender] === attacker) {
        return ELEMENT_COEF.regist;
    }
    return ELEMENT_COEF.neutral;
}

// -1 regist / 0 neutral / 1 weak, matching the original's HIT_* values. The
// battle code needs the three-way flag as well as the multiplier, because
// criticals depend on it (いまいち can never crit, ばつぐん scales crit chance).
export function elementHit(attacker, defender) {
    if (ADVANTAGE[attacker] === defender) {
        return 1;
    }
    if (ADVANTAGE[defender] === attacker) {
        return -1;
    }
    return 0;
}

function data() {
    const store = window.kirafanGachaData;
    if (!store) {
        throw new Error("asset/gacha/cards.js must be loaded before core/cards.js");
    }
    return store;
}

export function all() {
    return data().cards;
}

export function titles() {
    return data().titles;
}

export function byId(id) {
    return all().find(function (card) { return card.id === Number(id); }) || null;
}

// Filter on any combination of class / element / rarity / titleId / year.
// Array values match any member; scalars match exactly.
export function query(filter) {
    const spec = filter || {};
    return all().filter(function (card) {
        return Object.keys(spec).every(function (key) {
            const want = spec[key];
            if (want === undefined || want === null) {
                return true;
            }
            if (typeof want === "function") {
                return want(card[key], card);
            }
            if (Array.isArray(want)) {
                return want.indexOf(card[key]) !== -1;
            }
            return card[key] === want;
        });
    });
}

export function classInfo(id) {
    return CLASSES[Number(id)] || null;
}

export function elementInfo(id) {
    return ELEMENTS[Number(id)] || null;
}

export function titleInfo(titleId) {
    return titles().find(function (title) { return title.id === Number(titleId); }) || null;
}

// The model asset key for a card, matching the manifest's naming.
export function modelKey(card, evolved) {
    const resourceId = evolved && card.evolvedResourceId ? card.evolvedResourceId : card.resourceId;
    return "model/player/model_pl_" + resourceId + ".muast";
}

export function headId(card, evolved) {
    const value = evolved && card.evolvedHeadId !== null && card.evolvedHeadId !== undefined
        ? card.evolvedHeadId
        : card.headId;
    return Number(value) || 0;
}
