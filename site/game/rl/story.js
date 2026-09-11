// Authored story index, separate from the plain-JS dialogue bodies. No world,
// storage, DOM or random-stream access: selection and archive views are pure.
import { STORY_COMPANIONS } from "./storycharacters.js";
const entries = [
    { id: "prologue", title: "召唤灯与褪色的书", volume: 0, trigger: "manual" },
    { id: "finale_intro", title: "最后一页之前", volume: 5, trigger: "manual" },
    { id: "finale_pre", title: "与守页者相见", volume: 5, trigger: "manual" },
    { id: "finale_end", title: "还可以写下的故事", volume: 5, trigger: "manual" }
];
const turns = [
    ["潮线下的阶梯", "灯光照不到的蓝", "浪尖上的约定"],
    ["绿洲不是终点", "夜沙里的方向", "蜃楼中的空座"],
    ["蜜香背后的脚印", "蘑菇围成的圆", "树海归还的回声"],
    ["被遗漏的一拍", "炉火记得的手", "废墟中的接力"],
    ["回廊尽头的空白", "记忆之间的留白", "给下一行留个位置"]
];
for (let volume = 1; volume <= 5; volume++) {
    for (const [suffix, title] of [["open", "卷头"], ["boss_pre", "首领之前"],
        ["boss_post", "首领之后"], ["close", "卷尾"]]) {
        entries.push({ id: "v" + volume + "_" + suffix, title, volume, trigger: "manual" });
    }
    [5, 10, 15].forEach((floor, index) => entries.push({
        id: "v" + volume + "_turn_" + floor, title: turns[volume - 1][index], volume,
        trigger: "segment", priority: 200 + floor,
        when: { volume, minFloor: floor + 1 }, hint: "通过第 " + floor + " 层后归档"
    }));
}
// The five published pairs retain their historic condition/API. New scenes
// require an exact current card; a shared work page never chooses the speaker.
const legacyConditions = { aoba: 15000000, rin: 23001000, maika: 20000000, haruka: 29001000, takayama: 19000000 };
for (const { cardId, key, name, pageId, titles } of STORY_COMPANIONS) {
    const actor = legacyConditions[key] ? { character: legacyConditions[key] } : { cardId };
    [false, true].forEach((owned, index) => entries.push({
        id: "chatter_" + key + "_" + (owned ? "found" : "missing"), title: name + " · " + titles[index],
        volume: 0, trigger: "rest", priority: 100,
        when: { ...actor, page: { id: pageId, owned } }, hint: "对应角色在休息点交谈后归档"
    }));
}
const returnTitles = [
    ["潮声还在", "风暴之后的潮声"],
    ["先辨方向", "多留一张椅子"],
    ["记住来路", "带回的回声"],
    ["不是少了一枚齿轮", "记得那双手"],
    ["尚未写完的一行", "终章之后的空白"]
];
for (let volume = 1; volume <= 5; volume++) {
    ["defeat", "victory"].forEach((outcome, index) => entries.push({
        id: "return_v" + volume + "_" + outcome, title: returnTitles[volume - 1][index],
        volume: 0, trigger: "rest", priority: 80, when: { lastResult: { outcome, volume } },
        hint: "上一次在第 " + volume + " 卷" + (outcome === "victory" ? "通关" : "力竭")
            + "，确认结果并开始新冒险后，在休息点交谈"
    }));
}
// These existing bodies remain random/rest or terminal dialogue, not new
// conditional encounters. Their finite IDs now participate in the same
// completion-only archive as other stories. Keep historic Tomokane distinct
// from the current Kisaragi actor even though they share a collected work page.
for (const { who, name } of [...STORY_COMPANIONS, { who: "友兼", name: "友兼" }]) {
    for (const number of [1, 2, 3]) {
        entries.push({ id: "rest_" + who + "_" + number, title: name + " · 篝火闲谈 " + number,
            volume: 0, group: "rest", trigger: "manual", hint: "在休息点阅读或跳过这段闲谈后归档" });
    }
    entries.push({ id: "exit_" + who, title: name + " · 暂别与归途",
        volume: 0, group: "exit", trigger: "manual", hint: "力竭时阅读或跳过这段退场对白后归档" });
}
export const STORY_CATALOG = Object.freeze(entries.map(entry => Object.freeze({
    priority: 0, group: "volume", hint: "在冒险中阅读或跳过后归档", ...entry,
    when: Object.freeze({ ...entry.when,
        ...(entry.when?.page ? { page: Object.freeze({ ...entry.when.page }) } : {}),
        ...(entry.when?.lastResult ? { lastResult: Object.freeze({ ...entry.when.lastResult }) } : {}) })
})));
const byId = new Map(STORY_CATALOG.map(entry => [entry.id, entry]));
export function isStoryId(id) { return typeof id === "string" && byId.has(id); }

const outcomes = ["victory", "defeat"];
const runIdentity = /^[0-9a-f]{32}$/;
function validStoryResult(value) {
    return !!value && typeof value === "object" && !Array.isArray(value)
        && outcomes.includes(value.outcome) && Number.isSafeInteger(value.volume) && value.volume >= 1 && value.volume <= 5;
}

// Storage owns the validated receipt. A story gets only detached facts from an
// acknowledged prior trip, never the current result or a second history store.
export function previousStoryResult(receipt, activeRunId) {
    if (!validStoryResult(receipt) || receipt.acknowledged !== true
            || !Number.isSafeInteger(receipt.revision) || receipt.revision <= 0
            || typeof activeRunId !== "string" || !runIdentity.test(activeRunId)
            || typeof receipt.runId !== "string" || !runIdentity.test(receipt.runId)
            || receipt.runId === activeRunId) return null;
    return { outcome: receipt.outcome, volume: receipt.volume };
}

// Finite conjunction only. Unknown operators and malformed values fail closed.
export function matchesStory(when, context) {
    if (!when || typeof when !== "object" || Array.isArray(when)
            || Object.keys(when).some(key => !["volume", "minFloor", "character", "cardId", "page", "lastResult"].includes(key))) return false;
    for (const key of ["volume", "minFloor", "character", "cardId"]) {
        if (when[key] === undefined) continue;
        if (!Number.isSafeInteger(when[key]) || when[key] < 1) return false;
        const actual = context[key === "minFloor" ? "floor" : key];
        if (!Number.isSafeInteger(actual) || (key === "minFloor" ? actual < when[key] : actual !== when[key])) return false;
    }
    if (when.page !== undefined) {
        const page = when.page;
        if (!page || typeof page !== "object" || Array.isArray(page)
                || Object.keys(page).some(key => !["id", "owned"].includes(key))
                || !Number.isSafeInteger(page.id) || page.id < 1 || typeof page.owned !== "boolean") return false;
        if ((context.pages || []).some(id => String(id) === String(page.id)) !== page.owned) return false;
    }
    if (when.lastResult !== undefined) {
        const expected = when.lastResult, actual = context.lastResult;
        if (!expected || typeof expected !== "object" || Array.isArray(expected)
                || Object.keys(expected).some(key => !["outcome", "volume"].includes(key))
                || !outcomes.includes(expected.outcome)
                || expected.volume !== undefined && (!Number.isSafeInteger(expected.volume) || expected.volume < 1 || expected.volume > 5)
                || !validStoryResult(actual) || actual.outcome !== expected.outcome
                || expected.volume !== undefined && actual.volume !== expected.volume) return false;
    }
    return true;
}

export function selectStory(trigger, context, seen = [], catalog = STORY_CATALOG) {
    const archived = new Set(seen);
    return catalog.filter(entry => entry.trigger === trigger && !archived.has(entry.id)
        && matchesStory(entry.when, context)).sort((a, b) => b.priority - a.priority
            || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]?.id || null;
}

export function validateStoryCatalog(getNode) {
    const errors = [];
    for (const entry of STORY_CATALOG) {
        if (!Array.isArray(getNode(entry.id)) || !getNode(entry.id).length) errors.push("故事正文缺失：" + entry.id);
    }
    return { ok: !errors.length, errors };
}

// Locked entries never expose bodies or spoiler titles, even to the view model.
export function storySections(seen, getNode, resolveName) {
    const archived = new Set(seen);
    const sections = [0, 1, 2, 3, 4, 5].map(volume => ({
        group: "volume", volume, title: volume ? "第 " + volume + " 卷" : "序章与同行闲谈"
    })).concat([{ group: "rest", title: "篝火旁的闲谈" }, { group: "exit", title: "暂别与归途" }]);
    return sections.map(section => ({
        title: section.title,
        entries: STORY_CATALOG.filter(entry => entry.group === section.group
            && (section.volume === undefined || entry.volume === section.volume)).map(entry => {
            const lines = archived.has(entry.id) ? getNode(entry.id) : null;
            const unlocked = Array.isArray(lines) && lines.length > 0;
            return { id: entry.id, title: unlocked ? entry.title : "未归档的故事", unlocked,
                hint: entry.hint, lines: unlocked ? lines.map(line => ({
                    who: resolveName(line.who), text: line.text
                })) : [] };
        })
    }));
}
