// B.5 死亡地面残留: a short-lived dark disc where an enemy died. The corpse
// already sinks and fades (enemyview) and the coin receipt flies separately —
// the stain is the third beat of "it died HERE": after both the body and the
// burst are gone, the floor keeps the mark for another half-second, so a room
// cleared in a corner reads as a fight that happened there.
//
// Same drawing convention as the blob shadow and the elite aura (unlit squashed
// disc, depthWrite off) — a stain is a shadow that outlives its owner, so it
// uses the same colour and squash, just no fade-with-lift.
import { LAYER } from "./layers.js";

const STAIN_Y = 0.008;         // above the arena disc (-0.01), under the aura (0.03)
const STAIN_ALPHA = 0.20;      // same wash as a contact shadow
const STAIN_LIFE = 1.2;        // seconds; plan B.5
const SQUASH = 0.46;           // blobshadow.js SQUASH — the same ellipse
const MAX_STAINS = 24;         // a full room's kills at once; oldest retires first

export function createDeathStains(THREE, scene) {
    const group = new THREE.Group();
    group.name = "death-stains";
    scene.add(group);
    const stains = [];
    let geometry = null;
    let material = null;

    function ensureShared() {
        if (!geometry) {
            geometry = new THREE.CircleGeometry(1, 16);
            geometry.deleteAttribute("normal");
            geometry.rotateX(-Math.PI / 2);
        }
        if (!material) {
            material = new THREE.MeshBasicMaterial({
                color: 0x000000, transparent: true, opacity: STAIN_ALPHA,
                depthWrite: false, fog: false
            });
        }
    }

    return {
        object: group,
        spawn: function (x, z, radius) {
            ensureShared();
            if (stains.length >= MAX_STAINS) {
                const oldest = stains.shift();
                group.remove(oldest.mesh);
            }
            const mesh = new THREE.Mesh(geometry, material);
            const r = Math.max(0.22, (radius || 0.45) * 1.1);
            mesh.scale.set(r, 1, r * SQUASH);
            mesh.position.set(x, STAIN_Y, z);
            mesh.renderOrder = LAYER.prop + 1;   // over the ground, under every prop
            group.add(mesh);
            stains.push({ mesh: mesh, age: 0 });
        },
        update: function (dt) {
            const step = Number.isFinite(dt) ? dt : 0;
            for (let i = stains.length - 1; i >= 0; i--) {
                const stain = stains[i];
                stain.age += step;
                const t = stain.age / STAIN_LIFE;
                if (t >= 1) {
                    group.remove(stain.mesh);
                    stains.splice(i, 1);
                    continue;
                }
                // One material instance is shared: per-stain fade rides the
                // mesh's own onBeforeRender-free path — opacity is shared, so
                // instead the stain scales down into the ground. A shrinking
                // dark patch reads as drying; a global opacity tween would tie
                // every stain to the youngest's clock.
                const shrink = 1 - t * t;
                stain.mesh.userData.baseR = stain.mesh.userData.baseR || stain.mesh.scale.x;
                stain.mesh.scale.x = stain.mesh.userData.baseR * shrink;
                stain.mesh.scale.z = stain.mesh.userData.baseR * SQUASH * shrink;
            }
        },
        clear: function () {
            stains.forEach(function (stain) { group.remove(stain.mesh); });
            stains.length = 0;
        },
        dispose: function () {
            this.clear();
            group.removeFromParent();
            if (geometry) { geometry.dispose(); }
            if (material) { material.dispose(); }
        },
        get count() { return stains.length; }
    };
}
