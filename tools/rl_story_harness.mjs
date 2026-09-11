import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { STORY_CATALOG, selectStory, matchesStory, storySections, isStoryId, validateStoryCatalog } from "../site/game/rl/story.js";
import { loadDialogueScripts, getNode, play } from "../site/game/rl/dialogue.js";
import { mergeState, createMeta, pagesForVolume, FINALE_PAGES, descentReward, terminalReward } from "../site/game/rl/meta.js";
import { createProfileValidator, emptyProfile } from "../site/game/rl/profileschema.js";
import { createStats } from "../site/asset/rl/stats.js";
import { ACHIEVEMENTS } from "../site/game/rl/achievements.js";
import * as save from "../site/game/rl/save.js";

const assets = new URL("../site/asset/rl/", import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, assets), "utf8"));
const scripts = {};
for (const file of readdirSync(new URL("dialogue/", assets)).filter(file => file.endsWith(".js"))) {
    new Function("window", readFileSync(new URL("dialogue/" + file, assets), "utf8"))(scripts);
}
assert.ok(loadDialogueScripts(scripts).ok);
const stats = createStats({ cards: read("cards-rl.json").cards, growth: read("growth.json"), enemies: read("enemies.json").enemies });
const validate = createProfileValidator({ stats, weapons: read("weapons-rl.json"), mergeMeta: mergeState,
    pageIds: [1, 2, 3, 4, 5].flatMap(pagesForVolume).concat(FINALE_PAGES), achievementIds: ACHIEVEMENTS.map(row => row.id) });
save.setImportValidator(validate);
let count = 0;
async function test(label, fn) { await fn(); count++; console.log("PASS " + label); }

await test("索引包含131个主线/条件故事及168个既有休息/退场故事且正文齐全", () => {
    assert.equal(STORY_CATALOG.length, 299);
    assert.equal(new Set(STORY_CATALOG.map(entry => entry.id)).size, 299);
    assert.equal(STORY_CATALOG.filter(entry => entry.trigger === "segment").length, 15);
    assert.equal(STORY_CATALOG.filter(entry => entry.trigger === "rest").length, 92);
    assert.ok(validateStoryCatalog(getNode).ok);
    assert.equal(validateStoryCatalog(id => id === "v3_turn_10" ? null : getNode(id)).ok, false);
});
await test("42位发言者的126休息词与42退场词逐条归档，不误认任意前缀", () => {
    for (const [group, prefix, total] of [["rest", "rest_", 126], ["exit", "exit_", 42]]) {
        const bodies = Object.keys(scripts.kirafanDialogue).filter(id => id.startsWith(prefix)).sort();
        const indexed = STORY_CATALOG.filter(entry => entry.group === group);
        assert.equal(bodies.length, total);
        assert.deepEqual(indexed.map(entry => entry.id).sort(), bodies);
        for (const entry of indexed) {
            assert.equal(entry.trigger, "manual", "archive entries must not enter conditional selection");
            assert.equal(isStoryId(entry.id), true);
            const who = entry.id.slice(prefix.length, group === "rest" ? -2 : undefined);
            assert.ok(getNode(entry.id).every(line => line.who === who));
        }
    }
    for (const id of ["rest_友兼_4", "exit_unknown", "rest_山口如月_1", "rest_constructor_1"]) {
        assert.equal(isStoryId(id), false);
    }
    assert.equal(selectStory("rest", { cardId: 25021000, character: 25021000 }), null);
});
await test("旧随机词按独立分组回看，历史友兼与当前如月不串名且未读不泄露", () => {
    const archived = ["rest_友兼_2", "exit_山口 如月"];
    const sections = storySections(archived, getNode, who => who);
    assert.deepEqual(sections.slice(-2).map(section => section.title), ["篝火旁的闲谈", "暂别与归途"]);
    const rest = sections.at(-2), exits = sections.at(-1);
    assert.equal(rest.entries.length, 126); assert.equal(exits.entries.length, 42);
    assert.equal(sections.slice(0,6).flatMap(section => section.entries).length, 131);
    const friend = rest.entries.find(entry => entry.id === archived[0]);
    assert.ok(friend.title.startsWith("友兼 · ")); assert.equal(friend.lines[0].who, "友兼");
    const kisaragi = exits.entries.find(entry => entry.id === archived[1]);
    assert.ok(kisaragi.title.startsWith("山口如月 · ")); assert.equal(kisaragi.lines[0].who, "山口 如月");
    const locked = rest.entries.find(entry => entry.id === "rest_山口 如月_1");
    assert.equal(locked.title, "未归档的故事"); assert.deepEqual(locked.lines, []);
    friend.lines[0].text = "changed only in replay";
    assert.notEqual(getNode(archived[0])[0].text, friend.lines[0].text);
});
await test("完整299条归档可通过严格备份往返，新增对白不推断为已读", () => {
    const ids = STORY_CATALOG.map(entry => entry.id);
    const profile = { ...emptyProfile(), meta: mergeState({ storySeen: ids }) };
    assert.deepEqual(validate(JSON.parse(JSON.stringify(profile))).meta.storySeen, ids);
    assert.deepEqual(mergeState({ volumes: 5, chars: [25021000, 25002001] }).storySeen, []);
    for (const storySeen of [["rest_友兼_2", "rest_友兼_2"], ["exit_unknown"], ["rest_ゆの_4"]]) {
        assert.throws(() => validate({ ...profile, meta: { ...profile.meta, storySeen } }));
    }
});
for (let volume = 1; volume <= 5; volume++) {
    await test("卷" + volume + "：转折只在成功越过5/10/15层后选择，不跨卷", () => {
        const context = { volume, floor: 5, pages: [] };
        assert.equal(selectStory("segment", context), null);
        const seen = [];
        for (const floor of [5, 10, 15]) {
            context.floor = floor + 1;
            const id = "v" + volume + "_turn_" + floor;
            assert.equal(selectStory("segment", context, seen), id);
            seen.push(id);
            assert.equal(selectStory("segment", context, seen), null);
            context.floor = floor + 5;
            assert.equal(selectStory("segment", context, seen), null);
        }
    });
}
for (const [key, character] of [["aoba", 15000000], ["rin", 23001000], ["maika", 20000000], ["haruka", 29001000], ["takayama", 19000000]]) {
    await test(key + "：收藏前后分支互斥，字符串旧页编号兼容，已读不复播", () => {
        const context = { volume: 1, floor: 1, character, pages: [] };
        assert.equal(selectStory("rest", context), "chatter_" + key + "_missing");
        context.pages = [String(character)];
        assert.equal(selectStory("rest", context), "chatter_" + key + "_found");
        assert.equal(selectStory("rest", context, ["chatter_" + key + "_found"]), null);
    });
}
await test("选择器优先级和同级ID排序稳定，不依赖数组顺序", () => {
    const catalog = [
        { id: "z", trigger: "rest", priority: 1, when: {} },
        { id: "b", trigger: "rest", priority: 2, when: {} },
        { id: "a", trigger: "rest", priority: 2, when: {} }
    ];
    assert.equal(selectStory("rest", {}, [], catalog), "a");
    assert.equal(selectStory("rest", {}, [], catalog.slice().reverse()), "a");
    assert.equal(selectStory("rest", {}, ["a"], catalog), "b");
    assert.equal(selectStory("rest", { character: 999 }), null);
});
await test("未知条件、脚本、非有限数值与非法页条件全部失败关闭", () => {
    for (const when of [null, [], { eval: "true" }, { volume: "1" }, { minFloor: Infinity },
        { character: -1 }, { page: { id: 15000000, owned: "false" } }, { page: { id: 1, owned: true, code: "x" } }]) {
        assert.equal(matchesStory(when, { volume: 1, floor: 20, character: 15000000, pages: [] }), false);
    }
});
await test("旧档默认未归档，不按通关或旧序章标记推断观看；内存归并去重", () => {
    assert.deepEqual(mergeState({ volumes: 5, prologueSeen: true }).storySeen, []);
    assert.deepEqual(mergeState({ storySeen: ["v1_turn_5", "v1_turn_5", "bad", 10] }).storySeen, ["v1_turn_5"]);
    assert.equal(isStoryId("constructor"), false);
});
await test("图鉴只给已读正文，未知/未读节点不泄露标题；调用不修改源", () => {
    const seen = ["v1_turn_5"], before = JSON.stringify(scripts.kirafanDialogue);
    const entries = storySections(seen, getNode, () => "同行者").flatMap(section => section.entries);
    assert.equal(entries.filter(entry => entry.unlocked).length, 1);
    const open = entries.find(entry => entry.id === "v1_turn_5");
    assert.equal(open.title, "潮线下的阶梯"); assert.equal(open.lines.length, 2);
    const locked = entries.find(entry => entry.id === "v5_turn_15");
    assert.deepEqual(locked.lines, []); assert.equal(locked.title, "未归档的故事");
    open.lines[0].text = "view mutation";
    assert.equal(JSON.stringify(scripts.kirafanDialogue), before);
    assert.deepEqual(seen, ["v1_turn_5"]);
});
await test("播放结束一次归档，跳过不显示后续台词，下一段不继承跳过", async () => {
    let shown = 0, finished = 0, skipped = false, skipAfterFirst = true;
    const presenter = {
        begin() { skipped = false; }, isSkipped() { return skipped; },
        showLine() { shown++; }, waitInput() { skipped = skipAfterFirst; return Promise.resolve(); },
        finish() { finished++; }
    };
    await play("v1_turn_5", presenter);
    assert.equal(shown, 1); assert.equal(finished, 1);
    shown = 0; skipAfterFirst = false;
    await play("v1_turn_10", presenter);
    assert.equal(shown, 2); assert.equal(finished, 2);
    let archived = false;
    await assert.rejects(play("v1_turn_5", { showLine() {}, waitInput() { return Promise.reject(new Error("failed")); } })
        .then(() => { archived = true; }));
    assert.equal(archived, false);
    await assert.rejects(play("v1_turn_5", {
        showLine() { throw new Error("sync presenter failure"); }, waitInput() { return Promise.resolve(); }
    }).then(() => { archived = true; }), /sync presenter failure/);
    assert.equal(archived, false);
});
await test("备份往返保持归档，未知/重复/错误类型拒绝整包", () => {
    const profile = { ...emptyProfile(), meta: mergeState({ gems: 70, storySeen: ["v1_turn_5", "chatter_rin_found"] }) };
    assert.deepEqual(validate(JSON.parse(JSON.stringify(profile))).meta.storySeen, ["v1_turn_5", "chatter_rin_found"]);
    for (const storySeen of [["bad"], ["v1_turn_5", "v1_turn_5"], [1], {}, "v1_turn_5"]) {
        assert.throws(() => validate({ ...profile, meta: { ...profile.meta, storySeen } }));
    }
});
await test("下潜和胜败归并保留已读记录，不修改输入", () => {
    const seen = ["v1_turn_5", "rest_友兼_2", "exit_山口 如月"];
    const meta = mergeState({ storySeen: seen, gems: 30 }), before = JSON.stringify(meta);
    assert.deepEqual(descentReward(meta, { volume: 1, floor: 5 }).meta.storySeen, seen);
    for (const outcome of ["victory", "defeat"]) {
        assert.deepEqual(terminalReward(meta, { outcome, volume: 1, items: [] }).meta.storySeen, seen);
    }
    assert.equal(JSON.stringify(meta), before);
});
await test("归档幂等，保存失败只保留页面候选，重试与导入不重复奖励", () => {
    const memory = new Map(); let fail = false, writes = 0;
    const storage = {
        getItem(key) { return memory.get(key) ?? null; },
        setItem(key, value) { writes++; if (fail) throw new Error("quota"); memory.set(key, String(value)); },
        removeItem(key) { memory.delete(key); }, get length() { return memory.size; }, key(i) { return [...memory.keys()][i] ?? null; }
    };
    save.setStorage(storage); assert.ok(save.initializeStorage().ok);
    const meta = createMeta(); meta.read();
    assert.equal(meta.markStorySeen("v1_turn_5"), true);
    const before = save.exportSave(), oldWrites = writes;
    assert.equal(meta.markStorySeen("v1_turn_5"), false);
    assert.equal(meta.markStorySeen("missing"), false); assert.equal(writes, oldWrites);
    fail = true;
    assert.equal(meta.markStorySeen("rest_友兼_2"), true);
    assert.equal(meta.markStorySeen("exit_山口 如月"), true);
    assert.equal(save.exportSave(), before);
    assert.equal(save.storageState().status, "unsaved");
    assert.equal(meta.seenStory("rest_友兼_2"), true);
    assert.equal(meta.seenStory("exit_山口 如月"), true);
    fail = false; assert.ok(save.retryStorage().ok);
    const after = save.exportSave(); assert.ok(save.importSave(after).ok);
    meta.read(); assert.deepEqual(meta.state.storySeen, ["v1_turn_5", "rest_友兼_2", "exit_山口 如月"]);
    assert.equal(meta.gems(), 0); assert.deepEqual(meta.state.pages, []);
});
console.log("\n" + count + " 项故事专项逻辑检查通过。");
