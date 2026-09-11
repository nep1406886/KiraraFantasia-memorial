// The driver owns the transition. This modal only reports its stage and intents.
const CSS = `
    #rl-floor-load, #rl-floor-load * { box-sizing: border-box; letter-spacing: 0; }
    #rl-floor-load {
        width: min(520px, calc(100% - 32px)); max-height: calc(100dvh - 32px);
        margin: auto; padding: 24px; overflow: hidden;
        color: var(--kf-ink); background: var(--kf-paper);
        border: 1px solid var(--kf-ink-soft); border-radius: 8px;
        font: 14px/1.55 var(--font-sans); box-shadow: 0 8px 32px var(--kf-shadow);
    }
    #rl-floor-load[open] { display: flex; flex-direction: column; gap: 14px; }
    #rl-floor-load::backdrop { background: var(--kf-veil); }
    #rl-floor-load .floor-load-scroll { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
    #rl-floor-load .floor-load-heading {
        display: grid; grid-template-columns: minmax(0, 1fr) 72px; gap: 16px; align-items: center;
    }
    #rl-floor-load h2 { margin: 0 0 6px; font: 700 24px/1.4 var(--font-serif); }
    #rl-floor-load p { margin: 0; overflow-wrap: anywhere; }
    #rl-floor-load img { width: 100%; aspect-ratio: 3/4; object-fit: contain; }
    #rl-floor-load .floor-load-target { color: var(--kf-ink-soft); }
    #rl-floor-load progress { width: 100%; height: 8px; accent-color: var(--kf-ink-soft); margin: 16px 0 10px; }
    #floor-load-message { margin-top: 14px !important; }
    #floor-load-save { margin-top: 10px !important; font-size: 13px; }
    #floor-load-save[data-saved="false"] { font-weight: 600; }
    #rl-floor-load .floor-load-actions { display: flex; flex-wrap: wrap; gap: 8px; flex-shrink: 0; }
    #rl-floor-load button {
        flex: 1 1 120px; min-width: 0; min-height: 44px; padding: 9px 12px;
        border: 1px solid var(--kf-ink-soft); border-radius: 8px;
        background: var(--kf-paper); color: var(--kf-ink); font: 600 14px/1.5 var(--font-sans);
        cursor: pointer;
    }
    #rl-floor-load button.primary { background: var(--kf-mint); }
    #rl-floor-load button:hover { border-color: var(--kf-gold); }
    #rl-floor-load button:focus-visible { outline: 2px solid var(--kf-ink); outline-offset: 2px; }
    #rl-floor-load button:disabled { opacity: .6; cursor: default; }
    @media (max-width: 430px) {
        #rl-floor-load { padding: 18px; }
        #rl-floor-load h2 { font-size: 22px; }
        #rl-floor-load .floor-load-heading { grid-template-columns: minmax(0, 1fr) 60px; gap: 10px; }
    }
    @media (max-height: 480px) {
        #rl-floor-load { padding: 12px 18px; gap: 8px; }
        #rl-floor-load .floor-load-heading { grid-template-columns: minmax(0, 1fr) 48px; }
    }
`;

function node(tag, text, id) {
    const element = document.createElement(tag);
    if (text !== undefined) { element.textContent = text; }
    if (id) { element.id = id; }
    return element;
}

export function showFloorLoading(summary, options) {
    if (!document.getElementById("rl-floor-load-style")) {
        const style = node("style", CSS, "rl-floor-load-style"); document.head.appendChild(style);
    }
    const dialog = node("dialog", undefined, "rl-floor-load");
    dialog.setAttribute("aria-labelledby", "floor-load-title");
    dialog.setAttribute("aria-describedby", "floor-load-message");
    const title = node("h2", "准备下一层", "floor-load-title"); title.tabIndex = -1;
    const heading = node("div"); heading.className = "floor-load-heading";
    const text = node("div");
    text.append(title, node("p", "第 " + summary.volume + " 卷 · " + summary.volumeName));
    const target = node("p", "第 " + summary.from + " 层 → 第 " + summary.to + " 层");
    target.className = "floor-load-target"; text.appendChild(target); heading.appendChild(text);
    if (summary.cardArt) {
        const art = node("img"); art.src = summary.cardArt; art.alt = summary.characterName;
        art.addEventListener("error", function () { art.style.visibility = "hidden"; });
        heading.appendChild(art);
    }
    const progress = node("progress"); progress.setAttribute("aria-label", "下一层加载进度");
    const message = node("p", "正在准备原作地图资源，当前层与检查点暂不切换。", "floor-load-message");
    message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite");
    const saved = node("p", "", "floor-load-save");
    const scroll = node("div"); scroll.className = "floor-load-scroll";
    scroll.append(heading, progress, message, saved);
    const actions = node("div"); actions.className = "floor-load-actions";
    const retry = node("button", "重试下潜", "floor-load-retry"); retry.className = "primary";
    const backup = node("button", "存档与备份", "floor-load-storage");
    const back = node("button", "返回选角", "floor-load-back");
    for (const button of [retry, backup, back]) { button.type = "button"; actions.appendChild(button); }
    dialog.append(scroll, actions);
    let view = { busy: true, phase: "preload", committed: false }, closed = false;
    function refresh() {
        const state = options.state(), focused = document.activeElement;
        dialog.dataset.phase = view.phase;
        dialog.dataset.committed = String(view.committed);
        title.textContent = view.busy ? "准备下一层" : view.committed ? "检查点已提交" : "下潜已暂停";
        progress.hidden = !view.busy;
        retry.disabled = view.busy;
        retry.textContent = view.committed ? "重试装配" : "重试下潜";
        back.disabled = state.status !== "saved";
        saved.dataset.saved = String(state.status === "saved");
        if (state.status === "saved") {
            saved.textContent = "第 " + (view.committed ? summary.to : summary.from)
                + " 层检查点已保存。返回选角会保留续档，不会放弃本局。";
        } else if (state.status === "session") {
            saved.textContent = "进度仅本页有效。请先打开备份窗口导出；恢复持久保存前不能离开。";
        } else {
            saved.textContent = "本页进度尚未保存。请在备份窗口导出或重试保存，再返回选角。"
                + (state.error || "");
        }
        if (view.message) { message.textContent = view.message; }
        if (dialog.open && dialog.contains(focused) && (focused.disabled || focused.hidden)) {
            title.focus({ preventScroll: true });
        }
    }
    retry.addEventListener("click", function () { options.onRetry(); });
    backup.addEventListener("click", function () { options.onStorage(); });
    back.addEventListener("click", function () { options.onBack(); });
    dialog.addEventListener("cancel", function (event) { event.preventDefault(); });
    dialog.addEventListener("keydown", function (event) {
        event.stopPropagation();
        if (event.key !== "Tab") { return; }
        const buttons = [retry, backup, back].filter(function (button) { return !button.disabled; });
        const active = document.activeElement;
        if (event.shiftKey && (active === buttons[0] || !buttons.includes(active))) {
            event.preventDefault(); buttons[buttons.length - 1].focus();
        } else if (!event.shiftKey && (active === buttons[buttons.length - 1] || !buttons.includes(active))) {
            event.preventDefault(); buttons[0].focus();
        }
    });
    const unsubscribe = options.subscribe(refresh);
    document.body.appendChild(dialog); dialog.showModal(); title.focus({ preventScroll: true });
    return {
        update: function (state) { if (!closed) { view = { ...view, ...state }; refresh(); } },
        close: function () {
            if (closed) { return; }
            closed = true; unsubscribe(); dialog.close(); dialog.remove();
        }
    };
}
