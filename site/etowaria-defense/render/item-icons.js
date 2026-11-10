// Captures the actual scene objects, not a hand-drawn icon approximation.
import { Facility, Scarecrow } from "./battle-view.js";
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
    const desk = stage.props.find(prop => prop.name === "desk");
    const lantern = stage.props.find(prop => prop.name === "lantern");
    const view = { stage, desk, book, lantern };
    const facility = new Facility(view), reserve = new Facility(view, "F11"), scarecrow = new Scarecrow(view);
    const bottle = await stage.items.bottle(.8);
    try {
        await scarecrow.load(view);
        const fire = await elementalBottle(stage, bottle.group, "Fire");
        const water = await elementalBottle(stage, bottle.group, "Water");
        return { F01: capture(stage, facility.group), F11: capture(stage, reserve.group),
            F13: capture(stage, scarecrow.group), F10: fire, F12: water,
            sources: { F01: ["prefab/room/desk/desk_1001.muast", "prefab/room/goods/goods_1083.muast"],
                F11: ["prefab/room/desk/desk_1001.muast", "prefab/room/goods/goods_1072.muast"],
                F13: ["model/enemy/model_en_5200.muast"],
                F10: ["model/weapon/wpn_1400.muast", "ElementIconFire.png"],
                F12: ["model/weapon/wpn_1400.muast", "ElementIconWater.png"] } };
    } finally { facility.dispose(); reserve.dispose(); scarecrow.dispose(); stage.items.release(bottle); }
}

async function elementalBottle(stage, object, element) {
    const art = new Image(), badge = new Image();
    art.src = capture(stage, object);
    badge.src = new URL(`../assets/ui/ElementIcon${element}.png`, import.meta.url).href;
    await Promise.all([art.decode(), badge.decode()]);
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(art, 0, 0); ctx.drawImage(badge, 156, 152, 88, 88);
    return canvas.toDataURL("image/png");
}
