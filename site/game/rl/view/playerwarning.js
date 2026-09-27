// Under-the-player incoming-hit indicator. Unlike the ground telegraphs this
// tracks the player, not the threat: a soft breathing disc always underfoot
// that turns hot and sharpens when any in-flight threat zone overlaps the
// player. Pure presentation — the same containment math the world's hit test
// uses, read straight off action.shapes, never re-decided.
import { LAYER } from "./layers.js";

const TAU = Math.PI * 2;
const SAFE = 0x88b5e8, DANGER = 0xef5064;
const HIGH = 0.45;   // how far above the feet the ring hovers
const DANGER_R2 = 2.4; // edge-of-danger margin, in world units

function circleInArea(area, x, y, r) {
    if (area.kind === "disc") {
        return Math.hypot(x - area.x, y - area.y) <= area.radius + r;
    }
    if (area.kind === "annulus") {
        const d = Math.hypot(x - area.x, y - area.y);
        return d + r >= area.inner && d - r <= area.outer;
    }
    if (area.kind === "sector") {
        const dx = x - area.x, dy = y - area.y;
        if (Math.hypot(dx, dy) > area.radius + r) { return false; }
        let diff = Math.atan2(dy, dx) - area.angle;
        while (diff > Math.PI) { diff -= TAU; } while (diff < -Math.PI) { diff += TAU; }
        // Margin covers the player's body radius at the sector boundary.
        return Math.abs(diff) <= area.arc / 2 + (Math.hypot(dx, dy) > 1e-9 ? r / Math.hypot(dx, dy) : 1);
    }
    if (area.kind === "lane") {
        const ax = area.x2 - area.x1, ay = area.y2 - area.y1;
        const len2 = ax * ax + ay * ay;
        if (len2 < 1e-9) { return Math.hypot(x - area.x1, y - area.y1) <= area.radius + r; }
        const t = Math.max(0, Math.min(1, ((x - area.x1) * ax + (y - area.y1) * ay) / len2));
        return Math.hypot(x - (area.x1 + ax * t), y - (area.y1 + ay * t)) <= area.radius + r;
    }
    return false;
}

export function createPlayerWarning(scene, THREE, options) {
    const opts = options || {};
    const baseRadius = opts.radius || .9;
    const radius = baseRadius;

    const vertex = /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`;
    const fragment = /* glsl */`
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uTime;
        uniform float uDanger;      // 0..1 sharpens the edge
        varying vec2 vUv;
        void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float r = length(p);
            if (r > 1.0) { discard; }
            // Spinning dashes, only visible near the rim: reads "you are the target".
            float ang = atan(p.y, p.x);
            float dashes = 0.55 + 0.45 * sin(ang * 10.0 - uTime * 3.2);
            // Safe: the dashes stay faint so the footing glow is calm.
            float dashAmp = mix(0.10, 0.42, uDanger);
            float dashPattern = mix(1.0, dashes, dashAmp);
            // A soft inner fill that swells as danger rises.
            float fill = mix(0.06, 0.30, uDanger) * smoothstep(1.0, 0.25, r);
            // The rim itself, sharpening (Player Edge) with uDanger.
            float rimWidth = mix(0.16, 0.05, uDanger);
            float rim = smoothstep(1.0 - rimWidth, 1.0, r) * smoothstep(1.0, 0.0, r) * 2.2;
            // Soft outside falloff so the edge reads as a glow, not a disc.
            float outer = smoothstep(1.0, 0.85, r);
            float a = (fill * outer + rim * dashPattern) * uOpacity;
            gl_FragColor = vec4(uColor, a);
        }`;
    const material = new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: new THREE.Color(SAFE) },
            uOpacity: { value: .0 },
            uTime: { value: 0 },
            uDanger: { value: 0 }
        },
        vertexShader: vertex, fragmentShader: fragment,
        transparent: true, depthTest: true, depthWrite: false,
        side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = LAYER.enemy - 8;
    mesh.frustumCulled = false;
    scene.add(mesh);

    let target = 0, opacity = 0, safeColor = new THREE.Color(SAFE), dangerColor = new THREE.Color(DANGER);

    return {
        object: mesh,
        update(dt, world, timeSec) {
            const p = world && world.player;
            if (!p || p.dead) { mesh.visible = false; return; }
            mesh.visible = true;
            // A non-finite dt would poison the lerps permanently (NaN contagion);
            // treat it as a zero-time frame instead.
            const step = Number.isFinite(dt) ? dt : 0;
            mesh.position.set(p.x, HIGH * radius + .12, p.y);
            material.uniforms.uTime.value = Number.isFinite(timeSec) ? timeSec : 0;
            // Hot when any in-flight threat overlaps the player's body.
            let danger = 0;
            for (const unit of (world.enemies || [])) {
                if (unit.dead || unit.stunTimer > 0 || !unit.action) { continue; }
                const stage = unit.action.stage;
                if (stage !== "windup" && stage !== "active") { continue; }
                // Active threats carry more weight than ones still winding up.
                const weight = stage === "active" ? 1 : .6;
                for (const area of unit.action.shapes) {
                    if (circleInArea(area, p.x, p.y, (p.radius || .45))) {
                        danger = Math.max(danger, weight); break;
                    }
                }
                if (danger >= 1) { break; }
            }
            // Also read "danger nearby" from pending bullets that aren't telegraphed yet.
            material.uniforms.uDanger.value += (danger - material.uniforms.uDanger.value) * Math.min(1, step * 10);
            // Opacity target: danger → 1, calm → soft base so the footing reads.
            const targetOpacity = danger > 0 ? .85 : .18;
            opacity += (targetOpacity - opacity) * Math.min(1, step * 6);
            material.uniforms.uOpacity.value = opacity;
            material.uniforms.uColor.value.copy(safeColor).lerp(dangerColor, material.uniforms.uDanger.value);
            mesh.scale.setScalar(1 + material.uniforms.uDanger.value * .18);
        },
        dispose() {
            mesh.geometry.dispose(); material.dispose(); mesh.removeFromParent();
        }
    };
}
