// Orthographic follow camera: fixed azimuth, deadzone and time-based smoothing.
// A perspective lens distorts the original paper-stack models at screen edges;
// retain the original orthographic projection while exposing a useful view range.
// The height setting scales both rig pitch and the frustum. main.js publishes
// that pitch to billboard views and moves fog with the rig; no logic coordinates,
// movement speed or hitboxes change when the player adjusts the camera.
// Both a supplied PerspectiveCamera and a native OrthographicCamera use the same
// resize path (aspect + updateProjectionMatrix), without a second THREE import.

import { accessibility } from "../accessibility.js";

export const VIEW_HALF_HEIGHT = 4.6;
// Keep a near-range threat beside the player readable on a portrait phone.
// Wider screens retain their exact lens; the user's height/zoom still scales
// both axes. Only extra vertical ground is revealed, never stretched.
export const VIEW_MIN_ASPECT = 1.25;

function makeOrthographic(camera, halfHeight) {
    camera.isPerspectiveCamera = false;
    camera.isOrthographicCamera = true;
    camera.zoom = 1;
    camera.view = null;
    camera.updateProjectionMatrix = function () {
        const aspect = camera.aspect || 1;
        const top = camera.viewHalfHeight * Math.max(1, VIEW_MIN_ASPECT / aspect);
        const bottom = -top;
        const right = top * aspect;
        const left = -right;
        camera.top = top; camera.bottom = bottom;
        camera.left = left; camera.right = right;
        const near = camera.near;
        const far = camera.far;
        // three.js OrthographicCamera.makeOrthographic, written out so this
        // file needs no THREE import (the page owns exactly one module
        // instance and this module deliberately doesn't hold it).
        const te = camera.projectionMatrix.elements;
        te[0] = 2 / (right - left); te[4] = 0; te[8] = 0;
        te[12] = -(right + left) / (right - left);
        te[1] = 0; te[5] = 2 / (top - bottom); te[9] = 0;
        te[13] = -(top + bottom) / (top - bottom);
        te[2] = 0; te[6] = 0; te[10] = -2 / (far - near);
        te[14] = -(far + near) / (far - near);
        // Bottom row is the perspective divide. Orthographic means w = 1, so
        // both depth terms are zeroed -- copying the perspective convention
        // here (te[11] = -1) makes the GPU divide every vertex by (1 - z_view)
        // ~ 12, shrinking the whole ortho frame to a speck. Measured, fixed.
        te[3] = 0; te[7] = 0; te[11] = 0; te[15] = 1;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    };
    camera.viewHalfHeight = halfHeight;
    camera.updateProjectionMatrix();
}

export function createFollowCamera(camera, options) {
    const cfg = options || {};
    const deadzone = cfg.deadzone !== undefined ? cfg.deadzone : 1.2;
    let height = Number.isFinite(cfg.height) ? Math.max(5.5, Math.min(13, cfg.height)) : 9;
    const back = cfg.back !== undefined ? cfg.back : 6.5;
    const lookAtY = cfg.lookAtY !== undefined ? cfg.lookAtY : 0.9;
    const stiffness = cfg.stiffness !== undefined ? cfg.stiffness : 6;
    const halfHeight = cfg.viewHeight !== undefined ? cfg.viewHeight : VIEW_HALF_HEIGHT;

    makeOrthographic(camera, halfHeight * height / 9);

    let fx = 0;
    let fy = 0;

    // Impact shake (screen shake on player hits / crits): magnitude in world
    // units, decaying with the remaining time. One stronger request never
    // gets overridden by a weaker concurrent one. 辅助设置的“减少受击震动”
    // 在这里短路：受击事件照常结算，只是不移动镜头。
    let shakeMag = 0;
    let shakeTime = 0;
    let lastShakeX = 0;
    let lastShakeZ = 0;

    function apply() {
        let ox = 0;
        let oz = 0;
        if (shakeTime > 0) {
            const k = Math.min(1, shakeTime * 4);
            ox = (Math.random() * 2 - 1) * shakeMag * k;
            oz = (Math.random() * 2 - 1) * shakeMag * k;
        }
        lastShakeX = ox;
        lastShakeZ = oz;
        // logic (x, y) -> three (x, z)
        camera.position.set(fx + ox, height, fy + back + oz);
        camera.lookAt(fx, lookAtY, fy);
    }

    return {
        snap: function (px, py) {
            fx = px;
            fy = py;
            apply();
        },
        shake: function (mag, duration) {
            if (accessibility.reducedShake) { return; }
            shakeMag = Math.max(shakeMag, mag);
            shakeTime = Math.max(shakeTime, duration);
        },
        // Diagnostic surface for regressions (posture-probe precedent): the
        // offsets applied by the most recent apply(), plus whether a shake
        // window is currently in flight.
        lastShake: function () {
            return { x: lastShakeX, z: lastShakeZ, active: shakeTime > 0 };
        },
        update: function (px, py, dt) {
            const dx = px - fx;
            const dy = py - fy;
            const dist = Math.hypot(dx, dy);
            if (dist > deadzone) {
                const want = dist - deadzone;          // pull focus to the edge
                const k = 1 - Math.exp(-stiffness * dt);
                fx += (dx / dist) * want * k;
                fy += (dy / dist) * want * k;
            }
            if (shakeTime > 0) {
                shakeTime -= dt;
                if (shakeTime <= 0) {
                    shakeTime = 0;
                    shakeMag = 0;
                }
            }
            apply();
        },
        // Raising an orthographic rig alone does not reveal more ground.
        // Scale its frustum with height while retaining the authored azimuth
        // and billboard pitch; the existing saved-height setting stays valid.
        setHeight: function (h) {
            if (!Number.isFinite(h)) { return; }
            height = Math.max(5.5, Math.min(13, h));
            camera.viewHalfHeight = halfHeight * height / 9;
            camera.updateProjectionMatrix();
            apply();
        },
        get height() { return height; },
        get viewHalfHeight() { return camera.viewHalfHeight; },
        // Camera-to-focus distance. scene.js's fog near/far are authored
        // against the default rig's 11.1 — a taller rig must push the fog
        // out with it, or the player fogs over.
        distance: function () {
            return Math.hypot(height, back);
        },
        // T22m billboard tilt: the angle the rig looks DOWN at the focus.
        // The character stacks tilt back by exactly this (view/tilt.js) so
        // they read straight-on like the observation room.
        pitch: function () {
            return Math.atan2(height - lookAtY, back);
        }
    };
}
