// Harness for game/rl/tutorial.js (plan 阶段 8「菜单、教学、成就」acceptance):
// the DOM-free first-run walkthrough step machine.
//
//   node tools/rl_tutorial_harness.mjs
//
// Models the main.js caller contract: update(input.state, dt) is called every
// world step while the walkthrough is active and the world is not frozen.
// Booleans are HELD, so the module's own rising-edge detection is what
// advances steps — the harness feeds explicit press/release frames.
//
// Expected values are hardcoded here (including MOVE_HOLD_SECS = 0.4 and
// DONE_LINGER_SECS = 5) and never read back from the module internals.

import { createTutorial } from "../site/game/rl/tutorial.js";

const MOVE_HOLD_SECS = 0.4;   // tutorial.js:18
const DONE_LINGER_SECS = 5;   // tutorial.js:19

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

function frame(move, attack, dodge, interact, skill) {
    return {
        move: { x: move ? move[0] : 0, y: move ? move[1] : 0 },
        attack: !!attack,
        dodge: !!dodge,
        interact: !!interact,
        skill: [!!skill[0], !!skill[1], !!skill[2]]
    };
}

function run() {
    let hints = [];
    let doneCount = 0;
    let t = createTutorial({
        onHint: function (step, text) {
            hints.push({ step: step, text: text });
        },
        onDone: function () {
            doneCount += 1;
        }
    });

    // --- inactive updates are no-ops -------------------------------------
    t.update(null, 1 / 60);
    check("inactive: update(null) does not advance", t.step === 0 && !t.active);
    t.update(frame([0, 0], false, false, false, [false, false, false]), 1 / 60);
    check("inactive: update(input) does not advance", t.step === 0 && !t.active);

    // --- begin() ----------------------------------------------------------
    t.begin();
    check("begin: active and at step 0", t.active && t.step === 0);
    check("begin: announces hint 0", hints.length === 1 && hints[0].step === 0
        && hints[0].text.indexOf("移动") >= 0, JSON.stringify(hints[0].text));

    // --- step 0: move needs a sustained hold -----------------------------
    t.update(frame([1, 0], false, false, false, [false, false, false]), 0.1);
    t.update(frame([1, 0], false, false, false, [false, false, false]), 0.1);
    t.update(frame([1, 0], false, false, false, [false, false, false]), 0.1);
    check("move: 0.3s hold (< 0.4) does not advance",
        t.step === 0, "step=" + t.step);
    t.update(frame([0, 0], false, false, false, [false, false, false]), 0.2);
    check("move: releasing resets the hold without advancing", t.step === 0);
    t.update(frame([1, 0], false, false, false, [false, false, false]), MOVE_HOLD_SECS + 0.1);
    check("move: sustained hold advances to attack",
        t.step === 1 && hints.length === 2 && hints[1].step === 1,
        "step=" + t.step);

    // --- step 1: attack rising edge --------------------------------------
    // Entering a step, the previous frame's snapshot is the release baseline,
    // so the FIRST held frame is itself a rising edge — that's the responsive
    // behaviour we want. What must never happen is a held key advancing again
    // once the step it triggered has already moved on.
    t.update(frame([0, 0], false, false, false, [false, false, false]), 1 / 60);
    t.update(frame([0, 0], true, false, false, [false, false, false]), 1 / 60);
    check("attack: rising edge advances to dodge",
        t.step === 2 && hints.length === 3 && hints[2].step === 2, "step=" + t.step);
    t.update(frame([0, 0], true, false, false, [false, false, false]), 1 / 60);
    t.update(frame([0, 0], true, false, false, [false, false, false]), 1 / 60);
    t.update(frame([0, 0], true, false, false, [false, false, false]), 1 / 60);
    check("attack: holding after the edge does not double-advance", t.step === 2);

    // --- step 2: dodge rising edge (K or Space both map to dodge) --------
    t.update(frame([0, 0], false, false, false, [false, false, false]), 1 / 60);
    t.update(frame([0, 0], false, true, false, [false, false, false]), 1 / 60);
    check("dodge: rising edge advances to skill",
        t.step === 3 && hints.length === 4 && hints[3].step === 3, "step=" + t.step);
    t.update(frame([0, 0], false, true, false, [false, false, false]), 1 / 60);
    t.update(frame([0, 0], false, true, false, [false, false, false]), 1 / 60);
    t.update(frame([0, 0], false, true, false, [false, false, false]), 1 / 60);
    check("dodge: holding after the edge does not double-advance", t.step === 3);

    // --- step 3: any skill channel rising edge (2 / 3 per the hint) ------
    t.update(frame([0, 0], false, false, false, [false, false, false]), 1 / 60);
    t.update(frame([0, 0], false, false, false, [false, true, false]), 1 / 60);
    check("skill: rising edge on channel 2 advances to interact",
        t.step === 4 && hints.length === 5 && hints[4].step === 4, "step=" + t.step);
    t.update(frame([0, 0], false, false, false, [false, true, false]), 1 / 60);
    t.update(frame([0, 0], false, false, false, [false, true, false]), 1 / 60);
    check("skill: holding after the edge does not double-advance", t.step === 4);

    // --- step 4: interact rising edge (E) --------------------------------
    t.update(frame([0, 0], false, false, false, [false, false, false]), 1 / 60);
    t.update(frame([0, 0], false, false, true, [false, false, false]), 1 / 60);
    check("interact: rising edge advances to done",
        t.step === 5 && hints.length === 6 && hints[5].step === 5, "step=" + t.step);
    t.update(frame([0, 0], false, false, true, [false, false, false]), 1 / 60);
    t.update(frame([0, 0], false, false, true, [false, false, false]), 1 / 60);
    t.update(frame([0, 0], false, false, true, [false, false, false]), 1 / 60);
    check("interact: holding after the done entry does not re-fire onDone", doneCount === 0);

    // --- step 5: done lingers once, then fires onDone once ----------------
    t.update(frame([0, 0], false, false, false, [false, false, false]), DONE_LINGER_SECS - 0.5);
    check("done: still active before the linger elapses", t.active && doneCount === 0);
    t.update(frame([0, 0], false, false, false, [false, false, false]), 0.6);
    check("done: onDone fired exactly once and deactivates",
        doneCount === 1 && !t.active);
    t.update(frame([0, 0], false, false, false, [false, false, false]), 2.0);
    check("done: further updates never re-fire onDone", doneCount === 1);

    // --- dispose() abandons without firing onDone -------------------------
    t.begin();
    t.update(frame([1, 0], false, false, false, [false, false, false]), 0.2);
    t.update(frame([0, 0], false, true, false, [false, false, false]), 1 / 60);
    t.dispose();
    t.update(frame([0, 0], false, false, false, [false, false, false]), 6.0);
    check("dispose: abandons the walkthrough without onDone",
        !t.active && doneCount === 1);

    // --- move holds on the diagonal ---------------------------------------
    // Diagonal input is still a move (normalized x/y both non-zero); the
    // caller's input.js supplies the normalized vector, so a diagonal hold
    // counts as movement like any other.
    const t2 = createTutorial({ onHint: function () {}, onDone: function () {} });
    t2.begin();
    t2.update(frame([0.707, 0.707], false, false, false, [false, false, false]), MOVE_HOLD_SECS + 0.1);
    check("move: diagonal hold advances too", t2.step === 1, "step=" + t2.step);

    return failures;
}

const code = run();
console.log("");
console.log(code === 0 ? "ALL OK" : (code + " FAILURES"));
process.exit(code === 0 ? 0 : 1);