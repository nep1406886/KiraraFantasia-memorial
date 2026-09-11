// T28: whole-profile terminal transactions, receipts, migration and fault recovery.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as save from "../site/game/rl/save.js";
import { createProfileValidator, emptyProfile, PROFILE_VERSION } from "../site/game/rl/profileschema.js";
import { createMeta, mergeState, terminalReward, pagesForVolume, FINALE_PAGES } from "../site/game/rl/meta.js";
import { ACHIEVEMENTS } from "../site/game/rl/achievements.js";
import { createStats } from "../site/asset/rl/stats.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const stats = createStats({ cards: read("cards-rl.json").cards, growth: read("growth.json"), enemies: read("enemies.json").enemies });
const validate = createProfileValidator({ stats, weapons: read("weapons-rl.json"), mergeMeta: mergeState,
    pageIds: [1, 2, 3, 4, 5].flatMap(pagesForVolume).concat(FINALE_PAGES), achievementIds: ACHIEVEMENTS.map(row => row.id) });
const PROFILE = "kirafan-rl:profile", META = "kirafan-rl:meta", RUN = "kirafan-rl:run";
const clone = value => JSON.parse(JSON.stringify(value));
const meta = mergeState({ gems: 800, prologueSeen: true, tutorialSeen: true });
const run = { schemaVersion: 3, generatorVersion: "t24-1", seed: 28001, volume: 1, floor: 1,
    cardId: 10000000, level: 24, exp: 0, hp: 400, gauge: 0, coin: 90, stackHits: 0, stackKills: 0,
    equipment: [{ slot: "charm", rarity: "legendary", affixes: [] }], roomClaims: [] };
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
function begin(snapshot = run, options) { const started = save.beginRun(clone(snapshot), options); assert.ok(started.accepted, started.error); return started.runId; }
const facts = (outcome = "defeat", snapshot = run) => ({ outcome, volume: snapshot.volume,
    floor: outcome === "victory" ? 20 : snapshot.floor, cardId: snapshot.cardId,
    level: snapshot.level, coin: snapshot.coin, items: clone(snapshot.equipment) });
const finish = (id, outcome = "defeat", snapshot = run) => save.completeRun(id, facts(outcome, snapshot), terminalReward);
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("PASS " + name); }

await test("pure rewards leave source state and equipment unchanged", () => {
    const before = JSON.stringify({ meta, run }); const reward = terminalReward(meta, facts());
    assert.equal(reward.gems, 18); assert.equal(reward.meta.gems, 818); assert.deepEqual(reward.newPages, []);
    assert.equal(JSON.stringify({ meta, run }), before);
});
await test("profile v1 migrates once, keeps revision and does not bind an uncontinued run", () => {
    const old = { ...emptyProfile(), profileVersion: 1, revision: 17, meta, run }; delete old.runId;
    const s = boot({ [PROFILE]: JSON.stringify(old), [RUN]: JSON.stringify(run) });
    assert.equal(durable(s).profileVersion, PROFILE_VERSION); assert.equal(durable(s).revision, 18);
    assert.equal(durable(s).runId, null); assert.deepEqual(durable(s).run, run);
    assert.equal(s.memory.get(RUN), JSON.stringify(run)); assert.equal(s.attempts.length, 1);
    save.setStorage(s); assert.ok(save.initializeStorage().ok); assert.equal(s.attempts.length, 1);
});
await test("failed v1 migration keeps exact bytes and retries the complete v2 profile", () => {
    const old = { ...emptyProfile(), profileVersion: 1, revision: 17, meta, run }; delete old.runId;
    const s = storage({ [PROFILE]: JSON.stringify(old) }); s.fail = true; save.setStorage(s);
    const before = bytes(s); assert.equal(save.initializeStorage().ok, false); assert.equal(bytes(s), before);
    assert.equal(JSON.parse(save.exportPendingSave()).profileVersion, 2); s.fail = false;
    assert.ok(save.retryStorage().ok); assert.equal(durable(s).revision, 18);
});
await test("new run identity is independent of equal seeds; continue preserves it", () => {
    const s = boot(); const first = begin(); const second = begin(); assert.notEqual(first, second);
    assert.match(second, /^[0-9a-f]{32}$/); assert.equal(durable(s).run.seed, run.seed);
    save.setStorage(s); assert.ok(save.initializeStorage().ok); assert.equal(begin(durable(s).run, { resume: true }), second);
});
await test("a stale continue snapshot cannot bind or overwrite changed progress", () => {
    const s = boot(); const id = begin(); assert.ok(save.write("run", { ...run, coin: 123 }, { runId: id }));
    const before = bytes(s); assert.equal(save.beginRun(run, { resume: true }).accepted, false); assert.equal(bytes(s), before);
});
await test("terminal reward, clear and receipt use exactly one commit", () => {
    const s = boot(); const id = begin(), count = s.attempts.length; s.failAt = count + 2;
    const result = finish(id); assert.ok(result.saved, result.error); assert.equal(s.attempts.length, count + 1);
    const p = durable(s); assert.equal(p.run, null); assert.equal(p.runId, null); assert.equal(p.meta.gems, 818);
    assert.equal(p.lastResult.runId, id); assert.equal(p.lastResult.revision, p.revision);
    assert.equal(p.lastResult.acknowledged, false); assert.equal(p.lastResult.gems, 18);
});
await test("quota failure retains a complete receipt without altering any original bytes", () => {
    const s = boot(); const id = begin(); const before = bytes(s); s.fail = true;
    const result = finish(id); assert.equal(result.saved, false); assert.equal(bytes(s), before);
    assert.equal(result.receipt.revision, 0); const pending = JSON.parse(save.exportPendingSave());
    assert.equal(pending.run, null); assert.equal(pending.runId, null); assert.equal(pending.meta.gems, 818);
    assert.deepEqual(pending.lastResult, result.receipt); assert.ok(save.previewImport(JSON.stringify(pending)).ok);
});
await test("duplicate terminal requests never rerun the reducer or enqueue another award", () => {
    const s = boot(); const id = begin(); s.fail = true; finish(id); const count = s.attempts.length;
    const twice = save.completeRun(id, facts("victory"), () => { throw new Error("must not recalculate"); });
    assert.equal(twice.receipt.outcome, "defeat"); assert.equal(twice.meta.gems, 818); assert.equal(s.attempts.length, count);
    s.fail = false; assert.ok(save.retryStorage().ok); assert.equal(s.attempts.length, count + 1);
    assert.equal(durable(s).lastResult.revision, durable(s).revision); assert.equal(durable(s).meta.gems, 818);
    const before = bytes(s); finish(id); assert.equal(bytes(s), before); assert.equal(s.attempts.length, count + 1);
});
await test("terminal candidate composes prior unsaved collections, run and camera facts", () => {
    const s = boot(); const id = begin(); const camp = createMeta(); camp.read(); s.fail = true;
    camp.collectPage(pagesForVolume(2)[0]); save.write("cam-height", 12, { defer: true });
    save.write("run", { ...run, coin: 456 }, { defer: true, runId: id });
    const result = camp.settleRun(id, { ...facts(), coin: 456 }); assert.equal(result.receipt.coin, 456);
    assert.equal(camp.gems(), 818); s.fail = false; const count = s.attempts.length;
    assert.ok(save.retryStorage().ok); assert.equal(s.attempts.length, count + 1);
    assert.equal(durable(s).settings["cam-height"], 12); assert.equal(durable(s).meta.pages.length, 1);
    assert.equal(durable(s).meta.gems, 818); assert.equal(durable(s).run, null);
});
await test("an unrelated successful write commits the full terminal candidate once", () => {
    const s = boot(); const id = begin(); s.fail = true; finish(id); s.fail = false;
    assert.ok(save.write("cam-height", 10)); assert.equal(durable(s).meta.gems, 818);
    assert.equal(durable(s).lastResult.revision, durable(s).revision); assert.ok(save.resultState(id).saved);
});
await test("通关后逐段归档只增加已读记录，不改奖励或重盖收据修订号", () => {
    const s = boot(); const snapshot = { ...run, volume: 5, floor: 20 }, id = begin(snapshot);
    const camp = createMeta(); camp.read(); camp.settleRun(id, facts("victory", snapshot));
    const settled = durable(s), count = s.attempts.length;
    const nodes = ["v5_boss_post", "v5_close", "finale_end"];
    nodes.forEach((node, i) => {
        assert.ok(camp.markStorySeen(node));
        const p = durable(s);
        assert.deepEqual(p, { ...settled, revision: settled.revision + i + 1,
            meta: { ...settled.meta, storySeen: nodes.slice(0, i + 1) } });
        assert.ok(save.resultState(id).saved);
    });
    assert.equal(s.attempts.length, count + nodes.length);
    assert.equal(camp.markStorySeen("finale_end"), false);
    assert.equal(camp.markStorySeen("missing"), false);
    camp.settleRun(id, facts("victory", snapshot));
    assert.equal(s.attempts.length, count + nodes.length);
});
await test("终局与所有归档持续写失败保留原字节，显式重试一次提交全部事实", () => {
    const s = boot(); const snapshot = { ...run, volume: 5, floor: 20 }, id = begin(snapshot);
    const camp = createMeta(); camp.read(); const before = bytes(s), revision = durable(s).revision;
    s.fail = true; const result = camp.settleRun(id, facts("victory", snapshot));
    const pendingTerminal = JSON.parse(save.exportPendingSave());
    const nodes = ["v5_boss_post", "v5_close", "finale_end"];
    for (const node of nodes) { assert.ok(camp.markStorySeen(node)); assert.equal(bytes(s), before); }
    const pending = JSON.parse(save.exportPendingSave());
    assert.deepEqual(pending, { ...pendingTerminal, meta: { ...pendingTerminal.meta, storySeen: nodes } });
    assert.equal(pending.lastResult.revision, 0); assert.deepEqual(pending.lastResult, result.receipt);
    assert.equal(save.acknowledgeResult(id).ok, false);
    const count = s.attempts.length; s.fail = false; assert.ok(save.retryStorage().ok);
    assert.equal(s.attempts.length, count + 1);
    assert.deepEqual(durable(s), { ...pending, revision: revision + 1,
        lastResult: { ...pending.lastResult, revision: revision + 1 } });
    assert.ok(save.resultState(id).saved); assert.equal(durable(s).lastResult.acknowledged, false);
    camp.settleRun(id, facts("victory", snapshot));
    assert.equal(s.attempts.length, count + 1);
});
await test("首次终局写失败后已读归档可以保存完整候选，但不确认结果或重算奖励", () => {
    const s = boot(); const snapshot = { ...run, volume: 5, floor: 20 }, id = begin(snapshot);
    const camp = createMeta(); camp.read(); const before = bytes(s), revision = durable(s).revision;
    s.failAt = s.attempts.length + 1;
    assert.equal(camp.settleRun(id, facts("victory", snapshot)).saved, false);
    assert.equal(bytes(s), before); const pending = JSON.parse(save.exportPendingSave());
    assert.ok(camp.markStorySeen("v5_boss_post"));
    assert.deepEqual(durable(s), { ...pending, revision: revision + 1,
        lastResult: { ...pending.lastResult, revision: revision + 1 },
        meta: { ...pending.meta, storySeen: ["v5_boss_post"] } });
    assert.ok(save.resultState(id).saved); assert.equal(save.exportPendingSave(), null);
    const count = s.attempts.length; camp.settleRun(id, facts("victory", snapshot));
    assert.equal(s.attempts.length, count); assert.equal(durable(s).lastResult.acknowledged, false);
});
await test("终局已保存但最后一段归档失败时禁止确认，重试不改变已提交收据", () => {
    const s = boot(); const id = begin({ ...run, floor: 20 });
    const camp = createMeta(); camp.read(); camp.settleRun(id, facts("victory"));
    camp.markStorySeen("v1_boss_post"); const settled = durable(s), before = bytes(s);
    const observed = []; const unsubscribe = save.subscribeStorage(state => observed.push(state.status));
    try {
        s.fail = true; assert.ok(camp.markStorySeen("v1_close"));
        assert.equal(bytes(s), before); assert.equal(save.resultState(id).saved, false);
        assert.equal(save.resultState(id).canRetry, true);
        assert.equal(save.acknowledgeResult(id).ok, false);
        assert.equal(observed.at(-1), "unsaved");
        s.fail = false; assert.ok(save.retryStorage().ok);
        assert.deepEqual(durable(s), { ...settled, revision: settled.revision + 1,
            meta: { ...settled.meta, storySeen: ["v1_boss_post", "v1_close"] } });
        assert.equal(observed.at(-1), "saved"); assert.ok(save.resultState(id).saved);
    } finally { unsubscribe(); }
});
await test("终局候选期间的跨页冲突仍可归档到本页，但绝不覆盖外页或排队确认", () => {
    const s = boot(); const id = begin({ ...run, floor: 20 });
    const camp = createMeta(); camp.read(); s.fail = true;
    camp.settleRun(id, facts("victory")); const pending = JSON.parse(save.exportPendingSave());
    s.fail = false; const external = { ...durable(s), revision: durable(s).revision + 1,
        settings: { "cam-height": 12 } };
    s.memory.set(PROFILE, JSON.stringify(external)); const before = bytes(s), count = s.attempts.length;
    assert.ok(camp.markStorySeen("v1_boss_post")); assert.ok(camp.markStorySeen("v1_close"));
    assert.deepEqual(JSON.parse(save.exportPendingSave()), { ...pending,
        meta: { ...pending.meta, storySeen: ["v1_boss_post", "v1_close"] } });
    assert.equal(save.resultState(id).status, "conflict");
    assert.equal(save.retryStorage().ok, false); assert.equal(save.acknowledgeResult(id).ok, false);
    assert.equal(bytes(s), before); assert.equal(s.attempts.length, count);
});
await test("late saves and clears cannot resurrect a completed run", () => {
    const s = boot(); const id = begin(); finish(id); const before = bytes(s);
    assert.equal(save.write("run", run, { defer: true, runId: id }), false);
    assert.equal(save.write("run", run, { defer: true }), false);
    assert.equal(save.clear("run", { defer: true, runId: id }), false); assert.equal(bytes(s), before);
});
await test("unacknowledged results block a new run, and failed confirmation never navigates", () => {
    const s = boot(); const id = begin(); finish(id); assert.equal(save.beginRun(run).runId, null);
    s.fail = true; const before = bytes(s); assert.equal(save.acknowledgeResult(id).ok, false);
    assert.equal(bytes(s), before); assert.equal(save.resultState(id).receipt.acknowledged, false);
    s.fail = false; assert.ok(save.retryStorage().ok); assert.equal(durable(s).lastResult.acknowledged, false);
    assert.ok(save.acknowledgeResult(id).ok); const count = s.attempts.length;
    assert.ok(save.acknowledgeResult(id).ok); assert.equal(s.attempts.length, count);
});
await test("old callbacks cannot affect a newer run with the same seed", () => {
    const s = boot(); const old = begin(); finish(old); assert.ok(save.acknowledgeResult(old).ok);
    const fresh = begin(); assert.notEqual(fresh, old); const before = bytes(s);
    assert.equal(finish(old).receipt.runId, old); assert.equal(save.write("run", run, { runId: old }), false);
    assert.equal(save.acknowledgeResult(old).ok, false);
    assert.equal(bytes(s), before); assert.equal(durable(s).runId, fresh);
    assert.ok(save.write("run", { ...run, coin: 100 }, { runId: fresh }));
    finish(fresh); assert.equal(durable(s).meta.gems, 836);
    const latest = bytes(s); assert.equal(finish(old).receipt, null); assert.equal(bytes(s), latest);
});
await test("wrong identities are rejected before calculating rewards", () => {
    const s = boot(); begin(); const before = bytes(s); let called = false;
    const result = save.completeRun("0".repeat(32), facts(), () => { called = true; });
    assert.equal(result.receipt, null); assert.equal(called, false); assert.equal(bytes(s), before);
});
await test("defeat and victory settle the same equipment conversion", () => {
    for (const [outcome, expected] of [
        ["defeat", { newPages: [], pages: 0 }],
        ["victory", { newPages: pagesForVolume(1).map(String), pages: pagesForVolume(1).length }]]) {
        const s = boot(); const id = begin(); const count = s.attempts.length;
        const result = finish(id, outcome);
        assert.ok(result.saved, result.error);
        assert.equal(s.attempts.length, count + 1);
        assert.equal(durable(s).run, null); assert.equal(durable(s).runId, null);
        assert.equal(durable(s).lastResult.gems, 18, outcome);
        assert.equal(durable(s).lastResult.pages, expected.pages);
        assert.equal(durable(s).meta.gems, 818);
        // A duplicate terminal request must not rerun the reducer or re-award.
        const stored = JSON.parse(JSON.stringify(durable(s)));
        const replay = finish(id, outcome);
        assert.equal(replay.receipt.gems, 18);
        assert.equal(replay.receipt.pages, expected.pages);
        assert.deepEqual(durable(s), stored);
    }
});
await test("victory retains exact authored volume, finale rewards and equipment conversion", () => {
    for (const volume of [1, 5]) {
        const s = boot(); const snapshot = { ...run, volume, floor: 20 }; const id = begin(snapshot);
        const count = s.attempts.length; const result = finish(id, "victory", snapshot);
        assert.ok(result.saved, result.error); assert.equal(s.attempts.length, count + 1);
        assert.equal(durable(s).meta.gems, 818, "victory converts the same equipped loot");
        assert.equal(result.receipt.gems, 18);
        assert.equal(durable(s).meta.volumes, volume);
        assert.deepEqual(result.receipt.newPages, pagesForVolume(volume).concat(volume === 5 ? FINALE_PAGES : []).map(String));
        assert.equal(result.receipt.pages, result.receipt.newPages.length);
    }
});
await test("already owned pages are not counted as new terminal rewards", () => {
    const seedMeta = { ...meta, pages: pagesForVolume(1).slice(0, 2) }; boot({ [META]: JSON.stringify(seedMeta) });
    const id = begin(); const result = finish(id, "victory"); assert.equal(result.receipt.newPages.length, 5);
    assert.equal(result.receipt.pages, 7); assert.equal(result.meta.pages.length, 7);
});
await test("receipt import rebases revision, never recalculates and remains unacknowledged", () => {
    boot(); const id = begin(); finish(id); const backup = JSON.parse(save.exportSave());
    backup.revision = 99; backup.lastResult.revision = 99;
    const target = boot(); const count = target.attempts.length; assert.ok(save.importSave(JSON.stringify(backup)).ok);
    assert.equal(target.attempts.length, count + 1); assert.equal(durable(target).lastResult.revision, 2);
    assert.equal(durable(target).lastResult.acknowledged, false); assert.equal(durable(target).meta.gems, 818);
    save.setStorage(target); assert.ok(save.initializeStorage().ok); assert.equal(save.load("run"), null);
    const before = bytes(target); finish(id); assert.equal(bytes(target), before);
});
await test("an exported pending receipt becomes a single committed result on import", () => {
    const s = boot(); const id = begin(); s.fail = true; finish(id); const backup = save.exportPendingSave();
    const target = boot(); assert.ok(save.importSave(backup).ok); assert.ok(save.resultState(id).saved);
    assert.equal(durable(target).meta.gems, 818); assert.equal(durable(target).lastResult.acknowledged, false);
});
await test("failed receipt import preserves target raw bytes", () => {
    boot(); const id = begin(); finish(id); const backup = save.exportSave();
    const target = boot(); const before = bytes(target); target.fail = true;
    assert.equal(save.importSave(backup).ok, false); assert.equal(bytes(target), before);
});
await test("receipt range, identity, version and cross-field validation fail closed", () => {
    boot(); const id = begin(); finish(id, "victory"); const good = JSON.parse(save.exportSave());
    const invalid = [];
    for (const [key, value] of [["runId", "seed-28001"], ["outcome", "cancelled"], ["cardId", 999999],
        ["volume", 0], ["floor", 19], ["level", 101], ["coin", -1], ["equipmentCount", 5], ["gems", -1],
        ["newPages", ["999999"]], ["pages", 38], ["revision", good.revision + 1], ["acknowledged", 1], ["html", "<b>bad</b>"]]) {
        const p = clone(good); p.lastResult[key] = value; invalid.push(p);
    }
    let p = clone(good); p.run = clone(run); p.runId = id; invalid.push(p);
    p = clone(good); p.run = clone(run); p.runId = "0".repeat(32); invalid.push(p);
    p = clone(good); p.lastResult.revision = 0; p.lastResult.acknowledged = true; invalid.push(p);
    p = clone(good); p.meta.pages.pop(); invalid.push(p);
    p = clone(good); p.meta.volumes = 0; invalid.push(p);
    p = clone(good); p.lastResult.newPages = [p.lastResult.newPages[0], p.lastResult.newPages[0]]; invalid.push(p);
    p = clone(good); p.profileVersion = PROFILE_VERSION + 1; invalid.push(p);
    p = clone(good); p.profileVersion = 1; delete p.runId; invalid.push(p);
    p = { ...emptyProfile(), profileVersion: 1 }; invalid.push(p); // v1 cannot silently accept a v2 field
    for (const candidate of invalid) {
        const target = boot(); const before = bytes(target), count = target.attempts.length;
        assert.equal(save.importSave(JSON.stringify(candidate)).ok, false, JSON.stringify(candidate.lastResult));
        assert.equal(bytes(target), before); assert.equal(target.attempts.length, count);
    }
});
await test("receipt reads return copies rather than mutable profile ownership", () => {
    const s = boot(); const id = begin(); finish(id); const before = bytes(s);
    save.load("lastResult").acknowledged = true; save.resultState(id).receipt.gems = 999;
    assert.equal(save.resultState(id).receipt.gems, 18); assert.equal(bytes(s), before);
});
await test("an unacknowledged receipt cannot claim more gems than its complete profile contains", () => {
    boot(); const id = begin(); finish(id); const p = JSON.parse(save.exportSave()); p.meta.gems = 0;
    assert.equal(save.previewImport(JSON.stringify(p)).ok, false);
    p.lastResult.acknowledged = true;
    assert.ok(save.previewImport(JSON.stringify(p)).ok, "a historical confirmed award may already have been spent");
});
await test("cross-page conflict retains the terminal candidate but never overwrites the other page", () => {
    const s = boot(); const id = begin(); const external = { ...durable(s), revision: durable(s).revision + 1 };
    s.setItem(PROFILE, JSON.stringify(external)); const before = bytes(s), count = s.attempts.length;
    assert.equal(finish(id).saved, false); assert.equal(save.storageState().status, "conflict");
    assert.equal(bytes(s), before); assert.equal(s.attempts.length, count); assert.equal(save.retryStorage().ok, false);
    assert.equal(JSON.parse(save.exportPendingSave()).lastResult.runId, id);
    assert.equal(save.acknowledgeResult(id).ok, false);
});
await test("transient read failure retains the complete terminal transaction", () => {
    const s = boot(); const id = begin(); const before = bytes(s); s.readFail = true;
    const result = finish(id); assert.equal(result.saved, false); assert.equal(result.receipt.gems, 18);
    assert.equal(bytes(s), before); s.readFail = false; assert.ok(save.retryStorage().ok);
    assert.equal(durable(s).meta.gems, 818); assert.equal(durable(s).run, null);
});
await test("denied persistence can export a terminal receipt and recover without replay", () => {
    let denied = true; const target = storage();
    global.window = { get localStorage() { if (denied) throw new Error("denied"); return target; } };
    try {
        save.setStorage(null); assert.ok(save.initializeStorage().ok); save.write("meta", meta, { defer: true });
        const id = begin(); assert.equal(finish(id).saved, false); assert.equal(save.acknowledgeResult(id).ok, false);
        assert.equal(JSON.parse(save.exportPendingSave()).lastResult.gems, 18);
        denied = false; assert.ok(save.retryStorage().ok); assert.equal(target.attempts.length, 1);
        assert.ok(save.resultState(id).saved); assert.equal(durable(target).meta.gems, 818);
        finish(id); assert.equal(target.attempts.length, 1);
    } finally { delete global.window; }
});
await test("permission recovery cannot replace unseen progress with a local terminal result", () => {
    let denied = true; const target = storage({ [META]: JSON.stringify({ gems: 900 }) });
    global.window = { get localStorage() { if (denied) throw new Error("denied"); return target; } };
    try {
        save.setStorage(null); save.initializeStorage(); save.write("meta", meta, { defer: true });
        const id = begin(); finish(id); const before = bytes(target); denied = false;
        assert.equal(save.retryStorage().ok, false); assert.equal(bytes(target), before);
        assert.equal(save.storageState().status, "conflict"); assert.equal(JSON.parse(save.exportPendingSave()).meta.gems, 818);
    } finally { delete global.window; }
});
console.log("Terminal: " + passed + "/" + passed + " passed");
