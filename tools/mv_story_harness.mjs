// 白紙の書架 — 過場 script の検査を node から回すための足場。
//
// tools/check_mv_story.py が読む JSON 一つを出す。ここでやることは三つ:
//
//   (1) core/adv.js の validate() を全場面に通す。これは綴りの検査で、
//       goto の行き先や台詞の片言落ちを拾う。
//   (2) 表情名を各人の facial table に照らす。validate() は「語彙に有るか」
//       までしか見ない — plans/metroidvania.md 6.6 が要求しているのは
//       「そのモデルで実際に index が引けるか」で、これは別の検査。
//   (3) 場面 id と房データの room.script を突き合わせる。
//
// (2) が resolveFace ではなく emotionIndex を使う理由:
// core/actor.js:848-850 の resolveFace は EMOTION_FALLBACK に無い名前を
// facialTable["default"] に落とす。つまり "happpy" に対しても 0 を返す。
// 6.6 の負例「拼错的表情名 → 必须报错，不能静默退回 default」は resolveFace
// では原理的に書けない。emotionIndex は -1 を返すので、こちらが正直な信号。
//
// ただし emotionIndex(table, 99) は 99 をそのまま返す (raw index の逃げ道)。
// なので範囲も見る: index >= 0 かつ index < states.length。

import { readFileSync } from "node:fs";
import { join } from "node:path";

// core/loader.js は module 頂で window.location.protocol を読む (IS_LOCAL_FILE)。
// core/i18n.js は window.localStorage を読む。どちらも import より先に居ないと
// 落ちるので、静的 import ではなく dynamic import にしてある。
globalThis.window = {
    location: { protocol: "http:", href: "http://localhost/" },
    localStorage: {
        getItem: function () { return null; },
        setItem: function () {}
    },
    addEventListener: function () {},
    devicePixelRatio: 1
};
globalThis.document = { createElement: function () { return {}; } };

const ROOT = process.argv[2] || ".";
const MODULES = process.argv[3] || ROOT;

const adv = await import(new URL("file://" + join(MODULES, "core", "adv.js").replace(/\\/g, "/")));
const actor = await import(new URL("file://" + join(MODULES, "core", "actor.js").replace(/\\/g, "/")));
const castMod = await import(new URL("file://" + join(MODULES, "asset", "story", "cast.js").replace(/\\/g, "/")));
const scenesMod = await import(new URL("file://" + join(MODULES, "asset", "story", "mvscenes.js").replace(/\\/g, "/")));

const CAST = castMod.CAST;
const SCENES = scenesMod.SCENES;
const META = scenesMod.META;
const REGION_BGM = scenesMod.REGION_BGM;
const BOSS_BGM = scenesMod.BOSS_BGM;
const REGION_IDS = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7"];

function readJSON(...parts) {
    return JSON.parse(readFileSync(join(ROOT, ...parts), "utf8"));
}

// どのモデルがどの facial table を使うかは manifest が持っている。cast.js の
// `model` は resourceId なので、そこから鍵を組み立てて引く — 表の名前を
// この file に書き写すと、モデルを差し替えた時に嘘になる。
function facialTables() {
    const manifest = readJSON("asset", "models", "manifest.json");
    const out = {};
    Object.keys(CAST).forEach(function (id) {
        const entry = CAST[id];
        if (!entry.model) { return; }
        const key = "model/player/model_pl_" + entry.model + ".muast";
        const record = manifest.models[key];
        if (!record) { out[id] = { error: "no manifest entry for " + key }; return; }
        if (!record.facial) { out[id] = { error: "manifest entry has no facial" }; return; }
        const path = record.facial.split("?")[0];
        out[id] = { path: path, table: readJSON(path) };
    });
    return out;
}

// 房データが呼ぶ場面 id を集める。
function roomScripts() {
    const out = {};
    REGION_IDS.forEach(function (rid) {
        const region = readJSON("asset", "mv", rid + ".json");
        Object.keys(region.rooms).forEach(function (roomId) {
            const name = region.rooms[roomId].script;
            if (name) { out[name] = roomId; }
        });
    });
    return out;
}

// 区の bgm は房データ側に論理名で入っている (mv_lamp 等)。REGION_BGM がその
// 名前を mp3 の名前に直す表なので、両側が噛み合っているかを見る — 噛み合って
// いないと、その区は黙って無音になる (audio.bgm(undefined) は何もしない)。
function regionBgmKeys() {
    const out = {};
    REGION_IDS.forEach(function (rid) {
        const region = readJSON("asset", "mv", rid + ".json");
        out[rid] = region.bgm || null;
    });
    return out;
}

// 主の房。B1..B3 は room.boss に居るが、B4 は §4.7 の「不给血条」ゆえに
// 敵として存在しない。game/mv.js の bossIdOf が script の名前で拾っているので、
// 検査もそこを見る — 見なければ BOSS_BGM.B4 が誰にも引かれない事に気付けない。
function bossRooms() {
    const out = {};
    REGION_IDS.forEach(function (rid) {
        const region = readJSON("asset", "mv", rid + ".json");
        Object.keys(region.rooms).forEach(function (roomId) {
            const room = region.rooms[roomId];
            const id = room.boss || (room.script === "mv_b4" ? "B4" : null);
            if (id) { out[id] = roomId; }
        });
    });
    return out;
}

// 過場の層が要る class を、頁が本当に持っているか。core/advstage.js と
// core/adv.js が書く class 名は決まっているので、CSS が無いと出るのに
// 見えない (position も z-index も無い div になる)。
//
// 素の indexOf では検査にならない: "#mvcut" は "#mvcut.on { ... }" にも
// 含まれるので、規則そのものを消しても見付かってしまう (実際に負例が
// 通らなかった)。だから「規則の頭に居るか」を見る — 選択子の並びの中に
// その名前が在って、その後に { が来る形。
// node に CSS parser は無いので正規表現で足りる範囲に留めている。拾いたいのは
// 「書き忘れ」だけで、形は browser で見る。
// @media などの塊を落とす。中の規則は「上書き」であって定義ではないので、
// 名前を数える側に入れてはいけない — prefers-reduced-motion の
// 「#mvcut { transition: none }」が、消えた #mvcut の土台の代わりに
// 数えられてしまう (これも負例が教えてくれた)。
// 括弧を数えるだけの雑な走査で足りる。CSS の入れ子はこの頁に無い。
function stripAtBlocks(css) {
    const out = [];
    let i = 0;
    while (i < css.length) {
        const at = css.indexOf("@", i);
        if (at === -1) { out.push(css.slice(i)); break; }
        const open = css.indexOf("{", at);
        if (open === -1) { out.push(css.slice(i)); break; }
        out.push(css.slice(i, at));
        let depth = 1;
        let j = open + 1;
        while (j < css.length && depth > 0) {
            if (css[j] === "{") { depth += 1; }
            else if (css[j] === "}") { depth -= 1; }
            j += 1;
        }
        i = j;
    }
    return out.join("\n");
}

// core/adv.js と core/advstage.js が実際に書く class 名。source から拾う。
// adv-title- の接尾は kind ごとに変わるので此処では数えない (titleKinds が見る)。
function advClassNames() {
    const names = new Set();
    ["adv.js", "advstage.js"].forEach(function (file) {
        // MODULES 側から読む。ROOT は負例のために写した data の木で、core/ は
        // 写していない (写す必要が無い — 負例が触るのは data と頁だけ)。
        const src = readFileSync(join(MODULES, "core", file), "utf8");
        const forms = [/className\s*=\s*"([^"]*)"/g,
                       /classList\.add\("([^"]*)"\)/g,
                       /class="([^"]*)"/g];
        forms.forEach(function (re) {
            let hit = re.exec(src);
            while (hit) {
                hit[1].split(/\s+/).forEach(function (n) {
                    // 末尾が - の物は接尾を継ぐ途中 ("adv-title-" + kind)。
                    if (n && n.startsWith("adv-") && !n.endsWith("-")) {
                        names.add(n);
                    }
                });
                hit = re.exec(src);
            }
        });
    });
    return Array.from(names).sort();
}

function pageClasses() {
    const html = stripAtBlocks(readFileSync(join(ROOT, "game", "mv.html"), "utf8"));
    // 名前は手で並べない。手で並べた時に六つ落とした
    // (.adv-text .adv-name-secondary .adv-choice-primary .adv-choice-secondary
    //  .adv-flat-face .adv-flat-placeholder) ので、書いている側から取る。
    // これで core が新しい class を出し始めた日に、頁の書き忘れが此処で出る。
    const emitted = advClassNames();
    const need = ["#mvcut", ".mvcut-overlay", ".mvcut-canvas", ".mvcut-ui"]
        .concat(emitted.map(function (n) { return "." + n; }));
    const missing = need.filter(function (name) {
        // 「素の規則」を要求する。名前の後に続いて良いのは区切りと { だけで、
        // .on や :hover が付いた形は数えない。理由は負例が教えてくれた:
        // #mvcut の規則を消しても #mvcut.on が残っていて、名前を探すだけでは
        // 見付かってしまう。層の土台 (position/inset/z-index) は素の規則に
        // 書いてあるので、居るのはそちら。
        // 直後の \w- を弾くのは、下位の名前が上位を満たさないため
        // (.adv-bg-next が .adv-bg の代わりにならない)。
        // 22 個全部が実際に素の規則を持っている事は確認済み。
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const head = new RegExp("(^|[\\s,>+~])" + escaped
            + "(?![\\w.:#[-])[^{};]*\\{", "m");
        return !head.test(html);
    });
    return { need: need.length, missing: missing };
}

// 場面が頼む kind の一覧。CSS が無い kind は素の .adv-title で出る — 誤りでは
// ないが、意図した見た目にはならないので、頁に規則が有るかどうかを並べて出す。
function titleKinds() {
    const html = readFileSync(join(ROOT, "game", "mv.html"), "utf8");
    const kinds = {};
    Object.keys(SCENES).forEach(function (id) {
        SCENES[id].forEach(function (command) {
            if (!command || command.title === undefined) { return; }
            const kind = command.kind || "title";
            if (!kinds[kind]) {
                kinds[kind] = { scenes: [], styled:
                    html.indexOf(".adv-title-" + kind) !== -1 };
            }
            if (kinds[kind].scenes.indexOf(id) === -1) {
                kinds[kind].scenes.push(id);
            }
        });
    });
    return kinds;
}

// 場面が頼む背景。asset/story/background/ に在るのは二枚だけなので、
// 三枚目を書いた瞬間に気付けるようにしておく。null と "white" は fetch を
// 起こさない (advstage.js:550-557) ので、数に入れない。
function backgrounds() {
    const want = {};
    Object.keys(SCENES).forEach(function (id) {
        SCENES[id].forEach(function (command) {
            if (!command || command.bg === undefined) { return; }
            if (command.bg === null || command.bg === "white") { return; }
            if (!want[command.bg]) { want[command.bg] = []; }
            if (want[command.bg].indexOf(id) === -1) { want[command.bg].push(id); }
        });
    });
    return want;
}

// 場面から表情の指定を全部拾う。三つの書き方がある:
//   { speaker: "x", face: "happy", ja/zh }   台詞と一緒に
//   { enter: "x", face: "happy" }            登場と一緒に
//   { face: "x", to: "happy" }               台詞なしの表情替え
function faceUses(script) {
    const uses = [];
    script.forEach(function (command, i) {
        if (!command) { return; }
        if (command.face !== undefined && command.to !== undefined) {
            uses.push({ at: i, who: command.face, name: command.to, via: "face/to" });
            return;
        }
        if (command.face === undefined) { return; }
        const who = command.speaker !== undefined ? command.speaker : command.enter;
        if (!who) {
            uses.push({ at: i, who: null, name: command.face, via: "orphan" });
            return;
        }
        uses.push({ at: i, who: who, name: command.face,
                    via: command.enter ? "enter" : "line" });
    });
    return uses;
}

function castUses(script) {
    const ids = new Set();
    script.forEach(function (command) {
        if (!command) { return; }
        ["speaker", "enter", "turn"].forEach(function (key) {
            const value = command[key];
            if (typeof value === "string" && value !== "*") { ids.add(value); }
        });
        if (command.face !== undefined && command.to !== undefined
                && typeof command.face === "string") {
            ids.add(command.face);
        }
        if (typeof command.exit === "string" && command.exit !== "*") {
            ids.add(command.exit);
        }
    });
    return Array.from(ids);
}

const tables = facialTables();
const standpicIndex = readJSON("asset", "story", "standpic-index.json");
const scripts = roomScripts();

// 一つの表情指定を解く。3D は facial table、立ち絵は持っている file の一覧。
function resolveUse(use) {
    const entry = CAST[use.who];
    if (!entry) { return { ok: false, why: "unknown cast id" }; }
    if (entry.standpic) {
        // 立ち絵は EMOTION_FALLBACK を辿って有る file に落とす
        // (core/advstage.js flatExpression と同じ鎖)。落ちた先が
        // "default" でも、それは仕様どおりの代役。
        const have = (standpicIndex.characters[entry.standpic] || {}).expressions || [];
        let key = String(use.name).split("-")[0];
        for (let hop = 0; hop < 8; hop++) {
            if (have.indexOf(key) >= 0) { return { ok: true, kind: "flat", index: key }; }
            const next = actor.EMOTION_FALLBACK[key];
            if (!next) { break; }
            key = next;
        }
        // 語彙に無い名前でも "default" に落ちてしまうので、名前が語彙に
        // 有るかどうかは別に見る。
        return { ok: have.indexOf("default") >= 0, kind: "flat", index: "default",
                 why: "fell all the way through to default" };
    }
    const record = tables[use.who];
    if (!record || record.error) {
        return { ok: false, why: record ? record.error : "no facial table" };
    }
    const table = record.table;
    // cast.js の faces override を先に見る。core/actor.js の create() が
    // 同じ順で見るので、ここも同じ順でなければ検査が実物とずれる。
    const override = entry.faces && entry.faces[use.name] !== undefined
        ? entry.faces[use.name] : null;
    const raw = override !== null ? override : use.name;
    const index = actor.emotionIndex(table, raw);
    const states = table.states.length;
    return {
        ok: index >= 0 && index < states,
        kind: "actor", index: index, states: states,
        override: override !== null,
        why: index < 0 ? "emotionIndex returned -1"
            : (index >= states ? "index " + index + " past " + states + " states" : null)
    };
}

const perScene = {};
Object.keys(SCENES).forEach(function (id) {
    const script = SCENES[id];
    const problems = adv.validate(script, CAST);
    const uses = faceUses(script);
    const bad = [];
    uses.forEach(function (use) {
        const result = resolveUse(use);
        if (!result.ok) {
            bad.push({ at: use.at, who: use.who, name: use.name, why: result.why });
        }
    });
    const unknownCast = castUses(script).filter(function (cid) { return !CAST[cid]; });
    perScene[id] = {
        length: script.length,
        lines: script.filter(function (c) {
            return c && (c.ja !== undefined || c.zh !== undefined);
        }).length,
        validate: problems,
        faceUses: uses.length,
        badFaces: bad,
        unknownCast: unknownCast,
        cast: castUses(script)
    };
});

// 立ち絵しか無い人 (マッチ) に "serious" を頼んだ時、どこへ落ちるか。
// 6.6 の趣旨は「黙って default に落ちるのを許さない」なので、代役が
// default そのものになる場合だけを数えて出す。
const flatFallbacks = [];
Object.keys(SCENES).forEach(function (id) {
    faceUses(SCENES[id]).forEach(function (use) {
        const entry = CAST[use.who];
        if (!entry || !entry.standpic) { return; }
        const result = resolveUse(use);
        flatFallbacks.push({ scene: id, at: use.at, who: use.who,
                             name: use.name, to: result.index });
    });
});

const bgmFiles = [];
[REGION_BGM, BOSS_BGM].forEach(function (map) {
    Object.keys(map).forEach(function (key) {
        bgmFiles.push({ key: key, track: map[key] });
    });
});

console.log(JSON.stringify({
    scenes: perScene,
    sceneIds: Object.keys(SCENES),
    roomScripts: scripts,
    regionBgmKeys: regionBgmKeys(),
    bossRooms: bossRooms(),
    pageClasses: pageClasses(),
    titleKinds: titleKinds(),
    backgrounds: backgrounds(),
    meta: META,
    facial: Object.keys(tables).reduce(function (acc, id) {
        acc[id] = tables[id].error
            ? { error: tables[id].error }
            : { path: tables[id].path, states: tables[id].table.states.length };
        return acc;
    }, {}),
    flatFallbacks: flatFallbacks,
    bgm: bgmFiles,
    // 6.6 の負例が本当に -1 を返すことを、検査の側でも一度確かめる。
    probe: {
        misspelt: actor.emotionIndex(tables.kirara.table, "happpy"),
        resolveMisspelt: actor.resolveFace
            ? actor.resolveFace(tables.kirara.table, "happpy") : null,
        outOfRange: actor.emotionIndex(tables.kirara.table, 99),
        states: tables.kirara.table.states.length
    }
}, null, 1));
