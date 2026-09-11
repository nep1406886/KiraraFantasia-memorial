// The element ring, copied verbatim from core/cards.js.
//
// HARD RULE (master plan §4.1): no three.js, no DOM.
//
// Why a copy and not an import: core/ has no package.json "type" marker (only
// game/rl/ and asset/rl/ do), so node 20 parses core/cards.js as CommonJS and
// an `import { elementMultiplier } from "../../core/cards.js"` fails to link in
// every tools/rl_*_harness.mjs. core/ is peer-owned -- adding a marker file
// there is not mine to do, and a repo-root marker would flip .codex-tmp/_cls.js
// (which is CommonJS) into an ES module. The browser has no such problem, but
// the logic layer has to run in node, so the table lives here.
//
// Drift is the obvious risk of a copy, so it is gated instead of trusted:
// tools/rl_element_harness.mjs loads the real core/cards.js (through a data:
// URL, which node always treats as ESM) and asserts all 36 attacker/defender
// pairs and every ELEMENT_COEF field agree with this file. spec/04 §3's rule --
// copy the original's table, do not reinvent it -- is what both files obey.
//
// Source of the numbers: the decompiled original's
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

export const ELEMENT_IDS = { FIRE: 0, WATER: 1, EARTH: 2, WIND: 3, MOON: 4, SUN: 5 };

// The original clamps the final coefficient after resistance buffs/debuffs are
// applied; the bands are carried so a later stage can apply them at the right
// point rather than re-deriving them.
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
