// 教学 (plan 阶段 8「菜单、教学、成就」): the guided first-run walkthrough.
//
// DOM-free state machine — main.js owns #tutorial-hint and renders whatever
// onHint hands it, so the browser gate can drive this module headless and
// assert step transitions without a stage.
//
// input.js booleans are HELD, not edge-triggered (KeyJ down fires attack every
// frame it's held), so the tutorial does its own edge detection: a step
// advances on the rising edge only, and the move step accumulates hold time
// instead. update(inputState, dt) is called from main.js's step() every frame
// while active and the world isn't frozen — a frozen world (dialogue up, menu
// open) must not advance the tutorial, and the caller enforces that.
//
// Steps: 0 move → 1 attack → 2 dodge → 3 skill → 4 interact → 5 done. The
// done step just shows a closing line for ~5s, then fires onDone() once —
// main.js uses that to meta.markTutorialSeen() and hide the hint.

const MOVE_HOLD_SECS = 0.4;   // 按住方向键一小会儿，别把轻触当学会
const DONE_LINGER_SECS = 5;   // 收尾提示停留时间

const HINTS = [
    "移动：WASD 或方向键（按住走一走）",
    "攻击：J 或鼠标左键",
    "闪避：K 或空格",
    "技能：1 / 2 / 3",
    "互动：E（靠近残页、商店、篝火时）",
    "基本操作齐了——去把散落的书页救回来吧！"
];

export function createTutorial(options) {
    const opts = options || {};
    const onHint = typeof opts.onHint === "function" ? opts.onHint : function () {};
    const onDone = typeof opts.onDone === "function" ? opts.onDone : function () {};

    let active = false;
    let step = 0;
    let holdSecs = 0;      // move step: cumulative |move|>0 time
    let lingerSecs = 0;    // done step: time since the closing line showed
    let doneFired = false;
    // Previous frame's button snapshot for rising-edge detection.
    let prev = null;

    function snapshot(input) {
        return {
            attack: !!input.attack,
            dodge: !!input.dodge,
            interact: !!input.interact,
            skill: [
                !!input.skill[0], !!input.skill[1], !!input.skill[2]
            ]
        };
    }

    function enter(next) {
        step = next;
        holdSecs = 0;
        lingerSecs = 0;
        onHint(step, HINTS[step]);
    }

    return {
        begin: function () {
            active = true;
            doneFired = false;
            prev = null; // begin() runs right before the first update; the
                         // first frame establishes the baseline (no phantom
                         // rising edge from a key held during the dialogue).
            enter(0);
        },

        // update(inputState, dt) — dt in seconds, defaults to 1/60 for
        // callers that don't track it.
        update: function (input, dt) {
            if (!active || !input) {
                return;
            }
            const delta = typeof dt === "number" && dt > 0 ? dt : 1 / 60;
            const now = snapshot(input);

            if (step === 0) {
                const mx = input.move ? input.move.x || 0 : 0;
                const my = input.move ? input.move.y || 0 : 0;
                if (mx * mx + my * my > 0) {
                    holdSecs += delta;
                    if (holdSecs >= MOVE_HOLD_SECS) {
                        enter(1);
                    }
                }
            } else if (step === 1) {
                if (now.attack && !prev.attack) { enter(2); }
            } else if (step === 2) {
                if (now.dodge && !prev.dodge) { enter(3); }
            } else if (step === 3) {
                for (let i = 0; i < 3; i++) {
                    if (now.skill[i] && !prev.skill[i]) {
                        enter(4);
                        break;
                    }
                }
            } else if (step === 4) {
                if (now.interact && !prev.interact) { enter(5); }
            } else if (step === 5) {
                lingerSecs += delta;
                if (lingerSecs >= DONE_LINGER_SECS && !doneFired) {
                    doneFired = true;
                    active = false;
                    onDone();
                }
            }

            prev = now;
        },

        get active() { return active; },
        get step() { return step; },

        // dispose() — abandon the walkthrough (menu opened mid-tutorial and
        // the caller decided to keep the flag unmarked, etc.). onDone is NOT
        // fired, so the save keeps tutorialSeen=false and the next fresh run
        // offers the walkthrough again.
        dispose: function () {
            active = false;
        }
    };
}
