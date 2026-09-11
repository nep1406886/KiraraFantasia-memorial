// core/mvdanmaku.js を node で回して結果を JSON で吐く。
// tools/check_mv_danmaku.py がこれを呼ぶ。tools/mv_move_harness.mjs と同じ形で、
// 検査したい module の道を引数で受ける (負の場合が module を書き換えた写しを
// 渡してくるので、import 先を固定にはできない)。
//
// 引数: <mvdanmaku.mjs への道>
// 標準出力: JSON 一つ。人間向けの行は出さない。
//
// 弾幕の論理は three.js も DOM も触らないので、これがそのまま回帰になる。

import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath) {
    console.error("usage: mv_danmaku_harness.mjs <path to mvdanmaku module>");
    process.exit(2);
}
const D = await import(pathToFileURL(modulePath).href);

const checks = [];
function check(name, ok, detail) { checks.push([name, !!ok, String(detail)]); }

const ROOM = {
    size: [24, 12],
    spawns: [
        { model: "model_en_10000", at: [6, 4], behavior: "turret",
          pattern: "ring", element: 1 },
        { model: "model_en_10001", at: [16, 6], behavior: "turret",
          pattern: "aimed", element: 1 },
        { model: "model_en_10002", at: [10, 8], behavior: "turret",
          pattern: "wall", element: 1 },
        { model: "model_en_10003", at: [4, 2], behavior: "patrol", element: 1 }
    ]
};

function run(seconds, opts) {
    const o = opts || {};
    const field = D.createField();
    const turrets = D.createTurrets(o.room || ROOM, o.roomId || "R1-08");
    const charge = D.createCharge();
    const body = o.body === null ? null
        : (o.body || { x: 10, y: 1, w: 0.62, h: 1.7 });
    const total = { fired: 0, hits: 0, grazes: 0, expired: 0, blocked: 0 };
    const steps = Math.round(seconds * 120);
    for (let s = 0; s < steps; s++) {
        turrets.forEach(function (t) {
            total.fired += D.stepTurret(field, t, 1 / 120, body,
                                        o.blanch === undefined ? 2 : o.blanch);
        });
        const r = D.stepField(field, 1 / 120, {
            body: body, solids: o.solids || null,
            roomW: (o.room || ROOM).size[0], roomH: (o.room || ROOM).size[1],
            invulnerable: o.invulnerable === true
        });
        total.hits += r.hits;
        total.grazes += r.grazes;
        total.expired += r.expired;
        total.blocked += r.blocked;
        if (r.grazes) { D.addGraze(charge, r.grazes); }
    }
    return { field, turrets, charge, total };
}

// --- 撃つ -----------------------------------------------------------------

const ten = run(10);
check("turrets are only the turret-behaviour spawns",
      ten.turrets.length === 3, ten.turrets.length + " of 4 spawns");
check("turrets fire", ten.total.fired > 0, ten.total.fired + " bullets in 10s");
check("bullets are alive mid-flight", ten.field.alive > 0,
      ten.field.alive + " alive");
check("bullets expire", ten.total.expired > 0, ten.total.expired + " expired");

// 位相がずれている。全部同じ拍だと画面が点滅する。
const phases = ten.turrets.map(function (t) { return t.timer; });
const distinct = new Set(phases.map(function (p) { return p.toFixed(4); }));
check("turret phases are staggered", distinct.size === phases.length,
      phases.map(function (p) { return p.toFixed(2); }).join(" "));

// --- 型ごと ---------------------------------------------------------------
//
// PATTERN_IDS の全部を一つずつ撃たせる。上の ROOM は ring/aimed/wall しか
// 使っていないので、それだけだと残りは一度も撃たれないまま通る — 実際 glow と
// aura は「絵札と席はあるが撃つ型が無い」状態で暫く残っていた。
//
// 一つずつ別の房で回すのは、同じ房に七門並べると容量 256 を取り合って
// 「撃ったのに消された」が混ざるため。
const patternRows = {};
D.PATTERN_IDS.forEach(function (id) {
    const room = {
        size: [24, 12],
        spawns: [{ model: "model_en_10000", at: [11, 5], behavior: "turret",
                   pattern: id, element: 1 }]
    };
    // 前摇のある型 (burst 0.55s, charge 0.8s) と period の長い型 (bloom 3.2s)
    // が一度は撃てる長さ。
    const r = run(8, { room: room, roomId: "R5-0" + (D.PATTERN_IDS.indexOf(id) + 1),
                       body: { x: 3, y: 1, w: 0.62, h: 1.7 } });
    const roles = new Set();
    for (let i = 0; i < r.field.capacity; i++) {
        if (r.field.role[i] !== 0) { roles.add(D.ROLE_NAMES[r.field.role[i]]); }
    }
    patternRows[id] = {
        fired: r.total.fired,
        role: D.PATTERN_ROLE[id],
        seen: Array.from(roles),
        turrets: r.turrets.length
    };
    check("pattern " + id + " fires", r.total.fired > 0,
          r.total.fired + " bullets in 8s");
    check("pattern " + id + " draws as " + D.PATTERN_ROLE[id],
          roles.size === 0 || (roles.size === 1
              && roles.has(D.PATTERN_ROLE[id])),
          Array.from(roles).join(",") || "none alive at the end");
});

// 五つの役すべてに撃つ型がある。役だけあって型が無いと、Points の席と絵札を
// 確保して誰も使わない。
const sourced = new Set(D.PATTERN_IDS.map(function (id) {
    return D.PATTERN_ROLE[id];
}));
const named = D.ROLE_NAMES.filter(function (n) { return n; });
check("every role has at least one pattern that fires it",
      named.every(function (n) { return sourced.has(n); }),
      named.filter(function (n) { return !sourced.has(n); }).join(",")
      || named.length + " roles all sourced");

// bloom は二重の輪。内と外で速さが違う事を、速さの種類数で見る。
const bloomRoom = {
    size: [24, 12],
    spawns: [{ model: "model_en_10000", at: [11, 5], behavior: "turret",
               pattern: "bloom", element: 1 }]
};
const bloom = run(3.4, { room: bloomRoom, roomId: "R4-07",
                         body: { x: 3, y: 1, w: 0.62, h: 1.7 } });
const speeds = new Set();
for (let i = 0; i < bloom.field.capacity; i++) {
    if (bloom.field.role[i] === 0) { continue; }
    const v = Math.hypot(bloom.field.vx[i], bloom.field.vy[i]);
    speeds.add(v.toFixed(2));
}
check("bloom fires two rings at different speeds", speeds.size >= 2,
      Array.from(speeds).sort().join(" "));

// charge は前摇があるので、撃つと決めてから実際に出るまで間がある。
//
// timer を 0 に置いてから測る事。房ごとの位相 (rand で 0..period) を待つだけの
// 検めだと前摇が 0 でも「まだ撃っていない」が通ってしまう — 実際それで負の場合が
// 赤くならなかった。撃つ決心をした直後から数えるのが前摇の検め方。
function telegraphProbe(pattern) {
    const room = {
        size: [24, 12],
        spawns: [{ model: "model_en_10000", at: [11, 5], behavior: "turret",
                   pattern: pattern, element: 1 }]
    };
    const field = D.createField();
    const turrets = D.createTurrets(room, "R3-02");
    const t = turrets[0];
    t.timer = 0;                     // 撃つべき時が今。
    const body = { x: 3, y: 1, w: 0.62, h: 1.7 };
    // 一歩目で「前摇に入る」か「もう撃つ」かが決まる。
    const first = D.stepTurret(field, t, 1 / 120, body, 2);
    let firedBy = -1;
    let elapsed = 1 / 120;
    for (let i = 0; i < 240 && firedBy < 0; i++) {
        if (D.stepTurret(field, t, 1 / 120, body, 2) > 0) { firedBy = elapsed; }
        elapsed += 1 / 120;
    }
    return { first: first, firedBy: firedBy, telegraph: t.telegraph };
}
const charged = telegraphProbe("charge");
check("charge holds its shot through the telegraph",
      charged.first === 0 && charged.firedBy >= charged.telegraph * 0.9,
      "fired " + charged.first + " at once, then after "
      + charged.firedBy.toFixed(2) + "s (telegraph " + charged.telegraph + ")");
// 対照。前摇の無い型は決心した一歩目で出る。
const ringed = telegraphProbe("ring");
check("a pattern with no telegraph fires at once",
      ringed.first > 0 && ringed.telegraph === 0,
      "fired " + ringed.first + " on the first step");

// --- 再現性 ---------------------------------------------------------------
//
// 同じ房 id なら毎回同じ弾幕。Math.random() を使っていないことの実測。
const a = run(4), b = run(4);
check("same room id gives the same danmaku",
      a.total.fired === b.total.fired && a.total.grazes === b.total.grazes
      && a.field.alive === b.field.alive,
      a.total.fired + "/" + b.total.fired + " fired, "
      + a.total.grazes + "/" + b.total.grazes + " grazed");
const other = run(4, { roomId: "R2-03" });
check("a different room id gives a different one",
      other.turrets.map(function (t) { return t.timer.toFixed(4); }).join()
      !== ten.turrets.map(function (t) { return t.timer.toFixed(4); }).join(),
      "phases differ");

// --- 白化度 ---------------------------------------------------------------
//
// §4.6 の表: 白化度 0 の房は存档点。敵が出ないのだから、砲台も撃たない。
const calm = run(6, { blanch: 0 });
check("blanch 0 rooms are silent (they are the save points)",
      calm.total.fired === 0 && calm.field.alive === 0,
      calm.total.fired + " fired");
const loud = run(6, { blanch: 1 });
check("blanch 1 rooms do fire", loud.total.fired > 0,
      loud.total.fired + " fired");

// --- 掠りと被弾 -----------------------------------------------------------

const near = run(10, { body: { x: 6, y: 3.2, w: 0.62, h: 1.7 } });
check("standing in the danmaku both grazes and is hit",
      near.total.grazes > 0 && near.total.hits > 0,
      near.total.grazes + " grazes, " + near.total.hits + " hits");

// 一つの弾から掠りは一度だけ。取れる回数が撃った弾数を超えたら二重取り。
check("a bullet can be grazed only once",
      near.total.grazes <= near.total.fired,
      near.total.grazes + " grazes <= " + near.total.fired + " fired");

// 当たった弾から掠りも取れると被弾が得になる。当たり半径の内側に居続けて、
// 掠りが被弾より多く増えないことを見る。
{
    const field = D.createField();
    const body = { x: 5, y: 0, w: 0.62, h: 1.7 };
    // 主角の真上に、真下へ来る弾を一発。必ず当たる進路。
    D.spawnBullet(field, 5, 3, 0, -6, "bullet");
    let hits = 0, grazes = 0;
    for (let s = 0; s < 240; s++) {
        const r = D.stepField(field, 1 / 120, { body: body, roomW: 24, roomH: 12 });
        hits += r.hits; grazes += r.grazes;
    }
    // 掠り半径を通ってから当たるので掠りは 1、被弾も 1。掠りが 2 以上なら
    // 同じ弾を数え直している。
    check("a bullet that hits grazes at most once first",
          hits === 1 && grazes === 1, hits + " hit, " + grazes + " grazed");
}

// 無敵中は当たらないが、掠りは取れる (弾幕の中に居た事実は変わらない)。
const invuln = run(10, { body: { x: 6, y: 3.2, w: 0.62, h: 1.7 },
                         invulnerable: true });
check("invulnerable takes no hits", invuln.total.hits === 0,
      invuln.total.hits + " hits");
check("invulnerable still grazes", invuln.total.grazes > 0,
      invuln.total.grazes + " grazes");

// --- とっておき -----------------------------------------------------------

{
    const charge = D.createCharge();
    check("an empty charge cannot fire", !D.canFire(charge), "value 0");
    const field = D.createField();
    for (let i = 0; i < 20; i++) { D.spawnBullet(field, i, 5, 0, -1, "bullet"); }
    check("firing with an empty charge is refused",
          D.fireSpecial(charge, field) === -1 && field.alive === 20,
          "returned -1, " + field.alive + " bullets untouched");
    // ちょうど 30 掠りで一発。29 では撃てない。
    for (let i = 0; i < D.GRAZE_PER_SPECIAL - 1; i++) { D.addGraze(charge); }
    check("one graze short cannot fire", !D.canFire(charge),
          (D.GRAZE_PER_SPECIAL - 1) + " grazes, value " + charge.value.toFixed(4));
    D.addGraze(charge);
    // ここが 1/30 を足し合わせる形では通らなかった所 (30 * (1/30) < 1)。
    check("exactly " + D.GRAZE_PER_SPECIAL + " grazes charge one special",
          D.canFire(charge), "value " + charge.value.toFixed(4));
    const cleared = D.fireSpecial(charge, field);
    check("the special clears the screen",
          cleared === 20 && field.alive === 0,
          cleared + " cleared, " + field.alive + " left");
    check("the special spends exactly one charge",
          charge.units === 0 && charge.spent === 1,
          "units " + charge.units + ", spent " + charge.spent);
    // 上限。溜め置けるのは三発ぶんまで。整数なので、ちょうど 3 になる。
    for (let i = 0; i < 500; i++) { D.addGraze(charge); }
    check("the charge is capped", charge.value === D.GRAZE_MAX
          && charge.units === D.GRAZE_MAX * D.GRAZE_PER_SPECIAL,
          "value " + charge.value + " cap " + D.GRAZE_MAX);
}

// --- 地形 -----------------------------------------------------------------

{
    // 壁の中へ撃つ。弾は壁で消える。
    const field = D.createField();
    const solids = [{ x: 4, y: 4, w: 4, h: 1, kind: "wall" }];
    D.spawnBullet(field, 6, 6, 0, -6, "bullet");
    let blocked = 0;
    for (let s = 0; s < 120; s++) {
        blocked += D.stepField(field, 1 / 120,
                               { solids: solids, roomW: 24, roomH: 12 }).blocked;
    }
    check("walls stop bullets", blocked === 1 && field.alive === 0,
          blocked + " blocked");

    // 片通行の床は止めない。止めると「跳んで抜ける床の下」が安全地帯になる。
    const field2 = D.createField();
    const oneway = [{ x: 4, y: 4, w: 4, h: 1, kind: "oneway" }];
    D.spawnBullet(field2, 6, 6, 0, -6, "bullet");
    let blocked2 = 0;
    for (let s = 0; s < 60; s++) {
        blocked2 += D.stepField(field2, 1 / 120,
                                { solids: oneway, roomW: 24, roomH: 12 }).blocked;
    }
    check("one-way floors do not stop bullets",
          blocked2 === 0 && field2.alive === 1, blocked2 + " blocked");
}

// 房の外に出た弾は消える。寿命を待つと見えない所で判定が回り続ける。
{
    const field = D.createField();
    D.spawnBullet(field, 12, 6, 30, 0, "bullet");
    let gone = 0;
    for (let s = 0; s < 240; s++) {
        gone += D.stepField(field, 1 / 120, { roomW: 24, roomH: 12 }).expired;
    }
    check("bullets leaving the room are dropped early",
          gone === 1 && field.alive === 0, gone + " dropped");
}

// --- 池 -------------------------------------------------------------------

{
    // 容量を超えて撃つ。撃つのを止めるのではなく、古い弾を潰して撃つ。
    const field = D.createField({ capacity: 8 });
    for (let i = 0; i < 20; i++) { D.spawnBullet(field, i, 5, 0, -1, "bullet"); }
    check("the pool never exceeds capacity",
          field.alive === 8, field.alive + " of 8");
    check("overflow recycles rather than refusing to fire",
          field.fired === 20 && field.recycled === 12,
          field.fired + " fired, " + field.recycled + " recycled");
    // 生き残っているのは新しい方。丸く回しているので、消えたのは古い弾。
    const xs = [];
    for (let i = 0; i < field.capacity; i++) {
        if (field.role[i] !== 0) { xs.push(field.x[i]); }
    }
    check("the bullets kept are the newest",
          Math.min.apply(null, xs) === 12,
          "kept x " + xs.slice().sort(function (p, q) { return p - q; }).join(","));
}

// 再利用された枠の掠り印が持ち越されない。持ち越すと、新しい弾から掠りが取れない。
{
    const field = D.createField({ capacity: 2 });
    D.spawnBullet(field, 0, 0, 0, 0, "bullet");
    field.grazed[0] = 1;
    D.spawnBullet(field, 1, 0, 0, 0, "bullet");
    D.spawnBullet(field, 2, 0, 0, 0, "bullet");   // 0 番を潰す
    check("a recycled slot forgets its graze mark",
          field.grazed[0] === 0, "grazed[0] = " + field.grazed[0]);
}

// --- 描画 -----------------------------------------------------------------

{
    const field = D.createField();
    for (let i = 0; i < 5; i++) { D.spawnBullet(field, i, 1, 0, 0, "bullet"); }
    for (let i = 0; i < 3; i++) { D.spawnBullet(field, i, 2, 0, 0, "spark"); }
    const arr = new Float32Array(64 * 3);
    const nb = D.writePositions(field, "bullet", arr);
    const ns = D.writePositions(field, "spark", arr);
    check("positions are written per role", nb === 5 && ns === 3,
          nb + " bullet, " + ns + " spark");
    // 溢れない。用意した配列より弾が多くても、配列の外は書かない。
    const small = new Float32Array(6);
    const n = D.writePositions(field, "bullet", small);
    check("writing respects the array length", n === 2,
          n + " written into room for 2");
}

// 弾幕の draw 数は弾の数ではなく役の種類数。房データから静的に出せる。
//
// ROOM の三砲台は ring/aimed/wall で、三つとも役は "bullet" — だから 1。
// 「砲台の数」を数えていたら 3 になる。そこが数えたい所。
check("danmaku draws count roles, not turrets",
      D.danmakuDraws(ROOM) === 1,
      D.danmakuDraws(ROOM) + " role for 3 turrets");
// 役が分かれる房。spiral は "spark"、burst は "burst" なので三役。
const THREE_ROLE = { size: [24, 12], spawns: [
    { model: "m", at: [4, 4], behavior: "turret", pattern: "ring" },
    { model: "m", at: [8, 4], behavior: "turret", pattern: "spiral" },
    { model: "m", at: [12, 4], behavior: "turret", pattern: "burst" }
] };
check("distinct roles cost distinct draws",
      D.danmakuDraws(THREE_ROLE) === 3,
      D.danmakuDraws(THREE_ROLE) + " roles");
// 弾を 256 発出しても draw は増えない。予算はここで決まる。
{
    const field = D.createField();
    const turrets = D.createTurrets(THREE_ROLE, "R1-08");
    const body = { x: 12, y: 1, w: 0.62, h: 1.7 };
    for (let s = 0; s < 1800; s++) {
        turrets.forEach(function (t) { D.stepTurret(field, t, 1 / 120, body, 3); });
        D.stepField(field, 1 / 120, { body: body, roomW: 24, roomH: 12 });
    }
    check("many bullets still cost only their roles",
          D.danmakuDraws(THREE_ROLE) === 3 && field.alive > 30,
          field.alive + " bullets, 3 draws");
}
check("a room with no turrets costs no draws",
      D.danmakuDraws({ spawns: [{ model: "m", at: [1, 1], behavior: "patrol" }] }) === 0,
      "0 roles");
check("every pattern maps to a role",
      D.PATTERN_IDS.every(function (id) { return !!D.PATTERN_ROLE[id]; })
      && D.PATTERN_IDS.every(function (id) { return !!D.PATTERNS[id]; }),
      D.PATTERN_IDS.join(" "));

// --- 測った数 -------------------------------------------------------------
//
// 主張だけでなく生の数も出す。python 側が「調律したら数が動く」を釘付けに
// できるようにするため (tools/check_mv_move.py の TAPE_EXPECT と同じ考え)。
const tape = {
    fired: ten.total.fired,
    alive: ten.field.alive,
    expired: ten.total.expired,
    grazes: near.total.grazes,
    hits: near.total.hits,
    charge: Number(near.charge.value.toFixed(9)),
    phases: ten.turrets.map(function (t) { return Number(t.timer.toFixed(9)); })
};

// --- 出力 -----------------------------------------------------------------

process.stdout.write(JSON.stringify({ checks: checks, tape: tape }));
