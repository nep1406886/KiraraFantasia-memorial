// 操作说明 overlay (plan 阶段 8「菜单、教学、成就」): a static reference to
// the controls. Same grammar as codex.js / achievements.js — the module only
// assembles DOM, the caller (main.js) owns freezing, and the browser gate
// asserts against the same static rows.
//
// Content follows docs/游玩说明.md 二、操作 and input.js KEYMAP. Key 1 is the
// character's とっておき slot (skills.js puts the chara skill first and marks
// it ultimate), so the overlay says what the manual says: 技能 2/3, 必杀 R
// (也兼容 1). Touch gets the manual's touch paragraph.
//
// Interaction: rows are plain divs; the only interactive surfaces are the
// optional 重新教学 button (caller-enabled, only with an active run) and the
// close button. Escape and close both dismiss.

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}

function key(text) {
    return el("kbd", "howto-key", text);
}

function keyRow(keys, labelText) {
    const row = el("div", "howto-row");
    const cluster = el("div", "howto-keys");
    keys.forEach(function (k) {
        cluster.appendChild(key(k));
    });
    const label = el("div", "howto-label", labelText);
    row.appendChild(cluster);
    row.appendChild(label);
    return row;
}

export function createHowtoUI(options) {
    const opts = options || {};
    const overlay = el("div", "howto-overlay");
    overlay.id = "howto-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "操作说明");

    const head = el("div", "howto-head");
    const title = el("h3", null, "操作说明");
    head.appendChild(title);
    overlay.appendChild(head);

    const scroll = el("div", "howto-scroll");

    // --- 键盘 ------------------------------------------------------------
    const kb = el("section", "howto-card");
    kb.appendChild(el("h4", "howto-card-title", "键盘 / 鼠标"));
    kb.appendChild(keyRow(["W", "A", "S", "D"], "移动（方向键也可）；八方向，斜向不加速"));
    kb.appendChild(keyRow(["J"], "普通攻击（鼠标左键也可）；连按形成连段，不消耗资源"));
    kb.appendChild(keyRow(["鼠标", "移动"], "瞄准：挥击与定向技能朝光标，不限八方向"));
    kb.appendChild(keyRow(["K"], "闪避（空格也可）；翻滚 + 0.35 秒无敌帧"));
    kb.appendChild(keyRow(["2", "3"], "技能：两个独立冷却，可随时查看效果"));
    kb.appendChild(keyRow(["R"], "とっておき必杀（也兼容 1）；满槽时发动"));
    kb.appendChild(keyRow(["E"], "互动：商店 / 休息 / 残页 / 祭坛"));
    kb.appendChild(keyRow(["Esc"], "暂停菜单（再按一次继续）"));
    kb.appendChild(keyRow(["点击", "Enter"], "对话：补全当前一句，再按推进下一句"));
    scroll.appendChild(kb);

    // --- 触屏 ------------------------------------------------------------
    const touch = el("section", "howto-card");
    touch.appendChild(el("h4", "howto-card-title", "触屏"));
    const touchRows = [
        ["左半屏 · 虚拟摇杆", "按住拖动移动；摇杆松开即停"],
        ["右下 · 普攻 / 闪避", "普攻轻点出招、按住连击、拖动 360° 瞄准"],
        ["左下技能图标 / 必杀条", "本身就是按钮，点按施放"],
        ["右侧 · 交互按钮", "与 E 同一入口；顶部菜单按钮相当于 Esc"],
        ["横屏", "必须横屏游玩；竖屏会暂停战斗并提示旋转"]
    ];
    touchRows.forEach(function (pair) {
        const row = el("div", "howto-row touch");
        const label = el("div", "howto-label", pair[0]);
        const desc = el("div", "howto-desc", pair[1]);
        row.appendChild(label);
        row.appendChild(desc);
        touch.appendChild(row);
    });
    scroll.appendChild(touch);

    overlay.appendChild(scroll);

    // --- footer ----------------------------------------------------------
    const footer = el("div", "howto-footer");
    if (opts.canRetryTutorial) {
        const again = el("button", "howto-again");
        again.type = "button";
        again.id = "howto-again";
        again.textContent = "重新进行教学";
        again.addEventListener("click", function () {
            if (typeof opts.onRetryTutorial === "function") {
                opts.onRetryTutorial();
            }
        });
        footer.appendChild(again);
    }
    const close = el("button", "howto-close");
    close.type = "button";
    close.id = "howto-close";
    close.textContent = "关闭";
    footer.appendChild(close);
    overlay.appendChild(footer);

    return overlay;
}

// showHowto({ canRetryTutorial, onRetryTutorial, onClose }) → Promise<null>,
// resolved when dismissed. Escape and the close button both work; the caller
// owns freezing (same contract as showCodex / showAchievements).
export function showHowto(options) {
    const opts = options || {};
    return new Promise(function (resolve) {
        const overlay = createHowtoUI(opts);

        function close() {
            document.removeEventListener("keydown", onKey);
            overlay.remove();
            resolve(null);
            if (typeof opts.onClose === "function") {
                opts.onClose();
            }
        }
        function onKey(e) {
            if (e.key === "Escape") {
                e.stopPropagation();
                close();
            }
        }
        document.addEventListener("keydown", onKey);

        // 重新教学 is a leaf action: it starts the walkthrough, which needs the
        // world unfrozen, so the overlay dismisses itself right after.
        const again = overlay.querySelector("#howto-again");
        if (again) {
            again.addEventListener("click", close);
        }
        overlay.querySelector("#howto-close").addEventListener("click", close);
        document.body.appendChild(overlay);
    });
}