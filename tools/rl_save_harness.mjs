// Harness for game/rl/save.js (T05's deferred third, plan 阶段 5 acceptance):
//
//   node tools/rl_save_harness.mjs
//
// 1. 写入→读出→再写入，两次序列化结果字节相同
// 2. 缺字段的旧存档能加载（默认值兜底在 meta.mergeState，一起验），不抛异常
// 3. 损坏的 JSON 不白屏——load 回 null，游戏回退新存档
// 4. export/import 回环；垃圾导入是 null 不是异常
//
// 浏览器侧的两条（清 localStorage 重开、导出文件导回）走阶段 8 的 UI 闸门，
// 这里用注入的存储后端把语义钉死。

import * as save from "../site/game/rl/save.js";
import { mergeState } from "../site/game/rl/meta.js";
import { PLAYABLE_IDS } from "../site/game/rl/rosterids.js";
import { checkProfileEnvelope } from "../site/game/rl/profileschema.js";

// This file checks storage transport; rl_storage_harness validates real game IDs.
save.setImportValidator(checkProfileEnvelope);

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

// Map-based fake with the Storage interface (length/key included —
// exportSave enumerates it).
function fakeStorage() {
    const memory = new Map();
    return {
        getItem: function (k) { return memory.has(k) ? memory.get(k) : null; },
        setItem: function (k, v) { memory.set(k, String(v)); },
        removeItem: function (k) { memory.delete(k); },
        get length() { return memory.size; },
        key: function (i) { return Array.from(memory.keys())[i] || null; }
    };
}

// --- 1. byte-identical round-trip ---------------------------------------------

{
    save.setStorage(fakeStorage());
    const data = {
        volumes: 2,
        chars: [10000000, 18000000, 29001000],
        levels: { "10000000": 47 },
        nested: { deep: [1, 2, { x: "百物語の残页" }] }
    };
    save.write("meta", data);
    const first = save.load("meta");
    save.write("meta", first);
    const second = save.load("meta");
    check("write→load→write byte-identical", JSON.stringify(first) === JSON.stringify(data)
        && JSON.stringify(second) === JSON.stringify(data));

    // vacuity guard: a mutated state must NOT round-trip to the same string
    const tampered = JSON.parse(JSON.stringify(second));
    tampered.volumes = 3;
    check("vacuity guard: changed data serializes differently",
        JSON.stringify(tampered) !== JSON.stringify(data));
}

// --- 2. old save with missing fields -------------------------------------------

{
    const merged = mergeState({ chars: [99999999], volumes: 1 });
    check("old save: unknown chars kept, defaults filled",
        merged.chars.indexOf(99999999) >= 0
        && merged.chars.indexOf(10000000) >= 0
        && merged.volumes === 1
        && merged.gems === 0
        && Array.isArray(merged.pages));
    const empty = mergeState(null);
    // The historical 40 IDs stay valid for old stories/saves; the current
    // evolved playable identities are a separate, disjoint set.
    check("null save → historical and current identity defaults", empty.chars.length === 40 + PLAYABLE_IDS.length
        && PLAYABLE_IDS.every(id => empty.chars.includes(id)) && empty.chars.includes(10000000)
        && empty.volumes === 0);
    const insane = mergeState({ volumes: 99, gems: -5, shards: -5,
        levels: { "10000000": 999 } });
    check("out-of-range fields clamped, not trusted",
        insane.volumes === 0 && insane.gems === 0
        && insane.levels["10000000"] === undefined);

    let threw = null;
    try {
        mergeState({ chars: "not-an-array", levels: 7 });
    } catch (err) { threw = err; }
    check("malformed old save loads without throwing", threw === null);
}

// --- 3. corrupted JSON ----------------------------------------------------------

{
    const storage = fakeStorage();
    save.setStorage(storage);
    storage.setItem("kirafan-rl:meta", "{this is not json");
    check("corrupted slot → load returns null", save.load("meta") === null);
    storage.setItem("kirafan-rl:meta", "");
    check("empty slot → load returns null", save.load("meta") === null);
    storage.removeItem("kirafan-rl:meta");
    check("missing slot → load returns null", save.load("meta") === null);
}

// --- 4. export/import loopback ---------------------------------------------------

{
    const origin = fakeStorage();
    save.setStorage(origin);
    save.write("meta", { volumes: 3, chars: [1, 2, 3] });
    save.write("run", { floor: 7, seed: "x" });
    const bundle = save.exportSave();

    const target = fakeStorage();
    save.setStorage(target);
    check("fresh storage has nothing", save.load("meta") === null);
    const back = save.importSave(bundle);
    check("import returns the committed profile", back.ok
        && JSON.stringify(back.profile.meta) === JSON.stringify({ volumes: 3, chars: [1, 2, 3] }));
    check("both slots survive the trip", save.load("meta").volumes === 3
        && save.load("run").floor === 7);

    check("import of garbage rejected", !save.importSave("{{{").ok);
    check("import of empty object rejected", !save.importSave("{}").ok);
    check("import of array rejected", !save.importSave("[1,2]").ok);
    const halfBroken = save.importSave(JSON.stringify({
        meta: "{\"volumes\":4}",
        junk: "not json at all"
    }));
    // T24 (spec/07 §6): the whole bundle is validated BEFORE any write, so a
    // corrupt entry fails the import and the target storage stays untouched.
    check("one corrupt entry fails the whole import, nothing lands",
        !halfBroken.ok && save.load("meta") !== null
        && save.load("meta").volumes === 3);
}

console.log(failures === 0 ? "\nALL GREEN" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
