// 残页図鑑 overlay (T13) + 敌人図鑑 tab (T22f): the collection viewer.
//
// The codex is dumb data-wise: the caller (main.js) hands it fully assembled
// sections — pages: { title, entries: [{ id, work, hero, text, collected }] },
// enemies: { title, entries: [{ id, nameZh, name, element, role, level, hp,
// atk, def, coin, exp, model, encountered }] } — so nothing here reads meta or
// the page/encounter tables directly, and the browser gate can assert against
// the same assembled shape it seeded into localStorage.
//
// Interaction contract (spec/06 T13 acceptance): every entry is a <button>
// (Tab order = DOM order), Escape and the close button both dismiss, and the
// overlay never scrolls the page horizontally at any width — the grid is
// minmax(0,1fr) auto-fill, so the two-widths lesson (375+1280 green while
// 390/412/430 broke) cannot recur by construction. Only the active tab's
// entries are in the DOM, so .codex-entry always means "the visible tab".
//
// Enemy 立绘 (T22f): enemies ship no bust art — the original's face IS the
// model — so encountered entries get a once-rendered orthographic snapshot
// (ui/enemythumb.js), fetched lazily via IntersectionObserver: the roster is
// 96 faces and only the scrolled-in ones pay a GLB parse.

import { renderEnemyThumb } from "./enemythumb.js";

// Module-relative (this file lives at game/rl/ui/): a page-relative "../.."
// would escape a /kirafan-timer/ deployment subpath.
const BUST_BASE = new URL("../../../asset/img/rl/bust/", import.meta.url).href;
const ELEMENT_CHAR = ["炎", "水", "土", "風", "月", "日"];
const ROLE_LABEL = { mob: "杂兵", elite: "精英", boss: "首领" };

export function createCodexUI(options) {
    const opts = options || {};
    const sections = opts.sections || [];
    const enemySections = opts.enemySections || [];
    const storySections = opts.storySections || [];
    const hasEnemies = enemySections.length > 0;
    const hasStories = storySections.length > 0;
    const overlay = document.createElement("div");
    overlay.id = "codex-overlay";
    overlay.className = "codex-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "冒险图鉴");

    let tab = "pages";
    let collectedCount = 0;
    let totalCount = 0;
    let observer = null;
    let storyFilter = "read";
    const scroll = document.createElement("div");
    scroll.className = "codex-scroll";
    const detail = document.createElement("div");
    detail.className = "codex-detail";
    detail.id = "codex-detail";
    detail.textContent = "点击一页来阅读";
    const count = document.createElement("span");
    count.className = "codex-count";
    count.id = "codex-count";

    // --- header -------------------------------------------------------------
    const head = document.createElement("div");
    head.className = "codex-head";
    const title = document.createElement("h3");
    title.textContent = "残页图鉴";
    const tabs = document.createElement("div");
    tabs.className = "codex-tabs";
    tabs.id = "codex-tabs";

    function makeTab(name, label) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "codex-tab";
        btn.dataset.tab = name;
        btn.textContent = label;
        btn.addEventListener("click", function () {
            switchTab(name);
        });
        tabs.appendChild(btn);
        return btn;
    }
    makeTab("pages", "残页");
    if (hasEnemies) {
        makeTab("enemies", "敌人");
    }
    if (hasStories) { makeTab("stories", "故事"); }
    head.appendChild(title);
    head.appendChild(tabs);
    head.appendChild(count);
    const storyFilters = document.createElement("div");
    storyFilters.className = "codex-story-filters"; storyFilters.hidden = true;
    storyFilters.setAttribute("role", "group"); storyFilters.setAttribute("aria-label", "故事显示范围");
    for (const [value, label] of [["read", "已归档"], ["all", "全部位置"]]) {
        const button = document.createElement("button"); button.type = "button";
        button.id = "story-filter-" + value; button.textContent = label;
        button.dataset.filter = value; button.setAttribute("aria-pressed", String(value === storyFilter));
        button.addEventListener("click", function () {
            if (storyFilter === value) { return; }
            storyFilter = value;
            for (const option of storyFilters.children) {
                option.setAttribute("aria-pressed", String(option.dataset.filter === value));
            }
            scroll.replaceChildren(); scroll.scrollTop = 0;
            buildStories();
        });
        storyFilters.appendChild(button);
    }
    head.appendChild(storyFilters);
    overlay.appendChild(head);
    overlay.appendChild(scroll);
    overlay.appendChild(detail);

    // --- pages grid (T13, unchanged shape) -----------------------------------
    function buildPages() {
        detail.textContent = "点击一页来阅读";
        sections.forEach(function (section) {
            const head4 = document.createElement("h4");
            head4.className = "codex-section";
            head4.textContent = section.title;
            scroll.appendChild(head4);

            const grid = document.createElement("div");
            grid.className = "codex-grid";
            section.entries.forEach(function (entry) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "codex-entry" + (entry.collected ? "" : " locked");
                btn.dataset.pageId = String(entry.id);
                btn.dataset.collected = entry.collected ? "1" : "0";

                const img = document.createElement("img");
                img.src = BUST_BASE + entry.id + ".webp";
                img.alt = entry.collected ? entry.work : "？？？";
                img.loading = "lazy";
                btn.appendChild(img);

                const name = document.createElement("span");
                name.className = "codex-name";
                name.textContent = entry.collected ? entry.work : "？？？";
                btn.appendChild(name);

                btn.addEventListener("click", function () {
                    showPageDetail(entry);
                });
                grid.appendChild(btn);
            });
            scroll.appendChild(grid);
        });
    }

    function showPageDetail(entry) {
        detail.textContent = "";
        if (!entry.collected) {
            detail.textContent = "这一页还没有被救回";
            return;
        }
        const who = document.createElement("strong");
        who.textContent = "〈" + entry.work + "〉 " + entry.hero;
        const text = document.createElement("p");
        text.textContent = entry.text;
        detail.appendChild(who);
        detail.appendChild(text);
    }

    // --- enemies grid (T22f) --------------------------------------------------
    function buildEnemies() {
        detail.textContent = "点击一个条目查看详情";
        enemySections.forEach(function (section) {
            const head4 = document.createElement("h4");
            head4.className = "codex-section";
            head4.textContent = section.title;
            scroll.appendChild(head4);

            const grid = document.createElement("div");
            grid.className = "codex-grid";
            section.entries.forEach(function (entry) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "codex-entry"
                    + (entry.encountered ? "" : " locked");
                btn.dataset.enemyId = String(entry.id);
                btn.dataset.encountered = entry.encountered ? "1" : "0";

                const art = document.createElement("div");
                art.className = "codex-art";
                if (entry.encountered && entry.model) {
                    art.dataset.thumb = entry.model;
                } else {
                    art.textContent = "？";
                }
                btn.appendChild(art);

                const name = document.createElement("span");
                name.className = "codex-name";
                name.textContent = entry.encountered ? entry.nameZh : "？？？";
                btn.appendChild(name);

                btn.addEventListener("click", function () {
                    showEnemyDetail(entry);
                });
                grid.appendChild(btn);
            });
            scroll.appendChild(grid);
        });
        watchThumbs();
    }

    // Lazy 立绘: render the model snapshot when its card scrolls into view.
    // One observer per build; entries already rendered (cached src) are left
    // alone so tab ping-pong does not re-parse the GLB.
    function watchThumbs() {
        if (observer) {
            observer.disconnect();
        }
        observer = new IntersectionObserver(function (records) {
            records.forEach(function (record) {
                if (!record.isIntersecting) {
                    return;
                }
                const art = record.target;
                observer.unobserve(art);
                renderEnemyThumb(art.dataset.thumb).then(function (url) {
                    if (url) {
                        art.style.backgroundImage = "url(" + url + ")";
                    }
                });
            });
        }, { root: scroll });
        scroll.querySelectorAll(".codex-art[data-thumb]").forEach(function (art) {
            observer.observe(art);
        });
    }

    function showEnemyDetail(entry) {
        detail.textContent = "";
        if (!entry.encountered) {
            detail.textContent = "还没有遭遇过这个敌人";
            return;
        }
        const who = document.createElement("strong");
        who.textContent = entry.nameZh + "　" + entry.name;
        const line1 = document.createElement("p");
        const el = document.createElement("span");
        el.className = "codex-el el-" + entry.element;
        el.textContent = ELEMENT_CHAR[entry.element] || "？";
        line1.appendChild(el);
        line1.appendChild(document.createTextNode(
            " " + (ROLE_LABEL[entry.role] || entry.role)
            + " · Lv " + entry.level + " 时"));
        const line2 = document.createElement("p");
        line2.textContent = "HP " + entry.hp + " · 攻 " + entry.atk
            + " · 防 " + entry.def;
        const line3 = document.createElement("p");
        line3.textContent = "击杀奖励：コイン +" + entry.coin
            + " · 经验 +" + entry.exp;
        detail.appendChild(who);
        detail.appendChild(line1);
        detail.appendChild(line2);
        detail.appendChild(line3);
    }

    // Story replay is local text only. There is deliberately no gameplay or
    // persistence callback here, including on next/back/repeat/close.
    function buildStories() {
        detail.textContent = "选择已归档故事回看。回看不发放任何奖励。";
        let visible = 0;
        for (const section of storySections) {
            const entries = section.entries.filter(entry => storyFilter === "all" || entry.unlocked);
            if (!entries.length) { continue; }
            visible += entries.length;
            const heading = document.createElement("h4");
            heading.className = "codex-section"; heading.textContent = section.title;
            const grid = document.createElement("div"); grid.className = "codex-grid";
            for (const entry of entries) {
                const button = document.createElement("button"); button.type = "button";
                button.className = "codex-entry story-record" + (entry.unlocked ? "" : " locked");
                button.dataset.storyId = entry.id; button.dataset.unlocked = String(entry.unlocked);
                button.textContent = entry.title;
                button.addEventListener("click", function () { showStory(entry); });
                grid.appendChild(button);
            }
            scroll.append(heading, grid);
        }
        if (!visible) {
            const empty = document.createElement("p"); empty.className = "story-empty";
            empty.textContent = "还没有已归档的故事。在冒险中读完或明确跳过后，就可以在这里回看。";
            scroll.appendChild(empty);
        }
    }

    function showStory(entry) {
        detail.replaceChildren();
        if (!entry.unlocked || !entry.lines.length) {
            detail.textContent = entry.hint + "。未归档内容暂不可回看。";
            return;
        }
        let index = 0;
        const heading = document.createElement("strong"); heading.textContent = entry.title;
        const who = document.createElement("strong");
        const text = document.createElement("p"); text.className = "story-line";
        const controls = document.createElement("div"); controls.className = "story-controls";
        const previous = document.createElement("button"); previous.type = "button"; previous.textContent = "上一句";
        const position = document.createElement("span"); position.className = "story-position";
        const next = document.createElement("button"); next.type = "button"; next.textContent = "下一句";
        const note = document.createElement("p"); note.className = "story-note"; note.textContent = "只读回看 · 不消耗补给，不重复领奖";
        function render() {
            who.textContent = entry.lines[index].who;
            text.textContent = entry.lines[index].text;
            position.textContent = (index + 1) + " / " + entry.lines.length;
            previous.disabled = index === 0;
            next.textContent = index === entry.lines.length - 1 ? "从头回看" : "下一句";
        }
        previous.addEventListener("click", function () { index = Math.max(0, index - 1); render(); });
        next.addEventListener("click", function () { index = (index + 1) % entry.lines.length; render(); });
        controls.append(previous, position, next);
        detail.append(heading, who, text, controls, note); render();
    }

    // --- tab switching ---------------------------------------------------------
    function recount() {
        if (tab === "pages") {
            collectedCount = sections.reduce(function (n, s) {
                return n + s.entries.filter(function (e) { return e.collected; }).length;
            }, 0);
            totalCount = sections.reduce(function (n, s) { return n + s.entries.length; }, 0);
        } else if (tab === "stories") {
            collectedCount = storySections.reduce((n, section) => n + section.entries.filter(entry => entry.unlocked).length, 0);
            totalCount = storySections.reduce((n, section) => n + section.entries.length, 0);
        } else {
            collectedCount = enemySections.reduce(function (n, s) {
                return n + s.entries.filter(function (e) { return e.encountered; }).length;
            }, 0);
            totalCount = enemySections.reduce(function (n, s) { return n + s.entries.length; }, 0);
        }
        count.textContent = collectedCount + " / " + totalCount;
    }

    function switchTab(name) {
        if (name === tab || !["pages", "enemies", "stories"].includes(name)
                || (name === "enemies" && !hasEnemies) || (name === "stories" && !hasStories)) {
            return;
        }
        tab = name;
        overlay.dataset.tab = tab;
        storyFilters.hidden = tab !== "stories";
        title.textContent = tab === "stories" ? "故事回看" : tab === "enemies" ? "敌人图鉴" : "残页图鉴";
        if (observer) {
            observer.disconnect();
        }
        scroll.textContent = "";
        scroll.scrollTop = 0;
        Array.prototype.forEach.call(tabs.children, function (btn) {
            btn.classList.toggle("active", btn.dataset.tab === tab);
        });
        if (tab === "pages") {
            buildPages();
        } else if (tab === "stories") {
            buildStories();
        } else {
            buildEnemies();
        }
        recount();
    }

    if (hasEnemies || hasStories) {
        Array.prototype.forEach.call(tabs.children, function (btn) {
            btn.classList.toggle("active", btn.dataset.tab === tab);
        });
    }
    buildPages();
    recount();

    // --- footer --------------------------------------------------------------
    const close = document.createElement("button");
    close.type = "button";
    close.id = "codex-close";
    close.className = "codex-close";
    close.textContent = "关闭";
    overlay.appendChild(close);

    overlay.disposeCodex = function () {
        if (observer) {
            observer.disconnect();
        }
    };

    return overlay;
}

// showCodex({ sections, enemySections, onClose }) → Promise<null>, resolved
// when dismissed. Escape and the close button both work; the caller owns
// freezing.
export function showCodex(options) {
    const opts = options || {};
    return new Promise(function (resolve) {
        const previousFocus = document.activeElement;
        const overlay = createCodexUI(opts);
        let closed = false;

        function close() {
            if (closed) { return; }
            closed = true;
            document.removeEventListener("keydown", onKey);
            if (typeof overlay.disposeCodex === "function") {
                overlay.disposeCodex();
            }
            overlay.remove();
            if (previousFocus?.isConnected) { previousFocus.focus(); }
            resolve(null);
            if (typeof opts.onClose === "function") {
                opts.onClose();
            }
        }
        function onKey(e) {
            if (e.key === "Tab") {
                const buttons = [...overlay.querySelectorAll("button:not(:disabled)")]
                    .filter(button => button.getClientRects().length > 0);
                const index = buttons.indexOf(document.activeElement);
                if (index < 0 || e.shiftKey && index === 0 || !e.shiftKey && index === buttons.length - 1) {
                    e.preventDefault();
                    buttons[e.shiftKey ? buttons.length - 1 : 0]?.focus();
                }
                e.stopPropagation();
            }
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
            }
        }
        document.addEventListener("keydown", onKey);
        overlay.querySelector("#codex-close").addEventListener("click", close);
        document.body.appendChild(overlay);
        overlay.querySelector(".codex-tab")?.focus();
    });
}
