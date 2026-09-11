// Bounded world-anchored feedback. One clock controls rise, crit pop and fade;
// camera movement never detaches a number from the body that was hit.
const LIFETIME = .9, LIMIT = 48;
export function createDamageTextLayer(container, THREE) {
    const layer = document.createElement("div");
    layer.className = "damage-text-layer";
    layer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:100;font-variant-numeric:tabular-nums";
    container.appendChild(layer);
    const items = [], lanes = new WeakMap(), point = new THREE.Vector3();
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    function paint(item, positionOf) {
        const s = item.spec, unit = s.unit;
        const at = unit ? (positionOf ? positionOf(unit) : unit) : s;
        point.set(at.x, s.height || 1.85, at.y).project(s.camera);
        const canvas = s.renderer.domElement;
        const visible = point.z >= -1 && point.z <= 1 && Math.abs(point.x) < 1.1 && Math.abs(point.y) < 1.2;
        item.node.style.display = visible ? "" : "none";
        if (!visible) { return; }
        const t = Math.min(1, item.age / LIFETIME);
        const rise = reduced ? 0 : 40 * (1 - Math.pow(1 - t, 2));
        const pop = reduced ? 1 : 1 + .18 * Math.max(0, 1 - item.age / .14);
        const x = (point.x * .5 + .5) * canvas.clientWidth + item.lane * 16;
        const y = (.5 - point.y * .5) * canvas.clientHeight - rise - Math.abs(item.lane) * 8;
        item.node.style.transform = "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0) translate(-50%,-50%) scale(" + pop + ")";
        item.node.style.opacity = String(Math.min(1, (1 - t) / .35));
    }
    function remove(item) { item.node.remove(); }
    return {
        layer,
        get count() { return items.length; },
        show(spec) {
            if (!spec.camera || !spec.renderer) { return false; }
            if (items.length >= LIMIT) { remove(items.shift()); }
            const node = document.createElement("div");
            const healing = spec.heal === true, enemy = spec.side === "enemy";
            const color = healing ? "#a2ffe0" : enemy ? "#ff8198"
                : spec.hitFlag === -1 ? "#cbd5d9" : spec.crit || spec.hitFlag === 1 ? "#ffe196" : "#fffaf0";
            node.className = "damage-number" + (spec.crit ? " is-critical" : "");
            node.style.cssText = "position:absolute;left:0;top:0;white-space:nowrap;font-family:system-ui,sans-serif;font-size:clamp(18px,2vw,27px);font-weight:850;line-height:1.1;text-shadow:0 2px 2px #252132,1px 0 #252132,-1px 0 #252132;will-change:transform;color:" + color;
            const label = spec.crit ? "暴击" : spec.hitFlag === 1 ? "克制" : spec.hitFlag === -1 ? "抵抗" : "";
            if (label) {
                const tag = document.createElement("small"); tag.textContent = label;
                tag.style.cssText = "display:block;font-size:10px;letter-spacing:.1em;text-align:center";
                node.appendChild(tag);
            }
            node.appendChild(document.createTextNode((healing ? "+" : enemy ? "−" : "") + Math.round(spec.damage)));
            let lane = 0;
            if (spec.unit) {
                lane = lanes.get(spec.unit) || 0; lanes.set(spec.unit, (lane + 1) % 5);
            }
            const item = { node, spec, age: 0, lane: [0, -1, 1, -2, 2][lane] };
            items.push(item); layer.appendChild(node); paint(item);
            return true;
        },
        update(dt, positionOf) {
            for (let i = items.length - 1; i >= 0; i--) {
                const item = items[i]; item.age += Math.max(0, dt || 0);
                if (item.age >= LIFETIME) { remove(item); items.splice(i, 1); }
                else { paint(item, positionOf); }
            }
        },
        clear() { items.forEach(remove); items.length = 0; },
        dispose() { this.clear(); layer.remove(); }
    };
}
