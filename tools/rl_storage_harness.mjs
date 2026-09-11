import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as save from "../site/game/rl/save.js";
import { createProfileValidator, decodeBackup, MAX_BACKUP_BYTES } from "../site/game/rl/profileschema.js";
import { createMeta, mergeState, pagesForVolume, FINALE_PAGES } from "../site/game/rl/meta.js";
import { ACHIEVEMENTS } from "../site/game/rl/achievements.js";
import { createStats } from "../site/asset/rl/stats.js";
import { generateDungeon } from "../site/game/rl/dungeon.js";
import { RUN_GENERATOR_VERSION, layoutSeedFor } from "../site/game/rl/runschema.js";
import { makeGadget } from '../site/game/rl/gadgets.js';

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const weapons = read("weapons-rl.json");
const stats = createStats({ cards: read("cards-rl.json").cards, growth: read("growth.json"), enemies: read("enemies.json").enemies });
const validate = createProfileValidator({ stats, weapons, mergeMeta: mergeState,
    pageIds: [1, 2, 3, 4, 5].flatMap(pagesForVolume).concat(FINALE_PAGES),
    achievementIds: ACHIEVEMENTS.map(row => row.id) });
save.setImportValidator(validate);
const clone = value => JSON.parse(JSON.stringify(value));
const prefix = "kirafan-rl:";

function fakeStorage(initial = {}) {
    const memory = new Map(Object.entries(initial));
    return {
        memory, attempts: [], failAfter: Infinity,
        getItem(key) { return memory.get(key) ?? null; },
        setItem(key, value) {
            this.attempts.push(key);
            if (this.attempts.length > this.failAfter) { throw new Error("injected quota failure"); }
            memory.set(key, String(value));
        },
        removeItem(key) { memory.delete(key); },
        get length() { return memory.size; },
        key(index) { return Array.from(memory.keys())[index] ?? null; }
    };
}
const bytes = storage => JSON.stringify(Array.from(storage.memory));
const meta = mergeState({ gems: 800, levels: { 10000000: 24 }, prologueSeen: true, tutorialSeen: true });
const card = stats.card(10000000);
const native = weapons.catalog.find(row => row.class === card.class && row.charaId < 0 && row.rare === 3);
const run = {
    schemaVersion: 3, generatorVersion: RUN_GENERATOR_VERSION, seed: 12345, volume: 1, floor: 1,
    cardId: card.id, level: 24, exp: 0, hp: 400, gauge: 0, coin: 90, stackHits: 0, stackKills: 0,
    equipment: [{ slot: "weapon", rarity: "rare", affixes: [], catalogId: native.id }], roomClaims: []
};
const legacy = (m = meta, r = run, camera = 11) => JSON.stringify({ meta: JSON.stringify(m), run: JSON.stringify(r), "cam-height": JSON.stringify(camera) });
const profile = validate(decodeBackup(legacy()));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("PASS " + name); }

await test('contract seals survive full profile validation, shop/drop backups and strict invalid-field rejection', () => {
    for (const sealedSlot of [1, 2]) {
        const item = makeGadget('binding', undefined, sealedSlot);
        const candidate = { ...clone(run), floor: 13, equipment: [item] };
        const dungeon = generateDungeon(layoutSeedFor(candidate.seed, candidate.floor), { roomsMin: 6, roomsMax: 9 });
        const shop = dungeon.rooms.find(room => room.type === 'shop'); assert.ok(shop);
        candidate.roomClaims = [{ id: shop.id, offer: [0, 1, 2].map(() => ({ item, price: 180, bought: false })) },
            { id: dungeon.boss, cleared: true, drops: [{ x: 16, y: 12, items: [item] }] }];
        save.setStorage(fakeStorage());
        const restored = save.importSave(legacy(meta, candidate)); assert.ok(restored.ok, restored.error);
        const loaded = save.load('run'), exported = save.exportSave();
        assert.equal(loaded.equipment[0].sealedSlot, sealedSlot);
        assert.equal(loaded.roomClaims.find(r => r.id === shop.id).offer[0].item.sealedSlot, sealedSlot);
        assert.equal(loaded.roomClaims.find(r => r.id === dungeon.boss).drops[0].items[0].sealedSlot, sealedSlot);
        const storage = fakeStorage(); save.setStorage(storage); assert.ok(save.importSave(exported).ok);
        assert.deepEqual(save.load('run'), loaded);
        for (const change of [item => { delete item.sealedSlot; }, item => { item.sealedSlot = 0; },
            item => { item.gadgetId = 'hunter'; }, item => { item.hiddenSeal = 2; }]) {
            const bad = JSON.parse(exported), before = bytes(storage); change(bad.run.equipment[0]);
            assert.equal(save.importSave(JSON.stringify(bad)).ok, false); assert.equal(bytes(storage), before);
        }
    }
});

await test("legacy scalar camera, meta and native run commit with one write", () => {
    const storage = fakeStorage({ [prefix + "meta"]: '{"gems":1}' }); save.setStorage(storage);
    const preview = save.previewImport(legacy()); assert.ok(preview.ok, preview.error);
    assert.equal(storage.attempts.length, 0);
    const result = save.importSave(legacy(), preview.fingerprint); assert.ok(result.ok, result.error);
    assert.deepEqual(storage.attempts, [prefix + "profile"]);
    assert.equal(storage.getItem(prefix + "meta"), '{"gems":1}');
    assert.equal(save.load("meta").gems, 800); assert.equal(save.load("cam-height"), 11);
    assert.equal(save.load("run").equipment[0].catalogId, native.id);
});

await test("all slot APIs use the restored profile and never resurrect legacy run", () => {
    const storage = fakeStorage({ [prefix + "run"]: JSON.stringify(run) }); save.setStorage(storage);
    assert.ok(save.importSave(legacy()).ok);
    assert.ok(save.write("cam-height", 12)); assert.equal(save.load("cam-height"), 12);
    assert.ok(save.clear("run")); assert.equal(save.load("run"), null);
    assert.equal(storage.getItem(prefix + "run"), JSON.stringify(run));
    assert.equal(JSON.parse(storage.getItem(prefix + "profile")).run, null);
});

await test("current profile exports and restores without dropping fields", () => {
    save.setStorage(fakeStorage()); assert.ok(save.importSave(legacy()).ok);
    const exported = save.exportSave(); save.setStorage(fakeStorage());
    assert.ok(save.importSave(exported).ok);
    assert.deepEqual(JSON.parse(save.exportSave()), JSON.parse(exported));
});

await test("v3 real room inventory and consumption survive byte-for-byte normalization", () => {
    const dungeon = generateDungeon(layoutSeedFor(run.seed, run.floor), { roomsMin: 6, roomsMax: 9 });
    const shop = dungeon.rooms.find(room => room.type === "shop"); assert.ok(shop);
    const candidate = clone(run);
    candidate.roomClaims = [{ id: shop.id, chestOpened: false, altarUsed: false, rested: false,
        npcTalked: false, barrels: [], offer: [true, false, false].map(bought => ({
            item: clone(run.equipment[0]), price: 60, bought
        })) }];
    save.setStorage(fakeStorage()); const result = save.importSave(legacy(meta, candidate));
    assert.ok(result.ok, result.error); assert.deepEqual(save.load("run"), candidate);
});

await test('completed boss room and unclaimed loot survive strict backup import and export', () => {
    const dungeon = generateDungeon(layoutSeedFor(run.seed, run.floor), { roomsMin: 6, roomsMax: 9 });
    const candidate = clone(run);
    candidate.roomClaims = [{ id: dungeon.boss, chestOpened: false, altarUsed: false,
        rested: false, npcTalked: false, barrels: [], cleared: true,
        drops: [{ x: 16, y: 12, items: [clone(run.equipment[0])] }] }];
    save.setStorage(fakeStorage());
    const imported = save.importSave(legacy(meta, candidate)); assert.ok(imported.ok, imported.error);
    assert.deepEqual(save.load('run'), candidate);
    const exported = save.exportSave(); save.setStorage(fakeStorage());
    assert.ok(save.importSave(exported).ok);
    assert.deepEqual(save.load('run'), candidate);
});

await test('forged room loot ownership, positions and nested fields never alter storage', () => {
    const dungeon = generateDungeon(layoutSeedFor(run.seed, run.floor), { roomsMin: 6, roomsMax: 9 });
    const foreign = weapons.catalog.find(row => row.charaId > 0 && row.charaId !== card.id);
    assert.ok(foreign);
    for (const change of [
        c => { c.id = dungeon.start; },
        c => { c.cleared = false; },
        c => { c.drops[0].x = 33; },
        c => { c.drops[0].y = 25; },
        c => { c.drops[0].offered = true; },
        c => { c.drops[0].items[0].catalogId = foreign.id; },
        c => { c.drops[0].items[0].unknown = 'not allowed'; },
        c => { c.drops[0].items = [{ slot: 'armor', rarity: 'epic', affixes: [], gadgetId: 'unknown' }]; }
    ]) {
        const candidate = clone(run);
        const claim = { id: dungeon.boss, cleared: true, drops: [{ x: 16, y: 12, items: [clone(run.equipment[0])] }] };
        change(claim); candidate.roomClaims = [claim];
        const storage = fakeStorage({ [prefix + 'profile']: JSON.stringify(profile) });
        save.setStorage(storage); const before = bytes(storage);
        const result = save.importSave(legacy(meta, candidate));
        assert.equal(result.ok, false); assert.equal(bytes(storage), before);
    }
});

await test("v1/v2 migration preserves resources and uses existing seed semantics", () => {
    const v1 = clone(run); delete v1.schemaVersion; delete v1.generatorVersion; delete v1.seed; delete v1.roomClaims;
    save.setStorage(fakeStorage()); const first = save.importSave(legacy(meta, v1)); assert.ok(first.ok, first.error);
    assert.equal(first.profile.run.schemaVersion, 3); assert.deepEqual(first.profile.run.roomClaims, []);
    const v2 = { ...run, schemaVersion: 2 }; delete v2.roomClaims;
    const second = save.importSave(legacy(meta, v2)); assert.ok(second.ok, second.error);
    assert.equal(second.profile.run.seed, run.seed); assert.equal(second.profile.run.coin, run.coin);
});

await test("quota failure preserves every old byte, retries exactly one commit", () => {
    const storage = fakeStorage({ [prefix + "meta"]: '{"gems":7}', [prefix + "cam-height"]: "9" });
    save.setStorage(storage); const before = bytes(storage); const preview = save.previewImport(legacy());
    storage.failAfter = 0;
    assert.equal(save.importSave(legacy(), preview.fingerprint).ok, false);
    assert.deepEqual(storage.attempts, [prefix + "profile"]); assert.equal(bytes(storage), before);
    storage.failAfter = Infinity;
    assert.ok(save.importSave(legacy(), preview.fingerprint).ok); assert.equal(save.load("meta").gems, 800);
});

await test("change after preview rejects replacement", () => {
    const storage = fakeStorage(); save.setStorage(storage); const preview = save.previewImport(legacy());
    save.write("meta", { gems: 7 }); const before = bytes(storage);
    assert.equal(save.importSave(legacy(), preview.fingerprint).ok, false); assert.equal(bytes(storage), before);
});

await test("unchanged autosave cannot invalidate an open restore preview", () => {
    const storage = fakeStorage(); save.setStorage(storage); assert.ok(save.importSave(legacy()).ok);
    const preview = save.previewImport(legacy()); const before = bytes(storage); const count = storage.attempts.length;
    assert.ok(save.write("run", save.load("run"))); assert.ok(save.write("meta", save.load("meta")));
    assert.equal(bytes(storage), before); assert.equal(storage.attempts.length, count);
    assert.ok(save.importSave(legacy(), preview.fingerprint).ok);
});

await test("unknown game IDs and impossible room ownership cannot enter an import", () => {
    const invalid = [];
    let p = clone(profile); p.run.cardId = 999999; invalid.push(p);
    p = clone(profile); p.run.equipment[0].affixes = ["999999"]; invalid.push(p);
    p = clone(profile); p.run.equipment[0].catalogId = 999999; invalid.push(p);
    p = clone(profile); p.run.equipment[0].catalogId = weapons.catalog.find(row => row.charaId > 0 && row.charaId !== card.id).id; invalid.push(p);
    p = clone(profile); p.meta.pages = ["999999"]; invalid.push(p);
    p = clone(profile); p.meta.enemies = ["999999"]; invalid.push(p);
    p = clone(profile); p.meta.achievements = ["missing"]; invalid.push(p);
    p = clone(profile); p.run.roomClaims = [{ id: 63, rested: true }]; invalid.push(p);
    for (const candidate of invalid) {
        const storage = fakeStorage({ [prefix + "meta"]: '{"gems":9}' }); save.setStorage(storage);
        const before = bytes(storage); assert.equal(save.importSave(JSON.stringify(candidate)).ok, false);
        assert.equal(bytes(storage), before); assert.equal(storage.attempts.length, 0);
    }
});

await test("valid generic cross-class equipment survives import without changing card identity", () => {
    const crossClass = weapons.catalog.find(row => row.charaId < 0 && row.class !== card.class);
    assert.ok(crossClass);
    const candidate = clone(profile); candidate.run.equipment[0].catalogId = crossClass.id;
    const storage = fakeStorage(); save.setStorage(storage);
    assert.ok(save.importSave(JSON.stringify(candidate)).ok);
    assert.equal(save.load("run").cardId, card.id);
    assert.equal(save.load("run").equipment[0].catalogId, crossClass.id);
    assert.deepEqual(storage.attempts, [prefix + "profile"]);
});

await test("malformed, future, oversized and unsafe backups never mutate storage", () => {
    const invalid = ["{", "{}", "[]", JSON.stringify({ meta: '{"gems":1e999}' }),
        JSON.stringify({ meta: '{"__proto__":{}}' }), JSON.stringify({ surprise: "{}" }),
        " ".repeat(MAX_BACKUP_BYTES + 1), JSON.stringify({ ...profile, profileVersion: 3 }),
        JSON.stringify({ ...profile, dataVersion: 2 }), JSON.stringify({ ...profile, settings: { "cam-height": 0 } })];
    for (const [key, value] of [["coin", -1], ["level", 101], ["floor", 1.5], ["volume", "1"], ["exp", 0.2]]) {
        invalid.push(JSON.stringify({ ...profile, run: { ...run, [key]: value } }));
    }
    let nested = {}; for (let i = 0; i < 22; i++) { nested = { x: nested }; }
    invalid.push(JSON.stringify({ meta: JSON.stringify(nested) }));
    invalid.push(JSON.stringify({ ...profile, meta: { ...meta, enemies: Array(4097).fill("29012001") } }));
    for (const text of invalid) {
        const storage = fakeStorage({ [prefix + "meta"]: '{"gems":9}' }); save.setStorage(storage);
        const before = bytes(storage); assert.equal(save.importSave(text).ok, false, text.slice(0, 80));
        assert.equal(bytes(storage), before); assert.equal(storage.attempts.length, 0);
    }
});

await test("future active profile is preserved and exportable until explicit recovery", () => {
    const future = JSON.stringify({ ...profile, profileVersion: 3 });
    const storage = fakeStorage({ [prefix + "profile"]: future, [prefix + "meta"]: '{"gems":1}' });
    save.setStorage(storage); assert.equal(save.load("meta"), null);
    assert.equal(save.write("meta", meta), false); assert.equal(save.clear("run"), false);
    assert.equal(save.exportSave(), future); assert.equal(storage.getItem(prefix + "profile"), future);
    assert.ok(save.importSave(legacy()).ok); assert.equal(save.load("meta").gems, 800);
});

await test("same-version corrupt active profiles cannot be repaired by ordinary slot writes", () => {
    const invalid = [];
    let candidate = clone(profile); candidate.run.cardId = 999999; invalid.push(candidate);
    candidate = clone(profile); candidate.run.schemaVersion = 99; invalid.push(candidate);
    candidate = clone(profile); candidate.meta.gems = -1; invalid.push(candidate);
    candidate = clone(profile); candidate.meta.levels[card.id] = 81; invalid.push(candidate);
    for (const damaged of invalid) {
        damaged.revision = 17;
        const raw = JSON.stringify(damaged);
        const storage = fakeStorage({ [prefix + "profile"]: raw, [prefix + "run"]: JSON.stringify(run) });
        save.setStorage(storage); const before = bytes(storage);
        assert.equal(save.clear("run"), false, "clearing one slot must not silently discard a corrupt profile");
        assert.equal(save.write("meta", meta), false);
        assert.equal(save.write("run", run), false);
        assert.equal(save.write("cam-height", 10), false);
        assert.equal(save.load("meta"), null); assert.equal(save.load("run"), null);
        assert.equal(bytes(storage), before); assert.equal(storage.attempts.length, 0);
        assert.equal(save.exportSave(), raw);
        const recovered = save.importSave(legacy());
        assert.ok(recovered.ok, "explicit recovery must still be available");
        assert.equal(recovered.profile.revision, 18, "recovery keeps a readable envelope revision monotonic");
    }
});

await test("failed camp payment keeps gems, level and limit break unchanged", () => {
    const storage = fakeStorage({ [prefix + "meta"]: JSON.stringify(meta) }); save.setStorage(storage);
    const camp = createMeta(); camp.read(); storage.failAfter = 0;
    const before = JSON.stringify(camp.state);
    assert.equal(camp.train(card.id, 25).reason, "storage");
    assert.equal(camp.limitBreak(card.id).reason, "storage");
    assert.equal(JSON.stringify(camp.state), before); assert.equal(storage.getItem(prefix + "meta"), JSON.stringify(meta));
    storage.failAfter = Infinity;
    assert.equal(camp.train(card.id, 25).spent, 58); assert.equal(camp.gems(), 742);
});

await test("missing validation fails closed", () => {
    save.setStorage(fakeStorage()); save.setImportValidator(null);
    assert.equal(save.importSave(legacy()).ok, false); save.setImportValidator(validate);
});

console.log("Storage recovery: " + passed + "/" + passed + " passed");
