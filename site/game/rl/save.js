// Existing slot callers remain valid after an atomic, whole-profile restore.
import { decodeBackup, checkProfileEnvelope, emptyProfile, PROFILE_VERSION } from "./profileschema.js";

const PREFIX = "kirafan-rl:";
const PROFILE_KEY = PREFIX + "profile";
let backend = null;
let persistent = true;
let storageError = null;
let importValidator = null;
let managed = false, workingProfile = null, baseline = null, needsCommit = false, blocked = null;
let lastSavedAt = null, publishedState = null;
const listeners = new Set();

function defaultBackend() {
    try {
        if (typeof window !== "undefined" && window.localStorage) {
            // Full storage can still be read and exported. Do not discard that
            // backend merely because a write probe would fail at capacity.
            window.localStorage.getItem(PROFILE_KEY);
            persistent = true;
            return window.localStorage;
        }
    } catch (err) {
        // file:// or blocked storage — fall through to memory
    }
    persistent = false;
    const memory = new Map();
    return {
        getItem: function (key) { return memory.has(key) ? memory.get(key) : null; },
        setItem: function (key, value) { memory.set(key, String(value)); },
        removeItem: function (key) { memory.delete(key); },
        get length() { return memory.size; },
        key: function (index) { return Array.from(memory.keys())[index] || null; }
    };
}

export function setStorage(storage) {
    backend = storage;
    persistent = true;
    storageError = null;
    managed = false; workingProfile = null; baseline = null; needsCommit = false; blocked = null;
    lastSavedAt = null; publishedState = null;
}

function store() {
    if (!backend) {
        backend = defaultBackend();
    }
    return backend;
}

export function storageState() {
    store();
    const pending = !!workingProfile && (needsCommit || !persistent || blocked === "conflict");
    return { persistent: persistent, error: storageError, pending: pending, lastSavedAt: lastSavedAt,
        status: blocked || (!persistent ? "session" : storageError || needsCommit ? "unsaved" : managed ? "saved" : "loading"),
        canRetry: managed && !!workingProfile && !blocked && (needsCommit || !!storageError || !persistent) };
}

export function setImportValidator(validate) { importValidator = validate; }

function currentProfile() {
    const raw = store().getItem(PROFILE_KEY);
    if (raw === null || raw === undefined) { return null; }
    // Never fall back to stale legacy slots when the active profile is unreadable.
    const profile = checkProfileEnvelope(JSON.parse(raw));
    // Validate the existing contents before a slot edit can erase the evidence
    // of corruption. Only explicit backup recovery may replace a broken profile.
    return importValidator ? importValidator(profile) : profile;
}

// Settings live in profile.settings; cam-height keeps its original slot name.
const SETTING_SLOTS = ["cam-height", "reduced-shake", "reduced-flash", "simplified-ultimates", "quality"];

function getSlot(profile, slot) {
    if (["meta", "run", "runId", "lastResult"].includes(slot)) { return profile[slot] ?? null; }
    if (SETTING_SLOTS.includes(slot)) { return profile.settings[slot] ?? null; }
    return null;
}

function setSlot(profile, slot, data, options = {}) {
    if (slot === "run") {
        // Legacy unbound checkpoints remain readable/writable. Once bound,
        // only that run may save or abandon itself, never a late callback.
        if (profile.runId != null || profile.lastResult != null || options.runId !== undefined) {
            if (!profile.run || !profile.runId || options.runId !== profile.runId) {
                throw new Error("冒险已经结束或已被替换，未保存过时的续档。");
            }
            if (data && ["seed", "volume", "cardId"].some(key => data[key] !== profile.run[key])) {
                throw new Error("续档不能改变本局身份。");
            }
        }
        if (data === null && profile.profileVersion === PROFILE_VERSION) { profile.runId = null; }
    }
    if (slot === "meta" || slot === "run") { profile[slot] = data; }
    else if (SETTING_SLOTS.includes(slot)) {
        if (data === null) { delete profile.settings[slot]; }
        else { profile.settings[slot] = data; }
    } else { throw new Error("档案不支持这个存档槽。"); }
}

export function write(slot, data, options = {}) {
    if (managed) {
        if (!workingProfile || (blocked && blocked !== "conflict")) { return false; }
        try {
            const candidate = copyProfile(workingProfile);
            setSlot(candidate, slot, data, options);
            return commitManaged(candidate, options);
        } catch (_) { return false; }
    }
    try {
        const profile = currentProfile();
        if (profile) {
            const before = JSON.stringify(profile);
            setSlot(profile, slot, data, options);
            const checked = importValidator ? importValidator(profile) : checkProfileEnvelope(profile);
            // A paused autosave is not a new revision and must not invalidate
            // a restore preview while the player is still reading it.
            if (JSON.stringify(checked) !== before) {
                checked.revision += 1;
                checkProfileEnvelope(checked);
                store().setItem(PROFILE_KEY, JSON.stringify(checked));
            }
        } else {
            const raw = JSON.stringify(data);
            if (raw === undefined) { throw new Error("存档值无法序列化。"); }
            store().setItem(PREFIX + slot, raw);
        }
        storageError = null;
        return true;
    } catch (_) {
        storageError = "存档未保存，已有记录保持不变。";
        return false;
    }
}

export function load(slot) {
    if (managed) {
        checkStorageChanges();
        if (!workingProfile || blocked) { return null; }
        // A transient read failure does not erase accepted in-page facts.
        return getSlot(copyProfile(workingProfile), slot);
    }
    try {
        const profile = currentProfile();
        if (profile) { return getSlot(profile, slot); }
        const raw = store().getItem(PREFIX + slot);
        return raw === null || raw === undefined ? null : JSON.parse(raw);
    } catch (_) {
        storageError = "存档无法读取，原始记录仍保留。";
        return null;
    }
}

export function clear(slot, options = {}) {
    if (managed) { return write(slot, null, options); }
    try {
        const profile = currentProfile();
        if (profile) { return write(slot, null); }
        store().removeItem(PREFIX + slot);
        storageError = null;
        return true;
    } catch (_) {
        storageError = "存档未保存，已有记录保持不变。";
        return false;
    }
}

function rawSlots(s = store()) {
    const out = Object.create(null);
    const keys = [];
    for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (key && key.startsWith(PREFIX) && key !== PREFIX + "__probe__") { keys.push(key); }
    }
    for (const key of keys.sort()) { out[key.slice(PREFIX.length)] = s.getItem(key); }
    return out;
}

export function exportSave() {
    const profile = store().getItem(PROFILE_KEY);
    // Raw export also preserves malformed or newer profiles for later recovery.
    return profile === null || profile === undefined ? JSON.stringify(rawSlots()) : profile;
}

function fingerprint() {
    return JSON.stringify({ source: rawSlots(), pending: managed ? workingProfile : null });
}

export function previewImport(text) {
    try {
        if (!importValidator) { throw new Error("校验数据尚未就绪，暂时无法恢复存档。"); }
        return { ok: true, profile: importValidator(decodeBackup(text)), fingerprint: fingerprint() };
    } catch (error) {
        return { ok: false, error: error.message || "备份校验失败。" };
    }
}

export function importSave(text, expectedFingerprint) {
    const preview = previewImport(text);
    if (!preview.ok) { return preview; }
    if (!persistent) { return { ok: false, error: "浏览器未开放持久存储，恢复尚未执行。" }; }
    if (expectedFingerprint !== undefined && expectedFingerprint !== preview.fingerprint) {
        return { ok: false, error: "当前存档已变化，请重新选择备份并核对。" };
    }
    try {
        let revision = 0;
        try {
            const raw = store().getItem(PROFILE_KEY);
            if (raw !== null && raw !== undefined) { revision = checkProfileEnvelope(JSON.parse(raw)).revision; }
        } catch (_) { /* Explicit recovery can replace a broken envelope too. */ }
        const profile = importValidator(atRevision(preview.profile, revision + 1, true));
        // Serialize everything before the single commit. Legacy bytes stay untouched.
        const raw = JSON.stringify(profile);
        const sourceSlots = managed ? rawSlots() : null;
        store().setItem(PROFILE_KEY, raw);
        storageError = null;
        if (managed) { adoptCommitted(profile, raw, sourceSlots); publish(); }
        return { ok: true, profile: profile };
    } catch (_) {
        return { ok: false, error: "恢复未写入，原存档保持不变。请释放浏览器空间后重试。" };
    }
}

// Managed storage starts only after the game's content validator is available.
// workingProfile contains accepted gameplay facts, not queued purchase commands.
function copyProfile(profile) { return JSON.parse(JSON.stringify(profile)); }
function atRevision(profile, revision, restored = false) {
    const result = profile.lastResult;
    return { ...profile, revision, lastResult: result && (restored || result.revision === 0)
        ? { ...result, revision } : result };
}
function rawFingerprint(slots) {
    return JSON.stringify(Object.fromEntries(Object.keys(slots).sort().map(key => [key, slots[key]])));
}
function publish() {
    const state = storageState();
    const key = JSON.stringify(state);
    if (key === publishedState) { return; }
    publishedState = key;
    for (const listener of listeners) {
        try { listener(state); } catch (_) { /* A view cannot undo a completed storage write. */ }
    }
}
export function subscribeStorage(listener) {
    listeners.add(listener);
    listener(storageState());
    return function () { listeners.delete(listener); };
}

export function checkStorageChanges() {
    if (!managed || !workingProfile) { return !blocked; }
    if (blocked) { return false; }
    try {
        if (rawFingerprint(rawSlots()) === baseline) { return true; }
        blocked = "conflict";
        storageError = "存档已被其他页面修改。已停止写入，请先导出本页进度，再重新载入或恢复备份。";
    } catch (_) {
        // Raw reads can fail before new gameplay; keep the known profile exportable.
        needsCommit = true;
        storageError = "暂时无法访问浏览器存储。本页进度仍保留，请导出或重试。";
    }
    publish();
    return false;
}

function adoptCommitted(profile, raw, sourceSlots) {
    workingProfile = copyProfile(profile);
    baseline = rawFingerprint({ ...sourceSlots, profile: raw });
    needsCommit = false;
    blocked = null;
    storageError = null;
    lastSavedAt = persistent ? Date.now() : null;
}

function commitManaged(candidate, { defer = false, force = false } = {}) {
    if (!workingProfile || (blocked && blocked !== "conflict")) { return false; }
    let checked;
    try { checked = importValidator(candidate); }
    catch (_) {
        storageError = "当前进度校验失败，已有记录未覆盖。请导出原存档并恢复有效备份。";
        publish();
        return false;
    }
    const changed = needsCommit || JSON.stringify(checked) !== JSON.stringify(workingProfile);
    function retain() {
        if (defer && changed) { workingProfile = copyProfile(checked); needsCommit = true; }
        publish();
        return false;
    }
    if (!checkStorageChanges()) { return retain(); }
    // A no-op is not evidence that a previous failed payment was saved.
    if (!changed && !force) { return true; }
    let next, raw;
    try {
        next = importValidator(atRevision(checked, workingProfile.revision + (changed ? 1 : 0)));
        raw = JSON.stringify(next);
    } catch (_) {
        storageError = "存档无法序列化，已有记录未覆盖。请导出并检查备份。";
        return retain();
    }
    // No reads or callbacks after setItem are allowed to turn its success into
    // a reported failure. Build the next baseline from the pre-commit bytes.
    const sourceSlots = JSON.parse(baseline);
    try { store().setItem(PROFILE_KEY, raw); }
    catch (_) {
        storageError = "存档未保存，已有记录保持不变。请导出本页进度或释放浏览器空间后重试。";
        return retain();
    }
    adoptCommitted(next, raw, sourceSlots);
    publish();
    return true;
}

export function initializeStorage() {
    if (managed) { return { ok: !blocked && !needsCommit, error: storageError }; }
    managed = true;
    if (!importValidator) {
        blocked = "unavailable";
        storageError = "校验数据尚未就绪，已停止保存；原存档仍可导出。";
        publish();
        return { ok: false, error: storageError };
    }
    let sourceSlots, sourceVersion;
    try { sourceSlots = rawSlots(); baseline = rawFingerprint(sourceSlots); }
    catch (_) {
        blocked = "unavailable";
        storageError = "无法读取存储，已停止保存。请检查浏览器权限后重新载入。";
        publish();
        return { ok: false, error: storageError };
    }
    const hasProfile = Object.hasOwn(sourceSlots, "profile");
    try {
        const profile = hasProfile ? decodeBackup(sourceSlots.profile)
            : Object.keys(sourceSlots).length ? decodeBackup(JSON.stringify(sourceSlots)) : emptyProfile();
        sourceVersion = profile.profileVersion;
        workingProfile = copyProfile(importValidator(profile));
    } catch (error) {
        blocked = "corrupt";
        storageError = "存档无法读取，原始记录仍保留。" + (error.message || "请导出后恢复有效备份。");
        publish();
        return { ok: false, error: storageError };
    }
    needsCommit = !hasProfile || sourceVersion !== PROFILE_VERSION;
    if (!needsCommit) { storageError = null; publish(); return { ok: true }; }
    const ok = commitManaged(workingProfile, { defer: true });
    return { ok: ok, error: storageError };
}

export function retryStorage() {
    if (!managed || !workingProfile || blocked) {
        return { ok: false, error: storageError || "没有可以重试的合法进度。" };
    }
    if (!persistent) {
        let available, found;
        try {
            available = typeof window !== "undefined" ? window.localStorage : null;
            if (!available) { throw new Error("unavailable"); }
            found = rawSlots(available);
        } catch (_) {
            storageError = "浏览器仍未开放持久存储，仅当前页面有效。请先导出本页进度。";
            publish();
            return { ok: false, error: storageError };
        }
        backend = available;
        persistent = true;
        baseline = rawFingerprint(found);
        needsCommit = true;
        // We could not inspect these bytes at boot. Permission returning must
        // never be interpreted as permission to overwrite another save.
        if (Object.keys(found).length) {
            blocked = "conflict";
            storageError = "浏览器已有未读取的存档，未覆盖它。请先导出本页进度，再重新载入或明确恢复。";
            publish();
            return { ok: false, error: storageError };
        }
    }
    const ok = commitManaged(workingProfile, { defer: true, force: true });
    return { ok: ok, error: storageError };
}

export function exportPendingSave() {
    return managed && workingProfile && (needsCommit || !persistent || blocked === "conflict")
        ? JSON.stringify(workingProfile) : null;
}

function newRunId() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto && globalThis.crypto.getRandomValues) { globalThis.crypto.getRandomValues(bytes); }
    else { for (let i = 0; i < bytes.length; i++) { bytes[i] = Math.floor(Math.random() * 256); } }
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

// Binding is separate from the v3 snapshot and independent of its seeded RNG.
// A failed write retains the accepted run in this page, just like autosave.
export function beginRun(snapshot, { resume = false } = {}) {
    const runId = resume && workingProfile && workingProfile.runId || newRunId();
    if (!managed || !workingProfile || blocked && blocked !== "conflict") {
        // Preserve the existing read-only play fallback; it cannot overwrite
        // an unreadable archive, and its result will not claim to be saved.
        return { runId, accepted: false, saved: false, error: storageError };
    }
    if (workingProfile.lastResult && !workingProfile.lastResult.acknowledged) {
        return { runId: null, accepted: false, saved: false, error: "请先确认上一局的结算。" };
    }
    if (resume && (!workingProfile.run || JSON.stringify(snapshot) !== JSON.stringify(workingProfile.run))) {
        return { runId: null, accepted: false, saved: false, error: "续档已变化，请重新载入后继续。" };
    }
    const candidate = { ...copyProfile(workingProfile), runId, run: snapshot };
    try { importValidator(candidate); }
    catch (_) { return { runId: null, accepted: false, saved: false, error: "新的冒险进度无效，原存档未覆盖。" }; }
    commitManaged(candidate, { defer: true });
    const accepted = workingProfile.runId === runId;
    return { runId: accepted ? runId : null, accepted, saved: accepted && storageState().status === "saved", error: storageError };
}

// A descent is an intent, unlike already-earned combat/collection facts.
// Derive its next snapshot from the exact accepted old checkpoint and never
// retain a failed floor change for retryStorage to execute in the background.
export function advanceFloor(runId, checkpoint, calculateReward) {
    function refused(error) {
        return { ok: false, saved: false, status: storageState().status,
            run: null, meta: null, newPages: [], error };
    }
    if (!managed || !workingProfile || !runId || workingProfile.runId !== runId || !workingProfile.run
            || !checkpoint || !Number.isInteger(checkpoint.floor) || checkpoint.floor < 1 || checkpoint.floor >= 20) {
        return refused("本局或层号已失效，未提交下潜。");
    }
    try {
        if (JSON.stringify(checkpoint) !== JSON.stringify(workingProfile.run)) {
            return refused("本层检查点已变化，未提交下潜。请检查存档或重新载入。");
        }
        if (!checkStorageChanges()) { return refused(storageError); }
        const reward = calculateReward(copyProfile(workingProfile.meta), copyProfile(checkpoint));
        const newPages = reward.newPages.slice();
        const candidate = { ...copyProfile(workingProfile), meta: reward.meta,
            run: { ...copyProfile(workingProfile.run), floor: checkpoint.floor + 1, roomClaims: [] } };
        if (!commitManaged(candidate)) { return refused(storageError || "下潜检查点未保存。"); }
        const state = storageState();
        return { ok: true, saved: state.status === "saved", status: state.status, error: null,
            run: copyProfile(workingProfile.run), meta: copyProfile(workingProfile.meta), newPages };
    } catch (_) {
        return refused("下潜检查点校验失败，原存档未覆盖。");
    }
}

// This is deliberately a terminal-only transaction, not a general mutable
// profile API. Verify identity before asking the pure reward reducer to run.
export function completeRun(runId, facts, calculateReward) {
    if (workingProfile && workingProfile.lastResult && workingProfile.lastResult.runId === runId) {
        return terminalReply(runId);
    }
    if (!managed || !workingProfile || !runId || workingProfile.runId !== runId || !workingProfile.run
            || !facts || !Array.isArray(facts.items)
            || facts.volume !== workingProfile.run.volume || facts.cardId !== workingProfile.run.cardId) {
        return { receipt: null, saved: false, meta: null, error: storageError || "本局身份已失效，未提交结算。" };
    }
    try {
        const reward = calculateReward(copyProfile(workingProfile.meta), facts);
        const receipt = { runId, outcome: facts.outcome, volume: facts.volume, floor: facts.floor,
            cardId: facts.cardId, level: facts.level, coin: facts.coin, equipmentCount: facts.items.length,
            gems: reward.gems, newPages: reward.newPages, pages: reward.meta.pages.length,
            revision: 0, acknowledged: false };
        const candidate = { ...copyProfile(workingProfile), meta: reward.meta, run: null, runId: null, lastResult: receipt };
        commitManaged(candidate, { defer: true });
        return terminalReply(runId);
    } catch (_) {
        return { receipt: null, saved: false, meta: null, error: "结算校验失败，原存档未覆盖。" };
    }
}

export function resultState(runId) {
    const state = storageState();
    const result = workingProfile && workingProfile.lastResult;
    const receipt = result && result.runId === runId ? copyProfile(result) : null;
    const saved = !!receipt && receipt.revision > 0 && state.status === "saved";
    return { receipt, saved, status: state.status, canRetry: !!receipt && state.canRetry,
        error: saved ? null : state.error || "本次结算尚未保存。请导出本页进度，或恢复存储后重试。" };
}

function terminalReply(runId) {
    const result = resultState(runId);
    return { ...result, meta: result.receipt ? copyProfile(workingProfile.meta) : null };
}

export function acknowledgeResult(runId) {
    const result = resultState(runId);
    if (workingProfile && workingProfile.run) { return { ok: false, error: "另一局冒险已开始，不能使用旧结算离开。" }; }
    if (!result.saved || !checkStorageChanges()) {
        return { ok: false, error: storageError || result.error || "结算尚未保存，不能离开结果页。" };
    }
    if (result.receipt.acknowledged) { return { ok: true }; }
    const candidate = { ...copyProfile(workingProfile), lastResult: { ...result.receipt, acknowledged: true } };
    // Confirmation is commit-first: failure must leave the recoverable result
    // unacknowledged, and retryStorage must never perform the navigation.
    const ok = commitManaged(candidate);
    return { ok, error: ok ? null : storageError };
}
