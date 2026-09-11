// Stage scene + per-volume environment (T09, spec/01 §5, spec/02 §4).
//
// The art tokens are fixed by spec/01 §5:
//   * constant warm key light #fff4e0 at 1.0 — night volumes swap it to
//     moonlight #c9d4f0 but keep the ambient bright (原作夜景也是亮的:
//     only -20%)
//   * ambient is the sky color (mint #c9e6e4 day-side), shadows bounce cold
//     purple instead of going black
//   * every layer carries thin fog in the layer's ambient tint so room edges
//     melt into the background — the original map look, not optional
//
// Characters and map cards are unlit (MeshBasicMaterial), so the lights only
// matter to anything lit added later (blob shadows, effects); the fog and
// background apply to everything and are what the eye actually reads.

// Fog near/far tuned for ROOM_SIZE 16×12 under the follow camera's default
// rig (height 9, back 6.5): the room stays clear, its overhang and the
// border ring fade into the tint. T22b's camera-height slider moves the rig,
// so the fog rides along through a stored shift (setFogShift).
import { installModelRenderOrder } from "../../../core/model-render-order.js?v=20260908-1";
import { renderStage } from "./stagerender.js";

export const FOG_NEAR = 13;
export const FOG_FAR = 27;

export function createStageScene(THREE, renderer, options) {
    const scene = new THREE.Scene();
    const playerCamera = new THREE.Camera();
    // applyLayer saves the authored key before adding a player/enemy band.
    // Share the viewer's alpha-queue fix without decoding that band as a layer
    // or changing the game's material, mirror and depth-test rules.
    // frameStamp lets the compositor reuse per-pass CPU skinning (see
    // core/model-render-order.js): the game bumps it once per rendered frame.
    const disposeRenderOrder = renderer ? installModelRenderOrder(renderer, scene, THREE, {
        getAuthoredOrder: mesh => mesh.userData.rlAuthoredOrder,
        frameStamp: options && options.frameStamp
    }) : () => {};

    // sky mint above, cold purple bounce below (暗部补偿冷紫而不是压黑)
    const hemisphere = new THREE.HemisphereLight(0xc9e6e4, 0x6a5a8a, 2.1);
    const key = new THREE.DirectionalLight(0xfff4e0, 1.0);
    key.position.set(1.4, 2.6, 2.2);
    scene.add(hemisphere);
    scene.add(key);

    let fogShift = 0;

    return {
        scene: scene,
        dispose: disposeRenderOrder,
        render: function (camera, playerRoot) { renderStage(renderer, scene, camera, playerRoot, playerCamera); },
        get hemisphere() { return hemisphere; },
        get keyLight() { return key; },

        // cfg: { fog: "#rrggbb", night: bool } from asset/rl/floors.json
        applyVolume: function (cfg) {
            const fogColor = new THREE.Color((cfg && cfg.fog) || "#c9e6e4");
            scene.fog = new THREE.Fog(fogColor, FOG_NEAR + fogShift,
                                      FOG_FAR + fogShift);
            scene.background = fogColor;
            if (cfg && cfg.night) {
                key.color.set("#c9d4f0");
                hemisphere.intensity = 2.1 * 0.8;
            } else {
                key.color.set("#fff4e0");
                hemisphere.intensity = 2.1;
            }
            hemisphere.color.copy(fogColor);
        },

        // T22b: keep the fog band glued to the rig. delta is the new
        // camera-to-focus distance minus the default rig's; before the first
        // applyVolume there is no fog to retune, the stored shift lands then.
        setFogShift: function (delta) {
            fogShift = delta;
            if (scene.fog) {
                scene.fog.near = FOG_NEAR + fogShift;
                scene.fog.far = FOG_FAR + fogShift;
            }
        }
    };
}
