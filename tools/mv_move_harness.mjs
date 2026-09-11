// core/platformer.js を node で回して結果を JSON で吐く。
// tools/check_mv_move.py がこれを呼ぶ。ブラウザ抜きで物理だけ測るための土台。
//
// 引数: <platformer.mjs へのパス>
// 標準出力: JSON 一つ。人間向けの行は一切出さない (Python が丸ごと parse する)。

import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath) {
    console.error("usage: mv_move_harness.mjs <path to platformer module>");
    process.exit(2);
}
const P = await import(pathToFileURL(modulePath).href);

// --- 房を組む -------------------------------------------------------------

// 床 → 穴 → 床。穴の幅だけを変えて「渡れる / 渡れない」を測る。
function pitRoom(gap) {
    const farStart = 10 + gap;
    return P.compileRoom({
        size: [farStart + 12, 12],
        solid: [
            [0, 0, 10, 1],                  // 手前の床。天板は y = 1
            [farStart, 0, 12, 1],           // 向こうの床
            [0, 1, 1, 11],                  // 左の壁 (吹き飛んで房外に出ないように)
            [farStart + 11, 1, 1, 11]       // 右の壁
        ]
    });
}

// 段差と天井と一方通行を持つ房。入力テープの再現に使う。
function tapeRoom() {
    return P.compileRoom({
        size: [40, 14],
        solid: [
            [0, 0, 40, 1],          // 床
            [0, 1, 1, 13],          // 左壁
            [39, 1, 1, 13],         // 右壁
            [12, 1, 2, 2],          // 高さ 2 の段
            [20, 1, 3, 3],          // 高さ 3 の段 (1 回の跳躍では乗れない)
            [8, 6, 6, 1, "oneway"], // 一方通行の板。下から抜けて上から乗れる
            [28, 5, 4, 1],          // 天井として当たる板
            [33, 1, 1, 2, "crystal"],
            [35, 1, 2, 1, "fade"]
        ]
    });
}

// --- 入力テープ -----------------------------------------------------------
//
// テープは [ステップ数, move, jumpHeld] の並び。jump の立ち上がりは jumpHeld が
// 0 → 1 に変わったステップとして計算する。人の手で押した形に近く、かつ
// 「押しっぱなしを離す」も表現できる。
const TAPE = [
    [40, 1, 0],     // 走り出す
    [8, 1, 1],      // 押しっぱなしで跳ぶ (短くない跳躍)
    [70, 1, 0],     // 押しっぱなしを離して滞空
    [30, 1, 0],
    [6, 1, 1],      // 二回目
    [4, 1, 0],      // すぐ離す = 低い跳躍
    [60, 1, 0],
    [40, -1, 0],    // 引き返す
    [50, 0, 0],     // 手を離して止まる
    [10, 1, 1],
    [80, 1, 1],     // 押しっぱなし
    // ここから下は「終点を自由運動の途中に置く」ために足した。
    // 上の [80,1,1] で終わっていた頃、体は段 [12,1,2,2] の側面に押し付けられて
    // 床に立った姿勢で止まっていた: x = 12 - 0.31 = 11.69 ちょうど。あれは
    // どう来ても同じ値になる飽和点なので、DT を 1/120 から 1/119 に変えても
    // 終点が 1e-9 まで一致してしまい、門が何も検出しなかった (実測)。
    [10, 1, 0],     // 一度離す (次の立ち上がりを作る)
    [6, 1, 1],      // 跳んで段に乗る
    [40, 1, 0],
    [20, 0, 0],     // 立ち止まる
    [8, 1, 1],      // もう一度踏み切る
    [12, 1, 1]      // 上昇中に録り終える (頂点は 26 歩目なので、まだ空中)
];

// 経路そのものを一つの整数に畳む。終点だけを門にすると、飽和点で止まった
// ときに何も見えなくなる。畳んだ値なら途中の一歩でも違えば必ず動く。
function mixDigest(h, v) {
    // 1e-4 tile まで丸めてから畳む。同じ build なら計算は完全に再現するので
    // 誤差の許容は要らない -- 整数として厳密に比べられる。
    const n = Math.round(v * 10000) | 0;
    let x = (h ^ n) >>> 0;
    x = Math.imul(x, 0x5bd1e995) >>> 0;
    return ((x << 13) | (x >>> 19)) >>> 0;
}

function runTape(room, tape, body) {
    let prevHeld = false;
    let steps = 0;
    let landings = 0;
    let wasGround = body.onGround;
    let digest = 2166136261;
    for (const [n, move, held] of tape) {
        for (let i = 0; i < n; i++) {
            const heldNow = Boolean(held);
            const input = { move: move, jump: heldNow && !prevHeld, jumpHeld: heldNow };
            P.step(body, input, room);
            prevHeld = heldNow;
            if (body.onGround && !wasGround) { landings += 1; }
            wasGround = body.onGround;
            steps += 1;
            digest = mixDigest(digest, body.x);
            digest = mixDigest(digest, body.y);
            digest = mixDigest(digest, body.vx);
            digest = mixDigest(digest, body.vy);
            digest = mixDigest(digest, body.onGround ? 1 : 0);
        }
    }
    return { steps: steps, landings: landings, digest: digest >>> 0 };
}

// 穴を渡ろうとする。縁に来たら跳ぶ、という一つの規則だけで走らせる。
// 「一番うまい踏み切り」を探させると、門が探索の質を測ることになってしまう。
function tryGap(gap, options) {
    const opt = options || {};
    const room = pitRoom(gap);
    const body = P.createBody(3, 1);
    const edge = 10;
    let jumped = false;
    let prevHeld = false;
    // 十分な歩数。渡れるなら 300 歩で着く (滞空 0.44s = 53 歩)。
    for (let i = 0; i < 400; i++) {
        // 体の前端が穴の縁に届いたら踏み切る。
        const front = body.x + body.w / 2;
        let held = false;
        if (!jumped && front >= edge - (opt.early || 0)) {
            held = true;
            jumped = true;
        } else if (jumped && body.vy > 0) {
            held = true;   // 上昇中は押しっぱなし = 最大の跳躍
        }
        P.step(body, { move: 1, jump: held && !prevHeld, jumpHeld: held }, room);
        prevHeld = held;
        if (body.y < -2) {
            return { crossed: false, x: body.x, reason: "fell" };
        }
        // 「向こうの床に乗った」で判定する。x > edge では足りない: 縁で跳んで
        // 手前の床に戻っただけでも通ってしまう (実際に一度そう誤判定した)。
        if (jumped && body.onGround && body.x - body.w / 2 >= edge + gap - 1e-9) {
            return { crossed: true, x: body.x, reason: "landed" };
        }
    }
    return { crossed: false, x: body.x, reason: "timeout" };
}

// 縁を踏み越してから跳ぶ = 土狼時間に頼る渡り方。coyote を切ると落ちるべき。
function tryGapLate(gap) {
    const room = pitRoom(gap);
    const body = P.createBody(3, 1);
    const edge = 10;
    let jumped = false;
    let prevHeld = false;
    // createBody は onGround: false で始まる。先に一歩踏ませて床を掴ませないと
    // 「地面を離れてから」の判定が初回で成立してしまい、出発点でいきなり跳んで
    // しまう (最初そう書いて、渡れないのは物理のせいだと読み違えた)。
    let everGround = false;
    for (let i = 0; i < 400; i++) {
        let held = false;
        // 足が床から離れてから跳ぶ。coyote が生きていれば跳べる。
        if (!jumped && everGround && !body.onGround) {
            held = true;
            jumped = true;
        } else if (jumped && body.vy > 0) {
            held = true;
        }
        if (body.onGround) { everGround = true; }
        P.step(body, { move: 1, jump: held && !prevHeld, jumpHeld: held }, room);
        prevHeld = held;
        if (body.y < -2) { return { crossed: false, x: body.x, reason: "fell" }; }
        if (jumped && body.onGround && body.x - body.w / 2 >= edge + gap - 1e-9) {
            return { crossed: true, x: body.x, reason: "landed" };
        }
    }
    return { crossed: false, x: body.x, reason: "timeout" };
}

// 縁のすり上げ (SNAP_UP) が実際に働く場面。
//
// これを足した理由を正直に書いておく: すり上げは元々「軸分離のせいで穴が
// 渡れなくなる」ための対策として入れたつもりだったが、SNAP_UP = 0 にしても
// 上の穴の測定は 1e-9 まで同じだった。渡れなかったのは物理ではなく
// tryGapLate の掛け金の書き忘れ (l.129) が原因で、対策の理由付けが誤りだった。
//
// では要らないのか、というと要る。落下が緩いとき -- 跳躍の頂点近く -- に横から
// 縁の x 範囲へ入ると、足が天板の 0.12 tile 未満だけ下に居る一歩が起こりうる。
// そこで X の解決が先に働くと、天板に乗れる高さまで来ているのに側面に当たって
// 弾かれる。遊ぶ側からは「縁に見えない壁がある」に見える一歩。
//
// 場面は「2 tile 高い縁へ、跳躍の届く限界ぎりぎりで飛び移る」。跳躍高は
// 2.4 tile なので 2 tile の縁には乗れるが、遠いほど足は下がって着く。
// 一発の配置で狙うと当たり判定の位相合わせを測ることになるので、渡る距離を
// 0.005 tile 刻みで掃いて「乗れた回数」を数える。すり上げを切れば必ず減る。
function ledgeSnapSweep() {
    let landed = 0;
    let bumped = 0;
    const edges = [];
    const N = 240;
    for (let k = 0; k < N; k++) {
        // 2.40〜3.60 tile。境目 (足が天板の僅か下で入る距離) を挟む幅。
        const gap = 2.4 + k * 0.005;
        const takeoff = 8;
        const ledgeX = takeoff + gap;
        const room = P.compileRoom({
            size: [Math.ceil(ledgeX) + 14, 12],
            solid: [
                [0, 0, takeoff, 1],         // 踏み切り台。天板 y = 1
                [ledgeX, 0, 10, 3],         // 2 tile 高い縁。天板 y = 3
                [0, 1, 1, 11]
            ]
        });
        const body = P.createBody(3, 1);
        let jumped = false;
        let prevHeld = false;
        let result = "none";
        for (let i = 0; i < 300; i++) {
            // tryGap と同じ規則: 前端が縁に届いたら踏み切り、上昇中は押しっぱなし。
            const front = body.x + body.w / 2;
            let held = false;
            if (!jumped && front >= takeoff) { held = true; jumped = true; }
            else if (jumped && body.vy > 0) { held = true; }
            P.step(body, { move: 1, jump: held && !prevHeld, jumpHeld: held }, room);
            prevHeld = held;
            if (jumped && body.onGround && Math.abs(body.y - 3) < 1e-6) {
                result = "landed"; break;
            }
            if (jumped && body.onGround && body.y < 2) { result = "bumped"; break; }
            if (body.y < -2) { result = "bumped"; break; }
        }
        if (result === "landed") { landed += 1; edges.push(Number(gap.toFixed(3))); }
        if (result === "bumped") { bumped += 1; }
    }
    return {
        landed: landed, bumped: bumped, samples: N,
        // 乗れた一番遠い距離。すり上げが効いていれば僅かに伸びる。
        farthest: edges.length ? edges[edges.length - 1] : null
    };
}

// 跳躍の高さ。乗れる段の高さを房の設計に使うので、実測しておく。
function jumpHeight() {
    const room = P.compileRoom({ size: [20, 20], solid: [[0, 0, 20, 1]] });
    const body = P.createBody(5, 1);
    let top = body.y;
    let prevHeld = false;
    for (let i = 0; i < 300; i++) {
        const held = i >= 2;   // 2 歩目で押して、以後押しっぱなし
        P.step(body, { move: 0, jump: held && !prevHeld, jumpHeld: held }, room);
        prevHeld = held;
        if (body.y > top) { top = body.y; }
        if (i > 5 && body.onGround) { break; }
    }
    return top - 1;
}

// 押してすぐ離した跳躍の高さ。可変ジャンプが効いているかを測る。
function shortJumpHeight() {
    const room = P.compileRoom({ size: [20, 20], solid: [[0, 0, 20, 1]] });
    const body = P.createBody(5, 1);
    let top = body.y;
    let prevHeld = false;
    for (let i = 0; i < 300; i++) {
        const held = i >= 2 && i < 5;   // 3 歩だけ押す
        P.step(body, { move: 0, jump: held && !prevHeld, jumpHeld: held }, room);
        prevHeld = held;
        if (body.y > top) { top = body.y; }
        if (i > 6 && body.onGround) { break; }
    }
    return top - 1;
}

// 跳躍緩衝: 着地の 4 フレーム前に押した入力を拾うか。
// 落下中に一度だけ押し、着地後に跳んでいれば拾えている。
function bufferWorks() {
    const room = P.compileRoom({ size: [20, 20], solid: [[0, 0, 20, 1]] });
    const body = P.createBody(5, 6);   // 空中から落とす
    let prevHeld = false;
    let pressed = false;
    let touched = false;
    for (let i = 0; i < 400; i++) {
        let held = false;
        // 床まであと僅かになったら一度だけ押す。BUFFER_TIME = 4/60 s なので、
        // それより短い時間で着く高さで押す。
        if (!pressed && body.y - 1 < 0.28 && body.vy < 0) {
            held = true;
            pressed = true;
        }
        P.step(body, { move: 0, jump: held && !prevHeld, jumpHeld: held }, room);
        prevHeld = held;
        if (body.onGround) { touched = true; }
        // 着地したあと離れたなら、緩衝が効いて跳んだということ。
        if (touched && !body.onGround && body.vy > 0) {
            return { works: true, pressedAt: i };
        }
        if (touched && i > 60) { break; }
    }
    return { works: false, pressedAt: -1 };
}

// 一方通行の板: 下から抜けて、上から乗れるか。
function onewayWorks() {
    const room = tapeRoom();
    // 板は [8, 6, 6, 1, "oneway"]。下から上へ抜ける。
    // 初速は板を越えられる大きさを取る: 重力 103 で y=3 から板の天板 y=7 の上まで
    // 頭を出すには 26 では足りず (頂点 y≈6.28)、30 なら届く。最初 20 で書いて
    // 「抜けられない」と出たが、それは板ではなく初速が足りていなかっただけ。
    const up = P.createBody(10, 3);
    up.vy = 30;
    let through = false;
    for (let i = 0; i < 200; i++) {
        P.step(up, { move: 0, jump: false, jumpHeld: false }, room);
        if (up.y > 7 + 1e-9) { through = true; }
        if (up.onGround) { break; }
    }
    // 上から降りて乗る。
    const down = P.createBody(10, 9);
    let landedOn = false;
    for (let i = 0; i < 400; i++) {
        P.step(down, { move: 0, jump: false, jumpHeld: false }, room);
        if (down.onGround) {
            landedOn = Math.abs(down.y - 7) < 1e-6;
            break;
        }
    }
    return { passedUp: through, landedOnTop: landedOn, restY: down.y };
}

// 白紙化した床 (fade) と結晶 (crystal)。状態次第で固くなる。
function stateSolids() {
    const room = tapeRoom();
    const fadeIndex = room.solid.findIndex(function (r) { return r.kind === "fade"; });
    const crystalIndex = room.solid.findIndex(function (r) { return r.kind === "crystal"; });

    function dropOn(x, state) {
        const body = P.createBody(x, 5);
        for (let i = 0; i < 400; i++) {
            P.step(body, { move: 0, jump: false, jumpHeld: false }, room, state);
            if (body.onGround) { return body.y; }
            if (body.y < -2) { return -99; }
        }
        return body.y;
    }

    const restored = {};
    restored[fadeIndex] = true;
    const broken = {};
    broken[crystalIndex] = true;

    return {
        fadeIndex: fadeIndex,
        crystalIndex: crystalIndex,
        // fade の上に落ちる。既定では無いので床 (y=1) まで落ちる。
        fadeOff: dropOn(35.9, null),
        // 読み戻すと y=2 で止まる ([35,1,2,1] の天板)。
        fadeOn: dropOn(35.9, { restored: restored }),
        // 結晶は横から当たる。壊す前は止まり、壊せば通る。
        crystalBlocks: pushInto(33.0, null),
        crystalBroken: pushInto(33.0, { broken: broken })
    };

    function pushInto(targetX, state) {
        // 結晶 [33,1,1,2] へ左から歩いて当てる。
        const body = P.createBody(30, 1);
        for (let i = 0; i < 400; i++) {
            P.step(body, { move: 1, jump: false, jumpHeld: false }, room, state);
        }
        return body.x;
    }
}

// 累加器。1 フレームに詰め込む時間の上限が効いているか。
function clockClamp() {
    const clock = P.createClock();
    let steps = 0;
    // 5 秒ぶんを一度に渡す。上限 100 ms が効けば 12 歩で止まる。
    P.advance(clock, 5.0, function () { steps += 1; });
    const clamped = steps;
    const clock2 = P.createClock();
    let steps2 = 0;
    P.advance(clock2, 1 / 60, function () { steps2 += 1; });
    return { clampedSteps: clamped, normalSteps: steps2 };
}

// PRNG。同じ種なら同じ列、違う種なら違う列。
function prng() {
    const a = P.createRandom(P.seedFrom("R3-04"));
    const b = P.createRandom(P.seedFrom("R3-04"));
    const c = P.createRandom(P.seedFrom("R3-05"));
    const A = [], B = [], C = [];
    for (let i = 0; i < 6; i++) { A.push(a.next()); B.push(b.next()); C.push(c.next()); }
    return {
        same: A.every(function (v, i) { return v === B[i]; }),
        differs: A.some(function (v, i) { return v !== C[i]; }),
        inRange: A.every(function (v) { return v >= 0 && v < 1; }),
        first: A[0]
    };
}

// --- 走らせる -------------------------------------------------------------

const tapeBody = P.createBody(3, 1);
const tapeRun = runTape(tapeRoom(), TAPE, tapeBody);

const out = {
    constants: {
        DT: P.DT, TILE: P.TILE,
        coyote: P.COYOTE_TIME, buffer: P.BUFFER_TIME,
        body: { w: P.BODY.w, h: P.BODY.h },
        gravity: P.MOVE.gravity, jumpSpeed: P.MOVE.jumpSpeed, runSpeed: P.MOVE.runSpeed
    },
    tape: {
        steps: tapeRun.steps,
        landings: tapeRun.landings,
        // 経路を畳んだ整数。終点より先にこれが動く。
        digest: tapeRun.digest,
        // 終点は 1e-9 で比べる。丸めずに出す。
        x: tapeBody.x, y: tapeBody.y, vx: tapeBody.vx, vy: tapeBody.vy,
        onGround: tapeBody.onGround, facing: tapeBody.facing
    },
    gaps: {
        // 3 は渡れて 4 は渡れない、が門。3.5 は境目の確認用。
        g2: tryGap(2), g3: tryGap(3), g35: tryGap(3.5), g4: tryGap(4), g5: tryGap(5)
    },
    // 縁を踏み越してから跳ぶ渡り方。房を設計するときに効く数字なので、
    // どの幅まで通るのかを並べて出す。3 が通らないのは仕様どおり: 一歩ぶん
    // 落ちてから跳ぶので頂点が下がり、向こうの床の天板に足が届かない。
    coyoteGap: {
        g2: tryGapLate(2), g25: tryGapLate(2.5), g275: tryGapLate(2.75), g3: tryGapLate(3)
    },
    jumpHeight: jumpHeight(),
    shortJumpHeight: shortJumpHeight(),
    ledgeSnap: ledgeSnapSweep(),
    buffer: bufferWorks(),
    oneway: onewayWorks(),
    solids: stateSolids(),
    clock: clockClamp(),
    prng: prng()
};

process.stdout.write(JSON.stringify(out, null, 1));
