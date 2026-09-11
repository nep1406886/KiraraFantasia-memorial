// T22m model rules: bring the game's material handling up to the measured
// state models.html (models.js) reached — the observation room the user
// compares against. core/loader.js is a peer-owned snapshot with an older
// cut of the rules, and its gaps read on screen as the user reported them:
// "错位和边缘粗" — layering/depth from the name heuristic instead of the
// authored per-material truth, and hard cutout edges instead of the alpha
// blend. Nothing here rewrites the loader: views call applyModelRules()
// right after loader.load() and the rules ride on top.
//
// Everything in here is measurement-proven in models.js; the compressed
// reasons live with each rule. The numbered models.html measurements:
//   - en_7000 head edge dark pixels 2482 (cutout) → 3 (alpha blend)
//   - pl_140000 arm 506 → 4017 visible px once _DepthWrite truth is used
//   - msbVisible=false: EN_flash / EN_blur / spare hands are drawn forever
//     unless hidden — the "闪烁 / 黑边很重" report on enemies
//   - fringe dilation: alpha ramp texels near-empty ones are untrustworthy
//     black; pushing colour into them kills the dark rim (en_7000 rim
//     luminance 12.7 → 33.4, interior detail 95% kept)

import { resolveNodeName } from "../../../core/loader.js";

// materials.js:1470 — the five-feature overlay set drawn ON TOP of the face
// base. models.html renders these as alpha-blended decals that do not write
// depth (the backhair draws after them and must stay able to cover them).
const FACE_PART_NAME = /(^|_)(eye|eyebrow|eyebrrow|eyeblow|mouth|cheek)(_|$)/i;

const BLEND_FACTORS = {
    Zero: "ZeroFactor",
    One: "OneFactor",
    DstColor: "DstColorFactor",
    SrcColor: "SrcColorFactor",
    OneMinusDstColor: "OneMinusDstColorFactor",
    SrcAlpha: "SrcAlphaFactor",
    OneMinusSrcColor: "OneMinusSrcColorFactor",
    DstAlpha: "DstAlphaFactor",
    OneMinusDstAlpha: "OneMinusDstAlphaFactor",
    OneMinusSrcAlpha: "OneMinusSrcAlphaFactor"
};

// The blend equation the shader actually binds: _BlendSrc/_BlendDst are the
// live pair (Standard-shader _SrcBlend/_DstBlend are leftovers the pass never
// reads). Materials without the keys keep NormalBlending behaviour via the
// Std fallback — which is what every currently-exported player/enemy
// material resolves to anyway (models.js blend_census).
function applyAuthoredBlend(THREE, material) {
    const data = material.userData || {};
    const src = BLEND_FACTORS[data.blendSrc];
    const dst = BLEND_FACTORS[data.blendDst];
    const additive = data.blendDst === "One";
    if (!src && !dst) {
        material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.SrcAlphaFactor;
        material.blendDst = THREE.OneMinusSrcAlphaFactor;
        material.blendSrcAlpha = THREE.OneFactor;
        material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
        material.blendEquationAlpha = THREE.AddEquation;
        return;
    }
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE[src] !== undefined ? THREE[src] : THREE.SrcAlphaFactor;
    material.blendDst = THREE[dst] !== undefined ? THREE[dst] : THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = additive ? THREE.ZeroFactor : THREE.OneFactor;
    material.blendDstAlpha = additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
    material.blendEquationAlpha = THREE.AddEquation;
}

// The billboard always faces the camera. Three.js already reverses front-face
// winding for a negative world determinant, so an X mirror does not require
// DoubleSide. Forcing it draws the backs of boots and skirts over the front.
// The loader preserves authoredSide before applying its legacy defaults.
export function createMirrorSideManager(THREE) {
    const authored = new WeakMap();
    return {
        sync: function (root) {
            root.traverse(function (node) {
                if (!node.isMesh || !node.material) {
                    return;
                }
                const mats = Array.isArray(node.material) ? node.material : [node.material];
                mats.forEach(function (m) {
                    if (m.userData.faceDecal) { return; }   // decal rule owns itself
                    if (!authored.has(m)) { authored.set(m, m.userData.authoredSide ?? m.side); }
                    m.side = m.userData.weaponPart ? THREE.FrontSide : authored.get(m);
                });
            });
        }
    };
}

export function applyModelRules(root, THREE, options) {
    const opts = options || {};
    const kind = opts.kind || "player";
    // T22m-4: anisotropic filtering — models.html always raises it to the
    // adapter max. The rig's ~54° pitch views skirt/sleeve/ground-facing
    // faces at extreme angles where trilinear mipming blurs them; aniso
    // samples the real projected footprint instead.
    const maxAniso = opts.maxAnisotropy || 0;
    const seenTextures = new Set();
    const decals = new Map();
    root.traverse(function (child) {
        if (!child.isMesh || !child.material) {
            return;
        }
        // models.js:4365 — enemies carry complete duplicate visual sets the
        // game hides at runtime: side-view battle poses (SIDE_*), the L60/R60
        // profile silhouettes, and the damage/flash/blur effect shells the
        // report read as 闪烁 and 黑边. The view always faces the camera.
        const loweredName = String(resolveNodeName(child) || "").toLowerCase();
        if (kind === "enemy") {
            const faceOnly = loweredName.indexOf("l30_") === 0;
            if ((/^[lrt]\d+_/.test(loweredName) && !faceOnly)
                || (!faceOnly && /(damage|abnormal|flash|blur)/.test(loweredName))
                || /^side_/i.test(loweredName)) {
                child.visible = false;
            }
        }
        // models.js:4703 — m_Src.m_bVisibility: the game ships these meshes
        // switched OFF (spare hands/mouths/brows on players, EN_flash on
        // enemies). The old export ignored the flag; the converter now writes
        // node.extras.msbVisible and the view must honour it.
        if (child.userData && child.userData.msbVisible === false
                && !child.userData.visibilityGoverned) {
            child.visible = false;
        }
        // models.js:4711 — frustum culling uses the node's bounding sphere,
        // which stays at the skeleton origin for these exports; skinned
        // pieces must never be culled.
        if (child.isSkinnedMesh) {
            child.frustumCulled = false;
        }
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        const nodeName = String(resolveNodeName(child) || "");
        const isFaceOverlay = FACE_PART_NAME.test(nodeName)
            && !child.userData.facePart;
        // Weapon parts ride the actor tree too (core/actor.js equips them on
        // the Loc_/Weapon_ sockets). models.html's weapon rule differs from
        // the character rule in exactly two states: FrontSide always (the
        // cartoon outline is an inverted hull mapped to a black texel —
        // DoubleSide paints the shell over the weapon), and alphaTest only
        // when the material writes depth (models.js 3737-3741).
        let isWeaponPart = false;
        for (let parent = child.parent; parent; parent = parent.parent) {
            const pn = String(parent.name || "");
            if (pn === "Loc_L" || pn === "Loc_R"
                || pn.indexOf("Weapon_") === 0) {
                isWeaponPart = true;
                break;
            }
        }
        materials.forEach(function (material) {
            if (material.userData.authoredSide !== undefined) {
                material.side = material.userData.authoredSide;
            }
            if (maxAniso > 1) {
                ["map", "emissiveMap", "alphaMap"].forEach(function (slot) {
                    const texture = material[slot];
                    if (texture && !seenTextures.has(texture)) {
                        seenTextures.add(texture);
                        texture.anisotropy = maxAniso;
                        texture.needsUpdate = true;
                    }
                });
            }
            if (isFaceOverlay) {
                let decal = decals.get(material);
                if (!decal) {
                    decal = material.clone();
                    decal.transparent = false;
                    decal.blending = THREE.CustomBlending;
                    decal.blendSrc = THREE.SrcAlphaFactor;
                    decal.blendDst = THREE.OneMinusSrcAlphaFactor;
                    decal.blendSrcAlpha = THREE.OneFactor;
                    decal.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
                    decal.blendEquationAlpha = THREE.AddEquation;
                    decal.alphaToCoverage = false;
                    decal.alphaTest = 0.004;
                    decal.depthWrite = false;
                    decal.depthTest = true;
                    decal.userData.faceDecal = true;
                    decals.set(material, decal);
                }
                child.material = decal;
                return;
            }
            if (isWeaponPart) {
                material.side = THREE.FrontSide;
                // createMirrorSideManager keys off this mark to keep weapons
                // FrontSide across mirror flips (models.html's isWeaponMaterial).
                material.userData.weaponPart = true;
            }
            // Depth truth is per-material authored (the exporter folds the
            // stage rule into material.userData.depthWrite): arms/hands write
            // depth so later hair cannot paint over a nearer arm; body/hair
            // layers do not so coplanar fringe can cover the face. The loader
            // already honoured the manifest-level flag but not this one —
            // name-heuristic fallback only, which put whole fleets on the
            // wrong side (1455 of 1479 enemy materials disagree with the name
            // heuristic).
            const matUserData = material.userData || {};
            if (typeof matUserData.depthWrite === "boolean") {
                material.depthWrite = matUserData.depthWrite;
            }
            // Alpha blend in the opaque queue (models.js 4417-4516): the
            // painter's alpha ramp IS the anti-aliasing — one texel ≈ one
            // phone pixel there, while here a texel covers ~3 device pixels,
            // so the cutout turn of the ramp reads as a 3px dark rim ("边缘
            // 粗"). Keeping transparent=false holds renderOrder as the sort
            // key; CustomBlending survives in the opaque queue where
            // NormalBlending would be crushed to NoBlending.
            //
            // The 0.01 cutoff STAYS on every non-decal material. Dropping it
            // (alphaTest=0) was tried and reverted 2026-09-05: the ramp's
            // near-zero texels then blended as near-transparent and ATE thin
            // structures — 花小泉杏 lost her hair tips (a flat horizontal cut
            // across the crown) and the calves/feet behind her skirt. models.
            // html's blend fix was about the equation for texels ABOVE the
            // cutoff, never about removing the cutoff itself.
            material.transparent = false;
            material.blending = THREE.CustomBlending;
            material.blendSrc = THREE.SrcAlphaFactor;
            material.blendDst = THREE.OneMinusSrcAlphaFactor;
            material.blendSrcAlpha = THREE.OneFactor;
            material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
            material.blendEquationAlpha = THREE.AddEquation;
            applyAuthoredBlend(THREE, material);
            material.alphaToCoverage = false;
            material.alphaTest = 0.01;
            material.depthTest = true;
            // The authored draw order also decides weapon-vs-character:
            // wpn bundles number themselves into the character's own
            // sequence (models.js 3751-3761) — leave renderOrder alone.
        });
    });
}
