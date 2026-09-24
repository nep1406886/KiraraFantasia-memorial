// 成就 overlay + 达成 toast (plan 阶段 8「菜单、教学、成就」).
//
// Same grammar as codex.js: the module is dumb data-wise — the caller (main.js)
// hands it fully assembled entries [{ id, name, desc, done }], so nothing here
// reads meta or the ACHIEVEMENTS table directly, and the browser gate can
// assert against the same assembled shape it seeded into localStorage.
//
// Interaction contract: rows are plain divs (nothing to click through — the
// only interactive surface is the close button), Escape and the close button
// both dismiss, and the list is a single minmax-safe column, so no width can
// push it off-screen (the two-widths lesson).
//
// The toast is the unlock feedback: one at a time, a re-show restarts the
// timer instead of stacking (matches the CSS's fixed top-center chip).

export function createAchievementsUI(options) {
    const opts = options || {};
    const entries = opts.entries || [];
    const overlay = document.createElement("div");
    overlay.id = "achv-overlay";
    overlay.className = "achv-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "成就");

    const doneCount = entries.filter(function (e) { return e.done; }).length;

    // --- header -------------------------------------------------------------
    const head = document.createElement("div");
    head.className = "achv-head";
    const title = document.createElement("h3");
    title.textContent = "成就";
    const count = document.createElement("span");
    count.className = "achv-count";
    count.id = "achv-count";
    count.textContent = doneCount + " / " + entries.length;
    head.appendChild(title);
    head.appendChild(count);
    overlay.appendChild(head);

    // --- rows ----------------------------------------------------------------
    const scroll = document.createElement("div");
    scroll.className = "achv-scroll";
    entries.forEach(function (entry) {
        const row = document.createElement("div");
        row.className = "achv-row" + (entry.done ? " done" : " locked");
        row.dataset.achvId = String(entry.id);
        row.dataset.done = entry.done ? "1" : "0";

        const star = document.createElement("span");
        star.className = "achv-star";
        star.textContent = "★";
        row.appendChild(star);

        const body = document.createElement("div");
        body.className = "achv-body";
        const name = document.createElement("div");
        name.className = "achv-name";
        name.textContent = entry.name;
        const desc = document.createElement("div");
        desc.className = "achv-desc";
        desc.textContent = entry.desc;
        body.appendChild(name);
        body.appendChild(desc);
        row.appendChild(body);

        scroll.appendChild(row);
    });
    overlay.appendChild(scroll);

    // --- footer --------------------------------------------------------------
    const close = document.createElement("button");
    close.type = "button";
    close.id = "achv-close";
    close.className = "achv-close";
    close.textContent = "关闭";
    overlay.appendChild(close);

    return overlay;
}

// showAchievements({ entries, onClose }) → Promise<null>, resolved when
// dismissed. Escape and the close button both work; the caller owns freezing
// (same contract as showCodex).
export function showAchievements(options) {
    const opts = options || {};
    return new Promise(function (resolve) {
        const overlay = createAchievementsUI(opts);

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
        overlay.querySelector("#achv-close").addEventListener("click", close);
        document.body.appendChild(overlay);
    });
}

// showAchievementToast(entry) — "★ 成就达成 「name」" for ~4s. One at a time:
// a second unlock while one shows replaces the text and restarts the timer
// rather than stacking two chips.
export function showAchievementToast(entry) {
    const toast = document.getElementById("achv-toast");
    if (!toast || !entry) {
        return;
    }
    toast.textContent = "";
    const star = document.createElement("span");
    star.className = "achv-toast-star";
    star.textContent = "★";
    toast.appendChild(star);
    toast.appendChild(document.createTextNode(
        " 成就达成 「" + entry.name + "」"));

    if (showAchievementToast._timer) {
        clearTimeout(showAchievementToast._timer);
    }
    // Force a reflow between class removals so a back-to-back unlock
    // re-triggers the CSS transition instead of snapping.
    toast.classList.remove("show");
    void toast.offsetWidth;
    toast.classList.add("show");
    showAchievementToast._timer = setTimeout(function () {
        toast.classList.remove("show");
        showAchievementToast._timer = null;
    }, 4000);
}
