// node harness for core/lbstat.js. Prints JSON on stdout; tools/check_lb_stat.py
// reads it. No browser, no DOM -- lbstat.js imports nothing.
//
// Takes the module path as an argument, the same shape as
// tools/mv_danmaku_harness.mjs, because the negative cases hand over a patched
// *copy* of the module. A fixed import path could not be broken on purpose, and
// a check whose negative cases cannot break it is not a check.
//
// usage: lb_stat_harness.mjs <path to lbstat module>

import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath) {
    console.error("usage: lb_stat_harness.mjs <path to lbstat module>");
    process.exit(2);
}
const stat = await import(pathToFileURL(modulePath).href);

const out = {};

out.statIds = stat.STAT_IDS;
out.base = stat.BASE;
out.cap = stat.CAP;
out.levelMax = stat.LEVEL_MAX;
out.balance = stat.checkBalance();
out.dominance = stat.checkDominance();
out.emphasis = stat.checkEmphasis();
out.step = stat.STEP;
out.stepBalance = stat.CLASS_STEPS.map(function (s) {
    return stat.stepBalance(s);
});
out.classSteps = stat.CLASS_STEPS;

// Every class at level 1 and at level max, so the check can see both ends.
out.classes = stat.CLASS_SHAPE.map(function (_, classId) {
    return {
        classId: classId,
        rawProduct: stat.shapeProduct(stat.CLASS_SHAPE[classId]),
        normProduct: stat.shapeProduct(stat.CLASS_SHAPE_NORM[classId]),
        shape: stat.CLASS_SHAPE[classId],
        norm: stat.CLASS_SHAPE_NORM[classId],
        lv1: stat.baseStats({ classId: classId, elementId: 0, level: 1 }),
        lvMax: stat.baseStats({ classId: classId, elementId: 0,
                                level: stat.LEVEL_MAX })
    };
});

// Element edges: same class, each element, so only the edged stat should move.
out.elements = stat.ELEMENT_EDGE.map(function (edge, elementId) {
    return {
        elementId: elementId,
        stat: edge.stat,
        mul: edge.mul,
        stats: stat.baseStats({ classId: 0, elementId: elementId, level: 1 })
    };
});

// The level curve, and where the cumulative total lands.
let cum = 0;
out.expCurve = [];
for (let lv = 1; lv < stat.LEVEL_MAX; lv++) {
    const need = stat.expToNext(lv);
    cum += need;
    out.expCurve.push({ level: lv, need: need, cumulative: cum });
}
out.expTotal = cum;
out.expTotalFromModule = stat.expTotal();
out.expAtMax = stat.expToNext(stat.LEVEL_MAX);
out.expRatio = stat.EXP_RATIO;

// addExp: does it carry the remainder, and can one call cross two levels?
out.addExp = {
    // 120 to reach level 2, 160 to reach level 3 -> 300 crosses both with 20 left.
    twoLevels: stat.addExp({ level: 1, exp: 0 }, 300),
    exact: stat.addExp({ level: 1, exp: 0 }, stat.expToNext(1)),
    none: stat.addExp({ level: 1, exp: 0 }, 0),
    negative: stat.addExp({ level: 1, exp: 0 }, -50),
    atMax: stat.addExp({ level: stat.LEVEL_MAX, exp: 0 }, 99999)
};

// Effects: order independence, and the ratio caps.
const b = stat.baseStats({ classId: 0, elementId: 0, level: 1 });
const flatThenMul = [{ stat: "atk", kind: "flat", value: 10 },
                     { stat: "atk", kind: "mul", value: 0.2 }];
const mulThenFlat = [{ stat: "atk", kind: "mul", value: 0.2 },
                     { stat: "atk", kind: "flat", value: 10 }];
out.effects = {
    baseAtk: b.atk,
    flatThenMul: stat.applyEffects(b, flatThenMul).atk,
    mulThenFlat: stat.applyEffects(b, mulThenFlat).atk,
    // Ten +10% dodge pieces must not exceed the cap.
    dodgePile: stat.applyEffects(b, Array.from({ length: 10 }, function () {
        return { stat: "dodge", kind: "flat", value: 0.10 };
    })).dodge,
    critPile: stat.applyEffects(b, Array.from({ length: 10 }, function () {
        return { stat: "crit", kind: "flat", value: 0.10 };
    })).crit,
    // An unknown stat id must be ignored, not crash or land somewhere.
    unknown: stat.applyEffects(b, [{ stat: "nope", kind: "flat", value: 999 }]),
    // Two different stats in one set.
    twoStats: stat.applyEffects(b, [{ stat: "hp", kind: "flat", value: 5 },
                                    { stat: "ink", kind: "mul", value: 0.5 }])
};

// The roster, with the stats each one actually gets.
out.roster = stat.ROSTER.map(function (spec) {
    const f = stat.createFighter(spec.id, 1, []);
    return {
        id: spec.id, resourceId: spec.resourceId, card: spec.card,
        classId: spec.classId, elementId: spec.elementId, headId: spec.headId,
        difficulty: spec.difficulty, unlock: spec.unlock,
        skills: spec.skills,
        stats: f.stats,
        hp: f.hp, ink: f.ink, breath: f.breath
    };
});

out.classesCovered = Array.from(new Set(stat.ROSTER.map(function (s) {
    return s.classId;
}))).sort();

// createFighter with a level and gear, to confirm it composes.
out.fighterAt10 = stat.createFighter("kirara", 10,
    [{ stat: "atk", kind: "flat", value: 6 },
     { stat: "crit", kind: "flat", value: 0.15 }]).stats;

// An unknown id must fall back rather than throw.
out.fighterUnknown = stat.createFighter("nobody", 1, []).id;

out.formats = {
    ratio: stat.formatStat("dodge", 0.123),
    tile: stat.formatStat("speed", 5.4321),
    rate: stat.formatStat("inkRegen", 1.666),
    flat: stat.formatStat("hp", 20),
    fire: stat.formatStat("rate", 2.25)
};

process.stdout.write(JSON.stringify(out, null, 1));
