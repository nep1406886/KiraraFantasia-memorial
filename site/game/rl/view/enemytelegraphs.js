// Read-only ground warnings. These are explicit gameplay aids, not original
// effect assets. Every mesh comes from the exact area used by the world hit test.
import { SPECIAL_THREAT_LIMIT } from "../enemyactions.js";
import { LAYER } from "./layers.js";

const GROUND_Y = .035, WARNING = 0xf0b066, ACTIVE = 0xee6485;
const AFTERGLOW = .42;

function areaGeometry(THREE, area) {
    if (area.kind === "disc") { return new THREE.CircleGeometry(area.radius, 96); }
    if (area.kind === "annulus") { return new THREE.RingGeometry(area.inner, area.outer, 96); }
    if (area.kind === "sector") {
        return new THREE.CircleGeometry(area.radius, Math.max(16, Math.ceil(96 * area.arc / (2 * Math.PI))),
            area.angle - area.arc / 2, area.arc);
    }
    if (area.kind === "lane") {
        const length = Math.hypot(area.x2 - area.x1, area.y2 - area.y1), radius = area.radius;
        if (length < 1e-7) { return new THREE.CircleGeometry(radius, 96); }
        const shape = new THREE.Shape();
        shape.moveTo(0, radius); shape.lineTo(length, radius);
        shape.absarc(length, 0, radius, Math.PI / 2, -Math.PI / 2, true);
        shape.lineTo(0, -radius);
        shape.absarc(0, 0, radius, -Math.PI / 2, -Math.PI * 1.5, true);
        shape.closePath();
        const geometry = new THREE.ShapeGeometry(shape, 24);
        geometry.rotateZ(Math.atan2(area.y2 - area.y1, area.x2 - area.x1));
        return geometry;
    }
    throw new Error("Unknown enemy area: " + area.kind);
}

export function createEnemyTelegraphs(scene, THREE, options = {}) {
    const root = new THREE.Group(); root.name = "enemy-telegraphs";
    scene.add(root);
    const entries = new Map();
    // Geometry belongs to an action; materials belong to this room view.
    // Two live threats plus two short, non-dangerous afterglows reuse shaders.
    const idleMaterials = [];
    let disposed = false;
    function makeMaterials() {
        const fill = new THREE.ShaderMaterial({
            uniforms: { tint: { value: new THREE.Color(WARNING) }, age: { value: 0 },
                charge: { value: 0 }, phase: { value: 0 }, opacity: { value: .25 }, motion: { value: 1 } },
            vertexShader: `varying vec2 ground;
                void main() { ground = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: `varying vec2 ground;
                uniform vec3 tint;
                uniform float age, charge, phase, opacity, motion;
                void main() {
                    float stripe = smoothstep(.81, .95, fract((ground.x + ground.y) * 1.5 - age * .55 * motion));
                    float wave = pow(.5 + .5 * cos(length(ground) * 9.0 - age * 15.0 * motion), 9.0);
                    float energy = phase > .5 ? wave : stripe * (.35 + .65 * charge);
                    gl_FragColor = vec4(mix(tint, vec3(1.0, .95, .9), energy * .45), opacity * (.7 + .3 * energy));
                }`,
            transparent: true, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
            forceSinglePass: true, toneMapped: false });
        const edge = new THREE.LineBasicMaterial({ color: WARNING, transparent: true,
            opacity: .9, depthTest: true, depthWrite: false, fog: false, toneMapped: false });
        return { fill, edge };
    }
    function create(action) {
        const group = new THREE.Group();
        const { fill, edge } = idleMaterials.pop() || makeMaterials();
        const geometries = [];
        for (const area of action.shapes) {
            const geometry = areaGeometry(THREE, area), outline = new THREE.EdgesGeometry(geometry);
            geometries.push(geometry, outline);
            const anchor = new THREE.Group();
            anchor.name = "enemy-area-" + area.kind;
            anchor.userData.enemyArea = area;
            anchor.rotation.x = Math.PI / 2; // local +Y maps to the world's +Z
            anchor.position.set(area.kind === "lane" ? area.x1 : area.x, GROUND_Y,
                area.kind === "lane" ? area.y1 : area.y);
            const mesh = new THREE.Mesh(geometry, fill), rim = new THREE.LineSegments(outline, edge);
            mesh.renderOrder = LAYER.enemy - 10; rim.renderOrder = LAYER.enemy - 9;
            anchor.add(mesh, rim); group.add(anchor);
        }
        root.add(group);
        return { group, fill, edge, geometries };
    }
    function release(action, entry, reusable = true) {
        entry.group.removeFromParent();
        entry.geometries.forEach(geometry => geometry.dispose());
        if (reusable) { idleMaterials.push({ fill: entry.fill, edge: entry.edge }); }
        else { entry.fill.dispose(); entry.edge.dispose(); }
        entries.delete(action);
    }
    function clear() {
        for (const [action, entry] of entries) { release(action, entry, false); }
        idleMaterials.forEach(pair => { pair.fill.dispose(); pair.edge.dispose(); });
        idleMaterials.length = 0;
    }
    return {
        object: root,
        get count() { return entries.size; },
        get shapeCount() { let count = 0; for (const entry of entries.values()) { count += entry.group.children.length; } return count; },
        sync(world, timeSec) {
            if (disposed) { return; }
            const used = new Set();
            if (!world.player?.dead) {
                for (const recovering of [false, true]) {
                    for (const unit of world.enemies) {
                        const action = unit.action;
                        if (unit.dead || unit.stunTimer > 0 || !action) { continue; }
                        const eligible = recovering ? action.stage === "recover" && action.age < AFTERGLOW
                            : action.stage === "windup" || action.stage === "active";
                        if (eligible && used.size < SPECIAL_THREAT_LIMIT * (recovering ? 2 : 1)) { used.add(action); }
                    }
                }
            }
            // Retire before acquiring so material count stays bounded.
            for (const [action, entry] of entries) { if (!used.has(action)) { release(action, entry); } }
            const t = Number.isFinite(timeSec) ? timeSec : 0;
            for (const action of used) {
                let entry = entries.get(action);
                // Phase from action.age so the shim's frozen-time rerun of an
                // identical action still produces byte-identical pixels. A
                // Math.random() salt here breaks the reuse-parity gate.
                if (!entry) { entry = create(action); entries.set(action, entry); }
                const active = action.stage === "active";
                const fading = action.stage === "recover";
                const uniforms = entry.fill.uniforms;
                uniforms.tint.value.setHex(active ? ACTIVE : fading ? 0xb69bd1 : WARNING);
                entry.edge.color.copy(uniforms.tint.value);
                // warning is fractional (e.g. 0.95s) — no integer truncation,
                // or every sub-second windup would read as instantly charged.
                const warning = Math.max(1e-3, action.move.warning);
                const charge = Math.min(1, action.age / warning);
                // Countdown-driven fill: alpha grows with age AND the rim breathes
                // so a static windup never reads as dead ground art. Accessible
                // under reduced-flash because the sinusoid stays inside opacity,
                // never crosses a brightness threshold.
                const still = options.reducedMotion?.() || false;
                const pulse = still ? .5 : 0.5 + 0.5 * Math.sin(t * 5 + action.age * 3);
                // Floor stays at the original flat windup brightness so the
                // shape-parity gate's pulse-time samples stay foreground.
                uniforms.age.value = action.age;
                uniforms.charge.value = charge;
                uniforms.phase.value = active || fading ? 1 : 0;
                uniforms.motion.value = still ? 0 : 1;
                uniforms.opacity.value = fading ? .12 * (1 - action.age / AFTERGLOW)
                    : active ? .55 : .22 + .16 * charge + .04 * pulse;
                entry.edge.opacity = fading ? .24 * (1 - action.age / AFTERGLOW) : active ? 1 : .75 + .2 * pulse;
            }
        },
        clear,
        dispose() {
            if (disposed) { return; }
            disposed = true; clear(); root.removeFromParent();
        }
    };
}
