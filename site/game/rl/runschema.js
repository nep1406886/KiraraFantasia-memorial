// Run-snapshot schema for T24 (spec/07 §6): 版本化存档与可复现种子.
//
//   parseRunSnapshot(raw, floorsPerVolume) → normalized snapshot|null
//   layoutSeedFor(seed, floor) → uint32 layout stream seed
//
// This module is pure logic (no DOM, no three.js) so the acceptance harness
// can pin down exactly what the game accepts. main.js only adds the browser
// pieces (URL parsing and crypto.getRandomValues) on top of it.
//
// Snapshot shape (schemaVersion 3, v1/v2 migrate with empty room claims):
//   {
//     schemaVersion: 3,
//     generatorVersion: "t24-1",
//     seed: uint32,
//     volume: 1–5, floor: 1–floorsPerVolume,
//     cardId: >0, level: ≥1, exp: ≥0, hp: ≥1, gauge: ≥0, coin: ≥0,
//     stackHits: ≥0, stackKills: ≥0,
//     equipment: at most one item per slot; each item is
//       { slot: weapon|amulet|armor|charm,
//         rarity: common|rare|epic|legendary,
//         affixes: string[],
//         weaponId?: legacy passive key, catalogId?: positive WeaponList id }
//   }
//
// Legacy saves (schemaVersion missing, the pre-T24 field set) are migrated
// on read: the old fixed-string seed is hashed into a uint32 so the restore
// stays deterministic. The next saveRun() writes the migrated v2 envelope;
// if that write never happens the same hash is derived again on next boot.

import { hash32 } from "./random.js";
import { gadgetDefinition } from './gadgets.js';
import { SUPPLY_CHOICES } from './roomevents.js';

export const RUN_SCHEMA_VERSION = 3;
export const RUN_GENERATOR_VERSION = "t24-1";

const SLOTS = ["weapon", "amulet", "armor", "charm"];
const RARITIES = ["common", "rare", "epic", "legendary"];

export function isUint32(v) {
    return typeof v === "number" && isFinite(v)
        && v >= 0 && v <= 0xFFFFFFFF && Math.floor(v) === v;
}

// The pre-T24 fixed string, hashed once. This is the deterministic migration
// target for a v1 snapshot; it must stay byte-for-byte stable forever.
export function legacySeedFor(volume) {
    return hash32("百物語の残页 vol." + volume + " floor 1");
}

export function layoutSeedFor(seed, floor) {
    return hash32(String(isUint32(seed) ? seed >>> 0 : 0) + ":layout:" + floor);
}

function isFiniteNumber(v) {
    return typeof v === "number" && isFinite(v);
}

function validateEquipment(list, uniqueSlots = true) {
    if (!Array.isArray(list)) { return null; }
    const out = [];
    const used = new Set();
    for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!item || typeof item !== "object"
                || SLOTS.indexOf(item.slot) < 0
                || RARITIES.indexOf(item.rarity) < 0
                || (uniqueSlots && used.has(item.slot))
                || !Array.isArray(item.affixes)
                || item.affixes.some(function (a) { return typeof a !== "string"; })) {
            return null;
        }
        if (item.weaponId !== undefined
                && !(typeof item.weaponId === "string" && item.weaponId)
                && !(isUint32(item.weaponId) && item.weaponId > 0)) {
            return null;
        }
        if (item.catalogId !== undefined && (!isUint32(item.catalogId) || !item.catalogId
                || item.slot !== "weapon" || item.weaponId !== undefined)) { return null; }
        try { gadgetDefinition(item); } catch (_) { return null; }
        used.add(item.slot);
        out.push(Object.assign({}, item, { affixes: item.affixes.slice() }));
    }
    return out;
}

function validateRoomClaims(list) {
    if (!Array.isArray(list) || list.length > 64) { return null; }
    const used = new Set();
    const out = [];
    for (const row of list) {
        if (!row || !isUint32(row.id) || row.id >= 64 || used.has(row.id)) { return null; }
        used.add(row.id);
        const claim = { id: row.id };
        for (const key of ["chestOpened", "altarUsed", "rested", "npcTalked"]) {
            if (row[key] !== undefined && typeof row[key] !== "boolean") { return null; }
            claim[key] = !!row[key];
        }
        const barrels = row.barrels === undefined ? [] : row.barrels;
        if (!Array.isArray(barrels) || barrels.length > 16
                || barrels.some(id => !isUint32(id) || id >= 16)
                || new Set(barrels).size !== barrels.length) { return null; }
        claim.barrels = barrels.slice();
        if (row.supply !== undefined) {
            if (!SUPPLY_CHOICES.includes(row.supply) || !claim.rested) { return null; }
            claim.supply = row.supply;
        }
        if (row.offer !== undefined) {
            if (!Array.isArray(row.offer) || row.offer.length !== 3) { return null; }
            claim.offer = [];
            for (const entry of row.offer) {
                if (!entry || !isUint32(entry.price) || typeof entry.bought !== "boolean") { return null; }
                const items = entry.item === null ? [] : validateEquipment([entry.item], false);
                if (!items) { return null; }
                claim.offer.push({ item: items[0] || null, price: entry.price, bought: entry.bought });
            }
        }
        if (row.cleared !== undefined) {
            if (typeof row.cleared !== 'boolean') { return null; }
            if (row.cleared) { claim.cleared = true; }
        }
        if (row.drops !== undefined) {
            if ((!claim.cleared && !claim.chestOpened) || !Array.isArray(row.drops)
                    || row.drops.length > 64) { return null; }
            claim.drops = [];
            for (const drop of row.drops) {
                if (!drop || !isFiniteNumber(drop.x) || !isFiniteNumber(drop.y)
                        || drop.x < 0 || drop.y < 0 || drop.x > 64 || drop.y > 64
                        || !Array.isArray(drop.items) || !drop.items.length || drop.items.length > 4) { return null; }
                const items = validateEquipment(drop.items, false);
                if (!items) { return null; }
                claim.drops.push({ x: drop.x, y: drop.y, items });
            }
            if (!claim.drops.length) { delete claim.drops; }
        }
        out.push(claim);
    }
    return out;
}

// JSON.parse("1e999") is Infinity, not an error — a corrupted slot or crafted
// import can carry non-finite numbers through otherwise plausible JSON. Every
// numeric field is therefore gated on finiteness before its range check;
// NaN fails isFiniteNumber too, so one gate covers both.
function finiteField(raw, key) {
    return raw[key] === undefined || isFiniteNumber(raw[key]);
}

export function parseRunSnapshot(raw, floorsPerVolume) {
    if (!raw || typeof raw !== "object") { return null; }
    if (!isFiniteNumber(raw.cardId) || !isFiniteNumber(raw.level)
            || !isFiniteNumber(raw.hp)
            || !finiteField(raw, "exp") || !finiteField(raw, "gauge")
            || !finiteField(raw, "coin") || !finiteField(raw, "stackHits")
            || !finiteField(raw, "stackKills")) {
        return null;
    }
    // cardId and level are table keys / ladder steps, not measurements —
    // a fractional value means the slot is corrupt, not "almost level 3".
    if (!isUint32(raw.cardId) || raw.cardId === 0
            || raw.level < 1 || Math.floor(raw.level) !== raw.level) {
        return null;
    }
    const vol = Math.round(raw.volume);
    const floor = Math.round(raw.floor);
    if (!(vol >= 1 && vol <= 5)
            || !(floor >= 1 && floor <= floorsPerVolume)) {
        return null;
    }
    if (!(raw.cardId > 0) || !(raw.level >= 1) || !(raw.hp >= 1)) {
        return null;
    }
    const equipment = validateEquipment(raw.equipment);
    if (!equipment) { return null; }

    // Schema gate: anything explicitly newer than this build is refused, a
    // v2 payload must carry a valid seed + generator, and a legacy payload
    // migrates to the deterministic uint32 hash of the old fixed string.
    let seed;
    let generatorVersion;
    if (raw.schemaVersion === undefined) {
        seed = legacySeedFor(vol);
        generatorVersion = RUN_GENERATOR_VERSION;
    } else if (raw.schemaVersion === 2 || raw.schemaVersion === RUN_SCHEMA_VERSION) {
        if (!isUint32(raw.seed) || raw.generatorVersion !== RUN_GENERATOR_VERSION) {
            return null;
        }
        seed = raw.seed >>> 0;
        generatorVersion = raw.generatorVersion;
    } else {
        return null;
    }

    const roomClaims = raw.schemaVersion === RUN_SCHEMA_VERSION
        ? validateRoomClaims(raw.roomClaims) : [];
    if (!roomClaims) { return null; }
    return {
        schemaVersion: RUN_SCHEMA_VERSION,
        generatorVersion: generatorVersion,
        seed: seed,
        volume: vol,
        floor: floor,
        cardId: raw.cardId,
        level: Math.round(raw.level),
        exp: raw.exp > 0 ? raw.exp : 0,
        hp: raw.hp,
        gauge: raw.gauge > 0 ? raw.gauge : 0,
        coin: raw.coin > 0 ? raw.coin : 0,
        stackHits: raw.stackHits > 0 ? raw.stackHits : 0,
        stackKills: raw.stackKills > 0 ? raw.stackKills : 0,
        equipment: equipment,
        roomClaims: roomClaims
    };
}

// Guard against accidental future field growth: callers building a payload
// use this so the harness and the game agree on the envelope, byte for byte.
export function buildRunPayload(normalized) {
    if (!normalized || normalized.schemaVersion !== RUN_SCHEMA_VERSION) {
        return null;
    }
    const roomClaims = validateRoomClaims(normalized.roomClaims === undefined ? [] : normalized.roomClaims);
    if (!roomClaims) { return null; }
    return {
        schemaVersion: RUN_SCHEMA_VERSION,
        generatorVersion: RUN_GENERATOR_VERSION,
        seed: normalized.seed,
        volume: normalized.volume,
        floor: normalized.floor,
        cardId: normalized.cardId,
        level: normalized.level,
        exp: isFiniteNumber(normalized.exp) ? normalized.exp : 0,
        hp: normalized.hp,
        gauge: isFiniteNumber(normalized.gauge) ? normalized.gauge : 0,
        coin: isFiniteNumber(normalized.coin) ? normalized.coin : 0,
        stackHits: isFiniteNumber(normalized.stackHits) ? normalized.stackHits : 0,
        stackKills: isFiniteNumber(normalized.stackKills) ? normalized.stackKills : 0,
        equipment: normalized.equipment.slice(),
        roomClaims: roomClaims
    };
}
