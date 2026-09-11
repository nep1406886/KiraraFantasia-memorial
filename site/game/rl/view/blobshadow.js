// Character contact shadow (T09, spec/02 §2).
//
// Characters are unlit 2.5D paper stacks and the ground is a synthesized plane,
// so nothing in the pipeline puts anything under a character's feet: on screen
// the props (which mapview gives merged shadow discs) stand on the floor while
// the player and the enemies float above it. One squashed dark ellipse per
// character fixes the contact, and it is the same ellipse mapview draws under a
// prop — same colour, same squash, same alpha — so the two read as one lighting
// convention rather than two.
//
// It also carries information the paper stack cannot: the disc shrinks and
// fades as a character leaves the ground, which is the only cue that a dodge
// hop is airborne or that a dead unit is sinking.
//
// The disc is a scene-level object, never a child of the character: the
// character's own object carries the billboard mirror (scale.x = -1) and the
// run lean (rotation.z), and a shadow inheriting those would mirror and tip
// with them. It costs one draw call per character (≈7 in the worst room),
// which the ≤120 budget in tools/rl_view_harness.mjs absorbs.

// Just above every ground layer in mapview (surround -0.03, floor -0.02, arena
// disc -0.01): the boss fight happens on the arena disc, and a shadow under it
// is a shadow that is not there.
const SHADOW_Y = 0.006;
// Squashed because the camera is pitched 54°: a circle on the ground already
// projects as an ellipse, and flattening it further is what reads as a shadow
// instead of a coaster (mapview's SHADOW_SQUASH, same reason).
const SQUASH = 0.46;
const ALPHA = 0.22;
// The logic radius is the hitbox, which world.js took from the original's own
// shadow size, so the disc is that radius with a little spill.
const RADIUS_MULT = 1.15;
// A character this far off the ground has no contact left to draw.
const LIFT_FADE = 1.2;

let geometry = null;

function disc(THREE) {
    if (!geometry) {
        geometry = new THREE.CircleGeometry(1, 20);
        geometry.deleteAttribute("normal");
        geometry.rotateX(-Math.PI / 2);
    }
    return geometry;
}

// scene: the stage scene; radius: the unit's logic radius in world units.
export function createBlobShadow(THREE, scene, radius) {
    const material = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: ALPHA,
        depthWrite: false,      // never occlude what stands behind it
        fog: false              // a 0.22 black wash the fog would only mute
    });
    const mesh = new THREE.Mesh(disc(THREE), material);
    mesh.name = "charshadow";
    mesh.renderOrder = -1;      // with mapview's prop shadows, before everything
    const base = Math.max(0.18, (radius || 0.45) * RADIUS_MULT);
    mesh.scale.set(base, 1, base * SQUASH);
    mesh.position.y = SHADOW_Y;
    scene.add(mesh);

    return {
        object: mesh,

        // x/z: the unit's world position (the logic layer's x/y).
        // lift: how far the character is off the ground, if the view knows.
        // visible: false while the unit has no business casting one.
        sync: function (x, z, lift, visible) {
            if (visible === false) {
                mesh.visible = false;
                return;
            }
            mesh.visible = true;
            mesh.position.x = x;
            mesh.position.z = z;
            const off = Math.min(1, Math.max(0, (lift || 0) / LIFT_FADE));
            const shrink = 1 - off * 0.45;
            mesh.scale.set(base * shrink, 1, base * shrink * SQUASH);
            material.opacity = ALPHA * (1 - off);
        },

        dispose: function () {
            scene.remove(mesh);
            material.dispose();
        }
    };
}
