// 白紙の書架 — 白化度と机 (§4.3) を node から回す足場。
//
// core/mvblanch.js は DOM も three.js も要らないので、房データを読んで
// そのまま回せる。見るのは四つ。
//
//   (1) 段は積み上がって 4 で止まる。止まらないと房が真っ白のまま戻らない。
//   (2) 区ごとに別。R2 で四回倒れても R5 は元の色でなければ、罰が世界全体への
//       罰になり、「その区で間に合わなかった」という意味が消える。
//   (3) 描く段は房の設計値 + 上乗せ。房データを書き換えないので、存畫を消せば
//       設計の値に戻る。
//   (4) 存畫を通しても壊れない。壊れた値 (99 や文字列や配列でない at) が
//       入って来た時に、房が真っ白のままになったり例外で止まったりしない。
//
// 房データを実物で通すのは tools/mv_rooms_harness.mjs と同じ理由 —
// blanch は tools/build_mv_rooms.py が置く値で、配られる JSON がそれを
// 持っている事まで含めて確かめたい。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BLANCH_MAX, BLANCH_MIN, BLANCH_STEP, createBlanch, levelFor, extraFor,
         markDesk, whiteout, rest, restCandidate, toStore,
         WHITEOUT_LINE, WHITEOUT_CAPPED, DESK_LINE, restLine,
         REST_CLEAN, REST_ALONE, REST_FULL, REST_ASK } from "./mvblanch.js";
import { REGION_IDS } from "./rooms.js";

const MV_DIR = process.argv[2] || "site/asset/mv";

const out = { errors: [] };

const regions = {};
const rooms = {};
REGION_IDS.forEach(function (id) {
    const data = JSON.parse(readFileSync(join(MV_DIR, id + ".json"), "utf8"));
    regions[id] = data;
    Object.keys(data.rooms).forEach(function (roomId) {
        rooms[roomId] = data.rooms[roomId];
    });
});

out.max = BLANCH_MAX;
out.step = BLANCH_STEP;
out.roomCount = Object.keys(rooms).length;

// --- 房データ側 -------------------------------------------------------------
//
// 設計値の幅。core/rooms.js が 0..4 で弾くので、ここは「実際に配られている
// 値の分布」を見る — 全部 0 なら白化は設計に入っていない事になる。
out.baseLevels = {};
Object.keys(rooms).forEach(function (roomId) {
    const b = rooms[roomId].blanch || 0;
    out.baseLevels[b] = (out.baseLevels[b] || 0) + 1;
});

// 机を持つ房。区ごとに一つ以上無いと、その区で倒れた時に戻る所が無い。
out.desksPerRegion = {};
REGION_IDS.forEach(function (id) { out.desksPerRegion[id] = 0; });
Object.keys(rooms).forEach(function (roomId) {
    const region = roomId.split("-")[0];
    if ((rooms[roomId].desk || []).length) {
        out.desksPerRegion[region] += (rooms[roomId].desk || []).length;
    }
});

// --- 積み上がりと上限 -------------------------------------------------------

out.ladder = (function () {
    const b = createBlanch(null);
    const steps = [];
    for (let i = 0; i < BLANCH_MAX + 3; i++) {
        const r = whiteout(b, "R2-04");
        steps.push({ was: r.was, now: r.now, raised: r.raised,
                     line: r.raised ? "raised" : "capped" });
    }
    return steps;
})();

// 区ごとに別。R2 を上げて R5 が動かない事。
out.perRegion = (function () {
    const b = createBlanch(null);
    whiteout(b, "R2-04");
    whiteout(b, "R2-09");   // 同じ区の別の房でも同じ区が上がる
    whiteout(b, "R5-01");
    return { R2: extraFor(b, "R2-04"), R5: extraFor(b, "R5-01"),
             R0: extraFor(b, "R0-01"), all: toStore(b).extra };
})();

// 描く段 = 設計値 + 上乗せ。実物の房で見る。
out.levels = (function () {
    const b = createBlanch(null);
    const pick = ["R0-01", "R2-04", "R2-07", "R7-08"];
    const before = {};
    pick.forEach(function (id) {
        before[id] = levelFor(rooms[id], b, id);
    });
    whiteout(b, "R2-04");
    whiteout(b, "R2-04");
    const after = {};
    pick.forEach(function (id) {
        after[id] = levelFor(rooms[id], b, id);
    });
    return { before: before, after: after,
             base: pick.reduce(function (acc, id) {
                 acc[id] = rooms[id].blanch || 0; return acc;
             }, {}) };
})();

// 既に真っ白な房 (R7-08 は設計値 4) で倒れても、上限を越えない。
//
// extra と level を分けて出す。levelFor が二度目の clamp をかけるので、level
// だけ見ていると whiteout が上限を持っていない事に気付けない — 溜まっている値
// そのものを見る必要がある (存畫に出るのはこちら)。
out.alreadyWhite = (function () {
    const b = createBlanch(null);
    whiteout(b, "R7-08");
    whiteout(b, "R7-08");
    whiteout(b, "R7-08");
    whiteout(b, "R7-08");
    whiteout(b, "R7-08");
    return { extra: extraFor(b, "R7-08"),
             stored: toStore(b).extra,
             level: levelFor(rooms["R7-08"], b, "R7-08"),
             base: rooms["R7-08"].blanch };
})();

// 倒れた房の段が実際に上がるか。上の「区ごとに別」は「上がらない事」を見ているが、
// 「どこにも上がらない」実装もそれを通してしまう。
out.raisesWhereYouDied = (function () {
    const b = createBlanch(null);
    const before = levelFor(rooms["R2-04"], b, "R2-04");
    whiteout(b, "R2-04");
    return { before: before, after: levelFor(rooms["R2-04"], b, "R2-04"),
             extra: extraFor(b, "R2-04") };
})();

// toStore の 0 落とし。whiteout は 0 を作らないので、手で 0 を置いて通す
// (壊れた存畫や、後で「白化を読み戻す」を足した時に通る道)。
out.storeZero = (function () {
    const b = createBlanch(null);
    whiteout(b, "R2-04");
    b.extra.R6 = 0;
    b.extra.R4 = 0;
    const stored = toStore(b).extra;
    return { stored: stored, keys: Object.keys(stored).sort() };
})();

// --- 机 ---------------------------------------------------------------------

out.desk = (function () {
    const b = createBlanch(null);
    const none = whiteout(b, "R2-04");
    markDesk(b, "R2-07", [3, 1]);
    const marked = whiteout(b, "R2-04");
    markDesk(b, "R3-01", [3, 1]);
    const moved = whiteout(b, "R2-04");
    return {
        beforeAny: none.desk,
        afterMark: marked.desk,
        afterMove: moved.desk
    };
})();

// 机の座標が実物の房に在るか。存畫に書いた机が房データから消えた場合
// (房を作り直した後の存畫) に、そこへ戻そうとして落ちない事。
out.deskGone = (function () {
    const b = createBlanch({ desk: { room: "R9-99", at: [3, 1] }, extra: {} });
    return { kept: b.desk, exists: Boolean(rooms[b.desk && b.desk.room]) };
})();

// --- 存畫 -------------------------------------------------------------------

out.roundTrip = (function () {
    const b = createBlanch(null);
    whiteout(b, "R2-04");
    whiteout(b, "R4-03");
    markDesk(b, "R2-07", [3, 1]);
    const stored = toStore(b);
    const back = createBlanch(JSON.parse(JSON.stringify(stored)));
    return { stored: stored, back: toStore(back),
             same: JSON.stringify(stored) === JSON.stringify(toStore(back)) };
})();

// 壊れた存畫。どれも例外を出さず、真っ白に貼り付かない事。
out.broken = (function () {
    const cases = {
        overMax: { extra: { R2: 99 }, desk: null },
        negative: { extra: { R2: -3 }, desk: null },
        farNegative: { extra: { R2: -99 }, desk: null },
        notNumber: { extra: { R2: "white" }, desk: null },
        deskNoRoom: { extra: {}, desk: { at: [3, 1] } },
        deskShortAt: { extra: {}, desk: { room: "R2-07", at: [3] } },
        deskNotArray: { extra: {}, desk: { room: "R2-07", at: "3,1" } },
        deskNaN: { extra: {}, desk: { room: "R2-07", at: ["x", 1] } },
        notObject: "white",
        nullish: null
    };
    const result = {};
    Object.keys(cases).forEach(function (key) {
        try {
            const b = createBlanch(cases[key]);
            result[key] = { extra: extraFor(b, "R2-04"), desk: b.desk,
                            level: levelFor(rooms["R2-04"], b, "R2-04") };
        } catch (err) {
            result[key] = { threw: String(err && err.message || err) };
        }
    });
    return result;
})();

// --- 机で休む (§4.6) --------------------------------------------------------
//
// この作で唯一の取捨。ここを一段読み戻して、別の区を一段白くする。見るのは
// 「必ず代価が付く」事と「代価を払う先が読める形で決まる」事の二つ。
out.min = BLANCH_MIN;

const ALL_REGIONS = REGION_IDS.slice();

// 素直な一回。R2-04 は設計値 2 なので読み戻せる。
out.restOnce = (function () {
    const b = createBlanch(null);
    const r = rest(b, "R2-04", ALL_REGIONS, rooms["R2-04"]);
    return { ok: r.ok, why: r.why || null, here: r.here, there: r.there,
             hereWas: r.hereWas, hereNow: r.hereNow,
             thereWas: r.thereWas, thereNow: r.thereNow,
             level: levelFor(rooms["R2-04"], b, "R2-04"),
             base: rooms["R2-04"].blanch,
             stored: toStore(b).extra };
})();

// 代価は必ず付く。休んだ回数と、白くなった段の総和が釣り合う事。
out.restBalance = (function () {
    const b = createBlanch(null);
    let paid = 0;
    let read = 0;
    for (let i = 0; i < 6; i++) {
        const r = rest(b, "R2-04", ALL_REGIONS, rooms["R2-04"]);
        if (!r.ok) { break; }
        read += r.hereWas - r.hereNow;
        paid += r.thereNow - r.thereWas;
    }
    return { read: read, paid: paid, stored: toStore(b).extra };
})();

// 有色の房では断る。読み戻す物が無いのに代価だけ取られてはいけない。
out.restClean = (function () {
    const b = createBlanch(null);
    // R0-01 は設計値 0。
    const r = rest(b, "R0-01", ALL_REGIONS, rooms["R0-01"]);
    return { ok: r.ok, why: r.why || null, stored: toStore(b).extra };
})();

// 他の区を踏んでいなければ断る。無料で休めると取捨が消える。
out.restAlone = (function () {
    const b = createBlanch(null);
    const r = rest(b, "R2-04", ["R2"], rooms["R2-04"]);
    return { ok: r.ok, why: r.why || null, stored: toStore(b).extra };
})();

// 踏んだ区が全部真っ白でも断る。押し付け先が無いのに休めたら無料になる。
//
// 断る理由は "alone" と分ける。どちらも払えないが、こちらは他の区を踏んだ上で
// 全部埋まっている場合 — 「まだここしか知らない」と言うと嘘になる。
out.restAllWhite = (function () {
    const b = createBlanch(null);
    ["R0", "R1"].forEach(function (region) {
        b.extra[region] = BLANCH_MAX;
    });
    const r = rest(b, "R2-04", ["R0", "R1", "R2"], rooms["R2-04"]);
    return { ok: r.ok, why: r.why || null, stored: toStore(b).extra };
})();

// 払う先の選び方。いちばん白くない区で、同じ段なら名前順。
out.restCandidate = (function () {
    const b = createBlanch(null);
    b.extra.R0 = 2;
    b.extra.R1 = 1;
    b.extra.R3 = 1;
    return {
        // R1 と R3 が並ぶので名前順で R1。R0 は白いので選ばれない。
        tie: restCandidate(b, "R2-04", ["R0", "R1", "R2", "R3"]),
        // 今の区は選ばない。
        notHere: restCandidate(b, "R1-01", ["R1"]),
        // 踏んでいない区は選ばない。
        unvisited: restCandidate(b, "R2-04", ["R2"]),
        // 真っ白な区は選ばない。
        skipsCapped: (function () {
            const c = createBlanch(null);
            c.extra.R0 = BLANCH_MAX;
            c.extra.R1 = 3;
            return restCandidate(c, "R2-04", ["R0", "R1", "R2"]);
        })()
    };
})();

// 休んで下げた分は存畫に残る。0 は書かないが負は書く。
out.restRoundTrip = (function () {
    const b = createBlanch(null);
    rest(b, "R2-04", ALL_REGIONS, rooms["R2-04"]);
    rest(b, "R2-04", ALL_REGIONS, rooms["R2-04"]);
    const stored = toStore(b);
    const back = createBlanch(JSON.parse(JSON.stringify(stored)));
    return { stored: stored.extra, back: toStore(back).extra,
             same: JSON.stringify(stored) === JSON.stringify(toStore(back)),
             level: levelFor(rooms["R2-04"], back, "R2-04") };
})();

// 読み戻しても下限で止まる。設計値 0 の区で何度も休んでも負に流れない。
out.restFloor = (function () {
    const b = createBlanch(null);
    b.extra.R2 = BLANCH_MIN;
    const r = rest(b, "R2-04", ALL_REGIONS, rooms["R2-04"]);
    return { ok: r.ok, why: r.why || null, extra: extraFor(b, "R2-04"),
             level: levelFor(rooms["R2-04"], b, "R2-04") };
})();

// 休みと全白が噛み合うか。休んで下げた区で倒れたら、その分が戻るだけ。
out.restThenWhiteout = (function () {
    const b = createBlanch(null);
    rest(b, "R2-04", ALL_REGIONS, rooms["R2-04"]);
    const afterRest = extraFor(b, "R2-04");
    whiteout(b, "R2-04");
    return { afterRest: afterRest, afterWhiteout: extraFor(b, "R2-04"),
             level: levelFor(rooms["R2-04"], b, "R2-04"),
             base: rooms["R2-04"].blanch };
})();

// --- 言葉 -------------------------------------------------------------------
//
// 全部 {ja, zh} の二言語。片方だけの文が混ざると、その場面だけ言語が変わる。
out.lines = { raised: WHITEOUT_LINE, capped: WHITEOUT_CAPPED, desk: DESK_LINE,
              restClean: REST_CLEAN, restAlone: REST_ALONE,
              restFull: REST_FULL, restAsk: REST_ASK,
              rest: restLine(regions.R2.name),
              restNoName: restLine(null) };

// 払う区の名前が実際に文へ入るか。名前を言わない実装だと、後でそこへ行った時に
// 「勝手に悪くなっている」だけになる (core/mvblanch.js の註)。
out.restNamesRegion = {
    ja: restLine(regions.R2.name).ja.indexOf(regions.R2.name.ja) !== -1,
    zh: restLine(regions.R2.name).zh.indexOf(regions.R2.name.zh) !== -1
};

process.stdout.write(JSON.stringify(out));
