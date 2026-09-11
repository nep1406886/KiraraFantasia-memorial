// Repair the dark rim that alpha-tested atlases show under magnification.
//
// The source materials really are alpha-tested at 0.01 -- Unity _Mode=0,
// _SrcBlend=One/_DstBlend=Zero, _ZWrite=1, and MsbHandler supplies
// m_AlphaTestRefValue=0.01 -- and the converter reproduces that faithfully as
// glTF alphaMode MASK with alphaCutoff 0.01. The problem is what the authored
// atlases put in the ramp that the cutoff keeps.
//
// Measured on model_en_7000's 512x512 colour atlas, read exactly (PIL, no
// premultiplication): of 177141 texels with any alpha, 98492 (55.6%) sit below
// alpha 255, and their mean luminance falls as the alpha does --
//
//     alpha 255      78649 texels   mean luminance 180.9
//     alpha 161..192  7674 texels                  161.3
//     alpha 129..160  7026 texels                   96.2
//     alpha  33..64  10055 texels                   18.3
//     alpha   1..12  17676 texels                   43.9
//
// A cutoff of 0.01 keeps all of them and draws each one fully opaque. On the
// phone the game shipped to, one atlas texel is about one screen pixel and that
// tail is invisible. In this viewer one texel covers roughly three device pixels
// (measured 2.75-3.40, median 3.02), so it becomes a black outline. It is worst
// exactly where it was reported: hair strands and the mouth are narrow,
// high-contrast features that are almost entirely ramp, with little opaque core.
//
// Alternatives, and why not:
//   - Raise the cutoff. A one-texel hair strand has no opaque core, so the
//     feature disappears rather than losing its rim.
//   - Switch to real alpha blending. That returns the coplanar head layers to
//     the transparent queue, which is the seam bug the MASK choice exists to
//     avoid (model_pl_140007's hat brim against the hair).
//   - Re-export with dilated atlases. The Unity source bundles are no longer on
//     disk, so there is no input to re-export from.
//
// So the repair happens here, at load time: push opaque colour outward into the
// ramp. The alpha channel is never written, so silhouettes, coverage and
// alpha-to-coverage antialiasing stay bit-for-bit identical -- only the colour
// the cutoff was already going to draw changes.
//
// READ THE PIXELS THROUGH WEBGL, NOT A 2D CANVAS. This is the part that is easy
// to get silently wrong. A 2D canvas stores premultiplied alpha, so
// drawImage + getImageData destroys RGB exactly where alpha is low -- which is
// the entire ramp this code exists to reason about. Measured in Chrome, sending
// (200,120,60) and reading it back:
//
//     alpha   1  ->  (255,   0,   0)      alpha  24  ->  (202, 117,  64)
//     alpha   2  ->  (255, 128,   0)      alpha  96  ->  (199, 120,  61)
//     alpha   3  ->  (170,  85,  85)      alpha 250  ->  (200, 120,  60)
//     alpha  12  ->  (191, 128,  64)      alpha 255  ->  (200, 120,  60)
//
// Worst error 120 of 255. An earlier version of this file read through a 2D
// canvas and its before/after numbers were meaningless: it was measuring canvas
// quantisation, not the repair. Three.js itself is careful here -- its
// ImageBitmapLoader asks for `premultiplyAlpha: "none"` and uploads with
// UNPACK_PREMULTIPLY_ALPHA_WEBGL off -- so the untouched path is exact, and any
// repair has to stay exact too. Hence: upload to a GL texture, render to an RGBA8
// framebuffer, readPixels. Then hand three a raw byte array rather than a canvas,
// so the write-back cannot reintroduce the same loss.

const processed = new WeakSet();

// One parse of the same GLB produces a fresh ImageBitmap every time, so the
// WeakSet above can only dedupe within one parse. Loader callers re-parse the
// SAME file every room (each unit owns fresh geometries by design), and the
// dilate result is a pure function of the source bytes -- so the finished RGBA
// array is cached per (asset key + colour-texture index) and later parses
// reuse it, skipping the GL readback and the dilate passes. Bounded LRU: the
// biggest atlases here are 512x512 RGBA (~1 MiB), so 24 entries caps the
// resident cost near a battle roster's worth of atlases.
const dilatedCache = new Map();
const DILATED_CACHE_LIMIT = 24;

// Anything below this fraction of full alpha is treated as ramp, i.e. colour we
// cannot trust. The measurements above show the darkening begins immediately
// below solid, so the floor sits just under 1.
export const DEFAULT_ALPHA_FLOOR = 0.98;

// How far colour may travel outward, in texels.
//
// This was 4 on the reasoning that "the ramps here are a few texels wide, and
// more passes would smear across the atlas's packing gutters into a neighbouring
// island". Both halves of that were wrong, and measuring said so:
//
//   1. The ramps are not a few texels wide. Sweeping the pass count on the
//      rendered image (thin-valley count in the head region, pose-locked):
//        model_en_7000    p2 +31.7%   p4 -22.6%   p8 -57.1%   p12 -52.1%
//        model_pl_130402  p2 -21.7%   p4 -22.5%   p8 -18.3%   p12 -41.1%
//        model_en_6230                p4 -14.8%   p8 -23.9%   p12 -28.2%
//      Four passes stopped less than halfway through 7000's ramp. Worse, p2 was
//      *worse than no repair at all*: a half-filled ramp leaves a bright band
//      with the dark tail still outside it, which reads as a wider outline.
//   2. Smearing into the gutters cannot be seen. A gutter texel has alpha 0 and
//      alphaTest 0.01 discards it before it is ever shaded. The only place its
//      colour survives is mip generation, and there replacing black with the
//      art's own colour is the improvement, not the risk.
//
// So the cap is a CPU budget, not a quality knob. Instrumented on the real
// atlases (512x512, Node, one atlas): the fill converges on its own after 45-64
// passes at 60-215 ms, and a pass in steady state costs 0.6-3 ms. p24 and p48
// buy ~2 points over p12 on one model of five and nothing on the rest. Twelve
// passes is ~15-25 ms per atlas, 2-3 atlases per model, against multi-second
// model loads.
const DEFAULT_PASSES = 12;

// One reader for the whole session. Creating a GL context per texture would be
// wasteful and browsers cap how many can exist at once.
let reader = null;

const VERTEX_SHADER = [
    "attribute vec2 aPos;",
    "varying vec2 vUv;",
    "void main() {",
    "    vUv = aPos * 0.5 + 0.5;",
    "    gl_Position = vec4(aPos, 0.0, 1.0);",
    "}"
].join("\n");

const FRAGMENT_SHADER = [
    "precision highp float;",
    "uniform sampler2D uTex;",
    "varying vec2 vUv;",
    "void main() {",
    // Straight pass-through. No colour-space work anywhere in this path: the
    // texture is uploaded as plain RGBA (not SRGB8_ALPHA8) and the target is
    // RGBA8, so the bytes that go in are the bytes that come out.
    "    gl_FragColor = texture2D(uTex, vUv);",
    "}"
].join("\n");

function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createReader() {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const attrs = { alpha: true, antialias: false, depth: false, stencil: false,
                    premultipliedAlpha: false, preserveDrawingBuffer: false };
    const gl = canvas.getContext("webgl2", attrs) || canvas.getContext("webgl", attrs);
    if (!gl) {
        return null;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) {
        return null;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        return null;
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "uTex"), 0);
    return { gl: gl, canvas: canvas, target: null, size: [0, 0] };
}

// Exported so a test can prove the read is exact against a file whose bytes are
// known, rather than trusting that it is. The 2D-canvas path this replaced
// looked correct and was not.
// Returns the image's exact RGBA bytes, top row first, or null if GL is
// unavailable. Row order: the source is uploaded with UNPACK_FLIP_Y_WEBGL off, so
// texture coordinate v=0 is the image's first row; the quad puts v=0 at the
// bottom of the framebuffer, and readPixels also starts at the bottom. The two
// flips cancel, so the array comes back in the image's own order.
export function readExactPixels(image, width, height) {
    if (!reader) {
        reader = createReader() || { gl: null };
    }
    const gl = reader.gl;
    if (!gl) {
        return null;
    }
    if (reader.size[0] !== width || reader.size[1] !== height) {
        if (reader.target) {
            gl.deleteFramebuffer(reader.target.fbo);
            gl.deleteTexture(reader.target.tex);
        }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
            gl.TEXTURE_2D, tex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            return null;
        }
        reader.target = { tex: tex, fbo: fbo };
        reader.size = [width, height];
        reader.canvas.width = width;
        reader.canvas.height = height;
    }
    const source = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    // All three of these must be off, or the read is not the file's bytes.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) {
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    }
    let ok = true;
    try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    } catch (error) {
        ok = false;
    }
    if (!ok || gl.getError() !== gl.NO_ERROR) {
        gl.deleteTexture(source);
        return null;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, reader.target.fbo);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.deleteTexture(source);
    if (gl.getError() !== gl.NO_ERROR) {
        return null;
    }
    return data;
}

// Spread trusted colour outward over the ramp, in place.
//
// mode "brighten" only accepts a neighbour colour that is brighter than what is
// there, so the pass can remove darkness the compositing left behind but can
// never introduce any. mode "solidify" is the unconditional fill that texture
// tools ship. Which one is right is an empirical question about these atlases,
// so both exist and the caller picks; see the note on the export below.
function dilate(data, width, height, options) {
    const opts = options || {};
    const floorFraction = opts.alphaFloor === undefined ? DEFAULT_ALPHA_FLOOR : opts.alphaFloor;
    const floor = Math.max(1, Math.round(floorFraction * 255));
    const passes = opts.passes === undefined ? DEFAULT_PASSES : opts.passes;
    const brightenOnly = opts.mode !== "solidify";

    // trusted[i]: this texel's colour may be copied outward, either because it
    // started opaque or because an earlier pass reached it.
    const trusted = new Uint8Array(width * height);
    let trustedCount = 0;
    for (let i = 0, p = 3; i < trusted.length; i++, p += 4) {
        if (data[p] >= floor) {
            trusted[i] = 1;
            trustedCount++;
        }
    }
    if (!trustedCount || trustedCount === trusted.length) {
        return null;
    }

    // emptyDistance: only repair ramp texels that sit within this many texels of
    // a fully empty one. Without it the floor is the only test, and a floor high
    // enough to fix the silhouette rim also rewrites the translucency the artist
    // painted *inside* surfaces -- lace, gauze, fan panels, chain links. That is
    // not a hypothetical: floor 0.98 lifts the rim from luminance 12.7 to 100.6
    // but takes interior gradient energy down to 62% of baseline, which is the
    // regression that read as "coarser" and got the whole repair turned off.
    //
    // Interior translucency is nowhere near an empty texel; a silhouette ramp is
    // adjacent to one by construction. So this separates the two cases that the
    // alpha value alone cannot.
    //
    // models.js has documented and forwarded this option for a while, but the
    // module never read it -- ?fringedist=0/1/2/3 all produced byte-identical
    // renders. It is implemented here now.
    const emptyDistance = opts.emptyDistance === undefined
        ? 0
        : Math.max(0, Math.round(opts.emptyDistance));
    let nearEmpty = null;
    if (emptyDistance > 0) {
        // Multi-source spread from the empty texels, emptyDistance steps of the
        // same 8-neighbourhood the repair itself uses, so "distance" here means
        // the same thing it means to the dilation.
        nearEmpty = new Uint8Array(width * height);
        let front = [];
        for (let i = 0, p = 3; i < nearEmpty.length; i++, p += 4) {
            if (data[p] === 0) {
                nearEmpty[i] = 1;
                front.push(i);
            }
        }
        for (let step = 0; step < emptyDistance && front.length; step++) {
            const next = [];
            for (let k = 0; k < front.length; k++) {
                const i = front[k];
                const x = i % width;
                const y = (i - x) / width;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= height) {
                        continue;
                    }
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if ((dx === 0 && dy === 0) || xx < 0 || xx >= width) {
                            continue;
                        }
                        const j = yy * width + xx;
                        if (!nearEmpty[j]) {
                            nearEmpty[j] = 1;
                            next.push(j);
                        }
                    }
                }
            }
            front = next;
        }
        // Treat out-of-range ramp texels as trusted: they keep their own colour
        // and, more importantly, they still pass colour along to the rim so the
        // repair is not walled off from the edge it is meant to reach.
        for (let i = 0; i < trusted.length; i++) {
            if (!trusted[i] && !nearEmpty[i]) {
                trusted[i] = 1;
                trustedCount++;
            }
        }
        if (trustedCount === trusted.length) {
            return null;
        }
    }

    let reached = 0;
    let repaired = 0;
    for (let pass = 0; pass < passes; pass++) {
        const front = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (trusted[i]) {
                    continue;
                }
                let r = 0;
                let g = 0;
                let b = 0;
                let n = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    const yy = y + dy;
                    if (yy < 0 || yy >= height) {
                        continue;
                    }
                    for (let dx = -1; dx <= 1; dx++) {
                        const xx = x + dx;
                        if ((dx === 0 && dy === 0) || xx < 0 || xx >= width) {
                            continue;
                        }
                        const j = yy * width + xx;
                        if (!trusted[j]) {
                            continue;
                        }
                        const q = j * 4;
                        r += data[q];
                        g += data[q + 1];
                        b += data[q + 2];
                        n++;
                    }
                }
                if (!n) {
                    continue;
                }
                // Mark it reached either way, so the front keeps advancing and a
                // rejected texel does not block colour from travelling past it.
                front.push(i);
                const nr = Math.round(r / n);
                const ng = Math.round(g / n);
                const nb = Math.round(b / n);
                const p = i * 4;
                if (brightenOnly) {
                    // Decide on luminance, then write the whole triple, so the
                    // hue stays the art's own instead of drifting per channel.
                    const was = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
                    const now = 0.299 * nr + 0.587 * ng + 0.114 * nb;
                    if (now <= was) {
                        continue;
                    }
                }
                data[p] = nr;
                data[p + 1] = ng;
                data[p + 2] = nb;
                repaired++;
            }
        }
        if (!front.length) {
            break;
        }
        for (let k = 0; k < front.length; k++) {
            trusted[front[k]] = 1;
        }
        reached += front.length;
    }
    return repaired ? { trusted: trustedCount, reached: reached, repaired: repaired } : null;
}

// Returns stats when the texture was rewritten, or null when it was skipped
// (already done, no image, nothing to repair, or the exact read was unavailable).
// cacheKey (optional): identifies the SOURCE atlas across parses of the same
// file (loader passes "<assetKey>#<deterministic colour-texture index>"). A hit
// reuses the finished bytes; the stats are synthesized from the cached entry.
export function dilateTextureColour(texture, THREE, options, cacheKey) {
    const image = texture && texture.image;
    if (!image || !THREE || processed.has(texture)) {
        return null;
    }
    const width = image.width;
    const height = image.height;
    if (!width || !height || image.data) {
        // image.data means this is already a raw byte source -- either ours from
        // a previous load or something we should not second-guess.
        return null;
    }
    // Mark before the work: textures are shared across materials and meshes, and
    // a failed attempt should not be retried once per material.
    processed.add(texture);

    const cached = cacheKey ? dilatedCache.get(cacheKey) : null;
    if (cached && cached.width === width && cached.height === height) {
        // Refresh the LRU position, then hand the SAME bytes to this texture.
        // Sharing one Source object across textures is what three.js itself
        // does when a GLB reuses an image, and the data is read-only.
        dilatedCache.delete(cacheKey);
        dilatedCache.set(cacheKey, cached);
        texture.source = cached.source;
        texture.isDataTexture = true;
        texture.needsUpdate = true;
        return { trusted: 0, reached: 0, repaired: 0,
            width: width, height: height, cached: true };
    }

    const data = readExactPixels(image, width, height);
    if (!data) {
        return null;
    }
    const stats = dilate(data, width, height, options);
    if (!stats) {
        return null;
    }
    // Hand three the bytes directly. A canvas here would undo the whole point of
    // reading through GL, because storing into a canvas premultiplies again.
    // A fresh Source rather than assigning .image, because .image writes through
    // to source.data and the source object is shared between textures.
    const source = new THREE.Source({ data: data, width: width, height: height });
    texture.source = source;
    texture.isDataTexture = true;
    texture.needsUpdate = true;
    if (cacheKey) {
        // Store the shared Source (not a copy): one resident byte array per
        // atlas even when several live textures reference it.
        while (dilatedCache.size >= DILATED_CACHE_LIMIT) {
            const oldest = dilatedCache.keys().next().value;
            dilatedCache.delete(oldest);
        }
        dilatedCache.set(cacheKey, { source: source, width: width, height: height });
    }
    stats.width = width;
    stats.height = height;
    return stats;
}

// Only the colour slots. alphaMap is read through a single channel, so it carries
// no colour to repair, and the alpha it carries is deliberately untouched.
const COLOUR_SLOTS = ["map", "emissiveMap"];

// cache (optional): { namespace, counter } shared across ONE applyMaterialRules
// run. The counter numbers colour textures in traverse order -- the same file
// always produces the same order, so "<namespace>#<n>" identifies the same
// source atlas across parses deterministically.
export function dilateMaterialTextures(material, THREE, options, seen, cache) {
    let repaired = 0;
    COLOUR_SLOTS.forEach(function (slot) {
        const texture = material[slot];
        if (!texture) {
            return;
        }
        if (seen) {
            if (seen.has(texture)) {
                return;
            }
            seen.add(texture);
        }
        const cacheKey = cache
            ? cache.namespace + "#" + (cache.counter.n++)
            : undefined;
        if (dilateTextureColour(texture, THREE, options, cacheKey)) {
            repaired++;
        }
    });
    return repaired;
}
