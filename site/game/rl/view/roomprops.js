// Original room furniture: native instances own materials and timelines.
// Placement stays view-only and must not add unreported world colliders.
import { acquireNative } from './nativeassets.js';
import { createPlayer as createTimelinePlayer } from '../../../core/uniqueskill.js';
import { characterTiltX } from './tilt.js';
import { applyLayer, LAYER } from './layers.js';

export async function createRoomProp(THREE, key, options = {}) {
    const instance = await acquireNative('furniture', key);
    try {
        const source = instance.entry.affiliation;
        if (!source || source.category !== 5 || source.titleType !== -1) {
            throw new Error('房间物件来源不符：' + key);
        }
        const root = new THREE.Group(); root.name = 'room-prop:' + key;
        const box = new THREE.Box3().setFromObject(instance.root, true);
        const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
        if (!(size.y > 0 && size.x > 0)) throw new Error('房间物件尺寸无效：' + key);
        const scale = Math.min((options.height || 1.4) / size.y, (options.maxWidth || 2) / size.x);
        instance.root.scale.setScalar(scale);
        instance.root.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
        root.add(instance.root);
        root.position.set(options.x || 0, 0, options.y || 0);
        applyLayer(instance.root, LAYER.enemy, false);
        const timeline = instance.timeline && createTimelinePlayer({ THREE, root: instance.root,
            timeline: instance.timeline, camera: null, audio: null });
        if (timeline) timeline.restart();
        let time = 0, lastTilt = null, disposed = false;
        function update(dt) {
            if (disposed) return;
            time += Math.max(0, dt || 0);
            if (timeline && instance.timeline.duration > 0) {
                timeline.seek((time % instance.timeline.duration) * instance.timeline.fps);
            }
            const tilt = characterTiltX();
            if (tilt !== lastTilt) {
                root.rotation.x = tilt; root.position.y = 0; root.updateMatrixWorld(true);
                root.position.y = -new THREE.Box3().setFromObject(root, true).min.y + .012;
                lastTilt = tilt;
            }
        }
        update(0);
        return { root, entry: instance.entry, update,
            dispose() { if (disposed) return; disposed = true; root.removeFromParent(); instance.dispose(); } };
    } catch (error) { instance.dispose(); throw error; }
}

// Prepare off-scene. A partial failure releases every successful instance;
// callers can keep the old room until the whole arrangement is ready.
export async function createPropArrangement(THREE, specs) {
    const results = await Promise.allSettled(specs.map(spec => createRoomProp(THREE, spec.key, spec)));
    const props = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) { props.forEach(prop => prop.dispose()); throw failed.reason; }
    const root = new THREE.Group(); props.forEach(prop => root.add(prop.root));
    let disposed = false;
    return { root, props, update(dt) { if (!disposed) props.forEach(prop => prop.update(dt)); },
        dispose() { if (disposed) return; disposed = true; root.removeFromParent(); props.forEach(prop => prop.dispose()); } };
}
