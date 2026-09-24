import { LEVELS, SAVE_KEY, canOpenLevel, unlockedUnits } from "../data/campaign.js";

export function emptyProgress() { return { version: 1, completed: [], best: {}, lastLevel: "1-1" }; }

export function validateProgress(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.completed)) { throw new Error("不是本版本的巡守记录"); }
    const known = new Set(LEVELS.map(level => level.id));
    if (value.completed.some(id => typeof id !== "string" || !known.has(id))) { throw new Error("记录包含未知关卡"); }
    const completed = [...new Set(value.completed)];
    for (const id of completed) {
        const index = LEVELS.findIndex(level => level.id === id);
        if (index > 0 && !completed.includes(LEVELS[index - 1].id)) { throw new Error("关卡进度不连续"); }
    }
    const best = {};
    for (const id of completed) {
        const row = value.best?.[id];
        if (row && Number.isFinite(row.time) && row.time >= 0 && row.time <= 3600
            && Number.isInteger(row.gatesUsed) && row.gatesUsed >= 0 && row.gatesUsed <= 6) {
            best[id] = { time: row.time, gatesUsed: row.gatesUsed,
                healed: Number.isFinite(row.healed) ? Math.max(0, row.healed) : 0 };
        }
    }
    return { version: 1, completed: LEVELS.filter(level => completed.includes(level.id)).map(level => level.id), best,
        lastLevel: known.has(value.lastLevel) && canOpenLevel(value.lastLevel, completed) ? value.lastLevel : "1-1" };
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

    get unlocked() { return unlockedUnits(this.progress.completed); }
    canOpen(id) { return canOpenLevel(id, this.progress.completed); }

    rememberLevel(id) {
        if (!this.canOpen(id)) { return false; }
        this.progress.lastLevel = id;
        this.persist();
        return true;
    }

    finish(runId, battle) {
        if (this.finishedRuns.has(runId) || battle.phase !== "won" || !this.canOpen(battle.level.id)) { return []; }
        this.finishedRuns.add(runId);
        const previous = new Set(this.unlocked);
        const id = battle.level.id;
        if (!this.progress.completed.includes(id)) { this.progress.completed.push(id); }
        const result = { time: battle.time, gatesUsed: battle.stats.gatesUsed, healed: battle.stats.healed };
        const best = this.progress.best[id];
        if (!best || result.gatesUsed < best.gatesUsed || result.gatesUsed === best.gatesUsed && result.time < best.time) {
            this.progress.best[id] = result;
        }
        const index = LEVELS.findIndex(level => level.id === id);
        this.progress.lastLevel = LEVELS[Math.min(index + 1, LEVELS.length - 1)].id;
        this.progress = validateProgress(this.progress);
        this.persist();
        return this.unlocked.filter(unit => !previous.has(unit));
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
