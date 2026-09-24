// 成就 (plan 阶段 8「菜单、教学、成就」): the achievement table + evaluator.
//
// Pure data + one function, no DOM and no imports — the browser gate imports
// the same module in node and asserts unlock scenarios against it, so the
// expectations are hardcoded here and never read back from the UI.
//
// check(state) receives meta.state (the merged save shape from meta.js) and
// answers "is this earned now?". evaluateAchievements(meta) runs every check,
// persists the fresh ones through meta.unlockAchievements — one batch storage
// transaction per sweep, so the terminal gate's single-commit contract holds —
// and returns the newly earned entries so the caller toasts exactly once per
// achievement. meta.unlockAchievement stays as the per-row fallback for node
// fixtures without the batched API.
//
// The list only uses counters that real systems already write: volumes
// (clearVolume), pages (collectPage), enemies (encounterEnemies), gems
// (settle). Level/limit-break achievements wait until the 练级 UI exists —
// meta.train/limitBreak have no callers yet, so an entry keyed on them could
// never unlock and would read as a broken counter.

export const ACHIEVEMENTS = [
    { id: "v1", name: "潮声重现", desc: "完成第 1 卷",
      check: function (s) { return s.volumes >= 1; } },
    { id: "v2", name: "沙丘食约", desc: "完成第 2 卷",
      check: function (s) { return s.volumes >= 2; } },
    { id: "v3", name: "森林回声", desc: "完成第 3 卷",
      check: function (s) { return s.volumes >= 3; } },
    { id: "v4", name: "灯火之城", desc: "完成第 4 卷",
      check: function (s) { return s.volumes >= 4; } },
    { id: "v5", name: "第一百个故事", desc: "完成第 5 卷",
      check: function (s) { return s.volumes >= 5; } },

    { id: "page_1", name: "拾回第一页", desc: "救回 1 张残页",
      check: function (s) { return s.pages.length >= 1; } },
    { id: "page_7", name: "一卷份的约定", desc: "救回 7 张残页",
      check: function (s) { return s.pages.length >= 7; } },
    { id: "page_21", name: "过半之约", desc: "救回 21 张残页",
      check: function (s) { return s.pages.length >= 21; } },
    { id: "page_35", name: "收官前夜", desc: "救回 35 张残页",
      check: function (s) { return s.pages.length >= 35; } },
    { id: "page_37", name: "全数归架", desc: "救回全部 37 张残页",
      check: function (s) { return s.pages.length >= 37; } },

    { id: "enemy_10", name: "初次照面", desc: "遭遇 10 种敌人",
      check: function (s) { return s.enemies.length >= 10; } },
    { id: "enemy_30", name: "面识渐广", desc: "遭遇 30 种敌人",
      check: function (s) { return s.enemies.length >= 30; } },
    { id: "enemy_60", name: "墨影名鉴", desc: "遭遇 60 种敌人",
      check: function (s) { return s.enemies.length >= 60; } },

    { id: "gems_100", name: "小有积蓄", desc: "累计持有 100 星彩石",
      check: function (s) { return s.gems >= 100; } },
    { id: "gems_1000", name: "星彩石大亨", desc: "累计持有 1000 星彩石",
      check: function (s) { return s.gems >= 1000; } }
];

// evaluateAchievements(meta) → newly earned entries (and only those). The
// check runs first (a pure read against meta.state, fresh = not yet owned AND
// passing) and only a passing check persists — through meta.unlockAchievements
// as ONE storage transaction so a whole sweep toasts N rows but writes once
// (the terminal gate counts commits during the victory window, so per-row
// writes would break its single-transaction contract). The batched API is
// idempotent, so the second evaluate returns an empty list and the caller
// toasts exactly once. meta.unlockAchievement is kept as the fallback for
// node fixtures without the batched API.
export function evaluateAchievements(meta) {
    if (!meta || !meta.state) {
        return [];
    }
    const state = meta.state;
    const owned = new Set((state.achievements || []).map(function (a) { return String(a); }));
    const fresh = ACHIEVEMENTS.filter(function (entry) {
        return !owned.has(String(entry.id)) && entry.check(state);
    });
    if (fresh.length) {
        if (typeof meta.unlockAchievements === "function") {
            meta.unlockAchievements(fresh.map(function (entry) { return entry.id; }));
        } else {
            fresh.forEach(function (entry) { meta.unlockAchievement(entry.id); });
        }
    }
    return fresh;
}
