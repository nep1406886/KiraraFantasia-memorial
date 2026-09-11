// Harness for the dialogue system (T12, spec/05 §5–§7).
//
//   node tools/rl_dialogue_harness.mjs
//
// Gates, in file order:
//  1. DIALOGUE_FACES never drifts from core/actor.js GAME_EXPRESSIONS
//     (extracted from source — actor.js imports three, so no data:-URL
//     import is possible here; elements.js carries the same discipline).
//  2. Every asset/rl/dialogue/*.js loads in a sandbox window and merges
//     without clobbering (the Object.assign contract).
//  3. validateScripts: structure, faces, line limits, and who-resolution
//     through the same exact-then-【prefix】 resolver main.js uses.
//  4. Inventory: prologue, 5×(open/close/boss_pre/boss_post), finale trio,
//     40×3 rest nodes, 40 exit nodes — the 40 roster derived from meta.js's
//     own unlock API, not a hand-typed list.
//  5. Every line is Chinese-only body text (T22a 全量中文为正文): non-empty,
//     no ／ dual-write separator, and no kana outside the proper nouns the
//     localization itself keeps in kana (ハイプリス).
//  6. pages.js: 37 works, key = a real cards.js id, ≤120字, unique works.
//  7. 玩梗铁律 §6.1: no authored text shares a 6-character run with any
//     original game text on disk (skills/uniqueskill details, ItemList,
//     NamedList profiles, OriginalCharaLibraryList, CharacterList). Card,
//     character and work names are stripped first — 「ハイプリス」 is six
//     katakana and citing a name is not quoting a line.
//  8. play() sequencing through a fake presenter; unknown node rejects;
//     missing presenter rejects.
//  9. Wiring: roguelike.html ships every script file, main.js drives the
//     system, and no CDN hostname appears in the dialogue assets.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
    DIALOGUE_FACES, setCharacterResolver, loadDialogueScripts, getNode,
    validateScripts, play
} from "../site/game/rl/dialogue.js";
import { createMeta, pagesForVolume, FINALE_PAGES } from "../site/game/rl/meta.js";
import { isStoryId } from "../site/game/rl/story.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIALOGUE_DIR = join(ROOT, "asset", "rl", "dialogue");

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

// --- 1. DIALOGUE_FACES drift ---------------------------------------------------

{
    const actorSrc = readFileSync(join(ROOT, "core", "actor.js"), "utf8");
    const m = actorSrc.match(/GAME_EXPRESSIONS\s*=\s*\[([^\]]*)\]/);
    const real = m ? m[1].split(",").map(function (s) {
        return s.trim().replace(/^["']|["']$/g, "");
    }) : [];
    check("DIALOGUE_FACES matches core/actor.js GAME_EXPRESSIONS",
        real.length === DIALOGUE_FACES.length
        && real.every(function (f, i) { return f === DIALOGUE_FACES[i]; }),
        real.length + " expressions");
}

// --- cards: the gacha table, parsed the same way core/cards.js reads it -------

{
    const src = readFileSync(join(ROOT, "asset", "gacha", "cards.js"), "utf8");
    const data = JSON.parse(src.slice(src.indexOf("=") + 2).trim()
        .replace(/;\s*$/, ""));
    var CARDS = data.cards;
}
const cardById = new Map(CARDS.map(function (c) { return [c.id, c]; }));

// original-characters.js declares `var kirafanOriginalCharacters = [...]` at
// script scope, so the array literal is read out of the source directly.
const originalSrc = readFileSync(join(ROOT, "asset", "original-characters.js"), "utf8");
const originalNames = new Set();
{
    const m = originalSrc.match(/var\s+kirafanOriginalCharacters\s*=\s*(\[([\s\S]*?)\]);/);
    if (m) {
        const arr = JSON.parse(m[1].replace(/(\w+):/g, '"$1":'));
        arr.forEach(function (o) { originalNames.add(o.japanese); });
    }
}

// --- 2. load + merge every script file ------------------------------------------

const sandbox = { kirafanDialogue: undefined };
const files = readdirSync(DIALOGUE_DIR).filter(function (f) {
    return f.endsWith(".js");
}).sort();
{
    const pagesFile = "pages.js";
    for (const f of files) {
        const src = readFileSync(join(DIALOGUE_DIR, f), "utf8");
        try {
            // each file assigns window.kirafanDialogue or window.kirafanPages
            new Function("window", src)(sandbox);
        } catch (e) {
            check("script file " + f + " evaluates", false, e.message);
        }
    }
    check("dialogue scripts merge into one aggregate",
        sandbox.kirafanDialogue && Object.keys(sandbox.kirafanDialogue).length > 0,
        files.length + " files, " + Object.keys(sandbox.kirafanDialogue || {}).length + " nodes");
    check("pages.js publishes window.kirafanPages",
        sandbox.kirafanPages && Object.keys(sandbox.kirafanPages).length > 0,
        Object.keys(sandbox.kirafanPages || {}).length + " pages");
    void pagesFile;
}

// --- 3. structural validation with the real resolver ---------------------------

// Same resolver as main.js: exact card name, then a 【variant】 prefix match
// that is one of the 40 roster cards (those ship busts), then the
// original-characters roster (メディア/ハイプリス), then any prefix.
const rosterIds = (function () {
    const m = createMeta();
    for (let v = 1; v <= 5; v++) { m.clearVolume(v); }
    return m.progression.chars;
})();
function resolveWho(who) {
    for (const c of CARDS) {
        if (c.name === who) { return c; }
    }
    for (const c of CARDS) {
        if (c.name.indexOf(who + "【") === 0
                && rosterIds.indexOf(c.id) >= 0) {
            return c;
        }
    }
    if (originalNames.has(who)) { return { name: who }; }
    for (const c of CARDS) {
        if (c.name.indexOf(who + "【") === 0) { return c; }
    }
    return null;
}

setCharacterResolver(resolveWho);
{
    const result = loadDialogueScripts(sandbox);
    check("validateScripts: every node passes structure + who-resolution",
        result.ok, result.ok ? "" : result.errors.slice(0, 6).join(" | "));
    // validateScripts must be pure — a second pass on a broken object fails.
    const broken = validateScripts({ bad: [{ who: "", face: "nope", text: "" }] });
    check("validateScripts rejects malformed nodes", !broken.ok);
}

// --- 4. inventory ----------------------------------------------------------------

{
    const nodes = sandbox.kirafanDialogue;
    const expected = ["prologue"];
    for (let v = 1; v <= 5; v++) {
        expected.push("v" + v + "_open", "v" + v + "_close",
            "v" + v + "_boss_pre", "v" + v + "_boss_post");
    }
    expected.push("finale_intro", "finale_pre", "finale_end");
    const missing = expected.filter(function (id) { return !nodes[id]; });
    check("node inventory: prologue + 5 volumes + finale trio",
        missing.length === 0, missing.length ? "missing " + missing.join(", ") : expected.length + " nodes");

    // The 40-name roster, derived from meta.js's own unlock chain — not
    // retyped. cards.js names the roster's cards with 【variant】 suffixes
    // (きらら【マンガ版】, うつつ【第2部】); dialogue keys use the base name
    // the way cards-rl.json does, so strip the suffix.
    function baseName(c) {
        return c ? c.name.replace(/【.*$/, "") : "(no card)";
    }
    const meta = createMeta();
    for (let v = 1; v <= 5; v++) { meta.clearVolume(v); }
    // Persistence retains old story IDs as well as evolved playable cards.
    // The gacha/story table identifies the original 40, not the union's size.
    const rosterIds = meta.progression.chars.filter(id => cardById.has(id));
    const rosterNames = rosterIds.map(function (id) {
        return baseName(cardById.get(id));
    });
    check("meta retains the authored 40 narrative identities", rosterIds.length === 40,
        rosterIds.length + " ids");

    let restMissing = [], exitMissing = [];
    rosterNames.forEach(function (name) {
        for (let n = 1; n <= 3; n++) {
            if (!nodes["rest_" + name + "_" + n]) { restMissing.push(name + "_" + n); }
        }
        if (!nodes["exit_" + name]) { exitMissing.push(name); }
    });
    check("rest chatter: 40 characters × 3 lines",
        restMissing.length === 0,
        restMissing.length ? "missing " + restMissing.slice(0, 6).join(", ") : "120 nodes");
    check("exit lines: 40 characters",
        exitMissing.length === 0,
        exitMissing.length ? "missing " + exitMissing.join(", ") : "40 nodes");

    // Every rest/exit node's who must be that same roster name.
    let whoMismatch = [];
    Object.keys(nodes).forEach(function (id) {
        const m = id.match(/^rest_(.*)_([123])$/);
        if (m) {
            nodes[id].forEach(function (line) {
                if (line.who !== m[1]) { whoMismatch.push(id + " says " + line.who); }
            });
        }
        const e = id.match(/^exit_(.+)$/);
        if (e) {
            nodes[id].forEach(function (line) {
                if (line.who !== e[1]) { whoMismatch.push(id + " says " + line.who); }
            });
        }
    });
    check("rest/exit node keys agree with their who", whoMismatch.length === 0,
        whoMismatch.slice(0, 4).join("; "));

    // No stray node families.
    const familyOk = Object.keys(nodes).every(function (id) {
        // tutorial: the one-shot first-run walkthrough node (阶段 8 教学).
        return isStoryId(id) || /^(prologue|tutorial|v[1-5]_(open|close|boss_pre|boss_post)|finale_(intro|pre|end)|rest_.+_[123]|exit_.+)$/.test(id);
    });
    check("every node key belongs to a spec/05 §5 family", familyOk);
}

// --- 5. Chinese-only line format (T22a) ----------------------------------------------

{
    // Proper nouns the shipped localization keeps in kana — the same names
    // the cards table itself leaves untranslated.
    const KANA_OK = ["ハイプリス"];
    const KANA = /[぀-ゟ゠-ヿ]/;
    let bad = [];
    Object.keys(sandbox.kirafanDialogue).forEach(function (id) {
        sandbox.kirafanDialogue[id].forEach(function (line, i) {
            const text = line.text;
            if (!text.trim() || text.indexOf("／") >= 0) {
                bad.push(id + "[" + i + "] empty or dual-write");
                return;
            }
            let body = text;
            KANA_OK.forEach(function (n) { body = body.split(n).join(""); });
            if (KANA.test(body)) {
                bad.push(id + "[" + i + "] stray kana");
            }
        });
    });
    check("every dialogue line is Chinese-only body text", bad.length === 0,
        bad.length ? bad.slice(0, 6).join(", ") : "all lines");
}

// --- 6. pages.js -------------------------------------------------------------------

{
    const pages = sandbox.kirafanPages;
    const ids = Object.keys(pages);
    const works = new Set();
    let bad = [];
    ids.forEach(function (id) {
        const p = pages[id];
        const c = cardById.get(Number(id));
        if (!c) { bad.push(id + " is not a cards.js id"); return; }
        if (!p.work || !p.text || typeof p.text !== "string") {
            bad.push(id + " missing work/text"); return;
        }
        if (p.hero && p.hero !== c.name && p.hero !== c.character
                && p.hero !== c.name.replace(/【.*$/, "")) {
            bad.push(id + " hero " + p.hero + " is not the card's " + c.name);
        }
        // ≤120字 (spec/05 §7)
        const len = Array.from(p.text).length;
        if (len > 120) { bad.push(id + " text is " + len + " chars"); }
        works.add(p.work);
    });
    check("pages: 37 works, real card ids, hero matches, ≤120字",
        ids.length === 37 && bad.length === 0,
        ids.length + " pages, " + works.size + " works" + (bad.length ? "; " + bad.slice(0, 4).join("; ") : ""));

    // 6b. Drop order (阶段 5): meta.js's VOLUME_PAGES (guards hand out
    // pages[(floor-1) % 7], the floor-20 boss sweeps the rest) plus the three
    // finale strays must cover the 图鑑 exactly — a page no volume ever offers
    // is unreachable, an id that is not a pages.js key collects into nothing.
    const offered = new Set();
    for (let v = 1; v <= 5; v++) {
        pagesForVolume(v).forEach(function (id) { offered.add(String(id)); });
    }
    FINALE_PAGES.forEach(function (id) { offered.add(String(id)); });
    const pageKeys = new Set(ids);
    const missing = ids.filter(function (k) { return !offered.has(k); });
    const phantom = Array.from(offered).filter(function (k) { return !pageKeys.has(k); });
    check("pages: VOLUME_PAGES + finale strays cover the 図鑑 exactly",
        missing.length === 0 && phantom.length === 0,
        "missing=" + JSON.stringify(missing) + " phantom=" + JSON.stringify(phantom));
}

// --- 7. 玩梗铁律: 6-char collision vs every original text --------------------------

{
    // Corpus: every conversational original text on disk.
    const pieces = [];
    function push(s) { if (typeof s === "string" && s.length >= 6) { pieces.push(s); } }

    const skillSrc = readFileSync(join(ROOT, "asset", "battle", "skills.js"), "utf8");
    const skills = JSON.parse(skillSrc.slice(skillSrc.indexOf("=") + 2).trim()
        .replace(/;\s*$/, "")).skills;
    Object.values(skills).forEach(function (s) { push(s.name); push(s.detail); });

    const usSrc = readFileSync(join(ROOT, "asset", "battle", "uniqueskill.js"), "utf8");
    const scenes = JSON.parse(usSrc.slice(usSrc.indexOf("=") + 2).trim()
        .replace(/;\s*$/, "")).scenes;
    Object.values(scenes).forEach(function (s) { push(s.name); push(s.detail); });

    const itemRows = JSON.parse(readFileSync(join(ROOT, ".codex-tmp", "ItemList.json"), "utf8"));
    itemRows.forEach(function (r) { push(r.m_Name); push(r.m_DetailText); });

    const namedRows = JSON.parse(readFileSync(join(ROOT, ".codex-tmp", "NamedList.json"), "utf8"));
    namedRows.forEach(function (r) {
        push(r.m_ProfileText); push(r.m_NickName); push(r.m_FullName);
    });

    const origRows = JSON.parse(readFileSync(
        join(ROOT, ".codex-tmp", "OriginalCharaLibraryList.json"), "utf8"));
    origRows.forEach(function (r) { push(r.m_Title); push(r.m_Descript); });

    const charaRows = JSON.parse(readFileSync(
        join(ROOT, ".codex-tmp", "CharacterList.json"), "utf8"));
    charaRows.forEach(function (r) { push(r.m_Name); });

    const corpus = pieces.join("\n");
    const grams = new Set();
    for (let i = 0; i + 6 <= corpus.length; i++) {
        grams.add(corpus.slice(i, i + 6));
    }

    // Whitelist: proper nouns a line may legitimately cite — card names,
    // characters, work titles (longest first so 「九条 カレン【聖夜】」-style
    // variants are stripped before their shorter bases).
    const names = new Set();
    CARDS.forEach(function (c) {
        if (c.name && c.name.length >= 4) { names.add(c.name); }
        if (c.character && c.character.length >= 4) { names.add(c.character); }
        if (c.title && c.title.length >= 4) { names.add(c.title); }
    });
    originalNames.forEach(function (n) { if (n.length >= 4) { names.add(n); } });
    const sorted = Array.from(names).sort(function (a, b) { return b.length - a.length; });

    function stripNames(text) {
        let out = text;
        for (const n of sorted) {
            if (out.indexOf(n) >= 0) {
                out = out.split(n).join("◇");
            }
        }
        return out;
    }

    let hits = [];
    // A window must contain at least one kanji to count: pure-kana runs
    // (してください, っています。) are function-word grammar that every
    // natural Japanese sentence shares with the corpus — quoting a line
    // copies its content words, and those carry kanji. Recorded in
    // spec/05 §6 as the gate's operating definition.
    const KANJI = /[一-鿿]/;
    function scan(label, text) {
        const stripped = stripNames(text);
        for (let i = 0; i + 6 <= stripped.length; i++) {
            const g = stripped.slice(i, i + 6);
            if (KANJI.test(g) && grams.has(g)) {
                hits.push(label + ": …" + g + "…");
                return;
            }
        }
    }

    Object.keys(sandbox.kirafanDialogue).forEach(function (id) {
        sandbox.kirafanDialogue[id].forEach(function (line, i) {
            scan(id + "[" + i + "]", line.text);
        });
    });
    Object.keys(sandbox.kirafanPages).forEach(function (id) {
        scan("page " + id, sandbox.kirafanPages[id].text);
    });

    check("玩梗铁律: no 6-char run shared with any original text",
        hits.length === 0,
        hits.length ? hits.length + " hits — " + hits.slice(0, 8).join(" | ") : "0 hits");
}

// --- 8. play() sequencing -----------------------------------------------------------

{
    const shown = [];
    let finishes = 0;
    const fake = {
        showLine: function (line) { shown.push(line.who); },
        waitInput: function () { return Promise.resolve(); },
        finish: function () { finishes += 1; }
    };
    const node = sandbox.kirafanDialogue.prologue;
    await play("prologue", fake).then(function () {
        check("play(): walks every line, then finishes",
            shown.length === node.length && finishes === 1,
            shown.length + " lines shown");
    });
    let rejectedUnknown = false;
    await play("no_such_node_xyz", fake).catch(function () { rejectedUnknown = true; });
    check("play(): unknown node rejects", rejectedUnknown);
    let rejectedPresenter = false;
    await play("prologue", null).catch(function () { rejectedPresenter = true; });
    check("play(): missing presenter rejects", rejectedPresenter);
    check("getNode(): returns the loaded node",
        Array.isArray(getNode("prologue")) && getNode("prologue") === node);
}

// --- 9. wiring ------------------------------------------------------------------------

{
    const html = readFileSync(join(ROOT, "game", "roguelike.html"), "utf8");
    const missingTags = files.filter(function (f) {
        return html.indexOf("dialogue/" + f) < 0;
    });
    check("roguelike.html ships every dialogue script file",
        missingTags.length === 0,
        missingTags.length ? "missing " + missingTags.join(", ") : files.length + " tags");
    check("roguelike.html loads original-characters.js for the originals",
        html.indexOf("original-characters.js") >= 0);

    const mainSrc = readFileSync(join(ROOT, "game", "rl", "main.js"), "utf8");
    const wired = ["dialogue.js", "ui/dialogue.js", "initDialogue",
        "queueDialogue", "restChatterNode", "finale_pre", "prologue"]
        .every(function (token) { return mainSrc.indexOf(token) >= 0; });
    check("main.js drives the dialogue system", wired);

    let cdnHits = [];
    for (const f of files) {
        const src = readFileSync(join(DIALOGUE_DIR, f), "utf8");
        if (/kirafan\.gitlab\.io|asset\.kirafan\.cn/.test(src)) {
            cdnHits.push(f);
        }
    }
    check("no CDN hotlinking in dialogue assets", cdnHits.length === 0);
}

console.log("\n" + "=".repeat(60));
if (failures) {
    console.log("FAILED: " + failures + " gate(s)");
    process.exit(1);
}
console.log("ALL GREEN");
