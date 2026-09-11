// The map candidate owns these original room objects and their live timelines.
import { restCampFor } from '../restcamp.js';
import { createPropArrangement } from './roomprops.js';
import { createBlobShadow } from './blobshadow.js';

export async function createRestCampView(THREE, room) {
    const camp = restCampFor(room);
    if (!camp) return null;
    const arrangement = await createPropArrangement(THREE, camp.props);
    const shadows = [];
    try {
        const object = arrangement.root; object.name = 'native-rest-camp';
        for (const spec of camp.props) {
            const shadow = createBlobShadow(THREE, object, spec.shadow);
            shadows.push(shadow); shadow.sync(spec.x, spec.y, 0);
        }
        let disposed = false;
        return { room, camp, object, colliders: camp.colliders,
            placements: arrangement.props.map((prop, i) => ({
                name: camp.props[i].key, role: 'camp-' + camp.props[i].role,
                x: camp.props[i].x, y: camp.props[i].y, native: true,
                source: prop.entry.source.bundle })),
            update(dt) { if (!disposed) arrangement.update(dt); },
            dispose() {
                if (disposed) return;
                disposed = true;
                shadows.forEach(shadow => shadow.dispose());
                arrangement.dispose();
            }
        };
    } catch (error) {
        shadows.forEach(shadow => shadow.dispose());
        arrangement.dispose(); throw error;
    }
}
