// Native templates own geometry; live instances own material/UV state only.
// Ref-counted LRU eviction cannot dispose a building/effect still on screen.
import { loadSceneEntry, applySceneState, disposeScene } from "../../../core/uniqueskill.js";

const ROOT = new URL("../../../", import.meta.url);
const INDEX = new URL("asset/rl/native/index.json", ROOT);
const templates = new Map();
const CACHE_LIMIT = 48;
let indexPromise = null, indexReady = false, serial = 0;

export function loadNativeIndex() {
    if (!indexPromise) {
        const request = fetch(INDEX).then(response => {
            if (!response.ok) { throw new Error("native asset index " + response.status); }
            return response.json();
        }).then(index => {
            if (indexPromise !== request) throw new Error('原作素材目录请求已失效');
            indexReady = true;
            return index;
        }).catch(error => { if (indexPromise === request) indexPromise = null; throw error; });
        indexPromise = request;
    }
    return indexPromise;
}

function trimCache() {
    const unused = Array.from(templates.values()).filter(r => r.ready && r.refs === 0)
        .sort((a, b) => a.stamp - b.stamp);
    while (templates.size > CACHE_LIMIT && unused.length) {
        const record = unused.shift(), template = record.value;
        templates.delete(record.key);
        template.root.userData.emitters = template.emitters;
        disposeScene(template.root, template.THREE);
    }
}

function request(kind, key, index, entryOverride) {
    const cacheKey = kind + ":" + key;
    if (templates.has(cacheKey)) { return templates.get(cacheKey); }
    const entry = entryOverride || (index[kind] && index[kind][key]);
    if (!entry) { throw new Error("native asset missing: " + cacheKey); }
    const record = { key: cacheKey, refs: 0, stamp: ++serial, ready: false };
    let pendingScene = null, invalidated = false;
    function invalidate() {
        invalidated = true;
        if (!pendingScene) return;
        const loaded = pendingScene;
        pendingScene = null;
        disposeScene(loaded.scene, loaded.modules.THREE);
    }
    const cancelled = new Promise((resolve, reject) => {
        record.cancel = () => {
            invalidate();
            reject(new Error('原作素材请求已取消：' + cacheKey));
        };
    });
    const work = Promise.all([
        loadSceneEntry(entry).then(loaded => {
            if (invalidated || templates.get(cacheKey) !== record) {
                disposeScene(loaded.scene, loaded.modules.THREE);
                throw new Error('原作素材请求已失效：' + cacheKey);
            }
            // Own a partial scene immediately, even while its timeline is pending.
            pendingScene = loaded;
            return loaded;
        }),
        entry.timeline ? fetch(new URL(entry.timeline, ROOT)).then(response => {
            if (!response.ok) { throw new Error("native timeline " + response.status); }
            return response.json();
        }) : Promise.resolve(null)
    ]).then(([loaded, timeline]) => {
        if (invalidated || templates.get(cacheKey) !== record) {
            throw new Error('原作素材请求已失效：' + cacheKey);
        }
        const root = loaded.scene;
        // Resolved THREE materials are not serializable Object3D userData.
        // Keep them on the template record; clones get their own copies below.
        const emitters = root.userData.emitters || [];
        delete root.userData.emitters;
        record.value = { root, emitters, timeline, entry, THREE: loaded.modules.THREE };
        pendingScene = null;
        record.ready = true;
        record.cancel = null;
        return record.value;
    });
    record.promise = Promise.race([work, cancelled]).catch(error => {
        invalidate();
        if (templates.get(cacheKey) === record) templates.delete(cacheKey);
        throw error;
    });
    templates.set(cacheKey, record);
    return record;
}

export async function preloadNative(kind, keys) {
    const index = await loadNativeIndex();
    await Promise.all(Array.from(new Set(keys)).map(key => request(kind, key, index).promise));
    trimCache();
}

const ENEMY_ATTACKS = new URL("asset/rl/native/enemy-attacks.json", ROOT);
let enemyAttacksPromise = null;

// The enemy attack map (enemy-attacks.json) is a separate authored table:
// skill action -> ef_btl_dmg_enemy_attack_<kind>_<grade>. Resolved on demand
// so the main index stays the player/town catalogue.
export function loadEnemyAttacks() {
    if (!enemyAttacksPromise) {
        const request = fetch(ENEMY_ATTACKS).then(response => {
            if (!response.ok) { throw new Error("enemy attack map " + response.status); }
            return response.json();
        }).catch(error => { if (enemyAttacksPromise === request) enemyAttacksPromise = null; throw error; });
        enemyAttacksPromise = request;
    }
    return enemyAttacksPromise;
}

export async function acquireEnemyAttack(effect) {
    const map = await loadEnemyAttacks();
    const entry = map.effects && map.effects[effect];
    if (!entry) { throw new Error("enemy attack effect missing: " + effect); }
    const index = await loadNativeIndex();
    const record = request("effects", effect, index, entry);
    record.refs++; record.stamp = ++serial;
    let template;
    try { template = await record.promise; }
    catch (error) { record.refs--; throw error; }
    return instantiate(record, template);
}

export async function acquireNative(kind, key) {
    const index = await loadNativeIndex();
    const record = request(kind, key, index);
    record.refs++; record.stamp = ++serial;
    let template;
    try { template = await record.promise; }
    catch (error) { record.refs--; throw error; }
    return instantiate(record, template);
}

function instantiate(record, template) {
    const root = template.root.clone(true);
    const materials = new Set(), textures = new Set();
    function ownMaterial(source) {
        const material = source.clone();
        // UV animation and layered shaders must not share the template's maps.
        for (const property of ["map", "alphaMap"]) {
            if (source[property]) {
                material[property] = source[property].clone();
                material.userData["__usOwn_" + property] = true;
                textures.add(material[property]);
            }
        }
        materials.add(material);
        return material;
    }
    root.traverse(node => {
        if (!node.isMesh || !node.material) { return; }
        node.material = Array.isArray(node.material) ? node.material.map(ownMaterial) : ownMaterial(node.material);
        node.userData.__usOwnMaterials = true;
    });
    root.userData.emitters = template.emitters.map(spec => ({ ...spec,
        resolvedMaterial: spec.resolvedMaterial ? ownMaterial(spec.resolvedMaterial) : null }));
    applySceneState(root, template.THREE);
    let disposed = false;
    return { root, timeline: template.timeline, entry: template.entry,
        dispose() {
            if (disposed) { return; } disposed = true;
            root.removeFromParent();
            materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
            record.refs--; record.stamp = ++serial;
            trimCache();
        }
    };
}

export function nativeCacheStats() {
    return { templates: templates.size, refs: Array.from(templates.values()).reduce((n, r) => n + r.refs, 0) };
}

// Ready templates may be referenced by the visible room. Only detach pending
// records: late loads will dispose themselves instead of publishing stale data.
export function retryNativeRequests() {
    if (!indexReady) indexPromise = null;
    for (const [key, record] of templates) if (!record.ready) { templates.delete(key); record.cancel(); }
}
