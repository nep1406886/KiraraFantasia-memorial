// Cross-run progression (T11, plan 阶段 5; rules in 游玩说明 §六).
//
//   createMeta(save) → meta
//     meta.unlock(charaId) → bool        // true when newly added
//     meta.clearVolume(n) → charaId[]    // the newly unlocked cameos
//     meta.collectPage(pageId) → bool
//     meta.encounterEnemies(ids) → number  // T22f: new faces recorded
//     pagesForVolume(n) → pageId[]       // 残页 in-run drop order (阶段 5)
//     meta.settle({ items }) → { gems, unlocked }     // death settlement (星彩石)
//     meta.progression → { volumes, chars, pages }
//     meta.levelOf(charaId) → number; meta.train(charaId, targetLv)
//     meta.limitBreak(charaId) → count
//     meta.read()/meta.write()           // load/merge, persist via save
//     meta.unlockAchievement(id) → bool  // 成就: true on first unlock
//     meta.seenTutorial()/markTutorialSeen()  // 教学 one-shot flag
//
// 解锁表逐卷对账自 spec/05 §3 客串名单（减去已在首发的），修正后是
// 6/7/7/4/3（spec/05 §4「可玩性分批」2026-09-03 追记）：12 首发 +
// 27 卷解锁 + うつつ = 40。卡 id 即 CharacterList 的 m_CharaID
// （spec/04 §1），与 cards.js 同源。
//
// 死亡结算（游玩说明 §四）：死亡不是 Game Over——本局拾取物按
// SETTLE_RATIO 换算成星彩石（原作货币，跨局成长资源），练级与限界突破花星彩石。

import * as save from "./save.js";
import { PLAYABLE_IDS } from "./rosterids.js";
import { isStoryId } from "./story.js";

const FIRST_12 = [
    10000000,   // ゆの
    18000000,   // やすな
    14000000,   // カレン
    30001000,   // ココア
    23001000,   // リン
    15000000,   // 青葉
    35001000,   // 優子
    11010000,   // 唯（ゆゆ式）
    38001000,   // みら
    24001000,   // 薫子
    20000000,   // 苺香
    32002000    // きらら
];

const VOLUME_UNLOCKS = {
    1: [29001000, 47002000, 28001000, 31001000, 21000000, 19000000],
    2: [37002000, 34001000, 39001000, 25021000, 26000000, 36001000, 14010000],
    3: [12000000, 27001000, 41001000, 43001000, 42001000, 33011000, 17000000],
    4: [16000000, 45002000, 40002000, 13000000],
    5: [46002000, 22000000, 23011000]
};

const UTSUTSU = 32172000;

// 残页 drop order per volume (spec/05 §5 图鉴). A floor guard (floors 1-19)
// rescues pages[(floor-1) % 7] — one per floor, the tail of 19 floors mostly
// re-offers pages an earlier floor already took; the volume boss (floor 20)
// sweeps whatever is still missing. 7×5 = 35, plus vol5's finale rescues the
// two strays (きらら、優子) and the みら page = 37 — exactly the keys of
// asset/rl/dialogue/pages.js (asserted by rl_dialogue_harness).
const VOLUME_PAGES = {
    1: [29001000, 47002000, 28001000, 31001000, 21000000, 11010000, 19000000],
    2: [37002000, 34001000, 39001000, 25021000, 26000000, 36001000, 14010000],
    3: [12000000, 27001000, 41001000, 43001000, 42001000, 33011000, 17000000],
    4: [15000000, 16000000, 45002000, 20000000, 24001000, 40002000, 13000000],
    5: [46002000, 22000000, 30001000, 18000000, 10000000, 23001000, 14010000]
};
// The finale strays: きらら's own page, 優子, みら — collected at vol5's
// finale_end, not on any floor.
export const FINALE_PAGES = [32002000, 35001000, 38001000];

// pagesForVolume(n) — the in-run drop order, so main.js never hardcodes ids.
export function pagesForVolume(n) {
    return (VOLUME_PAGES[Number(n)] || []).slice();
}

const ROSTER_ALL = new Set(FIRST_12.concat([UTSUTSU],
    VOLUME_UNLOCKS[1], VOLUME_UNLOCKS[2], VOLUME_UNLOCKS[3],
    VOLUME_UNLOCKS[4], VOLUME_UNLOCKS[5], PLAYABLE_IDS));
// T22l 选人扩容 (user feedback 12③: 可选的角色数量有点少): the authored 40
// are selectable from a fresh save. The volume-clear unlock beats stay wired
// but can only ever re-confirm — unlock() refuses ids already owned, so
// clearVolume returns an empty fresh list and main.js's「新同伴入队」beat
// simply doesn't fire. Old saves merge (union) into the full roster too.
const ALL_ROSTER_IDS = Array.from(ROSTER_ALL);
// Base cap 80 is the evolved ★5 rows' own initLimitLv (cards-rl.json — the
// roster cards are the evolved forms, initLv 70 / initLimitLv 80); LB adds
// 5 × 4 on top, and the growth truth table covers exactly Lv1–100.
const BASE_LEVEL_CAP = 80;
const MAX_LEVEL = 100;
const MAX_LB = 4;
const LB_LEVEL_BONUS = 5;

// Authored economy (游玩说明 §六「按比例换算」的比值与单价，此处定案)：
// 拾取装备按稀有度折价，死亡结算带不回 SETTLE_RATIO 份。练一级的星彩石
// 价 = TRAIN_BASE + 2×等级（近线性——指数曲线 1.12^99 会让满级一只角色
// 要 ~15 万星彩石、上千局，不可玩；近线性全满 ~12900，约 70–250 局），
// 限界突破一口价。星彩石是原作两种货币之一（spec/04 §10；原作内部名
// GEM，报错枚举 GEM_IS_SHORT「星彩石が不足しています」），本作作跨局
// 成长货币，与局内 コイン 分工。
export const SETTLE_RATIO = 0.3;
const RARITY_VALUE = { common: 1, rare: 5, epic: 20, legendary: 60 };
const TRAIN_BASE_COST = 10;
const LB_COST = 500;

const SAVE_SLOT = "meta";

function defaults() {
    return {
        // T22l: the full authored 40 from the start (was FIRST_12).
        chars: ALL_ROSTER_IDS.slice(),
        levels: {},
        lb: {},
        pages: [],
        enemies: [],
        volumes: 0,
        gems: 0,
        prologueSeen: false,
        // 菜单/教学/成就 (plan 阶段 8): unlocked achievement ids (strings —
        // same reason pages are) and the one-shot first-run tutorial flag.
        achievements: [],
        tutorialSeen: false,
        storySeen: []
    };
}

// read(raw|null) → merged state
//   Missing fields fall back to defaults (旧存档兼容)；unknown fields are
//   kept — forward compatibility, not silently dropped progress.
export function mergeState(raw) {
    const base = defaults();
    if (!raw || typeof raw !== "object") {
        return base;
    }
    if (Array.isArray(raw.chars)) {
        base.chars = Array.from(new Set(base.chars.concat(raw.chars)));
    }
    if (raw.levels && typeof raw.levels === "object") {
        Object.keys(raw.levels).forEach(function (id) {
            const lv = Number(raw.levels[id]);
            if (lv >= 1 && lv <= MAX_LEVEL) { base.levels[id] = lv; }
        });
    }
    if (raw.lb && typeof raw.lb === "object") {
        Object.keys(raw.lb).forEach(function (id) {
            const n = Number(raw.lb[id]);
            if (n >= 0 && n <= MAX_LB) { base.lb[id] = n; }
        });
    }
    if (Array.isArray(raw.pages)) {
        base.pages = Array.from(new Set(raw.pages));
    }
    // T22f 敌人图鉴: encountered enemy ids, stored as strings for the same
    // reason pages are (see collectPage).
    if (Array.isArray(raw.enemies)) {
        base.enemies = Array.from(new Set(raw.enemies.map(String)));
    }
    if (Number(raw.volumes) >= 0 && Number(raw.volumes) <= 5) {
        base.volumes = Number(raw.volumes);
    }
    if (Number(raw.gems) >= 0) {
        base.gems = Math.floor(Number(raw.gems));
    } else if (Number(raw.shards) >= 0) {
        // pre-rename save slot (残片 era) carries over 1:1
        base.gems = Math.floor(Number(raw.shards));
    }
    if (typeof raw.prologueSeen === "boolean") {
        base.prologueSeen = raw.prologueSeen;
    }
    if (Array.isArray(raw.achievements)) {
        base.achievements = Array.from(new Set(raw.achievements.map(String)));
    }
    if (typeof raw.tutorialSeen === "boolean") {
        base.tutorialSeen = raw.tutorialSeen;
    }
    if (Array.isArray(raw.storySeen)) {
        base.storySeen = Array.from(new Set(raw.storySeen.filter(isStoryId)));
    }
    return base;
}

function settlementGems(items) {
    const value = items.reduce((total, item) => total + (RARITY_VALUE[item.rarity] || 0), 0);
    return Math.floor(value * SETTLE_RATIO);
}

// Guards rescue one authored page only when the next floor commits. Keeping
// this reducer pure lets failed loading/saving leave progression unchanged.
export function descentReward(raw, { volume, floor }) {
    if (!Number.isInteger(volume) || volume < 1 || volume > 5
            || !Number.isInteger(floor) || floor < 1 || floor >= 20) {
        throw new Error("下潜奖励的卷层无效。");
    }
    const next = mergeState(raw), pages = pagesForVolume(volume);
    const key = String(pages[(floor - 1) % pages.length]);
    const newPages = next.pages.some(id => String(id) === key) ? [] : [key];
    next.pages.push(...newPages);
    return { meta: next, newPages };
}

// Pure terminal reward calculation. Neither the source progress nor storage
// changes until save.completeRun accepts the whole result under its run ID.
// T31: victory and defeat both convert the same equipped loot at SETTLE_RATIO;
// victory additionally grants authored volume/finale progression.
export function terminalReward(raw, { outcome, volume, items }) {
    const next = mergeState(raw), newPages = [];
    let gems = 0;
    if (outcome === "defeat") {
        gems = settlementGems(items);
        next.gems += gems;
    } else if (outcome === "victory" && Number.isInteger(volume) && volume >= 1 && volume <= 5) {
        gems = settlementGems(items);
        next.gems += gems;
        next.volumes = Math.max(next.volumes, volume);
        next.chars = Array.from(new Set(next.chars.concat(VOLUME_UNLOCKS[volume], volume === 5 ? [UTSUTSU] : [])));
        const owned = new Set(next.pages.map(String));
        for (const id of pagesForVolume(volume).concat(volume === 5 ? FINALE_PAGES : [])) {
            const key = String(id);
            if (!owned.has(key)) { owned.add(key); next.pages.push(key); newPages.push(key); }
        }
    } else { throw new Error("终局结果无效。"); }
    return { meta: next, gems, newPages };
}

export function createMeta() {
    let state = defaults();

    function write() {
        // Collection and progression already happened in the world. Retain
        // these facts on failure; train/limitBreak below stay commit-first.
        save.write(SAVE_SLOT, state, { defer: true });
    }

    return {
        // read() — load from the save slot, merging with defaults. A
        // corrupted slot reads as absent (save.load returns null) and the
        // game starts fresh instead of white-screening.
        read: function () {
            state = mergeState(save.load(SAVE_SLOT));
            return state;
        },

        get state() { return state; },
        seenStory: function (id) { return state.storySeen.includes(id); },
        markStorySeen: function (id) {
            if (!isStoryId(id) || state.storySeen.includes(id)) { return false; }
            state.storySeen.push(id);
            write();
            return true;
        },
        get progression() {
            return {
                volumes: state.volumes,
                chars: state.chars.slice(),
                pages: state.pages.slice(),
                enemies: state.enemies.slice()
            };
        },

        unlock: function (charaId) {
            const id = Number(charaId);
            // Only the authored 40 (spec/05 §4) can ever join; anything else
            // — typos, corrupted saves, injected ids — is refused here.
            if (!ROSTER_ALL.has(id) || state.chars.indexOf(id) >= 0) {
                return false;
            }
            state.chars.push(id);
            write();
            return true;
        },

        // clearVolume(n) — unlocking IS the volume-clear reward (游玩说明
        // §六.2). Returns the newly unlocked ids; うつつ rides on volume 5.
        clearVolume: function (n) {
            const volume = Number(n);
            if (volume < 1 || volume > 5) { return []; }
            const fresh = [];
            (VOLUME_UNLOCKS[volume] || []).forEach(function (id) {
                if (this.unlock(id)) { fresh.push(id); }
            }, this);
            if (volume === 5 && this.unlock(UTSUTSU)) {
                fresh.push(UTSUTSU);
            }
            if (volume > state.volumes) {
                state.volumes = volume;
            }
            write();
            return fresh;
        },

        collectPage: function (pageId) {
            // pages.js keys its 图鉴 entries by String(cardId); storing the
            // same shape keeps a numeric caller from double-collecting a page
            // a string caller already took.
            const key = String(pageId);
            if (state.pages.some(function (p) { return String(p) === key; })) {
                return false;
            }
            state.pages.push(key);
            write();
            return true;
        },

        // encounterEnemies(ids) — T22f 敌人图鉴: record the room's roster as
        // seen. Batched (one write per room, not one per enemy) and idempotent;
        // returns the number of genuinely new faces.
        encounterEnemies: function (ids) {
            let fresh = 0;
            (ids || []).forEach(function (id) {
                const key = String(id);
                if (state.enemies.indexOf(key) === -1) {
                    state.enemies.push(key);
                    fresh += 1;
                }
            });
            if (fresh) {
                write();
            }
            return fresh;
        },

        // settle({ items }) — the death-settlement conversion. items are
        // loot.js Items; unknown rarities count as 0 (no invented value).
        // Returns what the player gained and who it newly unlocked.
        settle: function (run) {
            const items = (run && run.items) || [];
            const gems = settlementGems(items);
            state.gems += gems;
            write();
            return { gems: gems, unlocked: (run && run.unlocked) || [] };
        },

        settleRun: function (runId, facts) {
            const result = save.completeRun(runId, facts, terminalReward);
            // Accepted terminal facts remain in-page on quota failure; rejected
            // stale requests must never advance this instance's progression.
            if (result.meta) { state = mergeState(result.meta); }
            return result;
        },

        descendRun: function (runId, checkpoint) {
            const result = save.advanceFloor(runId, checkpoint, descentReward);
            if (result.ok) { state = mergeState(result.meta); }
            return result;
        },

        gems: function () { return state.gems; },

        // T12: the prologue plays once per save (spec/05 §5 序章), not once
        // per boot — veterans of run two skip straight to the roster.
        seenPrologue: function () { return !!state.prologueSeen; },
        markPrologueSeen: function () {
            state.prologueSeen = true;
            write();
        },

        // 成就 (plan 阶段 8): unlockAchievement(id) is idempotent — true only
        // on the first unlock, so the caller toasts exactly once. Ids are
        // strings for the same reason pages are.
        unlockAchievement: function (id) {
            const key = String(id);
            if (state.achievements.some(function (a) { return String(a) === key; })) {
                return false;
            }
            state.achievements.push(key);
            write();
            return true;
        },

        // 教学: the guided first-run walkthrough plays once per save, like
        // the prologue.
        seenTutorial: function () { return !!state.tutorialSeen; },
        markTutorialSeen: function () {
            state.tutorialSeen = true;
            write();
        },

        levelOf: function (charaId) {
            return state.levels[charaId] || 1;
        },

        levelCap: function (charaId) {
            return Math.min(MAX_LEVEL,
                BASE_LEVEL_CAP + (state.lb[charaId] || 0) * LB_LEVEL_BONUS);
        },

        trainingQuote: function (charaId, targetLv) {
            const id = Number(charaId);
            const from = this.levelOf(id);
            const cap = this.levelCap(id);
            if (!Number.isInteger(id) || state.chars.indexOf(id) < 0
                    || !Number.isInteger(targetLv) || targetLv < 1) {
                return { cost: 0, level: from, cap: cap, reason: "invalid" };
            }
            const to = Math.min(Number(targetLv), cap, MAX_LEVEL);
            if (to <= from) {
                return { cost: 0, level: from, cap: cap, reason: to < targetLv ? "cap" : "noop" };
            }
            let cost = 0;
            for (let lv = from; lv < to; lv++) {
                cost += TRAIN_BASE_COST + 2 * lv;
            }
            return { cost: cost, level: to, cap: cap, reason: state.gems < cost ? "poor" : null };
        },

        // Quotes are read-only; execution always checks current balance again.
        train: function (charaId, targetLv) {
            const quote = this.trainingQuote(charaId, targetLv);
            if (quote.reason) {
                return { spent: 0, level: this.levelOf(charaId), reason: quote.reason };
            }
            const candidate = { ...state, gems: state.gems - quote.cost,
                levels: { ...state.levels, [Number(charaId)]: quote.level } };
            if (!save.write(SAVE_SLOT, candidate)) {
                return { spent: 0, level: this.levelOf(charaId), reason: "storage" };
            }
            state = candidate;
            return { spent: quote.cost, level: quote.level };
        },

        limitBreakQuote: function (charaId) {
            const id = Number(charaId);
            const done = state.lb[id] || 0;
            const reason = !Number.isInteger(id) || state.chars.indexOf(id) < 0 ? "invalid"
                : done >= MAX_LB ? "max" : state.gems < LB_COST ? "poor" : null;
            return { cost: done >= MAX_LB ? 0 : LB_COST, lb: done, reason: reason };
        },

        limitBreak: function (charaId) {
            const quote = this.limitBreakQuote(charaId);
            if (quote.reason) {
                return { spent: 0, lb: quote.lb, reason: quote.reason };
            }
            const candidate = { ...state, gems: state.gems - quote.cost,
                lb: { ...state.lb, [Number(charaId)]: quote.lb + 1 } };
            if (!save.write(SAVE_SLOT, candidate)) {
                return { spent: 0, lb: quote.lb, reason: "storage" };
            }
            state = candidate;
            return { spent: quote.cost, lb: quote.lb + 1 };
        }
    };
}
