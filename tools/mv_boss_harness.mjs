// 白紙の書架 — §4.7 の主四体の機構を node から回す足場。
//
// core/mvboss.js は DOM も three.js も要らない。§4.7 の表は四体に四つ別の
// 規則を与えているので、確かめたいのは「体力が減るか」ではなく
// 「減らない筈の当たりで減らないか」の側:
//
//   B1  盾が三枚。剥がしている間は通らない。剥がし終えてから通る。
//   B2  往低处流。上から落ちて来た時だけ通り、下から撞いても通らない。
//   B3  打倒＝救回。倒れても死なず、以後は当たっても痛くない。
//   B4  血条を持たない (core/mvfill.js の側なので、ここでは「HP で終わら
//       ない」事だけ見る)。
//
// 房データも読む。四体が実際に房に置かれていて、規則の付いた区に居るのでない
// なら、この module 全部が誰にも呼ばれない飾りになる。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    SHIELD_LAYERS, STOMP_SHARE, BOSS_RULES, BOSS_IDS,
    ruleFor, createBossState, resolveHit, fromAbove, harmless, onDown,
    cleared, flowTarget, shieldLine,
    SHIELD_BLOCKED, FLOW_LOW, FLOW_STOMP, RESCUE_DONE, RESCUE_ALREADY
} from "./mvboss.js";
import { REGION_IDS } from "./rooms.js";

const MV_DIR = process.argv[2] || "site/asset/mv";

const out = { errors: [] };

// --- 房データ ---------------------------------------------------------------

const bossRooms = {};
REGION_IDS.forEach(function (id) {
    const data = JSON.parse(readFileSync(join(MV_DIR, id + ".json"), "utf8"));
    Object.keys(data.rooms).forEach(function (roomId) {
        const room = data.rooms[roomId];
        if (!room.boss) { return; }
        const body = (room.spawns || []).filter(function (s) {
            return s.behavior === "boss";
        });
        bossRooms[room.boss] = {
            room: roomId,
            region: roomId.split("-")[0],
            models: body.map(function (s) { return s.model; }),
            bodies: body.length,
            size: room.size
        };
    });
});
out.rooms = bossRooms;

out.rulesMatchRooms = BOSS_IDS.map(function (id) {
    const rule = ruleFor(id);
    const placed = bossRooms[id];
    return {
        id: id,
        kind: rule ? rule.kind : null,
        ruleRegion: rule ? rule.region : null,
        roomRegion: placed ? placed.region : null,
        bodies: placed ? placed.bodies : 0
    };
});

// --- B1 盾 ------------------------------------------------------------------

function body(over) {
    return Object.assign({ x: 5, y: 1, w: 1, h: 2, vx: 0, vy: 0, facing: 1 }, over || {});
}

function bossBox(over) {
    return Object.assign({ x: 5, y: 1, w: 2, h: 3 }, over || {});
}

(function () {
    const s = createBossState("B1");
    const seq = [];
    // 盾の枚数より多く撞く。剥がし終えた後は通らなければならない。
    for (let i = 0; i < SHIELD_LAYERS + 2; i++) {
        const hit = resolveHit(s, bossBox(), body());
        seq.push({ damage: hit.damage, broke: Boolean(hit.broke),
                   shield: hit.shield === undefined ? null : hit.shield,
                   last: Boolean(hit.last) });
    }
    out.shield = {
        layers: SHIELD_LAYERS,
        start: createBossState("B1").shield,
        seq: seq,
        blockedWhileShielded: seq.slice(0, SHIELD_LAYERS)
            .every(function (h) { return h.damage === 0; }),
        throughAfter: seq.slice(SHIELD_LAYERS)
            .every(function (h) { return h.damage === 1; }),
        broke: s.broke,
        // 盾は上下と関係ない。§4.7 の B1 は「只有マッチ 的撞能破」で、
        // 高低の話をしていない。
        //
        // 盾が残っている間の damage だけ見ても足りない — 盾が正しく止めている
        // 時も 0 なので、高さの条件を足した実装と区別が付かない。剥がれるか
        // (broke) と、剥がし終えた後に通るか、の二つで見る。
        fromBelow: resolveHit(createBossState("B1"), bossBox(),
                              body({ y: 0, vy: 4 })).damage,
        breaksFromBelow: (function () {
            const fresh = createBossState("B1");
            const hit = resolveHit(fresh, bossBox(), body({ y: 0, vy: 4 }));
            return { broke: Boolean(hit.broke), shield: fresh.shield };
        }()),
        throughFromBelow: (function () {
            const bare = createBossState("B1");
            for (let i = 0; i < SHIELD_LAYERS; i++) {
                resolveHit(bare, bossBox(), body());
            }
            return resolveHit(bare, bossBox(), body({ y: 0, vy: 4 })).damage;
        }())
    };
}());

// --- B2 往低处流 -------------------------------------------------------------

(function () {
    const boss = bossBox({ x: 6, y: 2, w: 2, h: 3 });
    const above = body({ x: 6, y: 4.2, vy: -3 });     // 落ちて来ている
    const below = body({ x: 6, y: 1, vy: 0 });        // 下から
    const rising = body({ x: 6, y: 4.2, vy: 5 });     // 上に居るが上っている
    const s = createBossState("B2");
    const hitAbove = resolveHit(s, boss, above);
    const hitBelow = resolveHit(createBossState("B2"), boss, below);
    const hitRising = resolveHit(createBossState("B2"), boss, rising);
    out.flow = {
        share: STOMP_SHARE,
        above: { damage: hitAbove.damage, stomp: Boolean(hitAbove.stomp) },
        below: { damage: hitBelow.damage, why: hitBelow.why || null },
        rising: { damage: hitRising.damage, why: hitRising.why || null },
        // 上から見ている間は触れても痛くない。踏んでいる最中に減るなら、
        // 「上を取れば安全」という機構が成立しない。
        harmlessAbove: harmless(createBossState("B2"), boss, above),
        harmfulBelow: harmless(createBossState("B2"), boss, below),
        stomps: s.stomps,
        // 腰の高さ。waist より下に居る間は届かない。
        waist: boss.y + boss.h * STOMP_SHARE,
        justUnderWaist: fromAbove(boss, body({ y: boss.y + boss.h * STOMP_SHARE - 0.01, vy: -1 })),
        atWaist: fromAbove(boss, body({ y: boss.y + boss.h * STOMP_SHARE, vy: -1 })),
        // 同じ床に並んで立っている時。腰ではなく足元で切っていると、これが
        // 「上から踏んだ」になり、高地を作らずに横から撞けてしまう。
        // 落ちてもいないので vy は 0。
        beside: resolveHit(createBossState("B2"), boss,
                           body({ x: boss.x + 1.5, y: boss.y, vy: 0 })).damage,
        besideHarmless: harmless(createBossState("B2"), boss,
                                 body({ x: boss.x + 1.5, y: boss.y, vy: 0 }))
    };
}());

// 流れる先は地形から出す。玩家の居場所を読むと、機構が「低い所に居る奴を
// 追う」になり、A4 で高地を作る意味が消える (§4.7 の 玩家要靠 A4 造高地)。
(function () {
    const boss = bossBox({ x: 10, y: 6, w: 2, h: 3 });
    const solids = [
        { x: 0, y: 0, w: 24, h: 1 },     // 床
        { x: 2, y: 3, w: 3, h: 1 },      // 低い段
        { x: 16, y: 9, w: 3, h: 1 }      // 主より高い段 (選ばれてはいけない)
    ];
    const low = flowTarget(boss, solids, 24);
    // 玩家を右端に置いても左端に置いても、行き先が変わらない事を見る。
    const withRight = flowTarget(boss, solids, 24, { x: 23, y: 1 });
    const withLeft = flowTarget(boss, solids, 24, { x: 1, y: 1 });
    out.flowTarget = {
        picked: low,
        // 床 (y+h = 1) が一番低い上端。x の中心は 12。
        floorCentre: 12,
        lowStepCentre: 3.5,
        highStepCentre: 17.5,
        ignoresPlayer: low === withRight && low === withLeft,
        // 下に何も無い時。落ちる先が無いので null を返す (0 を返すと、
        // 房の左端へ吸い寄せられる)。
        nothingBelow: flowTarget(bossBox({ x: 3, y: 0, w: 2, h: 3 }),
                                 [{ x: 0, y: 0, w: 24, h: 1 }], 24)
    };
}());

// --- B3 打倒＝救回 -----------------------------------------------------------

(function () {
    const s = createBossState("B3");
    const boss = bossBox();
    const first = resolveHit(s, boss, body());
    const end = onDown(s);
    const after = resolveHit(s, boss, body());
    out.rescue = {
        armored: BOSS_RULES.B3.armored,
        firstHit: first.damage,
        // dead が false でなければ、救回が kill と同じ事になる。
        dead: end.dead,
        saved: end.saved,
        savedFlag: s.saved,
        afterDamage: after.damage,
        afterWhy: after.why || null,
        // 救い出した後は触れても痛くない。
        harmlessAfter: harmless(s, boss, body()),
        harmfulBefore: harmless(createBossState("B3"), boss, body()),
        // 二度目の onDown で死なせてしまうと、救った相手を後から殺せる。
        secondDown: onDown(s),
        // core/mvenemy.js は end.dead で消すかどうかを決める。onDown を通って
        // 生き残る筈の状態が dead を返していないか、両方の呼びで見る。
        keptAlive: onDown(createBossState("B3")).dead === false
            && onDown(s).dead === false
    };
}());

// --- B4 血条を持たない ------------------------------------------------------

(function () {
    const s = createBossState("B4");
    out.fill = {
        kind: s.kind,
        armored: BOSS_RULES.B4.armored,
        shield: s.shield,
        // 白紙の獣 は HP で終わらない。resolveHit が通しても、cleared が
        // それだけで真になってはいけない。
        hit: resolveHit(s, bossBox(), body()).damage,
        clearedByHp: cleared(s, { hp: 0, alive: false }),
        clearedFresh: cleared(s, { hp: 3, alive: true })
    };
}());

// --- 状態の作られ方 ---------------------------------------------------------

out.states = {};
BOSS_IDS.forEach(function (id) {
    const s = createBossState(id);
    out.states[id] = { kind: s.kind, shield: s.shield, saved: s.saved };
});
out.unknown = createBossState("B9");
out.unknownRule = ruleFor("B9");
out.nullState = {
    hit: resolveHit(null, bossBox(), body()).damage,
    harmless: harmless(null, bossBox(), body()),
    down: onDown(null)
};

// --- 文 ---------------------------------------------------------------------

out.lines = {
    shieldLeft: shieldLine(2),
    shieldLast: shieldLine(0),
    blocked: SHIELD_BLOCKED,
    low: FLOW_LOW,
    stomp: FLOW_STOMP,
    rescueDone: RESCUE_DONE,
    rescueAlready: RESCUE_ALREADY
};
out.names = {};
BOSS_IDS.forEach(function (id) { out.names[id] = BOSS_RULES[id].name; });
// 残り枚数が文に出ているか。出ていないと、あと何回撞けば良いのかが判らない。
out.shieldCounts = {
    ja: shieldLine(2).ja.indexOf("2") !== -1,
    zh: shieldLine(2).zh.indexOf("2") !== -1,
    lastHasNoNumber: shieldLine(0).ja.indexOf("0") === -1
        && shieldLine(0).zh.indexOf("0") === -1
};

process.stdout.write(JSON.stringify(out, null, 1));
