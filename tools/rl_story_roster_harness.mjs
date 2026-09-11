// Current-card story coverage. Expected page/speaker aliases are independent
// fixtures: persistence identity must not be mistaken for the actor speaking.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { PLAYABLE_ROSTER } from "../site/game/rl/rosterids.js";
import { STORY_CATALOG, selectStory, matchesStory, storySections } from "../site/game/rl/story.js";
import { loadDialogueScripts, getNode } from "../site/game/rl/dialogue.js";
import { STORY_COMPANIONS, dialogueNameForCard, dialoguePresentationForName } from "../site/game/rl/storycharacters.js";

const root = new URL("../", import.meta.url);
const read = file => readFileSync(new URL(file, root), "utf8");
const cards = JSON.parse(read("site/asset/rl/cards-rl.json")).cards;
const window = {};
for (const file of readdirSync(new URL("site/asset/rl/dialogue/", root)).filter(file => file.endsWith(".js"))) {
    new Function("window", read("site/asset/rl/dialogue/" + file))(window);
}
assert.ok(loadDialogueScripts(window).ok);
const sharedPage = { 32172001: 32002000, 14002001: 14010000, 23012001: 23001000, 32022001: 32002000 };
const names = { "細野 はるみ": "はるみ", "御庭 つみき": "つみき", "小野坂 こはる": "こはる",
    "篠華 まゆ": "まゆ", "アリス": "アリス・カータレット", "双葉": "小田切 双葉", "なでしこ": "各務原 なでしこ" };
let failures = 0, checks = 0;
function check(label, fn) {
    checks++;
    try { fn(); console.log("PASS " + label); }
    catch (error) { failures++; console.log("FAIL " + label + ": " + error.message); }
}

for (const identity of PLAYABLE_ROSTER) {
    const card = cards.find(card => card.id === identity.id);
    const base = card.name.replace(/【.*$/, ""), who = names[base] || base;
    const page = sharedPage[card.id] || identity.legacyId;
    check(card.id + " 收藏前后各有正确人物/作品的互斥闲聊", () => {
        assert.ok(window.kirafanPages[page], "work page must exist");
        const context = { volume: 1, floor: 1, cardId: card.id, character: identity.legacyId, pages: [] };
        const missing = selectStory("rest", context);
        const foundContext = { ...context, pages: [String(page)] };
        const found = selectStory("rest", foundContext);
        assert.ok(missing, "missing branch is unreachable");
        assert.ok(found, "found branch is unreachable");
        assert.notEqual(missing, found, "the two conditions cannot select one branch");
        for (const [id, owned, ctx] of [[missing, false, context], [found, true, foundContext]]) {
            const entry = STORY_CATALOG.find(entry => entry.id === id);
            assert.deepEqual(entry.when.page, { id: page, owned });
            assert.equal(getNode(id)[0].who, who, "the currently selected character must speak");
            assert.equal(matchesStory(entry.when, owned ? context : foundContext), false);
            assert.equal(selectStory("rest", ctx, [id]), null, "already-read branch must not repeat");
            assert.equal(selectStory("rest", ctx, [], STORY_CATALOG.slice().reverse()), id);
        }
    });
    check(card.id + " 当前人物具有三条闲聊和力竭退场词", () => {
        assert.equal(dialogueNameForCard(card), who);
        assert.equal(dialogueNameForCard({ id: card.id - 1, evolvedId: card.id, name: card.name }), who);
        for (const id of [1, 2, 3].map(n => "rest_" + who + "_" + n).concat("exit_" + who)) {
            assert.ok(getNode(id)?.length, "missing " + id);
            assert.ok(getNode(id).every(line => line.who === who));
        }
    });
}

check("当前卡表逐个对应，历史友兼不能被如月替代", () => {
    assert.deepEqual(STORY_COMPANIONS.map(row => row.cardId), PLAYABLE_ROSTER.map(row => row.id));
    assert.equal(dialogueNameForCard({ id: 25021000, name: "友兼" }), "友兼");
    assert.equal(dialogueNameForCard(null), null);
    assert.equal(dialogueNameForCard({ id: 999 }), null);
    assert.equal(selectStory("rest", { cardId: 25021000, character: 25021000, pages: [] }), null);
});
check("新增身份条件拒绝无效值与不匹配卡片", () => {
    for (const value of [null, "25002001", -1, 0, Infinity, NaN, 25002001.5]) {
        assert.equal(matchesStory({ cardId: value }, { cardId: 25002001 }), false);
        assert.equal(matchesStory({ cardId: 25002001 }, { cardId: value }), false);
    }
    assert.equal(matchesStory({ cardId: 25002001 }, { cardId: 25021000 }), false);
});
check("如月和克蕾尔显式使用本地原作图，不借用友兼或红爱的身份", () => {
    for (const [who, id, name, suffix] of [["山口 如月", 25002001, "山口如月", "card/25002001.webp"],
        ["クレア", 32022001, "克蕾尔", "orig/illust_4.webp"]]) {
        const result = dialoguePresentationForName(who);
        assert.equal(result.id, id);
        assert.equal(result.nameZh, name);
        assert.ok(result.bust.endsWith(suffix));
        assert.ok(existsSync(new URL(result.bust, new URL("site/game/rl/main.js", root))));
        result.nameZh = "mutated";
        assert.equal(dialoguePresentationForName(who).nameZh, name);
    }
    for (const who of ["友兼", "クレア【温泉】", "クレア【ハロウィン】", "ゆの", null]) {
        assert.equal(dialoguePresentationForName(who), null, "existing resolver must keep ownership of " + who);
    }
});
check("终章不冒充九十九篇收藏，休息词不再混入错误职业与硬译口癖", () => {
    const finale = getNode("finale_intro").map(line => line.text).join("");
    assert.ok(!/九十九篇|99/.test(finale));
    const body = Object.values(window.kirafanDialogue).flat().map(line => line.text).join("\n");
    assert.ok(!/DEATH|暴风雨放晴|接球是接住的技术|生意家伙|造出来的孩子/.test(body));
});

check("41对条件闲聊互不覆盖，旧主线和15个转折保留", () => {
    assert.equal(STORY_CATALOG.filter(entry => entry.id.startsWith("chatter_")).length, 82);
    assert.equal(STORY_CATALOG.filter(entry => entry.id.startsWith("return_")).length, 10);
    assert.equal(STORY_CATALOG.filter(entry => entry.trigger === "segment").length, 15);
    assert.equal(STORY_CATALOG.length, 299);
    assert.equal(new Set(STORY_CATALOG.map(entry => entry.id)).size, 299);
});
check("未归档的新内容不泄露正文或标题，回看只返回副本", () => {
    const entries = storySections([], getNode, name => name).flatMap(section => section.entries);
    assert.equal(entries.length, 299);
    assert.ok(entries.every(entry => !entry.unlocked && !entry.lines.length && entry.title === "未归档的故事"));
    const id = selectStory("rest", { cardId: 25002001, character: 25021000, pages: [] });
    const before = JSON.stringify(window.kirafanDialogue);
    const opened = storySections([id], getNode, name => name).flatMap(section => section.entries).find(entry => entry.id === id);
    assert.ok(opened.unlocked);
    opened.lines[0].text = "view-only change";
    assert.equal(JSON.stringify(window.kirafanDialogue), before);
});
console.log(checks + " checks, " + failures + " failures");
process.exitCode = failures ? 1 : 0;
