import { LEVELS, SAVE_KEY, DECK_KEY, DECK_SIZE, DECK_ORDER, canOpenLevel, levelById, unlockedUnits } from "../data/campaign.js";

export function emptyProgress() { return { version: 1, completed: [], best: {}, lastLevel: "1-1", endless: null, endlessRun: null }; }

// Levels are all open; a record only remembers what was cleared and how well.
// Older saves (which required contiguous progress) remain valid as they are.
export function validateProgress(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.completed)) { throw new Error("不是本版本的巡守记录"); }
    const known = new Set(LEVELS.map(level => level.id));
    if (value.completed.some(id => typeof id !== "string" || !known.has(id))) { throw new Error("记录包含未知关卡"); }
    const completed = [...new Set(value.completed)];
    const best = {};
    for (const id of completed) {
        const row = value.best?.[id];
        if (row && Number.isFinite(row.time) && row.time >= 0 && row.time <= 3600
            && Number.isInteger(row.gatesUsed) && row.gatesUsed >= 0 && row.gatesUsed <= 6) {
            best[id] = { time: row.time, gatesUsed: row.gatesUsed,
                healed: Number.isFinite(row.healed) ? Math.max(0, row.healed) : 0 };
        }
    }
    let endless = null;
    const record = value.endless;
    if (record && Number.isInteger(record.wave) && record.wave >= 1 && record.wave <= 9999
        && Number.isInteger(record.kills) && record.kills >= 0 && Number.isFinite(record.time) && record.time >= 0) {
        endless = { wave: record.wave, kills: record.kills, time: record.time };
    }
    return { version: 1, completed: LEVELS.filter(level => completed.includes(level.id)).map(level => level.id), best,
        lastLevel: typeof value.lastLevel === "string" && levelById(value.lastLevel) ? value.lastLevel : "1-1", endless,
        endlessRun: validateEndlessRun(value.endlessRun) };
}

// A mid-run endless checkpoint. Strictly capped so a corrupt or oversized
// blob (the bench is at most the board's cell count) can't bloat storage.
function validateEndlessRun(value) {
    if (!value || value.version !== 1 || !Number.isInteger(value.seed) || !Number.isInteger(value.wave)
        || value.wave < 1 || value.wave > 9999 || !Number.isFinite(value.time) || value.time < 0 || value.time > 86400
        || !Number.isFinite(value.resource) || value.resource < 0 || value.resource > 1e7
        || !Number.isInteger(value.restocks) || value.restocks < 0 || value.restocks > 99
        || !Array.isArray(value.deck) || value.deck.length > 12 || !Array.isArray(value.units) || value.units.length > 45) { return null; }
    const units = [];
    for (const entry of value.units) {
        if (units.length >= 45) { break; }
        if (!entry || typeof entry.type !== "string" || !Number.isInteger(entry.row) || !Number.isInteger(entry.col)
            || entry.row < 0 || entry.row > 8 || entry.col < 0 || entry.col > 11
            || !Number.isFinite(entry.hp) || entry.hp < 1 || entry.hp > 1e6) { return null; }
        units.push({ type: entry.type, row: entry.row, col: entry.col,
            gear: typeof entry.gear === "string" ? entry.gear : null, hp: Math.round(entry.hp) });
    }
    return { version: 1, level: typeof value.level === "string" ? value.level : "endless", seed: value.seed, wave: value.wave, time: value.time, resource: value.resource,
        restocks: value.restocks, deck: [...new Set(value.deck)].slice(0, 12), units,
        stats: value.stats && typeof value.stats === "object" ? {
            kills: Math.max(0, Math.round(value.stats.kills || 0)),
            healed: Math.max(0, Math.round(value.stats.healed || 0)),
            gatesUsed: Math.max(0, Math.round(value.stats.gatesUsed || 0)) } : { kills: 0, healed: 0, gatesUsed: 0 } };
}

export function validateDeck(value) {
    if (!Array.isArray(value)) { return null; }
    const deck = [...new Set(value)].filter(id => DECK_ORDER.includes(id));
    return deck.length && deck.length <= DECK_SIZE ? deck : null;
}

export class CampaignSave {
    constructor(storage) {
        this.storage = storage;
        this.progress = emptyProgress();
        this.problem = null;
        this.finishedRuns = new Set();
        try {
            this.storage = storage || globalThis.localStorage;
            if (!this.storage) { throw new Error("Storage unavailable"); }
            const raw = this.storage.getItem(SAVE_KEY);
            if (raw) { this.progress = validateProgress(JSON.parse(raw)); }
        } catch {
            this.problem = "原巡守记录无法读取，未覆盖原文件。当前使用临时新记录。";
            this.readOnly = true;
        }
    }

    get unlocked() { return unlockedUnits(); }
    canOpen(id) { return canOpenLevel(id, this.progress.completed); }

    get deck() {
        try { return validateDeck(JSON.parse(this.storage?.getItem(DECK_KEY) || "null")); } catch { return null; }
    }
    set deck(value) {
        const deck = validateDeck(value);
        if (!deck) { return; }
        try { this.storage?.setItem(DECK_KEY, JSON.stringify(deck)); } catch { /* the deck is a convenience only */ }
    }

    rememberLevel(id) {
        if (!this.canOpen(id)) { return false; }
        this.progress.lastLevel = id;
        this.persist();
        return true;
    }

    finish(runId, battle) {
        if (this.finishedRuns.has(runId)) { return { newRecord: false }; }
        const id = battle.level.id;
        if (battle.level.endless) {
            if (battle.phase !== "lost") { return { newRecord: false }; }
            this.finishedRuns.add(runId);
            const result = { wave: battle.wave, kills: battle.stats.kills, time: battle.time };
            const old = this.progress.endless;
            const newRecord = !old || result.wave > old.wave || result.wave === old.wave && result.kills > old.kills;
            if (newRecord) { this.progress.endless = result; this.persist(); }
            return { newRecord };
        }
        if (battle.phase !== "won" || !this.canOpen(id)) { return { newRecord: false }; }
        this.finishedRuns.add(runId);
        const first = !this.progress.completed.includes(id);
        if (first) { this.progress.completed.push(id); }
        const result = { time: battle.time, gatesUsed: battle.stats.gatesUsed, healed: battle.stats.healed };
        const best = this.progress.best[id];
        const newRecord = !best || result.gatesUsed < best.gatesUsed || result.gatesUsed === best.gatesUsed && result.time < best.time;
        if (newRecord) { this.progress.best[id] = result; }
        const index = LEVELS.findIndex(level => level.id === id);
        this.progress.lastLevel = LEVELS[Math.min(index + 1, LEVELS.length - 1)].id;
        this.progress = validateProgress(this.progress);
        this.persist();
        return { newRecord, first };
    }

    // Endless checkpoint, throttled by the caller (campaign.js). Storage
    // churn is bounded: one JSON.stringify of a ≤2KB blob per checkpoint.
    saveEndlessRun(data) {
        this.progress.endlessRun = validateEndlessRun(data);
        if (this.progress.endlessRun) { this.persist(); }
        return !!this.progress.endlessRun;
    }
    clearEndlessRun() {
        if (!this.progress.endlessRun) { return; }
        this.progress.endlessRun = null;
        this.persist();
    }
    persist() {
        if (this.readOnly) { return false; }
        try {
            if (!this.storage) { throw new Error("Storage unavailable"); }
            const serialized = JSON.stringify(validateProgress(this.progress));
            const old = this.storage?.getItem(SAVE_KEY);
            if (old) { this.storage.setItem(`${SAVE_KEY}.previous`, old); }
            this.storage?.setItem(SAVE_KEY, serialized);
            return true;
        } catch {
            this.problem = "浏览器暂时不能保存进度。本次页面内仍可继续，请先导出记录。";
            return false;
        }
    }

    export() { return JSON.stringify(validateProgress(this.progress), null, 2); }

    import(text) {
        if (typeof text !== "string" || text.length > 65536) { throw new Error("记录文件过大或无法读取"); }
        const progress = validateProgress(JSON.parse(text));
        this.progress = progress;
        this.readOnly = false;
        this.problem = null;
        this.finishedRuns.clear();
        this.persist();
        return progress;
    }
}
