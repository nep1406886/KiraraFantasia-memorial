// 白紙の書架 — 終局の「埋める」(§4.7) を node から回すための足場。
//
// core/mvfill.js と core/rooms.js をそのまま読み込む。R7.json を実物として
// 渡すのは tools/mv_rooms_harness.mjs と同じ理由: 検査script が Python で
// 表を書き直すのでは無く、配られる JSON を通す。
//
// ここでやる事は三つ。
//   (1) 房データの枡が「立てる所」に在るか、跳んで届くか。
//       これは prose では担保できない。埋めなければ出られない房で届かない枡が
//       一つ在れば、それは難しい終局ではなく詰んだ存畫になる。
//   (2) 埋める順の規則が実際に順を守らせているか (逆順・持ち替え無し・
//       動作違い・力不足の四通りを通す)。
//   (3) 埋めた数だけ砲台が減るか。
//
// 出力は JSON 一つ。tools/check_mv_fill.py が読む。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ORDER, SOCKETS, REACH as FILL_REACH, checkFill, createFill,
         active, nextSocket, done, atSocket, tryFill, gunsAllowed }
    from "./mvfill.js";
import { REACH, validateRegion } from "./rooms.js";
import { BODY, MOVE } from "./platformer.js";

const MV_DIR = process.argv[2] || "site/asset/mv";
const ROOM_ID = process.argv[3] || "R7-08";

const out = { errors: [] };

function regionOf(roomId) { return roomId.split("-")[0]; }

const region = JSON.parse(readFileSync(join(MV_DIR, regionOf(ROOM_ID) + ".json"), "utf8"));
const room = region.rooms[ROOM_ID];
if (!room) {
    out.errors.push("no such room: " + ROOM_ID);
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
}

// --- 房データ側 -------------------------------------------------------------

out.order = ORDER.slice();
out.sockets = (room.fill || []).map(function (s) {
    return { owner: s.owner, ability: s.ability, at: s.at.slice() };
});
// checkFill をそのまま通す。core/rooms.js 経由でも通っているが、ここでは
// 「この房だけ」の問題を分けて見たい。
out.schemaProblems = checkFill(ROOM_ID, room, []);
// 区ぜんたいの検証も通す。fill を足した事で他の規則を壊していない事の確認。
out.regionProblems = validateRegion(region, []);

// 枡の owner が ORDER の並びと一致しているか (房データの並びは無関係)。
out.orderMatchesSockets = ORDER.every(function (owner) {
    return (room.fill || []).some(function (s) { return s.owner === owner; });
});
// SOCKETS が言う力と房データの力が一致しているか。
out.abilityMatchesSpec = (room.fill || []).every(function (s) {
    const spec = SOCKETS[s.owner];
    return Boolean(spec) && spec.ability === s.ability;
});
// 動作の種類。read が三つ、dash が一つ (マッチ だけ読み手ではない)。
out.verbs = ORDER.map(function (owner) { return SOCKETS[owner].verb; });

// --- 地形。立てるか、届くか -------------------------------------------------
//
// 足場の上面を集める。solid は [x, y, w, h] で y は下端なので、上面は y+h。
// 天井 (房の一番上に張り付いた板) と壁 (幅 1 で高い板) は足場に数えない —
// 上面が天井の上や壁の頂点に在っても、そこには立てない。
function platforms() {
    const [w, h] = room.size;
    const list = [];
    (room.solid || []).forEach(function (r) {
        const [x, y, rw, rh] = r;
        const kind = r[4] || "wall";
        const top = y + rh;
        if (top >= h) { return; }             // 天井
        if (rw === 1 && rh > 2) { return; }   // 壁
        list.push({ x0: x, x1: x + rw, y: top, kind: kind });
    });
    return list.sort(function (a, b) { return a.x0 - b.x0 || a.y - b.y; });
}

const tops = platforms();
out.platforms = tops.map(function (p) {
    return { x0: p.x0, x1: p.x1, y: p.y, kind: p.kind };
});

// 枡が足場の上に在るか。x は板の範囲の中、y は板の上面と同じ。
// 上面より高い所に在る枡は「空中に浮いた枡」で、届いても踏めない。
function standingOn(at) {
    return tops.filter(function (p) {
        return at[0] >= p.x0 && at[0] < p.x1 && at[1] === p.y;
    })[0] || null;
}

out.standable = (room.fill || []).map(function (s) {
    const p = standingOn(s.at);
    return { owner: s.owner, at: s.at.slice(),
             on: p ? { x0: p.x0, x1: p.x1, y: p.y, kind: p.kind } : null };
});

// 足場から足場へ跳べるか。core/rooms.js の traverseGaps と同じ物差し
// (gap <= REACH.gap, rise <= REACH.rise) を使うが、あちらは左から右へ一方向に
// しか見ない。ここは両向きに歩く — 枡は右にも左にも上にも在るので、
// 一方向の走査では「入れるが出られない」足場を見落とす。
//
// 下りは高さを問わない (落ちれば良い)。上りだけ rise で切る。
function reachStep(from, to) {
    if (from === to) { return false; }
    // 横の隔たり。範囲が重なっていれば 0。
    const gap = Math.max(0, Math.max(from.x0, to.x0) - Math.min(from.x1, to.x1));
    if (gap > REACH.gap) { return false; }
    const rise = to.y - from.y;
    if (rise > REACH.rise) { return false; }
    // 真上に重なった板へは、間に別の板が挟まっていない事にする — ここでは
    // 板が四枚しか無いので、重なりの有無だけ見れば足りる。
    return true;
}

// 入口の足場から歩いて届く足場の集合。R7-08 の入口は D 辺 (下から上がって
// 来る) なので、辺の at の上に在る床から始める。
function entryPlatform() {
    const down = (room.edges || []).filter(function (e) { return e.side === "D"; })[0];
    const x = down ? down.at : 2;
    // 辺の真上は穴なので、穴の両隣のうち房の中側 (右) の床から始める。
    let best = null;
    tops.forEach(function (p) {
        if (p.y > 2) { return; }               // 床の高さだけ
        if (p.x0 <= x + 2 && p.x1 > x + 1) { best = best || p; }
    });
    return best || tops[0];
}

const start = entryPlatform();
out.entry = start ? { x0: start.x0, x1: start.x1, y: start.y } : null;

const seen = new Set();
(function walk(p) {
    if (!p || seen.has(p)) { return; }
    seen.add(p);
    tops.forEach(function (q) { if (reachStep(p, q)) { walk(q); } });
})(start);

out.reachablePlatforms = tops.filter(function (p) { return seen.has(p); }).length;
out.platformCount = tops.length;

out.reachable = (room.fill || []).map(function (s) {
    const p = standingOn(s.at);
    return { owner: s.owner, at: s.at.slice(), ok: Boolean(p) && seen.has(p) };
});

// 跳躍の実測値との突き合わせ。REACH.rise は「安全側に丸めた」値なので、
// 物理から出る頂点がそれを下回っていたら、房は検査を通るのに跳べない。
// 頂点 = v²/2g。体の高さは足の位置で測るので引かない。
out.jumpApex = (MOVE.jumpSpeed * MOVE.jumpSpeed) / (2 * MOVE.gravity);
out.reachRise = REACH.rise;
out.bodyHeight = BODY.h;

// --- 順の規則 ---------------------------------------------------------------
//
// 房データから作った実物の fill を回す。SOCKETS の verb と ability を見て
// 「正しい手順」を組み立てるので、順や帰属を変えたらここも自動で追う。
const ALL = ["A1", "A2", "A3", "A4", "A5", "A6"];

function bodyAt(socket) { return { x: socket.at[0], y: socket.at[1] }; }

// 枡が四つ無い房では active() が false になり、nextSocket() は null を返す。
// 検査script の負の場合はまさにそれを作る (枡を消す・持ち主を重ねる) ので、
// null をそのまま触ると harness が落ちる — 落ちても「検出」にはなるが、
// 壊れるべき言明が壊れた事にはならない。ここで受け止めて、他の言明を全部
// 走らせる。
function verbOf(socket) {
    const spec = socket ? SOCKETS[socket.owner] : null;
    return spec ? spec.verb : "read";
}

function correctRun() {
    const fill = createFill(room);
    const steps = [];
    for (let i = 0; i < ORDER.length; i++) {
        const socket = nextSocket(fill);
        if (!socket) {
            steps.push({ owner: null, ok: false, why: "no socket",
                         index: 0, last: false, guns: gunsAllowed(fill, 4) });
            continue;
        }
        const r = tryFill(fill, {
            body: bodyAt(socket), hero: socket.owner, held: ALL,
            verb: verbOf(socket)
        });
        steps.push({ owner: socket.owner, ok: r.ok, why: r.why || null,
                     index: r.index || 0, last: Boolean(r.last),
                     guns: gunsAllowed(fill, 4) });
    }
    return { steps: steps, done: done(fill), filled: fill.filled };
}

out.correct = correctRun();

// 以下の場合分けはどれも「次の枡」を掴んでから一度だけ叩く。枡が無い房では
// nextSocket() が null なので、掴めなかった事を書いて返す — 落ちない。
function oneTry(pick, build) {
    const fill = createFill(room);
    const socket = pick(fill);
    if (!socket) { return { ok: false, why: "no socket", filled: fill.filled }; }
    const r = tryFill(fill, build(socket));
    return { ok: r.ok, why: r.why || null, filled: fill.filled };
}

// 逆順。最後の枡から埋めようとする。
out.reverse = oneTry(
    function (fill) { return fill.sockets[fill.sockets.length - 1]; },
    function (socket) {
        return { body: bodyAt(socket), hero: socket.owner, held: ALL,
                 verb: verbOf(socket) };
    });

// 持ち替えずに読む。一つ目は アルシーヴ の枡なので、ランプ で読む。
out.wrongHero = oneTry(nextSocket, function (socket) {
    const other = ORDER.filter(function (o) { return o !== socket.owner; })[0];
    return { body: bodyAt(socket), hero: other, held: ALL, verb: verbOf(socket) };
});

// 動作違い。読む枡を撞く。
out.wrongVerb = oneTry(nextSocket, function (socket) {
    const wrong = verbOf(socket) === "read" ? "dash" : "read";
    return { body: bodyAt(socket), hero: socket.owner, held: ALL, verb: wrong };
});

// 力不足。その枡の力だけ持たずに来る。
out.noAbility = oneTry(nextSocket, function (socket) {
    const spec = SOCKETS[socket.owner] || {};
    return { body: bodyAt(socket), hero: socket.owner, verb: verbOf(socket),
             held: ALL.filter(function (a) { return a !== spec.ability; }) };
});

// 遠い所から。次の枡から離れた場所で読む。
out.away = oneTry(nextSocket, function (socket) {
    return { body: { x: socket.at[0] + FILL_REACH.x + 1, y: socket.at[1] },
             hero: socket.owner, held: ALL, verb: verbOf(socket) };
});

// マッチ の枡だけは、誰が撞いても埋まる (操作できる三人に彼女は居ない)。
out.matchAnyHero = (function () {
    const fill = createFill(room);
    // マッチ の順番まで正しく進める。
    for (let i = 0; i < ORDER.length; i++) {
        const socket = nextSocket(fill);
        if (!socket) { break; }
        if (socket.owner === "match") {
            const r = tryFill(fill, {
                body: bodyAt(socket), hero: "kirara", held: ALL, verb: "dash"
            });
            return { ok: r.ok, why: r.why || null };
        }
        tryFill(fill, { body: bodyAt(socket), hero: socket.owner,
                        held: ALL, verb: verbOf(socket) });
    }
    return { ok: false, why: "no match socket" };
})();

// 埋め終わった後にもう一度読む。
out.afterDone = (function () {
    const fill = createFill(room);
    ORDER.forEach(function () {
        const socket = nextSocket(fill);
        if (!socket) { return; }
        tryFill(fill, { body: bodyAt(socket), hero: socket.owner,
                        held: ALL, verb: verbOf(socket) });
    });
    const r = tryFill(fill, { body: { x: 8, y: 1 }, hero: "lamp",
                              held: ALL, verb: "read" });
    return { ok: r.ok, why: r.why || null, done: done(fill) };
})();

// fill を持たない房では何も起きない事。R7-08 以外の 76 房が今まで通り
// 動く事の確認 — active() が false を返せば、game/mv.js の分岐は全部素通り。
out.plainRoom = (function () {
    const plain = createFill({ size: [24, 12], solid: [[0, 0, 24, 1]] });
    return { active: active(plain), done: done(plain),
             next: nextSocket(plain), guns: gunsAllowed(plain, 4),
             try: tryFill(plain, { body: { x: 1, y: 1 }, hero: "lamp",
                                   held: ALL, verb: "read" }).why };
})();

// 間合い。REACH の縁の内と外。
out.reachEdge = (function () {
    const fill = createFill(room);
    const socket = nextSocket(fill) || { at: [0, 0] };
    return {
        inside: atSocket(socket, { x: socket.at[0] + FILL_REACH.x - 0.01,
                                   y: socket.at[1] }),
        outside: atSocket(socket, { x: socket.at[0] + FILL_REACH.x + 0.01,
                                    y: socket.at[1] }),
        insideY: atSocket(socket, { x: socket.at[0],
                                    y: socket.at[1] + FILL_REACH.y - 0.01 }),
        outsideY: atSocket(socket, { x: socket.at[0],
                                     y: socket.at[1] + FILL_REACH.y + 0.01 })
    };
})();

process.stdout.write(JSON.stringify(out));
