// Backup validation is pure; callers supply the same tables used by the game.
import { parseRunSnapshot, layoutSeedFor } from "./runschema.js";
import { generateDungeon, roomSize } from "./dungeon.js";
import { isStoryId, STORY_CATALOG } from "./story.js";

export const PROFILE_VERSION = 2;
export const PROFILE_DATA_VERSION = 1;
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 20;
const PROFILE_V1_KEYS = ["profileVersion", "revision", "dataVersion", "meta", "run", "settings", "lastResult"];
const PROFILE_KEYS = [...PROFILE_V1_KEYS, "runId"];
const RESULT_KEYS = ["runId", "outcome", "volume", "floor", "cardId", "level", "coin",
    "equipmentCount", "gems", "newPages", "pages", "revision", "acknowledged"];
const META_KEYS = ["chars", "levels", "lb", "pages", "enemies", "volumes", "gems", "shards",
    "prologueSeen", "achievements", "tutorialSeen", "storySeen"];
const RUN_KEYS = ["schemaVersion", "generatorVersion", "seed", "volume", "floor", "cardId",
    "level", "exp", "hp", "gauge", "coin", "stackHits", "stackKills", "equipment", "roomClaims"];

export function emptyProfile() {
    return { profileVersion: PROFILE_VERSION, revision: 0, dataVersion: PROFILE_DATA_VERSION,
        meta: null, run: null, runId: null, settings: {}, lastResult: null };
}

function reject(message) { throw new Error(message); }
function plain(value) {
    return !!value && typeof value === "object" && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function fields(value, allowed, label) {
    if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))) {
        reject(label + "包含不支持的字段或类型。");
    }
}
function integer(value, min, max, label) {
    if (!Number.isSafeInteger(value) || value < min || value > max) { reject(label + "超出有效范围。"); }
}
function measured(value, min, max, label) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
        reject(label + "超出有效范围。");
    }
}
function boundedTree(root) {
    const pending = [[root, 0]];
    while (pending.length) {
        const [value, depth] = pending.pop();
        if (depth > MAX_DEPTH) { reject("备份嵌套层数过多。"); }
        if (typeof value === "number" && !Number.isFinite(value)) { reject("备份含无效数字。"); }
        if (!value || typeof value !== "object") { continue; }
        if (Array.isArray(value) && value.length > 4096) { reject("备份数组过长。"); }
        for (const key of Object.keys(value)) {
            if (["__proto__", "prototype", "constructor"].includes(key)) { reject("备份包含不安全的字段。"); }
            pending.push([value[key], depth + 1]);
        }
    }
}

export function decodeBackup(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) {
        reject("备份文件不能超过 2 MiB。");
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { reject("备份不是有效的 JSON 文件。"); }
    boundedTree(parsed);
    if (!plain(parsed)) { reject("备份必须是完整存档对象。"); }
    if (Object.hasOwn(parsed, "profileVersion")) { return parsed; }
    fields(parsed, ["meta", "run", "cam-height"], "旧备份");
    if (!Object.keys(parsed).length) { reject("备份为空。"); }
    const slots = {};
    for (const [slot, raw] of Object.entries(parsed)) {
        if (typeof raw !== "string") { reject("旧备份槽位格式不正确。"); }
        try { slots[slot] = JSON.parse(raw); } catch (_) { reject("旧备份的" + slot + "槽已损坏。"); }
    }
    boundedTree(slots);
    return { profileVersion: PROFILE_VERSION, revision: 0, dataVersion: PROFILE_DATA_VERSION, runId: null,
        meta: slots.meta === undefined ? null : slots.meta, run: slots.run === undefined ? null : slots.run,
        settings: slots["cam-height"] === undefined ? {} : { "cam-height": slots["cam-height"] }, lastResult: null };
}

// Structural checks are also usable before the asynchronous content tables load.
export function checkProfileEnvelope(profile) {
    boundedTree(profile);
    fields(profile, profile && profile.profileVersion === 1 ? PROFILE_V1_KEYS : PROFILE_KEYS, "档案");
    if (![1, PROFILE_VERSION].includes(profile.profileVersion) || profile.dataVersion !== PROFILE_DATA_VERSION) {
        reject("备份版本与当前游戏不兼容。");
    }
    integer(profile.revision, 0, Number.MAX_SAFE_INTEGER - 1, "存档修订号");
    if (profile.meta !== null && !plain(profile.meta)) { reject("角色进度格式不正确。"); }
    if (profile.run !== null && !plain(profile.run)) { reject("冒险进度格式不正确。"); }
    fields(profile.settings, ["cam-height", "reduced-shake", "reduced-flash",
        "simplified-ultimates", "quality"], "设置");
    if (profile.settings["cam-height"] !== undefined) {
        measured(profile.settings["cam-height"], 5.5, 13, "镜头高度");
    }
    // 辅助开关只接受布尔值：导入的备份不能借设置槽夹带可执行状态。
    for (const key of ["reduced-shake", "reduced-flash", "simplified-ultimates"]) {
        if (profile.settings[key] !== undefined && typeof profile.settings[key] !== "boolean") {
            reject("辅助开关格式不正确。");
        }
    }
    // 画质档位只接受发布过的三档名字。
    if (profile.settings["quality"] !== undefined
            && !["high", "balanced", "performance"].includes(profile.settings["quality"])) {
        reject("画质档位格式不正确。");
    }
    if (profile.profileVersion === 1) {
        if (profile.lastResult !== null) { reject("旧档案不能包含结算收据。"); }
        return profile;
    }
    if (profile.runId !== null) { runIdentity(profile.runId); }
    if (profile.run === null && profile.runId !== null) { reject("局编号缺少对应冒险。"); }
    if (profile.lastResult !== null) { resultEnvelope(profile.lastResult, profile); }
    return profile;
}

function runIdentity(id) {
    if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id)) { reject("局编号格式不正确。"); }
}

function resultEnvelope(result, profile) {
    fields(result, RESULT_KEYS, "结算收据");
    runIdentity(result.runId);
    if (!["victory", "defeat"].includes(result.outcome)) { reject("结算结果无效。"); }
    integer(result.volume, 1, 5, "结算卷号"); integer(result.floor, 1, 20, "结算层号");
    integer(result.cardId, 1, Number.MAX_SAFE_INTEGER, "结算角色");
    integer(result.level, 1, 100, "结算等级"); integer(result.coin, 0, Number.MAX_SAFE_INTEGER, "结算金币");
    integer(result.equipmentCount, 0, 4, "结算装备数");
    integer(result.gems, 0, result.equipmentCount * 18, "结算星彩石");
    integer(result.pages, 0, 37, "结算残页数"); integer(result.revision, 0, profile.revision, "结算修订号");
    if (!Array.isArray(result.newPages) || result.newPages.length > result.pages
            || typeof result.acknowledged !== "boolean" || result.acknowledged && result.revision === 0) {
        reject("结算收据的确认或残页记录无效。");
    }
    // T31: victory and defeat both convert the same equipped loot, so victory
    // may claim gems within the same per-item ceiling. Defeat never adds pages.
    if (result.outcome === "victory" ? result.floor !== 20 : result.newPages.length !== 0) {
        reject("结算奖励与结果不符。");
    }
    if (profile.meta === null || profile.runId === result.runId
            || profile.run !== null && (!result.acknowledged || profile.runId === null)) {
        reject("结算收据与活动冒险冲突。");
    }
}

export function createProfileValidator({ stats, weapons, mergeMeta, pageIds, achievementIds }) {
    const playable = new Set(mergeMeta(null).chars);
    const knownPages = new Set(pageIds.map(String));
    const knownAchievements = new Set(achievementIds);
    const catalog = new Map((weapons.catalog || []).map(row => [row.id, row]));
    const passives = new Set(Object.keys(weapons.passives || {}));
    const legacyWeapons = new Set((weapons.weapons || []).map(row => String(row.id)));

    function idList(values, known, limit, label, numeric = false) {
        if (!Array.isArray(values) || values.length > limit) { reject(label + "列表格式不正确。"); }
        const ids = values.map(id => {
            if (numeric ? !Number.isSafeInteger(id) : !["number", "string"].includes(typeof id)) {
                reject(label + "编号格式不正确。");
            }
            const key = numeric ? id : String(id);
            if (!known(key)) { reject(label + "含当前游戏不认识的编号。"); }
            return key;
        });
        if (new Set(ids).size !== ids.length) { reject(label + "含重复编号。"); }
    }

    function metaState(raw) {
        if (raw === null) { return null; }
        fields(raw, META_KEYS, "角色进度");
        if (raw.chars !== undefined) { idList(raw.chars, id => playable.has(id), playable.size, "角色", true); }
        for (const [key, min, max] of [["levels", 1, 100], ["lb", 0, 4]]) {
            if (raw[key] === undefined) { continue; }
            if (!plain(raw[key])) { reject("培养记录格式不正确。"); }
            for (const [id, value] of Object.entries(raw[key])) {
                if (!playable.has(Number(id)) || String(Number(id)) !== id) { reject("培养记录含未知角色。"); }
                integer(value, min, max, "培养等级或突破次数");
            }
        }
        if (raw.pages !== undefined) { idList(raw.pages, id => knownPages.has(id), knownPages.size, "残页"); }
        if (raw.storySeen !== undefined) { idList(raw.storySeen, isStoryId, STORY_CATALOG.length, "剧情归档"); }
        if (raw.enemies !== undefined) {
            idList(raw.enemies, id => String(Number(id)) === id && !!stats.enemy(Number(id)), 4096, "敌人图鉴");
        }
        if (raw.achievements !== undefined) {
            idList(raw.achievements, id => knownAchievements.has(id), knownAchievements.size, "成就");
        }
        if (raw.volumes !== undefined) { integer(raw.volumes, 0, 5, "卷进度"); }
        for (const key of ["gems", "shards"]) {
            if (raw[key] !== undefined) { integer(raw[key], 0, Number.MAX_SAFE_INTEGER, "星彩石"); }
        }
        for (const key of ["prologueSeen", "tutorialSeen"]) {
            if (raw[key] !== undefined && typeof raw[key] !== "boolean") { reject("剧情标记格式不正确。"); }
        }
        const normalized = mergeMeta(raw);
        for (const [id, level] of Object.entries(normalized.levels)) {
            if (level > 80 + 5 * (normalized.lb[id] || 0)) { reject("培养等级超过该角色的突破上限。"); }
        }
        return normalized;
    }

    function equipment(item, card) {
        fields(item, ["slot", "rarity", "affixes", "weaponId", "catalogId", "gadgetId", "sealedSlot"], "装备");
        if (item.affixes.length > 4 || item.affixes.some(id => !passives.has(id))) { reject("装备含未知或过多词条。"); }
        if (item.weaponId !== undefined && (!legacyWeapons.has(String(item.weaponId)) || item.slot !== "weapon")) {
            reject("旧武器编号无效。");
        }
        if (item.catalogId !== undefined) {
            const row = catalog.get(item.catalogId);
            if (!row || (row.charaId > 0 && row.charaId !== card.id)) {
                reject("武器不存在，或专用武器与角色不匹配。");
            }
        }
    }

    function runState(raw) {
        if (raw === null) { return null; }
        fields(raw, RUN_KEYS, "冒险进度");
        integer(raw.volume, 1, 5, "卷号"); integer(raw.floor, 1, 20, "层号");
        integer(raw.level, 1, 100, "冒险等级");
        for (const key of ["exp", "coin", "stackHits", "stackKills"]) {
            if (raw[key] !== undefined) { integer(raw[key], 0, Number.MAX_SAFE_INTEGER, "冒险资源"); }
        }
        for (const key of ["hp", "gauge"]) {
            if (raw[key] !== undefined) { measured(raw[key], key === "hp" ? 1 : 0, Number.MAX_SAFE_INTEGER, "生命或必杀槽"); }
        }
        const card = stats.card(raw.cardId);
        if (!card || !playable.has(raw.cardId)) { reject("续档角色不在当前可玩名单中。"); }
        const snapshot = parseRunSnapshot(raw, 20);
        if (!snapshot) { reject("冒险进度、装备或生成器版本无效。"); }
        if (raw.schemaVersion !== 3 && raw.roomClaims !== undefined) { reject("旧版冒险不能包含新版消费记录。"); }
        snapshot.equipment.forEach(item => equipment(item, card));
        const dungeon = generateDungeon(layoutSeedFor(snapshot.seed, snapshot.floor), { roomsMin: 6, roomsMax: 9 });
        for (const claim of snapshot.roomClaims) {
            const room = dungeon.rooms.find(row => row.id === claim.id);
            if (!room || claim.chestOpened && room.type !== "chest"
                    || (claim.altarUsed || claim.barrels.length) && room.type !== "battle"
                    || (claim.rested || claim.npcTalked) && room.type !== "rest"
                    || claim.offer && room.type !== "shop"
                    || claim.cleared && !['battle', 'boss'].includes(room.type)) { reject("消费记录与原种子生成的房间不符。"); }
            for (const entry of claim.offer || []) {
                if (entry.item) { equipment(entry.item, card); }
            }
            const size = roomSize(room);
            for (const drop of claim.drops || []) {
                if (drop.x > size.w || drop.y > size.h) { reject('战利品位置超出原房间。'); }
                drop.items.forEach(item => equipment(item, card));
            }
        }
        // Reject unknown nested fields instead of relying on the normalizer to trim them.
        for (const claim of raw.roomClaims || []) {
            fields(claim, ["id", "chestOpened", "altarUsed", "rested", "npcTalked", "barrels", "supply", "offer", "cleared", "drops"], "房间记录");
            for (const entry of claim.offer || []) { fields(entry, ["item", "price", "bought"], "商店记录"); }
            for (const drop of claim.drops || []) { fields(drop, ['x', 'y', 'items'], '战利品记录'); }
        }
        return snapshot;
    }

    return function validate(profile) {
        checkProfileEnvelope(profile);
        const meta = metaState(profile.meta), run = runState(profile.run);
        let result = profile.lastResult;
        if (result) {
            if (!playable.has(result.cardId) || !stats.card(result.cardId)) { reject("结算角色不在当前可玩名单中。"); }
            idList(result.newPages, id => knownPages.has(id), knownPages.size, "结算残页");
            const pages = new Set(meta.pages.map(String));
            if (result.newPages.some(id => !pages.has(String(id))) || result.pages > pages.size
                    || !result.acknowledged && result.pages !== pages.size
                    || !result.acknowledged && meta.gems < result.gems
                    || result.outcome === "victory" && meta.volumes < result.volume) {
                reject("结算收据与角色进度不符。");
            }
            result = { ...result, newPages: result.newPages.map(String) };
        }
        return { ...profile, profileVersion: PROFILE_VERSION, runId: profile.profileVersion === 1 ? null : profile.runId,
            meta, run, settings: { ...profile.settings }, lastResult: result };
    };
}
