// Damage resolution, melee geometry, and the one tuning constant.
//
// HARD RULE (master plan §4.1): no three.js, no DOM -- node harnesses drive
// this directly. The element ring comes from ./elements.js, which carries the
// decompiled original's table (BattleCommandParser) copied out of core/cards.js
// -- spec/04 §3 says copy it, do not reinvent it. elements.js explains why it is
// a copy rather than an import, and rl_element_harness.mjs gates the two against
// each other pair by pair.
//
// The formula is spec/04 §7, verbatim, including the operator order -- crit and
// element multiply the raw hit, and the defence term is subtracted *after*:
//
//   damage = round( atkOrMgc × skillCoef × elementMultiplier(a,d) × TEMPO
//                   × crit(1.5, chance = luck/1200 + affixes)
//                   − defOrMdef × 0.6 )        floor 1
//
// Rounding is plain half-up here, unlike asset/rl/stats.js: stats.js has to
// reproduce Unity's banker's rounding because it is rebuilding the original's
// numbers, while this formula is ours.

import { elementMultiplier, elementHit } from "./elements.js";
import { PLAYER_TIMING, ENEMY_TIMING } from "./actorstate.js";
import { segmentDistanceSquared } from "./geometry.js";
import { applyHealingLock, applyPoison, applyBearish, bearished } from "./playerstatus.js";

// spec/04 §6: the only self-set balance constant in the game. Player damage
// only -- the enemy side resolves at tempo 1. Everything else that needs
// balancing goes through the affix pool, the loot table, or the enemy
// composition. Measured by tools/rl_balance_harness.mjs.
export const TEMPO = 4.15;

// Crit multiplier and the defence factor from the same formula.
export const CRIT_MULT = 1.5;
export const DEF_FACTOR = 0.6;
// luck/LUCK_DIVISOR is the base crit chance (spec/04 §7).
export const LUCK_DIVISOR = 1200;

// Body-contact damage uses the enemy's cheapest damage skill coefficient
// (world.js computes it at spawn); enemies with no damage row at all fall back
// to this, which is たいあたり's shipped coefficient -- still a value out of the
// table, not a new hidden constant.
export const CONTACT_FALLBACK_COEF = 0.2;

// Knockback is a fixed impulse scaled by mass (spec/04 §7); crit and element
// never touch it, so the hit always *feels* the same.
export const KNOCKBACK = { impulse: 3.4, decay: 9.0, bossScale: 0.1 };

// A stunned target takes this much more damage (spec/04 §11, スタンゲージ --
// the original's passive m_Type 4 builds a stun gauge on enemies; m_Type 7's
// crit-damage reading confirms bonus multipliers are a thing the engine does).
// It is applied here rather than in world.js because tryHit is the single
// funnel every hit passes through, and world.js already imports this file.
export const STUN_DAMAGE_MULT = 1.5;

export function critChanceFor(luck, bonus, hit) {
    // Ordinary probability never crits on いまいち; explicit forced criticals
    // bypass this chance in rollCrit. The original also scales chance up on
    // ばつぐん by an amount the decompile does not pin down, so that part is
    // deliberately left at 1x rather than guessed.
    if (hit === -1) {
        return 0;
    }
    const chance = (luck || 0) / LUCK_DIVISOR + (bonus || 0);
    return chance < 0 ? 0 : (chance > 1 ? 1 : chance);
}

export function rollCrit(chance, rng, forceCritical = false, noCrit = false) {
    if (noCrit === true) return false;
    // Original kind 12 wins even on resisted elements, without a random roll.
    if (forceCritical === true) return true;
    if (chance <= 0) {
        return false;
    }
    const roll = rng ? rng() : Math.random();
    return roll < chance;
}

// kind-8 element resistance (T25): reads both carrier shapes — the player's
// skills.buffs entries ({ resistElement, resistPct }) and the enemy-side
// timed list (unit.resists = [{ element, pct, remaining }]) — and sums the
// strength for `element`. Positive resists damp incoming damage; negative
// rows (shipped) amplify it. Clamped to a ±80% working band.
export function sumResists(unit, element) {
    let total = 0;
    if (unit.skills && typeof unit.skills.resistFor === "function") {
        total += unit.skills.resistFor(element);
    }
    const list = unit.resists;
    if (list) {
        for (let i = 0; i < list.length; i++) {
            if (list[i].element === element) {
                total += list[i].pct;
            }
        }
    }
    if (total > 0.8) { return 0.8; }
    if (total < -0.8) { return -0.8; }
    return total;
}

// resolveDamage({ atk, mgc, def, mdef, element, skill, crit, tempo }) -> int >= 1
//
//   skill    a skill row ({ coef, magic }) or a bare coefficient number.
//   element  attacker's element, with the defender's in `targetElement`; or a
//            { attacker, defender } pair. Missing either side means no ring
//            (multiplier 1) -- that is what keeps the stage-1 assertions
//            (atk 1 vs def 99 -> 1, atk 5 vs def 0 -> 5) true.
//   crit     boolean (CRIT_MULT) or an explicit multiplier for affixes.
//   tempo    defaults to 1; the player side passes TEMPO.
export function resolveDamage(attack) {
    const a = attack || {};
    const skill = a.skill;
    const coef = typeof skill === "number" ? skill
        : (skill && skill.coef !== undefined ? skill.coef
            : (a.coef !== undefined ? a.coef : 1));
    const magic = skill && typeof skill === "object" && skill.magic !== undefined
        ? !!skill.magic
        : !!a.magic;

    const power = magic
        ? (a.mgc !== undefined ? a.mgc : (a.atk || 0))
        : (a.atk !== undefined ? a.atk : (a.mgc || 0));
    const defence = magic
        ? (a.mdef !== undefined ? a.mdef : (a.def || 0))
        : (a.def !== undefined ? a.def : (a.mdef || 0));

    let attackerElement = a.element;
    let defenderElement = a.targetElement;
    const defenderResist = a.defenderResist || 0;
    if (attackerElement !== null && typeof attackerElement === "object") {
        defenderElement = attackerElement.defender !== undefined
            ? attackerElement.defender : attackerElement.d;
        attackerElement = attackerElement.attacker !== undefined
            ? attackerElement.attacker : attackerElement.a;
    }
    const hasElements = attackerElement !== undefined && attackerElement !== null
        && defenderElement !== undefined && defenderElement !== null;
    const baseRing = hasElements ? elementMultiplier(attackerElement, defenderElement) : 1;
    const ring = a.noAdvantage === true ? Math.min(1, baseRing) : baseRing;
    const weakBonus = a.noAdvantage !== true && hasElements && elementHit(attackerElement, defenderElement) === 1
        && Number.isFinite(a.weakElementBonus) ? Math.max(0, a.weakElementBonus) : 0;

    const critMult = a.noCrit === true ? 1 : a.crit === true ? CRIT_MULT + (a.critDamage || 0)
        : (typeof a.crit === "number" && a.crit > 0 ? a.crit : 1);
    const tempo = a.tempo !== undefined ? a.tempo : 1;

    const raw = power * coef * (ring + weakBonus) * tempo * critMult
        * (1 - defenderResist) - defence * DEF_FACTOR;
    const rounded = Math.round(raw);
    return rounded < 1 ? 1 : rounded;
}

// Ring flag for the view (damage numbers change colour) and for the crit rule.
export function elementFlag(attackerElement, defenderElement, noAdvantage = false) {
    if (attackerElement === undefined || attackerElement === null
        || defenderElement === undefined || defenderElement === null) {
        return 0;
    }
    const hit = elementHit(attackerElement, defenderElement);
    return noAdvantage === true ? Math.min(0, hit) : hit;
}

// --- melee geometry --------------------------------------------------------

export function angleDiff(a, b) {
    let d = a - b;
    while (d > Math.PI) { d -= Math.PI * 2; }
    while (d < -Math.PI) { d += Math.PI * 2; }
    return d;
}

// Circle against the finite swing sector, including its two radial edges.
// The old centre-only angle test missed bodies visibly crossed by the blade.
export function inMeleeArc(attacker, target, range, arc) {
    const dx = target.x - attacker.x;
    const dy = target.y - attacker.y;
    const dist = Math.hypot(dx, dy);
    const radius = target.radius || 0;
    if (dist > range + radius) {
        return false;
    }
    if (dist <= radius || arc >= Math.PI * 2) {
        return true;
    }
    const offset = angleDiff(Math.atan2(dy, dx), attacker.facing);
    if (Math.abs(offset) <= arc / 2) { return true; }
    const edge = attacker.facing + Math.sign(offset) * arc / 2;
    return segmentDistanceSquared(dx, dy, 0, 0,
        Math.cos(edge) * range, Math.sin(edge) * range) <= radius * radius;
}

// --- applying a hit --------------------------------------------------------

// Recompute the same five live player stats after a timer boundary or reset.
// Player speed buffs recover skills, never movement or normal attack cadence.
export function refreshPlayerStats(player) {
    if (!player.base || !player.skills) return;
    const sk = player.skills;
    player.atk = player.base.atk * sk.statMult("atk");
    player.mgc = player.base.mgc * sk.statMult("mgc");
    player.def = player.base.def * sk.statMult("def");
    player.mdef = player.base.mdef * sk.statMult("mdef");
    player.luck = player.base.luck * sk.statMult("luck");
}

// Player stats have already been refreshed from skills; enemy timed stat
// effects stay on the unit so melee, emitted bullets and defence agree.
export function effectiveStat(unit, key) {
    let change = 0;
    const buffs = unit.debuffs || [];
    for (let i = 0; i < buffs.length; i++) { change += buffs[i][key] || 0; }
    return change ? unit[key] * Math.max(0.1, 1 + change) : unit[key];
}

// Builds the resolveDamage argument for `attacker` swinging `skill` at
// `target`, reading stats off the units. Units carry the six stats directly
// (world.js copies them out of asset/rl/stats.js at spawn).
export function attackFrom(attacker, target, skill, extra) {
    const e = extra || {};
    const rules = e.gadgets || attacker.gadgets || {};
    const noCrit = rules.noCrit === true, noAdvantage = rules.noAdvantage === true;
    const hit = elementFlag(attacker.element, target.element, noAdvantage);
    const chance = e.crit !== undefined ? 0
        : critChanceFor(attacker.luck, attacker.critBonus, hit);
    // CalcCritical returns true for a Bearish target before any other rule
    // (the original's isEnableStateAbnormalBearish branch), so it outranks an
    // explicit crit:false from the enemy-no-crit contract. The player's own
    // noCrit passive still wins.
    const crit = noCrit === true ? false
        : bearished(target) === true ? true
            : e.crit !== undefined ? e.crit
                : rollCrit(chance, e.rng, e.forceCritical);
    // weapon passives (spec/04 §4.2): the crit-damage rows (type 7, e.g.
    // +0.33) ride on the attacker; the type-14 debuff rows live on enemies
    // as timed atk/mgc multipliers. Both are inert when absent — every
    // harness fixture and the player-without-affixes path see no change.
    return {
        atk: effectiveStat(attacker, "atk"), mgc: effectiveStat(attacker, "mgc"),
        def: effectiveStat(target, "def"), mdef: effectiveStat(target, "mdef"),
        element: attacker.element, targetElement: target.element,
        skill: skill,
        crit: crit,
        noCrit, noAdvantage,
        critDamage: attacker.critDamage || 0,
        weakElementBonus: attacker.skills ? attacker.skills.weakElementBonus || 0 : 0,
        healingLockChance: skill && skill.healingLockChance || 0,
        healingLockSeconds: skill && skill.healingLockSeconds || 0,
        hitStatResets: skill && skill.hitStatResets || null,
        rng: e.rng,
        tempo: attacker.kind === "player" ? TEMPO : 1,
        // kind 8 (T25): the target's resistance against the attacker's
        // element, summed from whichever carrier shape the target owns.
        defenderResist: sumResists(target, attacker.element),
        hitFlag: hit
    };
}

// Applies an already-built attack to `target`. Returns what happened so the
// caller can raise events; i-frames block the whole hit (spec/04 §7: no
// partial mitigation).
export function tryHit(target, attack) {
    if (target.dead) {
        return { hit: false, damage: 0, died: false };
    }
    if (target.iframes > 0) {
        return { hit: false, damage: 0, died: false, blocked: true };
    }
    // A bare number keeps the stage-1 call shape (atk only) working.
    const spec = typeof attack === "number" ? { atk: attack } : attack;
    let damage = resolveDamage(spec);
    // The barrier (skills.js effect kind 13) cuts the hit before it lands, and
    // it has to do so here rather than in world.js because this is the single
    // funnel every incoming hit passes through: body contact, a charger's
    // lunge (enemyai.js advanceDash) and a bullet all arrive at tryHit. A unit
    // with no skills object -- every harness fixture -- is unaffected.
    if (target.skills && typeof target.skills.absorb === "function") {
        damage = target.skills.absorb(damage);
    }
    // Stun payoff (spec/04 §11): a target inside its stun window takes extra
    // damage. Checked after the barrier because the barrier is a shield, not
    // a stun-immunity. `stunTimer` is undefined on the player and on every
    // harness fixture, so the multiplier is inert unless the gauge exists.
    if (target.stunTimer > 0) {
        damage = Math.max(1, Math.round(damage * STUN_DAMAGE_MULT));
    }
    target.hp = Math.max(0, target.hp - damage);
    const died = target.hp === 0;
    if (died) {
        target.dead = true;
        target.sm.set("dead");
    } else if (target.kind === "player") {
        target.sm.set("hit");
        target.iframes = Math.max(target.iframes, PLAYER_TIMING.hitInvuln);
    } else {
        target.sm.set("damage");
    }
    // Registered ailments ride the hit: healing lock keeps its historic
    // fields, Poison rides the generic rider list. At most one playerStatus
    // event per hit (the first ailment that landed) keeps the existing
    // single-hook gates stable.
    let playerStatus = null;
    if (!died && spec.statusRiders && spec.statusRiders.length && target.kind === "player") {
        for (const rider of spec.statusRiders) {
            const applied = rider.key === "healingLock"
                ? applyHealingLock(target, rider.chance, rider.seconds, spec.rng)
                : rider.key === "poison"
                    ? applyPoison(target, rider.chance, rider.seconds, spec.rng)
                    : rider.key === "bearish"
                        ? applyBearish(target, rider.chance, rider.seconds, spec.rng)
                        : null;
            if (!playerStatus) { playerStatus = applied; }
            if (applied && applied.action === "applied") { break; }
        }
    } else {
        playerStatus = !died ? applyHealingLock(target, spec.healingLockChance,
            spec.healingLockSeconds, spec.rng) : null;
    }
    let statResets = null;
    if (!died && spec.hitStatResets && spec.hitStatResets.length
            && target.kind === "player" && target.skills && target.skills.resetStats) {
        statResets = [];
        for (const reset of spec.hitStatResets) {
            const changed = target.skills.resetStats(reset);
            statResets.push({ mode: reset.mode, stats: reset.stats, changed });
        }
        // The next hit in this same update must see the post-reset defence.
        if (statResets.some(reset => reset.changed.length)) refreshPlayerStats(target);
    }
    return {
        hit: true,
        damage: damage,
        died: died,
        crit: spec.noCrit !== true && (spec.crit === true || (typeof spec.crit === "number" && spec.crit > 1)),
        hitFlag: spec.noAdvantage === true ? Math.min(0, spec.hitFlag || 0) : spec.hitFlag || 0,
        playerStatus: playerStatus,
        statResets: statResets
    };
}

// Pushes `target` away from (fromX, fromY). Bosses barely budge (§7).
export function applyKnockback(target, fromX, fromY, scale) {
    if (!target || target.dead) {
        return;
    }
    const dx = target.x - fromX;
    const dy = target.y - fromY;
    const len = Math.hypot(dx, dy);
    if (len === 0) {
        return;
    }
    const mass = target.aiType === "boss" ? KNOCKBACK.bossScale : 1;
    const impulse = KNOCKBACK.impulse * mass * (scale === undefined ? 1 : scale);
    target.kx = (target.kx || 0) + (dx / len) * impulse;
    target.ky = (target.ky || 0) + (dy / len) * impulse;
}

// Body contact: an enemy standing in the player deals its cheapest attack on a
// cooldown. Enemies do not walk (plan §2.1), so this is the price of the player
// choosing to stand inside one.
export function contactTouch(enemy, player, rng) {
    if (enemy.dead || player.dead || enemy.contactCooldown > 0) {
        return { hit: false, damage: 0, died: false };
    }
    const reach = enemy.radius + player.radius;
    const dx = player.x - enemy.x;
    const dy = player.y - enemy.y;
    if (Math.hypot(dx, dy) > reach) {
        return { hit: false, damage: 0, died: false };
    }
    enemy.contactCooldown = ENEMY_TIMING.contactCooldown;
    const coef = enemy.contactCoef !== undefined ? enemy.contactCoef : CONTACT_FALLBACK_COEF;
    // No knockback on the player here: being shoved by a body you walked into
    // would push you into whatever bullets you were already dodging, which is
    // unreadable. Knockback stays a thing the player does to enemies.
    return tryHit(player, attackFrom(enemy, player, { coef: coef, magic: false }, { rng: rng }));
}
