// Harness for the truth-value data pipeline (T01, spec/04 §9).
//
//   node tools/rl_stats_harness.mjs
//
// 1. 30 characters × several levels: statsFor must equal Init × Growth
//    hand-computed from the RAW tables. Expectations are hardcoded here --
//    never read back from the pipeline under test (master plan §六).
//    The set includes the spec's own anchors: ゆの evolved Lv50 HP 1359,
//    Lv80 HP 1980 / Spd 119.8, Lv100 HP 2394.
// 2. All 40 roster members (spec/05 §4) exist in cards-rl.json with the
//    right class -- a missing or mis-typed role would break the unlock flow.
// 3. enemies.json: hardcoded interpolation spot-checks, plus every row's
//    interpolated stats must stay within its own [Init, Max] band and every
//    row must keep max >= init.
// 4. Negative cases: unknown chara/enemy, out-of-range levels clamp.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createStats } from "../site/asset/rl/stats.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

function closeEnough(a, b) {
    return Math.abs(a - b) < 1e-9;
}

const tables = {
    cards: JSON.parse(readFileSync(join(ROOT, "site/asset/rl/cards-rl.json"), "utf8")).cards,
    growth: JSON.parse(readFileSync(join(ROOT, "site/asset/rl/growth.json"), "utf8")),
    enemies: JSON.parse(readFileSync(join(ROOT, "site/asset/rl/enemies.json"), "utf8")).enemies
};
const stats = createStats(tables);

// --- 1. Stat(L) equals Init × Growth[L][gtid] (hand-computed) ----------------
// Computed 2026-09-02 from asset/rl/_raw CharacterList × CharacterParamGrowthList.

const SAMPLES = [
  {id:10002000,levels:[{lv:1,stats:{hp:345,atk:220,mgc:240,def:170,mdef:295,spd:111,luck:31}},{lv:25,stats:{hp:842,atk:431,mgc:470,def:496,mdef:918,spd:113.7,luck:32}},{lv:50,stats:{hp:1359,atk:651,mgc:710,def:836,mdef:1567,spd:116.4,luck:33}}]},
  {id:10000000,levels:[{lv:1,stats:{hp:470,atk:275,mgc:190,def:310,mdef:305,spd:102,luck:31}},{lv:25,stats:{hp:978,atk:539,mgc:372,def:1032,mdef:949,spd:104.4,luck:32}},{lv:50,stats:{hp:1506,atk:814,mgc:562,def:1783,mdef:1620,spd:107.0,luck:33}}]},
  {id:32002000,levels:[{lv:1,stats:{hp:385,atk:190,mgc:190,def:200,mdef:285,spd:112,luck:31}},{lv:25,stats:{hp:939,atk:372,mgc:372,def:584,mdef:887,spd:114.7,luck:32}},{lv:50,stats:{hp:1517,atk:562,mgc:562,def:984,mdef:1514,spd:117.5,luck:33}}]},
  {id:32172000,levels:[{lv:1,stats:{hp:415,atk:220,mgc:310,def:180,mdef:180,spd:102,luck:31}},{lv:25,stats:{hp:883,atk:431,mgc:682,def:487,mdef:599,spd:104.4,luck:32}},{lv:50,stats:{hp:1371,atk:651,mgc:1070,def:806,mdef:1036,spd:107.0,luck:33}}]},
  {id:11010000,levels:[{lv:1,stats:{hp:475,atk:345,mgc:135,def:255,mdef:165,spd:112,luck:31}},{lv:25,stats:{hp:1068,atk:800,mgc:265,def:745,mdef:446,spd:114.7,luck:32}},{lv:50,stats:{hp:1685,atk:1275,mgc:400,def:1255,mdef:739,spd:117.5,luck:33}}]},
  {id:12000000,levels:[{lv:1,stats:{hp:365,atk:150,mgc:310,def:130,mdef:260,spd:92,luck:31}},{lv:25,stats:{hp:821,atk:294,mgc:719,def:352,mdef:759,spd:94.2,luck:32}},{lv:50,stats:{hp:1295,atk:444,mgc:1145,def:582,mdef:1279,spd:96.5,luck:33}}]},
  {id:15000000,levels:[{lv:1,stats:{hp:465,atk:335,mgc:205,def:225,mdef:145,spd:112,luck:31}},{lv:25,stats:{hp:1045,atk:777,mgc:402,def:657,mdef:392,spd:114.7,luck:32}},{lv:50,stats:{hp:1650,atk:1238,mgc:607,def:1107,mdef:649,spd:117.5,luck:33}}]},
  {id:23011000,levels:[{lv:1,stats:{hp:473,atk:405,mgc:140,def:285,mdef:120,spd:114,luck:31}},{lv:25,stats:{hp:1063,atk:940,mgc:274,def:832,mdef:324,spd:116.7,luck:32}},{lv:50,stats:{hp:1678,atk:1496,mgc:414,def:1402,mdef:537,spd:119.6,luck:33}}]},
  {id:26000000,levels:[{lv:1,stats:{hp:480,atk:325,mgc:160,def:290,mdef:285,spd:103,luck:31}},{lv:25,stats:{hp:998,atk:637,mgc:314,def:965,mdef:887,spd:105.5,luck:32}},{lv:50,stats:{hp:1538,atk:962,mgc:474,def:1668,mdef:1514,spd:108.0,luck:33}}]},
  {id:30001000,levels:[{lv:1,stats:{hp:483,atk:395,mgc:200,def:215,mdef:120,spd:115,luck:31}},{lv:25,stats:{hp:1086,atk:916,mgc:392,def:628,mdef:324,spd:117.8,luck:32}},{lv:50,stats:{hp:1714,atk:1460,mgc:592,def:1058,mdef:537,spd:120.6,luck:33}}]},
  {id:37002000,levels:[{lv:1,stats:{hp:425,atk:160,mgc:310,def:190,mdef:240,spd:101,luck:31}},{lv:25,stats:{hp:904,atk:314,mgc:682,def:514,mdef:799,spd:103.4,luck:32}},{lv:50,stats:{hp:1404,atk:474,mgc:1070,def:851,mdef:1381,spd:105.9,luck:33}}]},
  {id:46002000,levels:[{lv:1,stats:{hp:623,atk:310,mgc:180,def:345,mdef:315,spd:107,luck:31}},{lv:25,stats:{hp:1296,atk:608,mgc:353,def:1148,mdef:980,spd:109.6,luck:32}},{lv:50,stats:{hp:1997,atk:918,mgc:533,def:1985,mdef:1673,spd:112.2,luck:33}}]},
  {id:45002000,levels:[{lv:1,stats:{hp:400,atk:140,mgc:370,def:165,mdef:265,spd:96,luck:31}},{lv:25,stats:{hp:899,atk:274,mgc:858,def:446,mdef:774,spd:98.3,luck:32}},{lv:50,stats:{hp:1419,atk:414,mgc:1367,def:739,mdef:1304,spd:100.7,luck:33}}]},
  {id:47002000,levels:[{lv:1,stats:{hp:633,atk:310,mgc:180,def:365,mdef:305,spd:106,luck:31}},{lv:25,stats:{hp:1317,atk:608,mgc:353,def:1215,mdef:949,spd:108.5,luck:32}},{lv:50,stats:{hp:2029,atk:918,mgc:533,def:2100,mdef:1620,spd:111.2,luck:33}}]},
  {id:40002000,levels:[{lv:1,stats:{hp:643,atk:310,mgc:170,def:365,mdef:305,spd:106,luck:31}},{lv:25,stats:{hp:1337,atk:608,mgc:333,def:1215,mdef:949,spd:108.5,luck:32}},{lv:50,stats:{hp:2061,atk:918,mgc:503,def:2100,mdef:1620,spd:111.2,luck:33}}]},
  {id:25021000,levels:[{lv:1,stats:{hp:493,atk:405,mgc:140,def:245,mdef:120,spd:115,luck:31}},{lv:25,stats:{hp:1108,atk:940,mgc:274,def:715,mdef:324,spd:117.8,luck:32}},{lv:50,stats:{hp:1749,atk:1496,mgc:414,def:1205,mdef:537,spd:120.6,luck:33}}]},
  {id:34001000,levels:[{lv:1,stats:{hp:408,atk:170,mgc:270,def:190,mdef:190,spd:101,luck:31}},{lv:25,stats:{hp:868,atk:333,mgc:594,def:514,mdef:632,spd:103.4,luck:32}},{lv:50,stats:{hp:1348,atk:503,mgc:932,def:851,mdef:1093,spd:105.9,luck:33}}]},
  {id:19000000,levels:[{lv:1,stats:{hp:400,atk:155,mgc:250,def:170,mdef:225,spd:98,luck:31}},{lv:25,stats:{hp:851,atk:304,mgc:550,def:460,mdef:749,spd:100.4,luck:32}},{lv:50,stats:{hp:1321,atk:459,mgc:862,def:761,mdef:1294,spd:102.8,luck:33}}]},
  {id:21000000,levels:[{lv:1,stats:{hp:365,atk:160,mgc:310,def:150,mdef:230,spd:92,luck:31}},{lv:25,stats:{hp:821,atk:314,mgc:719,def:406,mdef:672,spd:94.2,luck:32}},{lv:50,stats:{hp:1295,atk:474,mgc:1145,def:672,mdef:1132,spd:96.5,luck:33}}]},
  {id:33011000,levels:[{lv:1,stats:{hp:523,atk:385,mgc:140,def:245,mdef:120,spd:115,luck:31}},{lv:25,stats:{hp:1176,atk:893,mgc:274,def:715,mdef:324,spd:117.8,luck:32}},{lv:50,stats:{hp:1856,atk:1423,mgc:414,def:1205,mdef:537,spd:120.6,luck:33}}]},
  // evolved ゆの (★5): the full Lv1→100 curve including the spec's anchors
  {id:10002001,levels:[{lv:1,stats:{hp:345,atk:220,mgc:240,def:170,mdef:295,spd:111,luck:31}},{lv:50,stats:{hp:1359,atk:651,mgc:710,def:836,mdef:1567,spd:116.4,luck:33}},{lv:80,stats:{hp:1980,atk:915,mgc:998,def:1244,mdef:2346,spd:119.8,luck:33}},{lv:100,stats:{hp:2394,atk:1091,mgc:1190,def:1516,mdef:2865,spd:122.0,luck:34}}]},
  {id:10001000,levels:[{lv:1,stats:{hp:320,atk:210,mgc:225,def:160,mdef:285,spd:109,luck:31}},{lv:25,stats:{hp:781,atk:412,mgc:441,def:467,mdef:887,spd:111.6,luck:32}},{lv:50,stats:{hp:1261,atk:622,mgc:666,def:787,mdef:1514,spd:114.3,luck:33}}]},
  {id:10001001,levels:[{lv:1,stats:{hp:320,atk:210,mgc:225,def:160,mdef:285,spd:109,luck:31}},{lv:80,stats:{hp:1837,atk:874,mgc:936,def:1171,mdef:2266,spd:117.6,luck:33}}]},
  {id:10011000,levels:[{lv:1,stats:{hp:503,atk:385,mgc:170,def:235,mdef:130,spd:114,luck:31}},{lv:50,stats:{hp:1785,atk:1423,mgc:503,def:1156,mdef:582,spd:119.6,luck:33}}]},
  {id:10011001,levels:[{lv:1,stats:{hp:503,atk:385,mgc:170,def:235,mdef:130,spd:114,luck:31}},{lv:80,stats:{hp:2569,atk:2058,mgc:707,def:1720,mdef:859,spd:123.0,luck:33}}]},
  {id:10021000,levels:[{lv:1,stats:{hp:373,atk:175,mgc:320,def:185,mdef:235,spd:93,luck:31}},{lv:50,stats:{hp:1323,atk:518,mgc:1182,def:829,mdef:1156,spd:97.6,luck:33}}]},
  {id:10021001,levels:[{lv:1,stats:{hp:373,atk:175,mgc:320,def:185,mdef:235,spd:93,luck:31}},{lv:80,stats:{hp:1905,atk:728,mgc:1710,def:1223,mdef:1720,spd:100.3,luck:33}}]},
  {id:10031000,levels:[{lv:1,stats:{hp:398,atk:180,mgc:250,def:240,mdef:190,spd:99,luck:31}},{lv:50,stats:{hp:1315,atk:533,mgc:862,def:1075,mdef:1093,spd:103.9,luck:33}}]},
  {id:10031001,levels:[{lv:1,stats:{hp:398,atk:180,mgc:250,def:240,mdef:190,spd:99,luck:31}},{lv:80,stats:{hp:1876,atk:749,mgc:1238,def:1586,mdef:1646,spd:106.8,luck:33}}]},
  {id:10041000,levels:[{lv:1,stats:{hp:550,atk:300,mgc:205,def:345,mdef:250,spd:104,luck:31}},{lv:50,stats:{hp:1763,atk:888,mgc:607,def:1985,mdef:1328,spd:109.1,luck:33}}]}
];

let sampleChecks = 0;
let sampleFails = 0;
SAMPLES.forEach(function (sample) {
    sample.levels.forEach(function (expect) {
        const got = stats.statsFor(sample.id, expect.lv);
        const keys = Object.keys(expect.stats);
        if (!got) {
            sampleFails += 1;
            console.log("FAIL " + sample.id + " Lv" + expect.lv + " returned null");
            return;
        }
        keys.forEach(function (key) {
            sampleChecks += 1;
            if (!closeEnough(got[key], expect.stats[key])) {
                sampleFails += 1;
                console.log("FAIL " + sample.id + " Lv" + expect.lv + " " + key
                    + ": got " + got[key] + " want " + expect.stats[key]);
            }
        });
    });
});
check("30 characters x levels: Stat(L) matches hand-computed truth (" + sampleChecks + " values)",
    sampleFails === 0, sampleFails + " mismatches");

// spec/04's own anchors, restated so a regression reads as a named failure
const anchor = stats.statsFor(10002001, 50);
check("spec anchor: ゆの evolved Lv50 HP = 1359", anchor.hp === 1359, "got " + anchor.hp);
const anchor80 = stats.statsFor(10002001, 80);
check("spec anchor: ゆの evolved Lv80 HP = 1980", anchor80.hp === 1980, "got " + anchor80.hp);
check("spec anchor: ゆの evolved Lv80 Spd = 119.8", anchor80.spd === 119.8, "got " + anchor80.spd);

// --- 2. the 40-role roster exists with the right class -----------------------
// Transcribed from spec/05 §4 (id, class, rarity).

const ROSTER = [
    [32002000, 2, 5], [32172000, 4, 5], [10000000, 3, 3], [11010000, 0, 3],
    [12000000, 1, 3], [13000000, 1, 3], [14010000, 1, 3], [14000000, 3, 3],
    [15000000, 0, 3], [16000000, 2, 3], [17000000, 0, 3], [18000000, 0, 3],
    [19000000, 4, 3], [20000000, 2, 3], [21000000, 1, 3], [22000000, 4, 3],
    [23011000, 0, 4], [23001000, 1, 4], [24001000, 2, 4], [25021000, 0, 4],
    [26000000, 3, 3], [27001000, 2, 4], [28001000, 3, 4], [29001000, 3, 4],
    [30001000, 0, 4], [31001000, 1, 4], [33011000, 0, 4], [34001000, 4, 4],
    [35001000, 2, 4], [36001000, 2, 4], [37002000, 4, 5], [38001000, 4, 4],
    [39001000, 1, 4], [41001000, 2, 4], [40002000, 3, 5], [42001000, 4, 4],
    [43001000, 3, 4], [47002000, 3, 5], [45002000, 1, 5], [46002000, 3, 5]
];

const rosterFails = [];
ROSTER.forEach(function (row) {
    const card = stats.card(row[0]);
    if (!card) {
        rosterFails.push(row[0] + " missing");
    } else if (card.class !== row[1] || card.rare !== row[2]) {
        rosterFails.push(row[0] + " cls " + card.class + "/" + card.rare
            + " want " + row[1] + "/" + row[2]);
    }
});
check("all 40 roster members exist in cards-rl.json with the recorded class/rarity",
    rosterFails.length === 0, rosterFails.join("; "));

const classCounts = [0, 0, 0, 0, 0];
ROSTER.forEach(function (row) { classCounts[row[1]] += 1; });
check("class coverage 8/8/8/9/7 across the roster",
    classCounts.join("/") === "8/8/8/9/7", classCounts.join("/"));

// --- 3. enemies: interpolation spot-checks + band invariant ------------------

const ENEMY_SPOTS = [
    { id: 90010002, lv: 1,   want: { hp: 12453, atk: 1024, mgc: 880, def: 150, mdef: 135, spd: 100.0, luck: 30, element: 2 } },
    { id: 90010002, lv: 50,  want: { hp: 64844, atk: 32954, mgc: 28320, def: 224, mdef: 202, spd: 114.8, luck: 37, element: 2 } },
    { id: 90010002, lv: 100, want: { hp: 118304, atk: 65536, mgc: 56320, def: 300, mdef: 270, spd: 130.0, luck: 45, element: 2 } },
    { id: 99038006, lv: 1,   want: { hp: 200000, atk: 420, mgc: 470, def: 120, mdef: 120, spd: 120.0, luck: 30, element: 3 } },
    { id: 99038006, lv: 100, want: { hp: 200000, atk: 39480, mgc: 44180, def: 264, mdef: 264, spd: 156.0, luck: 30, element: 3 } },
    { id: 90038005, lv: 10,  want: { hp: 24818, atk: 945, mgc: 3782, def: 44, mdef: 55, spd: 92.5, luck: 30, element: 4 } },
    { id: 90038005, lv: 60,  want: { hp: 84919, atk: 5642, mgc: 22570, def: 69, mdef: 86, spd: 106.1, luck: 30, element: 4 } }
];

let enemyFails = 0;
ENEMY_SPOTS.forEach(function (spot) {
    const got = stats.enemyStats(spot.id, spot.lv);
    if (!got) {
        enemyFails += 1;
        console.log("FAIL enemy " + spot.id + " Lv" + spot.lv + " returned null");
        return;
    }
    Object.keys(spot.want).forEach(function (key) {
        if (!closeEnough(got[key], spot.want[key])) {
            enemyFails += 1;
            console.log("FAIL enemy " + spot.id + " Lv" + spot.lv + " " + key
                + ": got " + got[key] + " want " + spot.want[key]);
        }
    });
});
check("enemy interpolation spot-checks (シュガー/テンペスト/ハイプリス)", enemyFails === 0,
    enemyFails + " mismatches");

// every row: interpolated stats stay inside [Init, Max]; Max never < Init
let bandFails = 0;
let statMaxBelowInit = 0;
tables.enemies.forEach(function (enemy) {
    Object.keys(enemy.init).forEach(function (key) {
        if (enemy.max[key] < enemy.init[key]) {
            statMaxBelowInit += 1;
        }
        const probe = stats.enemyStats(enemy.id, (enemy.initLv + enemy.maxLv) / 2);
        if (probe[key] < Math.min(enemy.init[key], enemy.max[key]) - 1
            || probe[key] > Math.max(enemy.init[key], enemy.max[key]) + 1) {
            bandFails += 1;
        }
    });
});
check("all enemy rows keep Max >= Init on every stat", statMaxBelowInit === 0,
    statMaxBelowInit + " inversions");
check("mid-curve interpolation stays inside [Init, Max] for all "
    + tables.enemies.length + " rows", bandFails === 0, bandFails + " out of band");

// --- 4. negatives -------------------------------------------------------------

check("unknown character returns null", stats.statsFor(999999999, 50) === null);
check("unknown enemy returns null", stats.enemyStats(999999999, 50) === null);
check("level below 1 clamps to Lv1", stats.statsFor(10002000, -5).hp === 345);
check("level above 100 clamps to Lv100",
    stats.statsFor(10002000, 999).hp === stats.statsFor(10002000, 100).hp);
check("enemy level below initLv clamps to InitLv",
    stats.enemyStats(90010002, -50).hp === 12453);

// --- 5. no runtime hotlinking (spec/03 §7 grep gate) ---------------------------

import { readdirSync, statSync } from "node:fs";
const FORBIDDEN = ["asset.kirafan.cn", "voice-cri.kirafan.cn", "kirafan.gitlab.io",
    "database.kirafan.cn", "bucket-", "gitlab.com"];
let hotlinkHits = [];
function scanRuntime(dir) {
    readdirSync(dir).forEach(function (name) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            if (name === "_raw") { return; }     // fetch cache, not runtime
            scanRuntime(path);
        } else if (/\.(js|html)$/.test(name)) {
            const text = readFileSync(path, "utf8");
            FORBIDDEN.forEach(function (domain) {
                if (text.includes(domain)) {
                    hotlinkHits.push(path + " contains " + domain);
                }
            });
        }
    });
}
// The gate guards the roguelike's own runtime code (game/, core/, asset/rl/).
// asset/gacha/cards.js and asset/town/ list CDN urls in meta provenance
// blocks -- those are fetch-source records, not runtime hotlinks, and the
// town data is a peer's; a hit inside those files is not ours to fail on.
["game", "core", "site/asset/rl"].forEach(scanRuntime);
check("no runtime code hotlinks the CDNs", hotlinkHits.length === 0, hotlinkHits.join("; "));

console.log(failures ? "\n" + failures + " FAILED" : "\nall stats checks passed");
process.exit(failures ? 1 : 0);
