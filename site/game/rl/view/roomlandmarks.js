// Original town prefabs with explicit source affiliation. Instances, not
// mapview, own native materials. A missing or mismatched source record fails
// preparation rather than publishing the wrong work's building.
import { acquireNative, preloadNative } from "./nativeassets.js";
import { characterTiltX } from "./tilt.js";
import { ROOM_SIZE, roomSize } from "../dungeon.js";

// m_TitleType and m_ResourceID are copied from the original TownObjectListDB.
// A work building is selectable only when the room carries that exact title
// number. Volume is intentionally not a selector: an ecological volume is not
// evidence that an unrelated work belongs there.
const WORK_BUILDINGS = Object.freeze({
    0: "bld_110200_0",   // ひだまりスケッチ
    4: "bld_110500_0",   // きんいろモザイク
    7: "bld_110700_0",   // うらら迷路帖
    8: "bld_111800_0",   // キルミーベイベー
    11: "bld_112100_0",  // スロウスタート
    13: "bld_112300_0",  // ゆるキャン△
    20: "bld_113000_0",  // ご注文はうさぎですか？
    28: "bld_113800_0",  // 恋する小惑星
    33: "bld_114300_0",  // こはる日和。
    35: "bld_114700_0",  // スローループ
    36: "bld_114500_0"   // RPG不動産
});

export function roomBuildingKey(room) {
    if (!room) return null;
    if (room.workTitle !== undefined && room.workTitle !== null) {
        const title = room.workTitle;
        return Number.isInteger(title) && WORK_BUILDINGS[title] || null;
    }
    // These are system facilities, not work-specific landmarks.
    if (room.type === "start") return "bld_100000_0";
    if (room.type === "shop") return "bld_120400_0";
    if (room.type === "rest") return "bld_120100_0";
    return null;
}
export function preloadRoomBuildings() {
    return preloadNative("buildings", ["bld_100000_0", "bld_120400_0", "bld_120100_0"]);
}
export async function createRoomLandmark(THREE, room, volume) {
    const key = roomBuildingKey(room, volume);
    if (!key) return null;
    const instance = await acquireNative("buildings", key);
    try {
        const affiliation = instance.entry.affiliation;
        const title = room.workTitle === undefined || room.workTitle === null ? -1 : room.workTitle;
        if (!affiliation || affiliation.titleType !== title
            || title >= 0 && affiliation.category !== 6) {
            throw new Error("原作建筑归属不符：" + key);
        }
        const box = new THREE.Box3().setFromObject(instance.root);
        const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
        if (!(size.y > 0 && size.x > 0)) throw new Error("原作建筑没有有效尺寸：" + key);
        const height = room.type === "chest" ? 2.4 : room.type === "shop" ? 5.2 : 4.6;
        const roomBounds = roomSize(room), compact = roomBounds.w < ROOM_SIZE.w;
        const scale = Math.min(Math.min(height, roomBounds.h * .3) / size.y,
            Math.min(6, roomBounds.w * .27) / size.x);
        const pivot = new THREE.Group(); pivot.name = "native-building:" + key;
        const left = compact ? .23 : .32;
        const x = roomBounds.w * (room.seed & 1 ? left : 1 - left);
        const y = roomBounds.h * (compact ? .28 : .40);
        pivot.position.set(x, 0, y); pivot.rotation.x = characterTiltX();
        instance.root.scale.setScalar(scale);
        instance.root.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
        pivot.add(instance.root);
        const collider = { x, y, hw: size.x * scale * .4, hh: room.type === "chest" ? .45 : 1.05 };
        const placement = { name: key, x, y, flat: false, native: true,
            width: size.x * scale, height: size.y * scale, source: instance.entry.source.bundle,
            titleType: affiliation.titleType, originalName: affiliation.name };
        let disposed = false, lastTilt = null;
        function update() {
            const tilt = characterTiltX();
            if (tilt === lastTilt) return;
            pivot.rotation.x = tilt; pivot.position.y = 0;
            pivot.updateMatrixWorld(true);
            // Layered town sprites have real depth. Tilting around a flat
            // XY bound otherwise pushes the lower layers through the floor.
            // Re-ground precise vertices only when the view pitch changes.
            const tilted = new THREE.Box3().setFromObject(pivot, true);
            pivot.position.y = -tilted.min.y + .01;
            lastTilt = tilt;
        }
        update();
        return { root: pivot, collider, placement,
            update,
            dispose() { if (disposed) return; disposed = true; pivot.removeFromParent(); instance.dispose(); }
        };
    } catch (error) { instance.dispose(); throw error; }
}
