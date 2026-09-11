// 白紙のエトワリア — 色彩値と「思い出す」を node から回す足場。
//
// core/rpgcolour.js は DOM も three.js も要らない。確かめたいのは
// docs/fangame-plan.md 提案 A の四行が本当に規則になっているか:
//
//   掉色するのは 白紙の獣 の攻撃だけ (クリエメイト では減らない)
//   0 で「当場変白退場」— その戦闘ではなく、その章のあいだ立たない
//   戻し方は「加血」ではない — 体力に触らず、回想値を払う
//   回想値を溜めるのは そうりょ だけ (§提案 A が名指しした定位)
//
// 聖典の一行も見る。asset/gacha/cards.js の 38 作すべてに在るかを、cards.js の
// titles() ではなく生データから数える — cards.js は window を要るので node で
// 呼べない。titleId の集合が合っているかは check_rpg_colour.py 側で突き合わせる。

import { readFileSync } from "node:fs";

import {
    COLOUR_MAX, DRAIN_PER_HIT, RECALL_COST, RECALL_MAX, RECALL_CLASS,
    RECALL_PER_ACT, RECALL_PER_ACT_OTHER, RECALL_COLOUR,
    createColour, memberOf, usable, blankedIds, drain, act, recall,
    newChapter, toStore, fromStore, scriptureFor, scriptureCount, SCRIPTURE
} from "./rpgcolour.js";

const CARDS_JS = process.argv[2];

const out = { errors: [] };

function push(err) { out.errors.push(String(err && err.message || err)); }

// 職 id。core/cards.js の CLASS_IDS と同じ並び (あれは window を要らないので
// rpgcolour.js から import 出来ているが、こちらは数字で書いて突き合わせる —
// RECALL_CLASS が「2 = そうりょ」から動いていない事を見たい)。
const PRIEST = 2;
const FIGHTER = 0;

function party() {
    return createColour({ chapter: 1, members: [
        { id: "party0", titleId: 0, classId: FIGHTER },
        { id: "party1", titleId: 5, classId: PRIEST },
        { id: "party2", titleId: 22, classId: FIGHTER },
        // 作の無い相手 (titleId null)。序章・7章・8章 の頁。
        { id: "party3", titleId: null, classId: FIGHTER }
    ]});
}

// 白紙になるまで撞く。戻すのは一撃ごとの結果。
function drainToBlank(state, id) {
    const steps = [];
    for (let i = 0; i < COLOUR_MAX + 2; i++) {
        steps.push(drain(state, id, { fromBlank: true, damage: 120 }));
    }
    return steps;
}

function fill(state, id, times) {
    const steps = [];
    for (let i = 0; i < times; i++) { steps.push(act(state, id)); }
    return steps;
}

// --- 定数 -------------------------------------------------------------------

out.consts = {
    colourMax: COLOUR_MAX,
    drainPerHit: DRAIN_PER_HIT,
    recallCost: RECALL_COST,
    recallMax: RECALL_MAX,
    recallClass: RECALL_CLASS,
    recallPerAct: RECALL_PER_ACT,
    recallPerActOther: RECALL_PER_ACT_OTHER,
    recallColour: RECALL_COLOUR,
    priestIsRecallClass: RECALL_CLASS === PRIEST
};

// --- 掉色 -------------------------------------------------------------------

try {
    const st = party();
    // 値で取る。memberOf は生きた参照を返すので、後の drain で書き換わった値を
    // 読む事になる (最初にそれをやって startsFull が false になった)。
    const startColour = memberOf(st, "party0").colour;
    // クリエメイト の一撃。fromBlank が無い。
    const ordinary = drain(st, "party0", { damage: 999 });
    const afterOrdinary = memberOf(st, "party0").colour;
    // 当たらなかった手。
    const zero = drain(st, "party0", { fromBlank: true, damage: 0 });
    // 白紙の獣 の一撃を、量を変えて二回。どちらも 1 しか抜けない筈。
    const light = drain(st, "party0", { fromBlank: true, damage: 1 });
    const heavy = drain(st, "party0", { fromBlank: true, damage: 9999 });
    out.drain = {
        startsFull: startColour === COLOUR_MAX,
        ordinary: ordinary,
        colourAfterOrdinary: afterOrdinary,
        zeroDamage: zero,
        light: light,
        heavy: heavy,
        // 量に依らない: 1 の一撃と 9999 の一撃で、抜けた量が同じ。
        sameRegardlessOfDamage: light.drained === heavy.drained,
        unknownMember: drain(st, "party9", { fromBlank: true, damage: 5 })
    };
} catch (err) { push(err); }

// --- 退場 -------------------------------------------------------------------

try {
    const st = party();
    const steps = drainToBlank(st, "party0");
    const blankedAt = steps.findIndex(function (s) { return s.blanked; });
    // 白くなった後の一撃。二度目は数えない。
    const after = steps[steps.length - 1];
    out.blank = {
        steps: steps,
        // COLOUR_MAX 発目で白くなる。三発耐えるのではなく、三発目で退場。
        blankedAtHit: blankedAt + 1,
        usable: usable(st, "party0"),
        othersUsable: usable(st, "party1") && usable(st, "party2"),
        blankedIds: blankedIds(st),
        afterBlank: after,
        // 章の通し。二度目の一撃で 2 になっていないか。
        blanks: st.blanks
    };
} catch (err) { push(err); }

// --- 回想値 -----------------------------------------------------------------

try {
    // そうりょ (party1) と 戦士 (party0) を、別の state で同じ回数動かす。
    // 同じ state で続けて動かすと上限に当たった所から先が読めなくなるので分ける。
    const sp = party();
    const priest = fill(sp, "party1", 3);
    const sf = party();
    const fighter = fill(sf, "party0", 3);
    const st = party();
    out.gauge = {
        priest: priest,
        fighter: fighter,
        // 一手あたりの量。そうりょ が他より多いことが §提案 A の「新しい定位」で、
        // 「他は 0」ではない (0 だと そうりょ 抜きの隊で永久に撃てない)。
        perPriestAct: priest.length ? priest[0].gained : null,
        perOtherAct: fighter.length ? fighter[0].gained : null,
        priestAfter3: sp.recall,
        fighterAfter3: sf.recall,
        // 三手で足りるのは そうりょ だけ。
        priestReachesInThree: sp.recall >= RECALL_COST,
        otherNeedsMoreThanThree: sf.recall < RECALL_COST,
        // そうりょ 抜きでも到達はできる。撃てない指令が盤面に出たままにならない。
        otherEventuallyReaches: (function () {
            const s3 = party();
            fill(s3, "party0", 40);
            return s3.recall >= RECALL_COST;
        }()),
        // 上限。RECALL_MAX を越えない。
        capped: fill(st, "party1", RECALL_MAX + 8).pop(),
        recallCapped: st.recall,
        // 白紙になった そうりょ は溜めない。
        blankedPriest: (function () {
            const s2 = party();
            drainToBlank(s2, "party1");
            const before = s2.recall;
            const step = act(s2, "party1");
            return { step: step, unchanged: s2.recall === before };
        }())
    };
} catch (err) { push(err); }

// --- 思い出す ---------------------------------------------------------------

try {
    const st = party();
    drainToBlank(st, "party0");
    const hpUntouched = { note: "rpgcolour never sees hp; battle state is separate" };
    // 払えない。
    const poor = recall(st, "party0");
    fill(st, "party1", RECALL_COST);
    const before = st.recall;
    const ok = recall(st, "party0");
    out.recall = {
        poor: poor,
        ok: ok,
        // 値段を払っている。
        paid: before - st.recall,
        colourAfter: memberOf(st, "party0").colour,
        // 満量では戻らない。
        notFull: memberOf(st, "party0").colour < COLOUR_MAX,
        usableAgain: usable(st, "party0"),
        recalledCount: memberOf(st, "party0").recalled,
        // 戻した相手をもう一度。白紙でないので断られる。
        again: recall(st, "party0"),
        // 戻した直後にもう一撃。薄いので、また白くなる。
        fragile: drain(st, "party0", { fromBlank: true, damage: 50 }),
        unknown: recall(st, "party9"),
        hp: hpUntouched
    };
} catch (err) { push(err); }

// --- 聖典の一行 -------------------------------------------------------------

try {
    // 生データから titleId の集合を取る。cards.js は window を要るので使えない。
    const raw = readFileSync(CARDS_JS, "utf-8");
    const json = JSON.parse(raw.slice(raw.indexOf("{")).trim().replace(/;$/, ""));
    const titleIds = json.titles.map(function (t) { return Number(t.id); }).sort(
        function (a, b) { return a - b; });
    // どの作の頁でもない相手。missing の判定に要るので先に取る。
    const none = scriptureFor(null);
    const lines = {};
    const missing = [];
    titleIds.forEach(function (id) {
        const line = scriptureFor(id);
        lines[id] = line;
        // 空欄だけでなく「無い作の一行に落ちた」も欠けとして数える。表から一つ
        // 消すと scriptureFor は SCRIPTURE_NONE を返し、それは ja も zh も
        // 埋まっているので、空欄だけ見ていると欠けが通ってしまう。
        if (!line || !line.ja || !line.zh) { missing.push(id); }
        else if (line.ja === none.ja) { missing.push(id); }
    });
    // 在り得ない id。落ちる先が在るか (throw しない)。
    const unknown = scriptureFor(9999);
    out.scripture = {
        titleCount: titleIds.length,
        written: scriptureCount(),
        missing: missing,
        // 全部ちがう文か。同じ一行を配ると「その作の頁」ではなくなる。
        distinctJa: new Set(titleIds.map(function (id) { return lines[id].ja; })).size,
        distinctZh: new Set(titleIds.map(function (id) { return lines[id].zh; })).size,
        none: none,
        unknown: unknown,
        // 作の無い相手は SCRIPTURE_NONE に落ち、38 作のどれとも違う。
        noneIsOwn: titleIds.every(function (id) { return lines[id].ja !== none.ja; }),
        sample: { 0: lines[0], 5: lines[5], 22: lines[22], 37: lines[37] },
        // 思い出した時に読む一行が、その相手の作の一行になっているか。
        // 照合の相手は表 (SCRIPTURE) から直に取る。lines[22] は scriptureFor 越し
        // なので、全部同じ一行を返す様にすると比べる相手もそれになって一致する。
        readsOwnTitle: (function () {
            const st = party();
            drainToBlank(st, "party2");     // titleId 22
            fill(st, "party1", RECALL_COST);
            const r = recall(st, "party2");
            const table = SCRIPTURE[22];
            return { line: r.line,
                     matches: Boolean(table) && r.line.ja === table.ja
                              && r.line.zh === table.zh };
        }()),
        // 作の無い相手 (titleId null) を戻した時。
        readsNone: (function () {
            const st = party();
            drainToBlank(st, "party3");
            fill(st, "party1", RECALL_COST);
            const r = recall(st, "party3");
            return { line: r.line, isNone: r.line.ja === none.ja };
        }())
    };
} catch (err) { push(err); }

// --- 章 ---------------------------------------------------------------------

try {
    const st = party();
    drainToBlank(st, "party0");
    drain(st, "party2", { fromBlank: true, damage: 10 });
    fill(st, "party1", 2);
    const before = { blanked: blankedIds(st), recall: st.recall,
                     partial: memberOf(st, "party2").colour, blanks: st.blanks };
    newChapter(st, 2);
    out.chapter = {
        before: before,
        // 章が変われば白紙も戻る。
        after: { blanked: blankedIds(st), recall: st.recall,
                 colour: memberOf(st, "party0").colour,
                 partial: memberOf(st, "party2").colour,
                 blanks: st.blanks, chapter: st.chapter },
        // 回想値は持ち越さない。
        gaugeReset: st.recall === 0,
        // 「戻した回数」は消えない — 章をまたいだ記録なので。
        recalledKept: (function () {
            const s2 = party();
            drainToBlank(s2, "party0");
            fill(s2, "party1", RECALL_COST);
            recall(s2, "party0");
            const n = memberOf(s2, "party0").recalled;
            newChapter(s2, 3);
            return { before: n, after: memberOf(s2, "party0").recalled };
        }())
    };
} catch (err) { push(err); }

// --- 保存 -------------------------------------------------------------------

try {
    const st = party();
    drainToBlank(st, "party0");
    drain(st, "party2", { fromBlank: true, damage: 10 });
    fill(st, "party1", 2);
    const stored = toStore(st);
    const back = fromStore(JSON.parse(JSON.stringify(stored)));
    out.store = {
        roundTrip: JSON.stringify(toStore(back)) === JSON.stringify(stored),
        blankedSurvives: blankedIds(back),
        recallSurvives: back.recall,
        partialSurvives: memberOf(back, "party2").colour,
        titleSurvives: memberOf(back, "party2").titleId,
        classSurvives: memberOf(back, "party1").classId,
        // 戻した後も思い出せる (classId が残っていないと そうりょ が判らない)。
        stillWorks: (function () {
            fill(back, "party1", RECALL_COST);
            return recall(back, "party0");
        }()),
        rejects: [fromStore(null), fromStore({ version: 2, members: {} }),
                  fromStore({ version: 1 })],
        // 壊れた値を丸める。colour が 99 のまま入ると満量を越える。
        clamps: (function () {
            const bad = fromStore({ version: 1, recall: 999, chapter: 1,
                members: { party0: { titleId: 0, classId: 0, colour: 99,
                                     blanked: false, recalled: -5 } } });
            const m = memberOf(bad, "party0");
            return { recall: bad.recall, colour: m.colour, recalled: m.recalled };
        }())
    };
} catch (err) { push(err); }

process.stdout.write(JSON.stringify(out, null, 1));
