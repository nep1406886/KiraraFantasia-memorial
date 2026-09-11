// T28: ordinary play uses a validated profile and never hides failed persistence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as save from "../site/game/rl/save.js";
import { createProfileValidator, decodeBackup } from "../site/game/rl/profileschema.js";
import { createMeta, mergeState, pagesForVolume, FINALE_PAGES } from "../site/game/rl/meta.js";
import { ACHIEVEMENTS } from "../site/game/rl/achievements.js";
import { createStats } from "../site/asset/rl/stats.js";
import { generateDungeon } from "../site/game/rl/dungeon.js";
import { layoutSeedFor } from "../site/game/rl/runschema.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const weapons = read("weapons-rl.json");
const stats = createStats({ cards: read("cards-rl.json").cards, growth: read("growth.json"), enemies: read("enemies.json").enemies });
const validate = createProfileValidator({ stats, weapons, mergeMeta: mergeState,
    pageIds: [1, 2, 3, 4, 5].flatMap(pagesForVolume).concat(FINALE_PAGES), achievementIds: ACHIEVEMENTS.map(row => row.id) });
save.setImportValidator(validate);
const PREFIX = "kirafan-rl:", PROFILE = PREFIX + "profile";
const clone = value => JSON.parse(JSON.stringify(value));
const meta = mergeState({ gems: 800, levels: { 10000000: 24 }, prologueSeen: true, tutorialSeen: true });
const run = { schemaVersion: 3, generatorVersion: "t24-1", seed: 12345, volume: 1, floor: 1,
    cardId: 10000000, level: 24, exp: 0, hp: 400, gauge: 0, coin: 90, stackHits: 0, stackKills: 0, equipment: [], roomClaims: [] };
const legacy = (m = meta, r = run) => ({ [PREFIX + "meta"]: JSON.stringify(m), [PREFIX + "run"]: JSON.stringify(r), [PREFIX + "cam-height"]: "11" });
function fakeStorage(initial = {}) {
    const memory = new Map(Object.entries(initial));
    return { memory, attempts: [], fail: false,
        getItem(key) { return memory.get(key) ?? null; },
        setItem(key, value) { this.attempts.push(key); if (this.fail) throw new Error("injected quota"); memory.set(key, String(value)); },
        removeItem(key) { memory.delete(key); }, get length() { return memory.size; }, key(i) { return Array.from(memory.keys())[i] ?? null; } };
}
const bytes = storage => JSON.stringify(Array.from(storage.memory));
const durable = storage => JSON.parse(storage.getItem(PROFILE));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("PASS " + name); }

if (process.argv.includes("--probe")) {
    const storage = fakeStorage({ [PREFIX + "meta"]: "{bad json", [PREFIX + "run"]: JSON.stringify(run) });
    save.setStorage(storage);
    if (save.initializeStorage) save.initializeStorage();
    const before = bytes(storage);
    assert.equal(save.write("meta", meta), false, "a corrupt legacy slot must not be overwritten by default progression");
    assert.equal(bytes(storage), before);
    console.log("PASS corrupted legacy bytes protected");
    process.exit(0);
}

await test("legacy migration writes one profile and preserves every original slot", () => {
    const initial = legacy(); const storage = fakeStorage(initial); save.setStorage(storage);
    const result = save.initializeStorage(); assert.ok(result.ok, result.error);
    assert.deepEqual(storage.attempts, [PROFILE]);
    for (const [key, raw] of Object.entries(initial)) assert.equal(storage.getItem(key), raw);
    assert.equal(durable(storage).revision, 1); assert.deepEqual(durable(storage).run, run);
    assert.equal(save.load("meta").gems, 800); assert.equal(save.load("cam-height"), 11);
    save.initializeStorage(); assert.equal(storage.attempts.length, 1);
    const exposed = save.load("run"); exposed.coin = 0;
    assert.equal(save.load("run").coin, 90, "callers cannot mutate the active candidate through a read");
});

await test("fresh storage starts a profile; already current profiles are read without a new revision", () => {
    const storage = fakeStorage(); save.setStorage(storage); assert.ok(save.initializeStorage().ok);
    const raw = storage.getItem(PROFILE); assert.equal(durable(storage).run, null);
    save.setStorage(storage); assert.ok(save.initializeStorage().ok);
    assert.equal(storage.attempts.length, 1); assert.equal(storage.getItem(PROFILE), raw);
});

await test("v1 and v2 migration retains resources, seed semantics and empty claims", () => {
    for (const version of [undefined, 2]) {
        const snapshot = clone(run); snapshot.schemaVersion = version; delete snapshot.roomClaims;
        if (!version) { delete snapshot.seed; delete snapshot.generatorVersion; }
        const storage = fakeStorage(legacy(meta, snapshot)); save.setStorage(storage);
        assert.ok(save.initializeStorage().ok); const migrated = durable(storage).run;
        assert.equal(migrated.schemaVersion, 3); assert.equal(migrated.coin, 90); assert.equal(migrated.hp, 400);
        assert.deepEqual(migrated.roomClaims, []);
        if (version === 2) assert.equal(migrated.seed, 12345);
    }
});

await test("bad legacy or current content refuses all ordinary edits and stays exportable", () => {
    const validProfile = validate(decodeBackup(JSON.stringify({meta: JSON.stringify(meta), run: JSON.stringify(run)})));
    const badRun = { ...run, cardId: 999999 };
    const candidates = [legacy({ ...meta, gems: -1 }), legacy(meta, badRun),
        { [PREFIX + "meta"]: "{bad" }, legacy(meta, { ...run, schemaVersion: 99 }),
        { [PROFILE]: JSON.stringify({ ...validProfile, run: badRun }) }, { [PROFILE]: '{"profileVersion":99}' }];
    for (const initial of candidates) {
        const storage = fakeStorage(initial); save.setStorage(storage); const before = bytes(storage);
        assert.equal(save.initializeStorage().ok, false); assert.equal(save.storageState().status, "corrupt");
        assert.equal(save.write("meta", meta, { defer: true }), false); assert.equal(save.clear("run", { defer: true }), false);
        assert.equal(save.load("run"), null); assert.equal(bytes(storage), before); assert.equal(storage.attempts.length, 0);
        assert.ok(save.exportSave().length); assert.equal(save.exportPendingSave(), null);
    }
});

await test("migration quota failure keeps a usable candidate without touching old bytes", () => {
    const storage = fakeStorage(legacy()); storage.fail = true; save.setStorage(storage); const before = bytes(storage);
    assert.equal(save.initializeStorage().ok, false); assert.deepEqual(storage.attempts, [PROFILE]);
    assert.equal(bytes(storage), before); assert.equal(save.load("run").coin, 90);
    assert.equal(save.storageState().pending, true); assert.equal(save.storageState().canRetry, true);
    assert.equal(JSON.parse(save.exportPendingSave()).meta.gems, 800);
    storage.fail = false; const attempts = storage.attempts.length;
    assert.ok(save.retryStorage().ok); assert.equal(storage.attempts.length, attempts + 1);
    assert.equal(durable(storage).meta.gems, 800); assert.equal(save.storageState().pending, false);
});

await test("deferred run, collection and settings compose one retry of the latest candidate", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage();
    const before = bytes(storage); const raw = save.exportSave(); storage.fail = true;
    assert.equal(save.write("run", { ...run, coin: 100 }, { defer: true }), false);
    assert.equal(save.write("run", { ...run, coin: 110 }, { defer: true }), false);
    assert.equal(save.write("meta", { ...meta, pages: ["29001000"] }, { defer: true }), false);
    assert.equal(save.write("cam-height", 12, { defer: true }), false);
    assert.equal(bytes(storage), before); assert.equal(save.exportSave(), raw);
    const pending = JSON.parse(save.exportPendingSave());
    assert.equal(pending.run.coin, 110); assert.deepEqual(pending.meta.pages, ["29001000"]); assert.equal(pending.settings["cam-height"], 12);
    storage.fail = false; const attempts = storage.attempts.length;
    assert.ok(save.retryStorage().ok); assert.equal(storage.attempts.length, attempts + 1);
    assert.equal(durable(storage).revision, 2); assert.equal(durable(storage).run.coin, 110);
    assert.deepEqual(durable(storage).meta.pages, ["29001000"]); assert.equal(save.exportPendingSave(), null);
});

await test("a successful unrelated slot write must persist all deferred facts together", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage(); storage.fail = true;
    save.write("run", { ...run, coin: 144 }, { defer: true }); storage.fail = false;
    assert.ok(save.write("cam-height", 12)); assert.equal(durable(storage).run.coin, 144);
    assert.equal(save.storageState().status, "saved");
});

await test("failed camp payments are never queued or executed by a storage retry", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage();
    const camp = createMeta(); camp.read(); storage.fail = true;
    save.write("run", { ...run, coin: 111 }, { defer: true });
    assert.equal(camp.train(10000000, 25).reason, "storage"); assert.equal(camp.limitBreak(10000000).reason, "storage");
    const pending = JSON.parse(save.exportPendingSave()); assert.equal(pending.meta.gems, 800); assert.equal(pending.meta.levels[10000000], 24);
    storage.fail = false; assert.ok(save.retryStorage().ok);
    assert.equal(durable(storage).meta.gems, 800); assert.equal(durable(storage).meta.lb[10000000], undefined);
    assert.equal(durable(storage).run.coin, 111); assert.equal(camp.gems(), 800);
    assert.equal(camp.train(10000000, 25).spent, 58); assert.equal(durable(storage).meta.gems, 742);
});

await test("pending clear cannot resurrect a terminal run on retry", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage(); storage.fail = true;
    assert.equal(save.clear("run", { defer: true }), false); assert.equal(save.load("run"), null);
    assert.equal(durable(storage).run.coin, 90); storage.fail = false; assert.ok(save.retryStorage().ok);
    assert.equal(durable(storage).run, null);
});

await test("unchanged autosaves do not invalidate restore previews or announce new state", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage();
    let notices = 0; const unsubscribe = save.subscribeStorage(() => notices++);
    const preview = save.previewImport(save.exportSave()); const before = bytes(storage); const count = storage.attempts.length; const initialNotices = notices;
    assert.ok(save.write("run", save.load("run"), { defer: true }));
    assert.equal(bytes(storage), before); assert.equal(storage.attempts.length, count); assert.equal(notices, initialNotices);
    assert.ok(save.importSave(save.exportSave(), preview.fingerprint).ok); unsubscribe();
});

await test("repeated quota errors retain one state; reads cannot hide the unsaved warning", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage(); storage.fail = true;
    const notices = []; const unsubscribe = save.subscribeStorage(state => notices.push(state.status));
    save.write("run", { ...run, coin: 101 }, { defer: true }); const count = notices.length;
    save.write("run", { ...run, coin: 101 }, { defer: true }); save.load("meta");
    assert.equal(notices.length, count); assert.equal(save.storageState().status, "unsaved"); unsubscribe();
});

await test("changing an in-memory candidate invalidates an earlier restore preview", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage();
    const preview = save.previewImport(save.exportSave()); storage.fail = true;
    save.write("run", { ...run, coin: 101 }, { defer: true }); storage.fail = false; const before = bytes(storage);
    assert.equal(save.importSave(save.exportSave(), preview.fingerprint).ok, false); assert.equal(bytes(storage), before);
});

await test("external profile or legacy changes stop stale writes and keep local progress exportable", () => {
    for (const key of [PROFILE, PREFIX + "meta"]) {
        const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage();
        storage.fail = true; save.write("run", { ...run, coin: 140 }, { defer: true }); storage.fail = false;
        storage.setItem(key, key === PROFILE ? JSON.stringify({ ...durable(storage), revision: 50 }) : '{"gems":321}');
        const before = bytes(storage); assert.equal(save.checkStorageChanges(), false);
        assert.equal(save.storageState().status, "conflict"); assert.equal(save.retryStorage().ok, false);
        assert.equal(save.write("cam-height", 10), false); assert.equal(bytes(storage), before);
        assert.equal(JSON.parse(save.exportPendingSave()).run.coin, 140);
    }
});

await test("session storage can be exported and retried after permission returns", () => {
    let denied = true; const persistentStore = fakeStorage();
    global.window = { get localStorage() { if (denied) throw new Error("denied"); return persistentStore; } };
    try {
        save.setStorage(null); assert.ok(save.initializeStorage().ok); assert.equal(save.storageState().status, "session");
        assert.ok(save.write("meta", meta, { defer: true })); assert.equal(JSON.parse(save.exportPendingSave()).meta.gems, 800);
        assert.equal(save.retryStorage().ok, false); denied = false;
        assert.ok(save.retryStorage().ok); assert.equal(durable(persistentStore).meta.gems, 800);
        assert.equal(save.storageState().persistent, true); assert.equal(save.storageState().status, "saved");
    } finally { delete global.window; }
});

await test("newly accessible storage with unseen progress cannot be silently replaced", () => {
    let denied = true; const persistentStore = fakeStorage(legacy({ ...meta, gems: 321 }));
    global.window = { get localStorage() { if (denied) throw new Error("denied"); return persistentStore; } };
    try {
        save.setStorage(null); save.initializeStorage(); save.write("meta", meta, { defer: true });
        const before = bytes(persistentStore); denied = false;
        assert.equal(save.retryStorage().ok, false); assert.equal(save.storageState().status, "conflict");
        assert.equal(bytes(persistentStore), before); assert.equal(JSON.parse(save.exportPendingSave()).meta.gems, 800);
        assert.equal(JSON.parse(JSON.parse(save.exportSave()).meta).gems, 321);
    } finally { delete global.window; }
});

await test("missing content tables disables ordinary managed writes without destroying old slots", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.setImportValidator(null); const before = bytes(storage);
    assert.equal(save.initializeStorage().ok, false); assert.equal(save.storageState().status, "unavailable");
    assert.equal(save.clear("run"), false); assert.equal(save.write("meta", meta), false); assert.equal(bytes(storage), before);
    save.setImportValidator(validate);
});
await test("native weapon stock and consumed room claims survive automatic migration", () => {
    const { rooms } = generateDungeon(layoutSeedFor(run.seed, run.floor), { roomsMin: 6, roomsMax: 9 });
    const shop = rooms.find(room => room.type === "shop"); assert.ok(shop);
    const weapon = weapons.catalog.find(row => row.class === stats.card(run.cardId).class && row.charaId < 0 && row.rare === 3);
    const item = { slot: "weapon", rarity: "rare", affixes: [], catalogId: weapon.id };
    const snapshot = { ...run, equipment: [item], roomClaims: [{ id: shop.id, chestOpened: false, altarUsed: false,
        rested: false, npcTalked: false, barrels: [], offer: [true, false, false].map(bought => ({ item, price: 60, bought })) }] };
    const storage = fakeStorage(legacy(meta, snapshot)); save.setStorage(storage);
    assert.ok(save.initializeStorage().ok); assert.deepEqual(durable(storage).run, snapshot);
});

await test("a transient read denial retains deferred facts and retries without dropping a slot", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage();
    const readItem = storage.getItem; const before = bytes(storage);
    storage.getItem = function () { throw new Error("injected read denial"); };
    assert.equal(save.write("run", { ...run, coin: 222 }, { defer: true }), false);
    assert.equal(save.load("run").coin, 222); assert.equal(bytes(storage), before);
    assert.equal(save.storageState().status, "unsaved"); storage.getItem = readItem;
    assert.ok(save.retryStorage().ok); assert.equal(durable(storage).run.coin, 222);
    assert.equal(durable(storage).meta.gems, 800);
});

await test("read-only access loss keeps the last known profile exportable without new gameplay", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage();
    const readItem = storage.getItem, before = bytes(storage);
    storage.getItem = function () { throw new Error("injected read denial"); };
    assert.equal(save.checkStorageChanges(), false);
    assert.equal(save.storageState().pending, true, "a cached profile must remain exportable while raw reads fail");
    assert.equal(JSON.parse(save.exportPendingSave()).meta.gems, 800);
    assert.equal(JSON.parse(save.exportPendingSave()).run.coin, 90);
    assert.throws(() => save.exportSave()); assert.equal(bytes(storage), before);
    storage.getItem = readItem; const attempts = storage.attempts.length;
    assert.ok(save.retryStorage().ok); assert.equal(storage.attempts.length, attempts + 1);
    assert.equal(durable(storage).meta.gems, 800); assert.equal(durable(storage).run.coin, 90);
    assert.equal(save.exportPendingSave(), null);
});

await test("view failures cannot turn a successful disk commit into a failed payment", () => {
    const storage = fakeStorage(legacy()); save.setStorage(storage); save.initializeStorage();
    let armed = false; const unsubscribe = save.subscribeStorage(() => { if (armed) throw new Error("injected view failure"); });
    armed = true; const camp = createMeta(); camp.read();
    assert.equal(camp.train(10000000, 25).spent, 58); assert.equal(durable(storage).meta.gems, 742);
    assert.equal(camp.gems(), 742); unsubscribe();
});
console.log("Persistence: " + passed + "/" + passed + " passed");
