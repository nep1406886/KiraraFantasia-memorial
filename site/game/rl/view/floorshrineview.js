// Native cathedral statue and lanterns. This map candidate owns every instance;
// readiness/proximity are presentation inputs, never a second progression state.
import { floorShrineFor } from '../floorshrine.js';
import { createPropArrangement } from './roomprops.js';
import { createBlobShadow } from './blobshadow.js';
import { preloadNative } from './nativeassets.js';

export function preloadFloorShrine() {
    return preloadNative('furniture', ['goods_1147', 'goods_1072']);
}

export async function createFloorShrineView(THREE, room) {
    const shrine = floorShrineFor(room);
    if (!shrine) return null;
    const arrangement = await createPropArrangement(THREE, [
        { key: shrine.key, x: shrine.x, y: shrine.y, height: 3.1, maxWidth: 2.25 },
        { key: 'goods_1072', x: shrine.x - 1.22, y: shrine.y + .18, height: .72, maxWidth: .58 },
        { key: 'goods_1072', x: shrine.x + 1.22, y: shrine.y + .18, height: .72, maxWidth: .58 }
    ]);
    const object = arrangement.root; object.name = 'floor-shrine';
    const shadow = createBlobShadow(THREE, object, .86); shadow.sync(shrine.x, shrine.y, 0);
    const colors = [];
    arrangement.props.forEach((prop, index) => prop.root.traverse(child => {
        if (!child.isMesh) return;
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
            if (material?.color && !colors.some(row => row.material === material)) {
                colors.push({ material, color: material.color.clone(), lantern: index > 0 });
            }
        }
    }));
    const anchor = new THREE.Vector3(), labelBox = new THREE.Box3();
    let labelTilt = null;
    let active = false, nearby = false, glow = 0, elapsed = 0, disposed = false;
    function update(dt) {
        if (disposed) return;
        const delta = Math.max(0, dt || 0);
        elapsed += delta;
        glow += ((active ? 1 : 0) - glow) * (1 - Math.exp(-delta * 6));
        arrangement.update(delta);
        const statue = arrangement.props[0].root;
        if (labelTilt !== statue.rotation.x) {
            labelBox.setFromObject(statue, true);
            anchor.set(shrine.x, labelBox.max.y + .28, labelBox.min.z);
            labelTilt = statue.rotation.x;
        }
        for (const row of colors) {
            const brightness = row.lantern ? .5 + glow * (.68 + Math.sin(elapsed * 2) * .045)
                : .76 + glow * .24;
            row.material.color.copy(row.color).multiplyScalar(brightness);
        }
        object.userData.ritualState = active ? (nearby ? 'nearby' : 'awake') : 'dormant';
        object.userData.glow = glow;
    }
    update(0);
    return { room, shrine, object, anchor,
        placement: { name: shrine.key, x: shrine.x, y: shrine.y, native: true,
            role: 'floor-shrine', source: arrangement.props[0].entry.source.bundle },
        setState(awake, near) { active = !!awake; nearby = !!near; },
        update,
        dispose() { if (disposed) return; disposed = true; shadow.dispose(); arrangement.dispose(); }
    };
}
