// Screen-space HP/stun, anchored to the same interpolated positions as actors.
export function createHealthBars(container, THREE) {
    const layer = document.createElement("div");
    layer.className = "combat-health-layer";
    layer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:35";
    container.appendChild(layer);
    const entries = new Map(), point = new THREE.Vector3();
    // The stage canvas is CSS-sized by the resize path, not per frame. Reading
    // clientWidth/Height per unit per frame forced a layout between style
    // writes; a ResizeObserver keeps the cached pair and the frame loop never
    // touches layout again.
    let canvas = null, canvasW = 0, canvasH = 0, observer = null;
    function watchSize(element) {
        if (element === canvas && canvasW > 0) { return; }
        canvas = element;
        canvasW = element.clientWidth;
        canvasH = element.clientHeight;
        if (!observer) {
            observer = new ResizeObserver(function () {
                canvasW = canvas ? canvas.clientWidth : 0;
                canvasH = canvas ? canvas.clientHeight : 0;
            });
        }
        observer.disconnect();
        observer.observe(element);
    }
    function create(unit) {
        const node = document.createElement("div");
        node.className = "unit-health"; node.dataset.unit = String(unit.id);
        const player = unit.kind === "player";
        node.style.cssText = "position:absolute;left:0;top:0;transform:translate(-50%,-50%);width:" + (player ? 68 : unit.elite ? 78 : 50)
            + "px;height:5px;border:1px solid #fff8dc99;border-radius:4px;background:#302c41dd;box-shadow:0 1px 4px #25203088";
        const ghost = document.createElement("i"), fill = document.createElement("i"), stun = document.createElement("i");
        for (const bar of [ghost, fill, stun]) {
            bar.style.cssText = "position:absolute;inset:0;border-radius:3px;transform-origin:left;display:block";
            node.appendChild(bar);
        }
        ghost.style.background = "#ffe5aa";
        fill.style.background = player ? "linear-gradient(90deg,#5fae98,#b9f4c9)"
            : unit.elite ? "linear-gradient(90deg,#a780d5,#e4b6ef)" : "linear-gradient(90deg,#c05d70,#f7a7a1)";
        stun.style.cssText += ";top:7px;height:2px;background:#ffe79d";
        if (unit.elite) {
            const badge = document.createElement("span"); badge.textContent = "◆ 精英";
            badge.style.cssText = "position:absolute;left:0;bottom:9px;width:100%;font:10px system-ui;color:#fff5d5;text-align:center;text-shadow:0 1px 3px #181228";
            node.appendChild(badge);
        }
        layer.appendChild(node);
        return { node, fill, ghost, stun, hp: unit.hp, trail: unit.hp, wait: 0,
            last: { fill: "", ghost: "", stun: "", label: "", shown: null, opacity: "", x: "", y: "" } };
    }
    // Writes only when the value actually changed: assigning an identical style
    // string still dirties the style recalc, and this runs per unit per frame.
    function setStyle(entry, key, element, value) {
        if (entry.last[key] === value) { return; }
        entry.last[key] = value;
        element.style[key] = value;
    }
    return {
        layer,
        update(world, camera, renderer, dt, positionOf) {
            const alive = new Set(world.units.filter(u => !u.dead && u.kind !== "boss"));
            entries.forEach((entry, unit) => {
                if (!alive.has(unit)) { entry.node.remove(); entries.delete(unit); }
            });
            alive.forEach(unit => {
                let entry = entries.get(unit);
                if (!entry) { entry = create(unit); entries.set(unit, entry); }
                if (unit.hp < entry.hp) { entry.wait = .22; }
                entry.hp = unit.hp;
                if (entry.wait > 0) { entry.wait -= dt; }
                else { entry.trail += (unit.hp - entry.trail) * (1 - Math.exp(-8 * dt)); }
                entry.trail = Math.max(unit.hp, entry.trail);
                const ratio = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
                setStyle(entry, "fill", entry.fill, "scaleX(" + ratio + ")");
                setStyle(entry, "ghost", entry.ghost, "scaleX(" + Math.min(1, entry.trail / unit.maxHp) + ")");
                setStyle(entry, "stun", entry.stun, "scaleX(" + Math.min(1, (unit.stun || 0) / 100) + ")");
                const label = (unit.kind === "player" ? "角色" : unit.nameZh || "敌人") + "生命 "
                    + Math.round(unit.hp) + "/" + Math.round(unit.maxHp);
                if (entry.last.label !== label) {
                    entry.last.label = label;
                    entry.node.setAttribute("aria-label", label);
                }
                const at = positionOf(unit);
                point.set(at.x, unit.kind === "player" ? -.18 : unit.elite ? 2.0 : 1.5, at.y).project(camera);
                const shown = (unit.kind === "player" || unit.elite || ratio < 1 || unit.sm.state === "telegraph")
                    && point.z >= -1 && point.z <= 1 && Math.abs(point.x) < 1.05 && Math.abs(point.y) < 1.05;
                setStyle(entry, "shown", entry.node, shown ? "" : "none");
                setStyle(entry, "opacity", entry.node, unit.kind === "player" && unit.iframes > 0 ? ".6" : "1");
                if (canvas !== renderer.domElement || canvasW <= 0) { watchSize(renderer.domElement); }
                // 0.1px quantisation: sub-pixel noise below it is invisible, and
                // it stops a resting unit from churning style strings.
                const x = Math.round((point.x * .5 + .5) * canvasW * 10) / 10;
                const y = Math.round((.5 - point.y * .5) * canvasH * 10) / 10;
                setStyle(entry, "x", entry.node, x + "px");
                setStyle(entry, "y", entry.node, y + "px");
            });
        },
        clear() { entries.forEach(e => e.node.remove()); entries.clear(); },
        dispose() { if (observer) { observer.disconnect(); observer = null; } this.clear(); layer.remove(); }
    };
}
