// Enemy codex thumbnails (T22f): enemies have no bust art — what the original
// ships is the model itself, so the 图鉴 entry's 立绘 is the model rendered
// once, orthographically from the front at Euler(0,0,0) exactly like the game
// frames every chara (never a perspective camera, never a Y rotation — these
// are 2.5D paper stacks). The result is a data URL the DOM can use as an img.
//
// One 144x160 offscreen renderer serves every thumbnail. Calls are queued one
// at a time: the codex can ask for dozens of models at once (Intersection
// Observer fan-in) and each load() is uncached by design, so a burst would
// stack N GLB parses and N scenes on the GPU for no benefit — a queue costs
// the user nothing visible (each frame lands as it is ready) and keeps the
// peak at one live model.

import * as loader from "../../../core/loader.js";

const THUMB_W = 144;
const THUMB_H = 160;

let ctx = null;        // { THREE, renderer, scene, camera }
let queue = [];
let busy = false;

function ensureContext(modules) {
    if (ctx) {
        return ctx;
    }
    const THREE = modules.THREE;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(THUMB_W, THUMB_H, false);
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    ctx = {
        THREE: THREE,
        renderer: renderer,
        scene: new THREE.Scene(),
        camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    };
    return ctx;
}

// Fit the camera to the model's bbox with a little headroom. Ortho frustum in
// world units; the aspect follows the bbox, letterboxed into the thumbnail.
function frame(c, box) {
    const size = new c.THREE.Vector3();
    box.getSize(size);
    const center = new c.THREE.Vector3();
    box.getCenter(center);
    const w = Math.max(size.x, 0.01);
    const h = Math.max(size.y, 0.01);
    const margin = 1.12;
    // world-units-per-pixel that fits the box, whichever axis binds
    const scale = Math.min(THUMB_W / w, THUMB_H / h) / margin;
    const halfW = THUMB_W / 2 / scale;
    const halfH = THUMB_H / 2 / scale;
    const camera = c.camera;
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.near = -50;
    camera.far = 50;
    camera.position.set(center.x, center.y, 10);
    camera.lookAt(center.x, center.y, 0);
    camera.updateProjectionMatrix();
}

function renderOne(job) {
    loader.load(job.model, { kind: "enemy" }).then(function (loaded) {
        return loader.loadModules().then(function (modules) {
            const c = ensureContext(modules);
            c.scene.add(loaded.scene);
            const box = new c.THREE.Box3().setFromObject(loaded.scene);
            if (!box.isEmpty()) {
                frame(c, box);
                c.renderer.render(c.scene, c.camera);
                job.resolve(c.renderer.domElement.toDataURL("image/png"));
            } else {
                job.resolve(null);
            }
            c.scene.remove(loaded.scene);
            loader.disposeObject(loaded.scene);
        });
    }).catch(function () {
        job.resolve(null);   // missing art never breaks the codex
    }).then(function () {
        busy = false;
        pump();
    });
}

function pump() {
    if (busy || !queue.length) {
        return;
    }
    busy = true;
    renderOne(queue.shift());
}

// renderEnemyThumb(modelUrl) → Promise<dataURL|null>, resolved in FIFO order.
export function renderEnemyThumb(model) {
    return new Promise(function (resolve) {
        queue.push({ model: model, resolve: resolve });
        pump();
    });
}
