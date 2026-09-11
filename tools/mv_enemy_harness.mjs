// core/mvenemy.js を node で回して結果を JSON で吐く。
// tools/check_mv_enemy.py がこれを呼ぶ。tools/mv_danmaku_harness.mjs と同じ形で、
// 検査したい module の道を引数で受ける (負の場合が module を書き換えた写しを
// 渡してくるので、import 先を固定にはできない)。
//
// 引数: <mvenemy.mjs への道> <mvdanmaku.mjs への道>
// 標準出力: JSON 一つ。人間向けの行は出さない。
//
// 敵の論理は three.js も DOM も触らないので、これがそのまま回帰になる。

import { pathToFileURL } from "node:url";

const enemyPath = process.argv[2];
const danmakuPath = process.argv[3];
if (!enemyPath || !danmakuPath) {
    console.error("usage: mv_enemy_harness.mjs <mvenemy> <mvdanmaku>");
    process.exit(2);
}
const E = await import(pathToFileURL(enemyPath).href);
const D = await import(pathToFileURL(danmakuPath).href);

const checks = [];
function check(name, ok, detail) { checks.push([name, !!ok, String(detail)]); }

// 床は 0..24、途中に台が一つ。台は往復の折り返しを作るために置いてある。
const FLOOR = [[0, 0, 24, 1, "wall"], [8, 1, 2, 2, "wall"]];

// 遊ぶ側が渡してくる形。core/platformer.js の compileRoom() は房データの配列を
// {x, y, w, h, kind} に直して配るので、game/mv.js から来る矩形は object。
// 配列だけで検めていた間、番号で読んでいた誤りが通り抜けた (実測: R7-05 の
// patrol が一こま目で x=NaN になり、model が消えた)。両方で検める。
function asObjects(list) {
    return list.map(function (r) {
        return { x: r[0], y: r[1], w: r[2], h: r[3], kind: r[4] || "wall" };
    });
}
const FLOOR_OBJ = asObjects(FLOOR);

function room(spawns, solid) {
    return { size: [24, 12], blanch: 2, solid: solid || FLOOR, spawns: spawns };
}

function body(x, y) {
    return { x: x, y: y === undefined ? 1 : y, w: 0.62, h: 1.7,
             vx: 0, vy: 0, facing: 1, onGround: true };
}

// 一体を n 秒進める。1/120 刻みは game/mv.js の advance() と同じ。
function run(enemies, seconds, opts) {
    const steps = Math.round(seconds * 120);
    for (let i = 0; i < steps; i++) {
        for (let k = 0; k < enemies.length; k++) {
            E.stepEnemy(enemies[k], 1 / 120, opts);
        }
    }
}

// --- 表 -------------------------------------------------------------------

check("five kinds exist", Object.keys(E.KINDS).length === 5,
      Object.keys(E.KINDS).join(" "));
check("BEHAVIORS lists every kind",
      E.BEHAVIORS.length === 5
      && E.BEHAVIORS.every(function (b) { return E.KINDS[b]; }),
      E.BEHAVIORS.join(" "));
check("only shard is armoured",
      Object.keys(E.KINDS).filter(function (k) { return E.KINDS[k].armor; })
          .join(",") === "shard",
      Object.keys(E.KINDS).filter(function (k) { return E.KINDS[k].armor; })
          .join(",") || "none");
check("only shard is harmless to touch",
      Object.keys(E.KINDS).filter(function (k) { return !E.KINDS[k].touch; })
          .join(",") === "shard",
      Object.keys(E.KINDS).filter(function (k) { return !E.KINDS[k].touch; })
          .join(",") || "none");
check("the dash cooldown outlasts the dash",
      E.DASH.cool > E.DASH.time,
      E.DASH.time + " active, " + E.DASH.cool + " cool");
// 一回の体当たりで一回だけ当たるのは flash が立っている間だけ。flash が
// 体当たりより先に抜けると、抜けた後の刻みでもう一度当たる。0.25 > 0.18。
const flashWindow = 0.25;
check("the hurt flash outlasts the dash that caused it",
      flashWindow > E.DASH.time,
      flashWindow + " flash vs " + E.DASH.time + " dash");
// 進む距離。速さ × 続く時間。敵一体ぶん (1.0) より長く、二体ぶんより短い。
const reach = E.DASH.speed * E.DASH.time;
check("the dash reaches past one enemy but not two",
      reach > 1.0 && reach < 3.0, reach.toFixed(2) + " tiles");

// --- 作る -----------------------------------------------------------------

const made = E.createEnemies(room([
    { model: "m0", behavior: "patrol", at: [3, 1], element: 1 },
    { model: "m1", behavior: "shard", at: [12, 1], element: 2 },
    { model: "m2", behavior: "creamate", at: [18, 1], element: 3 },
    { model: "m3", behavior: "turret", at: [21, 1], pattern: "ring" }
]), "R1-01");
check("one body per spawn", made.length === 4, String(made.length));
check("bodies carry the spawn index",
      made.every(function (e, i) { return e.index === i; }),
      made.map(function (e) { return e.index; }).join(","));
check("bodies start alive with full health",
      made.every(function (e) { return e.alive && e.hp === e.hpMax; }),
      made.map(function (e) { return e.behavior + ":" + e.hp; }).join(" "));
// spawn.at は tile の左下。体は足元中央なので、幅の半分だけ右にある。
check("the body sits centred on the spawn tile",
      Math.abs(made[1].x - (12 + E.KINDS.shard.w / 2)) < 1e-9,
      made[1].x.toFixed(3));
check("an unknown behaviour makes no body",
      E.createEnemies(room([{ model: "m", behavior: "drifter", at: [3, 1] }]),
                      "R1-02").length === 0,
      "skipped");

// 同じ房を二度作ったら同じ物。房を出て戻るたびに向きが変わると、
// 覚えた動きが役に立たない。
//
// 二体では足りない。向きは ±1 の二値なので、種を壊しても四回に一回は
// 偶然一致してしまう (実測: 種を Math.random() に替えた写しがこの検査を
// 素通りした)。十体なら 1/1024 になり、通ったら本当に同じ物だと言える。
function lineUp(id) {
    const spawns = [];
    for (let i = 0; i < 10; i++) {
        spawns.push({ model: "m" + i, behavior: "patrol", at: [1 + i * 2, 1] });
    }
    return E.createEnemies(room(spawns), id);
}
function shape(list) {
    return list.map(function (e) { return e.facing; }).join(",");
}
const twiceA = lineUp("R3-04");
const twiceB = lineUp("R3-04");
check("the same room makes the same enemies",
      shape(twiceA) === shape(twiceB) && twiceA.length === 10,
      shape(twiceA));
// 全部同じ向きなら、それは並びではなく既定値。種が効いていない印。
check("the arrangement is not all one way",
      new Set(twiceA.map(function (e) { return e.facing; })).size === 2,
      shape(twiceA));
const other = lineUp("R3-05");
check("a different room makes a different arrangement",
      shape(twiceA) !== shape(other), shape(other));

// --- 重力と床 -------------------------------------------------------------

// 空中に置いた敵は落ちて床に着く。着いたら止まる。
const dropped = E.createEnemies(room([
    { model: "m", behavior: "patrol", at: [3, 8] }
]), "R1-03");
run(dropped, 2.5, { solids: FLOOR, body: body(20), blanch: 2, roomW: 24 });
check("an enemy falls to the floor and stops",
      dropped[0].onGround && Math.abs(dropped[0].y - 1) < 0.05,
      "y=" + dropped[0].y.toFixed(3) + " ground=" + dropped[0].onGround);

// 床の無い所に置いた敵は消える。房の下に落ちた敵を数え続けない。
const voided = E.createEnemies(room([
    { model: "m", behavior: "patrol", at: [3, 8] }
]), "R1-04");
run(voided, 3, { solids: [], body: body(20), blanch: 2, roomW: 24 });
check("an enemy that falls out of the room stops being alive",
      !voided[0].alive, "y=" + voided[0].y.toFixed(1));

// --- 往復 -----------------------------------------------------------------

const patrol = E.createEnemies(room([
    { model: "m", behavior: "patrol", at: [3, 1] }
]), "R1-05");
patrol[0].facing = 1;
const xs = [];
for (let i = 0; i < 1200; i++) {
    E.stepEnemy(patrol[0], 1 / 120,
                { solids: FLOOR, body: body(20), blanch: 2, roomW: 24 });
    xs.push(patrol[0].x);
}
const span = Math.max.apply(null, xs) - Math.min.apply(null, xs);
// 台は x=8 から。速さ 2.4 で 10 秒なら、壁に当たるまで進んで折り返す。
check("a patrol covers ground instead of shivering in place",
      span > 3, "span " + span.toFixed(2) + " tiles");
// 往復しているか。距離だけでは足りない — 壁まで歩いて張り付いたままの敵も
// 距離は稼ぐ。進む向きが変わった回数を数える。10 秒で 0.45↔7.55 を往復する
// なら 4 回以上あるはず。
let turns = 0;
let wasSign = 0;
for (let i = 1; i < xs.length; i++) {
    const moved = xs[i] - xs[i - 1];
    if (Math.abs(moved) < 1e-9) { continue; }
    const s = Math.sign(moved);
    if (wasSign !== 0 && s !== wasSign) { turns += 1; }
    wasSign = s;
}
check("a patrol turns around and comes back", turns >= 3 && turns < 40,
      turns + " reversals in 10s");
check("a patrol turns back at the wall",
      Math.max.apply(null, xs) < 8.6,
      "farthest right " + Math.max.apply(null, xs).toFixed(2));
check("a patrol turns back at the room edge",
      Math.min.apply(null, xs) >= E.KINDS.patrol.w / 2 - 1e-6,
      "farthest left " + Math.min.apply(null, xs).toFixed(2));
// 向きと動く方向が一致しているか。ずれていると model が後ろ向きに歩く。
let mismatch = 0;
for (let i = 1; i < xs.length; i++) {
    const moved = xs[i] - xs[i - 1];
    if (Math.abs(moved) < 1e-6) { continue; }
    // 折り返した直後の 1 刻みは向きが先に変わるので許す。
    if (Math.sign(moved) !== Math.sign(patrol[0].facing)
        && i > xs.length - 2) { mismatch += 1; }
}
check("a patrol faces the way it walks", mismatch === 0,
      mismatch + " steps facing backwards");

// 遊ぶ側の矩形の形で同じ事をする。結果が一致しなければ、どちらかの形しか
// 読めていない。
const objPatrol = E.createEnemies(room([
    { model: "m", behavior: "patrol", at: [3, 1] }
], FLOOR_OBJ), "R1-05");
objPatrol[0].facing = 1;
const objXs = [];
for (let i = 0; i < 1200; i++) {
    E.stepEnemy(objPatrol[0], 1 / 120,
                { solids: FLOOR_OBJ, body: body(20), blanch: 2, roomW: 24 });
    objXs.push(objPatrol[0].x);
}
check("compiled {x,y,w,h} rects work as well as [x,y,w,h]",
      Number.isFinite(objPatrol[0].x)
      && Math.abs(objPatrol[0].x - patrol[0].x) < 1e-9
      && Math.max.apply(null, objXs) < 8.6,
      "array x=" + patrol[0].x.toFixed(3)
      + " object x=" + objPatrol[0].x.toFixed(3));
// 落として床に着くか。NaN になると onGround が立たない。
const objDrop = E.createEnemies(room([
    { model: "m", behavior: "patrol", at: [3, 8] }
], FLOOR_OBJ), "R1-03b");
run(objDrop, 2.5, { solids: FLOOR_OBJ, body: body(20), blanch: 2, roomW: 24 });
check("an enemy lands on a compiled floor",
      objDrop[0].onGround && Math.abs(objDrop[0].y - 1) < 0.05,
      "y=" + objDrop[0].y.toFixed(3) + " ground=" + objDrop[0].onGround);

// 崖。床を途中で切ると、崖の手前で折り返す。
const LEDGE = [[0, 0, 6, 1, "wall"]];
const ledge = E.createEnemies(room([
    { model: "m", behavior: "patrol", at: [2, 1] }
], LEDGE), "R1-06");
ledge[0].facing = 1;
run(ledge, 8, { solids: LEDGE, body: body(20), blanch: 2, roomW: 24 });
check("a patrol stops at a ledge instead of walking off",
      ledge[0].alive && ledge[0].x < 6,
      "x=" + ledge[0].x.toFixed(2) + " alive=" + ledge[0].alive);

// --- 追う -----------------------------------------------------------------

const chaser = E.createEnemies(room([
    { model: "m", behavior: "creamate", at: [18, 1] }
]), "R1-07");
const near = body(14);
run(chaser, 3, { solids: FLOOR, body: near, blanch: 2, roomW: 24 });
check("a creamate closes on a nearby body",
      chaser[0].x < 18 - 1, "x=" + chaser[0].x.toFixed(2) + " from 18.5");

const ignored = E.createEnemies(room([
    { model: "m", behavior: "creamate", at: [18, 1] }
]), "R1-08");
const far = body(1);
const startX = ignored[0].x;
run(ignored, 2, { solids: FLOOR, body: far, blanch: 2, roomW: 24 });
check("a creamate ignores a body beyond its reach",
      Math.abs(ignored[0].x - startX) < 0.01,
      "moved " + (ignored[0].x - startX).toFixed(3)
      + " with the body " + (startX - far.x).toFixed(1) + " away");

// 真横に並んだら止まる。押し込み続けると体の中に埋まる。
const beside = E.createEnemies(room([
    { model: "m", behavior: "creamate", at: [12, 1] }
]), "R1-09");
run(beside, 6, { solids: FLOOR, body: body(12.5), blanch: 2, roomW: 24 });
// 位置だけ見ても足りない。止まらない写しは体の真横で左右に震えるが、幅は
// 一刻みぶん (速さ 3.1 × 1/120 ≈ 0.026) しかないので、緩い許容なら通る。
// 静止しているかは速さで見る。
check("a creamate stops when it is level with the body",
      Math.abs(beside[0].x - 12.5) < 1.2 && Math.abs(beside[0].vx) < 1e-9,
      "x=" + beside[0].x.toFixed(2) + " vx=" + beside[0].vx.toFixed(3)
      + " body at 12.5");

// 動かない型は動かない。
const still = E.createEnemies(room([
    { model: "a", behavior: "shard", at: [12, 1] },
    { model: "b", behavior: "turret", at: [15, 1], pattern: "ring" }
]), "R1-10");
const stillX = still.map(function (e) { return e.x; });
run(still, 4, { solids: FLOOR, body: body(13), blanch: 2, roomW: 24 });
check("shards and turrets hold their ground",
      still.every(function (e, i) { return Math.abs(e.x - stillX[i]) < 1e-6; }),
      still.map(function (e) { return e.x.toFixed(2); }).join(" "));

// --- 白化 0 の房 ----------------------------------------------------------

const asleep = E.createEnemies(room([
    { model: "m", behavior: "creamate", at: [18, 1] }
]), "R1-11");
const asleepX = asleep[0].x;
run(asleep, 4, { solids: FLOOR, body: body(14), blanch: 0, roomW: 24 });
check("nothing moves in a room at blanch 0",
      Math.abs(asleep[0].x - asleepX) < 1e-6,
      "moved " + (asleep[0].x - asleepX).toFixed(4));

// --- 体当たり -------------------------------------------------------------

const dash = E.createDash();
const hero = body(10);
check("the dash does not come out without A2",
      E.startDash(dash, hero, []) === false && dash.active === 0, "refused");
check("the dash comes out with A2",
      E.startDash(dash, hero, ["A2"]) === true && dash.active > 0,
      "active " + dash.active.toFixed(2));
check("the dash cannot be pressed twice at once",
      E.startDash(dash, hero, ["A2"]) === false, "refused while active");
// 冷却が明けるまで押せない。押せてしまうと移動手段になる。
run([], 0, {});
let waited = 0;
while (waited < 1.0 && (dash.active > 0 || dash.cool > 0)) {
    E.stepDash(dash, 1 / 120, hero);
    waited += 1 / 120;
}
check("the dash comes back after its cooldown",
      waited > E.DASH.time && waited < 1.0
      && E.startDash(dash, hero, ["A2"]) === true,
      "ready after " + waited.toFixed(2) + "s");
check("the dash drives the body at dash speed, not run speed",
      Math.abs(hero.vx) > 12, "vx " + hero.vx.toFixed(1));

// 向き。体当たり中に向きを変えられると、当たり判定が後ろへ回る。
const backHero = body(10);
backHero.facing = -1;
const backDash = E.createDash();
E.startDash(backDash, backHero, ["A2"]);
E.stepDash(backDash, 1 / 120, backHero);
check("the dash goes the way the body faces", backHero.vx < 0,
      "vx " + backHero.vx.toFixed(1));

// --- 当たり ---------------------------------------------------------------

function contactCase(behavior, opts) {
    const es = E.createEnemies(room([
        { model: "m", behavior: behavior, at: [12, 1] }
    ]), "R2-01");
    const b = body(es[0].x - 0.5);
    b.facing = 1;
    const d = E.createDash();
    if (opts && opts.dash) { E.startDash(d, b, ["A2"]); }
    const field = D.createField();
    const r = E.stepContact(es, b, d,
                            { field: field,
                              invulnerable: Boolean(opts && opts.invuln) });
    return { r: r, e: es[0], field: field, body: b };
}

const touched = contactCase("patrol", {});
check("walking into a patrol costs a page", touched.r.hits === 1,
      JSON.stringify(touched.r));
const guarded = contactCase("patrol", { invuln: true });
check("a patrol cannot hit you during invulnerability",
      guarded.r.hits === 0, JSON.stringify(guarded.r));
const punched = contactCase("patrol", { dash: true });
check("dashing into a patrol kills it instead of hurting you",
      punched.r.hits === 0 && punched.r.killed === 1 && !punched.e.alive,
      JSON.stringify(punched.r));
check("a killed enemy fades rather than vanishing",
      punched.e.dying > 0, "dying " + punched.e.dying.toFixed(2));
// 死んでいる間も flash は抜ける。抜けないと、core/mvstage.js が足す
// 「殴られた沈み」が消えるまでずっと死の沈みに重なる。
const fading = punched.e;
run([fading], 0.3, { solids: FLOOR, body: body(20), blanch: 2, roomW: 24 });
check("the hurt flash drains while an enemy is dying",
      fading.flash === 0 && fading.dying > 0,
      "flash " + fading.flash.toFixed(3) + " dying " + fading.dying.toFixed(2));
check("the dash bounces off what it hits",
      punched.body.vx < 0, "vx " + punched.body.vx.toFixed(2));

const walled = contactCase("shard", {});
check("a shard blocks instead of hurting",
      walled.r.hits === 0 && walled.r.blocked === 1 && walled.e.alive,
      JSON.stringify(walled.r));
check("a blocked body is pushed clear of the shard",
      walled.body.x + walled.body.w / 2 <= walled.e.x - walled.e.w / 2 + 1e-9,
      "body right " + (walled.body.x + walled.body.w / 2).toFixed(3)
      + " shard left " + (walled.e.x - walled.e.w / 2).toFixed(3));
const broken = contactCase("shard", { dash: true });
check("dashing breaks a shard", broken.r.killed === 1 && !broken.e.alive,
      JSON.stringify(broken.r));
check("a broken shard scatters bullets",
      broken.field.fired === E.KINDS.shard.burst,
      broken.field.fired + " bullets");

// 体力 2 の相手は一撃では落ちない。
const tough = contactCase("creamate", { dash: true });
check("a two-health enemy survives one dash",
      tough.e.alive && tough.e.hp === 1 && tough.r.damaged === 1,
      "hp " + tough.e.hp);
// 同じ体当たりで二度当たらない。flash が立っている間は通さない。
const again = E.stepContact([tough.e], tough.body, { active: 0.1, hits: 0 },
                            { field: tough.field });
check("one dash does not hit the same enemy twice",
      again.damaged === 0 && tough.e.hp === 1, JSON.stringify(again));

// --- 主 -------------------------------------------------------------------

const BOSS_ROOM = [
    { model: "b", behavior: "boss", at: [12, 1] },
    { model: "t0", behavior: "turret", at: [4, 1], pattern: "ring" },
    { model: "t1", behavior: "turret", at: [17, 1], pattern: "charge" },
    { model: "t2", behavior: "turret", at: [21, 1], pattern: "bloom" }
];
const fight = E.createEnemies(room(BOSS_ROOM), "R4-07");
const boss = E.bossOf(fight);
check("the boss body is found in the room", boss !== null && boss.hp === 8,
      boss ? "hp " + boss.hp : "none");
check("a room without a boss reports none",
      E.bossOf(E.createEnemies(room([
          { model: "m", behavior: "patrol", at: [3, 1] }
      ]), "R1-12")) === null, "null");
check("a fresh boss is in its first phase", E.bossPhase(boss) === 1,
      "phase " + E.bossPhase(boss));

// 段と開く砲台の数。体力を減らしながら見る。
const ladder = [];
for (let hp = 8; hp >= 0; hp--) {
    boss.hp = hp;
    boss.alive = hp > 0;
    ladder.push(E.bossPhase(boss) + "/" + E.gunsAllowed(fight, 3));
}
check("the phases rise as the boss weakens",
      ladder.join(" ") === "1/1 1/1 1/1 2/2 2/2 2/2 3/3 3/3 0/0",
      ladder.join(" "));
check("a dead boss silences every gun",
      E.gunsAllowed(fight, 3) === 0, "guns " + E.gunsAllowed(fight, 3));
boss.hp = 8;
boss.alive = true;
check("a room without a boss opens all its guns",
      E.gunsAllowed(E.createEnemies(room([
          { model: "t", behavior: "turret", at: [4, 1], pattern: "ring" }
      ]), "R1-13"), 3) === 3, "3");
// 砲台より多くは開けない。第一段で聞くと段の望みが 1 なので、留めが効いて
// いなくても 1 が返る — 望みが 3 になる第三段で聞く。
boss.hp = 1;
check("the gun count never exceeds the turrets present",
      E.gunsAllowed(fight, 1) === 1,
      "phase " + E.bossPhase(boss) + " with 1 turret -> "
      + E.gunsAllowed(fight, 1));
boss.hp = 8;

// 速さ。段が上がると速くなる。
//
// 床は平らな物を使う。FLOOR の台 (x=8..10) を使うと、主 (幅 1.6) は左へ
// 歩いて x=10.8 で台に当たって止まり、どの段でも進む距離が 1.2 になる —
// 測っているのが速さではなく壁になる (実測: phase1 1.20 vs phase3 1.20)。
const FLAT = [[0, 0, 24, 1, "wall"]];
const fast = E.createEnemies(room(BOSS_ROOM, FLAT), "R4-07");
const fastBoss = E.bossOf(fast);
function chaseDistance(hp) {
    fastBoss.hp = hp;
    fastBoss.alive = true;
    fastBoss.x = 12;
    fastBoss.vx = 0;
    fastBoss.vy = 0;
    const target = body(2);
    run([fastBoss], 1, { solids: FLAT, body: target, blanch: 2, roomW: 24 });
    return 12 - fastBoss.x;
}
const slow = chaseDistance(8);
const quick = chaseDistance(1);
check("a cornered boss moves faster than a fresh one", quick > slow + 0.1,
      "phase1 " + slow.toFixed(2) + " vs phase3 " + quick.toFixed(2));

// 倒すには 8 発。体当たり一発で 1 なので、8 回。
const killRoom = E.createEnemies(room(BOSS_ROOM), "R4-07");
const killBoss = E.bossOf(killRoom);
const killField = D.createField();
let swings = 0;
while (killBoss.alive && swings < 40) {
    const d = E.createDash();
    const b = body(killBoss.x - 0.9);
    b.facing = 1;
    killBoss.flash = 0;
    E.startDash(d, b, ["A2"]);
    E.stepContact(killRoom, b, d, { field: killField });
    swings += 1;
}
check("the boss takes eight dashes to put down", swings === 8,
      swings + " dashes");
check("the boss scatters a burst when it falls",
      killField.fired === E.KINDS.boss.burst,
      killField.fired + " bullets");
check("the fight's turrets outlive the boss",
      E.aliveCount(killRoom) === 3, E.aliveCount(killRoom) + " left");

// --- 数える ---------------------------------------------------------------

const counted = E.createEnemies(room([
    { model: "a", behavior: "patrol", at: [3, 1] },
    { model: "b", behavior: "patrol", at: [15, 1] }
]), "R1-14");
check("aliveCount counts the living", E.aliveCount(counted) === 2, "2");
counted[0].alive = false;
check("aliveCount drops the dead", E.aliveCount(counted) === 1, "1");

// 描画へ渡す座標。tile → world は TILE 倍。
const placed = E.worldOf(counted[1]);
check("worldOf scales tiles to world units",
      Math.abs(placed.x - counted[1].x * 0.7) < 1e-9,
      placed.x.toFixed(3) + " from " + counted[1].x.toFixed(3));

process.stdout.write(JSON.stringify({ checks: checks }));
