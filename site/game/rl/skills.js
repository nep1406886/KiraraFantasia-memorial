// Player skill slots, cooldowns, buffs, and the とっておき gauge.
//
// HARD RULE (master plan §4.1): no three.js, no DOM.
//
// Everything here is decoded from asset/rl/skills-rl.json, which is a build-time
// copy of the original's SkillList_PL / SkillContentList_PL rows. The action-game
// translation is spec/04 §4: cooldown = m_Recasts[0] × 0.35 s, one 突破 tier
// copied verbatim. Effect kinds are the original's:
//
//   0  damage        m_Args[0]/1000 = coefficient, m_Args[1] = magic flag
//   1  heal          m_Args[0] = percent of MaxHP (shipped values grade as
//                    小 27 / 中 33-44 / 大 49, which is how they were read)
//   2  buff          [turnConsume, turns, atk, mgc, def, mdef, spd, luck];
//                    stats are whole percents, except spd: an action-time ratio
//   3  stat reset    six 0/1 masks: both signs; seventh arg 0=down, 1=up only
//   4  abnormal      args = one chance% per eStateAbnormal slot
//                    (0 Confusion 1 Paralysis 2 Poison 3 Bearish 4 Sleep
//                    5 Unhappy 6 Silence 7 Isolation — the original's enum).
//                    Rogue-fold: enemy effects slow action cadence; player-side
//                    Unhappy locks combat healing, other self ailments are pending
//   5/6 cleanse / immunity: currently only player-side Unhappy is implemented
//   8  elementResist [turnConsume, turns, resist% ×6 elements 0..5];
//                    T22n had folded args[1] (the turn count!) into def/mdef
//   10 weak bonus    [turnConsume, turns, bonus%]; add to favourable coefficient
//   12 next critical [] — one explicit player damage action, including skills
//   13 barrier       [cut%, hits]
//   14 recast        immediate change to current cooldowns by base recast units
//   15 gauge         [0.33] = +33% of the とっておき gauge
//
// Unsupported effects (other ailments, conditional card payloads, ...) stay in
// slot.unhandled for the content stage rather than being guessed at here.
//
// The 1-player action translation of targets: 0/3/4 (self / one ally / all
// allies) all mean the player, 1 (single enemy) is an aimed shot, 2 (all
// enemies) is a ring around the player.

import { HEALING_LOCK_INDEX, HEALING_LOCK_TURNS, POISON_INDEX, POISON_TURNS,
    AILMENTS } from "./playerstatus.js";
import { decodeStatReset, resetStatChanges } from "./statreset.js";
import { decodeNextCritical } from "./nextcritical.js";

const AILMENT_INDEXES = AILMENTS.map(ailment => ailment.index);

// Fallbacks only: the shipped table carries both numbers and they win.
export const RECAST_SECONDS = 0.35;
export const TURN_SECONDS = 2.8;
// spec/04 §8: the gauge fills from damage dealt and taken alike.
export const GAUGE_MULT = 1.4;

const SELF_TARGETS = [0, 3, 4];
// T30: action speed recovers ordinary skill cooldowns, never movement/attacks.
export const PLAYER_RECOVERY_RATE = Object.freeze({ min: 0.5, max: 2 });

function recoveryRateAt(buffs, elapsed = 0) {
    let rate = 1;
    for (const buff of buffs) {
        if (buff.remaining > elapsed && Number.isFinite(buff.spd)) rate += buff.spd;
    }
    return Math.min(PLAYER_RECOVERY_RATE.max, Math.max(PLAYER_RECOVERY_RATE.min, rate));
}

// Integrate work over seconds, or invert that same integral for the HUD.
// Expiry boundaries are strictly increasing; no allocation/sort on this path.
function convertCooldown(buffs, amount, toSeconds) {
    if (!(amount > 0) || !Number.isFinite(amount)) return 0;
    let elapsed = 0, recovered = 0;
    while (true) {
        const rate = recoveryRateAt(buffs, elapsed);
        let expiry = Infinity;
        for (const buff of buffs) {
            if (buff.spd && Number.isFinite(buff.spd) && buff.remaining > elapsed) {
                expiry = Math.min(expiry, buff.remaining);
            }
        }
        const span = expiry - elapsed;
        if (toSeconds) {
            if (amount <= span * rate) return elapsed + amount / rate;
            amount -= span * rate;
        } else {
            if (amount <= span) return recovered + amount * rate;
            amount -= span;
            recovered += span * rate;
        }
        elapsed = expiry;
    }
}

function deliveryFor(target) {
    if (SELF_TARGETS.indexOf(target) >= 0) {
        return "self";
    }
    return target === 2 ? "ring" : "aimed";
}

// Reads one shipped row into the shape the game loop wants.
// Exported for the UI (T22i 人物卡): the roster shows skills decoded with
// the exact same rule the run uses, never a re-derived copy.
export function decodeSkill(row, id, recastSeconds, skillCards = {}) {
    const out = {
        id: id,
        sceneId: row.sceneId || null,
        action: row.action || null,
        effects: row.effects || [],
        name: row.nameZh || row.name,
        detail: row.detailZh || row.detail,
        nameJa: row.name,
        detailJa: row.detail,
        // Authored SkillList m_SkillType (3-7); the UI maps it to the
        // original's CMD_Skill* icon family (T22j).
        skillType: row.type,
        target: row.target,
        delivery: deliveryFor(row.target),
        coef: row.coef || 0,
        magic: !!row.magic,
        cooldown: row.cooldown && row.cooldown.length
            ? row.cooldown[0]
            : (row.recasts ? row.recasts[0] * recastSeconds : 0),
        recastUnits: Number.isSafeInteger(row.recasts?.[0]) && row.recasts[0] >= 0 ? row.recasts[0] : null,
        remaining: 0,
        damage: false,
        heal: 0,
        buff: null,
        buffs: [],
        statResets: [],
        statEffects: [],
        barrier: null,
        recastMod: 0,
        recastChanges: [],
        gauge: 0,
        // T22n per-character design: the decompiled eSkillContentType
        // switch (BattleCommandParser.cs) mapped into rogue-legible fields.
        nextAtk: 0,
        nextCriticals: [],
        regen: null,
        slow: null,
        resists: null,
        weakBonuses: [],
        statusEffects: [],
        cardPlacements: [],
        unhandled: []
    };
    (row.effects || []).forEach(function (effect, index) {
        const args = effect.args || [];
        if (effect.kind === 0) {
            out.damage = true;
        } else if (effect.kind === 1) {
            out.heal = Math.max(out.heal, (args[0] || 0) / 100);
        } else if (effect.kind === 2) {
            // StatusChange: whole percents in the shipped rows; /100 is the
            // fraction the stat multiplier consumes (T25 — the T22n pass
            // forwarded raw percents as fractions, so a +15% buff ran ×16).
            const buff = {
                target: effect.target,
                turns: args[1] || 0,
                atk: (args[2] || 0) / 100, mgc: (args[3] || 0) / 100,
                def: (args[4] || 0) / 100, mdef: (args[5] || 0) / 100,
                // BattleCommandParser excludes Spd from the percent conversion.
                spd: args[6] > 0 ? 1 / args[6] - 1 : 0,
                luck: (args[7] || 0) / 100
            };
            out.buffs.push(buff);
            out.statEffects.push(Object.freeze({ buff, index: out.buffs.length - 1 }));
            // Preserve the public ally-buff summary for existing consumers.
            // Runtime uses the individual entries so target/expiry never merge.
            if (SELF_TARGETS.indexOf(effect.target) >= 0) {
                if (!out.buff) {
                    out.buff = { turns: 0, atk: 0, mgc: 0, def: 0, mdef: 0, spd: 0, luck: 0 };
                }
                out.buff.turns = Math.max(out.buff.turns, buff.turns);
                ["atk", "mgc", "def", "mdef", "spd", "luck"].forEach(function (key) {
                    out.buff[key] += buff[key];
                });
            }
        } else if (effect.kind === 3) {
            const reset = decodeStatReset(effect);
            if (reset) {
                out.statResets.push(reset);
                out.statEffects.push(Object.freeze({ reset }));
            } else if (!out.unhandled.includes(3)) {
                out.unhandled.push(3);
            }
        } else if (effect.kind === 5) {
            // AbnormalRecover: one eStateAbnormal reset per non-zero m_Args
            // slot (BattleCommandParser.SolveSkillContent_AbnormalRecover).
            // Read against the game's registered ailments: a mask that flags
            // a registered slot is executable; a mask that only flags slots
            // this game does not run clears nothing and stays a disclosed gap.
            const mask = Array.isArray(args)
                ? args.map((v, i) => (Number.isFinite(v) && v !== 0 ? i : -1)).filter(i => i >= 0) : [];
            const supported = SELF_TARGETS.includes(effect.target)
                && mask.some(i => AILMENT_INDEXES.includes(i));
            if (supported) out.statusEffects.push({ kind: 5, target: effect.target, mask });
            if (!supported && !out.unhandled.includes(5)) out.unhandled.push(5);
        } else if (effect.kind === 6) {
            // AbnormalDisable: [turnConsume, turns] grants ONE buff that
            // protects against every abnormal state for its duration
            // (BattleCommandParser.SolveSkillContent_AbnormalDisable →
            // CharacterBattleParam.SetStateAbnormalDisableBuff). No trait
            // list is carried, so this is fully executable per row.
            if (SELF_TARGETS.includes(effect.target)
                    && Number.isSafeInteger(args[1]) && args[1] > 0) {
                out.statusEffects.push({ kind: 6, target: effect.target, turns: args[1] });
            } else if (!out.unhandled.includes(6)) {
                out.unhandled.push(6);
            }
        } else if (effect.kind === 10) {
            // Original WeakElementBonus adds abs(percent/100) to the element
            // coefficient, not to the final damage. Preserve each target/timer.
            if (SELF_TARGETS.includes(effect.target) && Number.isFinite(args[1])
                    && args[1] > 0 && Number.isFinite(args[2]) && args[2] !== 0) {
                out.weakBonuses.push({ target: effect.target, turns: args[1], pct: Math.abs(args[2]) / 100 });
            } else if (!out.unhandled.includes(effect.kind)) {
                out.unhandled.push(effect.kind); 
            }
        } else if (effect.kind === 21) {
            const child = skillCards && skillCards[args[1]];
            const card = Number.isSafeInteger(args[1]) && args[1] > 0
                && child && child.id === args[1] ? decodeSkillCard(child, recastSeconds) : null;
            if ([0, 1, 2, 3, 4].includes(effect.target)
                    && Number.isSafeInteger(args[0]) && args[0] > 0 && card) {
                out.cardPlacements.push({ target: effect.target, count: args[0], card });
            } else if (!out.unhandled.includes(21)) {
                out.unhandled.push(21);
            }
        } else if (effect.kind === 13) {
            out.barrier = { cut: (args[0] || 0) / 100, hits: args[1] || 0 };
        } else if (effect.kind === 14) {
            if (SELF_TARGETS.includes(effect.target) && Array.isArray(args) && args.length === 1
                    && Number.isFinite(args[0])) {
                if (args[0] !== 0) {
                    out.recastChanges.push(Object.freeze({ target: effect.target, ratio: args[0] }));
                    out.recastMod += args[0]; // decoded summary only; never persistent state
                }
            } else if (!out.unhandled.includes(14)) out.unhandled.push(14);
        } else if (effect.kind === 15) {
            out.gauge = args[0] || 0;
        } else if (effect.kind === 8) {
            // ElementResist: args[0]=turn consumption mode,
            // args[1]=turns, args[2..7] = resist % for elements 0..5
            // (in elements.js order: 火 水 土 风 月 阳).
            // Decoded per-element so the run can debit the *right* element,
            // not a phantom def/mdef buff (T25 audit).
            const resists = {};
            for (let e = 0; e < 6; e++) {
                const v = (args[2 + e] || 0) / 100;
                if (v !== 0) { resists[e] = v; }
            }
            if (Object.keys(resists).length) {
                out.resists = { turns: args[1] || 0, by: resists, target: effect.target };
            }
        } else if (effect.kind === 11) {
            // NextAttackUp: args[0]=target side, args[1]=% — a one-shot
            // damage amplifier on the next swing.
            out.nextAtk = (args[1] || 0) / 100;
        } else if (effect.kind === 12) {
            const grant = decodeNextCritical(effect);
            if (grant) out.nextCriticals.push(Object.freeze({ ...grant, index }));
            else if (!out.unhandled.includes(12)) out.unhandled.push(12);
        } else if (effect.kind === 23) {
            // BattleCommandParser: [turns, recovery power]. This game's heal
            // adaptation reads power as MaxHP%, once per table-defined turn.
            out.regen = { pct: (args[1] || 0) / 100, turns: args[0] || 1 };
        } else if (effect.kind === 4) {
            // Abnormal: args are one chance% PER eStateAbnormal slot
            // (0 Confusion 1 Paralysis 2 Poison 3 Bearish 4 Sleep 5 Unhappy
            // 6 Silence 7 Isolation — the original's own enum). Enemy
            // targets keep the rogue fold (the strongest listed chance
            // becomes the slow a damaging cast leaves on what it hits).
            // Self targets now decode against the REGISTERED ailment table:
            // every registered slot with a positive chance becomes its own
            // status effect; slots this game does not run stay disclosed.
            let best = 0;
            for (let a = 0; a < args.length; a++) {
                if (args[a] > best) { best = args[a]; }
            }
            if (effect.target === 1 || effect.target === 2) {
                out.slow = { pct: best / 100, turns: 2, target: effect.target };
            } else {
                const self = SELF_TARGETS.includes(effect.target) && Array.isArray(args);
                if (!self && !out.unhandled.includes(4)) { out.unhandled.push(4); }
                let applied = false;
                AILMENTS.forEach(function (ailment) {
                    const raw = args[ailment.index];
                    if (!self || !Number.isFinite(raw) || raw <= 0) { return; }
                    applied = true;
                    out.statusEffects.push({ kind: 4, target: effect.target,
                        ailment: ailment.key, index: ailment.index,
                        chance: Math.min(1, raw / 100) });
                });
                // Isolation (slot 7) only blocks friend-join and member
                // change in the original (BattleSystem
                // OnJudgeInterruptFriendJoinSelect / SetupForOpenMemberChange),
                // and this game has neither, so it is structurally
                // inapplicable rather than a gap still to fill. The other
                // unregistered slots (confusion/paralysis/sleep/silence) stay
                // disclosed until their semantics are wired.
                // Isolation (slot 7) only blocks friend-join and member change
                // in the original, and this game has neither, so a numeric
                // chance there is structurally inapplicable rather than a gap.
                // Anything else that names a slot this game does not run, or a
                // non-numeric chance on a slot it does run, stays disclosed.
                const STRUCTURAL = [7];
                const gap = args.some((v, i) => {
                    if (i >= 8 || v === 0) { return false; }
                    if (STRUCTURAL.includes(i)) { return false; }
                    if (!Number.isFinite(v)) { return true; }
                    return !AILMENT_INDEXES.includes(i);
                });
                if (gap && !out.unhandled.includes(4)) { out.unhandled.push(4); }
            }
        } else if (out.unhandled.indexOf(effect.kind) < 0) {
            out.unhandled.push(effect.kind);
        }
    });
    out.usable = out.damage || out.heal > 0 || !!out.regen || out.nextAtk > 0 || out.nextCriticals.length > 0
        || !!out.barrier || out.recastChanges.length > 0 || !!out.gauge || !!out.resists || !!out.slow || out.weakBonuses.length > 0
        || out.statusEffects.length > 0 || out.cardPlacements.length > 0 || out.statResets.length > 0
        || out.buffs.some(function (b) {
            return b.atk || b.mgc || b.def || b.mdef || b.luck || b.spd;
        });
    return out;
}

// Only leaf payloads whose complete semantics are understood are accepted.
// A missing/recursive/conditional card is not an executable empty timer.
export function decodeSkillCard(row, recastSeconds = RECAST_SECONDS) {
    if (!row || row.source !== "CARD" || !Number.isSafeInteger(row.id) || row.id <= 0
            || !Array.isArray(row.effects) || !row.effects.length
            || !Number.isFinite(row.loadFactors?.[0]) || row.loadFactors[0] <= 0) return null;
    const valid = row.effects.every(effect => {
        const args = effect?.args;
        if (!Array.isArray(args) || !args.length || !args.every(Number.isFinite)) return false;
        if (effect.kind === 0) {
            return [1, 2].includes(effect.target) && args.length >= 8 && args[0] > 0
                && [0, 1].includes(args[1]) && args.slice(2).every(value => value === 0);
        }
        if (!SELF_TARGETS.includes(effect.target)) return false;
        if (effect.kind === 1) return args.length === 1 && args[0] > 0;
        if (effect.kind === 13) return args.length === 2 && args[0] > 0 && args[0] <= 100
            && Number.isSafeInteger(args[1]) && args[1] > 0;
        return false;
    });
    if (!valid) return null;
    // Only freshly compiled, acyclic leaf data enters this snapshot. Never
    // freeze caller-owned source rows or leave a mutable barrier/args alias.
    function freezePayload(value) {
        for (const child of Object.values(value)) {
            if (child && typeof child === "object") freezePayload(child);
        }
        return Object.freeze(value);
    }
    const effects = row.effects.map(effect => {
        const copy = { kind: effect.kind, target: effect.target, args: effect.args.slice() };
        return freezePayload(decodeSkill({ effects: [copy], target: effect.target,
            coef: effect.kind === 0 ? effect.args[0] / 1000 : 0,
            magic: effect.kind === 0 && effect.args[1] === 1 }, row.id, recastSeconds));
    });
    const name = effects.every(effect => effect.heal > 0) ? "治疗卡"
        : effects.every(effect => effect.damage) ? "攻击卡"
        : effects.every(effect => effect.barrier) ? "防护卡" : "技能卡";
    return Object.freeze({ id: row.id, name, nameJa: row.name, loadFactor: row.loadFactors[0],
        effects: Object.freeze(effects) });
}

// createSkills({ table, card, maxHp })
//   table  parsed asset/rl/skills-rl.json
//   card   a cards-rl.json row (needs .class and .skillIds)
//   maxHp  the unit's max HP, for the gauge ceiling and heal percentages
export function createSkills(options) {
    const cfg = options || {};
    const table = cfg.table || {};
    const card = cfg.card || {};
    const recastSeconds = table.recastSeconds || RECAST_SECONDS;
    const turnSeconds = table.turnSeconds || TURN_SECONDS;
    const rows = table.player || {};

    const normalRow = (table.normalAttacks || {})[card.class] || null;
    const normal = normalRow
        ? decodeSkill(normalRow, normalRow.id, recastSeconds, table.skillCards)
        : { id: 0, name: "通常攻撃", coef: 0.5, magic: false, damage: true,
            target: 1, delivery: "aimed", cooldown: 0, remaining: 0,
            heal: 0, buff: null, barrier: null, recastMod: 0, gauge: 0,
            nextAtk: 0, nextCriticals: [], regen: null, slow: null, resists: null, unhandled: [] };

    const ids = [];
    if (card.skillIds) {
        if (card.skillIds.chara) { ids.push(card.skillIds.chara); }
        (card.skillIds.class || []).forEach(function (id) { ids.push(id); });
    }
    const slots = ids.slice(0, 3).map(function (id) {
        const row = rows[id] || rows[String(id)];
        return decodeSkill(row || { nameZh: "技能资料缺失", effects: [] }, id, recastSeconds, table.skillCards);
    });
    const ultimate = card.skillIds && card.skillIds.chara ? slots[0] : null;
    if (ultimate) { ultimate.ultimate = true; }

    const gaugeMax = Math.max(1, Math.round((cfg.maxHp || 1) * GAUGE_MULT));
    // Active buffs, each { turns, remaining, atk, mgc, ... }; statMult() sums
    // them, so two +20% atk buffs give +40%, matching the original's stacking.
    const buffs = [];
    let barrier = null;
    let gauge = 0;
    let sealedSlots = new Set();

    // Weapon passives (spec/04 §4.2): type 8 swaps in the evolved weapon's
    // own 通常攻撃 / class-skill rows. The base rows stay alive untouched so
    // an unequip restores them; `slots` is closure-captured by use/update,
    // so overrides mutate the array in place.
    const baseSlots = slots.slice();
    const weaponChildren = table.weaponChildren || {};
    let normalSource = null;
    let slotSources = slots.map(() => null);
    let replacements = [];

    const api = {
        normal: normal,
        slots: slots,
        ultimate: ultimate,
        turnSeconds: turnSeconds,
        get gauge() { return gauge; },
        gaugeMax: gaugeMax,
        get ultimateReady() { return !!(ultimate && ultimate.usable && gauge >= gaugeMax); },
        get barrier() { return barrier; },
        get buffs() { return buffs; },
        get weakElementBonus() {
            let total = 0;
            for (const buff of buffs) {
                if (buff.remaining > 0) total += buff.weakElementBonus || 0;
            }
            return total;
        },
        get cooldownRate() { return recoveryRateAt(buffs); },
        cooldownSeconds: function (index) {
            const slot = slots[index];
            return slot && !slot.ultimate ? convertCooldown(buffs, slot.remaining, true) : 0;
        },

        sourceFor: function (index) { return slotSources[index] || null; },

        // Isolated read model for comparisons/current equipment. No mutable
        // effect arrays, timers or catalog rows escape into a preview.
        describeLoadout: function () {
            return structuredClone({ turnSeconds, normal: api.normal, baseNormal: normal, slots, baseSlots,
                normalSource, slotSources, replacements, sealedSlots: [...sealedSlots],
                cooldownSeconds: slots.map((_, index) => api.cooldownSeconds(index)) });
        },

        applyGadgets: function (runtime) {
            sealedSlots = new Set(runtime?.sealedSlots || []);
        },

        isSealed: function (index) {
            return sealedSlots.has(index) && !!slots[index] && !slots[index].ultimate;
        },

        ready: function (index) {
            const slot = slots[index];
            return !!slot && !slot.ultimate && !api.isSealed(index) && slot.usable && slot.remaining <= 0;
        },

        // Starts the cooldown and returns the slot, or null when not ready.
        use: function (index, onStatReset) {
            const slot = slots[index];
            if (!api.ready(index)) {
                return null;
            }
            slot.remaining = slot.cooldown;
            // The original resets the executing command to full at turn end.
            // Preserve admission-time cooldown here, excluding this cast itself.
            api.applySelf(slot, onStatReset, index);
            return slot;
        },

        // Shared by ordinary casts and ordered ultimate sub-effects.
        applySelf: function (slot, onStatReset, recastExcluded = -1) {
            const ownBuffs = slot.buffs && slot.buffs.length
                ? slot.buffs.filter(function (b) { return SELF_TARGETS.indexOf(b.target) >= 0; })
                : (slot.buff ? [slot.buff] : []);
            const operations = slot.statEffects && slot.statEffects.length
                ? slot.statEffects.filter(effect => SELF_TARGETS.includes((effect.reset || effect.buff).target))
                : ownBuffs.map(buff => ({ buff }));
            operations.forEach(function (effect) {
                if (effect.reset) {
                    const changed = api.resetStats(effect.reset);
                    if (onStatReset) onStatReset(effect.reset, changed);
                    return;
                }
                const buff = effect.buff;
                buffs.push({
                    turns: buff.turns,
                    remaining: buff.turns * turnSeconds,
                    atk: buff.atk, mgc: buff.mgc,
                    def: buff.def, mdef: buff.mdef,
                    spd: buff.spd, luck: buff.luck
                });
            });
            (slot.weakBonuses || []).forEach(function (bonus) {
                if (SELF_TARGETS.includes(bonus.target)) {
                    buffs.push({ turns: bonus.turns, remaining: bonus.turns * turnSeconds,
                        weakElementBonus: bonus.pct });
                }
            });
            if (slot.barrier && slot.barrier.hits > 0) {
                barrier = { cut: slot.barrier.cut, hits: slot.barrier.hits };
            }
            api.applyRecast(slot, recastExcluded);
            if (slot.resists && SELF_TARGETS.indexOf(slot.resists.target) >= 0) {
                // Resist entries share the buff timer but use the same
                // refresh rule as enemy resists: strongest value per sign,
                // longest remaining duration, opposite signs stay separate.
                Object.keys(slot.resists.by).forEach(function (e) {
                    const element = +e;
                    const pct = slot.resists.by[e];
                    const remaining = slot.resists.turns * turnSeconds;
                    const entry = buffs.find(function (b) {
                        return b.resistElement === element
                            && Math.sign(b.resistPct) === Math.sign(pct);
                    });
                    if (entry) {
                        entry.resistPct = Math.abs(pct) > Math.abs(entry.resistPct) ? pct : entry.resistPct;
                        entry.remaining = Math.max(entry.remaining, remaining);
                        entry.turns = Math.max(entry.turns, slot.resists.turns);
                    } else {
                        buffs.push({
                            turns: slot.resists.turns, remaining: remaining,
                            resistElement: element, resistPct: pct
                        });
                    }
                });
            }
            if (slot.gauge) {
                api.addGauge(gaugeMax * slot.gauge);
            }
            return slot;
        },

        // CharacterBattle.RecastChange / BattleCommandData.CalcRecast: an
        // immediate, ordered delta; no future-cast discount can accumulate.
        applyRecast: function (effect, excluded = -1) {
            for (const change of effect?.recastChanges || []) {
                if (!SELF_TARGETS.includes(change.target) || !Number.isFinite(change.ratio)) continue;
                for (let index = 0; index < slots.length; index++) {
                    const slot = slots[index];
                    if (index === excluded || slot.ultimate || !(slot.cooldown > 0)) continue;
                    const ratio = slot.recastUnits > 0
                        ? Math.trunc(slot.recastUnits * change.ratio) / slot.recastUnits : change.ratio;
                    slot.remaining = Math.min(slot.cooldown, Math.max(0, slot.remaining + slot.cooldown * ratio));
                }
            }
        },

        resetStats: function (reset) {
            return resetStatChanges(buffs, reset);
        },

        update: function (dt) {
            if (!Number.isFinite(dt) || dt <= 0) return;
            const recovered = convertCooldown(buffs, dt, false);
            for (let i = 0; i < slots.length; i++) {
                if (slots[i].remaining > 0) {
                    const left = slots[i].remaining - recovered;
                    slots[i].remaining = left > 1e-9 ? left : 0;
                }
            }
            for (let i = buffs.length - 1; i >= 0; i--) {
                buffs[i].remaining -= dt;
                if (buffs[i].remaining <= 0) {
                    buffs.splice(i, 1);
                }
            }
        },

        // Room/death boundary: currency and cooldowns belong to the run;
        // temporary combat effects belong to the room.
        clearEffects: function () {
            buffs.length = 0;
            barrier = null;
        },

        // Multiplier for one stat key from every active buff.
        statMult: function (key) {
            let mult = 1;
            for (let i = 0; i < buffs.length; i++) {
                mult += buffs[i][key] || 0;
            }
            return mult < 0.1 ? 0.1 : mult;
        },

        // kind 8 (T25): total element resistance from active resist buffs —
        // a positive fraction means that element's hits land softer on the
        // player. Sign stays as shipped (negative rows exist).
        resistFor: function (element) {
            let total = 0;
            for (let i = 0; i < buffs.length; i++) {
                if (buffs[i].resistElement === element) {
                    total += buffs[i].resistPct || 0;
                }
            }
            return total;
        },

        // Barrier: returns the damage that gets through and spends one charge.
        absorb: function (damage) {
            if (!barrier || barrier.hits <= 0) {
                return damage;
            }
            barrier.hits -= 1;
            const through = Math.round(damage * (1 - barrier.cut));
            if (barrier.hits <= 0) {
                barrier = null;
            }
            return through < 0 ? 0 : through;
        },

        addGauge: function (amount) {
            gauge = Math.min(gaugeMax, gauge + Math.max(0, amount || 0));
            return gauge;
        },

        spendUltimate: function () {
            if (!api.ultimateReady) {
                return false;
            }
            gauge = 0;
            return true;
        },

        // applyWeapon(runtime) — runtime is equipment.passiveRuntime().
        // normalOverride replaces the whole normal attack (the 全体攻撃
        // rows carry target 2, and the swing already hits every enemy in
        // the arc, so the row's own coef/magic is all the change there is);
        // skillOverrides retain their authored class-slot positions (after
        // the character skill); null positions do not replace anything. Restoring happens
        // by calling with empty overrides — base rows come back verbatim.
        applyWeapon: function (runtime, classId = card.class) {
            const rt = runtime || {};
            const previous = slots.slice();
            const classNormal = (table.normalAttacks || {})[classId];
            const child = rt.normalOverride
                ? weaponChildren[String(rt.normalOverride)] : null;
            api.normal = child
                ? decodeSkill(child, rt.normalOverride, recastSeconds, table.skillCards)
                : (classNormal && classId !== card.class
                    ? decodeSkill(classNormal, classNormal.id, recastSeconds, table.skillCards) : normal);
            for (let i = 0; i < slots.length; i++) {
                slots[i] = baseSlots[i];
            }
            const firstClass = card.skillIds && card.skillIds.chara ? 1 : 0;
            const overrides = rt.skillOverrides || [];
            for (let s = 0; s < overrides.length; s++) {
                const idx = firstClass + s;
                if (idx >= slots.length) { break; }
                const row = weaponChildren[String(overrides[s])];
                if (row) {
                    slots[idx] = decodeSkill(row, overrides[s], recastSeconds, table.skillCards);
                }
            }
            // Cooldown work belongs to the key slot, not the decoded row.
            // Swapping/unequipping must not grant a free cast or revive an old timer.
            for (let i = 0; i < slots.length; i++) {
                if (previous[i]?.id === slots[i].id) slots[i] = previous[i];
                else if (previous[i] && !slots[i].ultimate) slots[i].remaining = previous[i].remaining;
            }
            replacements = (rt.skillReplacements || []).map(change => {
                const row = weaponChildren[String(change.skillId)];
                const actual = change.target === 0 ? api.normal : slots[firstClass + change.target - 1];
                return { ...change, source: Object.freeze({ ...change.source }),
                    active: !!row && change.active && actual?.id === change.skillId,
                    skill: row ? decodeSkill(row, change.skillId, recastSeconds, table.skillCards) : null };
            });
            normalSource = replacements.find(change => change.active && change.target === 0)?.source
                || (classId !== card.class && classNormal ? Object.freeze({ slot: "weapon", style: true }) : null);
            slotSources = slots.map((slot, index) => slot.ultimate ? null
                : replacements.find(change => change.active && change.target === index - firstClass + 1)?.source || null);
        },

        // Every effect kind the shipped rows use that this stage does not
        // implement -- the content stage picks these up (see the file header).
        get unhandled() {
            const set = [];
            slots.forEach(function (slot) {
                slot.unhandled.forEach(function (kind) {
                    if (set.indexOf(kind) < 0) { set.push(kind); }
                });
            });
            return set;
        }
    };
    return api;
}

// Enemy side: the shipped rows already carry a danmaku pattern (build-time
// classification in tools/build_rl_data.py). 999999 is the confusion self-hit
// 「自分を攻撃した！」 that every enemy list ends with -- it targets the caster,
// so it is never an attack option.
export const CONFUSION_SKILL_ID = 999999;

// Four of the 335 shipped enemy rows are not attacks at all, they are the
// original's turn-based scripting -- lines a boss says while a battle is being
// ended for it:
//
//   12017  1.2   なるほど、君が要か
//   12034  5.6   この程度、耐えられるよね？
//   83023  10    不思議と聴き入ってしまう音楽が聞こえた気がした   (targets the caster)
//   19050  30    英国式イレイザーショット
//
// The highest coefficient on any real attack row in the whole table is 0.6
// (骨砕き 0.55, 肉で斬って骨を断つ！ 0.6), so the cap sits in an empty band
// between 0.6 and 1.2 and can only ever catch those four: at メカこけし's atk
// 1100, coef 30 would deal ~33 000 to a level-appropriate player. The rows stay
// in skills-rl.json -- the table is a copy of the original and must not lie --
// and are listed in moveset.gimmicks, where tools/rl_enemy_harness.mjs asserts
// both halves of the gap.
export const SANE_ENEMY_COEF = 1.0;

export function enemyMoveset(table, skillIds) {
    const rows = (table || {}).enemy || {};
    const attacks = [];
    const support = [];
    const gimmicks = [];
    (skillIds || []).forEach(function (id) {
        if (id === CONFUSION_SKILL_ID) {
            return;
        }
        const row = rows[id] || rows[String(id)];
        if (!row) {
            return;
        }
        if ((row.coef || 0) > SANE_ENEMY_COEF) {
            gimmicks.push({ id: id, name: row.name, coef: row.coef });
            return;
        }
        const entry = {
            id: id,
            name: row.name,
            target: row.target,
            coef: row.coef || 0,
            magic: !!row.magic,
            pattern: row.pattern || "aimed",
            // The original's skill action name (SkillList_EN m_SAP): the key
            // into the enemy attack effect map.
            action: row.sap || "",
            sap: row.sap || "",
            healingLockChance: 0,
            healingLockSeconds: 0,
            // Every registered ailment this row can land on its opponent,
            // decoded from the same per-slot chance args as the healing lock.
            statusRiders: [],
            hitStatResets: []
        };
        // Enemy target 1/2 means its opponent (the player), not the caster.
        // Support scripts and self-targeted ailments must not become shot riders.
        if (row.coef > 0 && row.pattern !== "buff") {
            let damageSeen = false;
            for (const effect of row.effects || []) {
                if (effect.kind === 0 && (effect.target === 1 || effect.target === 2)) damageSeen = true;
                // Only the current post-damage opponent effects are riders.
                // Self/ally resets and support scripts need their own scheduler.
                if (damageSeen && effect.kind === 3 && (effect.target === 1 || effect.target === 2)) {
                    const reset = decodeStatReset(effect);
                    if (reset) entry.hitStatResets.push(reset);
                }
                if (effect.kind !== 4 || !(effect.target === 1 || effect.target === 2)) { continue; }
                const args = effect.args || [];
                AILMENTS.forEach(function (ailment) {
                    const chance = args[ailment.index];
                    if (!Number.isFinite(chance) || chance <= 0) { return; }
                    const pct = Math.min(1, chance / 100);
                    const seconds = (ailment.index === HEALING_LOCK_INDEX ? HEALING_LOCK_TURNS
                        : ailment.index === POISON_INDEX ? POISON_TURNS : 0)
                        * (table.turnSeconds || TURN_SECONDS);
                    entry.statusRiders.push(Object.freeze({ key: ailment.key, chance: pct, seconds: seconds }));
                    if (ailment.index === HEALING_LOCK_INDEX) {
                        entry.healingLockChance = Math.max(entry.healingLockChance, pct);
                        entry.healingLockSeconds = seconds;
                    }
                });
            }
        }
        // Support rows (pattern "buff" or no coefficient): the original's
        // turn-based command the enemy runs as its action. Decoded into the
        // executable shapes world.applyEnemySupport dispatches. Targets are
        // from the caster's perspective: 0 self, 3 ally-lowest-HP, 4 all
        // allies; 1/2 are the row's "敌人" — the player. A kind-2 negative
        // on the player is a debuff; a kind-1 heal on the player is authored
        // as-is (a narrative boss moment), not corrected away.
        const supportEffects = [];
        for (const effect of row.effects || []) {
            const args = effect.args || [];
            if (effect.kind === 1) {
                supportEffects.push({ kind: 1, target: effect.target,
                    pct: (args[0] || 0) / 100 });
            } else if (effect.kind === 13) {
                supportEffects.push({ kind: 13, target: effect.target,
                    cut: (args[0] || 0) / 100, hits: args[1] || 0 });
            } else if (effect.kind === 2) {
                // [turnConsume, turns, atk, mgc, def, mdef, spd, luck];
                // turns 0 = the original's turn+1 single turn. spd is the
                // original action-time ratio: the fold 1/x-1 (a 1.3 row
                // means ~23% slower actions for that many turns).
                supportEffects.push({ kind: 2, target: effect.target,
                    turns: Math.max(1, args[1] || 0),
                    atk: (args[2] || 0) / 100, mgc: (args[3] || 0) / 100,
                    def: (args[4] || 0) / 100, mdef: (args[5] || 0) / 100,
                    spd: Number.isFinite(args[6]) && args[6] > 0 ? 1 / args[6] - 1 : 0,
                    luck: (args[7] || 0) / 100 });
            }
        }
        Object.freeze(entry.statusRiders);
        Object.freeze(entry.hitStatResets);
        if (row.pattern === "buff" || !row.coef) {
            // A row that also carries a turn-charge effect (kind 19) is the
            // original's charged big move; there is no charge gauge in this
            // game, so the whole row stays undispatched (see enemyai.js
            // pickSupport and spec/06). Mark it from the SOURCE row, not the
            // decoded subset.
            if ((row.effects || []).some(function (e) { return e.kind === 19; })) {
                entry.hasCharge = true;
            }
            if (supportEffects.length) {
                Object.freeze(supportEffects);
                entry.supportEffects = supportEffects;
            }
            support.push(entry);
        } else {
            attacks.push(entry);
        }
    });
    return { attacks: attacks, support: support, gimmicks: gimmicks };
}

// Body-contact damage uses the cheapest attack the enemy owns (combat.js
// CONTACT_FALLBACK_COEF covers rows with no attack at all).
export function contactCoefOf(moveset) {
    let min = 0;
    (moveset.attacks || []).forEach(function (a) {
        if (a.coef > 0 && (min === 0 || a.coef < min)) {
            min = a.coef;
        }
    });
    return min;
}
