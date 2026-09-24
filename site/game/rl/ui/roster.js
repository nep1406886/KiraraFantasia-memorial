// Character roster selection UI
// Task 3.1: 40 playable characters; restyled 2026-09-04 (T21a) to spec/01:
// the tokens come from rl/ui/theme.css, the panels are the original's rounded
// paper cards (never dark glass), and each character shows her real 卡面
// (asset/img/rl/card/<charaId>.webp, 750×1000, spec/01 §6.1 "它是门面，不裁")
// instead of the old grey model-key placeholder.
//
// The styles are a scoped <style> block appended with the overlay (not inline
// cssText) because hover/focus-visible/:active cannot be expressed inline, and
// spec/01 §4.1 requires all four states on every clickable element.

import { showCharacterCard } from "./infocard.js";

// Module-relative (this file lives at game/rl/ui/): a page-relative "../.."
// would escape a /kirafan-timer/ deployment subpath.
const CARD_ART_BASE = new URL("../../../asset/img/rl/card/", import.meta.url).href;

// spec/01 §2: element colours are tokens, and an element never dyes a whole
// component — here it is one small dot beside the name.
// Data ring (T22i bake, proven against skill details): 0=炎 1=水 2=土
// 3=風 4=月 5=陽. The old map was shifted one (1:fire…) and painted every
// dot but 風 the wrong colour.
const ELEMENT_VAR = { 0: "var(--el-fire)", 1: "var(--el-water)", 2: "var(--el-earth)",
                      3: "var(--el-wind)", 4: "var(--el-moon)", 5: "var(--el-sun)" };

const ROSTER_CSS = `
    .rl-roster * { box-sizing: border-box; }
    .rl-roster {
        position: fixed;
        inset: 0;
        z-index: 1000;
        overflow-y: auto;
        background: var(--kf-sky);
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: clamp(16px, 4vmin, 40px) 1rem 2rem;
        font-family: var(--font-sans);
        color: var(--kf-ink);
    }
    .rl-roster h2 {
        margin: 0 0 clamp(12px, 3vmin, 24px);
        font-family: var(--font-serif);
        font-size: clamp(1.5rem, 4vw, 2.4rem);
        font-weight: 700;
        letter-spacing: 0.04em;
        color: var(--kf-ink);
        text-align: center;
    }
    .rl-roster-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(168px, 100%), 1fr));
        gap: clamp(10px, 2vmin, 18px);
        width: 100%;
        max-width: 1160px;
        margin-bottom: clamp(16px, 3vmin, 28px);
    }
    .rl-roster-card {
        position: relative;
        background: var(--kf-paper);
        border: 1.5px solid var(--kf-ink-soft);
        border-radius: 14px;
        padding: 10px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        box-shadow: 0 2px 0 var(--kf-shadow);
        transition: transform 0.18s ease-out, box-shadow 0.18s ease-out,
                    border-color 0.18s ease-out;
    }
    .rl-roster-card:hover, .rl-roster-card:focus-visible {
        transform: translateY(-3px);
        border-color: var(--kf-gold);
        box-shadow: 0 6px 18px var(--kf-shadow);
        outline: none;
    }
    .rl-roster-card:focus-visible {
        outline: 2px solid var(--kf-gold);
        outline-offset: 2px;
    }
    .rl-roster-card:active { transform: translateY(-1px); }
    .rl-roster-card .art {
        width: 100%;
        aspect-ratio: 3 / 4;
        border-radius: 9px;
        background: var(--kf-mint);
        object-fit: cover;
        display: block;
    }
    .rl-roster-card .art.missing {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--kf-ink-soft);
        font-size: 0.85rem;
        text-align: center;
        padding: 0.5rem;
    }
    .rl-roster-card .rarity {
        position: absolute;
        top: 7px;
        left: 7px;
        color: var(--kf-gold);
        font-size: 0.8rem;
        line-height: 1;
        letter-spacing: 1px;
        text-shadow: 0 1px 0 var(--kf-paper);
    }
    /* spec/01 §4.2: 四芒星点缀每个面板至多一处 — the 5★ corner star. */
    .rl-roster-card .star5 {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 18px;
        height: 18px;
        pointer-events: none;
    }
    .rl-roster-card .who {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.95rem;
        font-weight: 600;
        color: var(--kf-ink);
        text-align: center;
        word-break: break-word;
    }
    .rl-roster-card .who .el {
        flex: none;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        border: 1px solid var(--kf-ink-soft);
    }
    .rl-roster-card .stats {
        font-size: 0.72rem;
        color: var(--kf-ink-soft);
        text-align: center;
        width: 100%;
        font-variant-numeric: tabular-nums;
    }
    .rl-roster-card .stats .row {
        display: flex;
        justify-content: space-between;
        margin-bottom: 2px;
    }
    .rl-roster-card .rl-roster-info {
        font: inherit;
        font-size: 0.78rem;
        font-weight: 600;
        padding: 4px 16px;
        background: var(--kf-paper);
        color: var(--kf-ink);
        border: 1.5px solid var(--kf-ink-soft);
        border-radius: 999px;
        cursor: pointer;
        transition: border-color 0.18s ease-out;
    }
    .rl-roster-card .rl-roster-info:hover,
    .rl-roster-card .rl-roster-info:focus-visible {
        border-color: var(--kf-gold);
        outline: none;
    }
    .rl-roster-card .rl-roster-info:focus-visible {
        outline: 2px solid var(--kf-gold);
        outline-offset: 2px;
    }
    .rl-roster-actions {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 10px;
    }
    .rl-roster-actions button {
        font: inherit;
        font-weight: 600;
        padding: 0.7rem 1.8rem;
        background: var(--kf-paper);
        color: var(--kf-ink);
        border: 1.5px solid var(--kf-ink-soft);
        border-radius: 999px;
        cursor: pointer;
        box-shadow: 0 2px 0 var(--kf-shadow);
        transition: background 0.18s ease-out, border-color 0.18s ease-out,
                    transform 0.18s ease-out;
    }
    .rl-roster-actions button:hover, .rl-roster-actions button:focus-visible {
        border-color: var(--kf-gold);
        outline: none;
    }
    .rl-roster-actions button:focus-visible {
        outline: 2px solid var(--kf-gold);
        outline-offset: 2px;
    }
    .rl-roster-actions button:active { transform: translateY(1px); }
    @media (prefers-reduced-motion: reduce) {
        .rl-roster-card, .rl-roster-actions button { transition: none; }
        .rl-roster-card:hover, .rl-roster-card:focus-visible { transform: none; }
    }
`;

// spec/01 §4.2: the four-point star, gold stroke — inline SVG so it needs no
// asset and inherits nothing from the page.
const STAR5_SVG = '<svg class="star5" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M12 1 L14.2 9.8 L23 12 L14.2 14.2 L12 23 L9.8 14.2 L1 12 L9.8 9.8 Z" '
    + 'fill="var(--kf-paper)" stroke="var(--kf-gold)" stroke-width="1.6" '
    + 'stroke-linejoin="round"/></svg>';

function injectRosterStyles() {
    if (document.getElementById("rl-roster-style")) {
        return;
    }
    const style = document.createElement("style");
    style.id = "rl-roster-style";
    style.textContent = ROSTER_CSS;
    document.head.appendChild(style);
}

/**
 * Create the roster UI overlay
 * @param {Object} options - Configuration
 * @param {Array} options.cards - Card data from cards-rl.json
 * @param {Function} options.onSelect - Callback when character selected (cardId)
 * @param {Function} options.onCancel - Callback when cancelled
 * @param {Object} options.skillsTable - parsed skills-rl.json, for the 人物卡
 * @returns {HTMLElement} The roster overlay element
 */
export function createRosterUI(options) {
    const { cards, onSelect, onCancel, onCodex, onAchievements, onContinue, onTrain, onStorage, skillsTable } = options;

    // The caller owns the playable roster and unlock filtering. Preserve its
    // order and same-name deduplication without a second, UI-local size cap.
    // Element 0 is 炎, a full member of the data ring (0=炎…5=陽).
    const uniqueChars = new Map();
    for (const card of cards) {
        if (!uniqueChars.has(card.characterZh) && card.element >= 0 && card.element <= 5) {
            uniqueChars.set(card.characterZh, card);
        }
    }
    const roster = Array.from(uniqueChars.values());

    injectRosterStyles();

    // Create overlay container
    const overlay = document.createElement("div");
    overlay.id = "roster-overlay";
    overlay.className = "rl-roster";

    // Header
    const header = document.createElement("h2");
    header.textContent = "选择角色";
    overlay.appendChild(header);

    // Grid container
    const grid = document.createElement("div");
    grid.className = "rl-roster-grid";

    // Create character cards
    roster.forEach((card) => {
        const cardEl = createCharacterCard(card, () => {
            if (onSelect) {
                onSelect(card.id);
            }
            document.body.removeChild(overlay);
        });
        // T22i 人物卡: a dedicated 详情 button opens the character sheet
        // (title/profile/skills, with its own 出发). The card body stays a
        // one-click select — the established flow both players and the
        // browser gates drive.
        if (skillsTable) {
            const infoBtn = document.createElement("button");
            infoBtn.className = "rl-roster-info";
            infoBtn.textContent = "详情";
            infoBtn.setAttribute("aria-label", "查看" + (card.characterZh || "") + "的人物卡");
            infoBtn.addEventListener("click", function (event) {
                event.stopPropagation();
                showCharacterCard(card, skillsTable, {
                    artBase: CARD_ART_BASE,
                    onSelect: function (cardId) {
                        if (onSelect) {
                            onSelect(cardId);
                        }
                        document.body.removeChild(overlay);
                    }
                });
            });
            cardEl.appendChild(infoBtn);
        }
        grid.appendChild(cardEl);
    });

    overlay.appendChild(grid);

    const actions = document.createElement("div");
    actions.className = "rl-roster-actions";
    if (onStorage) {
        const storageBtn = document.createElement("button");
        storageBtn.id = "roster-storage";
        storageBtn.textContent = "存档与备份";
        storageBtn.addEventListener("click", onStorage);
        actions.appendChild(storageBtn);
    }
    if (onTrain) {
        const trainBtn = document.createElement("button");
        trainBtn.id = "roster-train";
        trainBtn.textContent = "营地培养";
        trainBtn.addEventListener("click", onTrain);
        actions.appendChild(trainBtn);
    }

    // Cancel button
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "取消";
    cancelBtn.addEventListener("click", () => {
        if (onCancel) {
            onCancel();
        }
        document.body.removeChild(overlay);
    });
    actions.appendChild(cancelBtn);

    // 残页図鑑 (T13): the collection is a camp feature, so the roster screen
    // (which IS the camp surface between runs) exposes it pre-run. The roster
    // overlay stays up underneath — the codex stacks on top and dismissing it
    // returns here, so a peek never drops the selection.
    if (onCodex) {
        const codexBtn = document.createElement("button");
        codexBtn.id = "roster-codex";
        codexBtn.textContent = "残页图鉴";
        codexBtn.addEventListener("click", () => {
            onCodex();
        });
        actions.appendChild(codexBtn);
    }

    // 成就 (plan 阶段 8): same camp-peek contract as the codex — the overlay
    // stacks over the roster and dismissing it returns here.
    if (onAchievements) {
        const achvBtn = document.createElement("button");
        achvBtn.id = "roster-achv";
        achvBtn.textContent = "成就";
        achvBtn.addEventListener("click", () => {
            onAchievements();
        });
        actions.appendChild(achvBtn);
    }

    // 局内续档: a saved run in flight resumes from here. The roster overlay
    // comes down with the resume (unlike the codex peek, which stacks), so
    // the button owns its removal — the showRoster promise stays pending,
    // which loadPlayer's caller already tolerates.
    if (onContinue) {
        const continueBtn = document.createElement("button");
        continueBtn.id = "roster-continue";
        continueBtn.textContent = "继续冒险";
        continueBtn.addEventListener("click", () => {
            document.body.removeChild(overlay);
            onContinue();
        });
        actions.appendChild(continueBtn);
    }

    overlay.appendChild(actions);

    return overlay;
}

/**
 * Create a single character card
 */
function createCharacterCard(card, onClick) {
    const cardEl = document.createElement("div");
    cardEl.className = "roster-card rl-roster-card";

    // The rarity readout (spec/01 §4.3) and, on 5★ only, the corner star.
    const rarity = document.createElement("div");
    rarity.className = "rarity";
    rarity.textContent = "★".repeat(Math.max(1, Math.min(5, card.rare || card.rarity || 3)));
    cardEl.appendChild(rarity);
    if ((card.rare || card.rarity || 0) >= 5) {
        cardEl.insertAdjacentHTML("beforeend", STAR5_SVG);
    }

    // 卡面 (spec/01 §6.1): 750×1000 WebP fetched per roster id, never
    // cropped by anything but object-fit, never stretched. A missing file
    // degrades to a mint placeholder with the name — the roster must not
    // depend on the art being on disk to be usable.
    const art = document.createElement("img");
    art.className = "art";
    art.src = CARD_ART_BASE + card.id + ".webp";
    art.alt = "";
    // Eager, not lazy: 40 卡面 are 3.6 MB total, and a lazy image never
    // loads in an occluded tab (no intersection events) — the art is the
    // 门面 and must be there when the screen is.
    art.addEventListener("error", () => {
        const fallback = document.createElement("div");
        fallback.className = "art missing";
        fallback.textContent = card.characterZh || card.name || "";
        cardEl.replaceChild(fallback, art);
    });
    cardEl.appendChild(art);

    // Character name + element dot (one small element accent, spec/01 §2.2)
    const who = document.createElement("div");
    who.className = "who";
    const dot = document.createElement("span");
    dot.className = "el";
    dot.style.background = ELEMENT_VAR[card.element] || "var(--kf-mint)";
    who.appendChild(dot);
    const name = document.createElement("span");
    name.textContent = card.characterZh || card.name;
    who.appendChild(name);
    cardEl.appendChild(who);

    // Stats preview -- only when the truth table actually shipped the row's
    // init block; a card without numbers renders without the block rather
    // than taking the whole roster down.
    if (card.init && card.init.hp !== undefined) {
        const stats = document.createElement("div");
        stats.className = "stats";
        stats.innerHTML = `
            <div class="row"><span>HP ${card.init.hp}</span><span>ATK ${card.init.atk}</span></div>
            <div class="row"><span>DEF ${card.init.def}</span><span>SPD ${card.init.spd}</span></div>
        `;
        cardEl.appendChild(stats);
    }

    // Click handler
    cardEl.addEventListener("click", onClick);

    return cardEl;
}

/**
 * Show the roster selection screen
 * @param {Array} cards - Full cards array from cards-rl.json
 * @returns {Promise<number>} Resolves with selected card ID, rejects on cancel
 */
export function showRoster(cards, options) {
    return new Promise((resolve, reject) => {
        const opts = options || {};
        const overlay = createRosterUI({
            cards: cards,
            onSelect: (cardId) => resolve(cardId),
            onCancel: () => reject(new Error("Roster selection cancelled")),
            onCodex: opts.onCodex || null,
            onAchievements: opts.onAchievements || null,
            onTrain: opts.onTrain || null,
            onStorage: opts.onStorage || null,
            onContinue: opts.onContinue || null,
            skillsTable: opts.skillsTable || null
        });
        document.body.appendChild(overlay);
    });
}
