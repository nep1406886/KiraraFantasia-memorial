// Original WeaponList identity. Items reference a stage; values stay in the catalog.
let byId = new Map();
let genericByClass = new Map();
let dedicatedByChara = new Map();
export const OFF_CLASS_PROFICIENCY = 0.65;

export function setWeaponCatalog(rows) {
    byId = new Map();
    genericByClass = new Map();
    dedicatedByChara = new Map();
    for (const row of rows || []) {
        byId.set(row.id, row);
        const groups = row.charaId > 0 ? dedicatedByChara : genericByClass;
        const key = row.charaId > 0 ? row.charaId : row.class;
        if (!groups.has(key)) { groups.set(key, []); }
        groups.get(key).push(row);
    }
}

export function weaponDefinition(item) {
    if (!item || item.catalogId === undefined) { return null; }
    const row = byId.get(item.catalogId);
    if (!row || item.slot !== "weapon" || item.weaponId !== undefined) {
        throw new Error("equipment: invalid weapon catalog reference " + item.catalogId);
    }
    return row;
}

export function canEquipWeapon(item, card) {
    try {
        const row = weaponDefinition(item);
        // Generic weapons are usable by every class. Dedicated stages still
        // belong to their original card; changing this must not transfer skills.
        return !row || !!card && (row.charaId < 0 || row.charaId === card.id);
    } catch (_) { return false; }
}

export function weaponProficiency(item, card) {
    const row = weaponDefinition(item);
    return row && card && row.class !== card.class ? OFF_CLASS_PROFICIENCY : 1;
}

export function weaponAffixes(item) {
    const row = weaponDefinition(item);
    const ids = (item && item.affixes) || [];
    if (!row || row.passiveId < 0) { return ids; }
    // Native identity is read last, and is never multiplied by a duplicate roll.
    const id = String(row.passiveId);
    return ids.filter(value => value !== id).concat(id);
}

export function rollWeapon(rng, floor, rarity, card) {
    if (!card || !byId.size) { return null; }
    let generic = genericByClass.get(card.class) || [];
    if (!generic.length) { return null; }
    if (rarity === "legendary") {
        const stages = (dedicatedByChara.get(card.id) || []).filter(row => row.class === card.class
            && row.evolution <= Math.min(4, Math.max(0, Math.floor((floor - 1) / 4))));
        if (stages.length) {
            return stages.reduce((best, row) => row.evolution > best.evolution ? row : best);
        }
    }
    // Most drops suit the card; one in five offers a deliberate off-class build.
    if (rng() < 0.2) {
        const other = [...genericByClass].filter(([id]) => id !== card.class).flatMap(([, rows]) => rows);
        if (other.length) { generic = other; }
    }
    const stars = rarity === "common" ? 3 : 4;
    const pool = generic.filter(row => row.rare === stars);
    return (pool.length ? pool : generic)[Math.floor(rng() * (pool.length || generic.length))];
}
