// Model loading for the fan-game layer.
//
// Lifted out of models.js so the four games can share one loader without
// four of them editing that file. The material rules below are not
// guesses -- they are what the original engine's Unity material floats
// say, and getting them wrong produces the dark seams and vanishing
// face parts that models.js spent several commits chasing down. Keep
// them in sync with models.js:1804 if either side changes.

import { dilateMaterialTextures } from "./texture-fringe.js";
import { installSkeletonDirtyGuard } from "./skeleton-dirty.js";

const THREE_BUILD = "0.180.0";

const MODULE_SOURCES = [
    {
        three: "../vendor/three/three.module.min.js",
        orbit: "../vendor/three/OrbitControls.js",
        gltf: "../vendor/three/GLTFLoader.js",
        meshopt: "../vendor/three/meshopt_decoder.module.js"
    },
    {
        three: "https://cdn.jsdelivr.net/npm/three@" + THREE_BUILD + "/build/three.module.js",
        orbit: "https://cdn.jsdelivr.net/npm/three@" + THREE_BUILD + "/examples/jsm/controls/OrbitControls.js",
        gltf: "https://cdn.jsdelivr.net/npm/three@" + THREE_BUILD + "/examples/jsm/loaders/GLTFLoader.js",
        meshopt: "https://cdn.jsdelivr.net/npm/three@" + THREE_BUILD + "/examples/jsm/libs/meshopt_decoder.module.js"
    }
];

let modulePromise = null;
let manifestPromise = null;
// Decompressed GLB blobs are immutable and safe to share between parses. A
// small LRU removes repeat network/decompression work when a roster or NPC
// view instantiates the same model more than once without retaining the whole
// model scene (scenes remain independently disposable).
const MODEL_BLOB_CACHE_LIMIT = 12;
const MODEL_BLOB_CACHE_BYTES = 32 * 1024 * 1024;
const modelBlobCache = new Map();
let modelBlobBytes = 0;
// Set only by installManifest(); kept beside manifestPromise so a second install
// can be told apart from a first one that has already resolved.
let installed = null;

// Chrome gives file:// pages an opaque origin, so neither fetch nor XHR can
// read the manifest or any .glb.gz next to the page. Worth detecting up front
// so games can show a useful hint instead of a stack trace.
export const IS_LOCAL_FILE = window.location.protocol === "file:";
export const LOCAL_FILE_HINT = "本地直接打开页面时浏览器禁止读取同目录文件。请在项目目录运行 python -m http.server 8642 后访问 http://localhost:8642/game.html";

// Prefer the vendored copies so the games keep working where the CDN is
// unreachable.
export function loadModules() {
    if (modulePromise) {
        return modulePromise;
    }
    modulePromise = MODULE_SOURCES.reduce(function (chain, source) {
        return chain.catch(function () {
            return Promise.all([
                import(source.three),
                import(source.orbit),
                import(source.gltf),
                import(source.meshopt)
            ]);
        });
    }, Promise.reject()).then(function (parts) {
        // One-time per page: skip Skeleton.update entirely when the recomputed
        // bone matrices would be bit-identical (evidence in skeleton-dirty.js).
        installSkeletonDirtyGuard(parts[0]);
        return {
            THREE: parts[0],
            OrbitControls: parts[1].OrbitControls,
            GLTFLoader: parts[2].GLTFLoader,
            MeshoptDecoder: parts[3].MeshoptDecoder
        };
    });
    return modulePromise;
}

// Seed the manifest cache so loadManifest() never fetches the full file.
//
// plans/metroidvania.md §6.1.4 asks for asset/mv/manifest-mv.json because the
// 758 KB (now 994 KB) full manifest is "白付的" on every page open. Producing the
// subset does not by itself save anything: load(), loadClassActions() and
// core/actor.js's facial lookup all go through loadManifest(), so without a way
// to hand them the subset the page parses the megabyte anyway and the subset is
// dead weight on top of it. This is that way in.
//
// §6.5 says the Metroidvania changes no existing file but core/save.js. This is
// the exception, and it is additive: loadManifest() below is untouched, so every
// other page keeps fetching the full manifest exactly as before.
//
// Rejects a second install with different data rather than letting two pages
// disagree about what "model/player/model_pl_320005.muast" points at.
export function installManifest(manifest) {
    if (!manifest || !manifest.models) {
        throw new Error("installManifest: no models table");
    }
    if (installed && installed !== manifest) {
        throw new Error("installManifest: a different manifest is already installed");
    }
    installed = manifest;
    manifestPromise = Promise.resolve(manifest);
    return manifest;
}

export function loadManifest() {
    if (manifestPromise) {
        return manifestPromise;
    }
    manifestPromise = fetch(assetUrl("asset/models/manifest.json?v=20260906-1")).then(function (response) {
        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }
        return response.json();
    });
    return manifestPromise;
}

// Manifest paths are relative to the site, including a GitHub Pages project
// prefix. Resolve from this module so consumers may live at any page depth.
export function assetUrl(path) {
    return new URL(String(path).replace(/^\.\.\//, "").replace(/^\//, ""),
        new URL("../", import.meta.url)).href;
}

// gzip'd GLB -> blob URL. onProgress receives a 0..1 fraction while the body
// streams, then null once we move on to decompression.
// Exported because the とっておき scenes live in their own index rather than the
// model manifest, and reimplementing the streaming + integrity check there
// would be the same code twice.
export function readModel(url, compression, onProgress) {
    return fetch(url).then(function (response) {
        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }
        const total = Number(response.headers.get("Content-Length") || 0);
        if (!total || !response.body) {
            return response.blob();
        }
        const reader = response.body.getReader();
        const chunks = [];
        let received = 0;
        function pump() {
            return reader.read().then(function (result) {
                if (result.done) {
                    // Release the lock once the body is fully read, rather than
                    // leaving the reader attached to a finished stream until GC.
                    //
                    // Note for anyone auditing the network panel: streamed reads
                    // like this one get logged as net::ERR_ABORTED on a few model
                    // fetches per page load, a different few each run. That is an
                    // accounting artefact, not a failed download -- releasing the
                    // lock here does not remove it. The bytes all arrive: the
                    // integrity check below compares the GLB's declared length
                    // against what we hold and stays quiet, and the models come out
                    // with their full mesh counts. Do not "fix" it by abandoning the
                    // streaming read, which is what reports load progress.
                    reader.releaseLock();
                    return new Blob(chunks);
                }
                received += result.value.byteLength;
                if (onProgress) {
                    onProgress(Math.min(0.99, received / total));
                }
                chunks.push(result.value);
                return pump();
            });
        }
        return pump().catch(function (error) {
            // A failed read leaves the stream locked too; cancel so the connection
            // is torn down deliberately rather than whenever GC gets to it.
            try { reader.cancel(); } catch (ignored) { /* already closed */ }
            throw error;
        });
    }).then(function (blob) {
        if (compression !== "gzip") {
            return blob;
        }
        if (!("DecompressionStream" in window)) {
            throw new Error("gzip decompression is unavailable");
        }
        if (onProgress) {
            onProgress(null);
        }
        const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
        return new Response(stream).blob();
    }).then(function (blob) {
        // A truncated body still parses far enough to render garbage, so
        // compare the GLB's own declared length against what we hold.
        if (blob.size >= 20) {
            return blob.slice(0, 20).arrayBuffer().then(function (head) {
                const view = new DataView(head);
                const magic = String.fromCharCode(
                    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
                );
                const declared = view.getUint32(8, true);
                if (magic !== "glTF" || declared !== blob.size) {
                    console.warn("GLB integrity mismatch:", magic, "declared", declared, "actual", blob.size);
                }
                return blob;
            });
        }
        return blob;
    });
}

export function readModelCached(url, compression, onProgress) {
    const resolved = new URL(url, document.baseURI).href;
    const key = String(compression || "") + ":" + resolved;
    let cached = modelBlobCache.get(key);
    if (cached) {
        modelBlobCache.delete(key);
        modelBlobCache.set(key, cached);
    } else {
        cached = { size: 0, promise: null };
        cached.promise = readModel(resolved, compression, onProgress).then(function (blob) {
            if (modelBlobCache.get(key) === cached) {
                cached.size = blob.size;
                modelBlobBytes += blob.size;
                trimModelCache();
            }
            return blob;
        }).catch(function (error) {
            // An older failed request must not remove a replacement installed
            // after clearModelCache() or an LRU eviction.
            if (modelBlobCache.get(key) === cached) {
                modelBlobCache.delete(key);
                modelBlobBytes -= cached.size;
            }
            throw error;
        });
        modelBlobCache.set(key, cached);
        trimModelCache();
    }
    return cached.promise.then(function (blob) {
        if (onProgress) { onProgress(1); }
        return blob;
    });
}

function trimModelCache() {
    while (modelBlobCache.size > MODEL_BLOB_CACHE_LIMIT || modelBlobBytes > MODEL_BLOB_CACHE_BYTES) {
        const oldest = modelBlobCache.keys().next().value;
        modelBlobBytes -= modelBlobCache.get(oldest).size;
        modelBlobCache.delete(oldest);
    }
}

export function clearModelCache() {
    modelBlobCache.clear();
    modelBlobBytes = 0;
}

// gltfpack strips mesh names, so GLTFLoader falls back to "mesh_<index>".
// The real name survives on the wrapper node around a skinned mesh.
const GENERATED_MESH_NAME = /^mesh_\d+$/;

export function resolveNodeName(node) {
    if (node.name && !GENERATED_MESH_NAME.test(node.name)) {
        return node.name;
    }
    let parent = node.parent;
    while (parent) {
        if (parent.name && !GENERATED_MESH_NAME.test(parent.name)) {
            return parent.name;
        }
        parent = parent.parent;
    }
    return node.name || "";
}

function resolveRenderOrder(mesh) {
    let node = mesh;
    while (node) {
        if (node.userData && node.userData.renderOrder !== undefined && node.userData.renderOrder !== null) {
            return Number(node.userData.renderOrder) || 0;
        }
        node = node.parent;
    }
    const geometry = mesh.geometry;
    if (geometry && geometry.userData && geometry.userData.renderOrder !== undefined) {
        return Number(geometry.userData.renderOrder) || 0;
    }
    return 0;
}

// Apply the engine's own alpha/depth rules.
//
// Body and head materials do not blend: _Mode=0 (opaque), _SrcBlend=One /
// _DstBlend=Zero, _ZWrite=1, with MsbHandler supplying an alpha test ref of
// 0.01. Blending them pushes every layer into three.js's transparent queue,
// where the first-drawn piece blends its anti-aliased edge against the
// background and then writes depth -- later layers behind it get depth-
// rejected and the edge keeps that background colour. That is the dark seam
// where a hat brim meets hair.
//
// "_outline" materials arrive flagged _Mode=3, _DstBlend=OneMinusSrcAlpha,
// _ZWrite=0, and this function used to honour that -- blending them and letting
// them skip depth, on the reading that they covered see-through pieces.
//
// They do not. In the player models `m_PL_<id>_body_outline` is the only outline
// material, and it covers the hands and sleeves: 320801's is `arm`/`armer`/
// `arm_2`/`armer_2`, 320111's is `sode`/`sode_2`/`hand`/`hand_2`. Blending them
// dropped the hands into the transparent queue while the sleeve and armour
// pieces above them stayed opaque with no alpha test to discard their empty
// texels, so the sleeves painted over the hands and characters reached the
// screen with bare wrists. That was the missing-hands bug on the ADV stage.
//
// The blend flag is vestigial: tools/survey_outline_alpha.py samples the atlas
// under the UVs of every mesh using an _outline material and finds it opaque in
// all 512 cases across 150 player models, all 19 across the enemies, and weapons
// carry no such material at all. Blending changes no pixel colour there; it only
// moves the piece into a queue where it loses. Dropping the exception recovers
// the hands -- measured on the ADV stage, 0 hand pixels before and 2227 after
// for arcive, 0 -> 255 for lamp, 0 -> 440 for kirara, with the whole-character
// pixel change essentially equal to the hands gained -- and leaves one uniform
// rule: everything opaque, alpha-tested, ordered by renderOrder. That is also
// what the engine itself does, since MsbHandler walks an ordered list rather
// than splitting opaque from transparent. It is not one list, though: a player
// ships one handler for the body and one for the head, and the real sort key is
// m_eRenderStage before m_RenderOrder before m_HieIndex. The exporter folds all
// three into extras.renderOrder -- see read_render_orders in
// tools/convert_kirafan_model.py for what dropping the stage cost.
//
// Nothing regresses for genuinely translucent materials, because this function
// already forced every non-outline material opaque; the exception was never
// what kept them blending.
export function applyMaterialRules(root, THREE, options) {
    const opts = options || {};
    const kind = opts.kind || "player";
    const depthWrite = opts.depthWrite !== false;
    // The GLB asks for LINEAR_MIPMAP_LINEAR, which is right, but mipmapping alone
    // blurs a texture the moment it is viewed at an angle: the hardware picks a
    // mip level for the worst-numbered axis, so a surface slanting away loses
    // detail along the axis that was still nearly 1:1. Anisotropic filtering
    // samples along the actual projected footprint instead. Skirt panels, sleeves
    // and the ground-facing sides of shoes are the visible beneficiaries.
    const maxAnisotropy = opts.maxAnisotropy || 0;
    // Opt-out for callers that want the atlas byte-exact (diagnostics comparing
    // against the source), and a tunable for how much of the ramp counts as
    // untrustworthy colour. 0.98 treats anything short of solid as ramp, which is
    // what the measurements on these atlases support.
    const dilateColour = opts.dilateColour;
    // Defaults match the viewer's, which are the measured ones: a floor of 0.6
    // with the repair confined to ramp texels within 2 texels of an empty one.
    // Ungated, a floor high enough to fix the silhouette rim also repaints the
    // translucency the artist painted inside surfaces and costs 38% of interior
    // gradient energy. Gated, the enemy atlas rim goes from luminance 12.7 to
    // 33.4 while detail holds at 95%. See core/texture-fringe.js and the table
    // in models.js.
    const fringeOptions = {
        alphaFloor: opts.alphaFloor === undefined ? 0.6 : opts.alphaFloor,
        emptyDistance: opts.emptyDistance === undefined ? 2 : opts.emptyDistance
    };
    const seenTextures = new Set();
    const seenColourTextures = new Set();
    // The same file is re-parsed for every unit/room instance; the dilate
    // result only depends on the atlas bytes, so number this parse's colour
    // textures deterministically and let texture-fringe reuse the finished
    // bytes across parses ("<assetKey>#<n>"). See core/texture-fringe.js.
    const fringeCache = opts.dilateCacheNamespace
        ? { namespace: opts.dilateCacheNamespace, counter: { n: 0 } }
        : null;
    root.traverse(function (child) {
        if (!child.isMesh || !child.material) {
            return;
        }
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        // The head is a stack of coplanar flat layers -- backhead, face, then
        // brows, eyes, mouth and blush painted on top -- and the engine resolves
        // them by draw order alone, because at equal depth there is nothing else
        // to resolve them by. Letting them write depth makes the first one drawn
        // veto every layer above it: on model_pl_100003 the backhead (order 5172)
        // blanked the whole face, leaving the mouth with 0 pixels on screen and
        // the face base with 867 where the same character's other model had 6438.
        //
        // Depth *testing* stays on, so the head still sits correctly against the
        // body -- a hand raised in front of the face still occludes it. Only the
        // writes come off, which is what stops the layers fighting each other.
        // Measured: 19353 px recovered on the broken model, confined to the head,
        // and 0 px changed on models that were already correct. Switching off
        // depthTest instead also fixes the face, but disturbs a further 8582 px
        // of head-against-body, which is the wrong trade.
        const layerName = resolveNodeName(child).toLowerCase();
        const isFaceLayer = /^[lr](30|60)_/.test(layerName);
        materials.forEach(function (material) {
            // Preserve the GLB culling rule before a consumer applies its own
            // presentation defaults. A negative object scale already has its
            // winding corrected by three.js; it does not change this rule.
            if (material.userData.authoredSide === undefined) {
                material.userData.authoredSide = material.side;
            }
            material.transparent = false;
            material.alphaTest = 0.01;
            material.depthWrite = isFaceLayer ? false : depthWrite;
            material.depthTest = true;
            // An alpha test is a binary keep-or-discard, and a discard is not
            // something MSAA can average -- so every alpha-tested edge came out
            // stair-stepped no matter how high the sample count. Hair strands and
            // fan ribs, which are one or two texels wide, broke up badly.
            //
            // Alpha-to-coverage was the answer to that for a long time: turn the
            // texture's alpha into MSAA coverage and let the multisample buffer
            // resolve the edge. Measurement retired it. The canvas has 4 samples,
            // so coverage only has 5 levels (0/25/50/75/100%), which is coarser
            // than the 8-bit ramp the artist painted -- it adds quantisation
            // noise to the edge instead of smoothing it.
            //
            // Rendering one frozen pose twice, once at the shipping sample rate
            // and once 3x3-supersampled then box-downsampled onto the same grid,
            // gives the converged answer; the difference is undersampling, and
            // undersampling is what shimmers once the pose moves:
            //   model_en_7000 idle   a2c on  MAE 3.43, 1208 px off by >40
            //                        a2c off MAE 2.61,  383 px off by >40
            // The error concentrates on hair and feet, which is where the flicker
            // was reported. Turning it off does not change the picture: the two
            // modes converge to the same image (luminance MAE 0.23, silhouette
            // MAE 0.0020, interior solidity 0.9054 vs 0.9046), so a2c's whole
            // effect at 1x was noise. Scored against a2c's own supersampled
            // baseline, to avoid grading a mode against itself, off still wins:
            // 2.71 vs 3.43. See the long note in models.js for the blending and
            // alphaTest=0.5 variants, both of which were rejected.
            material.alphaToCoverage = false;
            // Weapons carry their cartoon outline as an inverted hull mapped to
            // a black texel, so they must cull back faces or the shell hides
            // the weapon. Characters stay double-sided because mirrored
            // left/right pieces have no reliable GLB winding direction.
            material.side = kind === "weapon" ? THREE.FrontSide : THREE.DoubleSide;
            if (maxAnisotropy > 1) {
                ["map", "emissiveMap", "alphaMap"].forEach(function (slot) {
                    const texture = material[slot];
                    // Textures are shared between materials, so guard against
                    // re-flagging one and forcing needless re-uploads.
                    if (texture && !seenTextures.has(texture)) {
                        seenTextures.add(texture);
                        texture.anisotropy = maxAnisotropy;
                        texture.needsUpdate = true;
                    }
                });
            }
            // Repair the alpha ramp's colour so the 0.01 cutoff cannot magnify
            // near-transparent black into an outline around hair and mouths.
            // See core/texture-fringe.js for the measurements.
            if (dilateColour !== false) {
                dilateMaterialTextures(material, THREE, fringeOptions, seenColourTextures, fringeCache);
            }
        });
        child.renderOrder = resolveRenderOrder(child);
        // Skinned vertices follow their bones, but frustum culling uses the
        // node's bounding sphere, which stays at the skeleton origin in these
        // exports -- zooming onto a face culled the eyes, brows and mouth.
        if (child.isSkinnedMesh) {
            child.frustumCulled = false;
        }
    });
}

const objectUrls = [];

// Load one asset key from the manifest (e.g. "model/player/model_pl_140106.muast").
// Returns { scene, animations, entry }. Materials are already corrected.
export function load(assetKey, options) {
    const opts = options || {};
    return Promise.all([loadModules(), loadManifest()]).then(function (parts) {
        const modules = parts[0];
        const manifest = parts[1];
        const entry = manifest.models[assetKey];
        if (!entry) {
            throw new Error("asset not in manifest: " + assetKey);
        }
        return readModelCached(assetUrl(entry.file), entry.compression, opts.onProgress).then(function (blob) {
            return blob.arrayBuffer();
        }).then(function (buffer) {
            const loader = new modules.GLTFLoader();
            if (entry.meshopt) {
                loader.setMeshoptDecoder(modules.MeshoptDecoder);
            }
            return new Promise(function (resolve, reject) {
                loader.parse(buffer, "", resolve, reject);
            }).then(function (gltf) {
                applyMaterialRules(gltf.scene, modules.THREE, {
                    kind: opts.kind || assetKey.split("/")[1],
                    depthWrite: entry.depthWrite,
                    maxAnisotropy: opts.maxAnisotropy,
                    dilateCacheNamespace: assetKey
                });
                return { scene: gltf.scene, animations: gltf.animations || [], entry: entry };
            });
        });
    });
}

// Load a class-action bundle: the shared idle/attack/class_skill_1..3 clips
// for a class + head combination. These are what make the RPG's battle
// animations free -- they map one-to-one onto the original command layout.
export function loadClassActions(classId, headId) {
    return Promise.all([loadModules(), loadManifest()]).then(function (parts) {
        const modules = parts[0];
        const manifest = parts[1];
        const key = String(classId) + ":" + String(headId || 0);
        const entry = (manifest.classActions || {})[key]
            || (manifest.classActions || {})[String(classId) + ":0"];
        if (!entry) {
            throw new Error("no class actions for " + key);
        }
        return readModelCached(assetUrl(entry.file), entry.compression).then(function (blob) {
            return blob.arrayBuffer();
        }).then(function (buffer) {
            const gltfLoader = new modules.GLTFLoader();
            if (entry.meshopt) {
                gltfLoader.setMeshoptDecoder(modules.MeshoptDecoder);
            }
            return new Promise(function (resolve, reject) {
                gltfLoader.parse(buffer, "", resolve, reject);
            });
        }).then(function (gltf) {
            const actions = {
                animations: gltf.animations || [], names: entry.animations || [],
                sourceRoot: gltf.scene
            };
            return actions;
        });
    });
}

export function disposeObject(object) {
    const geometries = new Set();
    const skeletons = new Set();
    const materials = new Set();
    const textures = new Set();
    object.traverse(function (child) {
        if (child.geometry) {
            geometries.add(child.geometry);
        }
        if (child.skeleton) {
            skeletons.add(child.skeleton);
        }
        if (!child.material) {
            return;
        }
        (Array.isArray(child.material) ? child.material : [child.material]).forEach(function (material) {
            materials.add(material);
            Object.keys(material).forEach(function (key) {
                const value = material[key];
                if (value && value.isTexture) {
                    textures.add(value);
                }
            });
        });
    });
    geometries.forEach(function (geometry) { geometry.dispose(); });
    skeletons.forEach(function (skeleton) { skeleton.dispose(); });
    textures.forEach(function (texture) { texture.dispose(); });
    materials.forEach(function (material) { material.dispose(); });
}

// Floor-entry warmup: run load() once per asset key in the background and
// throw the parsed scene away. That leaves the decompressed GLB in
// readModelCached's LRU and the dilated colour bytes in the per-asset
// fringe cache, so the first room that actually spawns the model parses
// from memory instead of paying network + inflate on its critical path
// (attemptRoomLoad awaits the strict enemy load before revealing a room).
// Serial on purpose: one parse at a time bounds the CPU spike while the
// player is already playing. Failures are transparent — the on-demand path
// works exactly as before — and a failed key forgets its mark so a later
// warm (next floor) can retry. Already-warmed keys are skipped, so a warm
// overlapping an in-flight room load just no-ops through the shared blob
// promise and re-parses at most once.
const warmedModels = new Set();
export function warmModels(assetKeys) {
    return loadModules().then(function () {
        const list = [];
        (assetKeys || []).forEach(function (key) {
            if (typeof key === "string" && key && !warmedModels.has(key)) {
                warmedModels.add(key);
                list.push(key);
            }
        });
        return list.reduce(function (chain, key) {
            return chain.then(function () {
                return load(key).then(function (loaded) {
                    disposeObject(loaded.scene);
                }).catch(function () {
                    warmedModels.delete(key);
                });
            });
        }, Promise.resolve());
    });
}

export function revokeUrls() {
    while (objectUrls.length) {
        URL.revokeObjectURL(objectUrls.pop());
    }
}
