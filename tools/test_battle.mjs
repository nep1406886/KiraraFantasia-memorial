// core/battle.js のユニットテスト。node tools/test_battle.mjs で走る。
// 失敗したら非ゼロで落ちる。
//
// なぜミラーするのか: このリポジトリには package.json が無いので node は
// core/*.js を CJS として読む。tools/check_js_syntax.sh と同じ手口で
// .mjs に写してから import する。core/ 側は一切書き換えない。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "kirafan-battle-test-"));

["cards", "battle"].forEach(function (name) {
    const src = fs.readFileSync(path.join(root, "core", name + ".js"), "utf8")
        .replace(/from\s+"\.\/([A-Za-z0-9_]+)\.js"/g, 'from "./$1.mjs"');
    fs.writeFileSync(path.join(work, name + ".mjs"), src);
});

// cards.js は window.kirafanGachaData を見る。ここでは実データを読み込む。
function loadGlobal(file, name) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const fn = new Function("window", text + "\n;return window." + name + ";");
    const box = {};
    return fn(box, undefined) || box[name];
}

globalThis.window = globalThis;
const gachaData = loadGlobal("site/asset/gacha/cards.js", "kirafanGachaData");
const skillData = loadGlobal("site/asset/battle/skills.js", "kirafanSkillData");
globalThis.window.kirafanGachaData = gachaData;

// Windows では絶対パスをそのまま import できない (file:// にする必要がある)。
const B = await import(pathToFileURL(path.join(work, "battle.mjs")).href);
const cards = await import(pathToFileURL(path.join(work, "cards.mjs")).href);

// --- 極小テストランナー ---------------------------------------------------
let passed = 0;
const failures = [];

function ok(label, condition) {
    if (condition) { passed += 1; return; }
    failures.push(label);
}
function eq(label, actual, expected) {
    ok(label + " (got " + JSON.stringify(actual) + ", want " + JSON.stringify(expected) + ")",
        actual === expected);
}
function near(label, actual, expected, tol) {
    ok(label + " (got " + actual + ", want ~" + expected + ")",
        Math.abs(actual - expected) <= (tol === undefined ? 1e-9 : tol));
}
// テスト用のアクター。数値を直接置けるので式の検証に使う。
function actor(overrides) {
    const base = {
        hp: 1000, atk: 200, mgc: 200, def: 200, mdef: 200, spd: 100, luck: 30
    };
    const stats = Object.assign({}, base, (overrides || {}).stats || {});
    const spec = Object.assign({
        name: "test", classId: 0, element: 0, level: 1, stats: stats, skills: []
    }, overrides || {});
    spec.stats = stats;
    return spec;
}

// 2 体だけの盤面。party[0] が攻撃側、enemy[0] が受け側。
function duel(a, b, seed) {
    return B.createBattle({
        party: [actor(a)], enemies: [actor(b)], seed: seed === undefined ? 7 : seed
    });
}

const dmgClause = { kind: "damage", target: "enemyOne", magnitude: "中", element: null };

// --- 1. detail パーサのカバレッジ ----------------------------------------

const skills = skillData.skills;
const ids = Object.keys(skills);
eq("skills.js has 2832 entries", ids.length, 2832);

let full = 0;
const unparsedShapes = new Set();
ids.forEach(function (id) {
    const parsed = B.parseDetail(skills[id].detail);
    if (parsed.full) { full += 1; }
    parsed.unparsed.forEach(function (u) { unparsedShapes.add(u); });
});
eq("every detail parses with no leftover clause", full, ids.length);
eq("no unparsed clause shapes", unparsedShapes.size, 0);
if (unparsedShapes.size) {
    console.log("unparsed:", Array.from(unparsedShapes).slice(0, 20));
}

// --- 2. パーサの形 --------------------------------------------------------

const p1 = B.parseDetail("「敵単体」に炎属性中ダメージ");
eq("single-target damage: one clause", p1.clauses.length, 1);
eq("single-target damage: kind", p1.clauses[0].kind, "damage");
eq("single-target damage: target", p1.clauses[0].target, "enemyOne");
eq("single-target damage: element is fire", p1.clauses[0].element, cards.ELEMENT_IDS.FIRE);
eq("single-target damage: magnitude", p1.clauses[0].magnitude, "中");

const p2 = B.parseDetail("「味方全体」のHPを大回復＋「味方全体」の物理攻撃が一定ターン中アップ");
eq("two clauses split on ＋", p2.clauses.length, 2);
eq("heal clause", p2.clauses[0].kind, "heal");
eq("heal target", p2.clauses[0].target, "allyAll");
eq("buff clause", p2.clauses[1].kind, "buff");
eq("buff stat", p2.clauses[1].stats[0], "atk");

// 「超特大」は特大より先に見ないと取り違える。
eq("超特大 beats 特大", B.parseDetail("「敵全体」に超特大ダメージ").clauses[0].magnitude, "超特大");

// クリティカル時ダメージ と クリティカル率 を二重に拾わない。
const p3 = B.parseDetail("「自身」のクリティカル時ダメージが一定ターン大アップ");
eq("critDamage only", p3.clauses[0].stats.join(","), "critDamage");

// 実データにある U+2015 の「ダメ―ジ」も読める。
eq("U+2015 dash normalised",
    B.parseDetail("「敵単体」に中ダメ―ジ").clauses[0].kind, "damage");

// 「〜回復するスキルカードを設置」は回復ではなくカード。
eq("card beats heal",
    B.parseDetail("「味方全体」のHPを中回復するスキルカードを設置").clauses[0].kind, "card");

// がまん (解釈は OURS、名前と位置はデータのまま)。
eq("がまん parses as endure",
    B.parseDetail("「自身」にがまんを付与").clauses[0].kind, "endure");
// --- 3. normalizeSkill --------------------------------------------------

const guardSkill = B.normalizeSkill("0", skills["0"]);
eq("skill 0 is 防御", guardSkill.name, "防御");
eq("skill 0 parses as guard clause", guardSkill.clauses[0].kind, "guard");

const fighterAttack = B.normalizeSkill("1", skills["1"]);
eq("normalAttackId(FIGHTER) is 1", B.normalAttackId(cards.CLASS_IDS.FIGHTER), "1");
eq("fighter attack sap", fighterAttack.sap, "Fighter_attack");
near("fighter attack load is the raw 原作 value", fighterAttack.load, 0.75, 1e-6);
eq("class from sap", B.classFromSap("Knight_cls2_grade2"), cards.CLASS_IDS.KNIGHT);
// CLASS_IDS: FIGHTER 0 / MAGICIAN 1 / PRIEST 2 / KNIGHT 3 / ALCHEMIST 4。
// 物理は せんし と ナイト = index 0 と 3。
eq("physical classes are Fighter/Knight",
    [0, 1, 2, 3, 4].map(B.isPhysicalClass).join(","), "true,false,false,true,false");

// recast が配列のスキルは末尾 (最短) を採り、RECAST_SCALE を掛ける。
const arrayRecast = ids.find(function (id) { return Array.isArray(skills[id].recast); });
const nr = B.normalizeSkill(arrayRecast, skills[arrayRecast]);
eq("array recast takes the last element",
    nr.recastRaw, skills[arrayRecast].recast[skills[arrayRecast].recast.length - 1]);
eq("recast is scaled", nr.recast, Math.max(0, Math.round(nr.recastRaw * B.RECAST_SCALE)));

// skillId = card.id * 10 + slot
const someCard = cards.all()[0];
const bound = B.skillIdsForCard(someCard);
eq("ultimate id is card.id * 10", bound.ultimate, String(someCard.id * 10));
eq("class skill ids are +1/+2", bound.classSkills.join(","),
    [someCard.id * 10 + 1, someCard.id * 10 + 2].join(","));

// --- 4. 属性係数 ---------------------------------------------------------

// 炎 → 風 が有利 (ADVANTAGE) なので 2.0、逆は 0.5、同属性は 1.0。
const fireVsWind = B.elementCoef(
    { buffs: [], element: cards.ELEMENT_IDS.FIRE },
    { buffs: [], element: cards.ELEMENT_IDS.WIND },
    cards.ELEMENT_IDS.FIRE);
near("炎 vs 風 is ばつぐん 2.0", fireVsWind.coef, 2.0);
eq("ばつぐん hit flag is 1", fireVsWind.hit, 1);

const windVsFire = B.elementCoef(
    { buffs: [], element: cards.ELEMENT_IDS.WIND },
    { buffs: [], element: cards.ELEMENT_IDS.FIRE },
    cards.ELEMENT_IDS.WIND);
near("風 vs 炎 is いまいち 0.5", windVsFire.coef, 0.5);
eq("いまいち hit flag is -1", windVsFire.hit, -1);

const moonVsSun = B.elementCoef(
    { buffs: [], element: cards.ELEMENT_IDS.MOON },
    { buffs: [], element: cards.ELEMENT_IDS.SUN },
    cards.ELEMENT_IDS.MOON);
near("月 vs 陽 is ばつぐん", moonVsSun.coef, 2.0);

// 属性耐性バフは被ダメを下げるが、clamp 帯より下には行かない。
const resisted = B.elementCoef(
    { buffs: [], element: cards.ELEMENT_IDS.FIRE },
    { buffs: [{ stat: "resist", amount: 0.3, elements: [cards.ELEMENT_IDS.FIRE] }],
        element: cards.ELEMENT_IDS.WIND },
    cards.ELEMENT_IDS.FIRE);
near("resist buff cuts ばつぐん to 1.7", resisted.coef, 1.7, 1e-9);
const overResisted = B.elementCoef(
    { buffs: [], element: cards.ELEMENT_IDS.FIRE },
    { buffs: [{ stat: "resist", amount: 5, elements: null }], element: cards.ELEMENT_IDS.WIND },
    cards.ELEMENT_IDS.FIRE);
near("ばつぐん clamps at the 原作 floor 1.6", overResisted.coef, 1.6);
// --- 5. ダメージ式 -------------------------------------------------------

// 乱数を潰して式そのものを見る: seed と rngCount が同じなら結果も同じ。
function damageOnce(atk, def, seed, extra) {
    const state = duel(
        Object.assign({ classId: cards.CLASS_IDS.FIGHTER, element: cards.ELEMENT_IDS.FIRE,
            stats: { atk: atk, luck: 0 } }, (extra || {}).a),
        Object.assign({ element: cards.ELEMENT_IDS.FIRE, stats: { def: def, luck: 100 } },
            (extra || {}).b),
        seed);
    const attacker = state.actors[0];
    const defender = state.actors[1];
    if (extra && extra.mutate) { extra.mutate(attacker, defender); }
    return B.calcDamage(state, attacker, defender, dmgClause);
}

const d1 = damageOnce(200, 200, 11);
const d2 = damageOnce(200, 200, 11);
eq("damage is deterministic for a seed", d1.damage, d2.damage);
ok("damage is positive", d1.damage > 0);

// 攻撃力 2 倍でダメージ 2 倍 (同じ seed なので乱数は同じ)。
const dLow = damageOnce(200, 200, 21);
const dHigh = damageOnce(400, 200, 21);
near("doubling ATK doubles damage", dHigh.damage / dLow.damage, 2, 0.02);

// 防御は **除数**。2 倍で半分。
const dDef = damageOnce(200, 400, 21);
near("doubling DEF halves damage", dDef.damage / dLow.damage, 0.5, 0.02);

// 乱数帯は 0.85〜1.0 の内側に必ず入る。
let minRatio = Infinity;
let maxRatio = 0;
for (let s = 0; s < 200; s++) {
    const d = damageOnce(200, 200, 1000 + s);
    // power * atk / def を素で出しておく (magnitude 中 = MAGNITUDE_POWER["中"])。
    const raw = B.MAGNITUDE_POWER["中"] * 200 / 200;
    const ratio = d.damage / raw / (d.critical ? B.DEFINE.criticalCoef : 1);
    minRatio = Math.min(minRatio, ratio);
    maxRatio = Math.max(maxRatio, ratio);
}
ok("damage random band stays >= 0.85 (got " + minRatio + ")", minRatio >= 0.84);
ok("damage random band stays <= 1.0 (got " + maxRatio + ")", maxRatio <= 1.001);

// 物理クラスは ATK、魔法クラスは MAT を見る。式は共通。
const physical = damageOnce(200, 200, 31, {
    a: { classId: cards.CLASS_IDS.FIGHTER, stats: { atk: 400, mgc: 100, luck: 0 } }
});
const magical = damageOnce(200, 200, 31, {
    a: { classId: cards.CLASS_IDS.MAGICIAN, stats: { atk: 100, mgc: 400, luck: 0 } }
});
eq("physical uses ATK, magic uses MAT, same formula", physical.damage, magical.damage);
eq("physical flag follows the class", physical.physical, true);
eq("magic flag follows the class", magical.physical, false);

// 防御コマンドは被ダメ半減 (guardCoef 2.0 で割る)。
const guarded = damageOnce(200, 200, 41, {
    mutate: function (a, b) { b.guarding = true; }
});
const unguarded = damageOnce(200, 200, 41);
near("guard halves damage", guarded.damage / unguarded.damage, 0.5, 0.02);

// バリアは最後にカットする。normal = 0.4 (OURS)。
const barriered = damageOnce(200, 200, 51, {
    mutate: function (a, b) { b.barrier = { times: 1, cut: "normal" }; }
});
const bare = damageOnce(200, 200, 51);
near("normal barrier cuts 40%", barriered.damage / bare.damage, 0.6, 0.02);
ok("barrier reports what it absorbed", barriered.absorbed > 0);
// --- 6. クリティカル -----------------------------------------------------

// いまいち (hit -1) は絶対にクリティカルしない。cards.js のコメントの制約。
const neverCrit = duel(
    { element: cards.ELEMENT_IDS.WIND, stats: { luck: 999 } },
    { element: cards.ELEMENT_IDS.FIRE, stats: { luck: 0 } }, 3);
let critCount = 0;
for (let i = 0; i < 300; i++) {
    if (B.rollCritical(neverCrit, neverCrit.actors[0], neverCrit.actors[1], -1)) { critCount += 1; }
}
eq("いまいち never crits over 300 rolls", critCount, 0);

// ばつぐん (hit 1) はクリ率が上がる: 同じ LUK でも -1 より多く出る。
function critRate(hit, luck, rluck, seed) {
    const state = duel({ stats: { luck: luck } }, { stats: { luck: rluck } }, seed);
    let hits = 0;
    for (let i = 0; i < 2000; i++) {
        if (B.rollCritical(state, state.actors[0], state.actors[1], hit)) { hits += 1; }
    }
    return hits / 2000;
}
const neutralRate = critRate(0, 40, 0, 5);
const strongRate = critRate(1, 40, 0, 5);
ok("ばつぐん raises crit rate (" + neutralRate + " -> " + strongRate + ")",
    strongRate > neutralRate);
near("neutral crit rate tracks LUK", neutralRate, 0.40, 0.05);
near("ばつぐん crit rate is LUK * 1.1", strongRate, 0.44, 0.05);

// 受け側の LUK は確率を引く。
ok("defender LUK lowers crit rate", critRate(0, 40, 30, 5) < neutralRate);

// 確定クリの 3 条件。いまいち でもスタン中なら通る (原作の順序)。
const forced = duel({}, {}, 9);
forced.actors[0].nextCritical = true;
eq("nextCritical forces a crit", B.rollCritical(forced, forced.actors[0], forced.actors[1], -1), true);
forced.actors[0].nextCritical = false;
forced.actors[1].stunned = true;
eq("stun forces a crit", B.rollCritical(forced, forced.actors[0], forced.actors[1], -1), true);
forced.actors[1].stunned = false;
forced.actors[1].ailments.push({ ailment: "bearish", turns: 3 });
eq("よわき forces a crit", B.rollCritical(forced, forced.actors[0], forced.actors[1], -1), true);

// クリティカル係数は 1.5。
const critState = duel({ stats: { atk: 200, luck: 0 } }, { stats: { def: 200, luck: 0 } }, 61);
const plain = B.calcDamage(critState, critState.actors[0], critState.actors[1], dmgClause);
critState.rngCount -= 2;   // 同じ乱数に戻す
critState.actors[0].nextCritical = true;
const crit = B.calcDamage(critState, critState.actors[0], critState.actors[1], dmgClause);
near("crit multiplies by 1.5", crit.damage / plain.damage, 1.5, 0.02);
eq("crit is reported", crit.critical, true);
eq("plain is reported", plain.critical, false);
// --- 7. 回復 -------------------------------------------------------------

const healClause = { kind: "heal", target: "allyOne", magnitude: "中", element: null };
const healState = B.createBattle({
    party: [actor({ classId: cards.CLASS_IDS.PRIEST, stats: { mgc: 200 } }),
        actor({ stats: { hp: 2000 } })],
    enemies: [actor({})],
    seed: 5
});
const healer = healState.actors[0];
const small = healState.actors[1];
const r1 = B.calcRecover(healState, healer, healer, healClause);
const r2 = B.calcRecover(healState, healer, small, healClause);
near("heal scales with the target's max HP", r2.heal / r1.heal, small.maxHp / healer.maxHp, 0.02);
ok("heal is a sane share of max HP", r1.heal > healer.maxHp * 0.15 && r1.heal < healer.maxHp * 0.4);

// RecoverBonus は MAT で伸びるが 1.5 で止まる。
const bigMgc = B.createBattle({
    party: [actor({ classId: cards.CLASS_IDS.PRIEST, stats: { mgc: 100000 } })],
    enemies: [actor({})], seed: 5
});
const capped = B.calcRecover(bigMgc, bigMgc.actors[0], bigMgc.actors[0], healClause);
const expectedCap = Math.trunc(B.MAGNITUDE_RECOVER["中"] * B.DEFINE.recoverBonusMax
    * B.DEFINE.recoverBonusSameElement * 0.01 * bigMgc.actors[0].maxHp);
eq("RecoverBonus clamps at 1.5", capped.heal, expectedCap);

// ふこう は回復量 0。
small.ailments.push({ ailment: "unhappy", turns: 3 });
const blocked = B.calcRecover(healState, healer, small, healClause);
eq("ふこう zeroes healing", blocked.heal, 0);
eq("ふこう is reported as blocked", blocked.blocked, true);
small.ailments.length = 0;

// --- 8. TL (OrderValue) --------------------------------------------------

const slow = actor({ stats: { spd: 60 } });
const fast = actor({ stats: { spd: 140 } });
ok("higher SPD gives a smaller OrderValue",
    B.orderValue(Object.assign({ buffs: [], ailments: [] }, fast), 1)
    < B.orderValue(Object.assign({ buffs: [], ailments: [] }, slow), 1));

const plainOrder = B.orderValue({ stats: { spd: 100 }, buffs: [], ailments: [] }, 1);
const buffedOrder = B.orderValue(
    { stats: { spd: 100 }, buffs: [{ stat: "spd", amount: 0.5 }], ailments: [] }, 1);
ok("SPD buff shrinks OrderValue as a coefficient (" + plainOrder + " -> " + buffedOrder + ")",
    buffedOrder < plainOrder);

const sleeping = B.orderValue(
    { stats: { spd: 100 }, buffs: [], ailments: [{ ailment: "sleep", turns: 3 }] }, 1);
eq("sleep doubles the load factor", sleeping, Math.min(B.DEFINE.orderValueMax, plainOrder * 2));

// clamp [15, 500]
ok("OrderValue clamps low", B.orderValue({ stats: { spd: 9999 }, buffs: [], ailments: [] }, 0.1)
    >= B.DEFINE.orderValueMin);
ok("OrderValue clamps high", B.orderValue({ stats: { spd: 1 }, buffs: [], ailments: [] }, 99)
    <= B.DEFINE.orderValueMax);

// 速い方が先に動く。
const tl = B.createBattle({ party: [actor({ stats: { spd: 140 } })],
    enemies: [actor({ stats: { spd: 60 } })], seed: 1 });
eq("the faster actor is first on the timeline", B.nextActor(tl).id, "party0");
// --- 9. コマンドと状態異常 -----------------------------------------------

function withSkills(overrides) {
    const spec = actor(overrides);
    spec.skills = [
        B.normalizeSkill("1", skills["1"], { classId: 0 }),
        B.normalizeSkill("11", { name: "テスト", detail: "「敵単体」に中ダメージ",
            type: 3, sap: "Fighter_cls1_grade0", load: 1, recast: 8 },
        { classId: 0, slot: 1 })
    ];
    spec.ultimate = B.normalizeSkill("10", { name: "テストとっておき",
        detail: "「敵全体」に特大ダメージ", type: 3, sap: "10", load: 1.25, recast: 10 },
    { classId: 0, slot: 0, ultimate: true });
    return spec;
}

const cmdState = B.createBattle({ party: [withSkills({})], enemies: [actor({ ai: "aggressive" })], seed: 4 });
const me = cmdState.actors[0];
let legal = B.legalCommands(cmdState, me.id);
eq("attack and guard are always offered",
    legal.filter(function (c) { return c.type === "attack" || c.type === "guard"; }).length, 2);
ok("a ready skill is offered", legal.some(function (c) { return c.type === "skill"; }));
ok("ultimate is hidden on an empty gauge",
    !legal.some(function (c) { return c.type === "ultimate"; }));

// 1 本 = 100% で撃てる。満タン (3 本) は連鎖用の貯金。
me.gauge = 0.99;
ok("ultimate is still hidden just under one bar",
    !B.legalCommands(cmdState, me.id).some(function (c) { return c.type === "ultimate"; }));
me.gauge = 1;
ok("ultimate appears at one full bar",
    B.legalCommands(cmdState, me.id).some(function (c) { return c.type === "ultimate"; }));
me.gauge = B.DEFINE.togetherGaugeMax;
ok("ultimate appears on a full gauge",
    B.legalCommands(cmdState, me.id).some(function (c) { return c.type === "ultimate"; }));

me.cooldowns[1] = 3;
ok("a cooling skill is withheld",
    !B.legalCommands(cmdState, me.id).some(function (c) { return c.type === "skill"; }));
me.cooldowns[1] = 0;

me.ailments.push({ ailment: "silence", turns: 3 });
legal = B.legalCommands(cmdState, me.id);
ok("ちんもく blocks skills", !legal.some(function (c) { return c.type === "skill"; }));
ok("ちんもく still allows とっておき", legal.some(function (c) { return c.type === "ultimate"; }));
ok("ちんもく still allows the normal attack",
    legal.some(function (c) { return c.type === "attack"; }));
me.ailments.length = 0;
me.gauge = 0;

// needsTarget は単体対象の節があるときだけ答える。
eq("single-target skill needs an enemy",
    B.needsTarget(cmdState, { actorId: me.id, type: "skill", skillIndex: 1 }), "enemy");
eq("ultimate hitting everyone needs no pick",
    B.needsTarget(cmdState, { actorId: me.id, type: "ultimate" }), null);
eq("guard needs no pick", B.needsTarget(cmdState, { actorId: me.id, type: "guard" }), null);

// 不正なコマンドは弾く。
const rejected = B.submit(cmdState, { actorId: me.id, type: "ultimate" });
eq("an illegal command is rejected", rejected.events[0].type, "rejected");
// --- 9b. バフは 1 ステータス 1 枠 (OURS) ---------------------------------
//
// 加算で積めると小バフ連打が最適手になり、AI は永久にバフを撃って
// 戦闘が終わらなくなる。実際にそれが起きたのでここで固定する。
// 実際の経路 (submit) でしか確かめない。テスト用の export は作らない。
function buffer(magnitude, kind) {
    const spec = actor({ stats: { atk: 200, spd: 300, luck: 0 } });
    spec.skills = [
        B.normalizeSkill("1", skills["1"], { classId: 0 }),
        // 原作の言い回しそのまま。「攻撃力」ではなく「物理攻撃」。
        B.normalizeSkill("11", { name: "自分バフ",
            detail: "「自身」の物理攻撃が一定ターン" + magnitude
                + (kind === "debuff" ? "ダウン" : "アップ"),
            type: 3, sap: "Fighter_cls1_grade0", load: 1, recast: 0 }, { classId: 0, slot: 1 })
    ];
    return spec;
}

function castSelfBuff(state, times) {
    const self = state.actors[0];
    for (let i = 0; i < times; i += 1) {
        B.advance(state);
        if (B.activeActor(state) !== self) { break; }
        B.submit(state, { actorId: self.id, type: "skill", skillIndex: 1 });
    }
    return self;
}

const slotState = B.createBattle({ party: [buffer("小")],
    enemies: [actor({ stats: { hp: 1000000, spd: 1, atk: 1 } })], seed: 21 });
const atkBase = slotState.actors[0].stats.atk;
const slotMe = castSelfBuff(slotState, 5);
eq("repeating a buff keeps one slot",
    slotMe.buffs.filter(function (b) { return b.stat === "atk" && !b.once; }).length, 1);
near("five 小 buffs are still one 小 step",
    B.statWithBuffs(slotMe, "atk") / atkBase, 1 + B.STAT_BUFF_STEP["小"], 0.01);

// 強いほうが残り、弱いのを重ねても下がらない。
const upState = B.createBattle({ party: [buffer("大")],
    enemies: [actor({ stats: { hp: 1000000, spd: 1, atk: 1 } })], seed: 23 });
const upMe = castSelfBuff(upState, 1);
near("a 大 buff applies its own step",
    B.statWithBuffs(upMe, "atk") / upMe.stats.atk, 1 + B.STAT_BUFF_STEP["大"], 0.01);
upMe.skills[1] = B.normalizeSkill("12", { name: "弱いバフ",
    detail: "「自身」の物理攻撃が一定ターン小アップ", type: 3, sap: "Fighter_cls1_grade0",
    load: 1, recast: 0 }, { classId: 0, slot: 1 });
upMe.cooldowns[1] = 0;
castSelfBuff(upState, 1);
near("a weaker buff does not downgrade the slot",
    B.statWithBuffs(upMe, "atk") / upMe.stats.atk, 1 + B.STAT_BUFF_STEP["大"], 0.01);

// デバフはバフと別枠 (片方が片方を消さない)。
const mixState = B.createBattle({ party: [buffer("中")],
    enemies: [actor({ stats: { hp: 1000000, spd: 1, atk: 1 } })], seed: 24 });
const mixMe = castSelfBuff(mixState, 1);
mixMe.skills[1] = B.normalizeSkill("13", { name: "自分デバフ",
    detail: "「自身」の物理攻撃が一定ターン中ダウン", type: 3, sap: "Fighter_cls1_grade0",
    load: 1, recast: 0 }, { classId: 0, slot: 1 });
mixMe.cooldowns[1] = 0;
castSelfBuff(mixState, 1);
eq("a debuff takes its own slot, it does not clear the buff",
    mixMe.buffs.filter(function (b) { return b.stat === "atk" && !b.once; }).length, 2);

// 満タンの相手に回復しても「0 回復」イベントは出さない。
const fullSpec = actor({ stats: { spd: 300, luck: 0 }, classId: cards.CLASS_IDS.PRIEST });
fullSpec.skills = [
    B.normalizeSkill("1", skills["1"], { classId: 0 }),
    B.normalizeSkill("14", { name: "全体回復", detail: "「味方全体」を大回復",
        type: 3, sap: "Priest_cls1_grade0", load: 1, recast: 0 }, { classId: 2, slot: 1 })
];
const fullState = B.createBattle({ party: [fullSpec],
    enemies: [actor({ stats: { hp: 1000000, spd: 1, atk: 1 } })], seed: 22 });
B.advance(fullState);
const healResult = B.submit(fullState,
    { actorId: fullState.actors[0].id, type: "skill", skillIndex: 1 });
eq("healing a full-HP party emits no heal event",
    healResult.events.filter(function (e) { return e.type === "heal"; }).length, 0);
// --- 10. とっておき ------------------------------------------------------

// ゲージは攻撃で 0.17 ずつ溜まる。3 本で満タン。
const gaugeState = B.createBattle({ party: [withSkills({})],
    enemies: [actor({ stats: { hp: 1000000 } })], seed: 8 });
const attackerG = gaugeState.actors[0];
B.advance(gaugeState);
B.submit(gaugeState, { actorId: attackerG.id, type: "attack", skillIndex: 0 });
near("attacking charges the gauge by 0.17", attackerG.gauge, B.DEFINE.chargeOnAttack, 1e-6);

// 連鎖係数 1 / 1.5 / 2 はとっておきにだけ乗る。
const chainState = B.createBattle({
    party: [withSkills({ stats: { spd: 200, atk: 200, luck: 0 } }),
        withSkills({ stats: { spd: 199, atk: 200, luck: 0 } })],
    enemies: [actor({ stats: { hp: 1000000, def: 200, luck: 0 } })],
    seed: 12
});
chainState.actors[0].gauge = B.DEFINE.togetherGaugeMax;
chainState.actors[1].gauge = B.DEFINE.togetherGaugeMax;
B.advance(chainState);
const first = B.submit(chainState, { actorId: "party0", type: "ultimate" });
const firstDamage = first.events.filter(function (e) { return e.type === "damage"; })[0].amount;
eq("chain starts at 1", chainState.chain, 1);
B.advance(chainState);
const second = B.submit(chainState, { actorId: "party1", type: "ultimate" });
const secondDamage = second.events.filter(function (e) { return e.type === "damage"; })[0].amount;
eq("chain advances to 2", chainState.chain, 2);
ok("the second とっておき in a chain hits harder (" + firstDamage + " -> " + secondDamage + ")",
    secondDamage > firstDamage);
// 1 本ぶんだけ減る。残りで続けて撃てるのが連鎖の前提。
eq("firing とっておき spends exactly one bar",
    chainState.actors[0].gauge, B.DEFINE.togetherGaugeMax - 1);

// 普通の攻撃で連鎖は切れる。
B.advance(chainState);
B.submit(chainState, { actorId: B.activeActor(chainState).id, type: "attack", skillIndex: 0 });
eq("a normal action breaks the chain", chainState.chain, 0);

// --- 11. スタン ----------------------------------------------------------

// スタンは (damage / maxHp) * (stunCoef * elementCoef) の蓄積。
// dealDamage は内部関数なので公開経路 (submit) 越しに見る。
// 最大HPの数%だけ削る一撃 → 蓄積は増えるが満たない。
function stunRun(enemyHp, seed, stunCoef) {
    const battle = B.createBattle({
        party: [withSkills({ stats: { atk: 1000, spd: 200, luck: 0 },
            element: cards.ELEMENT_IDS.FIRE })],
        enemies: [actor({ stats: { hp: enemyHp, def: 100, luck: 0 },
            element: cards.ELEMENT_IDS.FIRE, ai: "aggressive",
            stunCoef: stunCoef === undefined ? B.STUN_COEF : stunCoef })],
        seed: seed
    });
    B.advance(battle);
    const step = B.submit(battle, { actorId: "party0", type: "attack", skillIndex: 0 });
    return { battle: battle, step: step };
}

const smallStun = stunRun(500000, 15);
ok("damage was dealt", smallStun.step.events.some(function (e) { return e.type === "damage"; }));
ok("a partial hit accumulates stun without triggering it",
    smallStun.battle.actors[1].stunValue > 0 && !smallStun.battle.actors[1].stunned);

// 最大HPの大半を持っていく一撃 → 蓄積が満ちてスタン。
// 生き残る HP にしておく (落ちるとスタン判定に入らない)。
const bigStun = stunRun(2600, 15, 3);
eq("the target survived the big hit", bigStun.battle.actors[1].alive, true);
ok("a hit worth most of max HP triggers stun", bigStun.battle.actors[1].stunned);
ok("stun is reported as an event",
    bigStun.step.events.some(function (e) { return e.type === "stun"; }));
eq("stun fills a とっておきゲージ on the other side",
    bigStun.battle.actors[0].gauge >= 1, true);
eq("stunValue saturates at STUN_VALUE_MAX",
    bigStun.battle.actors[1].stunValue, B.STUN_VALUE_MAX);

// 属性有利はスタン蓄積も倍にする (elementCoef がそのまま掛かる)。
function stunValueFor(attackerElement, defenderElement) {
    const battle = B.createBattle({
        party: [withSkills({ stats: { atk: 1000, spd: 200, luck: 0 }, element: attackerElement })],
        enemies: [actor({ stats: { hp: 900000, def: 100, luck: 0 }, element: defenderElement })],
        seed: 33
    });
    B.advance(battle);
    B.submit(battle, { actorId: "party0", type: "attack", skillIndex: 0 });
    return battle.actors[1].stunValue;
}
const neutralStun = stunValueFor(cards.ELEMENT_IDS.FIRE, cards.ELEMENT_IDS.FIRE);
const strongStun = stunValueFor(cards.ELEMENT_IDS.FIRE, cards.ELEMENT_IDS.WIND);
near("ばつぐん accumulates 4x stun (2x damage * 2x coef)",
    strongStun / neutralStun, 4, 0.2);

// スタン中は確定クリを許す (rollCritical のテストで確認済み) が、
// upkeep で 1 手ぶんで解ける。
const stunClear = stunRun(500000, 16).battle;
stunClear.actors[1].stunned = true;
let sawStunEnd = false;
for (let i = 0; i < 8 && !sawStunEnd; i++) {
    const step = B.advance(stunClear);
    if (step.waiting) { B.submit(stunClear, B.chooseCommand(stunClear, stunClear.actors[0])); }
    sawStunEnd = step.events.some(function (e) { return e.type === "stunEnd"; });
}
ok("stun wears off on the stunned actor's turn", sawStunEnd);
ok("a stunned turn is skipped",
    stunClear.log.some(function (e) { return e.type === "skip" && e.reason === "stun"; }));
// --- 12. 決定性とセーブ ---------------------------------------------------

// 同じ seed で同じ手を打つと、まったく同じ盤面になる。
function autoBattle(seed, limit) {
    const state = B.createBattle({
        party: [withSkills({ stats: { spd: 120 } }), withSkills({ classId: cards.CLASS_IDS.PRIEST })],
        enemies: [actor({ stats: { hp: 1200 }, ai: "aggressive" }),
            actor({ stats: { hp: 900 }, ai: "smart" })],
        seed: seed
    });
    let steps = 0;
    while (!B.isOver(state) && steps < (limit || 400)) {
        const step = B.advance(state);
        if (step.waiting) {
            // 味方も AI に指させる = 完全に決定的なリプレイになる。
            B.submit(state, B.chooseCommand(state, B.actorById(state, step.waiting)));
        }
        steps += 1;
    }
    return { state: state, steps: steps };
}

const runA = autoBattle(1234);
const runB = autoBattle(1234);
eq("the same seed replays identically",
    JSON.stringify(runA.state), JSON.stringify(runB.state));
ok("a battle actually finishes", Boolean(B.isOver(runA.state)));
ok("it takes a sane number of turns (" + runA.state.turn + ")",
    runA.state.turn > 2 && runA.state.turn < 400);

const runC = autoBattle(9999);
ok("a different seed gives a different fight",
    JSON.stringify(runC.state) !== JSON.stringify(runA.state));

// 途中セーブ → 復元 → 続き。乱数も状態の中なので同じ列が続く。
const midA = B.createBattle({
    party: [withSkills({ stats: { spd: 120 } })],
    enemies: [actor({ stats: { hp: 4000 }, ai: "aggressive" })],
    seed: 77
});
for (let i = 0; i < 6; i++) {
    const step = B.advance(midA);
    if (step.waiting) { B.submit(midA, B.chooseCommand(midA, B.actorById(midA, step.waiting))); }
}
const saved = JSON.parse(JSON.stringify(midA));
eq("state survives a JSON round trip", JSON.stringify(saved), JSON.stringify(midA));
eq("isRestorable accepts it", B.isRestorable(saved), true);
eq("isRestorable rejects junk", B.isRestorable({ version: 99 }), false);

function continueFrom(state) {
    for (let i = 0; i < 10; i++) {
        const step = B.advance(state);
        if (step.waiting) { B.submit(state, B.chooseCommand(state, B.actorById(state, step.waiting))); }
    }
    return JSON.stringify(state);
}
const fromLive = continueFrom(JSON.parse(JSON.stringify(saved)));
const fromSaved = continueFrom(JSON.parse(JSON.stringify(saved)));
eq("resuming a save continues the same RNG stream", fromLive, fromSaved);

// 乱数はエンジンの外から来ない: Math.random を壊しても結果が変わらない。
const realRandom = Math.random;
Math.random = function () { throw new Error("battle.js must not call Math.random"); };
let mathRandomClean = true;
try {
    autoBattle(2024);
} catch (err) {
    mathRandomClean = false;
    failures.push("Math.random was called: " + err.message);
}
Math.random = realRandom;
ok("the engine never calls Math.random", mathRandomClean);
// --- 13. 実カードで組む -------------------------------------------------

// 実データ (cards.js + skills.js) だけでパーティが組めること。
const realParty = cards.all().slice(0, 4).map(function (card) {
    return B.memberFromCard(card, skills, { level: 40 });
});
eq("four real cards make four members", realParty.length, 4);
ok("every member has a normal attack in slot 0",
    realParty.every(function (m) { return m.skills.length >= 1; }));
const withUltimate = realParty.filter(function (m) { return m.ultimate; });
ok("real cards resolve their とっておき (" + withUltimate.length + "/4)",
    withUltimate.length >= 1);
ok("skill names come from the data untouched",
    realParty[0].skills[0].name === skills[B.normalAttackId(realParty[0].classId)].name);

// カード 685 枚ぜんぶで記述子が作れる (落ちない)。
let built = 0;
let withAllThree = 0;
cards.all().forEach(function (card) {
    const member = B.memberFromCard(card, skills, { level: 40 });
    built += 1;
    if (member.ultimate && member.skills.length === 3) { withAllThree += 1; }
});
eq("all 685 cards build without throwing", built, cards.all().length);
ok("most cards get all three slots from shipped data (" + withAllThree + "/" + built + ")",
    withAllThree > built * 0.9);

// ステータスはレベルで伸び、SPD/LUK は伸びない。
const lv1 = B.statsForCard(cards.all()[0], 1);
const lv80 = B.statsForCard(cards.all()[0], 80);
ok("HP grows with level", lv80.hp > lv1.hp * 1.9);
eq("SPD does not grow with level", lv80.spd, lv1.spd);
eq("LUK does not grow with level", lv80.luck, lv1.luck);

// 敵記述子は skills.js の実スキルを撃てる。
const enemy = B.enemyDescriptor({
    name: { ja: "テスト", zh: "测试" }, classId: cards.CLASS_IDS.MAGICIAN,
    element: cards.ELEMENT_IDS.WATER, stats: { hp: 900, atk: 150, mgc: 150,
        def: 150, mdef: 150, spd: 95, luck: 20 },
    skillIds: ["11"], ai: "smart"
}, skills);
ok("an enemy gets its class normal attack", enemy.skills.length >= 1);
eq("enemy AI is carried through", enemy.ai, "smart");

// describeSkill は日本語をそのまま、中文を節から組む。
const desc = B.describeSkill(B.normalizeSkill("1", skills["1"]));
eq("describeSkill keeps the original 日本語", desc.ja, skills["1"].detail);
ok("describeSkill produces 中文", typeof desc.zh === "string" && desc.zh.length > 0);

// --- おわり --------------------------------------------------------------

fs.rmSync(work, { recursive: true, force: true });

if (failures.length) {
    console.error("\n" + failures.length + " assertion(s) failed:");
    failures.forEach(function (f) { console.error("  FAIL  " + f); });
    console.error("\n" + passed + " passed, " + failures.length + " failed");
    process.exit(1);
}
console.log(passed + " assertions passed");
