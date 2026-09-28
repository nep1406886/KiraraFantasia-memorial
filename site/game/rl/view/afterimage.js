// C.3b 闪避残影 (plan Tier 1-J): the dodge afterimage. A dodge is the one
// input whose SUCCESS is invisible — the player moved, nothing changed on the
// screen. Six decaying ghost frames along the dodge path turn the read into
// "I went THROUGH there".
//
// Implementation is a paper-stack trick that fits the art: the characters are
// unlit textured quads, so an "afterimage" is just the same quads drawn again
// with falling opacity — no skinning snapshot, no pose capture. We clone the
// player's static silhouette ONCE at dodge time (the pose at dodge start), and
// park copies along the recorded path points, fading them out over
// AFTERIMAGE_LIFE. The clone shares geometry and material base with the live
// model; opacity rides per-clone cloned materials (the stack is small).
import { LAYER } from "./layers.js";

const AFTERIMAGE_LIFE = 0.32;   // seconds per ghost
const AFTERIMAGE_COUNT = 6;     // ghosts per dodge
const AFTERIMAGE_ALPHA = 0.30;  // first ghost's opacity; falls per ghost
const GHOST_ORDER = LAYER.player - 5;  // just under the player band

export function createAfterimage(THREE, scene) {
    const ghosts = [];

    // Clone the player's visual stack into a fading ghost at a recorded point.
    function spawnGhost(source, x, y, facing, scale, mirror, index) {
        const root = source.clone(true);
        root.traverse(function (child) {
            if (!child.isMesh) { return; }
            child.userData.sharedGeometry = true;   // room cleanup must not dispose these
            const materials = Array.isArray(child.material)
                ? child.material : [child.material];
            const cloned = materials.map(function (material) {
                const copy = material.clone();
                copy.transparent = true;
                copy.depthWrite = false;
                copy.opacity = AFTERIMAGE_ALPHA * (1 - index / AFTERIMAGE_COUNT);
                return copy;
            });
            child.material = Array.isArray(child.material) ? cloned : cloned[0];
            child.renderOrder = GHOST_ORDER - index;
        });
        // Billboard mirror + scale ride the same axes the live view writes.
        root.scale.set((mirror ? -1 : 1) * scale, scale, scale);
        root.position.set(x, 0, y);
        root.rotation.y = 0;   // paper stacks never rotate around Y
        scene.add(root);
        ghosts.push({ root: root, age: 0, alpha0: AFTERIMAGE_ALPHA * (1 - index / AFTERIMAGE_COUNT) });
    }

    return {
        // The dodge started: record the six path points the world will sweep.
        // `pathAt(t)` maps t∈[0,1] → {x, y} along the dodge (the caller reads
        // the world's own dodge state, so the ghosts land where the logic
        // moved, not where the render was).
        spawn: function (source, pathAt, facing, scale, mirror) {
            for (let i = 0; i < AFTERIMAGE_COUNT; i++) {
                const at = pathAt((i + 1) / (AFTERIMAGE_COUNT + 1));
                if (!at) { continue; }
                spawnGhost(source, at.x, at.y, facing, scale, mirror, i);
            }
        },
        update: function (dt) {
            const step = Number.isFinite(dt) ? dt : 0;
            for (let i = ghosts.length - 1; i >= 0; i--) {
                const ghost = ghosts[i];
                ghost.age += step;
                const t = ghost.age / AFTERIMAGE_LIFE;
                if (t >= 1) {
                    scene.remove(ghost.root);
                    ghost.root.traverse(function (child) {
                        if (!child.isMesh) { return; }
                        const materials = Array.isArray(child.material)
                            ? child.material : [child.material];
                        materials.forEach(function (material) { material.dispose(); });
                    });
                    ghosts.splice(i, 1);
                    continue;
                }
                ghost.root.traverse(function (child) {
                    if (!child.isMesh) { return; }
                    const materials = Array.isArray(child.material)
                        ? child.material : [child.material];
                    materials.forEach(function (material) {
                        material.opacity = ghost.alpha0 * (1 - t * t);
                    });
                });
            }
        },
        clear: function () {
            const live = ghosts.slice();
            ghosts.length = 0;
            live.forEach(function (ghost) { scene.remove(ghost.root); });
        },
        get count() { return ghosts.length; },
        dispose: function () { this.clear(); }
    };
}
