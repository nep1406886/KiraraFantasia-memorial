// Decorative petals/light motes: one draw call, fixed vertices, no gameplay RNG.
export function createAmbience(THREE, { width, depth, x = 0, z = 0, night = false, count = 64, seed = 1 }) {
    const positions = new Float32Array(count * 3), phases = new Float32Array(count);
    const random = n => { const value = Math.sin((n + seed) * 12.9898) * 43758.5453; return value - Math.floor(value); };
    for (let i = 0; i < count; i++) {
        positions.set([random(i * 4) * width, .5 + random(i * 4 + 1) * 3.5, random(i * 4 + 2) * depth], i * 3);
        phases[i] = random(i * 4 + 3) * Math.PI * 2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
    const material = new THREE.ShaderMaterial({
        uniforms: { time: { value: 0 }, bounds: { value: new THREE.Vector2(width, depth) },
            tint: { value: new THREE.Color(night ? '#ffe6ad' : '#f5bdd0') } },
        transparent: true, depthWrite: false, toneMapped: false,
        vertexShader: `attribute float phase; uniform float time; uniform vec2 bounds; varying float angle;
            void main() {
                vec3 p = position;
                p.x = mod(p.x + time * .35 + sin(time * .6 + phase) * .5, bounds.x);
                p.z = mod(p.z + time * .12 + sin(time * .3 + phase) * .3, bounds.y);
                p.y = .35 + mod(p.y - time * .16 + sin(phase) * .2 + 100., 3.8);
                angle = phase + time * .65;
                vec4 mv = modelViewMatrix * vec4(p, 1.);
                gl_Position = projectionMatrix * mv;
                gl_PointSize = clamp(140. / max(4., -mv.z), 4., 11.);
            }`,
        fragmentShader: `uniform vec3 tint; varying float angle;
            void main() {
                vec2 p = gl_PointCoord - .5;
                p = mat2(cos(angle), -sin(angle), sin(angle), cos(angle)) * p;
                float d = length(p * vec2(1.3, 2.1));
                float a = (1. - smoothstep(.12, .5, d)) * .7;
                if (a < .015) discard;
                gl_FragColor = vec4(tint, a);
            }`
    });
    const object = new THREE.Points(geometry, material);
    object.name = 'ambient-petals'; object.position.set(x, 0, z); object.frustumCulled = false;
    let disposed = false;
    return { object,
        update(dt, reduced = false) {
            object.visible = !reduced;
            if (!reduced) material.uniforms.time.value += Math.max(0, dt || 0);
        },
        dispose() {
            if (disposed) return;
            disposed = true; object.removeFromParent(); geometry.dispose(); material.dispose();
        }
    };
}
