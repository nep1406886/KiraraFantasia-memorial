// Meige cinematic texture layers. Geometry has already converted V to 1-V.
// Keep these transforms separate from the per-object diffuse/mesh colour.

export function textureState(texture) {
    const source = texture || {};
    return {
        coverage: (source.coverageUV || [1, 1]).slice(),
        translation: (source.translationUV || [0, 0]).slice(),
        offset: (source.offsetUV || [0, 0]).slice(),
        rotate: source.rotateUV || 0
    };
}

// SearchTexIndex binds by texture type AND layer, not by array position.
export function textureProperty(material, type, layer) {
    if (type !== 0) { return null; }
    if (layer === 0) { return "map"; }
    const msb = material.userData.msb || {};
    return layer === 1 && msb.layerTexture ? "alphaMap" : null;
}

export function ownTexture(material, property) {
    const flag = "__usOwn_" + property;
    if (material[property] && !material.userData[flag]) {
        material[property] = material[property].clone();
        material.userData[flag] = true;
    }
    return material[property];
}

// MsbTextureParam.UpdateParam, followed by F * M * F because the GLB and
// texture upload use top-left UVs while Unity's shader samples bottom-left UVs.
// Scratch matrices are reused; sampling a frame allocates no matrix objects.
export function createUvWriter(THREE) {
    const rotation = new THREE.Matrix3();
    const temporary = new THREE.Matrix3();
    function translation(x, y) {
        return temporary.set(1, 0, x, 0, 1, y, 0, 0, 1);
    }
    return function (texture, state) {
        if (!texture) { return; }
        const u = state.coverage[0] !== 0 ? 1 / state.coverage[0] : 1;
        const v = state.coverage[1] !== 0 ? 1 / state.coverage[1] : 1;
        const angle = state.rotate * Math.PI / 180;
        const c = Math.cos(angle), s = Math.sin(angle);
        rotation.set(c, -s, 0, s, c, 0, 0, 0, 1);
        const matrix = texture.matrix;
        matrix.set(u, 0, 0, 0, v, 0, 0, 0, 1);
        matrix.multiply(translation(-0.5 * u, 0.5 * v));
        matrix.multiply(rotation);
        matrix.multiply(translation(0.5 * u, -0.5 * v));
        matrix.multiply(translation(c * state.offset[0] - s * state.offset[1],
            s * state.offset[0] + c * state.offset[1]));
        matrix.multiply(translation(-c * state.translation[0] + s * state.translation[1],
            -s * state.translation[0] - c * state.translation[1]));
        temporary.set(1, 0, 0, 0, -1, 1, 0, 0, 1);
        matrix.premultiply(temporary).multiply(temporary);
        texture.matrixAutoUpdate = false;
    };
}

// Literal layer equations from the original unlit Meige shader. In particular,
// its RGB multiply mode includes source alpha, while alpha add/sub do not.
function layerExpression(mode, alpha) {
    const source = alpha ? "usLayer.a" : "usLayer.rgb";
    const dest = alpha ? "usBase.a" : "usBase.rgb";
    switch (mode) {
    case 0:
    case 1: return (alpha ? source : source + " * usLayer.a") + " + " + dest + " * (1.0 - usLayer.a)";
    case 2: return (alpha ? source : source + " * usLayer.a") + " + " + dest;
    case 3: return dest + " - " + (alpha ? source : source + " * usLayer.a");
    case 4: return dest + " * " + source + (alpha ? "" : " * usLayer.a");
    case 5: return source;
    case 6: return dest;
    default: throw new Error("Unsupported Meige texture layer blend: " + mode);
    }
}

export function layerColorExpression(material) {
    const msb = material.userData.msb || {};
    const layer = (msb.textures || []).find(function (t) { return t.type === 0 && t.layer === 1; });
    if (!layer) { throw new Error("Missing Meige layer identity: " + material.name); }
    return "vec4(" + layerExpression(layer.layerBlendMode, false) + ", "
        + layerExpression(layer.layerBlendModeAlpha, true) + ")";
}

export function prepareLayerMaterial(material) {
    const msb = material.userData.msb || {};
    if (!msb.layerTexture) { return; }
    if (!material.map || !material.alphaMap) {
        throw new Error("Missing independent texture layer: " + material.name);
    }
    const expression = layerColorExpression(material);
    // alphaMap is the raw RGBA second layer, NOT three.js's green-channel
    // opacity mask. Reuse its independent UV attribute/matrix and sampler, but
    // replace both texture chunks so no extra alpha multiplication takes place.
    material.onBeforeCompile = function (shader) {
        shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", [
            "vec4 usBase = texture2D(map, vMapUv);",
            "vec4 usLayer = texture2D(alphaMap, vAlphaMapUv);",
            "diffuseColor *= " + expression + ";"
        ].join("\n")).replace("#include <alphamap_fragment>", "");
    };
    material.customProgramCacheKey = function () {
        return "meige-layer-v1:" + expression;
    };
    material.needsUpdate = true;
}

export function applyTextureState(material, writeUv) {
    const msb = material.userData.msb || {};
    (msb.textures || []).forEach(function (texture) {
        const property = textureProperty(material, texture.type || 0, texture.layer || 0);
        if (property) { writeUv(ownTexture(material, property), textureState(texture)); }
    });
    prepareLayerMaterial(material);
}
