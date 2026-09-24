// Captures the actual scene objects, not a hand-drawn icon approximation.
import { Facility } from "./battle-view.js";
import { posedBounds } from "./native-model.js";

function capture(stage, object, size = 256) {
    const THREE = stage.THREE;
    const scene = new THREE.Scene();
    const copy = object.clone(true); copy.position.set(0, 0, 0); copy.visible = true;
    scene.add(copy);
    const box = posedBounds(THREE, copy);
    const center = box.getCenter(new THREE.Vector3());
    const extent = box.getSize(new THREE.Vector3());
    const half = Math.max(extent.x, extent.y) * .62;
    const camera = new THREE.OrthographicCamera(-half, half, half, -half, .01, 30);
    camera.position.set(center.x, center.y, center.z + 10); camera.lookAt(center);
    const renderer = stage.renderer;
    const old = { target: renderer.getRenderTarget(), color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
        viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()), test: renderer.getScissorTest() };
    const target = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    try {
        renderer.setRenderTarget(target); renderer.setScissorTest(false); renderer.setViewport(0, 0, size, size);
        renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
        const pixels = new Uint8Array(size * size * 4); renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d"); const image = ctx.createImageData(size, size);
        for (let y = 0; y < size; y++) { image.data.set(pixels.subarray((size - y - 1) * size * 4, (size - y) * size * 4), y * size * 4); }
        ctx.putImageData(image, 0, 0);
        return canvas.toDataURL("image/png");
    } finally {
        renderer.setRenderTarget(old.target); renderer.setViewport(old.viewport); renderer.setScissor(old.scissor);
        renderer.setScissorTest(old.test); renderer.setClearColor(old.color, old.alpha); target.dispose(); stage.render();
    }
}

export async function captureDeploymentIcons(stage) {
    await stage.items.prepare();
    const book = stage.props.find(prop => prop.name === "producer-book")
        || await stage.loadProp(stage.assets.native.furniture.goods_1083, "producer-book", .32);
    book.group.visible = false;
    const desk = stage.props.find(prop => prop.name === "desk");
    const facility = new Facility({ stage, desk, book });
    const bottle = stage.items.bottle(.8);
    try {
        return { F01: capture(stage, facility.group), F10: capture(stage, bottle.group),
            sources: { F01: ["prefab/room/desk/desk_1001.muast", "prefab/room/goods/goods_1083.muast"],
                F10: ["model/weapon/wpn_1400.muast"] } };
    } finally { facility.dispose(); stage.items.release(bottle); }
}
