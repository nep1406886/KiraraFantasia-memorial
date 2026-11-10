// Bounded billboard batches: enemy rounds/streaks and soft player spell cores.
// The logic pool owns position, radius and spawnId. This view only reads them;
// each player shot keeps a contact core beneath its original effect trail.
import { LAYER, COMBAT_HEIGHT } from "./layers.js";

const LONG_PATTERNS = { aimed: true, volley: true };
const COLORS = {
    enemy: [1.00, 0.38, 0.52],
    player: [1.00, 0.93, 0.70]
};

function makeSprite(THREE, streak, soft = false) {
    const h = 128, w = streak ? 2 * h : h;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    const cx = w / 2, cy = h / 2, radius = h / 2;
    if (streak) {
        const tail = ctx.createLinearGradient(0, 0, cx, 0);
        tail.addColorStop(0, "rgba(255,255,255,0)");
        tail.addColorStop(1, "rgba(255,255,255,.65)");
        ctx.fillStyle = tail;
        ctx.fillRect(0, h * .35, cx, h * .3);
    }
    // Both textures put the circular core at the QUAD centre. The streak's
    // 2:1 aspect makes its core exactly as wide as it is tall, never an ellipse.
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    core.addColorStop(0.00, "rgba(255,255,255,1)");
    core.addColorStop(0.46, soft ? "rgba(255,255,255,.9)" : "rgba(255,255,255,1)");
    core.addColorStop(0.72, soft ? "rgba(255,255,255,.45)" : "rgba(163,163,163,1)");
    core.addColorStop(0.84, soft ? "rgba(255,255,255,.2)" : "rgba(41,41,41,1)");
    core.addColorStop(0.96, soft ? "rgba(255,255,255,.05)" : "rgba(26,26,26,1)");
    core.addColorStop(1.00, "rgba(255,255,255,0)");
    ctx.fillStyle = core;
    ctx.fillRect(cx - radius, 0, 2 * radius, h);
    const texture = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) { texture.colorSpace = THREE.SRGBColorSpace; }
    return texture;
}

export function createDanmakuView(scene, THREE, options) {
    const cfg = options || {}, capacity = cfg.capacity || 1024;
    const geometry = new THREE.PlaneGeometry(1, 1);
    function batch(name, streak, soft = false) {
        const material = new THREE.MeshBasicMaterial({
            map: makeSprite(THREE, streak, soft), transparent: true, alphaTest: .02,
            depthWrite: false, depthTest: !soft, fog: false, toneMapped: false
        });
        const mesh = new THREE.InstancedMesh(geometry, material, capacity);
        mesh.name = name; mesh.count = 0;
        mesh.userData.rlOverlay = true;
        mesh.renderOrder = LAYER.danmaku;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Allocate the instance colour attribute before the first render, so
        // a later empty -> populated transition needs no shader variant change.
        mesh.setColorAt(0, new THREE.Color());
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        scene.add(mesh);
        return mesh;
    }
    const discs = batch("danmaku", false), streaks = batch("danmaku-streaks", true);
    const spells = batch('player-spell-cores', true, true);
    const elements = [0xffb099,0xa3e1ff,0xffdc9b,0xb2ecca,0xd8bbff,0xffe9b8].map(hex=>new THREE.Color(hex));
    const dummy = new THREE.Object3D(), tint = new THREE.Color();
    const qz = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1);
    let disposed = false;

    return {
        object: discs,
        get count() { return discs.count; },
        get streakCount() { return streaks.count + spells.count; },
        sync: function (danmaku, position) {
            if (disposed) { return; }
            const cam = cfg.camera;
            if (cam) { cam.updateMatrixWorld(); }
            const basis = cam && cam.matrixWorld.elements;
            let n = 0, s = 0, p = 0;
            danmaku.forEach(function (bullet) {
                if (bullet.delay > 0 || n + s + p >= capacity) { return; }
                // Keep a precise contact core even while native art loads or is
                // culled by its bounded pool. Native art supplies the outer trail.
                const at = position ? position(bullet) : bullet;
                const radius = Number.isFinite(bullet.radius) && bullet.radius >= 0
                    ? bullet.radius : (cfg.size || .36) / 2;
                const long = !!((bullet.side === 'player' || LONG_PATTERNS[bullet.pattern]) && cam);
                dummy.position.set(at.x, COMBAT_HEIGHT, at.y);
                if (cam) { dummy.quaternion.copy(cam.quaternion); }
                else { dummy.quaternion.identity(); }
                if (long) {
                    const sx = bullet.vx * basis[0] + bullet.vy * basis[2];
                    const sy = bullet.vx * basis[4] + bullet.vy * basis[6];
                    qz.setFromAxisAngle(zAxis, Math.atan2(sy, sx));
                    dummy.quaternion.multiply(qz);
                }
                dummy.scale.set((long ? 4 : 2) * radius, 2 * radius, 1);
                dummy.updateMatrix();
                const player = bullet.side === 'player';
                const mesh = player ? spells : long ? streaks : discs, i = player ? p++ : long ? s++ : n++;
                const c = COLORS[bullet.side] || COLORS.enemy;
                mesh.setMatrixAt(i, dummy.matrix);
                mesh.setColorAt(i, player ? elements[bullet.element] || elements[5] : tint.setRGB(c[0], c[1], c[2]));
            });
            discs.count = n; streaks.count = s; spells.count = p;
            for (const mesh of [discs, streaks, spells]) {
                mesh.instanceMatrix.needsUpdate = true;
                mesh.instanceColor.needsUpdate = true;
            }
        },
        dispose: function () {
            if (disposed) { return; } disposed = true;
            for (const mesh of [discs, streaks, spells]) {
                scene.remove(mesh);
                mesh.dispose();
                mesh.material.map.dispose();
                mesh.material.dispose();
            }
            geometry.dispose();
        }
    };
}
