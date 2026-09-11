// Harness for game/rl/meta.js (T11 acceptance, spec/06):
// 死亡结算→解锁链路；导入导出回环.
//
//   node tools/rl_meta_harness.mjs
//
// Fresh metadata retains the historical 40 story IDs AND all current playable
// five-star IDs. Persistence identities are not the visible roster count.

import * as save from "../site/game/rl/save.js";
import { createMeta } from "../site/game/rl/meta.js";
import { PLAYABLE_IDS } from "../site/game/rl/rosterids.js";
import { checkProfileEnvelope } from "../site/game/rl/profileschema.js";

// Data-table validation is covered separately by rl_storage_harness.
save.setImportValidator(checkProfileEnvelope);

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}

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

// spec/05 §3, worked by hand:
const V1 = [29001000, 47002000, 28001000, 31001000, 21000000, 19000000];
const V2 = [37002000, 34001000, 39001000, 25021000, 26000000, 36001000, 14010000];
const V3 = [12000000, 27001000, 41001000, 43001000, 42001000, 33011000, 17000000];
const V4 = [16000000, 45002000, 40002000, 13000000];
const V5 = [46002000, 22000000, 23011000];
const UTSUTSU = 32172000;
const FIRST12 = [10000000, 18000000, 14000000, 30001000, 23001000, 15000000,
    35001000, 11010000, 38001000, 24001000, 20000000, 32002000];
const ALL40 = FIRST12.concat(V1, V2, V3, V4, V5, [UTSUTSU]);
const ALL_IDENTITIES = Array.from(new Set(ALL40.concat(PLAYABLE_IDS)));
const hasAllIdentities = ids => ids.length === ALL_IDENTITIES.length
    && ALL_IDENTITIES.every(id => ids.includes(id));

// --- 1. fresh state -------------------------------------------------------------

save.setStorage(fakeStorage());
const meta = createMeta();
meta.read();
const fresh = meta.progression;
check("fresh: historical and current identities, no volumes, no pages", hasAllIdentities(fresh.chars)
    && fresh.volumes === 0 && fresh.pages.length === 0);
check("fresh: every unlock tier is present from the start",
    ALL40.every(function (id) { return fresh.chars.indexOf(id) >= 0; }));

// --- 2. unlock chain (T22l: beats re-confirm, never add) -------------------------

check("unlock of an owned char is a no-op (false)", meta.unlock(10000000) === false);
check("…and the identity set does not grow", hasAllIdentities(meta.progression.chars));

const got1 = meta.clearVolume(1);
check("clearVolume(1) unlocks nobody new (all pre-owned)", got1.length === 0,
    JSON.stringify(got1));
check("…but the V1 cameos are all on the roster", V1.every(function (id) {
    return meta.progression.chars.indexOf(id) >= 0;
}));
check("volumes advanced to 1", meta.progression.volumes === 1);
meta.clearVolume(1);
check("re-clearing a volume unlocks nobody new",
    hasAllIdentities(meta.progression.chars));

// unlock() as a bouncer, on a throwaway meta: every authored id is already
// owned, so only the refusal paths remain — which is the whole T22l contract.
{
    save.setStorage(fakeStorage());
    const probe = createMeta();
    probe.read();
    check("unlock of any authored char is false (all owned)",
        ALL_IDENTITIES.every(function (id) { return probe.unlock(id) === false; })
        && hasAllIdentities(probe.progression.chars));
    const bogus = [0, 12345, 10000000.5, "10000000", 99000000];
    check("IDs outside the historical/current identity sets cannot enter", bogus.every(function (id) {
        return probe.unlock(id) === false;
    }) && hasAllIdentities(probe.progression.chars));
}

meta.clearVolume(2);
meta.clearVolume(3);
meta.clearVolume(4);
const before5 = meta.progression.chars.length;
const got5 = meta.clearVolume(5);
check("clearVolume(5) confirms 0 new (cameos + うつつ pre-owned)",
    got5.length === 0, JSON.stringify(got5));
check("all historical/current identities survive the final volume", hasAllIdentities(meta.progression.chars)
    && before5 === ALL_IDENTITIES.length);
check("volumes = 5", meta.progression.volumes === 5);
check("volumes never regress", meta.clearVolume(2).length === 0
    && meta.progression.volumes === 5);

// --- 3. death settlement → unlock chain ------------------------------------------

{
    save.setStorage(fakeStorage());
    const m = createMeta();
    m.read();
    // hand-computed: value = 20 (epic) + 1 (common) + 5 (rare) = 26
    //   × 0.3 = 7.8 → floor = 7 gems (星彩石)
    const result = m.settle({ items: [
        { slot: "weapon", rarity: "epic", affixes: [] },
        { slot: "charm", rarity: "common", affixes: [] },
        { slot: "armor", rarity: "rare", affixes: [] }
    ] });
    check("settle: 26 value × 0.3 → 7 星彩石 (gems)", result.gems === 7 && m.gems() === 7);
    const zero = m.settle({ items: [{ rarity: "made-up" }] });
    check("unknown rarity counts as 0", zero.gems === 0);
    const empty = m.settle({});
    check("settle of an empty run is legal", empty.gems === 0);

    // the full 链路: a run's drops → settle → train → level survives reload
    m.clearVolume(2);
    // hand sums with cost(lv) = 10 + 2×lv per level gained:
    const to5 = m.train(37002000, 5);
    check("train 1→5 with 7 gems is refused as poor", to5.reason === "poor"
        && to5.spent === 0 && m.gems() === 7);
    // 320 legendaries → 320 × 60 × 0.3 = 5760 gems; balance 7 + 5760 = 5767
    m.settle({ items: Array.from({ length: 320 }, function () {
        return { rarity: "legendary" };
    }) });
    check("legendary haul converts to 5760 gems", m.gems() === 5767,
        String(m.gems()));
    const affordable = m.train(37002000, 5);
    check("train 1→5 costs 12+14+16+18 = 60", affordable.spent === 60
        && affordable.level === 5, JSON.stringify(affordable));
    // 5→80 needs 7050; top the balance up with a second haul so the cap
    // itself is exercised (base cap 80 = the evolved ★5 initLimitLv).
    m.settle({ items: Array.from({ length: 400 }, function () {
        return { rarity: "legendary" };
    }) });
    check("second haul converts to 7200 gems", m.gems() === 12907,
        String(m.gems()));
    const toCap = m.train(37002000, 999);
    // 5→80: 75 levels × 10 + 2×(5+…+79) = 750 + 2×3150 = 7050
    check("affordable train stops at the LB cap (80 at 0 LB)",
        toCap.level === 80 && toCap.spent === 7050, JSON.stringify(toCap));
    const overCap = m.train(37002000, 81);
    check("training beyond the cap spends nothing", overCap.spent === 0
        && overCap.reason === "cap");

    // save → export → fresh storage → import → read back
    const bundle = save.exportSave();
    save.setStorage(fakeStorage());
    const m2 = createMeta();
    m2.read();
    check("fresh storage contains historical and current identities",
        hasAllIdentities(m2.progression.chars));
    save.importSave(bundle);
    m2.read();
    check("回环: progression survives export→import→read",
        hasAllIdentities(m2.progression.chars),
        String(m2.progression.chars.length));
    check("回环: trained level survives", m2.levelOf(37002000) === 80);
    check("回环: gem balance survives", m2.gems() === m.gems()
        && m.gems() === 12907 - 7050);

    // limitBreak: 4 max, +5 level cap each. Balance 5857 covers 4 × 500.
    const lb1 = m2.limitBreak(37002000);
    check("LB costs 500 and lands at 1", lb1.lb === 1 && lb1.spent === 500);
    check("cap raised to 85", m2.levelCap(37002000) === 85);
    let last = null;
    for (let i = 0; i < 3; i++) { last = m2.limitBreak(37002000); }
    check("LB reaches 4 after 3 more", last.lb === 4
        && m2.levelCap(37002000) === 100);
    const fifth = m2.limitBreak(37002000);
    check("5th attempt rejected as max", fifth.reason === "max"
        && fifth.spent === 0);

    // pre-rename slot (残片 era) migrates 1:1 into gems
    {
        save.setStorage(fakeStorage());
        save.write("meta", { shards: 42 });       // no gems key at all
        const old = createMeta();
        old.read();
        check("legacy 残片 slot migrates to 42 gems", old.gems() === 42);
        save.setStorage(fakeStorage());
        save.write("meta", { gems: 9, shards: 42 });
        const both = createMeta();
        both.read();
        check("gems key wins over legacy shards when both present", both.gems() === 9);
        save.setStorage(fakeStorage());
    }
}

// --- 4. 敌人図鑑 encounter recording (T22f) --------------------------------------

{
    save.setStorage(fakeStorage());
    const m = createMeta();
    m.read();
    check("fresh: no encountered enemies", m.progression.enemies.length === 0);
    const batch = m.encounterEnemies([29012001, "29013003", 29012001]);
    check("batch records numeric and string ids once each",
        batch === 2 && m.progression.enemies.length === 2,
        JSON.stringify(m.progression.enemies));
    check("…stored as strings, matching the pages convention",
        m.progression.enemies.every(function (id) {
            return typeof id === "string";
        }));
    check("re-encountering the same faces is a 0-write no-op",
        m.encounterEnemies([29012001, 29013003]) === 0
        && m.progression.enemies.length === 2);
    check("empty/absent batch is legal",
        m.encounterEnemies([]) === 0 && m.encounterEnemies() === 0);

    // the state rides the same export/import round-trip as the rest
    const bundle = save.exportSave();
    save.setStorage(fakeStorage());
    const m2 = createMeta();
    m2.read();
    save.importSave(bundle);
    m2.read();
    check("回环: encountered enemies survive export→import→read",
        m2.progression.enemies.length === 2
        && m2.progression.enemies.indexOf("29012001") >= 0);

    // merge: dedupes and stringifies raw saves
    save.setStorage(fakeStorage());
    save.write("meta", { enemies: [29012001, "29012001", 99038006] });
    const merged = createMeta();
    merged.read();
    check("merge dedupes and stringifies the enemies slot",
        merged.progression.enemies.length === 2
        && merged.progression.enemies.indexOf("29012001") >= 0
        && merged.progression.enemies.indexOf("99038006") >= 0);
    save.setStorage(fakeStorage());
}

console.log(failures === 0 ? "\nALL GREEN" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
