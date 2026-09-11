// Measure core/lbgear.js: tier scaling, option stability, fusion arithmetic,
// drop distribution, and what a full loadout does to the twelve stats.
//
// Run by tools/check_lb_gear.py, which copies core/*.js to .mjs first (node
// reads a bare .js as CommonJS) and hands the copies' paths in argv.
//
// usage: node lb_gear_harness.mjs <lbgear.mjs> <lbstat.mjs> <platformer.mjs>

const [gearPath, statPath, platformerPath] = process.argv.slice(2);

const gear = await import(pathToUrl(gearPath));
const stat = await import(pathToUrl(statPath));
const { createRandom, seedFrom } = await import(pathToUrl(platformerPath));

function pathToUrl(p) {
    return "file:///" + p.replace(/\\/g, "/");
}

const DROPS = 40000;   // per whiteness row
const out = {
    slots: gear.SLOT_IDS,
    tierMax: gear.TIER_MAX,
    mainScale: gear.MAIN_SCALE,
    fuseCost: gear.FUSE_COST,
    // Per (slot, variant, tier): the effects it produces.
    pieces: [],
    // Options must not change when a piece gains a tier.
    optionDrift: [],
    // A piece must never carry its slot's main stat as an option.
    mainAsOption: [],
    // Effect count must equal the tier (main + tier-1 options).
    effectCountWrong: [],
    // Main effect must grow strictly with tier.
    mainNotMonotonic: [],
    // Option values must NOT grow with tier (§3.7: the count grows).
    optionScaled: [],
    fusion: null,
    drops: [],
    loadout: null
};

// --- per-piece tables --------------------------------------------------------

for (const slotId of gear.SLOT_IDS) {
    const slot = gear.slotInfo(slotId);
    for (const v of gear.VARIANTS[slotId]) {
        let prevMain = -Infinity;
        let prevOptions = [];
        for (let tier = 1; tier <= gear.TIER_MAX; tier++) {
            const piece = gear.makePiece(slotId, v.id, tier);
            const effects = gear.effectsOf(piece);
            const main = effects[0];
            const options = effects.slice(1);

            out.pieces.push({
                slot: slotId, variant: v.id, tier,
                main: { stat: main.stat, value: main.value },
                options: options.map(function (e) {
                    return { stat: e.stat, value: e.value };
                }),
                weight: gear.weight([piece])
            });

            if (effects.length !== tier) {
                out.effectCountWrong.push({ slot: slotId, variant: v.id, tier,
                                            got: effects.length });
            }
            if (main.stat !== slot.main) {
                out.mainAsOption.push({ slot: slotId, variant: v.id, tier,
                                        why: "main effect is not the slot's stat",
                                        got: main.stat });
            }
            for (const o of options) {
                if (o.stat === slot.main) {
                    out.mainAsOption.push({ slot: slotId, variant: v.id, tier,
                                            why: "option repeats the main stat",
                                            got: o.stat });
                }
            }
            // Distinct options -- two of the same stat reads as a duplicate,
            // not as a tier.
            const names = options.map(function (o) { return o.stat; });
            if (new Set(names).size !== names.length) {
                out.mainAsOption.push({ slot: slotId, variant: v.id, tier,
                                        why: "duplicate option stat",
                                        got: names.join(",") });
            }

            if (main.value <= prevMain) {
                out.mainNotMonotonic.push({ slot: slotId, variant: v.id, tier,
                                            prev: prevMain, got: main.value });
            }
            prevMain = main.value;

            // The options a lower tier had must survive verbatim.
            for (let i = 0; i < prevOptions.length; i++) {
                const before = prevOptions[i];
                const after = options[i];
                if (!after || after.stat !== before.stat) {
                    out.optionDrift.push({
                        slot: slotId, variant: v.id, tier, index: i,
                        was: before.stat, now: after ? after.stat : null
                    });
                } else if (after.value !== before.value) {
                    out.optionScaled.push({
                        slot: slotId, variant: v.id, tier, stat: after.stat,
                        was: before.value, now: after.value
                    });
                }
            }
            prevOptions = options;
        }
    }
}

// --- fusion ------------------------------------------------------------------

{
    const f = { paths: [], freeFuse: [], crossKind: [], overMax: [],
                tierTotal: [], pairCount: [] };

    for (const slotId of gear.SLOT_IDS) {
        for (const v of gear.VARIANTS[slotId]) {
            // Walk 1 -> 5 and record what it costs from scratch.
            //
            // 2^(TIER_MAX-1) tier-1 pieces go in. Half of them pair off at
            // tier 1, a quarter of the original count at tier 2, and so on
            // down to one fusion at tier 4 -- the count of fusions *halves*
            // as the tier climbs. (Written the other way round first, which
            // reported 1288 instead of 464 by charging the most fusions at
            // the most expensive tier.)
            const copies = Math.pow(2, gear.TIER_MAX - 1);
            let atTier = copies;
            let total = 0;
            for (let tier = 1; tier < gear.TIER_MAX; tier++) {
                const fusions = atTier / 2;
                total += gear.fuseCost(tier) * fusions;
                atTier = fusions;
            }
            f.tierTotal.push({ slot: slotId, variant: v.id,
                               copiesForMax: copies, scrapsForMax: total });

            for (let tier = 1; tier <= gear.TIER_MAX; tier++) {
                const a = gear.makePiece(slotId, v.id, tier);
                const b = gear.makePiece(slotId, v.id, tier);
                const cost = gear.fuseCost(tier);

                // Exactly enough must work; one short must not.
                const ok = gear.fuse(a, b, cost);
                const short = gear.fuse(a, b, cost - 1);
                if (tier < gear.TIER_MAX) {
                    f.paths.push({ slot: slotId, variant: v.id, tier, cost,
                                   made: ok ? ok.piece.tier : null,
                                   spent: ok ? ok.spent : null });
                    if (!ok) {
                        f.freeFuse.push({ slot: slotId, variant: v.id, tier,
                                          why: "exact payment refused" });
                    }
                    if (short) {
                        f.freeFuse.push({ slot: slotId, variant: v.id, tier,
                                          why: "fused one scrap short",
                                          cost });
                    }
                } else if (ok || short) {
                    f.overMax.push({ slot: slotId, variant: v.id, tier });
                }
            }

            // Mixed tiers must not fuse: 1 + 4 -> 5 would undo the cost of 5.
            const mixed = gear.fuse(gear.makePiece(slotId, v.id, 1),
                                   gear.makePiece(slotId, v.id, 4), 99999);
            if (mixed) {
                f.crossKind.push({ slot: slotId, variant: v.id,
                                   why: "tier 1 + tier 4 fused" });
            }
            // Different variants must not fuse.
            for (const w of gear.VARIANTS[slotId]) {
                if (w.id === v.id) { continue; }
                const x = gear.fuse(gear.makePiece(slotId, v.id, 2),
                                    gear.makePiece(slotId, w.id, 2), 99999);
                if (x) {
                    f.crossKind.push({ slot: slotId, why: "variants fused",
                                       a: v.id, b: w.id });
                }
            }
        }
        // Different slots must not fuse.
        for (const other of gear.SLOT_IDS) {
            if (other === slotId) { continue; }
            const x = gear.fuse(gear.makePiece(slotId,
                                              gear.VARIANTS[slotId][0].id, 2),
                                gear.makePiece(other,
                                               gear.VARIANTS[other][0].id, 2),
                                99999);
            if (x) {
                f.crossKind.push({ why: "slots fused", a: slotId, b: other });
            }
        }
    }

    // Three copies must offer one pair, not two.
    const kind = gear.VARIANTS.brush[0].id;
    const three = [gear.makePiece("brush", kind, 1),
                   gear.makePiece("brush", kind, 1),
                   gear.makePiece("brush", kind, 1)];
    f.pairCount.push({ bag: 3, pairs: gear.fusablePairs(three, 9999).length });
    const four = three.concat([gear.makePiece("brush", kind, 1)]);
    f.pairCount.push({ bag: 4, pairs: gear.fusablePairs(four, 9999).length });
    // Broke: no pair should be offered.
    f.pairCount.push({ bag: 3, scraps: 0,
                       pairs: gear.fusablePairs(three, 0).length });

    out.fusion = f;
}

// --- drops -------------------------------------------------------------------

for (let whiteness = 0; whiteness < 5; whiteness++) {
    const rand = createRandom(seedFrom("drop:" + whiteness));
    const tiers = {};
    const slots = {};
    const variants = {};
    for (let i = 0; i < DROPS; i++) {
        const p = gear.rollDrop(whiteness, rand);
        tiers[p.tier] = (tiers[p.tier] || 0) + 1;
        slots[p.slot] = (slots[p.slot] || 0) + 1;
        variants[p.slot + ":" + p.variant] =
            (variants[p.slot + ":" + p.variant] || 0) + 1;
    }
    out.drops.push({
        whiteness,
        n: DROPS,
        tiers,
        // Slot share, so a rollDrop that never picks the last slot is visible.
        slotShare: gear.SLOT_IDS.map(function (s) {
            return Math.round(1000 * (slots[s] || 0) / DROPS) / 1000;
        }),
        variantKinds: Object.keys(variants).length,
        minVariantShare: Math.min.apply(null, Object.keys(variants).map(
            function (k) { return variants[k] / DROPS; })),
        meanTier: Object.keys(tiers).reduce(function (a, t) {
            return a + Number(t) * tiers[t];
        }, 0) / DROPS
    });
}

// --- a full loadout against a naked hero -------------------------------------

{
    const best = gear.SLOT_IDS.map(function (s) {
        return gear.makePiece(s, gear.VARIANTS[s][0].id, gear.TIER_MAX);
    });
    const worst = gear.SLOT_IDS.map(function (s) {
        return gear.makePiece(s, gear.VARIANTS[s][0].id, 1);
    });

    // Every roster entry, so a class whose shape makes gear dominant shows up.
    const perHero = stat.ROSTER.map(function (spec) {
        const naked = stat.baseStats({ classId: spec.classId,
                                       elementId: spec.elementId,
                                       level: stat.LEVEL_MAX });
        const dressed = stat.applyEffects(naked, gear.loadoutEffects(best));
        const ratios = {};
        stat.STAT_IDS.forEach(function (id) {
            ratios[id] = naked[id] > 0
                ? Math.round(1000 * dressed[id] / naked[id]) / 1000 : null;
        });
        return { id: spec.id, classId: spec.classId, ratios,
                 // Geometric mean over the twelve, so one capped ratio does
                 // not hide behind eleven others.
                 mean: Math.round(1000 * Math.exp(
                     stat.STAT_IDS.reduce(function (a, id) {
                         return a + Math.log(ratios[id] || 1);
                     }, 0) / stat.STAT_IDS.length)) / 1000 };
    });

    // The ratio stats must keep headroom under lbstat.js CAP even fully
    // dressed -- a capped stat makes further gear invisible.
    out.loadout = {
        slotsFilled: best.length,
        bestWeight: gear.weight(best),
        worstWeight: gear.weight(worst),
        // Same slot twice must not double up.
        doubledWeight: gear.weight(best.concat([best[0]])),
        effectCounts: best.map(gear.effectCount),
        headroom: gear.ratioHeadroom(best),
        // Worst case for the caps: every option that can be a ratio, on the
        // variant that rolls them earliest, at tier 5 in all four slots.
        headroomWorst: (function () {
            let worstOut = null;
            const pick = [];
            for (const s of gear.SLOT_IDS) {
                let bestV = null; let bestScore = -1;
                for (const v of gear.VARIANTS[s]) {
                    const eff = gear.effectsOf(gear.makePiece(s, v.id,
                                                              gear.TIER_MAX));
                    const score = eff.filter(function (e) {
                        return stat.CAP[e.stat] !== undefined;
                    }).reduce(function (a, e) { return a + e.value; }, 0);
                    if (score > bestScore) { bestScore = score; bestV = v.id; }
                }
                pick.push(gear.makePiece(s, bestV, gear.TIER_MAX));
            }
            worstOut = gear.ratioHeadroom(pick);
            return worstOut;
        })(),
        perHero,
        meanRatio: Math.round(1000 * perHero.reduce(function (a, h) {
            return a + h.mean;
        }, 0) / perHero.length) / 1000,
        maxRatio: Math.max.apply(null, perHero.map(function (h) {
            return h.mean;
        })),
        // Per-stat ceiling: for each stat, the tier-5 loadout that pushes it
        // hardest, measured on the hero it helps most.
        //
        // Not read off `best` -- that pins every slot to VARIANTS[slot][0], so
        // a stat absent from those four variants' first four options reported
        // a ratio of exactly 1.000 and looked untouchable by any gear. It is
        // reachable; that loadout just did not reach it. Asserting a balance
        // ceiling against one arbitrary loadout would pass whatever the other
        // variants do.
        perStatMax: (function () {
            const o = {};
            stat.STAT_IDS.forEach(function (id) {
                const pick = gear.SLOT_IDS.map(function (s) {
                    let bestV = gear.VARIANTS[s][0].id; let bestScore = -1;
                    for (const v of gear.VARIANTS[s]) {
                        const score = gear.effectsOf(
                            gear.makePiece(s, v.id, gear.TIER_MAX)
                        ).reduce(function (a, e) {
                            return a + (e.stat === id ? e.value : 0);
                        }, 0);
                        if (score > bestScore) { bestScore = score; bestV = v.id; }
                    }
                    return gear.makePiece(s, bestV, gear.TIER_MAX);
                });
                const effects = gear.loadoutEffects(pick);
                let worst = 0;
                let where = null;
                stat.ROSTER.forEach(function (spec) {
                    const naked = stat.baseStats({ classId: spec.classId,
                                                   elementId: spec.elementId,
                                                   level: stat.LEVEL_MAX });
                    const dressed = stat.applyEffects(naked, effects);
                    if (!(naked[id] > 0)) { return; }
                    const r = dressed[id] / naked[id];
                    if (r > worst) { worst = r; where = spec.id; }
                });
                o[id] = { ratio: Math.round(worst * 1000) / 1000, hero: where,
                          variants: pick.map(function (p) { return p.variant; }) };
            });
            return o;
        })()
    };
}

// --- rollDrop's third argument -----------------------------------------------
//
// game/laby.js builds the empty-slot list out of a save file, so it can arrive
// empty, short, or naming slots this build no longer has. Each case must still
// yield a wearable piece.
out.dropArgs = [];
[
    { label: "no third argument", arg: undefined },
    { label: "[]", arg: [] },
    { label: "unknown slot ids", arg: ["quill", "vellum"] },
    { label: "one real, one unknown", arg: ["mark", "quill"] },
    { label: "all four", arg: gear.SLOT_IDS.slice() },
    { label: "the same slot repeated", arg: ["mark", "mark", "mark"] },
    { label: "junk", arg: [null, 0, "", {}] }
].forEach(function (c, i) {
    let got = null;
    let ok = false;
    try {
        const rand = createRandom(seedFrom("args:" + i));
        // Several draws: the bias is a coin flip, so one draw can take the
        // uniform path and pass while the biased path is broken.
        for (let k = 0; k < 200; k++) {
            const p = gear.rollDrop(2, rand, c.arg);
            got = p;
            const known = gear.SLOT_IDS.indexOf(p && p.slot) >= 0;
            const variants = (p && gear.VARIANTS[p.slot]) || [];
            ok = known
                && variants.some(function (v) { return v.id === p.variant; })
                && p.tier >= 1 && p.tier < gear.TIER_MAX
                && gear.effectsOf(p).length === p.tier;
            if (!ok) { break; }
        }
    } catch (err) {
        got = "threw " + err.message;
        ok = false;
    }
    out.dropArgs.push({
        label: c.label,
        ok: ok,
        got: (got && got.slot) ? (got.slot + "/" + got.variant + "/" + got.tier)
                                : String(got)
    });
});

// The bias has to actually steer. Asked for one slot only, nearly every draw
// should land there -- but not all of them, or it is a guarantee and not a bias.
{
    const rand = createRandom(seedFrom("bias"));
    let hit = 0;
    const N = 20000;
    for (let k = 0; k < N; k++) {
        if (gear.rollDrop(2, rand, ["mark"]).slot === "mark") { hit += 1; }
    }
    out.biasShare = Math.round(1000 * hit / N) / 1000;
}

// --- one real run's worth of drops -------------------------------------------
//
// The tables above say what a piece is worth. This says what a player actually
// ends a book holding, which is a different question and the one that was
// wrong: with drops spread evenly over the four slots, a 13-room book filled
// only 2.97 of them, so a quarter of runs reached the boss having never seen a
// bookmark. Nothing throws -- it reads as bad luck.
{
    const ROOMS = 13;          // §3.2: 12-14 rooms a book
    const DROP_CHANCE = 0.34;  // game/laby.js awardRoom
    const RUNS = 3000;

    // Same policy as game/laby.js takeGear(), kept in step with it by hand.
    // (If they drift, the run figures stop describing the game -- so the gate
    // also checks the shape of that function's decisions below.)
    function take(run, piece) {
        const list = run.gear;
        for (let i = 0; i < list.length; i++) {
            if (list[i].slot !== piece.slot) { continue; }
            if (gear.canFuse(list[i], piece)) {
                const made = gear.fuse(list[i], piece, run.scraps | 0);
                if (made) {
                    run.scraps -= made.spent;
                    list[i] = made.piece;
                    return "fused";
                }
            }
            if (gear.weight([piece]) > gear.weight([list[i]])) {
                list[i] = piece;
                return "worn";
            }
            return "dropped";
        }
        list.push(piece);
        return "worn";
    }

    out.runs = [];
    for (let whiteness = 0; whiteness < 5; whiteness++) {
        let slots = 0;
        let tierSum = 0;
        let pieces = 0;
        let scraps = 0;
        let overMax = 0;
        let fused = 0;
        let worth = 0;
        let emptyRuns = 0;

        for (let k = 0; k < RUNS; k++) {
            const run = { gear: [], scraps: 0 };
            const rand = createRandom(seedFrom("run:" + whiteness + ":" + k));
            for (let room = 0; room < ROOMS; room++) {
                const boss = room === ROOMS - 1;
                run.scraps += Math.round((6 + whiteness * 4) * (boss ? 3 : 1)
                                         * (0.75 + rand.next() * 0.5));
                if (rand.next() >= (boss ? 1 : DROP_CHANCE)) { continue; }
                const piece = gear.rollDrop(whiteness, rand,
                                            gear.emptySlots(run.gear));
                if (take(run, piece) === "fused") { fused += 1; }
            }

            slots += run.gear.length;
            if (run.gear.length < gear.SLOT_IDS.length) { emptyRuns += 1; }
            scraps += run.scraps;
            run.gear.forEach(function (p) {
                pieces += 1;
                tierSum += p.tier;
                if (p.tier > gear.TIER_MAX) { overMax += 1; }
            });

            const naked = stat.baseStats({ classId: 0, elementId: 0,
                                           level: 12 });
            const dressed = stat.applyEffects(naked,
                                              gear.loadoutEffects(run.gear));
            worth += Math.exp(stat.STAT_IDS.reduce(function (a, id) {
                return a + Math.log(naked[id] > 0 ? dressed[id] / naked[id] : 1);
            }, 0) / stat.STAT_IDS.length);
        }

        out.runs.push({
            whiteness,
            runs: RUNS,
            slotsFilled: Math.round(1000 * slots / RUNS) / 1000,
            meanTier: Math.round(1000 * tierSum / Math.max(1, pieces)) / 1000,
            scrapsLeft: Math.round(scraps / RUNS),
            fusedPerRun: Math.round(1000 * fused / RUNS) / 1000,
            overMax,
            // Runs that ended with a slot never filled.
            emptyShare: Math.round(1000 * emptyRuns / RUNS) / 1000,
            setWorth: Math.round(1000 * worth / RUNS) / 1000
        });
    }
}

process.stdout.write(JSON.stringify(out));
