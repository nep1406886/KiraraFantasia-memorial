import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as story from "../site/game/rl/story.js";
import { STORY_COMPANIONS } from "../site/game/rl/storycharacters.js";
import { PLAYABLE_ROSTER } from "../site/game/rl/rosterids.js";
import { loadDialogueScripts, getNode } from "../site/game/rl/dialogue.js";
import { createMeta, mergeState, terminalReward, pagesForVolume, FINALE_PAGES } from "../site/game/rl/meta.js";
import { createProfileValidator, emptyProfile } from "../site/game/rl/profileschema.js";
import { createStats } from "../site/asset/rl/stats.js";
import { ACHIEVEMENTS } from "../site/game/rl/achievements.js";
import * as save from "../site/game/rl/save.js";

const read = name => JSON.parse(readFileSync(new URL("../site/asset/rl/" + name, import.meta.url), "utf8"));
const stats = createStats({ cards: read("cards-rl.json").cards, growth: read("growth.json"), enemies: read("enemies.json").enemies });
const validate = createProfileValidator({ stats, weapons: read("weapons-rl.json"), mergeMeta: mergeState,
    pageIds: [1, 2, 3, 4, 5].flatMap(pagesForVolume).concat(FINALE_PAGES), achievementIds: ACHIEVEMENTS.map(row => row.id) });
const scripts = {};
for (const file of readdirSync(new URL("../site/asset/rl/dialogue/", import.meta.url)).filter(name => name.endsWith(".js"))) {
    new Function("window", readFileSync(new URL("../site/asset/rl/dialogue/" + file, import.meta.url), "utf8"))(scripts);
}
assert.ok(loadDialogueScripts(scripts).ok);
const oldId = "1".repeat(32), currentId = "2".repeat(32);
const receipt = { runId: oldId, outcome: "defeat", volume: 1, acknowledged: true, revision: 4 };
const PROFILE = "kirafan-rl:profile";
const snapshot = { schemaVersion: 3, generatorVersion: "t24-1", seed: 28119, volume: 1, floor: 1,
    cardId: 25002001, level: 1, exp: 0, hp: 1, gauge: 0, coin: 0, stackHits: 0, stackKills: 0, equipment: [], roomClaims: [] };
let count = 0;
function test(name, fn) { fn(); count++; console.log("PASS " + name); }
function boot() {
    const memory = new Map();
    const storage = { fail: false, attempts: 0, memory,
        getItem(key) { return memory.get(key) ?? null; },
        setItem(key, value) { this.attempts++; if (this.fail) throw new Error("quota"); memory.set(key, String(value)); },
        removeItem(key) { memory.delete(key); }, get length() { return memory.size; }, key(i) { return [...memory.keys()][i] ?? null; } };
    save.setStorage(storage); save.setImportValidator(validate); assert.ok(save.initializeStorage().ok);
    return storage;
}
function begin(run = snapshot, options) { const result = save.beginRun(run, options); assert.ok(result.accepted, result.error); return result.runId; }
function finish(id, outcome = "defeat") {
    return save.completeRun(id, { outcome, volume: 1, floor: outcome === "victory" ? 20 : 1,
        cardId: snapshot.cardId, level: 1, coin: 0, items: [] }, terminalReward);
}

test("有限上一局条件命中胜败与卷号，不把当前卷当成上次卷", () => {
    const context = { volume: 5, lastResult: { outcome: "defeat", volume: 1 } };
    assert.equal(story.matchesStory({ lastResult: { outcome: "defeat", volume: 1 } }, context), true);
    assert.equal(story.matchesStory({ lastResult: { outcome: "victory" } }, context), false);
    assert.equal(story.matchesStory({ lastResult: { outcome: "defeat", volume: 5 } }, context), false);
    assert.equal(story.matchesStory({ lastResult: { outcome: "defeat" } }, context), true);
});
test("只读取已确认且不同局的持久收据，返回副本不泄漏所有权", () => {
    const actual = story.previousStoryResult(receipt, currentId);
    assert.deepEqual(actual, { outcome: "defeat", volume: 1 });
    actual.volume = 5; assert.equal(receipt.volume, 1);
    assert.equal(story.previousStoryResult(receipt, oldId), null);
    for (const id of [null, undefined, "", "new-run", 2, "2".repeat(31)]) assert.equal(story.previousStoryResult(receipt, id), null);
});
test("拒绝未确认、未保存、未知胜败、坏卷号与坏局编号", () => {
    for (const value of [null, [], {}, { ...receipt, acknowledged: false }, { ...receipt, acknowledged: 1 },
        { ...receipt, revision: 0 }, { ...receipt, revision: Infinity }, { ...receipt, revision: "4" },
        { ...receipt, outcome: "abandoned" }, { ...receipt, volume: 0 }, { ...receipt, volume: 6 },
        { ...receipt, volume: "1" }, { ...receipt, runId: "old" }, { ...receipt, runId: null }]) {
        assert.equal(story.previousStoryResult(value, currentId), null, JSON.stringify(value));
    }
});
test("上一局条件未知操作符和错误值失败关闭，空档不匹配", () => {
    const context = { lastResult: { outcome: "defeat", volume: 1 } };
    for (const value of [null, [], {}, "defeat", { outcome: "abandoned" }, { outcome: "defeat", volume: "1" },
        { outcome: "defeat", volume: 0 }, { outcome: "defeat", volume: 6 }, { outcome: "defeat", volume: Infinity },
        { outcome: "defeat", eval: "true" }, { outcome: "defeat", minFloor: 1 }]) {
        assert.equal(story.matchesStory({ lastResult: value }, context), false, JSON.stringify(value));
    }
    for (const lastResult of [undefined, null, [], {}, { outcome: "defeat", volume: 6 }, { outcome: "defeat", volume: "1" }]) {
        assert.equal(story.matchesStory({ lastResult: { outcome: "defeat" } }, { lastResult }), false);
    }
});
test("新增10条正文与稳定索引齐全，原289条没有被重用", () => {
    assert.equal(story.STORY_CATALOG.length, 299);
    assert.equal(new Set(story.STORY_CATALOG.map(row => row.id)).size, 299);
    const rows = story.STORY_CATALOG.filter(row => row.id.startsWith("return_"));
    assert.equal(rows.length, 10);
    for (const row of rows) {
        assert.equal(row.trigger, "rest"); assert.equal(row.priority, 80); assert.ok(Object.isFrozen(row.when.lastResult));
        assert.deepEqual(getNode(row.id).map(line => line.who), ["きらら", "うつつ"]);
        assert.throws(() => { row.when.lastResult.outcome = "changed"; }, TypeError);
    }
    assert.ok(story.validateStoryCatalog(getNode).ok);
    assert.equal(story.validateStoryCatalog(id => id === "return_v2_victory" ? null : getNode(id)).ok, false);
});
for (let volume = 1; volume <= 5; volume++) test("上一局卷" + volume + "：胜败互斥、已读不重播、选择与数组顺序无关", () => {
    for (const outcome of ["victory", "defeat"]) {
        const id = "return_v" + volume + "_" + outcome;
        const context = { volume: volume % 5 + 1, lastResult: { outcome, volume } };
        assert.equal(story.selectStory("rest", context), id);
        assert.equal(story.selectStory("rest", context, [], [...story.STORY_CATALOG].reverse()), id);
        assert.equal(story.selectStory("rest", context, [id]), null);
        assert.equal(story.selectStory("segment", context), null);
    }
});
test("41角色原有闲聊优先，耗尽当前分支才选择重返闲谈", () => {
    assert.equal(STORY_COMPANIONS.length, 41);
    for (const row of STORY_COMPANIONS) {
        const context = { cardId: row.cardId, character: PLAYABLE_ROSTER.find(card => card.id === row.cardId).legacyId,
            pages: [], lastResult: { outcome: "defeat", volume: 1 } };
        const chatter = "chatter_" + row.key + "_missing";
        assert.equal(story.selectStory("rest", context), chatter);
        assert.equal(story.selectStory("rest", context, [chatter]), "return_v1_defeat");
        assert.equal(story.selectStory("rest", context, [chatter, "return_v1_defeat"]), null);
    }
});
test("未读结果对白不剧透，回看副本不改源，299记录可完整备份", () => {
    const seen = ["return_v1_defeat"];
    const entries = story.storySections(seen, getNode, who => who).flatMap(section => section.entries);
    assert.equal(entries.length, 299); assert.equal(entries.filter(row => row.unlocked).length, 1);
    const locked = entries.find(row => row.id === "return_v5_victory");
    assert.equal(locked.title, "未归档的故事"); assert.deepEqual(locked.lines, []);
    const open = entries.find(row => row.id === seen[0]); open.lines[0].text = "view only";
    assert.notEqual(getNode(seen[0])[0].text, "view only");
    const ids = story.STORY_CATALOG.map(row => row.id), profile = { ...emptyProfile(), meta: mergeState({ storySeen: ids }) };
    assert.deepEqual(validate(JSON.parse(JSON.stringify(profile))).meta.storySeen, ids);
    assert.equal(story.isStoryId("return_v6_defeat"), false);
});
test("真实结算确认再开与续档保持上次结果；选择不写档、不重奖", () => {
    const storage = boot(), first = begin();
    assert.equal(story.previousStoryResult(save.load("lastResult"), first), null);
    assert.ok(finish(first).saved);
    assert.equal(story.previousStoryResult(save.load("lastResult"), currentId), null);
    assert.ok(save.acknowledgeResult(first).ok);
    const second = begin({ ...snapshot, cardId: 10002001, volume: 2 });
    const prior = save.load("lastResult"), before = storage.memory.get(PROFILE), writes = storage.attempts;
    const context = { volume: 2, lastResult: story.previousStoryResult(prior, second) };
    assert.equal(story.selectStory("rest", context), "return_v1_defeat");
    assert.equal(storage.memory.get(PROFILE), before); assert.equal(storage.attempts, writes);
    save.setStorage(storage); assert.ok(save.initializeStorage().ok);
    assert.equal(begin(save.load("run"), { resume: true }), second);
    assert.deepEqual(story.previousStoryResult(save.load("lastResult"), second), context.lastResult);
    const meta = createMeta(); meta.read(); const gems = meta.gems(), pages = [...meta.state.pages];
    assert.equal(meta.markStorySeen("return_v1_defeat"), true);
    assert.equal(meta.markStorySeen("return_v1_defeat"), false);
    assert.deepEqual(save.load("lastResult"), prior); assert.equal(save.load("runId"), second);
    assert.equal(meta.gems(), gems); assert.deepEqual(meta.state.pages, pages);
    assert.equal(story.selectStory("rest", context, meta.state.storySeen), null);
});
test("确认保存失败不产生上一局上下文，恢复后仅新局可读", () => {
    const storage = boot(), first = begin(); assert.ok(finish(first, "victory").saved);
    const before = storage.memory.get(PROFILE); storage.fail = true;
    assert.equal(save.acknowledgeResult(first).ok, false);
    assert.equal(story.previousStoryResult(save.load("lastResult"), currentId), null);
    assert.equal(save.beginRun(snapshot).accepted, false); assert.equal(storage.memory.get(PROFILE), before);
    storage.fail = false; assert.ok(save.retryStorage().ok);
    assert.equal(save.load("lastResult").acknowledged, false);
    assert.ok(save.acknowledgeResult(first).ok);
    assert.equal(story.previousStoryResult(save.load("lastResult"), first), null);
    const second = begin(); assert.deepEqual(story.previousStoryResult(save.load("lastResult"), second), { outcome: "victory", volume: 1 });
});
test("存储冲突不读取过时上次结果，既有字节不覆盖", () => {
    const storage = boot(), first = begin(); assert.ok(finish(first).saved); assert.ok(save.acknowledgeResult(first).ok);
    const second = begin(), concurrent = JSON.parse(storage.memory.get(PROFILE)); concurrent.revision++;
    storage.memory.set(PROFILE, JSON.stringify(concurrent)); const before = storage.memory.get(PROFILE);
    assert.equal(story.previousStoryResult(save.load("lastResult"), second), null);
    assert.equal(save.storageState().status, "conflict"); assert.equal(storage.memory.get(PROFILE), before);
});
console.log("\n" + count + " 项上次结果剧情检查通过。");
