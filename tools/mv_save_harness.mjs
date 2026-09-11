// core/save.js を node で回す為の台。tools/check_mv_save.py が読む JSON を吐く。
//
// save.js は `window.localStorage` と `console.warn` しか外を見ないので、
// 書き換えずにそのまま import できる。**写しを作らない** —— 検める対象は
// 実物でなければ、検めた事にならない。
//
// module の中に `cache` が居るので、一度 import すると状態が持ち越される。
// 場面ごとに別の store から始めたいので、`?fresh=n` を付けて import し直して
// module instance を作り分ける (node の loader は query 込みで別 key と見る)。

// 置き場所について: この file は staging tree の core/ に写され、隣の save.js を
// `./save.js` で読む。tools/check_mv_rooms.py と同じ作りで、根に置く
// package.json {"type":"module"} が .js を ES module として読ませる (無いと
// bare .js は CommonJS 扱いで import が死ぬ)。
//
// 否定例は check 側が staging tree の save.js を書き換えて注入する。だから
// ここは「実物を読む」以外の事をしない。
const SAVE_URL = "./save.js";
const KEY = "kirafan-fangame:save";

let freshCount = 0;

// 一場面ぶんの localStorage。実物と同じく文字列しか持たない —— object を
// そのまま返す stub にすると、JSON.parse を通らない分だけ本番より易しくなる。
function makeStorage(initialRaw) {
    const map = new Map();
    if (initialRaw !== undefined && initialRaw !== null) {
        map.set(KEY, String(initialRaw));
    }
    const storage = {
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) {
            if (storage.failWrites) { throw new Error("quota"); }
            map.set(k, String(v));
        },
        removeItem(k) { map.delete(k); },
        raw() { return map.has(KEY) ? map.get(KEY) : null; },
        failWrites: false
    };
    return storage;
}

// initialRaw に入れた文字列がその場面の「既に在る存畫」。
// undefined = key が無い、"..." = その中身がそのまま入っている。
async function scene(initialRaw) {
    const storage = makeStorage(initialRaw);
    globalThis.window = { localStorage: storage };
    freshCount += 1;
    const save = await import(SAVE_URL + "?fresh=" + freshCount);
    return { save, storage };
}

function parseRaw(raw) {
    if (raw === null) { return null; }
    try { return JSON.parse(raw); } catch (e) { return { parseError: String(e) }; }
}

const out = {};

// --- ① 素の起動 ------------------------------------------------------------
{
    const { save, storage } = await scene(undefined);
    const store = save.get();
    out.blankShape = {
        keys: Object.keys(store).sort(),
        version: store.version,
        recovered: store.recovered,
        chapters: store.chapters,
        mvIsObject: !!store.mv && typeof store.mv === "object",
        // 読むだけでは書かない。ここで既に書いていると、頁を開いただけの
        // browser に存畫が生える。
        wroteOnRead: storage.raw() !== null
    };
    out.missingScopeIsEmpty = JSON.stringify(save.get("nosuchscope")) === "{}";
}

// --- ② 壊れた・欠けた存畫 --------------------------------------------------
//
// ここが今回の穴。JSON として読める が 形が違う 存畫を並べて、
// clearChapter / recover が投げずに済むかを見る。
const BROKEN = {
    // 通る JSON だが chapters が無い。旧い build から来た、途中で書き損じた、
    // 手で編んだ —— どれでも到達する。
    missingChapters: '{"version":1,"recovered":[],"rpg":{},"mv":{}}',
    missingRecovered: '{"version":1,"chapters":[],"mv":{}}',
    // 型が違う。null / 文字列 / object を配列の席に置く。
    nullArrays: '{"version":1,"recovered":null,"chapters":null}',
    stringArrays: '{"version":1,"recovered":"","chapters":"mv"}',
    objectArrays: '{"version":1,"recovered":{},"chapters":{}}',
    // 全く別物。配列や素の値が来た場合。
    topLevelArray: '[1,2,3]',
    topLevelNumber: '42',
    topLevelNull: 'null',
    // 読めない JSON。ここは元から catch が拾っていた道。
    unparseable: '{"version":1,',
    empty: ''
};

out.broken = {};
for (const [name, raw] of Object.entries(BROKEN)) {
    const { save, storage } = await scene(raw);
    const rec = { threw: null };
    try {
        // 終局が通る道。E は game/mv.js:550 で これ を呼ぶ。
        save.clearChapter("mv");
        save.recover(10002000);
        rec.chapters = save.get().chapters;
        rec.recovered = save.get().recovered;
        rec.isCleared = save.isChapterCleared("mv");
        rec.isRecovered = save.isRecovered(10002000);
        rec.recoveredIds = save.recoveredIds();
    } catch (e) {
        rec.threw = String(e && e.message ? e.message : e);
    }
    rec.raw = parseRaw(storage.raw());
    out.broken[name] = rec;
}

// --- ③ 知らない scope を消さない ------------------------------------------
//
// 別の作 (F など) が書いた scope を、こちらの blank() が知らないからと言って
// 落としてはいけない。
{
    const raw = '{"version":1,"recovered":[],"chapters":[],'
        + '"lb":{"volume":3},"somethingNew":{"x":1}}';
    const { save } = await scene(raw);
    save.clearChapter("mv");
    const store = save.get();
    out.keepsUnknownScopes = {
        lb: store.lb,
        somethingNew: store.somethingNew
    };
}

// --- ④ patch は兄弟を巻き込まない ----------------------------------------
//
// §6.7 が `set` ではなく `patch` を使うと決めた理由そのもの。E は房を出る度に
// room を書くので、そこで held や keys が消えると能力が失われる。
{
    const { save, storage } = await scene(undefined);
    save.patch("mv", { room: "R0-01", held: ["A1", "A2"], keys: { jump: "z" } });
    save.patch("mv", { room: "R0-02" });
    const afterPatch = save.get("mv");
    save.set("mv", { room: "R0-03" });
    const afterSet = save.get("mv");
    out.patchVsSet = {
        // patch の後: room だけ動いて held と keys は残る。
        patchKeeps: afterPatch,
        // set の後: 丸ごと置き換わる。これが「なぜ patch を使うか」の実演。
        setDrops: afterSet,
        // 書いた物は本当に localStorage に降りている。
        persisted: parseRaw(storage.raw())
    };
}

// --- ⑤ 往復 --------------------------------------------------------------
//
// 書いた存畫を別の module instance が読み直して同じ物を得るか。
// (cache を跨ぐ道が本番の「頁を開き直す」に当たる)
{
    const first = await scene(undefined);
    first.save.patch("mv", { room: "R4-03", held: ["A1", "A3"], life: 2 });
    first.save.clearChapter("mv");
    first.save.recover(10002000);
    const raw = first.storage.raw();

    const second = await scene(raw);
    out.roundTrip = {
        mv: second.save.get("mv"),
        chapters: second.save.get().chapters,
        recovered: second.save.get().recovered,
        // 二度書いても増えない。
        idempotent: (function () {
            second.save.clearChapter("mv");
            second.save.recover(10002000);
            return { chapters: second.save.get().chapters,
                     recovered: second.save.get().recovered };
        }())
    };
}

// --- ⑥ 書けない時に投げない ----------------------------------------------
//
// localStorage が満杯 / 無効 (private mode) の時。遊べなくなるより、
// 記録が残らない方を選ぶ。
{
    const { save, storage } = await scene(undefined);
    storage.failWrites = true;
    const rec = { threw: null };
    const warn = console.warn;
    let warned = 0;
    console.warn = function () { warned += 1; };
    try {
        save.patch("mv", { room: "R0-01" });
        save.clearChapter("mv");
        // 書けなくても、その場の値は読める (cache に載っている)。
        rec.stillReadable = save.get("mv").room === "R0-01"
            && save.isChapterCleared("mv");
    } catch (e) {
        rec.threw = String(e && e.message ? e.message : e);
    } finally {
        console.warn = warn;
    }
    rec.warned = warned;
    rec.storedNothing = storage.raw() === null;
    out.writeFailure = rec;
}

// --- ⑦ reset ------------------------------------------------------------
{
    const raw = '{"version":1,"recovered":[1],"chapters":["mv"],"mv":{"room":"R7-08"}}';
    const { save, storage } = await scene(raw);
    save.reset();
    out.reset = {
        store: save.get(),
        persisted: parseRaw(storage.raw())
    };
}

// --- ⑧ version が違う存畫 ------------------------------------------------
{
    const raw = '{"version":99,"recovered":[7],"chapters":["rpg"],"mv":{"room":"R2-02"}}';
    const { save } = await scene(raw);
    const store = save.get();
    out.versionMismatch = {
        version: store.version,
        // 進行を捨てない。version を直すだけ。
        keptRecovered: store.recovered,
        keptChapters: store.chapters,
        keptMv: store.mv
    };
}

process.stdout.write(JSON.stringify(out, null, 1));
