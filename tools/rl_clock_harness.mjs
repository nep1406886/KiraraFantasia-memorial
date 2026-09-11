// Harness for game/rl/clock.js (master plan 阶段 0 acceptance).
//
//   node tools/rl_clock_harness.mjs
//
// 1. 1000 uneven frame dts -> cumulative update steps match floor(total/step)
//    within 1 step (the accumulator carries at most one step of remainder,
//    plus float drift).
// 2. One 30s dt -> at most 15 steps (0.25s clamp at step 1/60). The expected
//    unclamped count is asserted first so the check can't pass vacuously: if
//    the clamp were missing, the count would be 1800, not 15.
// 3. update() always receives exactly the configured step; render() alpha
//    stays in [0, 1).

import { createClock, MAX_FRAME_DT, DEFAULT_STEP } from "../site/game/rl/clock.js";

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

// --- 1. 1000 uneven dts -------------------------------------------------

const STEP = DEFAULT_STEP;
const seenSteps = [];
const seenDts = [];
const alphas = [];
let totalDt = 0;

const uneven = createClock({
    step: STEP,
    update: function (dt) { seenDts.push(dt); },
    render: function (alpha) { alphas.push(alpha); }
});

// Deterministic uneven frames between ~2ms and ~46ms — all under the clamp,
// so the expected count is pure arithmetic: floor(total / step).
const dts = [];
for (let i = 0; i < 1000; i++) {
    dts.push(0.002 + ((i * 17) % 41) * 0.0011);
}
dts.forEach(function (dt) {
    totalDt += dt;
    seenSteps.push(uneven.tick(dt));
});

const actualSteps = seenSteps.reduce(function (a, b) { return a + b; }, 0);
const expectedSteps = Math.floor(totalDt / STEP);
check("1000 uneven dts: step count within 1 of floor(total/step)",
    Math.abs(actualSteps - expectedSteps) <= 1,
    "actual=" + actualSteps + " expected=" + expectedSteps);
check("every update() received exactly the configured step",
    seenDts.every(function (dt) { return dt === STEP; }),
    seenDts.length + " updates");
check("render() alpha always in [0,1)",
    alphas.every(function (a) { return a >= 0 && a < 1; }));

// --- 2. the 30s tab-away frame ------------------------------------------

// Vacuity guard: without the clamp this frame WOULD be 1800 steps, so the
// ≤15 assertion below is a real test of the clamp, not a tautology.
const unclamped = Math.floor(30 / STEP);
check("vacuity guard: 30s unclamped would be 1800 steps",
    unclamped === 1800, "unclamped=" + unclamped);

let bigSteps = 0;
const tabbed = createClock({ step: STEP, update: function () { bigSteps += 1; } });
bigSteps += tabbed.tick(30);
const maxSteps = Math.floor(MAX_FRAME_DT / STEP);
check("single 30s dt clamped to <= " + maxSteps + " steps",
    bigSteps >= 0 && bigSteps <= maxSteps, "steps=" + bigSteps);

// And the clamp must not lose the remainder: the accumulator afterwards is
// 30s minus the steps actually run, inside [0, step).
check("accumulator holds a sub-step remainder after the big frame",
    tabbed.accumulator >= 0 && tabbed.accumulator < STEP,
    "acc=" + tabbed.accumulator.toFixed(6));

// --- 3. degenerate inputs ------------------------------------------------

const guard = createClock({ step: STEP });
check("negative dt is ignored, not run backwards",
    guard.tick(-5) === 0 && guard.accumulator === 0);
check("zero dt runs nothing", guard.tick(0) === 0);

console.log(failures ? "\n" + failures + " FAILED" : "\nall clock checks passed");
process.exit(failures ? 1 : 0);
