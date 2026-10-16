import { LEVELS, ENDLESS, UNIT_RULES, ENEMY_RULES, SAVE_KEY, DECK_KEY, DECK_SIZE, DECK_ORDER, ACHIEVEMENTS, canOpenLevel, levelById, unlockedUnits } from "../data/campaign.js";
import { evaluateChallenge } from "./challenge-evaluator.js";

export function emptyProgress() { return { version: 1, completed: [], best: {}, lastLevel: "1-1", endless: null, endlessRun: null, endlessRewards: null, materials: {}, town: {}, achievements: [] }; }

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
        endlessRun: validateEndlessRun(value.endlessRun),
        endlessRewards: validateEndlessRewards(value.endlessRewards),
        materials: validateMaterials(value.materials),
        town: validateTown(value.town),
        achievements: Array.isArray(value.achievements) ? [...new Set(value.achievements)].filter(id => ACHIEVEMENTS[id]) : [] };
}

function validateEndlessRun(value) {
    if (!value || ![1, 2].includes(value.version) || !Number.isInteger(value.seed) || !Number.isInteger(value.wave)
        || value.wave < 1 || value.wave > 9999 || !Number.isFinite(value.time) || value.time < 0 || value.time > 86400
        || !Number.isFinite(value.resource) || value.resource < 0 || value.resource > 1e7
        || !Number.isInteger(value.restocks) || value.restocks < 0 || value.restocks > 9999
        || !Array.isArray(value.deck) || value.deck.length > DECK_SIZE || value.deck.some(id => !DECK_ORDER.includes(id))
        || !Array.isArray(value.units) || value.units.length > ENDLESS.rows * ENDLESS.cols) { return null; }
    const deck = [...new Set(value.deck)];
    if (!deck.length || deck.length > DECK_SIZE) { return null; }
    const units = [];
    const occupied = new Set();
    for (const entry of value.units) {
        if (!entry || typeof entry.type !== "string" || !DECK_ORDER.includes(entry.type) || !deck.includes(entry.type) || !Number.isInteger(entry.row) || !Number.isInteger(entry.col)
            || entry.row < 0 || entry.row >= ENDLESS.rows || entry.col < 0 || entry.col >= ENDLESS.cols
            || !Number.isFinite(entry.hp) || entry.hp < 1 || entry.hp > 1e6) { return null; }
        const position = `${entry.row}:${entry.col}`;
        if (occupied.has(position)) { return null; }
        if (entry.gear != null && typeof entry.gear !== "string") { return null; }
        const gear = entry.gear ? UNIT_RULES[entry.gear] : null;
        if (entry.gear && (!gear || gear.kind !== "gear" || gear.gearFor?.length && !gear.gearFor.includes(entry.type))) { return null; }
        occupied.add(position);
        units.push({ ...entry, type: entry.type, row: entry.row, col: entry.col, gear: entry.gear || null, hp: Math.round(entry.hp) });
    }
    const base = { version: value.version, level: typeof value.level === "string" ? value.level : "endless", runId: typeof value.runId === "string" ? value.runId : null,
        seed: value.seed, wave: value.wave, time: value.time, resource: value.resource, restocks: value.restocks, deck, units,
        stats: value.stats && typeof value.stats === "object" ? {
            kills: Math.max(0, Math.round(value.stats.kills || 0)), healed: Math.max(0, Math.round(value.stats.healed || 0)),
            gatesUsed: Math.max(0, Math.round(value.stats.gatesUsed || 0)), wavesCleared: Math.max(0, Math.round(value.stats.wavesCleared || 0)),
            generated: Math.max(0, Math.round(value.stats.generated || 0)), collected: Math.max(0, Math.round(value.stats.collected || 0)),
            spent: Math.max(0, Math.round(value.stats.spent || 0)), deployed: Math.max(0, Math.round(value.stats.deployed || 0)),
            recalls: Math.max(0, Math.round(value.stats.recalls || 0)), shielded: Math.max(0, Math.round(value.stats.shielded || 0)),
            blocked: Math.max(0, Math.round(value.stats.blocked || 0)), defeatedUnits: Math.max(0, Math.round(value.stats.defeatedUnits || 0))
        } : { kills: 0, healed: 0, gatesUsed: 0, wavesCleared: 0, generated: 0, collected: 0, spent: 0, deployed: 0, recalls: 0, shielded: 0, blocked: 0, defeatedUnits: 0 } };
    if (value.version === 1) {
        return { ...base, waveProgress: value.waveProgress && typeof value.waveProgress === "object"
            && Number.isInteger(value.waveProgress.total) && Number.isInteger(value.waveProgress.killed)
            ? { total: Math.max(0, Math.min(45, value.waveProgress.total)), killed: Math.max(0, Math.min(45, value.waveProgress.killed)) } : null };
    }
    if (typeof value.runId !== "string" || value.runId.length < 1 || value.runId.length > 100
        || !Number.isInteger(value.rngState) || value.rngState < 0 || value.rngState > 0xffffffff
        || !Number.isInteger(value.plannedWave) || value.plannedWave < 1 || value.plannedWave > 9999
        || !Number.isFinite(value.nextWaveAt) || value.nextWaveAt < 0 || !Number.isInteger(value.spawnIndex)
        || !Number.isInteger(value.nextSpawnIndex) || value.spawnIndex < 0 || value.nextSpawnIndex < value.spawnIndex || value.nextSpawnIndex > 100000
        || !Array.isArray(value.spawns) || value.spawns.length > 400 || value.spawnIndex > value.spawns.length
        || !Array.isArray(value.waveBounds) || value.waveBounds.length > 128 || value.waveBounds.some(row => !Array.isArray(row) || row.length !== 2)
        || !Array.isArray(value.settledWaves) || value.settledWaves.length > 128
        || new Set(value.settledWaves).size !== value.settledWaves.length || value.settledWaves.some(wave => !Number.isInteger(wave) || wave < 1 || wave > value.plannedWave)
        || !Array.isArray(value.warned) || value.warned.length > 400 || value.warned.some(index => !Number.isInteger(index) || index < 0 || index >= value.nextSpawnIndex)
        || !Array.isArray(value.enemies) || value.enemies.length > 120 || !Array.isArray(value.pending) || value.pending.length > 240
        || !Array.isArray(value.projectiles) || value.projectiles.length > 120 || !Array.isArray(value.lobs) || value.lobs.length > 120
        || !Array.isArray(value.pickups) || value.pickups.length > 80 || !Array.isArray(value.readyAt) || value.readyAt.length > 30
        || !Array.isArray(value.gates) || value.gates.length !== ENDLESS.rows || value.gates.some(gate => typeof gate !== "boolean")) { return null; }
    const finiteObject = item => item && Object.values(item).every(part => typeof part !== "number" || Number.isFinite(part));
    const spawns = [];
    const spawnIds = new Set();
    for (const spawn of value.spawns) {
        if (!finiteObject(spawn) || !Number.isFinite(spawn.at) || spawn.at < 0 || !Number.isInteger(spawn.row) || spawn.row < 0 || spawn.row >= ENDLESS.rows
            || !ENEMY_RULES[spawn.type] || !Number.isInteger(spawn.wave) || spawn.wave < 1 || spawn.wave > value.plannedWave
            || !Number.isFinite(spawn.hpScale) || spawn.hpScale <= 0 || !Number.isInteger(spawn.index) || spawn.index < 0 || spawn.index >= value.nextSpawnIndex
            || spawnIds.has(spawn.index)) { return null; }
        spawnIds.add(spawn.index); spawns.push({ ...spawn });
    }
    const waveBounds = [];
    const boundWaves = new Set();
    for (const [wave, bound] of value.waveBounds) {
        if (!Number.isInteger(wave) || wave < 1 || wave > value.plannedWave || boundWaves.has(wave) || !bound || !Number.isInteger(bound.remaining)
            || !Number.isInteger(bound.total) || bound.remaining < 0 || bound.total < bound.remaining || bound.total > 45
            || (bound.modifier !== null && (!bound.modifier || typeof bound.modifier.kind !== "string" || typeof bound.modifier.label !== "string"))) { return null; }
        boundWaves.add(wave); waveBounds.push([wave, { remaining: bound.remaining, total: bound.total, modifier: bound.modifier || null }]);
    }
    if (value.settledWaves.some(wave => !boundWaves.has(wave))) { return null; }
    const enemies = [];
    const enemyIds = new Set();
    const enemyFields = ["hp", "maxHp", "speed", "nextAttack", "x", "armor", "maxArmor", "slowUntil", "slowFactor", "stunUntil", "vulnerableUntil", "vulnerable", "weakenUntil", "weaken", "burnUntil", "burnDps", "nextBurn", "reviveAt", "nextSpecial", "nextRoar", "armorBrokenAt", "cryHaste", "cryUntil"];
    const finiteOrNull = value => value === null || Number.isFinite(value);
    for (const enemy of value.enemies) {
        if (!enemy || typeof enemy.id !== "string" || enemyIds.has(enemy.id) || !ENEMY_RULES[enemy.type] || !Number.isInteger(enemy.row) || enemy.row < 0 || enemy.row >= ENDLESS.rows
            || !Number.isInteger(enemy.wave) || enemy.wave < 1 || enemy.wave > value.plannedWave || !boundWaves.has(enemy.wave)
            || typeof enemy.summoned !== "boolean" || !["walking", "attacking", "shooting", "stunned", "reviving"].includes(enemy.state)
            || enemyFields.some(key => enemy[key] !== undefined && !finiteOrNull(enemy[key]))) { return null; }
        enemyIds.add(enemy.id); enemies.push({ ...enemy });
    }
    const pending = value.pending.map(action => ({ ...action }));
    if (pending.some(action => !finiteObject(action) || typeof action.kind !== "string" || !Number.isFinite(action.at) || action.at < 0)) { return null; }
    const projectiles = value.projectiles.map(projectile => ({ ...projectile, hit: [...projectile.hit] }));
    if (projectiles.some(projectile => !finiteObject(projectile) || typeof projectile.id !== "string" || typeof projectile.source !== "string"
        || !Array.isArray(projectile.hit) || projectile.hit.length > 120 || !Number.isInteger(projectile.row) || projectile.row < 0 || projectile.row >= ENDLESS.rows)) { return null; }
    const lobs = value.lobs.map(lob => ({ ...lob }));
    if (lobs.some(lob => !finiteObject(lob) || typeof lob.id !== "string" || !UNIT_RULES[lob.unitType] || !Number.isInteger(lob.row) || lob.row < 0 || lob.row >= ENDLESS.rows)) { return null; }
    const pickups = value.pickups.map(pickup => ({ ...pickup }));
    if (pickups.some(pickup => !finiteObject(pickup) || typeof pickup.id !== "string" || !Number.isInteger(pickup.row) || pickup.row < 0 || pickup.row >= ENDLESS.rows
        || !Number.isFinite(pickup.amount) || pickup.amount < 0 || !Number.isFinite(pickup.autoAt))) { return null; }
    const readyAt = value.readyAt.map(row => [row[0], row[1]]);
    if (readyAt.some(row => !Array.isArray(row) || typeof row[0] !== "string" || !UNIT_RULES[row[0]] || !Number.isFinite(row[1]) || row[1] < 0)) { return null; }
    return { ...base, runId: value.runId, rngState: value.rngState, plannedWave: value.plannedWave, nextWaveAt: value.nextWaveAt,
        spawnIndex: value.spawnIndex, nextSpawnIndex: value.nextSpawnIndex, spawns, waveBounds, settledWaves: [...value.settledWaves], enemies, pending,
        projectiles, lobs, pickups, readyAt, gates: [...value.gates], warned: [...value.warned], sequence: Number.isInteger(value.sequence) && value.sequence >= 0 ? value.sequence : 0,
        nextNatural: Number.isFinite(value.nextNatural) && value.nextNatural >= value.time ? value.nextNatural : value.time,
        materials: Array.isArray(value.materials) && value.materials.length <= 99 && value.materials.every(id => ["M1", "M2", "M3", "M4", "M5"].includes(id)) ? [...value.materials] : [] };
}

function validateEndlessRewards(value) {
    if (!value || typeof value.runId !== "string" || value.runId.length < 1 || value.runId.length > 100 || !Array.isArray(value.receipts) || value.receipts.length > 9999) { return null; }
    const receipts = [...new Set(value.receipts.filter(id => typeof id === "string" && /^.{1,100}:wave:[1-9]\d{0,3}$/.test(id)))];
    return { runId: value.runId, receipts };
}

// 城镇素材：{ M1: 数量 }，每项 0-9999。
function validateMaterials(value) {
    if (!value || typeof value !== "object") { return {}; }
    const out = {};
    for (const key of ["M1", "M2", "M3", "M4", "M5"]) {
        const n = value[key];
        if (Number.isInteger(n) && n >= 0 && n <= 9999) { out[key] = n; }
    }
    return out;
}

// 城镇建筑等级：{ B1: 等级 }，每项 0-5。
function validateTown(value) {
    if (!value || typeof value !== "object") { return {}; }
    const out = {};
    for (const key of ["B1", "B2", "B3", "B4", "B5"]) {
        const n = value[key];
        if (Number.isInteger(n) && n >= 0 && n <= 5) { out[key] = n; }
    }
    return out;
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

    // Achievements: idempotent — returns only the ids newly unlocked this call.
    // Evaluated once per finished run so a repeated result screen or reload can
    // never re-grant them.
    unlockAchievements(ids) {
        const fresh = [...new Set(ids)].filter(id => ACHIEVEMENTS[id] && !this.progress.achievements.includes(id));
        if (fresh.length) { this.progress.achievements.push(...fresh); this.persist(); }
        return fresh;
    }

    finish(runId, battle) {
        if (this.finishedRuns.has(runId)) { return { newRecord: false, achievements: [] }; }
        const id = battle.level.id;
        if (battle.level.endless) {
            if (battle.phase !== "lost") { return { newRecord: false, achievements: [] }; }
            this.finishedRuns.add(runId);
            const result = { wave: battle.wave, kills: battle.stats.kills, time: battle.time };
            const old = this.progress.endless;
            const newRecord = !old || result.wave > old.wave || result.wave === old.wave && result.kills > old.kills;
            if (newRecord) { this.progress.endless = result; }
            const wave = battle.wave;
            const achievements = this.unlockAchievements([
                wave >= 10 && "endless_10", wave >= 20 && "endless_20"].filter(Boolean));
            this.persist();
            return { newRecord, achievements };
        }
        if (battle.phase !== "won" || !this.canOpen(id)) { return { newRecord: false, achievements: [] }; }
        this.finishedRuns.add(runId);
        const first = !this.progress.completed.includes(id);
        if (first) { this.progress.completed.push(id); }
        const result = { time: battle.time, gatesUsed: battle.stats.gatesUsed, healed: battle.stats.healed };
        const best = this.progress.best[id];
        const newRecord = !best || result.gatesUsed < best.gatesUsed || result.gatesUsed === best.gatesUsed && result.time < best.time;
        if (newRecord) { this.progress.best[id] = result; }
        const index = LEVELS.findIndex(level => level.id === id);
        this.progress.lastLevel = LEVELS[Math.min(index + 1, LEVELS.length - 1)].id;
        const challenge = evaluateChallenge(battle.level, battle.stats, battle.phase);
        const achievements = this.unlockAchievements([
            "first_clear",
            battle.stats.gatesUsed === 0 && "zero_gate",
            battle.stats.healed > 0 && "healer",
            ENEMY_RULES[battle.level.newEnemy]?.boss && "boss_clear"].filter(Boolean));
        this.progress = validateProgress(this.progress);
        this.persist();
        return { newRecord, first, achievements, challenge };
    }

    // Endless checkpoint, throttled by the caller (campaign.js). Storage
    // churn is bounded: one JSON.stringify of a ≤2KB blob per checkpoint.
    saveEndlessRun(data) {
        this.progress.endlessRun = validateEndlessRun(data);
        if (this.progress.endlessRun) { this.persist(); }
        return !!this.progress.endlessRun;
    }
    settleEndlessReward({ runId, wave, drops, bonusDrops, checkpoint } = {}) {
        if (typeof runId !== "string" || !runId || runId.length > 100 || !Number.isInteger(wave) || wave < 1 || wave > 9999
            || !Array.isArray(drops) || !Array.isArray(bonusDrops)
            || [...drops, ...bonusDrops].some(id => !["M1", "M2", "M3", "M4", "M5"].includes(id))) {
            return { applied: false, saved: false };
        }
        const receipt = `${runId}:wave:${wave}`;
        const currentRewards = this.progress.endlessRewards;
        if (currentRewards?.receipts.includes(receipt)) {
            return { applied: false, saved: true };
        }
        const endlessRun = checkpoint === null ? null : validateEndlessRun(checkpoint);
        if (checkpoint !== null && (!endlessRun || endlessRun.version !== 2 || endlessRun.runId !== runId
            || !endlessRun.settledWaves.includes(wave))) {
            return { applied: false, saved: false };
        }
        const previous = this.progress;
        const materials = { ...previous.materials };
        for (const id of [...drops, ...bonusDrops]) {
            materials[id] = Math.min(9999, (materials[id] || 0) + 1);
        }
        this.progress = {
            ...previous,
            endlessRun,
            endlessRewards: {
                runId,
                receipts: [...(currentRewards?.receipts || []), receipt].slice(-9999)
            },
            materials
        };
        if (!this.persist()) {
            this.progress = previous;
            return { applied: false, saved: false };
        }
        return { applied: true, saved: true };
    }
    clearEndlessRun() {
        if (!this.progress.endlessRun) { return; }
        this.progress.endlessRun = null;
        this.persist();
    }
    // 城镇：素材入账（无尽掉落）。
    grantMaterials(drops) {
        if (!Array.isArray(drops) || !drops.length) { return; }
        for (const id of drops) {
            const known = ["M1", "M2", "M3", "M4", "M5"].includes(id);
            if (known) { this.progress.materials[id] = Math.min(9999, (this.progress.materials[id] || 0) + 1); }
        }
        this.persist();
    }
    // 城镇：升级建筑。返回 true 表示扣料并升级成功。
    upgradeTown(buildingId, costPlan) {
        const level = this.progress.town[buildingId] || 0;
        const cost = costPlan?.[level];
        if (!cost) { return false; }
        const need = {};
        for (const id of cost) { need[id] = (need[id] || 0) + 1; }
        for (const [id, n] of Object.entries(need)) {
            if ((this.progress.materials[id] || 0) < n) { return false; }
        }
        for (const [id, n] of Object.entries(need)) { this.progress.materials[id] -= n; }
        this.progress.town[buildingId] = level + 1;
        this.persist();
        return true;
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
