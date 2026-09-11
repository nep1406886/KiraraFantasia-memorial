// 実時間の当たりを core/battle.js の結算に通す。plans/metroidvania.md 阶段 0。
// tools/check_mv_damage.py がこれを呼ぶ。ブラウザは要らない。
//
// 引数: <battle.js へのパス> <platformer.js へのパス>
// 標準出力: JSON 一つ。人間向けの行は出さない。
//
// core/cards.js は window.kirafanGachaData を data() の中でだけ読む
// (core/cards.js:83)。elementMultiplier / elementHit はそこを通らないので、
// カード表を読まないかぎり node でそのまま import できる。敵記述子だけで
// 組めば party 側も要らない。

import { pathToFileURL } from "node:url";

const battlePath = process.argv[2];
const platformerPath = process.argv[3];
if (!battlePath || !platformerPath) {
    console.error("usage: mv_damage_harness.mjs <battle.js> <platformer.js>");
    process.exit(2);
}
const B = await import(pathToFileURL(battlePath).href);
const P = await import(pathToFileURL(platformerPath).href);

const SEED = 0x51ed10;
const HITS = 200;

// 攻守 2 体。カード表を読まずに済むよう両方とも enemyDescriptor で作る
// (§6.4 の「真 actor を借りる」を、依存を増やさずに満たす形)。
// HP は削り切られない大きさ。生死で列が途切れると比較にならない。
function pair() {
    const attacker = B.enemyDescriptor({
        name: { ja: "読み手", zh: "读者" },
        classId: 0, element: 1, level: 30,
        stats: { hp: 999999, atk: 620, mgc: 300, def: 200, mdef: 200, spd: 120, luck: 40 },
        skillIds: [], ai: "aggressive"
    }, {});
    const defender = B.enemyDescriptor({
        name: { ja: "白紙", zh: "白纸" },
        classId: 3, element: 0, level: 30,
        stats: { hp: 999999, atk: 300, mgc: 300, def: 240, mdef: 240, spd: 90, luck: 25 },
        skillIds: [], ai: "aggressive"
    }, {});
    return { attacker: attacker, defender: defender };
}

function borrow(seed) {
    const p = pair();
    // §6.4 のとおり createBattle を一度呼んで、返った state と actors を使う。
    // makeActor は export されていないので、これが唯一の正しい作り方。
    const state = B.createBattle({ party: [], enemies: [p.attacker, p.defender], seed: seed });
    return {
        state: state,
        attacker: state.actors[0],
        defender: state.actors[1]
    };
}

// 通常攻撃 1 発ぶんの節。element: "self" は攻撃側の属性を使う (battle.js:1005)。
const CLAUSE = { magnitude: "中", element: "self" };

// 回合制の側: 何も挟まずに 200 発。
function turnBased(seed) {
    const b = borrow(seed);
    const out = [];
    for (let i = 0; i < HITS; i++) {
        const r = B.calcDamage(b.state, b.attacker, b.defender, CLAUSE);
        out.push([r.damage, r.critical ? 1 : 0, r.hit, r.elementCoef]);
    }
    return { seq: out, rngCount: b.state.rngCount };
}

// 実時間の側: 房の物理を回しながら、当たった瞬間に同じ結算を呼ぶ。
// 物理は自前の PRNG (createRandom) を持っていて battle の state を触らない、
// というのがここで確かめたい一点。挟んだフレーム数が結果を動かしたら、
// 実時間で戦えないということになる。
function realTime(seed, options) {
    const opt = options || {};
    const b = borrow(seed);
    if (opt.bumpRngCount) { b.state.rngCount += opt.bumpRngCount; }

    const room = P.compileRoom({
        size: [40, 12],
        solid: [[0, 0, 40, 1], [0, 1, 1, 11], [39, 1, 1, 11], [12, 1, 2, 2]]
    });
    const body = P.createBody(3, 1);
    // 物理側の乱数も一緒に回す。battle の列に混ざらないことの確認も兼ねる。
    const rng = P.createRandom(P.seedFrom("R0-mv-damage"));
    const rolls = [];

    const out = [];
    let prevHeld = false;
    let cooldown = 0;
    let frames = 0;
    // フレーム間隔は一定にしない。実際の入力は毎フレーム同じでは無いので、
    // 「当たる間隔がまちまちでも列が変わらない」を測る。
    const pattern = [7, 3, 11, 5, 2, 9, 4, 13, 6, 8];
    while (out.length < HITS && frames < 200000) {
        const move = ((frames >> 5) & 1) ? 1 : -1;
        const held = (frames % 37) === 0;
        P.step(body, { move: move, jump: held && !prevHeld, jumpHeld: held }, room);
        prevHeld = held;
        frames += 1;
        if (cooldown > 0) { cooldown -= 1; continue; }
        const r = B.calcDamage(b.state, b.attacker, b.defender, CLAUSE);
        out.push([r.damage, r.critical ? 1 : 0, r.hit, r.elementCoef]);
        if (rolls.length < 6) { rolls.push(rng.next()); }
        cooldown = pattern[out.length % pattern.length];
    }
    return {
        seq: out, rngCount: b.state.rngCount, frames: frames,
        physRolls: rolls, bodyX: body.x, bodyY: body.y
    };
}

const tb = turnBased(SEED);
const rt = realTime(SEED);
const bumped = realTime(SEED, { bumpRngCount: 1 });
// 種を変えたら列は変わらなければならない。等しさの検査が「常に等しい」を
// 見ているだけでないことの裏取り。
const otherSeed = realTime(SEED + 1);

function equal(a, b) {
    if (a.length !== b.length) { return false; }
    for (let i = 0; i < a.length; i++) {
        for (let k = 0; k < a[i].length; k++) {
            if (a[i][k] !== b[i][k]) { return false; }
        }
    }
    return true;
}

function firstDiff(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        for (let k = 0; k < a[i].length; k++) {
            if (a[i][k] !== b[i][k]) { return { index: i, field: k, a: a[i], b: b[i] }; }
        }
    }
    return null;
}

const out = {
    hits: HITS,
    seed: SEED,
    turnBased: {
        count: tb.seq.length, rngCount: tb.rngCount,
        head: tb.seq.slice(0, 5), tail: tb.seq.slice(-3),
        // 結算が動いていること自体の確認。全部 0 なら比較は無意味。
        total: tb.seq.reduce(function (s, r) { return s + r[0]; }, 0),
        criticals: tb.seq.filter(function (r) { return r[1] === 1; }).length,
        distinct: new Set(tb.seq.map(function (r) { return r[0]; })).size
    },
    realTime: {
        count: rt.seq.length, rngCount: rt.rngCount, frames: rt.frames,
        head: rt.seq.slice(0, 5), tail: rt.seq.slice(-3),
        physRolls: rt.physRolls, bodyX: rt.bodyX, bodyY: rt.bodyY
    },
    matches: equal(tb.seq, rt.seq),
    firstDiff: firstDiff(tb.seq, rt.seq),
    bumpedMatches: equal(tb.seq, bumped.seq),
    bumpedFirstDiff: firstDiff(tb.seq, bumped.seq),
    otherSeedMatches: equal(tb.seq, otherSeed.seq)
};

process.stdout.write(JSON.stringify(out, null, 1));
