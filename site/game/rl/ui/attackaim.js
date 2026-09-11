// One captured attack finger; movement fingers and world settlement stay separate.
// Screen-space direction is converted by the page's combat-plane projector.
export function createAttackAim(button, input, actions) {
    const aim = input.state.aimStick;
    let pointer = null, origin = null, releasing = false;
    const hint = document.createElement("span");
    hint.className = "touch-attack-hint"; hint.textContent = "拖动瞄准";
    const marker = document.createElement("span");
    marker.className = "touch-aim-marker"; marker.setAttribute("aria-hidden", "true");
    button.append(hint, marker);
    button.setAttribute("aria-label", "攻击：轻点出招，按住连击，拖动可360度瞄准");

    function visualOff() {
        button.classList.remove("aiming");
        button.style.removeProperty("--aim-angle");
    }
    function releasePointer() {
        const id = pointer; pointer = null; origin = null;
        if (id !== null && button.hasPointerCapture(id)) { button.releasePointerCapture(id); }
        visualOff();
    }
    function clear() {
        const owned = pointer !== null || releasing;
        releasing = false; releasePointer();
        aim.x = 0; aim.y = 0; aim.active = false;
        if (owned) { actions.cancel(); }
    }
    function down(event) {
        if (event.button > 0 || pointer !== null || button.getAttribute("aria-disabled") === "true") { return; }
        event.preventDefault();
        pointer = event.pointerId; origin = { x: event.clientX, y: event.clientY };
        releasing = false; aim.active = false; input.state.pointer.active = false;
        try { button.setPointerCapture(pointer); } catch (_) { /* Window up/cancel still releases it. */ }
        actions.press();
    }
    function move(event) {
        if (event.pointerId !== pointer || !origin) { return; }
        event.preventDefault();
        const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
        const length = Math.hypot(dx, dy);
        if (!Number.isFinite(length) || length < 10) { return; }
        aim.x = dx / length; aim.y = dy / length; aim.active = true;
        button.style.setProperty("--aim-angle", Math.atan2(dy, dx) + "rad");
        button.classList.add("aiming");
    }
    function up(event) {
        if (event.pointerId !== pointer) { return; }
        event.preventDefault(); releasePointer(); releasing = true;
        // Keep a sub-frame drag's last direction until the same step that sees
        // its latched attack. Ordinary held attacks stop through the same lift.
        actions.lift();
    }
    function cancel(event) { if (event.pointerId === pointer) { clear(); } }
    function touchStart(event) {
        // Pointer events own this gesture. Cancelling the native touch gesture
        // also prevents Chromium from suppressing the next menu/skill tap after
        // a fast drag; pointer.preventDefault alone only affects mouse events.
        if (pointer !== null) { event.preventDefault(); }
    }
    function keyDown(event) {
        if (event.key !== "Enter" && event.key !== " ") { return; }
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat && button.getAttribute("aria-disabled") !== "true") { actions.press(); }
    }
    function keyUp(event) {
        if (event.key !== "Enter" && event.key !== " ") { return; }
        event.preventDefault(); event.stopPropagation(); actions.lift();
    }
    function blur() { if (pointer === null) { actions.lift(); } }
    button.addEventListener("pointerdown", down);
    button.addEventListener("touchstart", touchStart, { passive: false });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    button.addEventListener("lostpointercapture", cancel);
    button.addEventListener("keydown", keyDown);
    button.addEventListener("keyup", keyUp);
    button.addEventListener("blur", blur);
    return {
        clear,
        pump() {
            if (releasing) { releasing = false; aim.active = false; aim.x = 0; aim.y = 0; }
        },
        dispose() {
            clear();
            button.removeEventListener("pointerdown", down);
            button.removeEventListener("touchstart", touchStart);
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", cancel);
            button.removeEventListener("lostpointercapture", cancel);
            button.removeEventListener("keydown", keyDown);
            button.removeEventListener("keyup", keyUp);
            button.removeEventListener("blur", blur);
            hint.remove(); marker.remove();
        }
    };
}
