// Read-only ultimate targeting. Navigation belongs to the minimap rather
// than text labels clamped to the edges of the combat viewport.

export function createBattleIndicators(parent, THREE) {
    const layer = document.createElement("div");
    layer.className = "battle-indicators";
    parent.appendChild(layer);
    const targets = new Map(), point = new THREE.Vector3();
    function label(cache, key, className) {
        if (!cache.has(key)) {
            const node = document.createElement("div"); node.className = className;
            cache.set(key, node); layer.appendChild(node);
        }
        return cache.get(key);
    }
    function position(node, x, y, camera, width, height, clamp) {
        point.set(x, .12, y).project(camera);
        let px = (point.x + 1) * width / 2, py = (1 - point.y) * height / 2;
        if (clamp) { px = Math.max(60, Math.min(width - 60, px)); py = Math.max(116, Math.min(height - 112, py)); }
        node.hidden = !clamp && (point.z < -1 || point.z > 1 || px < 0 || px > width || py < 0 || py > height);
        node.style.transform = "translate(" + px.toFixed(1) + "px," + py.toFixed(1) + "px) translate(-50%,-50%)";
    }
    function clearOld(cache, used) {
        for (const [key, node] of cache) { if (!used.has(key)) { node.remove(); cache.delete(key); } }
    }
    return {
        update(world, camera, renderer, positionOf) {
            layer.hidden = !world?.player || world.player.dead || !!world.frozen || !!world.transition;
            if (layer.hidden) { return; }
            const width = renderer.domElement.clientWidth, height = renderer.domElement.clientHeight;
            const ready = !!world.player.skills?.ultimateReady;
            const preview = ready ? world.previewUltimate() : null, selected = new Set();
            if (preview) {
                const units = preview.targets.concat(preview.self ? [world.player] : []);
                for (const unit of units) {
                    const node = label(targets, unit.id, "ultimate-target");
                    const self = String(unit === world.player);
                    if (node.dataset.self !== self) { node.dataset.self = self; }
                    const text = unit === world.player ? "增益" : preview.scope === "全体" ? "全体" : "锁定";
                    if (node.textContent !== text) { node.textContent = text; }
                    const at = positionOf ? positionOf(unit) : unit;
                    position(node, at.x, at.y, camera, width, height, false); selected.add(unit.id);
                }
            }
            clearOld(targets, selected);
        },
        dispose() { layer.remove(); targets.clear(); }
    };
}
