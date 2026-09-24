// Bounded world-anchored feedback. One clock controls rise, crit pop and fade;
// camera movement never detaches a number from the body that was hit.
//
// spec/01: colours come from theme.css tokens (no bare hex outside this layer's
// token-lookup table); numbers use the serif face with tabular-nums; the pop is
// a 200 ms ease-out at MOTION_INTENSITY 4 (peak 1.15, crit 1.25), and
// prefers-reduced-motion disables both pop and rise.
const LIFETIME = .9, LIMIT = 48;

// spec/01 §2: element ids 0-5 → CSS custom-property suffix. The six tokens are
// defined once in theme.css :root; this table is the only place that maps a
// logic-layer element id to a visual token name.
const EL_TOKEN = ["el-fire", "el-water", "el-earth", "el-wind", "el-moon", "el-sun"];
const EL_NAME = ["炎", "水", "地", "风", "月", "阳"];

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
        // 200 ms ease-out pop (cubic-bezier 0.22,1,0.36,1 approximated by
        // the 4th-power complement), peak 1.15 for ordinary hits, 1.25 for
        // crits. MOTION_INTENSITY 4: restrained, no overshoot bounce.
        const peak = reduced ? 1 : (s.crit ? 1.25 : 1.15);
        const pop = reduced ? 1 : 1 + (peak - 1) * Math.max(0, 1 - Math.pow(item.age / .2, 4));
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
            // spec/01 §2: element colours are permitted on damage numbers.
            // 克制 (hitFlag=1) tints the number with the attacker's element
            // colour; crit adds a gold halo; ordinary hits use paper white.
            let color, label, labelColor;
            if (healing) {
                color = "var(--el-wind)";
            } else if (enemy) {
                color = "var(--kf-berry)";
            } else if (spec.hitFlag === 1) {
                const el = spec.element != null ? spec.element : 0;
                color = "var(--" + (EL_TOKEN[el] || EL_TOKEN[0]) + ")";
                label = "克制·" + (EL_NAME[el] || EL_NAME[0]);
                labelColor = color;
            } else if (spec.hitFlag === -1) {
                color = "var(--kf-ink-soft)";
                label = "抵抗";
            } else if (spec.crit) {
                color = "var(--kf-gold)";
                label = "暴击";
            } else {
                color = "var(--kf-paper)";
            }
            node.className = "damage-number" + (spec.crit ? " is-critical" : "");
            const shadow = spec.crit && !healing
                ? "0 0 6px var(--kf-gold),0 2px 2px #252132,1px 0 #252132,-1px 0 #252132"
                : "0 2px 2px #252132,1px 0 #252132,-1px 0 #252132";
            node.style.cssText = "position:absolute;left:0;top:0;white-space:nowrap;font-family:var(--font-serif);font-variant-numeric:tabular-nums;font-size:clamp(18px,2vw,27px);font-weight:850;line-height:1.1;text-shadow:" + shadow + ";will-change:transform;color:" + color;
            if (label) {
                const tag = document.createElement("small"); tag.textContent = label;
                tag.style.cssText = "display:block;font-size:10px;letter-spacing:.1em;text-align:center;font-family:var(--font-sans)"
                    + (labelColor ? ";color:" + labelColor : "");
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
