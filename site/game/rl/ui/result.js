// T23: the driver owns settlement and navigation; this modal only presents them.

const RESULT_CSS = `
    #rl-result, #rl-result * { box-sizing: border-box; letter-spacing: 0; }
    #rl-result {
        width: min(560px, calc(100% - 32px));
        max-height: calc(100dvh - 32px);
        margin: auto;
        padding: 24px;
        overflow: hidden;
        color: var(--kf-ink);
        background: var(--kf-paper);
        border: 1px solid var(--kf-ink-soft);
        border-radius: 8px;
        font: 14px/1.5 var(--font-sans);
        box-shadow: 0 8px 32px var(--kf-shadow);
    }
    #rl-result[open] { display: flex; flex-direction: column; gap: 12px; }
    #rl-result::backdrop { background: var(--kf-veil); }
    #rl-result .result-scroll { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    #rl-result .result-save { flex-shrink: 0; font-size: 13px; }
    #rl-result .result-save[data-saved="false"] { font-weight: 600; }
    #rl-result .result-heading {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 120px;
        gap: 20px;
        align-items: center;
    }
    #rl-result h2 {
        margin: 0 0 8px;
        font: 700 24px/1.4 var(--font-serif);
        overflow-wrap: anywhere;
    }
    #rl-result p { margin: 0; overflow-wrap: anywhere; }
    #rl-result .result-volume { color: var(--kf-ink-soft); }
    #rl-result .result-character { margin-top: 12px; font-size: 18px; font-weight: 600; }
    #rl-result img { display: block; width: 100%; aspect-ratio: 3 / 4; object-fit: contain; }
    #rl-result dl {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px 12px;
        border-top: 1px solid var(--kf-mint);
        margin: 20px 0;
        padding-top: 16px;
    }
    #rl-result dt { color: var(--kf-ink-soft); font-size: 12px; }
    #rl-result dd { margin: 4px 0 0; font-size: 18px; font-variant-numeric: tabular-nums; }
    #rl-result .result-actions, #rl-result .result-storage-actions {
        display: flex; flex-wrap: wrap; gap: 8px; flex-shrink: 0;
    }
    #rl-result button {
        flex: 1 1 120px;
        min-width: 0;
        min-height: 44px;
        padding: 10px 16px;
        border: 1px solid var(--kf-ink-soft);
        border-radius: 8px;
        background: var(--kf-paper);
        color: var(--kf-ink);
        font: 600 14px/1.5 var(--font-sans);
        cursor: pointer;
    }
    #rl-result button.primary { background: var(--kf-mint); }
    #rl-result button:hover { border-color: var(--kf-gold); }
    #rl-result button:active { background: var(--kf-sky); }
    #rl-result button:focus-visible { outline: 2px solid var(--kf-ink); outline-offset: 3px; }
    #rl-result button:disabled { cursor: wait; opacity: 0.65; }
    @media (max-width: 430px) {
        #rl-result { padding: 20px; }
        #rl-result .result-heading { grid-template-columns: minmax(0, 1fr) 88px; gap: 12px; }
        #rl-result h2 { font-size: 22px; }
        #rl-result dl { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-height: 480px) {
        #rl-result { padding: 12px 20px; gap: 8px; }
        #rl-result .result-heading { grid-template-columns: minmax(0, 1fr) 64px; }
    }
`;

export function showRunResult(summary, options) {
    if (document.getElementById("rl-result")) { return; }
    if (!document.getElementById("rl-result-style")) {
        const style = document.createElement("style");
        style.id = "rl-result-style";
        style.textContent = RESULT_CSS;
        document.head.appendChild(style);
    }

    const dialog = document.createElement("dialog");
    dialog.id = "rl-result";
    dialog.dataset.outcome = summary.outcome;
    dialog.setAttribute("aria-labelledby", "result-title");
    const heading = document.createElement("div");
    heading.className = "result-heading";
    const text = document.createElement("div");
    const title = document.createElement("h2");
    title.id = "result-title";
    title.tabIndex = -1;
    title.textContent = summary.outcome === "victory" ? "本卷完成" : "这一页先折起来";
    const volume = document.createElement("p");
    volume.className = "result-volume";
    volume.textContent = "第 " + summary.volume + " 卷 · " + summary.volumeName;
    const character = document.createElement("p");
    character.className = "result-character";
    character.textContent = summary.characterName;
    text.append(title, volume, character);
    heading.appendChild(text);
    if (summary.cardArt) {
        const art = document.createElement("img");
        art.src = summary.cardArt;
        art.alt = summary.characterName;
        art.addEventListener("error", function () { art.style.visibility = "hidden"; });
        heading.appendChild(art);
    }

    const stats = document.createElement("dl");
    const fields = [
        ["抵达层数", summary.floor + " / 20"],
        ["角色等级", "Lv " + summary.level],
        ["本局金币", String(summary.coin)],
        ["持有装备", summary.equipmentCount + " 件"],
        ["本次星彩石", "+" + summary.gemsEarned],
        ["残页收藏", summary.pages + " 页"]
    ];
    fields.forEach(function (entry) {
        const pair = document.createElement("div");
        const name = document.createElement("dt");
        const value = document.createElement("dd");
        name.textContent = entry[0];
        value.textContent = entry[1];
        pair.append(name, value);
        stats.appendChild(pair);
    });

    const actions = document.createElement("div");
    actions.className = "result-actions";
    const storageActions = document.createElement("div");
    storageActions.className = "result-storage-actions";
    const saved = document.createElement("p");
    saved.id = "result-save"; saved.className = "result-save";
    saved.setAttribute("role", "status"); saved.setAttribute("aria-live", "polite");
    const backup = document.createElement("button");
    backup.id = "result-storage"; backup.type = "button"; backup.textContent = "存档与备份";
    backup.addEventListener("click", function () { options.onStorage(); });
    const retry = document.createElement("button");
    retry.id = "result-retry"; retry.type = "button"; retry.textContent = "重试保存";
    let navigating = false, actionError = null;
    function refresh() {
        const state = options.state(), focused = document.activeElement;
        saved.dataset.saved = String(state.saved);
        saved.textContent = actionError || (state.saved ? "结算已保存。奖励只计入一次，可以继续出发。"
            : state.status === "session" ? "结算仅本页有效。请先导出进度，恢复存储后再离开。"
                : "结算未保存。" + (state.error || "请导出本页进度或重试。"));
        actions.querySelectorAll("button").forEach(button => { button.disabled = navigating || !state.saved; });
        backup.disabled = navigating;
        retry.hidden = !state.canRetry; retry.disabled = navigating || !state.canRetry;
        if (dialog.open && dialog.contains(focused) && (focused.disabled || focused.hidden)) {
            title.focus({ preventScroll: true });
        }
    }
    retry.addEventListener("click", function () {
        actionError = null;
        const result = options.onRetry();
        if (!result.ok) { actionError = result.error; }
        refresh();
    });
    function addAction(id, label, callback, primary) {
        const button = document.createElement("button");
        button.id = id;
        button.type = "button";
        button.textContent = label;
        if (primary) { button.className = "primary"; button.autofocus = true; }
        button.addEventListener("click", async function () {
            if (navigating) { return; }
            navigating = true; actionError = null; refresh();
            try {
                const result = await callback();
                if (result !== false && (!result || result.ok !== false)) { return; }
                actionError = result.error || "结算确认未保存，仍留在结果页。";
            } catch (_) { actionError = "未能离开结果页。请检查存档后重试。"; }
            navigating = false; refresh();
        });
        actions.appendChild(button);
    }
    addAction("result-restart", "重新出发", options.onRestart, !options.onNextVolume);
    if (options.onNextVolume) {
        addAction("result-next", "前往下一卷", options.onNextVolume, true);
    }
    const scroll = document.createElement("div"); scroll.className = "result-scroll";
    scroll.append(heading, stats); storageActions.append(backup, retry);
    dialog.append(scroll, saved, storageActions, actions);
    // A terminal run cannot be resumed by dismissing the browser's modal.
    dialog.addEventListener("cancel", function (event) { event.preventDefault(); });
    dialog.addEventListener("keydown", function (event) {
        event.stopPropagation();
        if (event.key !== "Tab") { return; }
        const buttons = Array.from(dialog.querySelectorAll("button:not(:disabled):not([hidden])"));
        if (!buttons.length) { event.preventDefault(); title.focus({ preventScroll: true }); return; }
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !buttons.includes(document.activeElement))) {
            event.preventDefault();
            first.focus();
        }
    });
    const unsubscribe = options.subscribe(function () { actionError = null; refresh(); });
    dialog.addEventListener("close", function () { unsubscribe(); dialog.remove(); }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
    title.focus({ preventScroll: true });
}
