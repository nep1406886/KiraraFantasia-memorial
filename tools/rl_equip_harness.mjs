// Harness for game/rl/equipment.js (T10 acceptance, spec/06):
// 装备/卸下 1000 次后属性回到基础值（合并逻辑没有累积残留）.
//
//   node tools/rl_equip_harness.mjs
//
// Expected values are hard-coded (master plan §六) — the harness never reads
// the multiplier table it is checking through the same path.

import { applyEquipment, setAffixTable, affixTableFromPassives } from "../site/game/rl/equipment.js";
import { readFileSync } from "node:fs";

let failures = 0;
function check(label, ok, detail) {
    console.log((ok ? "ok   " : "FAIL ") + label + (detail ? "  " + detail : ""));
    if (!ok) {
        failures += 1;
    }
}
function close(a, b, eps) {
    return Math.abs(a - b) <= (eps || 1e-9);
}

// Synthetic table with hand-computed expectations. Slots mirror the real
// data's shapes: pure mults, mults+crit, crit-only.
const TABLE = {
    "1001": { mults: { atk: 1.1 } },
    "1002": { mults: { atk: 1.2, mgc: 0.9 } },
    "1003": { mults: { hp: 1.5 } },
    "1004": { crit: 0.03 },
    "1005": { mults: { spd: 1.08, luck: 1.1 }, crit: 0.02 }
};
setAffixTable(TABLE);

const BASE = { hp: 1359, atk: 651, mgc: 720, def: 836, mdef: 900, spd: 116.4, luck: 150 };

// --- 1. single affix math -----------------------------------------------------

{
    const out = applyEquipment(BASE, [{ slot: "weapon", affixes: ["1001"] }]);
    check("single atk affix = base × 1.1", close(out.atk, 651 * 1.1, 1e-9),
        out.atk.toFixed(3));
    check("other stats untouched", out.hp === BASE.hp && out.def === BASE.def
        && out.mgc === BASE.mgc && out.mdef === BASE.mdef
        && out.spd === BASE.spd && out.luck === BASE.luck);
    check("critChance = luck/1200 with no crit affix",
        close(out.critChance, 150 / 1200, 1e-12));
}

// --- 2. multiplicative stacking (乘区) -----------------------------------------

{
    const out = applyEquipment(BASE, [
        { slot: "weapon", affixes: ["1001"] },
        { slot: "amulet", affixes: ["1001"] },
        { slot: "armor", affixes: ["1002"] }
    ]);
    check("three atk affixes stack multiplicatively",
        close(out.atk, 651 * 1.1 * 1.1 * 1.2, 1e-9), out.atk.toFixed(3));
    check("mgc only from 1002", close(out.mgc, 720 * 0.9, 1e-9));
}

// --- 3. crit stacking + cap (negative case) ------------------------------------

{
    const out = applyEquipment(BASE, [
        { slot: "charm", affixes: ["1004"] },
        { slot: "amulet", affixes: ["1005"] }
    ]);
    check("crit = luck/1200 + 0.03 + 0.02",
        close(out.critChance, 150 / 1200 + 0.05, 1e-12));

    // 30 × 0.03 = 0.9 on top of the 0.125 luck base — over the cap.
    const many = [];
    for (let i = 0; i < 30; i++) { many.push({ slot: "s" + i, affixes: ["1004"] }); }
    const capped = applyEquipment(BASE, many);
    check("critChance caps at 1", capped.critChance === 1);
    check("cap actually engages at this luck (vacuity guard)",
        150 / 1200 + 30 * 0.03 > 1);
}

// --- 4. the 1000× equip/unequip cycle ------------------------------------------

{
    // Simulate a player swapping gear 1000 times: every step recomputes from
    // BASE through applyEquipment (the game's only merge path), the equipped
    // set grows and shrinks, and after every full strip the stats must be
    // byte-identical to base + its critChance. Any accumulation inside the
    // module would show up as drift here.
    let equipped = [];
    let strippedOk = 0;
    let drift = null;
    const rngState = { v: 12345 };
    function rng() {
        // xorshift for reproducibility
        let x = rngState.v;
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        rngState.v = x;
        return x / 4294967296;
    }
    const IDS = Object.keys(TABLE);
    for (let i = 0; i < 1000; i++) {
        if (equipped.length && rng() < 0.5) {
            equipped.splice(Math.floor(rng() * equipped.length), 1);
        } else {
            equipped.push({
                slot: "s" + i,
                affixes: [IDS[Math.floor(rng() * IDS.length)]]
            });
        }
        const out = applyEquipment(BASE, equipped);
        if (out.hp < BASE.hp || out.atk < BASE.atk) {
            drift = "step " + i + " dipped below base";
            break;
        }
        if (i % 7 === 0) {
            const stripped = applyEquipment(BASE, []);
            const want = { hp: 1359, atk: 651, mgc: 720, def: 836,
                mdef: 900, spd: 116.4, luck: 150, critChance: 0.125 };
            const keys = Object.keys(want);
            for (let k = 0; k < keys.length; k++) {
                if (stripped[keys[k]] !== want[keys[k]]) {
                    drift = "step " + i + ": " + keys[k] + " "
                        + stripped[keys[k]] + " ≠ " + want[keys[k]];
                    break;
                }
            }
            if (!drift) { strippedOk += 1; }
        }
    }
    check("1000 swap steps, 143 strips, all byte-identical to base",
        drift === null && strippedOk === 143, drift || strippedOk + " strips");
    check("vacuity guard: equipped items DO change stats",
        applyEquipment(BASE, equipped).atk !== BASE.atk || equipped.length === 0);
}

// --- 5. negative cases ----------------------------------------------------------

{
    let threw = null;
    try {
        applyEquipment(BASE, [{ slot: "weapon", affixes: ["9999"] }]);
    } catch (err) {
        threw = err.message;
    }
    check("unknown affix id throws (loot/table disagreement is loud)",
        threw !== null && threw.indexOf("9999") >= 0, threw);

    let threw2 = null;
    try {
        setAffixTable({ "bad": { mults: { speed: 2 } } });
        applyEquipment(BASE, [{ slot: "weapon", affixes: ["bad"] }]);
    } catch (err) {
        threw2 = err.message;
    }
    check("unknown multiplier slot throws", threw2 !== null
        && threw2.indexOf("speed") >= 0, threw2);
    setAffixTable(TABLE);
}

// --- 6. pool/table coverage (the real-data invariant, synthetic here) -----------

{
    // Once the real 162-passive table lands, this shape of check runs over
    // the actual ids via the loot harness; here it guards the synthetic set.
    const ids = Object.keys(TABLE);
    const out = applyEquipment(BASE, ids.map(function (id) {
        return { slot: "s", affixes: [id] };
    }));
    const want = {
        hp: 1359 * 1.5,
        atk: 651 * 1.1 * 1.2,
        mgc: 720 * 0.9,
        def: 836,
        mdef: 900,
        spd: 116.4 * 1.08,
        luck: 150 * 1.1,
        critChance: Math.min(1, 150 / 1200 + 0.03 + 0.02)
    };
    let ok = true;
    Object.keys(want).forEach(function (key) {
        if (!close(out[key], want[key], 1e-9)) { ok = false; }
    });
    check("full-table product matches hand-computed values", ok,
        JSON.stringify(out));
}

// --- 7. the real 162-passive table (weapons-rl.json) ----------------------------

{
    const weapons = JSON.parse(readFileSync(new URL("../site/asset/rl/weapons-rl.json",
        import.meta.url), "utf8"));
    const table = affixTableFromPassives(weapons.passives);
    const ids = Object.keys(weapons.passives);
    check("table covers all 162 passives", ids.length === 162
        && Object.keys(table).length === 162);

    // Every loot-rollable affix id (passives keys == weapons[].id) has an
    // entry — applyEquipment throws on the rest, so this is the pool check.
    check("every weapons[].id is a table key",
        weapons.weapons.every(function (w) {
            return Object.prototype.hasOwnProperty.call(table, String(w.id));
        }));

    // Hand-computed spot checks, expectations read off the JP detail text
    // and hard-coded (the decoder is the thing under test — its output may
    // not feed the expectation):
    //   12012011: [50,0,0,0,0,0] → 物理攻撃1.5倍, plus type-11 踏みとどまり
    //   15052001: [0,100,0,0,0,0] → 魔法攻撃2倍
    //   10002011: [0,0,0,0,0,85] → クリティカル率中アップ (per-mille → +8.5pt)
    //   10002001: type 3+9 only → スタン無効+オーバーヒール, no stat change
    //   15002001: trigger-2 [0,5,…] → 撃破時 stacking, special not 乗区
    const t1 = table["12012011"];
    check("12012011 → atk ×1.5", t1.mults && t1.mults.atk === 1.5
        && Object.keys(t1.mults).length === 1, JSON.stringify(t1.mults));
    check("12012011 keeps 踏みとどまり as special",
        t1.special.some(function (e) { return e.type === 11; }));
    const t2 = table["15052001"];
    check("15052001 → mgc ×2", t2.mults && t2.mults.mgc === 2
        && Object.keys(t2.mults).length === 1);
    const t3 = table["10002011"];
    check("10002011 → crit +8.5pt, no mults", t3.crit === 0.085 && !t3.mults,
        JSON.stringify(t3));
    const t4 = table["10002001"];
    check("10002001 → pure behavioral (no mults/crit)",
        !t4.mults && !t4.crit && t4.special.length === 2);
    const t5 = table["15002001"];
    check("15002001 → on-kill mgc stays special (conditional ≠ 乗区)",
        !t5.mults && t5.special.some(function (e) {
            return e.trigger === 2 && e.type === 0;
        }));

    // End-to-end: a legendary dropping with 12012011 + 10002011 affixes.
    setAffixTable(table);
    const equipped = applyEquipment(BASE, [
        { slot: "weapon", affixes: ["12012011", "10002011"] }
    ]);
    check("legendary in play: atk ×1.5, crit = luck/1200 + 0.085",
        close(equipped.atk, 651 * 1.5, 1e-9)
            && close(equipped.critChance, 150 / 1200 + 0.085, 1e-12),
        "atk=" + equipped.atk.toFixed(1) + " crit=" + equipped.critChance.toFixed(4));
    setAffixTable(TABLE);
}

console.log(failures === 0 ? "\nALL GREEN" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
