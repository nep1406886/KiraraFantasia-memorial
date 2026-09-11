import assert from "node:assert/strict";
import { createFollowCamera, VIEW_HALF_HEIGHT } from "../site/game/rl/view/camera.js";

let checks = 0;
function test(name, fn) { fn(); checks++; console.log("PASS " + name); }
function near(a, b, eps = 1e-9) { assert.ok(Math.abs(a - b) < eps, a + " != " + b); }
// Only the projection coefficients and focus are under test. Real matrix
// inversion and ground pixels are covered by the serial browser checks.
function rig(width, height, options) {
    const camera = { aspect: width / height, near: .05, far: 100,
        projectionMatrix: { elements: new Array(16).fill(0) },
        projectionMatrixInverse: { copy() { return this; }, invert() { return this; } },
        position: { set(x, y, z) { Object.assign(this, { x, y, z }); } },
        lookAt(x, y, z) { this.focus = { x, y, z }; } };
    return { camera, follow: createFollowCamera(camera, options) };
}
test("宽屏默认取景和既有正交投影不变", () => {
    const { camera, follow } = rig(1280, 746.5); follow.snap(16, 12);
    assert.ok(camera.isOrthographicCamera && !camera.isPerspectiveCamera);
    near(camera.top, VIEW_HALF_HEIGHT); near(camera.right, VIEW_HALF_HEIGHT * 1280 / 746.5);
    near(camera.projectionMatrix.elements[15], 1); near(camera.projectionMatrix.elements[11], 0);
    near(camera.position.y, 9); near(camera.position.z, 18.5);
});
test("竖屏默认横向至少11.5世界单位，近身首领不会因窄屏被裁到画外", () => {
    for (const [width, height] of [[320, 760], [375, 720], [390, 750], [430, 840]]) {
        const { camera } = rig(width, height);
        near(camera.right, 5.75); near(camera.left, -5.75);
        assert.ok((3.2 + 1.2) / camera.right < .95);
    }
});
test("横竖屏只扩展视野，不拉伸像素比例", () => {
    for (const [width, height] of [[390, 750], [844, 336.5], [1024, 768], [1280, 746.5]]) {
        const { camera } = rig(width, height);
        near(width * camera.projectionMatrix.elements[0], height * camera.projectionMatrix.elements[5]);
        near(camera.right / camera.top, width / height);
    }
});
test("竖屏仍保留镜头高度缩放与边界，不把用户缩放锁死", () => {
    const { camera, follow } = rig(390, 750);
    follow.setHeight(5.5); const low = camera.right;
    follow.setHeight(13); near(camera.right / low, 13 / 5.5);
    follow.setHeight(100); near(follow.height, 13);
    follow.setHeight(-100); near(follow.height, 5.5);
});
test("旋转屏幕后重算投影，跟随仍为时间驱动且不改目标坐标", () => {
    const a = rig(390, 750), b = rig(1280, 746.5), target = Object.freeze({ x: 20, y: 14 });
    a.follow.snap(16, 12); b.follow.snap(16, 12);
    for (let i = 0; i < 120; i++) { a.follow.update(target.x, target.y, 1 / 60); }
    for (let i = 0; i < 288; i++) { b.follow.update(target.x, target.y, 1 / 144); }
    near(a.camera.position.x, b.camera.position.x); near(a.camera.position.z, b.camera.position.z);
    a.camera.aspect = 844 / 336.5; a.camera.updateProjectionMatrix();
    near(a.camera.top, 4.6); near(a.camera.right, 4.6 * 844 / 336.5);
});
console.log("Camera framing: " + checks + " checks passed");

