// Harness for game/rl/achievements.js (plan 阶段 8「菜单、教学、成就」):
// evaluateAchievements(meta) checks each table row as a pure read and persists
// passing ones through meta.unlockAchievement (idempotent).
//
//   node tools/rl_achievements_harness.mjs
//
// The contract is imported by the browser gate too, so the expectations are
// hardcoded here (ids and thresholds from achievements.js) and never read
// back from any UI.

import { ACHIEVEMENTS, evaluateAchievements } from "../site/game/rl/achievements.js";

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

// A fake meta that mirrors meta.js's real achievements contract: ids are
// strings stored on state.achievements, unlockAchievement is idempotent, and
// unlockAchievements batches a whole sweep into one write (returns the count
// of genuinely new ids). Persistence ORDER is the caller's business — the
// harness models the documented contract exactly.
function fakeMeta(state) {
    if (!state.achievements) {
        state.achievements = [];
    }
    function unlock(id) {
        const key = String(id);
        if (state.achievements.indexOf(key) >= 0) {
            return false;
        }
        state.achievements.push(key);
        return true;
    }
    return {
        state: state,
        unlockAchievement: unlock,
        unlockAchievements: function (ids) {
            let fresh = 0;
            (ids || []).forEach(function (id) {
                if (unlock(id)) { fresh += 1; }
            });
            return fresh;
        },
        get unlocked() {
            return state.achievements.slice();
        }
    };
}

function state(volumes, pageCount, enemyCount, gems) {
    const pages = [];
    for (let i = 0; i < pageCount; i++) { pages.push("p" + (i + 1)); }
    const enemies = [];
    for (let i = 0; i < enemyCount; i++) { enemies.push("e" + (i + 1)); }
    return { volumes: volumes, pages: pages, enemies: enemies, gems: gems };
}

function run() {
    // --- 1. a completely empty profile earns nothing ----------------------
    const empty = fakeMeta(state(0, 0, 0, 0));
    const none = evaluateAchievements(empty);
    check("empty profile: no achievements", none.length === 0, JSON.stringify(none));
    check("empty profile: nothing persisted", empty.unlocked.length === 0);

    // --- 2. milestones are inclusive ladders: a profile at 3/21/30/100 ----
    // earns every row whose threshold it clears (v1..v3, page_1/7/21,
    // enemy_10/30, gems_100) in table order.
    const mid = fakeMeta(state(3, 21, 30, 100));
    const fresh = evaluateAchievements(mid);
    check("mid profile: v1-v3, page_1/7/21, enemy_10/30, gems_100 in table order",
        fresh.length === 9
            && fresh[0].id === "v1" && fresh[1].id === "v2" && fresh[2].id === "v3"
            && fresh[3].id === "page_1" && fresh[4].id === "page_7"
            && fresh[5].id === "page_21"
            && fresh[6].id === "enemy_10" && fresh[7].id === "enemy_30"
            && fresh[8].id === "gems_100",
        JSON.stringify(fresh.map(function (e) { return e.id; })));
    // Only a passing check may persist: unlockAchievement must have been
    // called exactly for those nine (no unlocked row failed its check).
    check("mid profile: exactly the passing rows persisted",
        mid.unlocked.length === 9 && mid.unlocked.every(function (id) {
            return fresh.some(function (e) { return e.id === id; });
        }), JSON.stringify(mid.unlocked));

    // --- 3. full sweep hits every tier ------------------------------------
    const full = fakeMeta(state(5, 37, 60, 1000));
    const all = evaluateAchievements(full);
    check("full profile: all 15 rows unlock in table order",
        all.length === ACHIEVEMENTS.length
            && all.every(function (e, i) { return e.id === ACHIEVEMENTS[i].id; }),
        JSON.stringify(all.map(function (e) { return e.id; })));

    // --- 4. idempotency: a second evaluate returns [] ----------------------
    const again = evaluateAchievements(full);
    check("full profile: second evaluate returns nothing new", again.length === 0);
    check("full profile: persisted set unchanged",
        full.unlocked.length === ACHIEVEMENTS.length);

    // --- 5. thresholds are the hardcoded ones ------------------------------
    // 6 pages already clears page_1 (the 1-page floor), but not page_7.
    const edge = fakeMeta(state(0, 6, 9, 99));
    const near = evaluateAchievements(edge);
    check("edge profile (0/6/9/99): only page_1 crosses", near.length === 1
        && near[0].id === "page_1", JSON.stringify(near.map(function (e) { return e.id; })));
    const edge2 = fakeMeta(state(0, 7, 10, 100));
    const crossed = evaluateAchievements(edge2);
    check("edge profile (0/7/10/100): page_1/7, enemy_10, gems_100 in order",
        crossed.length === 4 && crossed[0].id === "page_1"
            && crossed[1].id === "page_7"
            && crossed[2].id === "enemy_10" && crossed[3].id === "gems_100",
        JSON.stringify(crossed.map(function (e) { return e.id; })));

    // --- 6. robustness ------------------------------------------------------
    check("robustness: null meta returns []", evaluateAchievements(null).length === 0);
    check("robustness: meta without state returns []",
        evaluateAchievements({ unlockAchievement: function () { return true; } }).length === 0);
    check("robustness: ids are strings; repeated sweeps stay single-unlock",
        (function () {
            const m = fakeMeta(state(1, 1, 0, 0));
            evaluateAchievements(m);
            evaluateAchievements(m);
            return m.state.achievements.length === 2
                && m.state.achievements[0] === "v1"
                && m.state.achievements[1] === "page_1";
        })());
    // The batched API is the real-meta contract: one union call persists every
    // fresh row, and a second evaluate (pure-owned-first) adds nothing.
    check("robustness: batched unlock persists each fresh row exactly once",
        (function () {
            const m = fakeMeta(state(2, 10, 30, 100));
            const once = evaluateAchievements(m);
            const twice = evaluateAchievements(m);
            // volumes=2 -> v1..v2; pages=10 -> page_1/7; enemies=30 ->
            // enemy_10/30; gems=100 -> gems_100  = 2+2+2+1 = 7 rows.
            return once.length === 7
                && twice.length === 0
                && m.state.achievements.length === 7;
        })());

    return failures;
}

const code = run();
console.log("");
console.log(code === 0 ? "ALL OK" : (code + " FAILURES"));
process.exit(code === 0 ? 0 : 1);