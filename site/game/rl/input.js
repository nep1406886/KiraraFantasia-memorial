// Input for the roguelike layer (T05 contract).
//
//   input.state → { move: {x,y}, attack, dodge, skill: [bool×3], ultimate, menu }
//
// Bindings follow docs/游玩说明.md exactly:
//   WASD / arrows  move          J / mouse-left  attack
//   K / Space      dodge         2 / 3           character skills
//   R / 1          ultimate      Esc             menu
//
// state is a live object, refreshed on every keydown/keyup — the game loop
// just reads it each update. Booleans are "held", not edge-triggered; stage 1
// builds edge detection on top when actions need it.
//
// attach()/detach() wire the listeners so a harness (or the menu system later)
// can turn the game's input off without touching the key handlers themselves.

const KEYMAP = {
    KeyW: "up", ArrowUp: "up",
    KeyS: "down", ArrowDown: "down",
    KeyA: "left", ArrowLeft: "left",
    KeyD: "right", ArrowRight: "right",
    KeyJ: "attack",
    KeyK: "dodge", Space: "dodge",
    Digit1: "skill0", Numpad1: "skill0",
    Digit2: "skill1", Numpad2: "skill1",
    Digit3: "skill2", Numpad3: "skill2",
    KeyR: "ultimate",
    KeyE: "interact",
    KeyH: "assist",
    Escape: "menu"
};

export function createInput() {
    const state = {
        move: { x: 0, y: 0 },
        attack: false,
        dodge: false,
        interact: false,
        assist: false,
        skill: [false, false, false],
        ultimate: false,
        menu: false,
        // T22k 键鼠联动: pointer position in NDC (-1..1) over the stage
        // canvas, with a "seen at least once" latch. The view layer converts
        // it to world ground coordinates (input.js stays three-free).
        pointer: { x: 0, y: 0, active: false },
        // Independent touch attack stick: a continuous screen-space direction.
        aimStick: { x: 0, y: 0, active: false }
    };

    // Which movement keys are currently held; move.x/y are recomputed from
    // these so simultaneous opposite keys (W+S) cancel instead of jittering.
    const held = { up: false, down: false, left: false, right: false };
    const heldKeys = new Set();
    let mouseAttack = false;

    function editable(target) {
        return target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    }

    function keyState(code, down) {
        if (down) { heldKeys.add(code); } else { heldKeys.delete(code); }
        const name = KEYMAP[code];
        const active = [...heldKeys].some(key => KEYMAP[key] === name);
        apply(name, active || name === "attack" && mouseAttack);
    }

    function apply(name, down) {
        if (name === "up" || name === "down" || name === "left" || name === "right") {
            held[name] = down;
            state.move.x = (held.right ? 1 : 0) - (held.left ? 1 : 0);
            state.move.y = (held.down ? 1 : 0) - (held.up ? 1 : 0);
            return;
        }
        if (name === "skill0" || name === "skill1" || name === "skill2") {
            state.skill[Number(name.slice(5))] = down;
        } else {
            state[name] = down;
        }
    }

    function onKeyDown(event) {
        const name = KEYMAP[event.code];
        if (!name || editable(event.target)) {
            return;
        }
        // Stop the page from scrolling on Space / arrows while playing.
        if (event.code === "Space" || event.code.indexOf("Arrow") === 0) {
            event.preventDefault();
        }
        keyState(event.code, true);
    }

    function onKeyUp(event) {
        const name = KEYMAP[event.code];
        if (name) {
            keyState(event.code, false);
        }
    }

    // Mouse-left counts as attack, matching the manual. button 0 only, so a
    // middle/right click can still open browser menus. A mousedown the browser
    // synthesised from a touch is skipped: the touch controls own their taps
    // (a joystick drag must not also swing). A click on the play field also
    // arms the aim at the click spot — click-to-attack aims where it clicks
    // even if no pointermove ran first (cursor resting since page load).
    // A quick click can land mousedown+mouseup inside one update gap; a pure
    // level flag would then never be true during a world update and the click
    // is swallowed (measured 2026-09-17: swing stayed 0). The pending latch
    // holds the click until the next update has seen it (endStep clears it
    // once, from main.js after world.update); holding the button keeps the
    // level true, so held auto-fire is unchanged.
    let mouseAttackPending = false;
    function syncAttack() {
        state.attack = [...heldKeys].some(key => KEYMAP[key] === "attack")
            || mouseAttack || mouseAttackPending;
    }
    function onMouseDown(event) {
        if (event.button !== 0
            || rendererCanvas && event.target !== rendererCanvas
            || (event.sourceCapabilities
                && event.sourceCapabilities.firesTouchEvents)) {
            return;
        }
        mouseAttack = true;
        mouseAttackPending = true;
        syncAttack();
        if (event.target === rendererCanvas) {
            aimFrom(event.clientX, event.clientY);
        }
    }

    function onMouseUp(event) {
        if (event.button === 0) {
            mouseAttack = false;
            syncAttack();
        }
    }

    // The click's latch stays armed until the world has actually swung with
    // it — a click that lands DURING a swing must still queue the next one
    // (the level is consumed by the first actionable frame after the swing
    // ends). main.js passes seen = the player's swingId changed this update;
    // holding the button keeps the level true regardless (auto-fire).
    function endStep(seen) {
        if (mouseAttackPending && seen) {
            mouseAttackPending = false;
            syncAttack();
        }
    }

    // T22k: the aim channel. A pointermove over the play field updates the
    // NDC pointer; the canvas rect maps client px → NDC, clamped to -1..1 so
    // a cursor hovering an overlay (menu/shop) still aims at the stage edge.
    // pointermove (not mousemove) because it also carries the pen; touch is
    // deliberately excluded — the touch controls own their taps, and a drag
    // on the joystick would swing the aim.
    // Only moves whose target IS the canvas arm the aim: the cursor riding a
    // UI overlay (roster card click, menu buttons, dialogue box) must not
    // leave a stale aim that hijacks every later keyboard swing — a
    // keyboard-only player who clicked the roster once would otherwise aim
    // every attack at wherever that click happened to sit.
    function aimFrom(clientX, clientY) {
        const canvas = rendererCanvas;
        if (!canvas) {
            return;
        }
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) {
            return;
        }
        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
        state.pointer.x = Math.max(-1, Math.min(1, ndcX));
        state.pointer.y = Math.max(-1, Math.min(1, ndcY));
        state.pointer.active = true;
    }

    function onPointerMove(event) {
        if (event.pointerType === "touch") {
            state.pointer.active = false;
            return;
        }
        if (event.target !== rendererCanvas) {
            return;
        }
        aimFrom(event.clientX, event.clientY);
    }

    function onMouseLeave() {
        // Cursor left the window: aim is stale, fall back to move/facing.
        state.pointer.active = false;
    }

    // A key that goes down while the tab is hidden never gets its keyup if
    // the browser eats it (Alt+Tab on Windows does this) — clear on blur so
    // the character doesn't run in a straight line forever.
    function onBlur() {
        heldKeys.clear();
        mouseAttack = false;
        Object.keys(KEYMAP).forEach(function (code) {
            apply(KEYMAP[code], false);
        });
        state.attack = false;
        state.pointer.active = false;
        state.aimStick.x = 0; state.aimStick.y = 0; state.aimStick.active = false;
    }

    function onVisibility() { if (document.hidden) { onBlur(); } }

    let attached = false;
    let rendererCanvas = null;   // set by attach(canvas), for the aim mapping
    function attach(canvas) {
        rendererCanvas = canvas || null;
        if (attached) {
            return;
        }
        attached = true;
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("mousedown", onMouseDown);
        window.addEventListener("mouseup", onMouseUp);
        window.addEventListener("pointermove", onPointerMove);
        document.addEventListener("mouseleave", onMouseLeave);
        window.addEventListener("blur", onBlur);
        document.addEventListener("visibilitychange", onVisibility);
    }

    function detach() {
        if (!attached) {
            return;
        }
        attached = false;
        onBlur();
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("mouseup", onMouseUp);
        window.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("mouseleave", onMouseLeave);
        window.removeEventListener("blur", onBlur);
        document.removeEventListener("visibilitychange", onVisibility);
    }

    return {
        attach: attach,
        detach: detach,
        clear: onBlur,
        endStep: endStep,
        get state() { return state; }
    };
}
