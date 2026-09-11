// Equipment application: (character truth + native weapon stats) * affixes.
// Legacy items keep their multiplier-only meaning; catalogId identifies native stages.
//
// applyEquipment is PURE: it recomputes from the base every call, so
// equip→unequip cycles cannot accumulate residue by construction — that is
// the property rl_equip_harness hammers 1000×. The affix→multiplier table is
// injected (setAffixTable) rather than imported: the mapping from the
// passive enum (m_Type 0–14) to multiplier slots is authored data.
//
// Pure data functions — no three, no DOM, so node harnesses can drive it.

import { weaponDefinition, weaponAffixes, canEquipWeapon, weaponProficiency } from "./weaponcatalog.js";
import { weaponProfile } from "./weaponprofile.js";
import { gadgetRuntime } from './gadgets.js';

let affixTable = null;

// Highest first. Only skill-replacement conflicts use this order.
export const SKILL_OVERRIDE_PRIORITY = Object.freeze(["weapon", "amulet", "armor", "charm"]);

function replacementOrder(a, b) {
    const rank = source => {
        const index = SKILL_OVERRIDE_PRIORITY.indexOf(source.slot);
        return index < 0 ? SKILL_OVERRIDE_PRIORITY.length : index;
    };
    return rank(a.source) - rank(b.source)
        || Number(b.source.native) - Number(a.source.native)
        || b.source.affixIndex - a.source.affixIndex
        || b.source.effectIndex - a.source.effectIndex;
}

// affixTableFromPassives(passives) → table
//   Builds the setAffixTable payload from weapons-rl.json's 162 passives
//   (each { charaId, detail, effects: [{ trigger, type, args }] }).
//
//   The m_Type/m_Trigger enums were decoded data-driven (2026-09-03, all 162
//   rows cross-read against their m_SkillDetail; the decompiled
//   Assembly-CSharp on disk is 1.0.3 and predates the passive system, so
//   there is no switch to cite — closest analogues:
//   BattleLeaderSkillParser.cs:56-65 buff args ×0.01 → percent, eStatus
//   order Hp/Atk/Mgc/Def/MDef/Spd/Luck in BattleDefine.cs:376):
//
//   m_Trigger: 0 常時 / 1 被撃時 / 2 撃破時.
//   m_Type 0: self stat array, slots [Atk%, Mgc%, Def%, MDef%, Spd, crit].
//     Only trigger-0 rows are constant, so only they become 乘区:
//     slots 0-3 → mult = 1 + v/100; slot 4 is an ACTION-TIME multiplier
//     (0.92 = faster; lower = faster) → converted to a Spd mult of 1/v;
//     slot 5 is crit rate in per-mille (85 → +8.5pt; percent would make
//     "中アップ" a near-always-crit — see spec/04 §4 note).
//   m_Type 7: crit damage +v (fraction) → critDamage special.
//   Everything else (1 狙われ率, 2/3 状態/スタン無効, 4 スタンゲージ,
//   5/6 とっておき回収, 8 通常攻撃改変, 9 オーバーヒール, 10 与ダメ回復,
//   11 踏みとどまり, 12 配置回数, 13 HP依存攻撃, 14 被撃時全体デバフ) is
//   behavioral: kept verbatim as `special` for the systems that will read
//   them, applying no stat change here.
export function affixTableFromPassives(passives) {
    const table = {};
    const ids = Object.keys(passives || {});
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const entry = { special: [] };
        const effects = passives[id].effects || [];
        for (let j = 0; j < effects.length; j++) {
            const effect = effects[j];
            if (effect.trigger === 0 && effect.type === 0 && effect.args
                    && effect.args.length >= 6) {
                const a = effect.args;
                if (a[0]) { entry.mults = entry.mults || {}; entry.mults.atk = 1 + a[0] / 100; }
                if (a[1]) { entry.mults = entry.mults || {}; entry.mults.mgc = 1 + a[1] / 100; }
                if (a[2]) { entry.mults = entry.mults || {}; entry.mults.def = 1 + a[2] / 100; }
                if (a[3]) { entry.mults = entry.mults || {}; entry.mults.mdef = 1 + a[3] / 100; }
                if (a[4]) { entry.mults = entry.mults || {}; entry.mults.spd = 1 / a[4]; }
                if (a[5]) { entry.crit = (entry.crit || 0) + a[5] / 1000; }
            } else if (effect.type === 7 && effect.args && effect.args.length) {
                entry.critDamage = (entry.critDamage || 0) + effect.args[0];
                entry.special.push(effect);
            } else {
                entry.special.push(effect);
            }
        }
        table[id] = entry;
    }
    return table;
}

// setAffixTable(table)
//   table: { [affixId]: { mults?: { hp,atk,mgc,def,mdef,spd,luck },
//                         crit?: number } }
//   mults are multiplicative factors (1.1 = +10%); crit is additive
//   percentage points (0.03 = +3%暴击率). A missing table entry for a rolled
//   affix is a data bug and throws — the loot pool and this table must agree.
export function setAffixTable(table) {
    affixTable = table || null;
}

// passiveRuntime(items) → the aggregated behavioral effects of everything
//   equipped (spec/04 §4.2). Pure, recomputed from the items on every call —
//   same no-residue property as applyEquipment. Magnitude readings, each
//   cross-read against the 162 rows' m_SkillDetail and pinned by
//   rl_weapon_harness:
//
//   critDamage   type 7, sum of args[0] — added to the 1.5x crit multiplier.
//   gaugeMult    type 6 trigger 0, 1 + sum args[0] — the rows all read
//                「大アップ」 with args [1], i.e. +100%.
//   gaugeOnHit   type 5 trigger 1, sum args[0] — the rows all read
//                「攻撃を受けるたび上昇」 with args [0.15]: a fixed 15% of
//                the gauge ceiling per hit taken.
//   stunFill     type 4, 1 + sum args[0] — all rows [0.25], +25% stun fill.
//   overheal     type 9, sum args[0]/100 — heal ceiling above maxHp.
//   lifesteal    type 10, sum args[0]/100 — fraction of damage dealt healed.
//   survival     type 11, count — 踏みとどまり charges (once each per floor).
//   taunt        type 1, sum args[0]/100 — recorded; enemies only ever aim
//                at the player in this design, so it reads as a no-op.
//   hitStack     trigger 1 type 0 — {atk,mgc,def,mdef} per-hit-taken stack
//                (fractions); killStack the same on kill.
//   debuffOnHit  type 14 — strongest row's {atk,mgc} (fractions) + turns.
//   normalOverride / skillOverrides — type 8 child row ids, resolved per
//                authored position (normal, first class skill, second class
//                skill). Missing positions never shift another skill.
//   skillReplacements — all declarations and their effective source, using
//                SKILL_OVERRIDE_PRIORITY, then native/last-affix precedence.
//   healingLockImmune type 2 trigger 0 — protects against Unhappy only.
//   extraCardTriggers type 12 trigger 0 — added at placement/refresh, not retroactive.
//   noops        type 3 (players have no stun gauge here),
//                13 (HP-scaling: the curve row
//                is the passive itself, no readable payload) — counted so the
//                harness can assert the accounting is complete.
export function passiveRuntime(items) {
    const rt = {
        critDamage: 0,
        gaugeMult: 1,
        gaugeOnHit: 0,
        stunFill: 1,
        overheal: 0,
        lifesteal: 0,
        survival: 0,
        healingLockImmune: false,
        extraCardTriggers: 0,
        taunt: 0,
        hitStack: null,
        killStack: null,
        debuffOnHit: null,
        normalOverride: null,
        skillOverrides: [],
        skillReplacements: [],
        noops: []
    };
    const list = items || [];
    function read(item) {
        const affixes = weaponAffixes(item);
        const weapon = weaponDefinition(item);
        for (let j = 0; j < affixes.length; j++) {
            const special = affixOf(affixes[j]).special || [];
            for (let k = 0; k < special.length; k++) {
                const e = special[k];
                const args = e.args || [];
                if (e.type === 7) {
                    rt.critDamage += args[0] || 0;
                } else if (e.type === 6 && e.trigger === 0) {
                    rt.gaugeMult += args[0] || 0;
                } else if (e.type === 5 && e.trigger === 1) {
                    rt.gaugeOnHit += args[0] || 0;
                } else if (e.type === 4 && e.trigger === 0) {
                    rt.stunFill += args[0] || 0;
                } else if (e.type === 9) {
                    rt.overheal += (args[0] || 0) / 100;
                } else if (e.type === 10) {
                    rt.lifesteal += (args[0] || 0) / 100;
                } else if (e.type === 11) {
                    rt.survival += 1;
                } else if (e.type === 2 && e.trigger === 0) {
                    rt.healingLockImmune = true;
                } else if (e.type === 12 && e.trigger === 0
                        && Number.isSafeInteger(args[0]) && args[0] >= 0) {
                    rt.extraCardTriggers += args[0];
                } else if (e.type === 1) {
                    rt.taunt += (args[0] || 0) / 100;
                } else if (e.type === 8) {
                    for (let target = 0; target < Math.min(3, args.length); target++) {
                        if (!Number.isSafeInteger(args[target]) || args[target] <= 0) continue;
                        rt.skillReplacements.push({ target, skillId: args[target], active: false,
                            source: { slot: item.slot, affixId: String(affixes[j]), affixIndex: j,
                                effectIndex: k, native: !!weapon && String(weapon.passiveId) === String(affixes[j]) } });
                    }
                } else if (e.type === 14) {
                    const row = {
                        atk: (args[3] || 0) / 100,
                        mgc: (args[4] || 0) / 100,
                        turns: args[2] || 0
                    };
                    if (!rt.debuffOnHit
                            || Math.abs(row.atk) + Math.abs(row.mgc)
                                > Math.abs(rt.debuffOnHit.atk) + Math.abs(rt.debuffOnHit.mgc)) {
                        rt.debuffOnHit = row;
                    }
                } else if (e.type === 0 && (e.trigger === 1 || e.trigger === 2)) {
                    const stack = {
                        atk: (args[0] || 0) / 100,
                        mgc: (args[1] || 0) / 100,
                        def: (args[2] || 0) / 100,
                        mdef: (args[3] || 0) / 100
                    };
                    if (e.trigger === 1) { rt.hitStack = stack; }
                    else { rt.killStack = stack; }
                } else if (e.type === 2 || e.type === 3 || e.type === 12
                        || e.type === 13) {
                    if (rt.noops.indexOf(e.type) < 0) { rt.noops.push(e.type); }
                }
            }
        }
    }
    for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].slot !== "weapon") {
            read(list[i]);
        }
    }
    for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].slot === "weapon") {
            read(list[i]);
        }
    }
    const winners = [null, null, null];
    for (const change of rt.skillReplacements) {
        const current = winners[change.target];
        if (!current || replacementOrder(change, current) < 0) winners[change.target] = change;
    }
    for (const change of winners) {
        if (!change) continue;
        change.active = true;
        if (change.target === 0) rt.normalOverride = change.skillId;
        else {
            while (rt.skillOverrides.length < change.target) rt.skillOverrides.push(null);
            rt.skillOverrides[change.target - 1] = change.skillId;
        }
    }
    return rt;
}

function affixOf(id) {
    if (!affixTable || !Object.prototype.hasOwnProperty.call(affixTable, id)) {
        throw new Error("equipment: no table entry for affix " + id
            + " — loot pool and affix table disagree");
    }
    return affixTable[id];
}

// Combat and item details share the same composed percentage modifiers.
export function equipmentMultipliers(items, card) {
    const mults = { hp: 1, atk: 1, mgc: 1, def: 1, mdef: 1, spd: 1, luck: 1 };
    let crit = 0;
    const list = items || [];
    for (let i = 0; i < list.length; i++) {
        const affixes = weaponAffixes(list[i]);
        const proficiency = weaponProficiency(list[i], card);
        for (let j = 0; j < affixes.length; j++) {
            const affix = affixOf(affixes[j]);
            const keys = Object.keys(affix.mults || {});
            for (let k = 0; k < keys.length; k++) {
                const key = keys[k];
                if (!(key in mults)) {
                    throw new Error("equipment: unknown multiplier slot " + key);
                }
                const amount = affix.mults[key];
                mults[key] *= 1 + (amount - 1) * (amount > 1 ? proficiency : 1);
            }
            crit += (affix.crit || 0) * proficiency;
        }
    }
    const gadgets = gadgetRuntime(items);
    mults.atk *= gadgets.damage; mults.mgc *= gadgets.damage;
    mults.def *= gadgets.defense; mults.mdef *= gadgets.defense;
    return { mults: mults, crit: crit, gadgets };
}

// Native stage stats are added once before affixes; legacy items add no flat stats.
export function applyEquipment(base, items, card) {
    const { mults, crit, gadgets } = equipmentMultipliers(items, card);
    const flat = { atk: 0, mgc: 0, def: 0, mdef: 0 };
    for (const item of items || []) {
        const weapon = weaponDefinition(item);
        if (weapon) {
            const proficiency = weaponProficiency(item, card);
            for (const key of Object.keys(flat)) { flat[key] += weapon.max[key] * proficiency; }
        }
    }
    const result = {};
    const baseKeys = Object.keys(base);
    for (let i = 0; i < baseKeys.length; i++) {
        const key = baseKeys[i];
        if (key in mults) {
            result[key] = (base[key] + (flat[key] || 0)) * mults[key];
        } else {
            result[key] = base[key];
        }
    }
    // 暴击率 = luck/1200 + 词条 (spec/04 §7). Affix crit is percentage
    // points; critChance itself caps at 1.
    result.critChance = gadgets.noCrit ? 0 : Math.min(1, base.luck / 1200 + crit);
    return result;
}

// Shared by live re-equipping and read-only comparisons, including run stacks.
export function calculateLoadout(base, items, counters) {
    const stats = applyEquipment(base, items, counters && counters.card);
    const passives = passiveRuntime(items);
    const stacks = [
        [passives.hitStack, (counters && counters.stackHits) || 0],
        [passives.killStack, (counters && counters.stackKills) || 0]
    ];
    stacks.forEach(function (entry) {
        if (!entry[0] || !entry[1]) { return; }
        ["atk", "mgc", "def", "mdef"].forEach(function (key) {
            if (entry[0][key]) { stats[key] *= 1 + entry[0][key] * entry[1]; }
        });
    });
    return { stats: stats, passives: passives };
}

export function previewEquipment(base, items, candidate, counters) {
    if (!candidate || ["weapon", "amulet", "armor", "charm"].indexOf(candidate.slot) < 0
            || !Array.isArray(candidate.affixes)
            || !canEquipWeapon(candidate, counters && counters.card)) { return null; }
    try {
        const next = items.filter(function (item) { return item.slot !== candidate.slot; });
        next.push(candidate);
        const before = calculateLoadout(base, items, counters), after = calculateLoadout(base, next, counters);
        return {
            equipped: items.find(function (item) { return item.slot === candidate.slot; }) || null,
            item: candidate,
            style: { current: weaponProfile(counters && counters.card, items),
                candidate: weaponProfile(counters && counters.card, next) },
            current: before.stats, candidate: after.stats,
            passives: { current: before.passives, candidate: after.passives },
            gadgets: { current: gadgetRuntime(items), candidate: gadgetRuntime(next) }
        };
    } catch (_) {
        return null;
    }
}
