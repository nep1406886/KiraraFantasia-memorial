// World occlusion and a character's self-occlusion are different boundaries.
// Draw the player against a fresh depth buffer, not with depthTest disabled:
// the latter also lets back-facing clothing and weapons cut across the face.
// Pass membership belongs to scene-root views; no bone, material, layer mask,
// or authored mesh order is changed by this compositor.
export function renderStage(renderer, scene, camera, playerRoot, localCamera) {
    if (!playerRoot || !playerRoot.visible || playerRoot.parent !== scene) {
        renderer.render(scene, camera);
        return;
    }
    const roots = scene.children.map(root => ({
        root, visible: root.visible,
        pass: root === playerRoot ? 1 : (root.userData.rlOverlay ? 2 : 0)
    }));
    const background = scene.background;
    const autoClear = renderer.autoClear;
    const autoReset = renderer.info.autoReset;
    const matrixWorldAutoUpdate = scene.matrixWorldAutoUpdate;
    const origin = localCamera ? { x: playerRoot.position.x, z: playerRoot.position.z } : null;
    let localized = false;
    function restorePlayer() {
        if (!localized) { return; }
        localized = false;
        playerRoot.position.x = origin.x;
        playerRoot.position.z = origin.z;
        // Automatic scenes defer the world-matrix recompute to the next
        // auto-updating render (the next frame's pass 0): the restore only
        // rewrites position, and the stale matrixWorld left behind is the
        // localized pose. Nothing renders it (both other passes hide the
        // whole playerRoot) and every direct matrixWorld reader in this
        // codebase refreshes explicitly first via
        // updateWorldMatrix(true, false) (actorview foot lift, usparticle
        // world-space emitters). Callers that manage matrices manually
        // (scene.matrixWorldAutoUpdate === false) keep the immediate
        // recompute so their post-condition is unchanged.
        if (!matrixWorldAutoUpdate) { playerRoot.updateMatrixWorld(true); }
    }
    function show(pass) {
        for (const entry of roots) {
            // Lights are available to every pass; hidden view roots stay hidden.
            entry.root.visible = entry.visible && (entry.pass === pass || entry.root.isLight === true);
        }
    }
    try {
        // Keep diagnostics cumulative across the complete frame, not last pass.
        if (autoReset) { renderer.info.reset(); }
        renderer.info.autoReset = false;
        show(0);
        renderer.render(scene, camera);
        // Three updates invisible descendants too. The first pass has already
        // refreshed the whole scene; later passes only change visibility and
        // the isolated player origin, not the world's pose. Do not traverse
        // every map/enemy skeleton again for each pass. Restore the caller's
        // flag in finally so the next frame still gets fresh animation.
        scene.matrixWorldAutoUpdate = false;
        scene.background = null;
        renderer.autoClear = false;
        renderer.clearDepth();
        show(1);
        if (localCamera) {
            // These paper skins contain nearly coplanar facial layers. Their
            // GPU skinning must not lose precision to a large world offset:
            // shift camera and model together only for the isolated pass.
            localCamera.copy(camera, false);
            localCamera.isPerspectiveCamera = camera.isPerspectiveCamera;
            localCamera.isOrthographicCamera = camera.isOrthographicCamera;
            localCamera.position.x -= origin.x;
            localCamera.position.z -= origin.z;
            playerRoot.position.x = 0;
            playerRoot.position.z = 0;
            localized = true;
            playerRoot.updateMatrixWorld(true);
        }
        renderer.render(scene, localCamera || camera);
        restorePlayer();
        if (roots.some(entry => entry.visible && entry.pass === 2)) {
            // Projectiles/effects remain readable in front of the player too.
            renderer.clearDepth();
            show(2);
            renderer.render(scene, camera);
        }
    } finally {
        scene.matrixWorldAutoUpdate = matrixWorldAutoUpdate;
        restorePlayer();
        for (const entry of roots) { entry.root.visible = entry.visible; }
        scene.background = background;
        renderer.autoClear = autoClear;
        renderer.info.autoReset = autoReset;
    }
}
