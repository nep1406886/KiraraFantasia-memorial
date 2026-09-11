// Draw-order ladder for the stage (T09, spec/02 §2).
//
// Every character is an unlit paper stack whose own quads are ordered by the
// authored MsbHandler order that core/loader.js writes onto each mesh's
// renderOrder (m_eRenderStage, then m_RenderOrder, then m_HieIndex, folded into
// one number). That number resolves a model against ITSELF and nothing else:
// two models in one room interleave by whatever absolute values they happen to
// carry, and the z-buffer then decides who wins.
//
// Correct depth is the wrong answer for one pair. The boss is a card several
// times the player's size, so whenever the player closes in from behind it, the
// z-buffer does its job and the player disappears entirely behind a wing —
// measured in .cache/rl_fight_check.py's boss shot, where the phoenix hid the
// player outright. In a dodge game the one thing that may never be hidden is
// the thing you are dodging with.
//
// So the ladder below reserves a band per role and shifts a model's whole
// authored order into its band, preserving the internal stack. Enemies keep
// depth testing (they occlude each other and the map correctly); the player
// alone draws with depthTest off, which is the deliberate trade: the player is
// never hidden by an enemy, at the cost of also never being hidden by a border
// prop — and the border ring stands where the player almost never does.
// Bullets are transparent, so they draw after the whole opaque pass regardless,
// which is the priority a danmaku game wants anyway.
export const LAYER = {
    prop: 0,            // merged kit cards and the ground (their natural 0)
    enemy: 100000,      // above every prop, still depth-tested
    player: 200000,     // above every enemy, depth test off
    danmaku: 300000,    // transparent pass; both sides' bullets
    vfx: 400000         // transparent pass; hit sparks and skill effects
};

// The character models are exported at half the size the map layer was
// authored for. Measured on the raw GLBs: players stand 0.7–1.1 units tall,
// mobs 0.4–1.0, bosses 1.0–1.5, the phoenix 2.8 — the original's own
// proportions relative to each other, kept faithfully by the exporter. But
// every map-side constant assumes a ~1.6-unit character (mapview.js PROP_SCALE:
// "the tallest tree is 1.1, against a ~1.6 unit character"; the view gate's
// own "has a prop ≥1.0 units tall" check exists so something stands as tall
// as a character), so unscaled the props tower 2–3× over the cast and the
// camera shows a speck. One uniform scale on the whole character layer —
// player and enemies together, so their authored ratios survive — lands the
// player at 1.4–2.2 units inside the band the map was built for. Logic-layer
// numbers (hitboxes, radii, rooms, doors) are untouched; a visible sprite
// wider than its hitbox is the danmaku convention, not a bug.
export const CHARACTER_SCALE = 2.0;

// One presentation plane for aiming, projectile cores, trails and hit sparks.
// World x/y remains ground-space; this height never changes collision radii.
export const COMBAT_HEIGHT = 1.0;

// Shift every mesh under `root` into `base`'s band, keeping the authored order
// as the offset inside it. `noDepthTest` is for the player only.
export function applyLayer(root, base, noDepthTest) {
    root.traverse(function (child) {
        if (!child.isMesh) { return; }
        // Idempotent: re-applying after a weapon mount must not stack bands.
        if (child.userData.rlAuthoredOrder === undefined) {
            child.userData.rlAuthoredOrder = child.renderOrder || 0;
        }
        child.renderOrder = base + child.userData.rlAuthoredOrder;
        if (!noDepthTest) { return; }
        const materials = Array.isArray(child.material)
            ? child.material : [child.material];
        materials.forEach(function (material) {
            if (material) { material.depthTest = false; }
        });
    });
}
