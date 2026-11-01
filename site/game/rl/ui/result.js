// T23: the driver owns settlement and navigation; this modal only presents them.

// 动效节奏（spec/01 §1 MOTION_INTENSITY 4：UI 层 150–250ms、无弹跳）：
// 横幅/卡面入场与数字滚动 240ms，横幅高光脉冲 180ms，均在 250ms 上限内。
const RESULT_MOTION_MS = 240;
const RESULT_PULSE_MS = 180;

// 结算横幅铺 asset/img/rl/ui/ 的两张闲置场景图（result.webp=胜、dark.webp=负，
// 2026-10 盘点全站 0 引用，此处首次启用）。用 div + background 而不是 <img>：
// rl_result_browser 对 #rl-result img 是「唯一卡面」的严格单元素断言，多一个
// img 就会挂。URL 模块内 new URL 解析，兼容 /kirafan-timer/ 部署子路径
// （同 roster.js 的 CARD_ART_BASE）。
const RESULT_BANNERS = {
    victory: new URL("../../../asset/img/rl/ui/result.webp", import.meta.url).href,
    defeat: new URL("../../../asset/img/rl/ui/dark.webp", import.meta.url).href
};

// 结局一行吐槽：outcome × 卷序各一条（5+5，默认按卷序取行），
// 37/37 全图鉴另有彩蛋两条（37 = 34 卷页 + 3 终章，meta.js 实测去重数；
// 盘点时设想的「百页」档永远触发不了，已废弃）。与上一局撞行时在同一池内
// 随机换一条，保证连续两局不重复。记忆放 sessionStorage：restartRun 走
// 整页跳转，模块级变量跨局清零；且 sessionStorage 不是 kirafan-rl:profile
// 槽，terminal 门的单事务计数不受影响。存储被拒时静默退化为「可能重复」。
const RESULT_QUIPS = {
    victory: [
        "顺利收卷。书签今晚可以睡个好觉了。",
        "又一卷圆满——墨迹未干，先别急着合上。",
        "结局落在纸上的那一刻，比想象中要轻。",
        "这一卷写得漂亮，连折角都整整齐齐。",
        "收卷愉快。下一册的扉页已经在等你了。"
    ],
    defeat: [
        "这一页先折起来，下次从折角处接着写。",
        "力竭不是句号，只是页边的一道折线。",
        "故事没写完就打了个盹，也是常有的滋味。",
        "书签还夹在原地，随时回来接着走。",
        "被翻皱的那一页，反而记得最牢。"
    ]
};
const FULL_CODEX_QUIPS = [
    "37 页全齐——这本残页之书，今天正式补完了。",
    "最后一页也救回来了。谢谢你把故事一页一页带回家。"
];
const FULL_CODEX_PAGES = 37;
const QUIP_STORE_KEY = "kirafan-rl:result-quip";

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
        /* spec/01 §4: 纸面板统一 12–16px 圆角 + 1.5px 墨边；结算页原来是
           8px/1px，与菜单、图鉴、对白盒不是同一套壳体。 */
        border: 1.5px solid var(--kf-line);
        border-radius: var(--ui-radius);
        font: 14px/1.55 var(--font-sans);
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
    /* 结算横幅：胜/负场景图由 JS 按 outcome 写入 backgroundImage（模块内
       new URL 解析），这里只定壳。高度 clamp 防止 375×667 这类矮屏首屏被
       挤出；底部一道淡出融进纸面，让图「贴进书页」而不是浮在上面。 */
    #rl-result .result-banner {
        flex: none;
        height: clamp(96px, 18vh, 160px);
        border-radius: calc(var(--ui-radius) - 4px);
        background: var(--kf-sky) center 30% / cover no-repeat;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--kf-ink-soft) 16%, transparent);
        animation: result-banner-in ${RESULT_MOTION_MS}ms var(--ui-ease) both,
            result-banner-pulse ${RESULT_PULSE_MS}ms var(--ui-ease) ${RESULT_MOTION_MS}ms 1;
    }
    /* 结局一行吐槽：衬线斜体，放在卡面下方（.result-heading 之后）。 */
    #rl-result .result-quip {
        margin: 0;
        font: italic 13px/1.6 var(--font-serif);
        color: var(--kf-ink-soft);
        overflow-wrap: anywhere;
    }
    /* 终值摘要：只进读屏（追加进 aria-live 的 #result-save），不占版面。 */
    #rl-result .result-sr-note {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }
    /* 卡面上浮入场，与横幅的入场/脉冲共用 250ms 上限节奏。 */
    #rl-result .result-heading img { animation: result-art-in ${RESULT_MOTION_MS}ms var(--ui-ease) both; }
    @keyframes result-banner-in { from { opacity: 0; transform: translateY(-6px); } }
    @keyframes result-banner-pulse { 50% { filter: brightness(1.07) saturate(1.06); } }
    @keyframes result-art-in { from { opacity: 0; transform: translateY(10px); } }
    /* theme.css 的全局 reduced-motion 清单不含 #rl-result，这里自带 kill。 */
    @media (prefers-reduced-motion: reduce) {
        #rl-result .result-banner, #rl-result .result-heading img { animation: none; }
    }
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

function readLastQuipKey() {
    try {
        return window.sessionStorage.getItem(QUIP_STORE_KEY);
    } catch (_) { return null; }   // 存储被拒（如 terminal 门的无存储用例）时不记忆
}

// 选取本局吐槽：默认行按卷序取（同结局随卷变化）；若与上一局撞行，
// 在同一池里随机换一条——池 >1 时连续两局永不重复，彩蛋池同理轮换。
function pickResultQuip(summary) {
    const full = (summary.pages || 0) >= FULL_CODEX_PAGES;
    const pool = full ? FULL_CODEX_QUIPS : (RESULT_QUIPS[summary.outcome] || RESULT_QUIPS.defeat);
    const poolId = full ? "full" : (summary.outcome === "victory" ? "victory" : "defeat");
    let index = Math.min(Math.max((summary.volume || 1) - 1, 0), pool.length - 1);
    if (readLastQuipKey() === poolId + ":" + index && pool.length > 1) {
        const others = [];
        for (let i = 0; i < pool.length; i++) { if (i !== index) { others.push(i); } }
        index = others[Math.floor(Math.random() * others.length)];
    }
    try { window.sessionStorage.setItem(QUIP_STORE_KEY, poolId + ":" + index); } catch (_) {}
    return pool[index];
}

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

    // 结算横幅：胜/负各铺一张闲置场景图。div + background，绝不用 img（见
    // RESULT_BANNERS 处的断言说明）；纯装饰，aria-hidden 挡在读屏外。
    const banner = document.createElement("div");
    banner.className = "result-banner";
    banner.setAttribute("aria-hidden", "true");
    banner.style.backgroundImage = 'linear-gradient(180deg, transparent 60%, var(--kf-paper) 99%), url("'
        + (RESULT_BANNERS[summary.outcome] || RESULT_BANNERS.defeat) + '")';

    // 结局一行吐槽：衬线斜体，置于卡面下方。
    const quip = document.createElement("p");
    quip.className = "result-quip";
    quip.textContent = pickResultQuip(summary);

    const stats = document.createElement("dl");
    const fields = [
        ["抵达层数", summary.floor + " / 20"],
        ["角色等级", "Lv " + summary.level],
        ["本局金币", String(summary.coin)],
        ["持有装备", summary.equipmentCount + " 件"],
        ["本次星彩石", "+" + summary.gemsEarned],
        ["残页收藏", summary.pages + " 页"]
    ];
    // 数字滚动：dd 先按终值建好 DOM；允许动效时才换成 aria-hidden 的 span
    // 重演滚动，落定时把终值一次性写回 dd（不留 span，读屏浏览到的始终是
    // 真值）。全部落定后，向 aria-live 的 #result-save 追加一条 sr-only 终值
    // 摘要——只写一次，滚动过程不会刷屏。reduced-motion 或自动化环境
    // （rAF 被替换成空函数）直接出终值，不做滚动。
    const reduceMotion = typeof window !== "undefined" && typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const canRoll = !reduceMotion && typeof performance === "object"
        && typeof performance.now === "function" && typeof requestAnimationFrame === "function";
    let settling = fields.length;
    let statsNoteQueued = false;
    function noteSettled() {
        settling -= 1;
        if (settling > 0 || statsNoteQueued) { return; }
        statsNoteQueued = true;
        setTimeout(function () {
            if (!saved.isConnected || saved.querySelector(".result-sr-note")) { return; }
            const note = document.createElement("span");
            note.className = "result-sr-note";
            note.textContent = "最终结算：" + fields.map(function (f) { return f[0] + " " + f[1]; }).join("，");
            saved.appendChild(note);
        }, 0);
    }
    function rollStatValue(dd, parsed, finalText) {
        const span = document.createElement("span");
        span.setAttribute("aria-hidden", "true");
        span.textContent = parsed[1] + "0" + parsed[3];
        dd.textContent = "";
        dd.appendChild(span);
        const target = parseInt(parsed[2], 10);
        const startedAt = performance.now();
        let settled = false;
        function settle() {
            if (settled) { return; }
            settled = true;
            dd.textContent = finalText;   // 终值一次性写回
            noteSettled();
        }
        function tick() {
            if (settled) { return; }
            const t = Math.min((performance.now() - startedAt) / RESULT_MOTION_MS, 1);
            span.textContent = parsed[1] + Math.round(target * (1 - Math.pow(1 - t, 3))) + parsed[3];
            if (t < 1) { requestAnimationFrame(tick); } else { settle(); }
        }
        // 保底：无头/自动化环境可能把 rAF 换成永不回调的空函数，
        // 稍晚的 setTimeout 保证终值必然落回。
        setTimeout(settle, RESULT_MOTION_MS + 80);
        requestAnimationFrame(tick);
    }
    fields.forEach(function (entry) {
        const pair = document.createElement("div");
        const name = document.createElement("dt");
        const value = document.createElement("dd");
        name.textContent = entry[0];
        value.textContent = entry[1];
        const parsed = /^(.*?)(\d+)(.*)$/.exec(entry[1]);
        if (canRoll && parsed) {
            rollStatValue(value, parsed, entry[1]);
        } else {
            noteSettled();
        }
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
    scroll.append(banner, heading, quip, stats); storageActions.append(backup, retry);
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
