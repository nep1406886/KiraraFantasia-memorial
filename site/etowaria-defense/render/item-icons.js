// Captures the actual scene objects, not a hand-drawn icon approximation.
import { Facility } from "./battle-view.js";
import { posedBounds } from "./native-model.js";
import { withCaptureTarget } from "./capture.js";

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
    try {
        return withCaptureTarget(THREE, stage.renderer, size, size, () => stage.renderer.render(scene, camera));
    } finally {
        stage.render();
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
