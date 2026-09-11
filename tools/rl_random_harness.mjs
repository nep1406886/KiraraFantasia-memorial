// Harness for game/rl/random.js (master plan 阶段 0 acceptance).
//
//   node tools/rl_random_harness.mjs
//
// 1. Same seed twice -> 1000 outputs identical (dungeon layouts must
//    reproduce from a seed).
// 2. Different seeds -> first 100 outputs all differ.
// 3. 10000 outputs, every one in [0, 1).
// 4. hash32: deterministic, discriminates strings, returns a uint32.

import { createRandom, seedFrom, hash32 } from "../site/game/rl/random.js";

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

// --- 1. same seed, same sequence ----------------------------------------

function take(rng, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(rng());
    }
    return out;
}

const runA = take(createRandom(12345), 1000);
const runB = take(createRandom(12345), 1000);
check("same seed -> identical 1000 outputs",
    runA.every(function (v, i) { return v === runB[i]; }));

// Vacuity guard: two different seeds must actually diverge somewhere in the
// first 1000 outputs, or check 2 below proves nothing about discrimination.
const other = take(createRandom(54321), 1000);
check("vacuity guard: different seeds do diverge somewhere",
    runA.some(function (v, i) { return v !== other[i]; }));

// --- 2. different seeds ---------------------------------------------------

const kirara = take(seedFrom("きらら"), 100);
const utsutsu = take(seedFrom("うつつ"), 100);
check("seedFrom('きらら') vs seedFrom('うつつ'): first 100 all differ",
    kirara.every(function (v, i) { return v !== utsutsu[i]; }));

// --- 3. range --------------------------------------------------------------

const many = take(createRandom(1), 10000);
check("10000 outputs all in [0, 1)",
    many.every(function (v) { return v >= 0 && v < 1; }));
// A generator stuck at a constant would also satisfy [0,1); make sure the
// outputs actually spread (both halves of the unit interval are hit).
const lowHalf = many.filter(function (v) { return v < 0.5; }).length;
check("outputs spread across the interval (not constant)",
    lowHalf > 4000 && lowHalf < 6000, "below-0.5 count=" + lowHalf);

// --- 4. hash32 -------------------------------------------------------------

check("hash32 deterministic for the same string",
    hash32("きららファンタジア外伝") === hash32("きららファンタジア外伝"));
check("hash32 discriminates different strings",
    hash32("volume-1") !== hash32("volume-2"));
check("hash32 discriminates near-identical strings",
    hash32("seed") !== hash32("seed0"));
const h = hash32("test");
check("hash32 returns a uint32",
    Number.isInteger(h) && h >= 0 && h <= 0xFFFFFFFF, "h=" + h);
check("seedFrom(x) === createRandom(hash32(x))",
    take(seedFrom("repro"), 3).join(",") === take(createRandom(hash32("repro")), 3).join(","));

console.log(failures ? "\n" + failures + " FAILED" : "\nall random checks passed");
process.exit(failures ? 1 : 0);
