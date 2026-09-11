// Harness for the element ring (阶段 3, spec/04 §3).
//
//   node tools/rl_element_harness.mjs
//
// The ring lives twice: core/cards.js owns it for the browser-only card pages,
// and game/rl/elements.js carries a copy because node cannot link core/*.js
// (no package.json "type" marker there, and core/ is peer-owned -- see the
// header of game/rl/elements.js). This harness is the reason that copy is safe:
//
// 1. All 36 attacker/defender pairs agree between the two files, for both
//    elementMultiplier() and elementHit(). core/cards.js is loaded through a
//    data: URL, which node always treats as ESM regardless of package.json.
// 2. ELEMENT_COEF agrees field for field, clamp bands included.
// 3. The ring is the original's: 水 -> 炎 -> 風 -> 土 -> 水, each 2.0 forward
//    and 0.5 back, and the 月 <-> 陽 pair is 2.0 in *both* directions (the
//    special case the stage's acceptance names).
// 4. Sanity: same element and ring-vs-月/陽 are always 1.0, so no pair is
//    accidentally advantaged.
// 5. resolveDamage() actually multiplies by the ring before subtracting
//    defence -- element wired into the formula, not just tabulated.
// 6. いまいち can never crit (critChanceFor returns 0 on hit === -1).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
    elementMultiplier, elementHit, ELEMENT_COEF, ELEMENT_IDS
} from "../site/game/rl/elements.js";
import { resolveDamage, elementFlag, critChanceFor, DEF_FACTOR } from "../site/game/rl/combat.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

// core/cards.js is an ES module in a directory node reads as CommonJS. A data:
// URL has no package.json above it, so node parses it as ESM -- and cards.js
// imports nothing, so it needs no base to resolve against.
const cardsSource = readFileSync(join(ROOT, "core", "cards.js"), "utf8");
const cards = await import(
    "data:text/javascript;base64," + Buffer.from(cardsSource, "utf8").toString("base64")
);

const NAMES = ["炎", "水", "土", "風", "月", "陽"];
const IDS = [0, 1, 2, 3, 4, 5];

// --- 1. every pair, both functions -----------------------------------------

{
    let multMismatch = [];
    let hitMismatch = [];
    IDS.forEach(function (a) {
        IDS.forEach(function (d) {
            const mine = elementMultiplier(a, d);
            const theirs = cards.elementMultiplier(a, d);
            if (mine !== theirs) {
                multMismatch.push(NAMES[a] + "->" + NAMES[d] + " " + mine + " vs " + theirs);
            }
            const mineHit = elementHit(a, d);
            const theirsHit = cards.elementHit(a, d);
            if (mineHit !== theirsHit) {
                hitMismatch.push(NAMES[a] + "->" + NAMES[d] + " " + mineHit + " vs " + theirsHit);
            }
        });
    });
    check("all 36 pairs: elementMultiplier matches core/cards.js",
        multMismatch.length === 0, multMismatch.join("; ") || "36/36");
    check("all 36 pairs: elementHit matches core/cards.js",
        hitMismatch.length === 0, hitMismatch.join("; ") || "36/36");
}

// --- 2. the constants ------------------------------------------------------

{
    const theirs = cards.ELEMENT_COEF;
    check("ELEMENT_COEF.weak matches", ELEMENT_COEF.weak === theirs.weak, String(ELEMENT_COEF.weak));
    check("ELEMENT_COEF.regist matches", ELEMENT_COEF.regist === theirs.regist, String(ELEMENT_COEF.regist));
    check("ELEMENT_COEF.neutral matches", ELEMENT_COEF.neutral === theirs.neutral, String(ELEMENT_COEF.neutral));
    const bands = ["weak", "neutral", "regist"];
    const bandBad = bands.filter(function (key) {
        const a = ELEMENT_COEF.clamp[key];
        const b = theirs.clamp[key];
        return !a || !b || a[0] !== b[0] || a[1] !== b[1];
    });
    check("ELEMENT_COEF.clamp bands match", bandBad.length === 0,
        bandBad.join(",") || "weak/neutral/regist");
    const idsBad = Object.keys(ELEMENT_IDS).filter(function (key) {
        return ELEMENT_IDS[key] !== cards.ELEMENT_IDS[key];
    });
    check("ELEMENT_IDS match", idsBad.length === 0, idsBad.join(",") || "6/6");
}

// --- 3. the ring itself ----------------------------------------------------

{
    // 水 > 炎 > 風 > 土 > 水 (the original's GetStrongElementType chain)
    const ring = [
        [ELEMENT_IDS.WATER, ELEMENT_IDS.FIRE],
        [ELEMENT_IDS.FIRE, ELEMENT_IDS.WIND],
        [ELEMENT_IDS.WIND, ELEMENT_IDS.EARTH],
        [ELEMENT_IDS.EARTH, ELEMENT_IDS.WATER]
    ];
    ring.forEach(function (pair) {
        const label = NAMES[pair[0]] + " -> " + NAMES[pair[1]];
        check(label + " is 2.0 (ばつぐん)", elementMultiplier(pair[0], pair[1]) === 2.0,
            String(elementMultiplier(pair[0], pair[1])));
        check(label + " reversed is 0.5 (いまいち)", elementMultiplier(pair[1], pair[0]) === 0.5,
            String(elementMultiplier(pair[1], pair[0])));
        check(label + " hit flags are +1 / -1",
            elementHit(pair[0], pair[1]) === 1 && elementHit(pair[1], pair[0]) === -1);
    });
    // The ring must be a cycle, not a line: four elements, four edges, and
    // every element both beats and is beaten by exactly one other.
    const beats = {};
    const beaten = {};
    [0, 1, 2, 3].forEach(function (a) {
        beats[a] = [0, 1, 2, 3].filter(function (d) { return elementMultiplier(a, d) === 2.0; });
        beaten[a] = [0, 1, 2, 3].filter(function (o) { return elementMultiplier(o, a) === 2.0; });
    });
    const cyclic = [0, 1, 2, 3].every(function (a) {
        return beats[a].length === 1 && beaten[a].length === 1;
    });
    check("the four-element ring is a cycle (each beats one, is beaten by one)", cyclic,
        [0, 1, 2, 3].map(function (a) { return NAMES[a] + ">" + NAMES[beats[a][0]]; }).join(" "));
}

// --- 4. 月 <-> 陽 and the neutral cases ------------------------------------

{
    const M = ELEMENT_IDS.MOON;
    const S = ELEMENT_IDS.SUN;
    check("月 -> 陽 is 2.0", elementMultiplier(M, S) === 2.0, String(elementMultiplier(M, S)));
    check("陽 -> 月 is 2.0 as well (the mutual special case)",
        elementMultiplier(S, M) === 2.0, String(elementMultiplier(S, M)));
    check("both directions flag as ばつぐん",
        elementHit(M, S) === 1 && elementHit(S, M) === 1);
    check("no direction of 月/陽 is ever いまいち",
        elementMultiplier(M, S) !== 0.5 && elementMultiplier(S, M) !== 0.5);

    const selfBad = IDS.filter(function (a) { return elementMultiplier(a, a) !== 1.0; });
    check("same element is always 1.0", selfBad.length === 0,
        selfBad.map(function (a) { return NAMES[a]; }).join(",") || "6/6");

    const crossBad = [];
    [0, 1, 2, 3].forEach(function (a) {
        [M, S].forEach(function (b) {
            if (elementMultiplier(a, b) !== 1.0) { crossBad.push(NAMES[a] + "->" + NAMES[b]); }
            if (elementMultiplier(b, a) !== 1.0) { crossBad.push(NAMES[b] + "->" + NAMES[a]); }
        });
    });
    check("ring elements and 月/陽 never interact (all 1.0)", crossBad.length === 0,
        crossBad.join(",") || "16/16");

    // Exactly 8 ordered pairs are 2.0: four ring edges plus 月<->陽 both ways
    // ... which is 6, so the count also proves nothing extra sneaked in.
    let weak = 0;
    let regist = 0;
    IDS.forEach(function (a) {
        IDS.forEach(function (d) {
            const m = elementMultiplier(a, d);
            if (m === 2.0) { weak += 1; }
            if (m === 0.5) { regist += 1; }
        });
    });
    check("exactly 6 ordered pairs are ばつぐん (4 ring + 月⇄陽)", weak === 6, "weak=" + weak);
    check("exactly 4 ordered pairs are いまいち (the ring, reversed)", regist === 4, "regist=" + regist);
}

// --- 5. the ring inside the damage formula ---------------------------------

{
    // resolveDamage multiplies by the ring *before* subtracting defence
    // (spec/04 §7's operator order), so the expectations are hand-computed the
    // same way: round(power × coef × ring × tempo) − def × 0.6, floor 1.
    const base = { atk: 200, def: 100, skill: { coef: 1.0, magic: false } };
    const neutral = resolveDamage(Object.assign({}, base, { element: 0, targetElement: 0 }));
    const weak = resolveDamage(Object.assign({}, base, { element: 1, targetElement: 0 }));
    const regist = resolveDamage(Object.assign({}, base, { element: 0, targetElement: 1 }));
    const expectN = Math.round(200 * 1.0 * 1.0 * 1 - 100 * DEF_FACTOR);
    const expectW = Math.round(200 * 1.0 * 2.0 * 1 - 100 * DEF_FACTOR);
    const expectR = Math.round(200 * 1.0 * 0.5 * 1 - 100 * DEF_FACTOR);
    check("neutral hit = round(200×1×1) − 60", neutral === expectN, neutral + " vs " + expectN);
    check("ばつぐん hit = round(200×1×2) − 60", weak === expectW, weak + " vs " + expectW);
    check("いまいち hit = round(200×1×0.5) − 60", regist === expectR, regist + " vs " + expectR);
    check("ばつぐん is not simply 2× the neutral result (defence is subtracted after)",
        weak !== neutral * 2, weak + " vs " + (neutral * 2));

    // The { attacker, defender } spelling must agree with the flat one.
    const pairForm = resolveDamage(Object.assign({}, base, { element: { attacker: 1, defender: 0 } }));
    check("element:{attacker,defender} matches element+targetElement",
        pairForm === weak, pairForm + " vs " + weak);

    // Unknown element on either side means no ring at all -- that is what
    // keeps the stage-1 assertions (atk 1 vs def 99 -> 1) true.
    check("missing defender element -> multiplier 1",
        resolveDamage(Object.assign({}, base, { element: 1 })) === expectN);
    check("missing attacker element -> multiplier 1",
        resolveDamage(Object.assign({}, base, { targetElement: 0 })) === expectN);
    check("elementFlag returns 0 when either side is unknown",
        elementFlag(1, undefined) === 0 && elementFlag(undefined, 0) === 0
        && elementFlag(1, null) === 0 && elementFlag(null, 0) === 0);
    check("elementFlag agrees with elementHit when both sides are known",
        elementFlag(1, 0) === elementHit(1, 0) && elementFlag(0, 1) === elementHit(0, 1));
}

// --- 6. crit and the ring --------------------------------------------------

{
    // The original never crits on いまいち; core/cards.js records the rule in
    // elementHit's comment and combat.js implements that half of it.
    check("いまいち can never crit", critChanceFor(1200, 0.5, -1) === 0);
    check("neutral crit chance is luck/1200 + bonus",
        Math.abs(critChanceFor(600, 0.1, 0) - 0.6) < 1e-9, String(critChanceFor(600, 0.1, 0)));
    check("ばつぐん keeps the luck term (the original's scale factor is unpinned)",
        Math.abs(critChanceFor(600, 0, 1) - 0.5) < 1e-9, String(critChanceFor(600, 0, 1)));
    check("crit chance clamps to [0,1]",
        critChanceFor(-100, 0, 0) === 0 && critChanceFor(12000, 5, 0) === 1);
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall element checks passed");
process.exit(failures ? 1 : 0);
