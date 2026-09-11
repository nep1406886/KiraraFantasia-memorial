// Storage owns data and validation; this view only presents a replace decision.
import { MAX_BACKUP_BYTES } from "../profileschema.js";

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) { element.className = className; }
    if (text !== undefined) { element.textContent = text; }
    return element;
}

function storageMessage(state, compact = false) {
    if (state.status === "session") { return compact ? "仅本页有效，请导出进度" : state.error || "仅当前页面有效，关闭后不会保留。"; }
    if (state.status === "conflict") { return compact ? "存档有变更，已停止写入" : state.error; }
    if (state.status === "corrupt") { return compact ? "存档需恢复，已停止保存" : state.error; }
    if (state.status === "unavailable") { return compact ? "暂不可保存，原档已保留" : state.error; }
    if (state.status === "unsaved") { return compact ? "未保存，请导出或重试" : state.error || "当前进度尚未写入浏览器。"; }
    if (state.status === "loading") { return "正在检查存档…"; }
    return state.lastSavedAt ? "已保存到当前浏览器" : "已读取本地存档";
}

export function createStorageStatus(options) {
    const panel = node("section", "rl-save-status"); panel.id = "save-status";
    panel.setAttribute("aria-label", "存档状态");
    const copy = node("div", "save-status-copy");
    const message = node("span"); message.id = "save-status-message";
    message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite");
    const time = node("span", "save-status-time"); time.id = "save-status-time";
    const actions = node("div", "save-status-actions");
    const retry = node("button", "", "重试保存"); retry.id = "save-status-retry"; retry.type = "button";
    const open = node("button", "", "存档与备份"); open.id = "save-status-open"; open.type = "button";
    retry.addEventListener("click", () => options.retry());
    open.addEventListener("click", () => options.onOpen());
    copy.append(message, time); actions.append(retry, open); panel.append(copy, actions);
    if (options.brand) { panel.prepend(options.brand); }
    document.body.insertBefore(panel, document.body.firstChild);
    const unsubscribe = options.subscribe(state => {
        panel.dataset.state = state.status;
        const text = storageMessage(state, true);
        if (message.textContent !== text) { message.textContent = text; }
        time.textContent = state.lastSavedAt ? "上次保存 " + new Date(state.lastSavedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "";
        const retryFocused = document.activeElement === retry;
        retry.hidden = !state.canRetry; retry.disabled = !state.canRetry;
        if (retry.hidden && retryFocused) { open.focus({ preventScroll: true }); }
        if (options.onState) { options.onState(state); }
    });
    function resized() {
        document.documentElement.style.setProperty("--save-status-height", panel.getBoundingClientRect().height + "px");
        if (options.onResize) { options.onResize(); }
    }
    const observer = new ResizeObserver(resized); observer.observe(panel); resized();
    return { destroy() { unsubscribe(); observer.disconnect(); panel.remove(); } };
}

export function showStorageManager(options) {
    const dialog = node("dialog", "rl-decision rl-storage");
    dialog.id = "rl-storage";
    const heading = node("h2", "", "存档与备份");
    heading.id = "storage-title"; heading.tabIndex = -1;
    dialog.setAttribute("aria-labelledby", heading.id);
    const previous = document.activeElement;
    let closed = false, generation = 0, selected = null, committed = false;
    const mode = node("p", "decision-status");
    let state = options.state();
    mode.textContent = storageMessage(state);
    const status = node("p", "decision-status"); status.id = "storage-result"; status.setAttribute("role", "status");
    const current = node("section", "storage-current");
    const pending = node("section", "storage-pending"); pending.id = "storage-pending"; pending.hidden = true;
    const preview = node("section", "storage-preview"); preview.id = "storage-preview"; preview.hidden = true;
    const scroll = node("div", "storage-scroll");
    const selection = node("div", "storage-file");
    selection.appendChild(node("span", "", "恢复备份"));
    const file = node("input"); file.id = "storage-file"; file.type = "file"; file.accept = ".json,application/json";
    file.hidden = true;
    const picker = node("button", "", "选择备份文件"); picker.type = "button"; picker.id = "storage-select-file";
    picker.addEventListener("click", () => file.click());
    const filename = node("span", "storage-filename", "未选择文件");
    const fileRow = node("div", "storage-file-row"); fileRow.append(picker, filename);
    selection.append(fileRow, file);
    const actions = node("div", "decision-actions");
    const download = node("button", "", "导出存档"); download.id = "storage-export"; download.type = "button";
    const downloadPending = node("button", "", "导出本页进度"); downloadPending.id = "storage-export-pending"; downloadPending.type = "button";
    const retry = node("button", "", "重试保存"); retry.id = "storage-retry"; retry.type = "button";
    const restore = node("button", "primary", "确认替换并重新载入"); restore.id = "storage-confirm";
    restore.type = "button"; restore.disabled = true;
    const back = node("button", "", "返回"); back.type = "button"; back.id = "storage-close";

    function summary(container, title, profile) {
        container.replaceChildren(node("h3", "", title));
        if (!profile) { container.appendChild(node("p", "", "暂时无法预览；原文仍可导出。")); return; }
        const meta = profile.meta || {};
        const dl = node("dl", "storage-summary");
        const rows = [["星彩石", meta.gems ?? meta.shards ?? 0], ["已通关", (meta.volumes || 0) + " 卷"],
            ["残页", (meta.pages || []).length + " / 37"],
            ["冒险进度", profile.run ? "第 " + profile.run.volume + " 卷 · 第 " + profile.run.floor + " 层" : "无进行中的冒险"],
            ["镜头高度", profile.settings["cam-height"] ?? 9]];
        if (profile.run) { rows.splice(4, 0, ["冒险角色", options.characterName(profile.run.cardId) + " · Lv " + profile.run.level]); }
        if (profile.lastResult) {
            const result = profile.lastResult;
            rows.push(["最近结算", "第 " + result.volume + " 卷 · " + (result.outcome === "victory" ? "通关" : "力竭")
                + " · " + (result.acknowledged ? "已确认" : "待确认")],
            ["结算角色", options.characterName(result.cardId)], ["本次星彩石", "+" + result.gems]);
        }
        for (const [label, value] of rows) { dl.append(node("dt", "", label), node("dd", "", String(value))); }
        container.appendChild(dl);
        const levels = meta.levels || {}, limits = meta.lb || {};
        const trained = Array.from(new Set(Object.keys(levels).concat(Object.keys(limits))))
            .filter(id => (levels[id] || 1) > 1 || (limits[id] || 0) > 0);
        if (trained.length) {
            const list = node("ul", "storage-levels");
            for (const id of trained) {
                list.appendChild(node("li", "", options.characterName(Number(id)) + " · Lv " + (levels[id] || 1)
                    + " · 突破 " + (limits[id] || 0)));
            }
            container.append(node("h3", "", "培养记录"), list);
        }
    }
    function refresh() {
        const focused = document.activeElement;
        state = options.state();
        mode.textContent = storageMessage(state);
        retry.hidden = !state.canRetry; retry.disabled = !state.canRetry;
        download.textContent = state.persistent ? "导出原存档" : "导出会话存档";
        restore.disabled = !selected || !state.persistent;
        try {
            const snapshot = options.preview(options.export());
            summary(current, state.persistent ? "已保存的记录" : "当前会话记录", snapshot.ok ? snapshot.profile : null);
        } catch (_) { summary(current, "原存档", null); }
        const pendingText = options.pending ? options.pending() : null;
        pending.hidden = !pendingText; downloadPending.hidden = !pendingText;
        if (pendingText) {
            const checked = options.preview(pendingText);
            summary(pending, "本页进度（尚未持久保存）", checked.ok ? checked.profile : null);
        } else { pending.replaceChildren(); }
        if (dialog.open && dialog.contains(focused) && (focused.hidden || focused.disabled)) {
            heading.focus({ preventScroll: true });
        }
    }
    refresh();
    const unsubscribe = options.subscribe ? options.subscribe(refresh) : function () {};

    function close() {
        if (closed || committed) { return; }
        closed = true; generation += 1;
        unsubscribe();
        dialog.close(); dialog.remove();
        if (previous && previous.isConnected) { previous.focus(); }
        options.onClose();
    }
    function downloadText(read, prefix) {
        let url;
        try {
            const text = read();
            if (typeof text !== "string") { throw new Error("missing snapshot"); }
            url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
            const link = node("a"); link.href = url;
            link.download = prefix + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
            document.body.appendChild(link); link.click(); link.remove();
            status.textContent = "备份已导出。";
        } catch (_) { status.textContent = "无法读取存档，导出未完成。"; }
        finally { if (url) { setTimeout(() => URL.revokeObjectURL(url), 1000); } }
    }
    download.addEventListener("click", () => downloadText(options.export, "kirafan-save-"));
    downloadPending.addEventListener("click", () => downloadText(options.pending, "kirafan-unsaved-"));
    retry.addEventListener("click", function () {
        const result = options.retry();
        status.textContent = result.ok ? "本页进度已保存。此前失败的培养或突破未自动执行，请重新确认。" : result.error;
        refresh();
    });
    file.addEventListener("change", async function () {
        const token = ++generation;
        selected = null; restore.disabled = true; preview.hidden = true; preview.replaceChildren(); status.textContent = "";
        const chosen = file.files[0];
        filename.textContent = chosen ? chosen.name : "未选择文件";
        if (!chosen) { return; }
        if (chosen.size > MAX_BACKUP_BYTES) { status.textContent = "备份文件不能超过 2 MiB。"; return; }
        try {
            const text = await chosen.text();
            if (closed || generation !== token) { return; }
            const checked = options.preview(text);
            if (!checked.ok) { status.textContent = checked.error; return; }
            selected = { text: text, fingerprint: checked.fingerprint };
            summary(preview, "将替换为", checked.profile); preview.hidden = false;
            status.textContent = "恢复会替换当前角色进度、冒险和镜头设置。";
            restore.disabled = !state.persistent;
        } catch (_) {
            if (!closed && generation === token) { status.textContent = "文件读取失败，存档未改变。"; }
        }
    });
    restore.addEventListener("click", function () {
        if (!selected || committed) { return; }
        restore.disabled = true;
        const result = options.restore(selected.text, selected.fingerprint);
        if (!result.ok) { status.textContent = result.error; restore.disabled = false; return; }
        committed = true; unsubscribe(); restore.disabled = true;
        file.disabled = true; picker.disabled = true; download.disabled = true; back.disabled = true;
        downloadPending.disabled = true; retry.disabled = true;
        status.textContent = "恢复已保存，正在重新载入。";
        options.onRestored();
    });
    back.addEventListener("click", close);
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.addEventListener("keydown", function (event) {
        event.stopPropagation();
        if (event.key !== "Tab") { return; }
        // Retry can hide actions; include only the current keyboard targets.
        const buttons = Array.from(dialog.querySelectorAll("button:not(:disabled):not([hidden])"));
        if (!buttons.length) { event.preventDefault(); heading.focus({ preventScroll: true }); return; }
        const first = buttons[0], last = buttons[buttons.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && (active === first || active === heading)) {
            event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (active === last || active === heading)) {
            event.preventDefault(); first.focus();
        }
    });
    actions.append(download, downloadPending, retry, restore, back);
    scroll.append(mode, current, pending, selection, preview);
    dialog.append(heading, scroll, status, actions);
    document.body.appendChild(dialog); dialog.showModal(); heading.focus({ preventScroll: true });
    return { close: close };
}
