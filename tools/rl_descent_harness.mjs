// T28: commit-first descent, preserving accepted old-floor facts on failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as save from "../site/game/rl/save.js";
import { createProfileValidator } from "../site/game/rl/profileschema.js";
import * as progression from "../site/game/rl/meta.js";
import { ACHIEVEMENTS } from "../site/game/rl/achievements.js";
import { createStats } from "../site/asset/rl/stats.js";
import { generateDungeon } from "../site/game/rl/dungeon.js";
import { buildRunPayload, layoutSeedFor } from "../site/game/rl/runschema.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const stats = createStats({ cards: read("cards-rl.json").cards, growth: read("growth.json"), enemies: read("enemies.json").enemies });
const validate = createProfileValidator({ stats, weapons: read("weapons-rl.json"), mergeMeta: progression.mergeState,
    pageIds: [1, 2, 3, 4, 5].flatMap(progression.pagesForVolume).concat(progression.FINALE_PAGES),
    achievementIds: ACHIEVEMENTS.map(row => row.id) });
const PROFILE = "kirafan-rl:profile", META = "kirafan-rl:meta";
const clone = value => JSON.parse(JSON.stringify(value));
const meta = progression.mergeState({ gems: 800, prologueSeen: true, tutorialSeen: true });
const run = buildRunPayload({ schemaVersion: 3, seed: 28101, volume: 1, floor: 5,
    cardId: 10000000, level: 24, exp: 6, hp: 400, gauge: 30, coin: 90, stackHits: 5, stackKills: 2,
    equipment: [{ slot: "charm", rarity: "legendary", affixes: [] }], roomClaims: [] });
function storage(initial = {}) {
    const memory = new Map(Object.entries(initial));
    return { memory, attempts: [], fail: false, failAt: Infinity, readFail: false,
        getItem(key) { if (this.readFail) throw new Error("read denied"); return memory.get(key) ?? null; },
        setItem(key, value) { this.attempts.push({ key, value: String(value) });
            if (this.fail || this.attempts.length === this.failAt) throw new Error("quota"); memory.set(key, String(value)); },
        removeItem(key) { memory.delete(key); }, get length() { return memory.size; }, key(i) { return Array.from(memory.keys())[i] ?? null; } };
}
const durable = s => JSON.parse(s.memory.get(PROFILE));
const bytes = s => JSON.stringify(Array.from(s.memory));
function boot(initial = { [META]: JSON.stringify(meta) }) {
    const s = storage(initial); save.setStorage(s); save.setImportValidator(validate); assert.ok(save.initializeStorage().ok); return s;
}
function begin(snapshot = run) { const result = save.beginRun(clone(snapshot)); assert.ok(result.accepted, result.error); return result.runId; }
const descend = (id, checkpoint = run) => save.advanceFloor(id, checkpoint, progression.descentReward);
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("PASS " + name); }

await test("dedicated descent API exists without changing the v3 snapshot", () => {
    assert.equal(typeof save.advanceFloor, "function");
    assert.equal(typeof progression.descentReward, "function");
    assert.equal(typeof progression.createMeta().descendRun, "function");
});
await test("pure authored page reward leaves the source untouched", () => {
    const before = JSON.stringify(meta); const result = progression.descentReward(meta, run);
    assert.deepEqual(result.newPages, ["21000000"]); assert.equal(result.meta.gems, 800);
    assert.equal(JSON.stringify(meta), before); assert.equal(result.meta.volumes, 0);
    for (const floor of [0, 20, 21, 1.5]) assert.throws(() => progression.descentReward(meta, { ...run, floor }));
    for (const volume of [0, 6, 1.5]) assert.throws(() => progression.descentReward(meta, { ...run, volume }));
});
await test("next checkpoint and page use exactly one whole-profile write", () => {
    const s = boot(), id = begin(), count = s.attempts.length, revision = durable(s).revision;
    s.failAt = count + 2; const result = descend(id); assert.ok(result.ok, result.error); assert.ok(result.saved);
    assert.equal(s.attempts.length, count + 1); assert.equal(durable(s).revision, revision + 1);
    assert.deepEqual(durable(s).run, { ...run, floor: 6 }); assert.equal(durable(s).runId, id);
    assert.deepEqual(durable(s).meta.pages, ["21000000"]); assert.equal(durable(s).meta.gems, 800);
    assert.deepEqual(result.run, durable(s).run); assert.deepEqual(result.newPages, ["21000000"]);
});
await test("same transition is rejected before recalculating or writing", () => {
    const s = boot(), id = begin(); descend(id); const before = bytes(s), count = s.attempts.length;
    const result = save.advanceFloor(id, run, () => { throw new Error("must not recalculate"); });
    assert.equal(result.ok, false); assert.equal(bytes(s), before); assert.equal(s.attempts.length, count);
});
await test("quota failure keeps exact durable bytes and does not queue a floor or reward", () => {
    const s = boot(), id = begin(); const before = bytes(s); s.fail = true;
    const result = descend(id); assert.equal(result.ok, false); assert.equal(result.saved, false);
    assert.equal(result.meta, null); assert.equal(bytes(s), before); assert.deepEqual(save.load("run"), run);
    assert.deepEqual(save.load("meta").pages, []); assert.equal(save.exportPendingSave(), null);
    s.fail = false; assert.ok(save.retryStorage().ok); assert.equal(durable(s).run.floor, 5);
    assert.deepEqual(durable(s).meta.pages, []); assert.ok(descend(id).ok); assert.equal(durable(s).run.floor, 6);
});
await test("only the explicit descent retry can apply the previously failed transition", () => {
    const s = boot(), id = begin(), camp = progression.createMeta(); camp.read(); s.fail = true;
    assert.equal(camp.descendRun(id, run).ok, false); assert.deepEqual(camp.progression.pages, []);
    s.fail = false; assert.ok(save.write("cam-height", 12));
    assert.equal(durable(s).run.floor, 5); assert.deepEqual(durable(s).meta.pages, []);
    const count = s.attempts.length; assert.ok(camp.descendRun(id, run).ok);
    assert.equal(s.attempts.length, count + 1); assert.deepEqual(camp.progression.pages, ["21000000"]);
    assert.equal(durable(s).settings["cam-height"], 12);
});
await test("accepted unsaved old-floor collections and counters merge into one descent commit", () => {
    const s = boot(), id = begin(), camp = progression.createMeta(); camp.read(); s.fail = true;
    camp.collectPage(progression.pagesForVolume(2)[0]); save.write("cam-height", 12, { defer: true });
    const current = { ...run, coin: 456, stackKills: 9 }; save.write("run", current, { defer: true, runId: id });
    const before = bytes(s); assert.equal(camp.descendRun(id, current).ok, false); assert.equal(bytes(s), before);
    const pending = JSON.parse(save.exportPendingSave()); assert.equal(pending.run.floor, 5);
    assert.equal(pending.run.coin, 456); assert.equal(pending.meta.pages.length, 1);
    assert.ok(save.previewImport(JSON.stringify(pending)).ok);
    s.fail = false; const count = s.attempts.length; assert.ok(camp.descendRun(id, current).ok);
    assert.equal(s.attempts.length, count + 1); assert.equal(durable(s).run.coin, 456);
    assert.equal(durable(s).run.stackKills, 9); assert.equal(durable(s).settings["cam-height"], 12);
    assert.equal(durable(s).meta.pages.length, 2);
});
await test("generic retry preserves old-floor facts without crossing a floor", () => {
    const s = boot(), id = begin(); s.fail = true;
    const current = { ...run, coin: 222 }; save.write("run", current, { defer: true, runId: id }); descend(id, current);
    s.fail = false; assert.ok(save.retryStorage().ok); assert.equal(durable(s).run.floor, 5);
    assert.equal(durable(s).run.coin, 222); assert.deepEqual(durable(s).meta.pages, []);
});
await test("next floor clears every old room claim even when layouts differ in size", () => {
    const dungeon = generateDungeon(layoutSeedFor(run.seed, 5));
    const claims = dungeon.rooms.map(room => ({ id: room.id, chestOpened: room.type === "chest",
        altarUsed: false, rested: room.type === "rest", npcTalked: false, barrels: [] }));
    const current = buildRunPayload({ ...run, roomClaims: claims }); const s = boot(), id = begin(current);
    assert.ok(descend(id, current).ok); assert.deepEqual(durable(s).run.roomClaims, []);
    assert.ok(save.previewImport(save.exportSave()).ok);
});
await test("wrong run, mutated resources, identity, jumps and final floor fail before reducer", () => {
    const s = boot(), id = begin(), before = bytes(s), count = s.attempts.length; let called = 0;
    const reduce = () => { called++; throw new Error("not reached"); };
    const invalid = [{ ...run, floor: 6 }, { ...run, floor: 4 }, { ...run, floor: 19 },
        { ...run, seed: run.seed + 1 }, { ...run, coin: 999 }, { ...run, volume: 2 },
        { ...run, cardId: 18000000 }, { ...run, equipment: [] }, null];
    for (const checkpoint of invalid) assert.equal(save.advanceFloor(id, checkpoint, reduce).ok, false);
    assert.equal(save.advanceFloor("0".repeat(32), run, reduce).ok, false);
    assert.equal(called, 0); assert.equal(bytes(s), before); assert.equal(s.attempts.length, count);
    const last = { ...run, floor: 20 }; const finalId = begin(last);
    assert.equal(save.advanceFloor(finalId, last, reduce).ok, false); assert.equal(called, 0);
});
await test("invalid rewards cannot alter storage or the progression instance", () => {
    const s = boot(), id = begin(), before = bytes(s);
    for (const reduce of [() => { throw new Error("bad reducer"); }, () => ({ meta: { ...meta, pages: ["999"] }, newPages: ["999"] })]) {
        assert.equal(save.advanceFloor(id, run, reduce).ok, false); assert.equal(bytes(s), before);
    }
    assert.deepEqual(save.load("run"), run); assert.deepEqual(save.load("meta").pages, []);
});
await test("each authored guard floor advances once; recycled pages do not duplicate", () => {
    for (let volume = 1; volume <= 5; volume++) {
        const s = boot(); let current = { ...run, volume, floor: 1 }; const id = begin(current);
        for (let floor = 1; floor <= 19; floor++) {
            const result = descend(id, current); assert.ok(result.ok, result.error);
            assert.equal(result.newPages.length, floor <= 7 ? 1 : 0); current = result.run;
        }
        assert.equal(durable(s).run.floor, 20); assert.equal(durable(s).meta.pages.length, 7);
        assert.equal(durable(s).meta.gems, 800); assert.equal(durable(s).meta.volumes, 0);
    }
});
await test("numeric pre-existing pages are not awarded again", () => {
    const s = boot({ [META]: JSON.stringify({ ...meta, pages: [21000000] }) }), id = begin();
    const result = descend(id); assert.ok(result.ok); assert.deepEqual(result.newPages, []);
    assert.equal(durable(s).meta.pages.length, 1);
});
await test("stale callbacks cannot change a new run even with the same seed", () => {
    const s = boot(), old = begin(), fresh = begin(), before = bytes(s);
    assert.notEqual(old, fresh); assert.equal(descend(old).ok, false); assert.equal(bytes(s), before);
    assert.ok(descend(fresh).ok);
});
await test("terminal receipt and settings survive a later run descent unchanged", () => {
    const s = boot(), old = begin(); save.write("cam-height", 11);
    const facts = { outcome: "defeat", volume: 1, floor: 5, cardId: run.cardId, level: run.level, coin: run.coin, items: run.equipment };
    assert.ok(save.completeRun(old, facts, progression.terminalReward).saved); assert.ok(save.acknowledgeResult(old).ok);
    const receipt = durable(s).lastResult, fresh = begin(); assert.ok(descend(fresh).ok);
    assert.deepEqual(durable(s).lastResult, receipt); assert.equal(durable(s).settings["cam-height"], 11);
    assert.equal(durable(s).meta.gems, 818); const before = bytes(s);
    assert.equal(descend(old).ok, false); assert.equal(bytes(s), before);
});
await test("death after descent settles exactly once and late descent cannot resurrect it", () => {
    const s = boot(), id = begin(), result = descend(id);
    const facts = { outcome: "defeat", volume: 1, floor: 6, cardId: run.cardId, level: run.level, coin: run.coin, items: run.equipment };
    assert.ok(save.completeRun(id, facts, progression.terminalReward).saved); const before = bytes(s);
    assert.equal(descend(id, result.run).ok, false); assert.equal(bytes(s), before);
    assert.equal(durable(s).run, null); assert.equal(durable(s).meta.gems, 818); assert.equal(durable(s).meta.pages.length, 1);
});
await test("conflict never queues a transition or overwrites another page", () => {
    const s = boot(), id = begin(); s.setItem(PROFILE, JSON.stringify({ ...durable(s), revision: durable(s).revision + 1 }));
    const before = bytes(s), count = s.attempts.length; assert.equal(descend(id).ok, false);
    assert.equal(bytes(s), before); assert.equal(s.attempts.length, count); assert.equal(save.storageState().status, "conflict");
    const pending = JSON.parse(save.exportPendingSave()); assert.equal(pending.run.floor, 5); assert.deepEqual(pending.meta.pages, []);
    assert.equal(save.retryStorage().ok, false);
});
await test("transient reads fail closed and recover only on explicit descent", () => {
    const s = boot(), id = begin(), before = bytes(s); s.readFail = true; assert.equal(descend(id).ok, false);
    assert.equal(bytes(s), before); const pending = JSON.parse(save.exportPendingSave()); assert.equal(pending.run.floor, 5);
    assert.deepEqual(pending.meta.pages, []); s.readFail = false; assert.ok(save.retryStorage().ok);
    assert.equal(durable(s).run.floor, 5); assert.ok(descend(id).ok);
});
await test("session commit advances in-page without claiming durable persistence", () => {
    let denied = true; const target = storage();
    global.window = { get localStorage() { if (denied) throw new Error("denied"); return target; } };
    try {
        save.setStorage(null); save.initializeStorage(); save.write("meta", meta, { defer: true });
        const id = begin(), camp = progression.createMeta(); camp.read(); const result = camp.descendRun(id, run);
        assert.ok(result.ok); assert.equal(result.saved, false); assert.equal(result.status, "session");
        assert.equal(JSON.parse(save.exportPendingSave()).run.floor, 6); assert.equal(target.attempts.length, 0);
        assert.deepEqual(camp.progression.pages, ["21000000"]); denied = false; assert.ok(save.retryStorage().ok);
        assert.equal(target.attempts.length, 1); assert.equal(durable(target).run.floor, 6);
        assert.equal(descend(id).ok, false); assert.equal(target.attempts.length, 1);
    } finally { delete global.window; }
});
await test("restore invalidates the old transition and exposes only the imported run", () => {
    const s = boot(), old = begin(), backup = save.exportSave(); begin({ ...run, seed: run.seed + 1 });
    const candidate = clone(JSON.parse(backup)); candidate.runId = "1".repeat(32);
    assert.ok(save.importSave(JSON.stringify(candidate)).ok); const before = bytes(s);
    assert.equal(descend(old).ok, false); assert.equal(bytes(s), before); assert.equal(durable(s).runId, candidate.runId);
});
await test("returned data cannot mutate the committed profile", () => {
    const s = boot(), id = begin(), result = descend(id), before = bytes(s);
    result.run.coin = 999; result.meta.pages.push("999"); result.newPages.length = 0;
    assert.equal(bytes(s), before); assert.equal(save.load("run").coin, 90); assert.equal(save.load("meta").pages.length, 1);
});
console.log("Descent: " + passed + "/" + passed + " passed");
