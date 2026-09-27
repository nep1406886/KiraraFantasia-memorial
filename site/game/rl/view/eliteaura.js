// Elite aura ring (B.2): the ground ring that marks an elite from three rooms
// away. The HP bar already carries a purple gradient and a 「◆ 精英」 badge, but
// the bar only shows once damage lands — the aura is the tell that survives
// first contact, the way a crown does in Vampire Survivors.
//
// Geometry is a flat annulus under the enemy's feet, on the same Y stack as the
// telegraphs (enemytelegraphs.js GROUND_Y = .035) so the two ground decals never
// z-fight; the aura sits slightly BELOW it (0.03) — a threat warning always
// paints over the standing identity ring, which is the reading order a player
// under fire needs. Both share the blob-shadow convention (squashed, unlit,
// depthWrite off), so the ring reads as light on the ground, not as a plate.
//
// The colour is the elite's own element (0=炎..5=陽, elements.js ring) at low
// opacity — the ring says WHAT it is, the pulse says it is ALIVE. The pulse is
// a slow sinusoid on opacity only (never brightness), so reduced-flash users
// see a gentle breathing ring, not a strobe.
import { LAYER } from "./layers.js";

// Same convention as enemytelegraphs.js WARNING→ACTIVE and the codex element
// badges (theme.css .codex-el.el-*): the data ring order, not a re-derivation.
const ELEMENT_COLOR = [0xd2553f, 0x3f7fd2, 0xa08040, 0x4fa060, 0x8a6fd2, 0xd2a83f];
const RING_Y = 0.03;
const BASE_OPACITY = 0.30;
const PULSE_AMPLITUDE = 0.12;
const PULSE_SECONDS = 2.4;
// Per-instance pulse shaping, mutated by setPhase (B.3).
let pulseSeconds = PULSE_SECONDS;
let pulseAmplitude = PULSE_AMPLITUDE;
let spinRate = 0;
// Bosses get a second outer ring: an elite is "stronger", a boss is "the room".
const BOSS_OUTER = 1.22;
const BOSS_OUTER_OPACITY = 0.55;

function ringGeometry(THREE, inner, outer) {
    return new THREE.RingGeometry(inner, outer, 48);
}

export function createEliteAura(THREE, scene, radius, element, kind) {
    const color = ELEMENT_COLOR[element] || ELEMENT_COLOR[0];
    // Module-level pulse shaping is shared: reset per instance so a disposed
    // phase-3 aura does not leak its fast pulse into the next elite's ring.
    pulseSeconds = PULSE_SECONDS;
    pulseAmplitude = PULSE_AMPLITUDE;
    spinRate = 0;
    const material = new THREE.MeshBasicMaterial({
        color: color, transparent: true, opacity: BASE_OPACITY,
        side: THREE.DoubleSide, depthWrite: false, fog: false, toneMapped: false
    });
    const root = new THREE.Group();
    root.name = "elite-aura";
    const inner = new THREE.Mesh(ringGeometry(THREE, radius * 0.72, radius * 0.92), material);
    inner.rotation.x = -Math.PI / 2;
    inner.renderOrder = LAYER.enemy - 12;
    root.add(inner);
    let outer = null;
    if (kind === "boss") {
        outer = new THREE.Mesh(
            ringGeometry(THREE, radius * 0.98, radius * BOSS_OUTER), material);
        outer.rotation.x = -Math.PI / 2;
        outer.renderOrder = LAYER.enemy - 12;
        // The outer ring runs on a cloned material: the pulse phases differ, so
        // a shared material would bind the two rings to one clock.
        outer.material = material.clone();
        outer.material.opacity = BASE_OPACITY * BOSS_OUTER_OPACITY;
        root.add(outer);
    }
    scene.add(root);

    return {
        object: root,
        material: material,
        get color() { return material.color.getHex(); },
        // B.3 阶段化: each phase escalates the ring instead of recolouring it
        // — phase 2 breathes faster and 25% stronger, phase 3 adds a slow spin
        // to the outer ring, phase 3+ inner edge tightens. The element colour
        // IS the boss's identity; changing it per phase would change WHO the
        // ring says is standing there.
        setPhase: function (phase) {
            const p = Math.max(1, phase | 0);
            root.userData.phase = p;
            pulseSeconds = PULSE_SECONDS / (1 + (p - 1) * 0.35);
            pulseAmplitude = PULSE_AMPLITUDE * (1 + (p - 1) * 0.25);
            if (outer) { spinRate = (p >= 3 ? 0.5 : 0) * Math.PI / 4; }
        },
        sync: function (x, z, timeSec, alive, fade) {
            if (!alive && !(fade > 0)) {
                root.visible = false;
                return;
            }
            root.visible = true;
            root.position.set(x, RING_Y, z);
            const t = Number.isFinite(timeSec) ? timeSec : 0;
            const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 / pulseSeconds);
            // fade > 0: the death fade (enemyview drives 1→0 over the corpse
            // animation). Scales the whole ring toward zero with the body so
            // a dying boss's aura dies with it instead of blinking out.
            const f = alive ? 1 : Math.max(0, fade || 0);
            material.opacity = (BASE_OPACITY + pulseAmplitude * pulse) * f;
            if (outer) {
                outer.material.opacity =
                    (BASE_OPACITY * BOSS_OUTER_OPACITY) * (0.8 + 0.4 * pulse) * f;
                if (spinRate) { outer.rotation.z = t * spinRate; }
            }
        },
        dispose: function () {
            root.removeFromParent();
            inner.geometry.dispose();
            if (outer) { outer.geometry.dispose(); outer.material.dispose(); }
            material.dispose();
        }
    };
}
