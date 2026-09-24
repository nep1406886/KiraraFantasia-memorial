// Enemy behaviour: three AI types, all built on "enemies do not walk".
//
// HARD RULE (master plan §4.1): no three.js, no DOM.
//
// Plan §2.1 is a constraint turned into a design: 465 of 604 enemy models have
// no skeleton and the animated ones have no walk clip, so the enemy vocabulary
// is *hold position, telegraph, act*. The player is the only unit that moves
// freely, and that is the player's power.
//
//   sentry   never moves; turns to face, then telegraphs and fires danmaku.
//   charger  the 蓄力型/跳跃型 pair folded together: telegraph, then a locked
//            lunge at where the player *was* -- dodgeable by reading, not by
//            reacting. Fires danmaku too, when it rolls a ranged skill.
//   boss     phases on HP, adds patterns and tightens cadence per phase, and
//            asks the world for reinforcements when a phase flips.
//
// Cadence comes from the row's own Spd: the original's turn is 8 recasts =
// 2.8 s (asset/rl/skills-rl.json turnSeconds), and an enemy acts every turn
// scaled by how fast it is relative to the shipped rows' median Spd of 100
// (measured across the 66 enemies in encounters.json: exactly 100). No new
// tuning constant -- both numbers come out of the tables.

import { ENEMY_TIMING } from "./actorstate.js";
import { angleDiff, tryHit, attackFrom, applyKnockback, effectiveStat } from "./combat.js";
import { moveCircle, sweepCircleTime } from "./geometry.js";
import { updateEnemyAction } from "./enemyactions.js";

// Median Spd of the shipped encounter roster; the divisor that turns a row's
// Spd into an action interval.
export const SPD_BASELINE = 100;
// Boss HP fractions where the next phase starts (three phases).
export const BOSS_PHASES = [0.7, 0.4];

// How each danmaku pattern is dressed. Counts are the readable-density choice;
// the pattern itself came from the skill name at build time.
const PATTERN_MODS = {
    aimed: { count: 1, speed: 6.0 },
    fan: { count: 5, speed: 5.2, spread: Math.PI / 3 },
    ring: { count: 12, speed: 4.6 },
    spiral: { arms: 3, steps: 6, speed: 4.8 },
    volley: { count: 3, speed: 6.2, stepDelay: 0.15 },
    wave: { count: 3, speed: 5.0, spread: Math.PI / 2, curve: 0.9 },
    cross: { count: 1, speed: 5.4 },
    wall: { count: 7, speed: 2.6, spacing: 0.8, radius: 0.22, life: 5.0 }
};

// Element character (T21e 去均匀弹幕海): the ring already says what each
// element *does* on hit (elements.js); this says how its projectiles *move*.
// 風 reads fast and flickery, 土 heavy and slow, the rest sit between. The
// multipliers stay inside the dodge band (walk 3.5 / dodge 8.4 u/s vs bullet
// ~4.6-6.2) so no element escapes the "outruns a walk, loses to a dodge"
// contract in danmaku.js.
const ELEMENT_TEMPO = {
    0: 1.06,   // 炎
    1: 0.94,   // 水
    2: 0.88,   // 土
    3: 1.15,   // 風
    4: 1.00,   // 月
    5: 1.00    // 陽
};

export function actionInterval(unit) {
    const turn = unit.turnSeconds || 2.8;
    const liveSpd = effectiveStat(unit, "spd");
    const spd = liveSpd > 0 ? liveSpd : SPD_BASELINE;
    let interval = turn * SPD_BASELINE / spd;
    // T25 kind-4 slow: enemies don't walk (plan §2.1), so 减速 lands on their
    // ACTION CADENCE instead of a movement stat they never use. Boss/elite
    // resistance was already eaten by applySlow's pct.
    if (unit.slow && unit.slow.pct > 0) {
        interval /= Math.max(0.2, 1 - unit.slow.pct);
    }
    // Bosses act once per phase-divided turn: phase 2 twice as often, phase 3
    // three times. Phase *is* the boss's escalation, so it is also its tempo.
    return unit.aiType === "boss" ? interval / (unit.phase || 1) : interval;
}

function faceToward(unit, target, dt, rate) {
    const want = Math.atan2(target.y - unit.y, target.x - unit.x);
    unit.facing += angleDiff(want, unit.facing) * Math.min(1, dt * (rate || 4));
}

// Picks an attack the unit can actually perform. A charge-pattern skill is a
// lunge, so only a charger may roll one; anything else fires it as an aimed
// shot rather than dropping the skill from the rotation.
// Support cast cooldown scales with the heal's size (2026-09-18): the rows
// carry no recast, so the fold sets it — a 3% top-up can come every couple of
// turns, but a 50% self-heal is a once-a-minute boss moment, and 100%
// 「ひきこもる」 reads as a room-length event, not a wall.
const SUPPORT_BASE = 2;        // intervals between small supports
const SUPPORT_HEAL_SCALE = 40; // extra intervals per 100% healed
function supportCooldown(unit, entry) {
    const heals = (entry.supportEffects || []).filter(function (fx) { return fx.kind === 1; });
    const maxPct = heals.length
        ? Math.max.apply(null, heals.map(function (fx) { return fx.pct; })) : 0;
    return actionInterval(unit) * (SUPPORT_BASE + maxPct * SUPPORT_HEAL_SCALE);
}

// 2026-09-18 敌人支援模组: pick one decoded support row whose cast would do
// something — a heal needs a wounded ally (or self), a buff needs its tag not
// already running. The first eligible row in authored order wins; kind 13
// shields stay undispatched (no enemy barrier carrier yet, spec/06).
function pickSupport(unit, world) {
    const support = (unit.moveset && unit.moveset.support) || [];
    for (const entry of support) {
        // Skip rows that also carry a turn-charge effect (kind 19): the
        // original's charged big move has no charge gauge here, so the row
        // stays undispatched rather than firing its heal half for free.
        if (entry.hasCharge) {
            continue;
        }
        const effects = entry.supportEffects || [];
        let usable = false;
        for (const effect of effects) {
            if (effect.kind === 1) {
                if (effect.target === 0) {
                    if (unit.hp < unit.maxHp / 2) { usable = true; }
                } else if (effect.target === 3 || effect.target === 4) {
                    for (const ally of world.enemies) {
                        if (!ally.dead && ally.hp < ally.maxHp / 2) { usable = true; break; }
                    }
                } else if (effect.target === 1 || effect.target === 2) {
                    // The row heals the player: authored as-is (boss mercy
                    // beat); cast it only when the player is not full.
                    const p = world.player;
                    if (p && !p.dead && p.hp < p.maxHp / 2) { usable = true; }
                }
            } else if (effect.kind === 2) {
                const targets = (effect.target === 1 || effect.target === 2)
                    ? (world.player && !world.player.dead ? [world.player] : [])
                    : [unit];
                for (const target of targets) {
                    const rows = target.debuffs || [];
                    const tag = "support" + entry.id;
                    let active = false;
                    for (const row of rows) {
                        if (row.tag === tag && row.remaining > 0) { active = true; break; }
                    }
                    if (!active) { usable = true; break; }
                }
            }
        }
        if (usable) { return entry; }
    }
    return null;
}

function pickAttack(unit, rng) {
    const attacks = (unit.moveset && unit.moveset.attacks) || [];
    if (!attacks.length) {
        return null;
    }
    const pool = unit.aiType === "charger"
        ? attacks
        : attacks.filter(function (a) { return a.pattern !== "charge"; });
    const list = pool.length ? pool : attacks;
    const pick = list[Math.floor((rng ? rng() : Math.random()) * list.length) % list.length];
    if (pick.pattern === "charge" && unit.aiType !== "charger") {
        return Object.assign({}, pick, { pattern: "aimed" });
    }
    return pick;
}

// Bosses escalate their own patterns: a single aimed shot becomes a burst,
// and from phase 2 a ring becomes a spiral.
function bossDress(unit, attack) {
    const phase = unit.phase || 1;
    if (attack.pattern === "aimed") {
        return { pattern: "aimed", count: 1 + phase };
    }
    if (attack.pattern === "ring" && phase >= 2) {
        return { pattern: "spiral", arms: 2 + phase };
    }
    if (attack.pattern === "fan") {
        return { pattern: "fan", count: 4 + phase * 2 };
    }
    if (attack.pattern === "volley") {
        return { pattern: "volley", count: 2 + phase };
    }
    if (attack.pattern === "wall") {
        return { pattern: "wall", count: 7 + phase * 2 };
    }
    if (attack.pattern === "wave") {
        return { pattern: "wave", count: 3 + phase };
    }
    return { pattern: attack.pattern };
}

function fire(unit, world, attack) {
    const dress = unit.aiType === "boss" ? bossDress(unit, attack) : { pattern: attack.pattern };
    const base = PATTERN_MODS[dress.pattern] || PATTERN_MODS.aimed;
    const tempo = ELEMENT_TEMPO[unit.element] || 1;
    const mods = Object.assign({}, base, dress, {
        side: "enemy",
        element: unit.element,
        power: effectiveStat(unit, attack.magic ? "mgc" : "atk"),
        coef: attack.coef,
        magic: attack.magic,
        critChance: 0,             // enemies do not crit (spec/04 §7 gives the
                                   // luck term to the player's loot roll)
        srcId: unit.id,
        skillId: attack.id,
        healingLockChance: attack.healingLockChance,
        healingLockSeconds: attack.healingLockSeconds,
        statusRiders: attack.statusRiders,
        hitStatResets: attack.hitStatResets
    });
    if (mods.speed) {
        mods.speed = mods.speed * tempo;
    }
    delete mods.pattern;
    const made = world.danmaku
        ? world.danmaku.emit(dress.pattern, { x: unit.x, y: unit.y, angle: unit.facing }, mods)
        : 0;
    world.events.push({
        type: "enemySkill", unit: unit, skill: attack,
        pattern: dress.pattern, bullets: made
    });
    return made;
}

// The lunge: commit to the player's position as it was when the telegraph
// started, travel there over ENEMY_TIMING.dash, and deal the skill's own damage
// on the way through. Aiming at the *snapshot* rather than at the player's live
// position is what makes the 0.70 s telegraph the dodge window: the lunge is
// beaten by reading the tell and walking, not by reacting inside the 0.32 s of
// travel. unit.aimAt is written by enemyai when it commits to the attack.
function startDash(unit, world, attack) {
    const aim = unit.aimAt || world.player;
    const dx = aim ? aim.x - unit.x : Math.cos(unit.facing);
    const dy = aim ? aim.y - unit.y : Math.sin(unit.facing);
    const len = Math.hypot(dx, dy) || 1;
    // Overshoot slightly so the lunge passes through the player instead of
    // stopping politely on their hitbox.
    const travel = Math.min(len + 0.6, 6.0);
    if (!unit.sm.set("dash")) {
        // Nothing legal to lunge out of: drop the lunge rather than leave a
        // dash on a unit that will never advance it.
        unit.aimAt = null;
        return;
    }
    unit.dash = {
        vx: (dx / len) * travel / ENEMY_TIMING.dash,
        vy: (dy / len) * travel / ENEMY_TIMING.dash,
        skill: attack,
        hit: false
    };
    unit.aimAt = null;
    world.events.push({ type: "dash", unit: unit, skill: attack });
}

function advanceDash(unit, world, dt) {
    const d = unit.dash;
    if (!d) {
        return;
    }
    const beforeX = unit.x, beforeY = unit.y;
    const margin = unit.radius;
    const position = moveCircle(unit, d.vx * dt, d.vy * dt, world.roomColliders, {
        minX: margin, maxX: world.width - margin, minY: margin, maxY: world.height - margin
    });
    unit.x = position.x; unit.y = position.y;

    const p = world.player;
    if (!p || p.dead || d.hit) {
        return;
    }
    if (!Number.isFinite(sweepCircleTime(beforeX, beforeY, unit.x, unit.y,
            p.x, p.y, unit.radius + p.radius))) {
        return;
    }
    d.hit = true;
    const result = tryHit(p, attackFrom(unit, p, d.skill, { rng: world.rng }));
    if (result.hit) {
        world.events.push({
            type: "hit", attacker: unit, target: p,
            damage: result.damage, died: result.died, skill: d.skill
        });
        if (result.playerStatus && result.playerStatus.action !== "miss") {
            world.events.push({ type: "playerStatus", unit: p, ...result.playerStatus });
        }
        for (const reset of result.statResets || []) {
            world.events.push({ type: "statReset", unit: p, ...reset });
        }
    }
}

function updatePhase(unit, world) {
    if (unit.aiType !== "boss") {
        return;
    }
    const frac = unit.maxHp > 0 ? unit.hp / unit.maxHp : 1;
    let phase = 1;
    for (let i = 0; i < BOSS_PHASES.length; i++) {
        if (frac <= BOSS_PHASES[i]) {
            phase = i + 2;
        }
    }
    if (phase === (unit.phase || 1)) {
        return;
    }
    unit.phase = phase;
    // A phase flip is a beat of its own: clear the floor around the boss and
    // ask for reinforcements. The world decides whether it can honour it.
    if (world.danmaku) {
        world.danmaku.emit("ring", { x: unit.x, y: unit.y, angle: unit.facing }, {
            count: 16 + phase * 4, speed: 4.2, side: "enemy", element: unit.element,
            power: effectiveStat(unit, "mgc") || effectiveStat(unit, "atk"),
            coef: 0.1, magic: true, srcId: unit.id
        });
    }
    unit.actionTimer = ENEMY_TIMING.recover;
    world.events.push({ type: "bossPhase", unit: unit, phase: phase });
    if (typeof world.requestSummon === "function") {
        world.requestSummon(unit, phase);
    }
}

// enemyai(unit, world, dt) -- T07's contract. Called once per enemy per tick,
// after the unit's state machine has been updated.
export function enemyai(unit, world, dt) {
    if (unit.dead || unit.sm.state === "dead") {
        return;
    }
    if (unit.choreography) {
        updateEnemyAction(unit, world, dt, BOSS_PHASES);
        return;
    }
    updatePhase(unit, world);

    const state = unit.sm.state;
    const p = world.player;
    const alive = p && !p.dead;

    // The action clock runs in every state, including while the unit is
    // telegraphing, acting or flinching. actionInterval is the period *between
    // decisions*, not the gap that follows each animation -- that is the cadence
    // tools/rl_balance_harness.mjs models (one enemy action per actionInterval),
    // and charging the 1.15 s of telegraph+skill on top of it would make the
    // shipped fight ~29% less dangerous than the win bands it is gated against.
    // A unit fast enough for its interval to fall inside its own animation
    // simply acts as fast as the animation allows.
    unit.actionTimer = (unit.actionTimer || 0) - dt;
    // The support clock shares the action cadence (same per-frame decrement);
    // it only decides when the unit is actually free to act, below.
    if (unit.supportTimer === undefined) { unit.supportTimer = actionInterval(unit) * 2; }
    unit.supportTimer -= dt;

    // Aim tracks the player except while committed: once the telegraph starts
    // the direction is locked, which is what makes the tell honest.
    if (alive && (state === "idle" || state === "recover")) {
        faceToward(unit, p, dt, 4);
    }

    if (state === "dash") {
        advanceDash(unit, world, dt);
        return;
    }
    if (state === "skill") {
        // The pending attack fires on the frame the skill window opens.
        if (unit.pending) {
            const attack = unit.pending;
            unit.pending = null;
            if (attack.supportEffects) {
                // 2026-09-18 敌人支援模组: a support row casts its decoded
                // effects (heal/buff) through the world's dispatcher instead
                // of firing danmaku. No bullet, no charge.
                const events = world.applyEnemySupport
                    ? world.applyEnemySupport(unit, attack) : null;
                if (events) {
                    for (const ev of events) { world.events.push(ev); }
                }
            } else if (attack.pattern === "charge" && unit.aiType === "charger") {
                startDash(unit, world, attack);
            } else {
                fire(unit, world, attack);
            }
        }
        return;
    }
    if (state !== "idle" && state !== "recover") {
        return;               // telegraphing, flinching: nothing to decide
    }

    if (unit.actionTimer > 0 || !alive) {
        return;
    }

    // 2026-09-18 敌人支援模组: the support clock runs on its own timer and,
    // when ready and a decoded support row exists with an eligible target,
    // this cycle casts support INSTEAD of attacking (one action slot used).
    if (unit.supportTimer <= 0) {
        const support = pickSupport(unit, world);
        if (support) {
            unit.supportTimer = supportCooldown(unit, support);
            unit.pending = support;
            unit.actionTimer = actionInterval(unit);
            if (unit.sm.set("telegraph")) {
                world.events.push({ type: "telegraph", unit: unit, skill: support,
                    pattern: support.pattern || "buff", support: true,
                    duration: ENEMY_TIMING.telegraph });
            } else {
                unit.pending = null;
            }
            return;
        }
        unit.supportTimer = actionInterval(unit) * 2;  // nothing eligible; retry soon
    }

    const attack = pickAttack(unit, world.rng);
    if (!attack) {
        unit.actionTimer = actionInterval(unit);
        return;
    }
    // Out-of-range lunges are pointless; a charger that cannot reach fires
    // instead if it has anything ranged, and otherwise just waits a beat.
    const dist = Math.hypot(p.x - unit.x, p.y - unit.y);
    let chosen = attack;
    if (attack.pattern === "charge" && dist > 7.5) {
        const ranged = (unit.moveset.attacks || []).filter(function (a) { return a.pattern !== "charge"; });
        if (!ranged.length) {
            unit.actionTimer = actionInterval(unit) * 0.5;
            return;
        }
        chosen = ranged[Math.floor((world.rng ? world.rng() : Math.random()) * ranged.length) % ranged.length];
    }

    unit.pending = chosen;
    unit.actionTimer = actionInterval(unit);
    // Snapshot the player's position for charge skills; the lunge will aim at
    // this, not at the player's live position at launch time. That is what
    // makes the read-window honest: by the time startDash runs the player has
    // already dodged out of the line (or not).
    if (chosen.pattern === "charge" && p) {
        unit.aimAt = { x: p.x, y: p.y };
    }
    if (unit.sm.set("telegraph")) {
        world.events.push({
            type: "telegraph", unit: unit, skill: chosen,
            pattern: chosen.pattern, duration: ENEMY_TIMING.telegraph
        });
    } else {
        unit.pending = null;
        unit.aimAt = null;
    }
}

// Knockback decay, shared by every unit the world moves. Enemies do not walk,
// so this is the only thing that displaces them.
export function decayKnockback(unit, dt, world) {
    if (!unit.kx && !unit.ky) {
        return;
    }
    const margin = unit.radius;
    const position = moveCircle(unit, (unit.kx || 0) * dt, (unit.ky || 0) * dt, world.roomColliders, {
        minX: margin, maxX: world.width - margin, minY: margin, maxY: world.height - margin
    });
    unit.x = position.x; unit.y = position.y;
    const decay = Math.max(0, 1 - 9.0 * dt);
    unit.kx = (unit.kx || 0) * decay;
    unit.ky = (unit.ky || 0) * decay;
    if (Math.abs(unit.kx) < 0.01) { unit.kx = 0; }
    if (Math.abs(unit.ky) < 0.01) { unit.ky = 0; }
}

// Re-exported so world.js has one import site for the enemy layer.
export { applyKnockback };
