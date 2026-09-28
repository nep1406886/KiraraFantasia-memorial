// C.3 连击计数 (plan Tier 1-L): the HUD combo ticker. Damage numbers say HOW
// MUCH; the ticker says HOW OFTEN — hits landing within COMBO_WINDOW extend a
// chain, the chain dies the moment the player stops connecting (or leaves the
// room), and only from the 5th hit does the counter present at all (a 2-hit
// "combo" is just fighting).
//
// Pure presentation: main.js pushes hits at it from the existing "hit" event
// the damage numbers already ride; the counter never touches the world.
export const COMBO_WINDOW = 2.5;   // seconds between hits that keep a chain
export const COMBO_MIN = 5;         // from this many hits the ticker appears

export function createComboMeter(container) {
    const node = document.createElement("div");
    node.className = "combo-meter";
    node.setAttribute("aria-hidden", "true");
    // Bottom-right, above the とっておき gauge — the two readouts stack on
    // the same corner the player's thumb already owns. clamp() only (the
    // 375/1280-green, 390-broken lesson lives in the HUD's own comments).
    node.style.cssText = `
        position: absolute;
        right: clamp(10px, 2.5vw, 26px);
        bottom: calc(clamp(10px, 3vh, 26px) + clamp(18px, 3.2vh, 26px)
                     + clamp(8px, 1.5vh, 14px) + clamp(48px, 11vw, 66px) + 10px);
        z-index: 30;
        pointer-events: none;
        font-family: var(--font-serif);
        font-variant-numeric: tabular-nums;
        color: var(--kf-gold);
        font-size: clamp(0.9rem, 2.4vw, 1.15rem);
        font-weight: 800;
        text-shadow: 0 1px 0 var(--kf-paper), 0 2px 4px var(--kf-shadow);
        opacity: 0;
        transform: translateY(6px) scale(0.95);
        transition: opacity 0.25s ease-out, transform 0.25s ease-out;
    `;
    container.appendChild(node);

    let count = 0;
    let lastHit = -1e9;   // seconds; a first hit at t=0 must not read as "decay"
    let age = 0;         // seconds since the last hit, for the pop animation
    let peak = 0;        // pop scale riding the newest hit

    return {
        node,
        get count() { return count; },
        // A player-dealt hit on an enemy (main.js filters and forwards).
        hit() {
            count += 1;
            lastHit = age;
            peak = 1;
            if (count >= COMBO_MIN) {
                node.textContent = count + " 连击";
                node.style.opacity = "1";
                node.style.transform = "translateY(0) scale(1.06)";
            }
        },
        update(dt) {
            const step = Number.isFinite(dt) ? dt : 0;
            age += step;
            // The chain breaks on silence, not on the frame it happens: the
            // window is generous (dodge-repositioning costs time) and the
            // reset is silent — no animation for losing, only for building.
            if (count > 0 && age - lastHit > COMBO_WINDOW) {
                count = 0;
                node.style.opacity = "0";
                node.style.transform = "translateY(6px) scale(0.95)";
                return;
            }
            if (peak > 0) {
                peak = Math.max(0, peak - step * 5);
                // Decay the pop back toward scale 1 — the scale-up on the hit
                // itself is the only motion, and it is small.
                const s = 1 + 0.06 * peak;
                node.style.transform = "translateY(0) scale(" + s.toFixed(3) + ")";
            }
        },
        clear() {
            count = 0;
            node.style.opacity = "0";
            node.style.transform = "translateY(6px) scale(0.95)";
        },
        dispose() { node.remove(); }
    };
}
