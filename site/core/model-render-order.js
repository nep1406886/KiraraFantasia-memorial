// The exporter packs stage, layer and hierarchy into renderOrder. Only the
// first two select a Unity render queue: MsbObjectHandler.UpdateParam() calls
// MeigeUtility.RenderStageToRenderQueue(stage, layer), NOT m_HieIndex.
// Within an alpha queue Unity sorts back-to-front. Treating the hierarchy
// as another queue paints pl_120000's chest_line over its face (both layer 4).
// Keep the packed assets compatible, and use hierarchy only after depth ties.

export function alphaQueue(renderOrder) {
    if (!Number.isSafeInteger(renderOrder)) { return null; }
    const stage = Math.floor(renderOrder / 1000000);
    const layer = Math.floor((renderOrder % 1000000) / 1000);
    if (stage < 20 || stage > 24 || layer >= 125) { return null; }
    // Unity sorts queues <= 2500 as opaque. Alpha_Higher (stage 20), layer 0
    // is exactly 2500; all other currently exported alpha queues are above it.
    const queue = stage * 125 + layer + (stage >= 22 ? 1 : 0);
    return queue > 2500 ? queue : null;
}

export function compareModelRenderItems(a, b, depths, buckets) {
    if (a.groupOrder !== b.groupOrder) { return a.groupOrder - b.groupOrder; }
    const bucket = Math.floor(a.renderOrder / 1000);
    // A bucket is a contiguous interval in the EXISTING renderOrder ladder.
    // The installer validates its authored queue and role offset as a whole,
    // so an interleaved prop or conflicting role can never create a sort cycle.
    const queue = alphaQueue(a.renderOrder);
    const eligible = buckets ? buckets.has(bucket) : queue !== null && queue === alphaQueue(b.renderOrder);
    if (eligible && bucket === Math.floor(b.renderOrder / 1000)) {
        const az = depths?.get(a.object) ?? a.z;
        const bz = depths?.get(b.object) ?? b.z;
        if (Number.isFinite(az) && Number.isFinite(bz) && az !== bz) {
            return bz - az;
        }
    }
    // Match Three's opaque comparator everywhere else. CustomBlending keeps
    // these meshes in one queue; moving them to transparent would reorder them
    // against weapons and other depth-writing meshes, outside this fix's scope.
    if (a.renderOrder !== b.renderOrder) { return a.renderOrder - b.renderOrder; }
    if (a.material.id !== b.material.id) { return a.material.id - b.material.id; }
    if (a.z !== b.z) { return a.z - b.z; }
    return a.id - b.id;
}

// Install on an owned scene/renderer. Scene.onBeforeRender runs
// after world matrices update and before Three projects/sorts render items.
// A skinned mesh's cached boundingSphere is NOT refreshed by animation. Use
// the current posed AABB center, like Renderer.bounds, instead of that stale
// center or the mesh-node origin (often the same origin for every face layer).
export function installModelRenderOrder(renderer, scene, THREE, options = {}) {
    // Games may add role offsets to renderOrder. Decode the saved authored
    // value, but NEVER remove those offsets from the effective draw ladder.
    const getAuthoredOrder = options.getAuthoredOrder || (mesh => mesh.renderOrder);
    // CPU skinning is camera-independent; only the final projection is per pass.
    // Installers that render the same frame in several passes (staged
    // compositing) MAY pass frameStamp, bumped once per game frame; the posed
    // AABB is then computed once and reprojected per pass. Without frameStamp
    // every beforeRender refreshes, so single-pass installers and the fixture
    // keep the exact per-call semantics.
    const frameStamp = options.frameStamp || null;
    const posedBounds = new WeakMap();
    const depths = new Map();
    const queues = new Map();
    const buckets = new Set();
    const center = new THREE.Vector3();
    const previous = scene.onBeforeRender;
    const previousAfter = scene.onAfterRender;
    const compare = (a, b) => compareModelRenderItems(a, b, depths, buckets);
    function beforeRender(activeRenderer, activeScene, camera) {
        previous.apply(this, arguments);
        depths.clear();
        queues.clear();
        buckets.clear();
        scene.traverseVisible(function (mesh) {
            if (!mesh.isMesh || !mesh.geometry || !camera.layers.test(mesh.layers)) { return; }
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            if (!materials.some(m => m && m.visible && !m.transparent)) { return; }
            const authored = getAuthoredOrder(mesh);
            const queue = alphaQueue(authored);
            const offset = mesh.renderOrder - authored;
            const bucket = Math.floor(mesh.renderOrder / 1000);
            const eligible = queue !== null && Number.isSafeInteger(offset) && offset % 1000 === 0;
            let group = queues.get(bucket);
            if (!group) {
                group = { queue, offset, eligible, peers: [] };
                queues.set(bucket, group);
            }
            // Include unsupported meshes in validation, not in depth sorting.
            // On ambiguous data keep the entire interval in its original order.
            group.eligible = group.eligible && eligible && group.queue === queue && group.offset === offset;
            group.peers.push(mesh);
        });
        for (const [bucket, group] of queues) {
            // Invisible expression alternatives and single-item queues cannot
            // collide. Avoid skinning their vertices a second time each frame.
            if (!group.eligible || group.peers.length < 2) { continue; }
            buckets.add(bucket);
            const stamp = frameStamp ? frameStamp() : null;
            for (const mesh of group.peers) {
                let bounds;
                if (mesh.isSkinnedMesh) {
                    // Recompute per game frame (design: pose changes between
                    // frames; the cache only amortizes the multi-pass
                    // compositor within ONE frame). Missing the stamp
                    // comparison here would freeze the sort on frame-1 bounds.
                    let cached = stamp === null ? null : posedBounds.get(mesh);
                    if (!cached || cached.stamp !== stamp) {
                        mesh.computeBoundingBox();
                        if (stamp !== null) {
                            cached = { stamp: stamp, box: mesh.boundingBox };
                            posedBounds.set(mesh, cached);
                        }
                    }
                    bounds = cached ? cached.box : mesh.boundingBox;
                } else {
                    if (!mesh.geometry.boundingBox) { mesh.geometry.computeBoundingBox(); }
                    bounds = mesh.geometry.boundingBox;
                }
                if (!bounds || bounds.isEmpty()) { continue; }
                bounds.getCenter(center).applyMatrix4(mesh.matrixWorld).project(camera);
                if (Number.isFinite(center.z)) { depths.set(mesh, center.z); }
            }
        }
        activeRenderer.setOpaqueSort(compare);
    }
    function afterRender(activeRenderer) {
        // A renderer can also draw a separate cinematic/overlay scene. Do not
        // apply this scene's depth map (or its role offsets) to that next pass.
        activeRenderer.setOpaqueSort(null);
        if (previousAfter) { previousAfter.apply(this, arguments); }
    }
    scene.onBeforeRender = beforeRender;
    scene.onAfterRender = afterRender;
    return function dispose() {
        if (scene.onBeforeRender === beforeRender) { scene.onBeforeRender = previous; }
        if (scene.onAfterRender === afterRender) { scene.onAfterRender = previousAfter; }
        renderer.setOpaqueSort(null);
        depths.clear();
        queues.clear();
        buckets.clear();
    };
}
