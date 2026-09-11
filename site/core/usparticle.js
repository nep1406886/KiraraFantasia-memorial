// Particle emitters for the とっておき effect scenes.
//
// tools/export_uniqueskill_scene.py writes one rule per MeigeParticleEmitter
// into the glTF scene's `extras.emitters`, and GLTFLoader surfaces that as
// scene.userData.emitters. This module turns those rules into geometry and
// steps them from the timeline's peActive schedule, which core/uniqueskill.js
// already decodes and raises through onEmitter.
//
// Why a custom simulation rather than three.js Points or Sprite:
//
//   The rules need per-particle rotation, a size range on both axes, a colour
//   curve sampled over life, blink, and a UV sub-rect walked as a sheet. Points
//   gives one scalar size and no rotation; Sprite is one draw call each and
//   there are up to 4810 live particles in the worst scene (140110). So each
//   emitter is a single interleaved quad buffer -- 4 verts and 6 indices per
//   particle -- expanded to a camera-facing quad in the vertex shader, with the
//   CPU writing only the per-particle state that changed.
//
// Budget, measured rather than guessed (.codex-tmp/pe_budget.py): median peak
// 300 live particles per scene, worst case 4810, i.e. 19240 verts. That is
// small enough to update from JS every frame.

import { layerColorExpression } from "./usmaterial.js";

const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
const DEG = Math.PI / 180;

const VERTEX_SHADER = [
    "attribute vec2 corner;",
    "attribute vec3 offset;",
    "attribute vec2 size;",
    "attribute float rotation;",
    "attribute vec4 tint;",
    "attribute vec4 uvRect;",
    "varying vec2 vUv;",
    "varying vec4 vTint;",
    "void main() {",
    // Zero size is how a dead particle is hidden: it collapses to a point and
    // rasterises nothing, which is cheaper than restriping the index buffer.
    "    vec2 scaled = corner * size;",
    "    float c = cos(rotation);",
    "    float s = sin(rotation);",
    "    vec2 spun = vec2(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);",
    // Billboard in view space so the quad always faces the camera regardless
    // of how the timeline has rotated the emitter's parent.
    "    vec4 view = modelViewMatrix * vec4(offset, 1.0);",
    "    view.xy += spun;",
    "    gl_Position = projectionMatrix * view;",
    "    vUv = uvRect.xy + (corner + 0.5) * uvRect.zw;",
    "    vTint = tint;",
    "}"
].join("\n");

const FRAGMENT_SHADER = [
    "uniform sampler2D map;",
    "uniform mat3 mapTransform;",
    "uniform float alphaScale;",
    "varying vec2 vUv;",
    "varying vec4 vTint;",
    "void main() {",
    "    vec4 texel = texture2D(map, (mapTransform * vec3(vUv, 1.0)).xy);",
    "    gl_FragColor = vec4(texel.rgb * vTint.rgb, texel.a * vTint.a * alphaScale);",
    // Additive blending would otherwise pay for thousands of fully
    // transparent fragments.
    "    if (gl_FragColor.a <= 0.001) { discard; }",
    "}"
].join("\n");

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function pick(range) {
    if (!range) {
        return 0;
    }
    return lerp(range[0], range[1], Math.random());
}

// Meige's ranges are authored as (min, max) but a few are inverted (drag
// 0.94 -> 0.87), and lerp handles that without a sort.
function pickBoth(range, t) {
    if (!range) {
        return 0;
    }
    return lerp(range[0], range[1], t);
}

function randomOnSphere(out, polarRange) {
    // Polar angle measured from +Y, azimuth free. A handful of emitters author
    // a polar band past 180 (220-240, 100-500); wrapping keeps the direction
    // legal instead of producing a NaN from acos.
    let polar = pick(polarRange) % 360;
    if (polar < 0) {
        polar += 360;
    }
    if (polar > 180) {
        polar = 360 - polar;
    }
    const theta = polar * DEG;
    const azimuth = Math.random() * Math.PI * 2;
    const sin = Math.sin(theta);
    out[0] = sin * Math.cos(azimuth);
    out[1] = Math.cos(theta);
    out[2] = sin * Math.sin(azimuth);
}

function randomInCone(out, halfAngleRange) {
    // The emitter's own forward is +Y here, matching the sphere case, so a zero
    // angle range emits straight up the node's axis.
    const half = Math.min(180, Math.abs(pick(halfAngleRange))) * DEG;
    const cos = lerp(Math.cos(half), 1, Math.random());
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    const azimuth = Math.random() * Math.PI * 2;
    out[0] = sin * Math.cos(azimuth);
    out[1] = cos;
    out[2] = sin * Math.sin(azimuth);
}

export function createEmitters(options) {
    const opts = options || {};
    const THREE = opts.THREE;
    const root = opts.root;
    if (!THREE || !root) {
        throw new Error("createEmitters needs THREE and root");
    }

    const specs = (root.userData && root.userData.emitters) || [];
    if (!specs.length) {
        return null;
    }

    // Emitter nodes are addressed by index into the glTF node list, which is
    // what the exporter recorded, but GLTFLoader does not expose that list. It
    // does preserve names, and the exporter also stored the parent renderer's
    // name -- the same string peActive channels use -- so bind by name and take
    // the `ptcl:` child as the spawn transform when it exists.
    const byName = new Map();
    root.traverse(function (node) {
        if (node.name && !byName.has(node.name)) {
            byName.set(node.name, node);
        }
    });

    // Emitter sprites come from loadScene's resolveEmitterMaterials, which
    // pulls each one out of the parser by index. They are not reachable by
    // traversing meshes: the only primitive that ever used them was the
    // placeholder card the exporter now withholds. The name scan below is a
    // fallback for a scene exported before that resolution existed.
    const materialByName = new Map();
    root.traverse(function (node) {
        if (!node.isMesh || !node.material) {
            return;
        }
        const list = Array.isArray(node.material) ? node.material : [node.material];
        list.forEach(function (material) {
            if (material.name && !materialByName.has(material.name)) {
                materialByName.set(material.name, material);
            }
        });
    });

    const container = new THREE.Group();
    container.name = "usParticles";
    container.frustumCulled = false;
    root.add(container);

    const emitters = [];
    const scratchDir = [0, 0, 0];
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    const spawnDir = new THREE.Vector3();
    const spawnOffset = new THREE.Vector3();

    specs.forEach(function (spec) {
        const rule = spec.rule || {};
        const count = Math.max(1, rule.num | 0);
        // line/polyline/ribbon strips are not simulated as strips; they fall
        // back to billboards of the same width. 401 of 2828 emitters are
        // polyline, so this is visible but bounded, and a wrong strip is worse
        // than a plausible spark.
        const node = byName.get("ptcl:" + spec.name) || byName.get(spec.name);
        if (!node) {
            return;
        }

        const source = spec.resolvedMaterial
            || (spec.materialName ? materialByName.get(spec.materialName) : null)
            || null;
        const map = source && source.map ? source.map : null;
        if (!map) {
            // Without the sprite there is nothing to draw, and an untextured
            // white quad would look worse than the absence.
            return;
        }

        const geometry = new THREE.BufferGeometry();
        const corners = new Float32Array(count * 4 * 2);
        const offsets = new Float32Array(count * 4 * 3);
        const sizes = new Float32Array(count * 4 * 2);
        const rotations = new Float32Array(count * 4);
        const tints = new Float32Array(count * 4 * 4);
        const uvRects = new Float32Array(count * 4 * 4);
        const indices = new Uint16Array(count * 6);

        for (let i = 0; i < count; i++) {
            for (let c = 0; c < 4; c++) {
                corners[(i * 4 + c) * 2] = CORNERS[c][0];
                corners[(i * 4 + c) * 2 + 1] = CORNERS[c][1];
            }
            const base = i * 4;
            const at = i * 6;
            indices[at] = base;
            indices[at + 1] = base + 1;
            indices[at + 2] = base + 2;
            indices[at + 3] = base;
            indices[at + 4] = base + 2;
            indices[at + 5] = base + 3;
        }

        geometry.setAttribute("corner", new THREE.BufferAttribute(corners, 2));
        const offsetAttr = new THREE.BufferAttribute(offsets, 3);
        const sizeAttr = new THREE.BufferAttribute(sizes, 2);
        const rotationAttr = new THREE.BufferAttribute(rotations, 1);
        const tintAttr = new THREE.BufferAttribute(tints, 4);
        const uvAttr = new THREE.BufferAttribute(uvRects, 4);
        [offsetAttr, sizeAttr, rotationAttr, tintAttr, uvAttr].forEach(function (attr) {
            attr.setUsage(THREE.DynamicDrawUsage);
        });
        geometry.setAttribute("offset", offsetAttr);
        geometry.setAttribute("size", sizeAttr);
        geometry.setAttribute("rotation", rotationAttr);
        geometry.setAttribute("tint", tintAttr);
        geometry.setAttribute("uvRect", uvAttr);
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

        const uniforms = {
            map: { value: map }, mapTransform: { value: map.matrix },
            alphaScale: { value: rule.alphaScale === undefined ? 1 : rule.alphaScale }
        };
        let fragment = FRAGMENT_SHADER;
        if (source.alphaMap && source.userData.msb && source.userData.msb.layerTexture) {
            uniforms.layerMap = { value: source.alphaMap };
            uniforms.layerTransform = { value: source.alphaMap.matrix };
            fragment = "uniform sampler2D layerMap;\nuniform mat3 layerTransform;\n" + fragment;
            fragment = fragment.replace("vec4 texel = texture2D(map, (mapTransform * vec3(vUv, 1.0)).xy);", [
                "vec4 usBase = texture2D(map, (mapTransform * vec3(vUv, 1.0)).xy);",
                "vec4 usLayer = texture2D(layerMap, (layerTransform * vec3(vUv, 1.0)).xy);",
                "vec4 texel = " + layerColorExpression(source) + ";"
            ].join("\n"));
        }
        const shader = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: VERTEX_SHADER,
            fragmentShader: fragment,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        // Inherit whatever compositing the parent sprite used, so an additive
        // emitter glows and a standard one does not double-brighten.
        if (source) {
            shader.blending = source.blending;
            shader.blendSrc = source.blendSrc;
            shader.blendDst = source.blendDst;
            shader.blendEquation = source.blendEquation;
            if (source.blending === THREE.CustomBlending) {
                shader.blendSrcAlpha = source.blendSrcAlpha;
                shader.blendDstAlpha = source.blendDstAlpha;
            }
        }

        const mesh = new THREE.Mesh(geometry, shader);
        // Each emitter owns its shader. Cloning its uniforms in the timeline
        // sampler would also clone the borrowed texture and orphan that clone.
        mesh.userData.__usOwnMaterials = true;
        mesh.name = "pe:" + spec.name;
        mesh.frustumCulled = false;
        mesh.renderOrder = (source && source.userData && source.userData.msb
            && source.userData.msb.renderOrder) || 0;
        mesh.visible = false;
        // Local emitters ride their node, so parenting does the transform for
        // free and spawn offsets stay in local space. World emitters release
        // their particles, so they hang off the scene root and spawn positions
        // are baked at emit time.
        if (rule.local) {
            node.add(mesh);
        } else {
            container.add(mesh);
        }

        const blocks = (rule.uv && rule.uv.blocks) || 1;
        const rect = (rule.uv && rule.uv.rect) || [0, 0, 1, 1];

        emitters.push({
            spec: spec,
            rule: rule,
            node: node,
            mesh: mesh,
            geometry: geometry,
            attrs: {
                offset: offsetAttr, size: sizeAttr, rotation: rotationAttr,
                tint: tintAttr, uv: uvAttr
            },
            count: count,
            live: 0,
            active: false,
            emitCarry: 0,
            blocks: blocks,
            rect: rect,
            // null means "no scaling", which is also how (0, 0) is read: 16
            // emitters author it, and a literal zero scale would make them
            // invisible under any reading of the field.
            scaleRamp: (function () {
                const ls = rule.lifeScale;
                if (!ls || (!ls[0] && !ls[1])) {
                    return null;
                }
                return (ls[0] === 1 && ls[1] === 1) ? null : ls;
            }()),
            // Per-particle state. Parallel typed arrays rather than objects:
            // 4810 particles at 60 Hz means the allocator is the thing to
            // avoid, not the indexing.
            px: new Float32Array(count),
            py: new Float32Array(count),
            pz: new Float32Array(count),
            vx: new Float32Array(count),
            vy: new Float32Array(count),
            vz: new Float32Array(count),
            age: new Float32Array(count),
            life: new Float32Array(count),
            travel: new Float32Array(count),
            lifeMax: new Float32Array(count),
            baseW: new Float32Array(count),
            baseH: new Float32Array(count),
            rot: new Float32Array(count),
            rotSpeed: new Float32Array(count),
            accel: new Float32Array(count),
            drag: new Float32Array(count),
            curve: new Uint8Array(count),
            block: new Uint8Array(count),
            blinkSpan: new Float32Array(count),
            alive: new Uint8Array(count)
        });
    });

    function spawn(emitter, index) {
        const rule = emitter.rule;
        const shape = rule.shape || {};
        const type = rule.emit;

        spawnOffset.set(0, 0, 0);
        if (type === "sphere") {
            randomOnSphere(scratchDir, shape.angle);
            spawnDir.set(scratchDir[0], scratchDir[1], scratchDir[2]);
            const radius = pick(shape.radius);
            spawnOffset.copy(spawnDir).multiplyScalar(radius);
        } else if (type === "point") {
            randomInCone(scratchDir, shape.angle);
            spawnDir.set(scratchDir[0], scratchDir[1], scratchDir[2]);
        } else if (type === "planeQuad") {
            spawnOffset.set((Math.random() - 0.5) * pick(shape.width), 0,
                            (Math.random() - 0.5) * pick(shape.height));
            spawnDir.set(0, 1, 0);
        } else if (type === "planeCircle") {
            const radius = pick(shape.radius);
            const azimuth = Math.random() * Math.PI * 2;
            spawnOffset.set(Math.cos(azimuth) * radius, 0,
                            Math.sin(azimuth) * radius);
            spawnDir.set(0, 1, 0);
        } else if (type === "box") {
            spawnOffset.set((Math.random() - 0.5) * pick(shape.width),
                            (Math.random() - 0.5) * pick(shape.height),
                            (Math.random() - 0.5) * pick(shape.depth));
            spawnDir.set(0, 1, 0);
        } else if (type === "cylinder") {
            const radius = pick(shape.radius);
            const azimuth = Math.random() * Math.PI * 2;
            spawnOffset.set(Math.cos(azimuth) * radius,
                            (Math.random() - 0.5) * pick(shape.height),
                            Math.sin(azimuth) * radius);
            spawnDir.set(Math.cos(azimuth), 0, Math.sin(azimuth));
        } else {
            spawnDir.set(0, 1, 0);
        }

        if (rule.randomDir) {
            randomOnSphere(scratchDir, [0, 180]);
            spawnDir.set(scratchDir[0], scratchDir[1], scratchDir[2]);
        }

        const speed = pick(rule.speed);

        if (rule.local) {
            emitter.px[index] = spawnOffset.x;
            emitter.py[index] = spawnOffset.y;
            emitter.pz[index] = spawnOffset.z;
            emitter.vx[index] = spawnDir.x * speed;
            emitter.vy[index] = spawnDir.y * speed;
            emitter.vz[index] = spawnDir.z * speed;
        } else {
            // World space: bake the node's transform into both the start point
            // and the launch direction, then forget the node.
            emitter.node.updateWorldMatrix(true, false);
            emitter.node.matrixWorld.decompose(worldPos, worldQuat, worldScale);
            spawnOffset.applyQuaternion(worldQuat).multiply(worldScale);
            spawnDir.applyQuaternion(worldQuat);
            emitter.px[index] = worldPos.x + spawnOffset.x;
            emitter.py[index] = worldPos.y + spawnOffset.y;
            emitter.pz[index] = worldPos.z + spawnOffset.z;
            emitter.vx[index] = spawnDir.x * speed;
            emitter.vy[index] = spawnDir.y * speed;
            emitter.vz[index] = spawnDir.z * speed;
        }

        emitter.age[index] = 0;
        emitter.travel[index] = 0;
        // lifeType distance means the particle dies after covering a distance,
        // not after a time; 13 emitters of 2828 use it.
        emitter.lifeMax[index] = pick(rule.life);
        emitter.life[index] = emitter.lifeMax[index];

        const width = rule.width || rule.size || [0.1, 0.1];
        const height = rule.height || rule.size || width;
        const t = Math.random();
        // One roll for both axes keeps sprites square when the ranges match,
        // which is how nearly every billboard here is authored. lifeScale is
        // not folded in here: it is a ramp over life, applied in writeParticle.
        emitter.baseW[index] = pickBoth(width, t);
        emitter.baseH[index] = pickBoth(height, t);

        if (rule.rot) {
            emitter.rot[index] = pick(rule.rot.start) * DEG;
            emitter.rotSpeed[index] = pick(rule.rot.speed) * DEG;
        } else {
            emitter.rot[index] = 0;
            emitter.rotSpeed[index] = 0;
        }
        if (rule.accel) {
            emitter.accel[index] = pick(rule.accel.a);
            emitter.drag[index] = pick(rule.accel.drag);
        } else {
            emitter.accel[index] = 0;
            emitter.drag[index] = 0;
        }
        const curves = rule.colorCurves;
        emitter.curve[index] = curves && curves.length
            ? Math.floor(Math.random() * curves.length) : 0;
        emitter.block[index] = emitter.blocks > 1
            ? Math.floor(Math.random() * emitter.blocks) : 0;
        emitter.blinkSpan[index] = rule.blink ? pick(rule.blink) : 0;
        emitter.alive[index] = 1;
    }

    function writeParticle(emitter, index) {
        const attrs = emitter.attrs;
        const offset = attrs.offset.array;
        const size = attrs.size.array;
        const rotation = attrs.rotation.array;
        const tint = attrs.tint.array;
        const uv = attrs.uv.array;
        const rule = emitter.rule;

        const base = index * 4;
        if (!emitter.alive[index]) {
            for (let c = 0; c < 4; c++) {
                size[(base + c) * 2] = 0;
                size[(base + c) * 2 + 1] = 0;
            }
            return;
        }

        const t = emitter.lifeMax[index] > 0
            ? Math.min(1, emitter.age[index] / emitter.lifeMax[index]) : 1;

        let r = 1;
        let g = 1;
        let b = 1;
        let alpha = 1;
        const curves = rule.colorCurves;
        if (curves && curves.length) {
            const stops = curves[emitter.curve[index]] || curves[0];
            if (stops && stops.length) {
                // m_Point is empty on every colour curve in the data, so the
                // stops are evenly spaced over the particle's life.
                const span = stops.length - 1;
                const at = t * span;
                const i0 = Math.min(span, Math.floor(at));
                const i1 = Math.min(span, i0 + 1);
                const f = at - i0;
                r = lerp(stops[i0][0], stops[i1][0], f);
                g = lerp(stops[i0][1], stops[i1][1], f);
                b = lerp(stops[i0][2], stops[i1][2], f);
                // The fourth component is alpha, and it is the whole point of
                // the curve on 624 emitters whose RGB never leaves white.
                // Dropping it made every one of those render at full opacity:
                // sandsmoke on 100206 authors a peak of 0.298 and was covering
                // 78% of the frame as an opaque wall (.codex-tmp/pe_alpha.py --
                // 564 emitters carry a sub-1 alpha, 1261 curves end at 0).
                alpha = lerp(stops[i0][3], stops[i1][3], f);
            }
        }

        // lifeAlpha multiplies on top rather than replacing the curve. 1441
        // emitters set both, and on 509 of those the curve already reaches 0,
        // so the tail fades twice -- that is authored, not a correction to make.
        if (rule.lifeAlpha) {
            alpha *= 1 - t;
        }
        if (emitter.blinkSpan[index] > 0) {
            // A blink span is the full on/off period, so half of it is dark.
            const phase = (emitter.age[index] % (emitter.blinkSpan[index] * 2))
                / (emitter.blinkSpan[index] * 2);
            alpha *= phase < 0.5 ? 1 : 0;
        }
        // HDR factor is the engine's over-brightness knob; without a bloom
        // pass the honest approximation is to scale the colour.
        const hdr = rule.hdr === undefined ? 1 : rule.hdr;

        // m_lifeScaleRange, read as a scale ramped over the particle's life
        // rather than as a random multiplier. The evidence is the ordering: 321
        // of 2828 ranges are inverted (0.3 -> 0.2, 0.4 -> 0.3), and a random
        // pick is order-blind while a ramp is not. m_lifeSpanSecRange already
        // randomises the lifetime, so a second lifetime multiplier would be
        // redundant, and the name matches m_lifeSpanAlpha, which is a fade over
        // life. The sibling m_LifeScaleType is 0 on all 2828 emitters, so the
        // enum cannot be decoded from the data; if this reading is wrong the
        // error is bounded -- a particle that grows or shrinks instead of
        // holding its mean size (.codex-tmp/pe_lifescale.py).
        const ramp = emitter.scaleRamp;
        const scale = ramp ? lerp(ramp[0], ramp[1], t) : 1;
        const width = emitter.baseW[index] * scale;
        const height = emitter.baseH[index] * scale;
        const rect = emitter.rect;
        let ux = rect[0];
        let uy = rect[1];
        if (emitter.blocks > 1) {
            // A UV sheet is walked along the row the authored rect sits in.
            ux = rect[0] + rect[2] * emitter.block[index];
        }

        for (let c = 0; c < 4; c++) {
            const v = base + c;
            offset[v * 3] = emitter.px[index];
            offset[v * 3 + 1] = emitter.py[index];
            offset[v * 3 + 2] = emitter.pz[index];
            size[v * 2] = width;
            size[v * 2 + 1] = height;
            rotation[v] = emitter.rot[index];
            tint[v * 4] = r * hdr;
            tint[v * 4 + 1] = g * hdr;
            tint[v * 4 + 2] = b * hdr;
            tint[v * 4 + 3] = alpha;
            uv[v * 4] = ux;
            uv[v * 4 + 1] = uy;
            uv[v * 4 + 2] = rect[2];
            uv[v * 4 + 3] = rect[3];
        }
    }

    function step(emitter, dt) {
        const rule = emitter.rule;
        let live = 0;

        for (let i = 0; i < emitter.count; i++) {
            if (!emitter.alive[i]) {
                continue;
            }
            emitter.age[i] += dt;

            if (emitter.accel[i]) {
                const vx = emitter.vx[i];
                const vy = emitter.vy[i];
                const vz = emitter.vz[i];
                const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
                if (speed > 1e-6) {
                    const push = emitter.accel[i] * dt / speed;
                    emitter.vx[i] += vx * push;
                    emitter.vy[i] += vy * push;
                    emitter.vz[i] += vz * push;
                }
            }
            if (emitter.drag[i] && emitter.drag[i] !== 1) {
                // Authored as a per-second retained fraction.
                const keep = Math.pow(emitter.drag[i], dt);
                emitter.vx[i] *= keep;
                emitter.vy[i] *= keep;
                emitter.vz[i] *= keep;
            }
            if (rule.gravity) {
                const force = pickBoth(rule.gravity.force, 0.5) * dt;
                emitter.vx[i] += rule.gravity.dir[0] * force;
                emitter.vy[i] += rule.gravity.dir[1] * force;
                emitter.vz[i] += rule.gravity.dir[2] * force;
            }

            const dx = emitter.vx[i] * dt;
            const dy = emitter.vy[i] * dt;
            const dz = emitter.vz[i] * dt;
            emitter.px[i] += dx;
            emitter.py[i] += dy;
            emitter.pz[i] += dz;
            emitter.travel[i] += Math.sqrt(dx * dx + dy * dy + dz * dz);
            emitter.rot[i] += emitter.rotSpeed[i] * dt;

            const done = rule.lifeType === "distance"
                ? emitter.travel[i] >= emitter.lifeMax[i]
                : emitter.age[i] >= emitter.lifeMax[i];
            if (done) {
                emitter.alive[i] = 0;
            } else {
                live++;
            }
            writeParticle(emitter, i);
        }

        if (emitter.active) {
            emitter.emitCarry += (rule.rate || 0) * dt;
            let budget = Math.floor(emitter.emitCarry);
            if (budget > 0) {
                emitter.emitCarry -= budget;
                // rateRandom jitters the burst so a 120/s emitter does not
                // spawn in visible lockstep with the frame clock.
                if (rule.rateRandom) {
                    budget = Math.max(0, Math.round(
                        budget * (1 + (Math.random() * 2 - 1) * rule.rateRandom)));
                }
                for (let i = 0; i < emitter.count && budget > 0; i++) {
                    if (emitter.alive[i]) {
                        continue;
                    }
                    spawn(emitter, i);
                    writeParticle(emitter, i);
                    budget--;
                    live++;
                }
            }
        }

        emitter.live = live;
        emitter.mesh.visible = live > 0;
        if (live > 0 || emitter.dirty) {
            const attrs = emitter.attrs;
            attrs.offset.needsUpdate = true;
            attrs.size.needsUpdate = true;
            attrs.rotation.needsUpdate = true;
            attrs.tint.needsUpdate = true;
            attrs.uv.needsUpdate = true;
        }
        emitter.dirty = live > 0;
    }

    const byIndex = new Map();
    emitters.forEach(function (emitter) {
        byIndex.set(emitter.spec.index, emitter);
    });

    return {
        emitters: emitters,
        container: container,

        // core/uniqueskill.js raises peActive transitions here.
        setActive: function (index, active) {
            const emitter = byIndex.get(index);
            if (!emitter) {
                return;
            }
            emitter.active = !!active;
            if (!active) {
                // Turning an emitter off stops emission; particles already out
                // live their life, which is what the engine does too.
                emitter.emitCarry = 0;
            }
        },

        update: function (dt) {
            const clamped = Math.max(0, Math.min(0.1, dt || 0));
            if (clamped <= 0) {
                return;
            }
            for (let i = 0; i < emitters.length; i++) {
                step(emitters[i], clamped);
            }
        },

        // Scrubbing has no continuous history to simulate, so everything dies
        // and the next update rebuilds from whatever is active.
        reset: function () {
            emitters.forEach(function (emitter) {
                emitter.active = false;
                emitter.emitCarry = 0;
                emitter.live = 0;
                emitter.alive.fill(0);
                emitter.mesh.visible = false;
                for (let i = 0; i < emitter.count; i++) {
                    writeParticle(emitter, i);
                }
                emitter.attrs.size.needsUpdate = true;
            });
        },

        liveCount: function () {
            let total = 0;
            emitters.forEach(function (emitter) { total += emitter.live; });
            return total;
        },

        dispose: function () {
            emitters.forEach(function (emitter) {
                if (emitter.mesh.parent) {
                    emitter.mesh.parent.remove(emitter.mesh);
                }
                emitter.geometry.dispose();
                emitter.mesh.material.dispose();
            });
            if (container.parent) {
                container.parent.remove(container);
            }
            emitters.length = 0;
            byIndex.clear();
        }
    };
}
