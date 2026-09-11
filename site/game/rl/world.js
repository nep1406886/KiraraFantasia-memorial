// The current room: player, enemies, bullets, and everything that can hurt or
// be hurt.
//
// HARD RULE (master plan §4.1): this file and everything it imports stay free
// of three.js and the DOM so pure-logic harnesses run in node. The view layer
// reads units out of here and never writes back.
//
// Stage-3 scope: the shipped tables drive the fight. createWorld takes
// `tables` ({ stats, skills, encounter }) and every number comes out of them --
// asset/rl/stats.js for the growth curves, skills-rl.json for movesets and
// cooldowns, one encounters.json volume row for who spawns. The three AI types
// live in ./enemyai.js and the bullets in ./danmaku.js; this file is the wiring
// and owns exactly one thing of its own, the update order.
//
// Tables are optional. With none, createWorld/spawnPlayer/spawnEnemy behave as
// they did in stage 2 (hp 10 / atk 1 / def 0 player, hp 5 / atk 1 enemies),
// which is what tools/rl_combat_harness.mjs and rl_move_harness.mjs asserts
// against: a gate for the melee hit window must not move when someone
// re-authors a growth curve (spec/02 -- harness 不得从被测管线读期望).
//
// The update order is the one tools/rl_enemy_harness.mjs pins:
//   player -> per enemy (timers, state machine, brain, knockback, contact)
//   -> bullets -> gauge -> room clear.
// Bullets move after the units that fired them so a shot never resolves against
// a stale position, and the gauge is credited last, from the events this tick
// appended (creditGauge), so every damage path counts once and only once.

import {
    createStateMachine, PLAYER_STATES, ENEMY_STATES, BOSS_STATES, PLAYER_TIMING
} from "./actorstate.js";
import {
    inMeleeArc, tryHit, attackFrom, contactTouch, applyKnockback,
    elementFlag, critChanceFor, rollCrit, TEMPO, CRIT_MULT, sumResists, effectiveStat,
    refreshPlayerStats as refreshPlayer
} from "./combat.js";
import { enemyai, decayKnockback, actionInterval } from "./enemyai.js";
import { enemyRole } from "./enemyroles.js";
import { CHOREOGRAPHY_STATES, cancelEnemyAction } from "./enemyactions.js";
import { createDanmaku } from "./danmaku.js";
import { createSkills, decodeSkill, enemyMoveset, contactCoefOf } from "./skills.js";
import { applyHealingLock, cleanseHealingLock, grantHealingLockImmunity,
    healingLocked, updatePlayerStatus, clearPlayerStatus } from "./playerstatus.js";
import { placeSkillCard, updateSkillCards, clearSkillCards, NORMAL_CARD_SOURCE } from "./skillcards.js";
import { resetStatChanges } from "./statreset.js";
import { grantNextCritical, consumeNextCritical, clearNextCritical } from "./nextcritical.js";
import { doorsOf, ROOM_SIZE, roomSize } from "./dungeon.js";
import { floorShrineFor, nearFloorShrine } from './floorshrine.js';
import { restCampFor } from './restcamp.js';
import { createRandom, hash32 } from "./random.js";
import { moveCircle } from "./geometry.js";
import { rollLoot } from "./loot.js";
import { canEquipWeapon } from "./weaponcatalog.js";
import { weaponProfile, inWeaponReach } from "./weaponprofile.js";
import { selectEnemyTarget, ultimatePreview } from "./targeting.js";
import { applyEquipment, equipmentMultipliers, passiveRuntime, calculateLoadout, previewEquipment } from "./equipment.js";
import { gadgetRuntime, gadgetDefinition, gadgetTerms, rollGadget, sameGadgetEffect } from './gadgets.js';
import { createAssistance } from './assistance.js';
import { restEventChoices, altarEventChoices } from './roomevents.js';

let nextId = 1;

function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

// How close to the door's center line (world units) the player must be to slip
// through the wall opening.
const DOOR_BAND = 1.5;
// Where the player lands after stepping through a door.
const ENTRY_OFFSET = 1.2;
// Door crossing is staged under a screen fade (T21d): the view covers the
// stage in CSS (0.15s ease-in), the world swaps the room once this much
// simulation time has run — the fade must be fully opaque before the swap,
// so this stays strictly above the CSS cover duration.
export const DOOR_FADE_OUT = 0.18;

function doorEntry(side, width, height) {
    if (side === "N") return { x: width / 2, y: ENTRY_OFFSET };
    if (side === "S") return { x: width / 2, y: height - ENTRY_OFFSET };
    if (side === "W") return { x: ENTRY_OFFSET, y: height / 2 };
    if (side === "E") return { x: width - ENTRY_OFFSET, y: height / 2 };
    return { x: width / 2, y: height / 2 };
}

// Enemy hitbox radius, read off the original's own shadow size: the encounter
// roster's median m_ShadowScale is 2.5 and stage 2's hand-picked radius was
// 0.5, so one ratio converts the whole table instead of 66 authored numbers.
// The clamp is because the extremes (0.2 .. 5.0) are bounding boxes of the
// *model* -- a 5.0 shadow is a mecha's footprint, not the part you hit. This is
// geometry, not one of spec/04 §6's forbidden balance coefficients.
export const RADIUS_PER_SHADOW = 0.2;
export const RADIUS_MIN = 0.35;
export const RADIUS_MAX = 1.2;

// spec/04 §6 allows exactly three balance levers besides TEMPO: 词条池, 掉落表,
// 敌人组合. This is the last of the three, so it lives in the game and
// tools/rl_balance_harness.mjs imports it -- the certified win bands have to be
// measured against the value the player actually meets.
export const ELITE_CHANCE = 0.25;

// A boss phase flip asks the world for reinforcements (enemyai.js updatePhase
// -> world.requestSummon). Two flips, one add each, never more than two alive:
// the adds are a beat in the fight, not a second fight.
export const SUMMON_PER_PHASE = 1;
export const SUMMON_MAX = 2;
// How far from the boss an add appears. Around the fight, not on the player.
export const SUMMON_RING = 2.5;

// --- progression economy (spec/04 §10) --------------------------------------
// コイン (coin) is the run currency 游玩说明 §3 promises for the shop; exp is the
// in-run level growth on top of the volume's starting level. All of it lives
// here as named constants because tools/rl_progression_harness.mjs imports
// them -- the certified behaviour has to be measured against the numbers the
// player actually meets.
export const PICKUP_RADIUS = 0.9;
export const EXP_PER_KILL = { enemy: 6, elite: 15, boss: 40 };
export const COIN_PER_KILL = { enemy: 8, elite: 20, boss: 50 };
export const SHOP_PRICES = { common: 30, rare: 60, epic: 110, legendary: 200 };
export const SHOP_ITEM_COUNT = 3;
export const REST_HEAL_FRACTION = 0.4;
export const LEVELUP_HEAL_FRACTION = 0.3;

// --- T22g 交互丰富: room interactables -----------------------------------------
// 木桶 (battle rooms) and the 祭坛 event point roll off the room's own seed
// stream, so a regenerated floor rebuilds them identically; their state parks
// on roomState and survives re-entry. The barrel/altar tables are authored
// here rather than in loot.js because they pay coin/HP, not equipment — a
// barrel is a small bonus (coin 55% / heal 20% / nothing 25%), the altar is
// the room's one big event (coin 40% / heal 35% / nothing 25%).
export const BARREL_LOOT = {
    coin: 0.55, coinMin: 6, coinMax: 14, heal: 0.20, healFraction: 0.12
};
export const BARREL_MIN_COUNT = 2;
export const BARREL_MAX_COUNT = 3;
export const BARREL_RADIUS = 0.45;
export const ALTAR_CHANCE = 0.35;
export const ALTAR_OUTCOMES = {
    coin: 0.40, coinMin: 40, coinMax: 60, heal: 0.35, healFraction: 0.25
};

export function expToNext(level) {
    return 20 * level;
}

// --- スタンゲージ (stun gauge, spec/04 §11) -----------------------------------
// The Kirafan-native replacement for the dropped Touhou graze system: the
// original's passives name it directly (PassiveSkillList m_Type 4 スタンゲージ,
// m_Type 2 スタン状態にならない), so the mechanic is enemy-side, not
// player-side. Hitting an enemy fills its gauge; a full gauge stuns it for
// STUN_DURATION, during which it neither acts nor touches the player and takes
// STUN_DAMAGE_MULT (combat.js) more damage. ばつぐん and crits fill faster --
// the reward lever is the element ring the game already teaches, so no new
// stat is invented (spec/04 §6's no-hidden-coefficients rule).
export const STUN_MAX = 100;
export const STUN_BASE = 10;              // gauge points per landed hit
export const STUN_ADVANTAGE_BONUS = 10;   // extra when hitFlag === 1 (ばつぐん)
export const STUN_CRIT_BONUS = 10;        // extra when the hit crits
export const STUN_RATE = { enemy: 1.0, elite: 0.6, boss: 0.4 };
export const STUN_DURATION = 3.0;         // seconds of the stun window
export const STUN_DECAY_DELAY = 3.0;      // seconds unhit before the gauge decays
export const STUN_DECAY_PER_SEC = 15;     // gauge points drained per second after that

// T25 enemy-target abnormal -> slow (kind 4, spec/08 §2.1): shipped chance%
// remains slow strength on enemies. Player Unhappy is a separate T30 status.
// Durability differs by rank —
// a boss shrugs off 70% of it, an elite 45% — and never reaches a full stop,
// so control is pressure, not a lockout. Refresh keeps the STRONGER of old
// and new and resets the clock: multi-hit ordering is invisible.
export const SLOW_RESIST = { enemy: 0, elite: 0.45, boss: 0.7 };

export function createWorld(options) {
    const cfg = options || {};
    const assistance = createAssistance();
    const hitPositions = new WeakMap();
    const world = {
        width: cfg.width || ROOM_SIZE.w,
        height: cfg.height || ROOM_SIZE.h,
        time: 0,
        frozen: false,
        // 受击顿帧 (T21b): seconds of simulation freeze left. Set through
        // applyHitStop() when a hit lands; update() burns it down before the
        // frozen check so the two never fight over who skips the tick.
        hitStop: 0,
        // 门过渡 (T21d): non-null while a door crossing is being staged.
        // { t, to, fromSide } — tryTransition arms it, update() walks the
        // player on for DOOR_FADE_OUT seconds (enemies/bullets hold), then
        // performs the enterRoom it replaced.
        transition: null,
        player: null,
        enemies: [],
        enemyActionCursor: 0,
        events: [],
        // The live input.state object (game/rl/input.js); the harness can
        // substitute a plain object with the same shape.
        inputState: null,
        assistance: assistance.status,
        // T22k 键鼠联动: world-space aim point from the mouse, { x, y } on
        // the ground plane, or null (no pointer yet / over an overlay that
        // cleared it). The view layer writes it each tick before update().
        aim: null,

        // --- dungeon state (stage 2) ---
        dungeon: null,
        roomId: null,
        roomState: new Map(),          // roomId → { visited, cleared }
        // --- T22g room interactables: chest/barrels/altar/npc of the CURRENT
        // room. The durable records live on roomState; these handles are
        // re-bound (or nulled) by every enterRoom.
        chest: null,
        barrels: [],
        altar: null,
        npc: null,
        floorShrine: null,
        // Prop AABBs of the current room, set by the view after buildRoom
        // (mapview): [{ x, y, hw, hh }] in room-local world units. Cleared
        // on every room change; movement pushes out of them (clampRoom).
        roomColliders: [],

        // Shipped tables, all optional (see the header). `stats` is
        // asset/rl/stats.js createStats, `skills` the parsed skills-rl.json,
        // `encounter` one encounters.json volume row.
        tables: {
            stats: (cfg.tables && cfg.tables.stats) || null,
            skills: (cfg.tables && cfg.tables.skills) || null
        },
        encounter: (cfg.tables && cfg.tables.encounter) || null,
        volume: cfg.volume
            || (cfg.tables && cfg.tables.encounter ? cfg.tables.encounter.vol : 0),
        floor: cfg.floor || 1,
        // 20-layer descent (spec/02 §3): absent in fixtures/gates → 1, i.e.
        // the single-floor legacy world where floor 1 IS the final floor.
        floorsPerVolume: cfg.floorsPerVolume || 1,

        // Items rolled but not yet picked up, [{ x, y, items }] in world
        // units. Walking over one auto-equips it (spec/04 §10) and pushes a
        // "pickup" event; the drop entry reference rides both events so the
        // view can pair its floor marker with the removal.
        drops: [],

        // Run currency (コイン, spec/04 §10): kills award it, the shop spends it.
        coin: 0,

        // Every roll the *fight* makes: AI choices, crits, elite upgrades,
        // summon placement. Seeded so replaying a seed replays the battle; the
        // dungeon layout has its own stream inside dungeon.js and must keep it,
        // or adding this stage would have moved every door.
        rng: createRandom(hash32("world:" + (cfg.seed !== undefined ? cfg.seed : 0))),

        // Both sides' bullets. Always present -- the pool is 1024 plain objects
        // and enemyai.js/skills only ever fill it when something has a ranged
        // row, so a table-less fixture world simply never emits.
        danmaku: createDanmaku(cfg.danmaku || {}),

        spawnPlayer: function (spec) {
            const s = spec || {};
            const table = world.tables.stats;
            const card = s.card
                || (table && s.cardId !== undefined ? table.card(s.cardId) : null);
            const level = s.level !== undefined ? s.level
                : (world.encounter && world.encounter.playerLevel
                    ? world.encounter.playerLevel : 1);
            // With a card the six stats are the shipped growth curve; without
            // one they are stage-2's literals, which the stage-1 gates assert.
            const base = card && table ? table.statsFor(card.id, level) : {
                hp: s.hp !== undefined ? s.hp : 10,
                atk: s.atk !== undefined ? s.atk : 1,
                mgc: 0,
                def: s.def !== undefined ? s.def : 0,
                mdef: 0, spd: 100, luck: 0
            };
            // Native weapons add their table stats before the affix multipliers.
            // Legacy items retain their original multiplier-only behavior.
            if ((s.equipment || []).some(item => !canEquipWeapon(item, card))) {
                throw new Error("equipment: weapon does not match the player");
            }
            // Keep raw affix crit points separate from the displayed capped
            // chance. A contract suppresses hits, not their original chance.
            let stats = base;
            let critAffix = 0;
            if (s.equipment && s.equipment.length) {
                stats = applyEquipment(base, s.equipment, card);
                critAffix = equipmentMultipliers(s.equipment, card).crit;
            }
            const maxHp = s.hp !== undefined ? s.hp : stats.hp;
            const unit = {
                id: nextId++,
                kind: "player",
                card: card,
                level: level,
                element: card ? card.element : undefined,
                model: s.model,
                x: s.x !== undefined ? s.x : world.width / 2,
                y: s.y !== undefined ? s.y : world.height / 2,
                radius: 0.45,
                facing: 0,
                hp: maxHp,
                maxHp: maxHp,
                // s.hp is a fixture override of the whole hp field; a later
                // re-equip must not "fix" it back to the curve (reapplyEquipment).
                hpOverride: s.hp,
                // `base` is the unbuffed curve; atk/mgc/def/mdef/luck are the
                // live values every hit reads, recomputed from base through the
                // buff multipliers once per tick (refreshPlayer).
                base: stats,
                // Pre-equipment truth of the current level: equipping and
                // levelling re-derive `base` from here, never from `base`
                // itself, so cycles cannot accumulate residue.
                truthBase: base,
                // Live equipment, one item per slot; explicit confirmation replaces it.
                equipment: (s.equipment || []).slice(),
                weaponProfile: weaponProfile(card, s.equipment || []),
                gadgets: gadgetRuntime(s.equipment || []),
                swingGadgets: null,
                swingProfile: null,
                exp: 0,
                expNext: expToNext(level),
                atk: stats.atk, mgc: stats.mgc,
                def: stats.def, mdef: stats.mdef,
                luck: stats.luck,
                critBonus: critAffix,    // 阶段 4's 词条 pool writes here
                // Weapon passives (spec/04 §4.2): recompute on every
                // equip/levelup in reapplyEquipment. critDamage rides the
                // unit for combat.attackFrom; the stacks are permanent run
                // buffs from the trigger-1/2 rows; survivalUsed counts
                // 踏みとどまり charges spent this floor.
                passives: passiveRuntime(s.equipment || []),
                critDamage: 0,
                stackHits: 0,
                stackKills: 0,
                survivalUsed: 0,
                speed: PLAYER_TIMING.moveSpeed,
                iframes: 0,
                dead: false,
                healingLock: 0,
                healingLockImmunity: 0,
                skillCards: [],
                // per-swing bookkeeping: a swing hits each enemy at most once
                swingId: 0,
                swingHits: null,
                castOnly: false,         // this swing is a skill cast, not a hit
                // T22m: which slot the current cast came from (0-2), so the
                // view can play that slot's authored clip instead of the
                // generic attack. Bumped by castSkill, read by actorview.
                castSlot: -1,
                dodgeDir: { x: 1, y: 0 },
                heldSkill: [false, false, false],
                heldUltimate: false,
                heldDodge: false,
                heldAttack: false,
                actionBuffer: null
            };
            if (card && world.tables.skills) {
                unit.skills = createSkills({
                    table: world.tables.skills, card: card, maxHp: maxHp
                });
                if (unit.passives) {
                    unit.skills.applyWeapon(unit.passives, unit.weaponProfile.classId);
                }
                unit.skills.applyGadgets(unit.gadgets);
            }
            unit.critDamage = unit.passives ? unit.passives.critDamage : 0;
            unit.sm = createStateMachine("idle", PLAYER_STATES);
            world.player = unit;
            return unit;
        },

        spawnEnemy: function (spec) {
            const s = spec || {};
            const boss = s.aiType === "boss";
            const hp = s.hp !== undefined ? s.hp : 5;
            const unit = {
                id: nextId++,
                // An elite keeps its own moves but is not the main boss for
                // phase changes, the view or the HUD.
                kind: boss && !s.elite ? "boss" : "enemy",
                enemyId: s.enemyId,
                name: s.name,
                nameZh: s.nameZh,
                model: s.model,                    // manifest key, view-only
                shadowScale: s.shadowScale,        // view: blob shadow size
                voiceCueSheet: s.voiceCueSheet,    // 阶段 6 / T04
                x: s.x, y: s.y,
                radius: s.radius !== undefined ? s.radius : 0.5,
                facing: Math.PI,
                hp: hp, maxHp: hp,
                atk: s.atk !== undefined ? s.atk : 1,
                mgc: s.mgc !== undefined ? s.mgc : 0,
                def: s.def !== undefined ? s.def : 0,
                mdef: s.mdef !== undefined ? s.mdef : 0,
                spd: s.spd !== undefined ? s.spd : 100,
                luck: s.luck !== undefined ? s.luck : 0,
                element: s.element,
                aiType: s.aiType || "sentry",
                elite: !!s.elite,
                summoned: false,
                moveset: s.moveset || null,
                choreography: enemyRole(s.enemyId, s.moveset),
                choreographyCursor: 0,
                action: null,
                recoveryWindow: 0,
                turnSeconds: s.turnSeconds,
                phase: 1,
                actionTimer: 0,
                pending: null,
                aimAt: null,
                dash: null,
                kx: 0, ky: 0,
                iframes: 0,
                dead: false,
                // スタンゲージ (spec/04 §11): stun fills from being hit, decays
                // after a lull, and stunTimer > 0 is the stun window itself.
                stun: 0,
                stunTimer: 0,
                stunIdle: 0,
                contactCooldown: 0,
                room: s.room !== undefined ? s.room : world.roomId
            };
            // Body contact costs the enemy's cheapest attack; an enemy with no
            // damage row at all leaves the field unset so combat.js's shipped
            // fallback applies, because 0 would read as "free to stand in".
            const coef = s.moveset ? contactCoefOf(s.moveset) : 0;
            if (coef > 0) {
                unit.contactCoef = coef;
            }
            // Authored commitments keep their own clocks. The legacy brain's
            // timed transitions must not fire them before their full warning.
            unit.sm = createStateMachine("idle", unit.choreography ? CHOREOGRAPHY_STATES
                : boss ? BOSS_STATES : ENEMY_STATES);
            // Stagger the opening volley so a room does not fire in unison --
            // the same first `next` rl_balance_harness.mjs gives its units.
            unit.actionTimer = actionInterval(unit) * (0.3 + 0.7 * world.rng());
            world.enemies.push(unit);
            return unit;
        },

        // T06's contract names one entry point; spawnPlayer/spawnEnemy are the
        // typed forms the harnesses and main.js already call.
        spawn: function (kind, spec) {
            return kind === "player" ? world.spawnPlayer(spec) : world.spawnEnemy(spec);
        },

        get units() {
            const list = world.enemies.slice();
            if (world.player) {
                list.unshift(world.player);
            }
            return list;
        },

        get room() {
            if (!world.dungeon) {
                return null;
            }
            return world.dungeon.rooms.find(function (r) { return r.id === world.roomId; }) || null;
        },

        // Doors of the current room, resolved for the view/HUD.
        get roomDoors() {
            return world.dungeon ? doorsOf(world.dungeon, world.roomId) : [];
        },

        // True while a battle/boss room still has live enemies — its doors
        // stay shut.
        get roomLocked() {
            const room = world.room;
            if (!room || (room.type !== "battle" && room.type !== "boss")) {
                return false;
            }
            return world.enemies.some(function (e) { return !e.dead; });
        },

        get floorExitReady() {
            const room = world.room;
            return !!(room && room.type === 'boss' && world.player && !world.player.dead
                && world.player.sm.state !== 'dead' && !world.transition && !world.roomLocked
                && world.roomState.get(room.id)?.cleared);
        },

        get canCommuneAtShrine() {
            // Frozen is checked by the input owner, not here: confirmation
            // intentionally freezes the world and must recheck this same range.
            return world.floorExitReady && nearFloorShrine(world.floorShrine, world.player);
        },

        // Views/audio consume events (dodge, swing, hit, room, death...)
        // between updates; drainEvents hands them over and clears the queue.
        drainEvents: function () {
            const out = world.events;
            world.events = [];
            return out;
        }
    };

    // --- dungeon wiring ------------------------------------------------------

    world.setDungeon = function (dungeon, roomClaims) {
        world.dungeon = dungeon;
        world.roomState = new Map();
        dungeon.rooms.forEach(function (room) {
            const claim = (roomClaims || []).find(function (c) { return c.id === room.id; }) || {};
            world.roomState.set(room.id, {
                visited: false, cleared: !!claim.cleared, claims: claim,
                drops: claim.drops ? JSON.parse(JSON.stringify(claim.drops)) : [],
                rested: !!claim.rested, supply: claim.supply,
                offer: claim.offer ? JSON.parse(JSON.stringify(claim.offer)) : null
            });
        });
        world.roomColliders = [];
        // A new dungeon is a new floor: the 踏みとどまり charges (spec/04
        // §4.2 type 11, 「1回だけ」) re-arm on the way down.
        if (world.player) {
            world.player.survivalUsed = 0;
        }
        world.enterRoom(dungeon.start, null);
    };

    // Completed encounters and their remaining loot survive reload. Unfinished
    // fights still restart; their transient enemy/projectile state is not saved.
    world.getRoomClaims = function () {
        return Array.from(world.roomState, function (pair) {
            const state = pair[1], old = state.claims || {};
            const claim = {
                id: pair[0],
                chestOpened: state.chest ? state.chest.opened : !!old.chestOpened,
                altarUsed: state.altar ? state.altar.used : !!old.altarUsed,
                rested: !!state.rested,
                npcTalked: state.npc ? state.npc.talked : !!old.npcTalked,
                barrels: state.barrels
                    ? state.barrels.filter(b => b.broken).map(b => b.id) : (old.barrels || []).slice()
            };
            if (state.supply) { claim.supply = state.supply; }
            if (state.offer) { claim.offer = JSON.parse(JSON.stringify(state.offer)); }
            if (state.cleared) { claim.cleared = true; }
            const drops = pair[0] === world.roomId ? world.drops : state.drops;
            if ((claim.cleared || claim.chestOpened) && drops?.length) {
                claim.drops = drops.map(drop => ({ x: drop.x, y: drop.y,
                    items: JSON.parse(JSON.stringify(drop.items)) }));
            }
            return claim;
        });
    };

    // The view (mapview.buildRoom) reports the new room's prop AABBs once
    // its geometry is placed; movement clamps against them from then on.
    world.setRoomColliders = function (list) {
        // A late map load invalidates a committed path, never its visible
        // endpoint alone. Cancel before publishing new solids; do not teleport
        // a charging unit or let it silently slide outside its warning.
        world.enemies.forEach(function (enemy) {
            if (enemy.action) { cancelEnemyAction(enemy); }
        });
        world.roomColliders = (list || []).map(function (c) {
            return { x: c.x, y: c.y, hw: c.hw, hh: c.hh };
        });
        // T22g: the room's interactables are solid too. Appended here (not
        // in enterRoom) because this call is what rebuilds the collider list
        // each room; breakBarrel splices its own collider out directly so a
        // shattered barrel stops blocking mid-room.
        world.barrels.forEach(function (b) {
            if (!b.broken) {
                world.roomColliders.push({ x: b.x, y: b.y, hw: 0.4, hh: 0.4 });
            }
        });
        if (world.chest) {
            world.roomColliders.push({ x: world.chest.x, y: world.chest.y, hw: 0.55, hh: 0.55 });
        }
        if (world.floorShrine) {
            const s = world.floorShrine;
            world.roomColliders.push({ x: s.x, y: s.y, hw: s.hw, hh: s.hh });
        }
    };

    world.enterRoom = function (roomId, fromSide) {
        const room = world.dungeon.rooms.find(function (r) { return r.id === roomId; });
        if (!room) {
            return;
        }
        // Direct callers (setDungeon boot, gate drivers) bypass the staged
        // crossing — any half-armed transition is stale the moment the room
        // actually changes.
        world.transition = null;
        const from = world.roomId;
        const previous = world.roomState.get(from);
        if (previous?.visited) { previous.drops = world.drops; }
        world.roomId = roomId;
        const size = roomSize(room);
        world.width = size.w;
        world.height = size.h;
        // logic-layer enemies are per-room; views reload on the "room" event
        world.enemies.forEach(function (enemy) { cancelEnemyAction(enemy); });
        world.enemies = [];
        world.enemyActionCursor = 0;
        // The statue is a world-owned solid from room entry, even before its
        // view arrives. Static scenery replaces only the previous room's data.
        world.floorShrine = floorShrineFor(room);
        world.roomColliders = world.floorShrine ? [{ x: world.floorShrine.x, y: world.floorShrine.y,
            hw: world.floorShrine.hw, hh: world.floorShrine.hh }] : [];
        // A boss's last spiral must not follow the player through the door.
        world.danmaku.clear();
        // Room views are rebuilt, but the room's unclaimed loot keeps its identity.
        const state = world.roomState.get(roomId);
        world.drops = state.drops;
        // T22g interactable handles are per-room like the loot.
        world.chest = null;
        world.barrels = [];
        world.altar = null;
        world.npc = null;

        const firstVisit = !state.visited;
        state.visited = true;

        // spawn this room's enemies on first visit (cleared rooms stay empty)
        if (firstVisit && !state.cleared && room.enemies.length) {
            spawnRoomEnemies(room);
        }

        // land the player just inside the door they came through
        const p = world.player;
        if (p) {
            p.actionBuffer = null;
            const at = doorEntry(fromSide, world.width, world.height);
            p.x = at.x;
            p.y = at.y;
            p.sm.set("idle");
            clearPlayerEffects(p);
        }

        world.events.push({ type: "room", from: from, to: roomId, room: room, firstVisit: firstVisit });
        if (firstVisit && room.type === "boss" && !state.cleared) {
            world.events.push({ type: "bossRoom", room: room });
        }
        // T22g 交互丰富: per-room interactables. Each room's set is authored
        // ONCE off its own seed and parked on roomState, so re-entry rebinds
        // the same chest / barrels / altar / npc with their opened/broken/
        // used/talked flags intact. The chest room no longer auto-spills its
        // roll on entry (that was the pre-T22g behaviour) — the player walks
        // up and opens it, and the roll happens then.
        if (room.type === "chest" && !state.chest) {
            state.chest = {
                x: world.width / 2,
                y: world.height / 2 - 2.5,
                opened: !!state.claims.chestOpened
            };
        }
        if (room.type === "chest") {
            world.chest = state.chest;
        }
        if (room.type === "battle") {
            if (!state.altar) {
                state.altar = rollAltar(room);
                if (state.altar) { state.altar.used = !!state.claims.altarUsed; }
            }
            world.altar = state.altar;
            if (!state.barrels) {
                state.barrels = rollBarrels(roomId);
                state.barrels.forEach(function (barrel) {
                    barrel.broken = (state.claims.barrels || []).includes(barrel.id);
                });
            }
            world.barrels = state.barrels;
        }
        if (room.type === "rest" && !state.npc) {
            state.npc = { ...restCampFor(room).npc, talked: !!state.claims.npcTalked };
        }
        if (room.type === "rest") {
            world.npc = state.npc;
        }
        if (firstVisit && room.type === "shop") {
            if (!state.offer) { state.offer = rollShopOffer(room); }
            world.events.push({ type: "shopOpen", room: room, offer: state.offer });
        }
        if (firstVisit && room.type === "rest") {
            world.events.push({ type: "restOpen", room: room });
        }
        world.drops.forEach(drop => {
            drop.offered = false;
            world.events.push({ type: 'drop', x: drop.x, y: drop.y, items: drop.items, drop });
        });
    };

    // --- roster: encounters.json rows -> live units ---------------------------

    // T22g 木桶: 2-3 per battle room off the room's own seed stream, kept
    // clear of the door corridors (a barrel in a doorway would wall the room
    // shut), of the altar when the room rolled one, and of each other.
    function rollBarrels(roomId) {
        const room = world.dungeon.rooms.find(function (r) { return r.id === roomId; });
        const rng = createRandom((room.seed ^ hash32("barrels")) >>> 0);
        const doors = doorsOf(world.dungeon, roomId).map(function (d) { return d.at; });
        const keepClear = doors.concat(world.altar ? [world.altar] : []);
        const slots = [];
        const count = BARREL_MIN_COUNT
            + Math.floor(rng() * (BARREL_MAX_COUNT - BARREL_MIN_COUNT + 1));
        for (let i = 0; i < count; i++) {
            for (let tries = 0; tries < 24; tries++) {
                const x = 2.8 + rng() * (world.width - 5.6);
                const y = 2.2 + rng() * (world.height - 4.4);
                const blocked = keepClear.some(function (spot) {
                    return Math.hypot(spot.x - x, spot.y - y) < 2.4;
                }) || slots.some(function (s) {
                    return Math.hypot(s.x - x, s.y - y) < 1.8;
                });
                if (!blocked) {
                    slots.push({ id: i, x: x, y: y, radius: BARREL_RADIUS, broken: false });
                    break;
                }
            }
        }
        return slots;
    }

    // T22g 祭坛: the event point some battle rooms roll (ALTAR_CHANCE). It
    // claims a corner — corners are inset from every door midpoint by
    // construction, so no door can ever be blocked by one.
    function rollAltar(room) {
        const rng = createRandom((room.seed ^ hash32("altar")) >>> 0);
        if (rng() >= ALTAR_CHANCE) {
            return null;
        }
        const corners = [
            { x: 3.2, y: 3.2 }, { x: world.width - 3.2, y: 3.2 },
            { x: 3.2, y: world.height - 3.2 }, { x: world.width - 3.2, y: world.height - 3.2 }
        ];
        const spot = corners[Math.floor(rng() * corners.length)];
        spot.used = false;
        return spot;
    }

    function radiusFor(shadowScale) {
        const r = (shadowScale || 2.5) * RADIUS_PER_SHADOW;
        return clamp(r, RADIUS_MIN, RADIUS_MAX);
    }

    // The segment rung (spec/04 §5/§6): in a 20-layer volume the enemy level
    // steps up once per 生态段 — enc.level on floors 1-5, +1 on 6-10, +2 on
    // 11-15, +3 on 16-20. It is the ONLY difficulty dial a segment gets; no
    // new coefficients are invented here. Single-floor worlds (fixtures,
    // legacy gates) keep enc.level untouched.
    function encounterLevel() {
        const base = (world.encounter && world.encounter.level) || 1;
        if (world.floorsPerVolume <= 1) { return base; }
        const seg = Math.min(3, Math.floor((world.floor - 1) * 4 / world.floorsPerVolume));
        return base + seg;
    }

    // 段级敌人池 (spec/02 §3.3): a multi-floor volume draws its mobs from the
    // current 生态段's own pool, keyed on the same rung encounterLevel uses.
    // Everything else — single-floor fixtures, a segment with an empty pool,
    // an encounter authored before mobSegments existed — falls back to the
    // flat union, so the legacy readers never see a thinner world.
    function segmentMobs() {
        const enc = world.encounter;
        if (!enc || world.floorsPerVolume <= 1 || !enc.mobSegments) {
            return enc ? (enc.mobs || []) : [];
        }
        const seg = Math.min(3, Math.floor((world.floor - 1) * 4 / world.floorsPerVolume));
        const pool = enc.mobSegments[Math.min(seg, enc.mobSegments.length - 1)];
        if (pool && pool.length) {
            return pool;
        }
        return enc.mobs || [];
    }

    // One encounters.json row plus a level -> a live enemy. Measurements use
    // this real room entry too, not a second copy of the scaling rules.
    function spawnFromSpec(spec, level, x, y, roomId) {
        const table = world.tables.stats;
        const skills = world.tables.skills;
        const grown = table ? table.enemyStats(spec.id, level) : null;
        // hpScale is the authored per-boss dial in encounters.json (spec/04 §5);
        // mobs ship without one.
        const hp = grown ? Math.max(1, Math.round(grown.hp * (spec.hpScale || 1))) : 5;
        return world.spawnEnemy({
            enemyId: spec.id,
            name: spec.name, nameZh: spec.nameZh,
            model: spec.model,
            shadowScale: spec.shadowScale,
            voiceCueSheet: spec.voiceCueSheet,
            x: x, y: y,
            radius: radiusFor(spec.shadowScale),
            hp: hp,
            atk: grown ? grown.atk : undefined,
            mgc: grown ? grown.mgc : undefined,
            def: grown ? grown.def : undefined,
            mdef: grown ? grown.mdef : undefined,
            spd: grown ? grown.spd : undefined,
            luck: grown ? grown.luck : undefined,
            element: spec.element,
            aiType: spec.aiType,
            elite: !!spec.elite,
            moveset: skills ? enemyMoveset(skills, spec.skills) : null,
            turnSeconds: skills ? skills.turnSeconds : undefined,
            room: roomId
        });
    }

    // Who is in this room. How many and where is dungeon.js's, seeded from the
    // floor; the *identities* are rolled here from a stream keyed on the room's
    // own seed, so adding this stage did not move a single door -- the
    // byte-identical layout gate in tools/rl_dungeon_harness.mjs still holds.
    function spawnRoomEnemies(room) {
        const enc = world.encounter;
        if (!enc) {
            // No tables: stage-2's literals, which the stage-1 gates assert.
            room.enemies.forEach(function (slot) {
                world.spawnEnemy({
                    x: slot.x, y: slot.y,
                    hp: slot.kind === "boss" ? 25 : 5,
                    atk: slot.kind === "boss" ? 2 : 1,
                    radius: slot.kind === "boss" ? 0.8 : 0.5,
                    aiType: slot.kind,
                    room: room.id
                });
            });
            return;
        }
        const rng = createRandom(hash32("roster:" + room.seed));
        const mobs = segmentMobs();
        const elites = enc.elites || [];
        const level = encounterLevel();
        // Floors 1..N-1 of a multi-floor volume put a 層守衛 in the boss room
        // instead of the volume boss: an elite row from this volume's pool,
        // rolled on the room's own roster stream. Elites ship elite:true, so
        // spawnEnemy kinds them "enemy" — no boss bar, no phase machine, no
        // volume-end chain. The final floor's boss room is the only true boss.
        const finalFloor = world.floorsPerVolume <= 1 || world.floor >= world.floorsPerVolume;
        const specs = room.enemies.map(function (slot) {
            if (slot.kind === "boss") {
                if (!finalFloor && elites.length) {
                    return elites[(rng() * elites.length) | 0];
                }
                return enc.boss;
            }
            return mobs.length ? mobs[(rng() * mobs.length) | 0] : null;
        });
        // One placement in a battle room may come up an elite instead: the same
        // roll, on the same slot, that rl_balance_harness.mjs's mobGroup makes.
        if (specs.length && elites.length && specs[0] && specs[0] !== enc.boss
            && rng() < ELITE_CHANCE) {
            specs[0] = elites[(rng() * elites.length) | 0];
        }
        room.enemies.forEach(function (slot, i) {
            if (specs[i]) {
                spawnFromSpec(specs[i], level, slot.x, slot.y, room.id);
            }
        });
    }

    // Floor-entry model warmup list (consumed by loader.warmModels): every
    // manifest key a room of this floor can roll — the segment's mob pool,
    // the elite rows, and the volume boss. Pure data, no loading here; the
    // view layer decides what to do with it. Table-less fixtures return [].
    world.floorEnemyModels = function () {
        const enc = world.encounter;
        if (!enc) { return []; }
        const seen = new Set();
        const out = [];
        segmentMobs().concat(enc.elites || [], [enc.boss]).forEach(function (spec) {
            const key = spec && spec.model;
            if (typeof key === "string" && key && !seen.has(key)) {
                seen.add(key);
                out.push(key);
            }
        });
        return out;
    };

    // enemyai.js calls this when a boss phase flips (updatePhase). The world
    // decides whether it can honour it: a boss room outside a loaded encounter
    // has nobody to call, and the cap keeps the adds a beat rather than a
    // second fight. Modelled at the same thresholds in rl_balance_harness.mjs.
    //
    // This is also the path plan §2.1's 分裂型 would arrive on -- an enemy that
    // splits on death is one spawnFromSpec call from here. It is not in this
    // stage because encounters.json has no field that says which rows split,
    // and inventing one would be authoring content in the engine; the data comes
    // from tools/build_rl_data.py in 阶段 8.
    world.requestSummon = function (boss, phase) {
        const enc = world.encounter;
        const summonPool = segmentMobs();
        if (!enc || !summonPool.length || !world.roomId) {
            return 0;
        }
        const alive = world.enemies.filter(function (e) {
            return e.summoned && !e.dead;
        }).length;
        const budget = Math.min(SUMMON_PER_PHASE, SUMMON_MAX - alive);
        let made = 0;
        for (let i = 0; i < budget; i++) {
            const spec = summonPool[(world.rng() * summonPool.length) | 0];
            const angle = world.rng() * Math.PI * 2;
            const unit = spawnFromSpec(spec, encounterLevel(),
                clamp(boss.x + Math.cos(angle) * SUMMON_RING, 1.5, world.width - 1.5),
                clamp(boss.y + Math.sin(angle) * SUMMON_RING, 1.5, world.height - 1.5),
                world.roomId);
            unit.summoned = true;
            made += 1;
        }
        if (made > 0) {
            world.events.push({ type: "summon", unit: boss, phase: phase, count: made });
        }
        return made;
    };

    // --- room transitions -----------------------------------------------------

    function tryTransition(p) {
        if (world.roomLocked) {
            return;
        }
        const doors = doorsOf(world.dungeon, world.roomId);
        for (let i = 0; i < doors.length; i++) {
            const door = doors[i];
            let crossing = false;
            if (door.side === "N" && p.y <= p.radius && Math.abs(p.x - door.at.x) <= DOOR_BAND) { crossing = true; }
            if (door.side === "S" && p.y >= world.height - p.radius && Math.abs(p.x - door.at.x) <= DOOR_BAND) { crossing = true; }
            if (door.side === "W" && p.x <= p.radius && Math.abs(p.y - door.at.y) <= DOOR_BAND) { crossing = true; }
            if (door.side === "E" && p.x >= world.width - p.radius && Math.abs(p.y - door.at.y) <= DOOR_BAND) { crossing = true; }
            if (crossing) {
                if (world.transition) {
                    return;
                }
                // entering room `door.to` through its wall opposite to door.side
                const opposite = { N: "S", S: "N", W: "E", E: "W" }[door.side];
                // T21d: the swap is staged under a fade instead of happening
                // this tick — see the transition branch in update().
                world.transition = { t: 0, to: door.to, fromSide: opposite };
                world.events.push({ type: "door", to: door.to, side: door.side });
                return;
            }
        }
    }

    // --- player ----------------------------------------------------------------

    // Committed enemy areas share bullets' no-random-crit rule and the same
    // hit funnel. Reject stale room owners rather than accepting late damage.
    world.hitPlayerFrom = function (attacker, skill, extra) {
        const p = world.player;
        if (!p || p.dead || p.sm.state === "dead" || !attacker || attacker.dead
                || attacker.sm.state === "dead" || attacker.stunTimer > 0
                || !skill || !world.enemies.includes(attacker)) {
            return { hit: false, damage: 0, died: false };
        }
        const result = tryHit(p, attackFrom(attacker, p, skill, { rng: world.rng, crit: false }));
        if (result.hit) { pushHit(attacker, p, result, skill, extra); }
        return result;
    };

    // Every world-owned damage path ends here, which is what lets creditGauge
    // fill the とっておき gauge from the event queue instead of from six call
    // sites. `extra` marks where the hit came from for the view (contact,
    // bullet) without giving each source its own event type.
    function pushHit(attacker, target, result, skill, extra) {
        // 踏みとどまり (spec/04 §4.2 type 11): tryHit has already applied the
        // fatal hit; surviving rewrites the outcome before anyone — events,
        // gauge credit, the death settlement — can see it.
        if (target.kind === "player" && result.died && maybeSurvive(target)) {
            result.died = false;
        }
        if (target.kind === "player" && result.died) {
            clearPlayerEffects(target);
        }
        const ev = {
            type: "hit",
            attacker: attacker,
            target: target,
            damage: result.damage,
            died: result.died,
            crit: !!result.crit,
            hitFlag: result.hitFlag || 0,
            skill: skill || null
        };
        if (extra) {
            Object.assign(ev, extra);
        }
        // Effects may load after movement, knockback or pool reuse. Keep only
        // a value snapshot, with a centre fallback for non-projectile hits.
        const impact = ev.impact || target;
        ev.impact = { x: impact.x, y: impact.y };
        world.events.push(ev);
        if (result.playerStatus && result.playerStatus.action !== "miss") {
            world.events.push({ type: "playerStatus", unit: target, ...result.playerStatus });
        }
        for (const reset of result.statResets || []) {
            world.events.push({ type: "statReset", unit: target, ...reset });
        }
        // The stun gauge fills from the same funnel (spec/04 §11): every hit
        // an enemy takes is gauge, whatever dealt it -- melee, skill, bullet.
        buildStun(attacker, target, result);
        if (target.dead && target.kind !== "player") { cancelEnemyAction(target); }
        // Weapon passives (spec/04 §4.2) hang off the same funnel; every
        // hook below is inert without the matching affix.
        if (target.kind === "player" && result.hit) {
            onPlayerHitTaken(target);
        }
        if (attacker && attacker.kind === "player" && result.hit
                && !attacker.dead && target.kind !== "player") {
            onPlayerDealtDamage(attacker, result);
        }
        // Kill drops (spec/04 §4, plan 阶段 4): every non-summon death rolls
        // the drop table on the battle's own rng stream, so replaying a seed
        // replays the loot. Summoned units are hp fodder, not loot pins.
        if (ev.died && target.kind !== "player" && !target.summoned) {
            const source = target.kind === 'boss' ? 'boss'
                : target.elite ? world.room?.type === 'boss' ? 'guardian' : 'elite' : 'enemy';
            rollDrops(target.x, target.y, attacker, source);
            grantKillRewards(target, attacker);
            if (attacker && attacker.kind === "player"
                    && attacker.passives.killStack) {
                attacker.stackKills = (attacker.stackKills || 0) + 1;
                reapplyEquipment(attacker);
            }
        }
        return ev;
    }

    // 「1回だけHPが1残り、全回復」: one charge per floor (survivalUsed resets
    // in setDungeon). The full heal is the row's own args [0,100].
    function maybeSurvive(p) {
        const rt = p.passives;
        if (!rt || rt.survival <= (p.survivalUsed || 0)) {
            return false;
        }
        p.survivalUsed += 1;
        p.dead = false;
        p.hp = p.maxHp;
        p.iframes = Math.max(p.iframes, PLAYER_TIMING.hitInvuln);
        // tryHit already entered the terminal "dead" state; `set` cannot
        // leave it, so the revive goes through the machine's escape hatch.
        p.sm.force("hit");
        world.events.push({ type: "survival", unit: p });
        return true;
    }

    function onPlayerHitTaken(p) {
        const rt = p.passives;
        if (!rt) {
            return;
        }
        if (rt.hitStack) {
            p.stackHits = (p.stackHits || 0) + 1;
            reapplyEquipment(p);
        }
        if (rt.debuffOnHit && rt.debuffOnHit.turns) {
            const seconds = rt.debuffOnHit.turns
                * (world.tables.skills ? world.tables.skills.turnSeconds || 2.8 : 2.8);
            world.enemies.forEach(function (e) {
                if (e.dead) { return; }
                if (!e.debuffs) { e.debuffs = []; }
                let entry = null;
                for (let i = 0; i < e.debuffs.length; i++) {
                    if (e.debuffs[i].tag === "weapon14") {
                        entry = e.debuffs[i];
                        break;
                    }
                }
                if (entry) {
                    entry.remaining = seconds;
                } else {
                    e.debuffs.push({
                        tag: "weapon14",
                        atk: rt.debuffOnHit.atk,
                        mgc: rt.debuffOnHit.mgc,
                        remaining: seconds
                    });
                }
            });
        }
    }

    function onPlayerDealtDamage(p, result) {
        const rt = p.passives;
        if (!rt || !rt.lifesteal || !result.damage) {
            return;
        }
        if (!allowCombatHealing(p)) { return; }
        const healed = Math.max(1, Math.round(result.damage * rt.lifesteal));
        const before = p.hp;
        p.hp = Math.min(healCeiling(p), p.hp + healed);
        if (p.hp > before) {
            world.events.push({
                type: "heal", unit: p, amount: p.hp - before, skill: null
            });
        }
    }

    // Gauge math for one landed hit. Rate depends on the row the enemy was
    // spawned from (boss rows barely fill, spec/04 §11's STUN_RATE), and the
    // advantage/crit bonuses mean the element ring is the accelerator. The
    // weapon passives' stun-fill rows (spec/04 §4.2 type 4) multiply the
    // player's contribution.
    function buildStun(attacker, target, result) {
        if (target.kind === "player" || target.dead || !result.hit) {
            return;
        }
        target.stunIdle = 0;
        const rate = target.kind === "boss" ? STUN_RATE.boss
            : (target.elite ? STUN_RATE.elite : STUN_RATE.enemy);
        let gain = STUN_BASE;
        if (result.hitFlag === 1) {
            gain += STUN_ADVANTAGE_BONUS;
        }
        if (result.crit) {
            gain += STUN_CRIT_BONUS;
        }
        if (attacker && attacker.kind === "player" && attacker.passives) {
            gain *= attacker.passives.stunFill;
        }
        target.stun += gain * rate;
        if (target.stun >= STUN_MAX && target.stunTimer <= 0) {
            target.stun = 0;
            target.stunTimer = STUN_DURATION;
            // Cancel authored commitments, not just their current animation.
            // Legacy bosses retain their old timer/skip behaviour.
            cancelEnemyAction(target);
            target.sm.set("damage");
            world.events.push({
                type: "stun", unit: target,
                x: target.x, y: target.y,
                duration: STUN_DURATION
            });
        }
    }

    // One roll per kill/chest; guaranteed sources skip only the empty outcome.
    // No reward is generated by roomClear or by re-entering a completed room.
    function rollDrops(x, y, killer, source) {
        const luck = (killer && killer.luck) || 0;
        const card = world.player && world.player.card;
        const items = rollLoot(world.rng, world.floor, luck, card, { source });
        if (!items.length) {
            return;
        }
        const entry = { x: x, y: y, items: items };
        world.drops.push(entry);
        world.events.push({ type: "drop", x: x, y: y, items: items, drop: entry });
    }

    // --- progression (spec/04 §10) -------------------------------------------

    // Re-derive `base` from the current level's truth curve plus the live
    // equipment. Called on every equip and every level-up; because it starts
    // from the truth table every time it has the same no-residue property
    // applyEquipment itself has. maxHp gains are handed to hp one-for-one so
    // a heavier breastplate is never a net heal-then-clip.
    function reapplyEquipment(p) {
        let truth = p.truthBase;
        if (p.card && world.tables.stats) {
            truth = world.tables.stats.statsFor(p.card.id, p.level);
        }
        p.truthBase = truth;
        p.weaponProfile = weaponProfile(p.card, p.equipment);
        p.gadgets = gadgetRuntime(p.equipment);
        if (p.gadgets.assist < 2) assistance.disable();
        const loadout = calculateLoadout(truth, p.equipment, p);
        const stats = loadout.stats;
        p.passives = loadout.passives;
        p.critDamage = p.passives.critDamage;
        const health = healthForLoadout(p, loadout);
        p.base = stats;
        p.critBonus = equipmentMultipliers(p.equipment, p.card).crit;
        p.maxHp = health.maxHp;
        p.hp = health.hp;
        if (p.skills && p.skills.applyWeapon) {
            const buffered = p.actionBuffer?.kind === 'skill' ? p.actionBuffer.slot : null;
            const bufferedId = buffered === null ? null : p.skills.slots[buffered]?.id;
            p.skills.applyWeapon(p.passives, p.weaponProfile.classId);
            p.skills.applyGadgets(p.gadgets);
            if (buffered !== null && (p.skills.isSealed(buffered)
                    || p.skills.slots[buffered]?.id !== bufferedId)) p.actionBuffer = null;
        }
    }

    function healthForLoadout(p, loadout) {
        const maxHp = p.hpOverride !== undefined ? p.hpOverride : Math.max(1, Math.round(loadout.stats.hp));
        const hp = maxHp > p.maxHp ? Math.min(maxHp, p.hp + maxHp - p.maxHp) : p.hp;
        return { maxHp, hp: Math.min(hp, Math.round(maxHp * (1 + (loadout.passives.overheal || 0)))) };
    }

    // Heal ceiling (spec/04 §4.2 type 9): オーバーヒール raises the cap
    // heals may fill to, without touching maxHp itself — the HUD bar and
    // every percent-of-maxHp effect still read the true maximum.
    function healCeiling(p) {
        const over = p.passives ? p.passives.overheal : 0;
        return Math.round(p.maxHp * (1 + (over || 0)));
    }

    // Candidate only. Pickup and purchase persist it before publishing any
    // resource, health or equipment mutation. Callers validate the item first.
    function equipmentState(p, item) {
        const equipment = p.equipment.slice(), index = equipment.findIndex(row => row.slot === item.slot);
        if (index < 0) equipment.push(item); else equipment[index] = item;
        const health = healthForLoadout(p, calculateLoadout(p.truthBase, equipment, p));
        return { equipment, hp: health.hp };
    }

    world.previewEquipment = function (item) {
        const p = world.player;
        if (!p || p.dead) { return null; }
        const preview = previewEquipment(p.truthBase, p.equipment, item, p);
        if (preview && p.skills && world.tables.skills) {
            const next = [...p.equipment.filter(row => row.slot !== item.slot), item];
            const skills = createSkills({ table: world.tables.skills, card: p.card, maxHp: p.maxHp });
            skills.applyWeapon(passiveRuntime(next), preview.style.candidate.classId);
            skills.applyGadgets(gadgetRuntime(next));
            skills.slots.forEach((slot, index) => { slot.remaining = p.skills.slots[index]?.remaining || 0; });
            preview.skills = { current: p.skills.describeLoadout(), candidate: skills.describeLoadout() };
            // Equipment does not clear temporary recovery buffs. The inherited
            // cooldown has the same live recovery estimate on both sides.
            preview.skills.candidate.cooldownSeconds = preview.skills.current.cooldownSeconds.slice();
            preview.skillNames = { current: preview.skills.current.slots.map(slot => slot.name),
                candidate: preview.skills.candidate.slots.map(slot => slot.name) };
        }
        return preview;
    };

    world.takeDrop = function (entry, item, persist) {
        const p = world.player;
        if (!p || p.dead || world.transition || world.drops.indexOf(entry) < 0
                || entry.items.indexOf(item) < 0
                || Math.hypot(p.x - entry.x, p.y - entry.y) > PICKUP_RADIUS) { return false; }
        if (!world.previewEquipment(item)) { return false; }
        const next = equipmentState(p, item);
        const claims = world.getRoomClaims(), claim = claims.find(row => row.id === world.roomId);
        if (claim && (claim.cleared || claim.chestOpened)) {
            const remaining = world.drops.map(drop => ({ x: drop.x, y: drop.y,
                items: drop === entry ? drop.items.filter(row => row !== item) : drop.items.slice() }))
                .filter(drop => drop.items.length);
            if (remaining.length) claim.drops = remaining; else delete claim.drops;
        }
        try {
            if (persist && persist({ ...next, roomClaims: claims }) !== true) { return false; }
        } catch (_) { return false; }
        p.equipment = next.equipment;
        assistance.disable();
        reapplyEquipment(p);
        if (p.skills) { refreshPlayer(p); }
        entry.items.splice(entry.items.indexOf(item), 1);
        if (!entry.items.length) { world.drops.splice(world.drops.indexOf(entry), 1); }
        entry.offered = false;
        world.events.push({ type: "pickup", items: [item], drop: entry,
            exhausted: !entry.items.length, x: entry.x, y: entry.y });
        return true;
    };

    // Offer once on approach. Leaving the radius re-arms a declined drop.
    function updateDrops() {
        const p = world.player;
        if (!p || p.dead || world.transition) {
            return;
        }
        for (let i = world.drops.length - 1; i >= 0; i--) {
            const entry = world.drops[i];
            if (Math.hypot(p.x - entry.x, p.y - entry.y) > PICKUP_RADIUS) {
                entry.offered = false;
                continue;
            }
            if (entry.offered || !entry.items.length) { continue; }
            entry.offered = true;
            world.events.push({ type: "lootOffer", drop: entry });
            return;
        }
    }

    function levelUp(p) {
        p.exp -= p.expNext;
        p.level += 1;
        p.expNext = expToNext(p.level);
        reapplyEquipment(p);
        const before = p.hp;
        p.hp = Math.min(healCeiling(p), p.hp + Math.round(p.maxHp * LEVELUP_HEAL_FRACTION));
        world.events.push({
            type: "levelup", unit: p, level: p.level, healed: p.hp - before
        });
    }

    // Kill rewards ride the same "died" branch that rolls loot. Fixture
    // worlds (no card) still earn coin -- the shop math has to be testable
    // without the growth curves -- but level growth needs the truth table,
    // because statsFor is what a level means.
    function grantKillRewards(target, killer) {
        const kind = target.kind === "boss" ? "boss"
            : (target.elite ? "elite" : "enemy");
        const coin = COIN_PER_KILL[kind];
        world.coin += coin;
        // T22j: the coin is otherwise silent — the receipt sprite is the
        // feedback the original gives when マニー pops out of a kill.
        world.events.push({
            type: "coinGain", x: target.x, y: target.y, amount: coin
        });
        const p = world.player;
        if (p && killer === p && p.card && world.tables.stats) {
            p.exp += EXP_PER_KILL[kind];
            while (p.exp >= p.expNext) {
                levelUp(p);
            }
        }
    }

    // Separate lanes: native weapon, affix gear, named mechanic. The room seed
    // owns stock; revisits and saves retain the original entries and prices.
    function rollShopOffer(room) {
        const rng = createRandom(hash32("shop:" + room.seed));
        const luck = (world.player && world.player.luck) || 0;
        const offer = [];
        for (let i = 0; i < SHOP_ITEM_COUNT; i++) {
            const card = world.player && world.player.card;
            const options = { source: 'shop', slot: i === 0 ? 'weapon'
                : i === 1 ? ['amulet', 'armor', 'charm'][Math.floor(rng() * 3)] : undefined, weaponFloor: world.floor };
            const item = i === 2 ? rollGadget(rng, 'shop', world.floor)
                : rollLoot(rng, world.floor + 1, luck, card, options)[0] || null;
            const gadget = gadgetDefinition(item);
            offer.push({
                item: item,
                price: gadget ? gadget.price : item ? SHOP_PRICES[item.rarity] : 0,
                bought: false
            });
        }
        return offer;
    }

    world.getShopOffer = function () {
        const room = world.room;
        if (!room || room.type !== "shop") {
            return null;
        }
        const state = world.roomState.get(room.id);
        return (state && state.offer) || null;
    };

    world.getShopQuote = function (index, expectedItem) {
        const offer = world.getShopOffer();
        if (!offer || !Number.isInteger(index) || index < 0 || index >= offer.length) {
            return null;
        }
        const entry = offer[index];
        const p = world.player;
        if (!entry || !entry.item || !p) return null;
        const preview = world.previewEquipment(entry.item);
        const reason = p.dead || world.transition ? '当前不能购买'
            : entry.bought ? '已售'
            : expectedItem && entry.item !== expectedItem ? '商品已变化'
            : !preview ? '不可装备'
            : p.equipment.some(item => sameGadgetEffect(item, entry.item)) ? '已装备同一机制，无需重复购买'
            : !Number.isSafeInteger(entry.price) || entry.price < 0 ? '价格无效'
            : world.coin < entry.price ? '金币不足' : '';
        return { item: entry.item, price: entry.price, preview, enabled: !reason, reason };
    };

    world.buyShopItem = function (index, expectedItem, persist) {
        const quote = world.getShopQuote(index, expectedItem);
        if (!quote?.enabled) return null;
        const entry = world.getShopOffer()[index], p = world.player;
        const next = equipmentState(p, entry.item), claims = world.getRoomClaims();
        const claim = claims.find(row => row.id === world.roomId);
        claim.offer[index].bought = true;
        const coin = world.coin - entry.price;
        try {
            if (persist && persist({ ...next, coin, roomClaims: claims }) !== true) return null;
        } catch (_) { return null; }
        p.equipment = next.equipment;
        assistance.disable();
        reapplyEquipment(p);
        if (p.skills) refreshPlayer(p);
        world.coin = coin;
        entry.bought = true;
        world.events.push({
            type: "purchase", item: entry.item, price: entry.price, index: index
        });
        return entry.item;
    };

    // T22g 木桶: pay the authored loot table and drop the collider. The roll
    // rides the run stream (like rollDrops) so a retry re-rolls; `broken`
    // lives on the roomState record, so re-entry shows a shattered room.
    function breakBarrel(barrel, p) {
        barrel.broken = true;
        world.roomColliders = world.roomColliders.filter(function (c) {
            return c.x !== barrel.x || c.y !== barrel.y;
        });
        const roll = world.rng();
        let loot;
        if (roll < BARREL_LOOT.coin) {
            loot = {
                kind: "coin",
                amount: BARREL_LOOT.coinMin + Math.floor(
                    world.rng() * (BARREL_LOOT.coinMax - BARREL_LOOT.coinMin + 1))
            };
            world.coin += loot.amount;
        } else if (roll < BARREL_LOOT.coin + BARREL_LOOT.heal) {
            const before = p.hp;
            p.hp = Math.min(healCeiling(p),
                p.hp + Math.max(1, Math.round(p.maxHp * BARREL_LOOT.healFraction)));
            loot = { kind: "heal", amount: p.hp - before };
        } else {
            loot = { kind: "none" };
        }
        world.events.push({ type: "barrelBreak", x: barrel.x, y: barrel.y, loot: loot });
    }

    // T22g 宝箱: opening pays the guaranteed roll the chest room used to
    // auto-spill on entry — same loot stream, same guaranteed-non-empty rule,
    // but the player walks up and presses E first. One-shot per room.
    world.openChest = function () {
        const room = world.room;
        const p = world.player;
        if (!room || room.type !== "chest" || !world.chest || !p || p.dead) {
            return null;
        }
        if (world.chest.opened) {
            return null;
        }
        world.chest.opened = true;      // the roomState record — persists
        rollDrops(world.chest.x, world.chest.y, p, 'chest');
        world.events.push({
            type: "chestOpen", room: room, x: world.chest.x, y: world.chest.y
        });
        return true;
    };

    world.getAltarOffer = function () {
        const p = world.player, room = world.room;
        if (!p || p.dead || !room || !world.altar || world.roomLocked || world.transition) { return null; }
        return { roomId: room.id, used: world.altar.used, title: '星石契约',
            text: '书册摊在灯火之间。星光不替你决定，只将每一条道路的代价写清。',
            options: quoteEventChoices(altarEventChoices(room.seed, p.maxHp, healCeiling(p) - p.hp, world.floor)) };
    };

    // An explicit choice replaces the former unpreviewable random reward.
    world.useAltar = function (choice, roomId, persist) {
        return commitRoomEvent('altar', choice, roomId, persist);
    };

    // T22g NPC: the campfire guest. Talking heals (the rest mechanic fires
    // once per room through restHeal) and the presenter plays the guest's
    // line; `first` tells the view side introduction vs small talk.
    world.talkNpc = function () {
        const room = world.room;
        const p = world.player;
        if (!room || room.type !== "rest" || !world.npc || !p || p.dead) {
            return null;
        }
        const first = !world.npc.talked;
        world.npc.talked = true;        // the roomState record — persists
        const healed = 0;
        world.events.push({
            type: "npcTalk", room: room, x: world.npc.x, y: world.npc.y,
            first: first, healed: healed
        });
        return { first: first, healed: healed };
    };

    world.getSupplyOffer = function () {
        const p = world.player, room = world.room;
        if (!p || p.dead || !room || room.type !== "rest") { return null; }
        const state = world.roomState.get(room.id);
        const offer = {
            roomId: room.id, used: !!state.rested,
            heal: Math.min(Math.max(0, healCeiling(p) - p.hp), Math.round(p.maxHp * REST_HEAL_FRACTION)),
            gauge: p.skills ? Math.min(p.skills.gaugeMax - p.skills.gauge, Math.round(p.skills.gaugeMax * 0.35)) : 0
        };
        return { ...offer, title: '旅人营地 · 一次整备',
            text: '旅人把热茶、星光和修好的旧机关放在身边。补充资源，还是改变作战方式？这次停留只够完成一件事。',
            options: quoteEventChoices(restEventChoices(room.seed, offer.heal, offer.gauge, world.floor)) };
    };

    function quoteEventChoices(choices) {
        const p = world.player;
        return choices.map(option => {
            const preview = option.item ? world.previewEquipment(option.item) : null;
            const equipment = option.item ? [...p.equipment.filter(item => item.slot !== option.item.slot), option.item] : p.equipment.slice();
            const health = option.item && preview ? healthForLoadout(p, calculateLoadout(p.truthBase, equipment, p)) : { hp: p.hp };
            const hp = health.hp + (option.heal || 0) - (option.hpCost || 0);
            const gauge = (p.skills?.gauge || 0) + (option.gauge || 0);
            const coin = world.coin - (option.coinCost || 0);
            const reason = option.item && !preview ? '装备数据不可用'
                : option.minFloor > world.floor ? '第 ' + option.minFloor + ' 层起开放此机关'
                : option.item && p.equipment.some(item => sameGadgetEffect(item, option.item)) ? '已装备同一机制，品质不改变效果'
                : hp < 1 ? '生命不足，不能以致死代价立约'
                : coin < 0 ? '金币不足'
                : !option.item && !(option.heal > 0 || option.gauge > 0) ? '当前无需补充此资源' : '';
            return { ...option, ...gadgetTerms(option.item, preview?.skillNames?.candidate),
                preview, enabled: !reason, reason, result: { hp, gauge, coin, equipment } };
        });
    }

    function commitRoomEvent(kind, choice, roomId, persist) {
        const offer = kind === 'altar' ? world.getAltarOffer() : world.getSupplyOffer();
        if (!offer || offer.used || offer.roomId !== roomId || world.transition) { return null; }
        const option = offer.options.find(row => row.id === choice);
        if (!option?.enabled) { return null; }
        const p = world.player, claims = world.getRoomClaims();
        const claim = claims.find(row => row.id === roomId);
        if (kind === 'altar') claim.altarUsed = true;
        else { claim.rested = true; claim.supply = choice; if (world.npc) claim.npcTalked = true; }
        // Synchronous persistence is an injected gate, not world-owned storage.
        // A refused/throwing write leaves resources, equipment, flags and RNG untouched.
        const patch = { ...option.result, roomClaims: claims };
        try { if (persist && persist(patch) !== true) { return null; } } catch (_) { return null; }
        if (option.item) {
            p.equipment = option.result.equipment;
            assistance.disable();
            reapplyEquipment(p);
            if (p.skills) refreshPlayer(p);
        }
        p.hp = option.result.hp;
        if (p.skills) p.skills.addGauge(option.result.gauge - p.skills.gauge);
        world.coin = option.result.coin;
        if (kind === 'altar') world.altar.used = true;
        else { const state = world.roomState.get(roomId); state.rested = true; state.supply = choice; }
        const outcome = { kind: option.item ? 'equipment' : choice === 'gauge' ? 'gauge' : 'heal',
            amount: option.heal || option.gauge || 0, item: option.item, label: option.label };
        const result = { type: kind === 'altar' ? 'altarUse' : 'supply', choice, amount: outcome.amount,
            label: option.label, item: option.item, outcome, unit: p, room: world.room,
            x: kind === 'altar' ? world.altar.x : p.x, y: kind === 'altar' ? world.altar.y : p.y };
        world.events.push(result);
        return result;
    }

    world.chooseSupply = function (choice, roomId, persist) {
        return commitRoomEvent('supply', choice, roomId, persist);
    };

    world.restHeal = function () {
        const room = world.room;
        const p = world.player;
        if (!room || room.type !== "rest" || !p || p.dead) {
            return 0;
        }
        const state = world.roomState.get(room.id);
        if (!state || state.rested) {
            return 0;
        }
        state.rested = true;
        const before = p.hp;
        p.hp += Math.min(Math.max(0, healCeiling(p) - p.hp), Math.round(p.maxHp * REST_HEAL_FRACTION));
        const healed = p.hp - before;
        world.events.push({ type: "rest", unit: p, healed: healed, room: room });
        return healed;
    };

    function clearPlayerEffects(p) {
        clearPlayerStatus(p);
        clearSkillCards(p);
        clearNextCritical(p);
        p.swingCritical = false;
        p.swingRecastSkill = null;
        p.nextAtkBonus = 0;
        p.swingBonusMult = null;
        p.regen = null;
        if (p.skills) {
            p.skills.clearEffects();
            refreshPlayer(p);
        }
    }

    // A cast costs the same commitment as a swing: the player enters the attack
    // state (its 0.38 s is the action unit rl_balance_harness.mjs models -- one
    // action per STEP, a slot *instead of* a hit) with the melee window
    // suppressed. PLAYER_STATES has no cast state and the anchor table
    // (view/actorview.js) has no cast clip, so the view plays the swing; 阶段 8
    // owns the presentation. Returns false when the slot is still cooling.
    function castSkill(p, index) {
        const slot = p.skills.use(index, (reset, changed) => reportStatReset(p, reset, changed));
        if (!slot) {
            return false;
        }
        if ((slot.statResets || []).some(reset => [0, 3, 4].includes(reset.target))) refreshPlayer(p);
        // Same aim rule as the swing (T22k): an aimed shot tracks the cursor.
        const aimFacing = aimFacingFor(p);
        if (slot.delivery === "aimed" && aimFacing !== null) {
            p.facing = aimFacing;
        }
        p.sm.set("attack");
        p.castOnly = true;
        p.castSlot = index;
        p.swingId += 1;
        p.swingHits = null;
        applyPlayerStatuses(p, slot);
        let healBlocked = false;
        if (slot.heal > 0) {
            const before = p.hp;
            healBlocked = !allowCombatHealing(p);
            if (!healBlocked) p.hp = Math.min(healCeiling(p), p.hp + Math.round(p.maxHp * slot.heal));
            world.events.push({
                type: "heal", unit: p, amount: p.hp - before, skill: slot
            });
        }
        // T22n per-character design: the decompiled effect kinds beyond the
        // base six, folded into rogue-legible behaviour.
        if (slot.regen && slot.regen.pct > 0) {
            p.regen = {
                pct: slot.regen.pct,
                turnsLeft: slot.regen.turns,
                elapsed: 0
            };
        }
        if (slot.nextAtk > 0) {
            // NextAttackUp (kind 11): pending bonus consumed by the next swing
            // (see the melee window — one consumption, shared across every
            // target that swing reaches; a whiff keeps it pending).
            p.nextAtkBonus = Math.max(p.nextAtkBonus || 0, slot.nextAtk);
            world.events.push({ type: "nextAtkUp", unit: p, pct: slot.nextAtk });
        }
        if (slot.resists && slot.resists.target !== 0
                && slot.resists.target !== 3 && slot.resists.target !== 4) {
            // kind 8 on an enemy target (T25). Damaging rows carry it on their
            // bullets (fireSkill); a row with no damage applies directly:
            // all enemies for target 2, the nearest for target 1.
            if (!slot.damage) {
                applyResistToEnemies(p, slot.resists);
            }
        }
        (slot.statEffects || []).forEach(function (effect) {
            const target = (effect.reset || effect.buff).target;
            if (!slot.damage && (target === 1 || target === 2)) {
                forEnemyTarget(p, target, function (e) {
                    applyStatOperation(e, effect, slot.id);
                });
            }
        });
        if (slot.slow && slot.slow.pct > 0 && !slot.damage) {
            // kind 4 with no damage of its own (T25): the shipped 减速 rows
            // are pure spells, so the slow lands on the cast's target
            // directly — the same aim fold applyResists uses.
            const slowSeconds = slotSlowSeconds(slot);
            forEnemyTarget(p, slot.slow.target, function (e) {
                applySlow(e, slot.slow.pct, slowSeconds);
            });
        }
        // Keep the existing one-delivery ordinary skill. Critical grants retain
        // their position around that first damage entry, not tooltip order.
        const firstDamage = (slot.effects || []).findIndex(effect => effect.kind === 0);
        for (const grant of slot.nextCriticals || []) {
            if (!slot.damage || grant.index < firstDamage) grantPlayerCritical(p, slot.id);
        }
        if (slot.damage) {
            fireSkill(p, slot);
        }
        for (const grant of slot.nextCriticals || []) {
            if (slot.damage && grant.index > firstDamage) grantPlayerCritical(p, slot.id);
        }
        installPlayerCards(p, slot, index);
        world.events.push({ type: "skill", unit: p, slot: index, skill: slot, healBlocked: healBlocked });
        return true;
    }

    function grantPlayerCritical(p, skillId) {
        const action = grantNextCritical(p);
        if (action) world.events.push({ type: "nextCritical", unit: p, action, skillId });
    }

    function consumePlayerCritical(p, skillId) {
        const used = consumeNextCritical(p);
        if (used) world.events.push({ type: "nextCritical", unit: p, action: "used", skillId });
        return used;
    }

    function cardEvent(p, entry, action) {
        world.events.push({ type: "skillCard", unit: p, action, cardId: entry.card.id,
            instance: entry.id, trigger: entry.triggers, sourceSlot: entry.sourceSlot,
            sourceSkillId: entry.sourceSkillId, name: entry.card.name,
            remaining: entry.remaining, next: entry.next });
    }

    function installPlayerCards(p, slot, sourceSlot) {
        for (const placement of slot.cardPlacements || []) {
            const result = placeSkillCard(p, sourceSlot, slot.id, placement, turnSeconds());
            if (result) cardEvent(p, result.entry, result.action);
        }
    }

    function triggerPlayerCard(p, entry) {
        if (world.player !== p || p.dead || entry.ownerId !== p.id) return;
        cardEvent(p, entry, "triggered");
        const alive = world.enemies.filter(enemy => !enemy.dead);
        // Autonomous single-target cards select at trigger time, not at the
        // original cast's cursor position. Keep one target for all child effects.
        const nearest = selectEnemyTarget(p, alive, null);
        for (const effect of entry.card.effects) {
            if (effect.heal > 0) {
                const before = p.hp;
                if (allowCombatHealing(p)) {
                    p.hp += Math.min(Math.max(0, healCeiling(p) - p.hp), Math.round(p.maxHp * effect.heal));
                }
                world.events.push({ type: "heal", unit: p, amount: p.hp - before,
                    skill: null, skillCard: entry.card.id });
            }
            if (effect.barrier) p.skills.applySelf(effect);
            if (!effect.damage) continue;
            const targets = effect.target === 2 ? alive : (nearest ? [nearest] : []);
            for (const target of targets) {
                if (target.dead) continue;
                const result = tryHit(target, attackFrom(p, target, effect, { rng: world.rng }));
                if (result.hit) pushHit(p, target, result, effect, { skillCard: entry.card.id,
                    cardInstance: entry.id, cardTrigger: entry.triggers });
            }
        }
    }

    function allowCombatHealing(p) {
        if (!healingLocked(p)) { return true; }
        world.events.push({ type: "playerStatus", unit: p, action: "healBlocked" });
        return false;
    }

    function applyPlayerStatuses(p, slot) {
        for (const effect of slot.statusEffects || []) {
            if (![0, 3, 4].includes(effect.target)) { continue; }
            let result = null;
            if (effect.kind === 4) {
                result = applyHealingLock(p, effect.chance, effect.turns * turnSeconds(), world.rng);
            } else if (effect.kind === 5) {
                result = cleanseHealingLock(p);
            } else if (effect.kind === 6) {
                result = grantHealingLockImmunity(p, effect.turns * turnSeconds());
            }
            if (result && result.action !== "miss") {
                world.events.push({ type: "playerStatus", unit: p, ...result });
            }
        }
    }

    // --- T25 skill riders: slow / element resist --------------------------------
    // Enemy-side carrier: unit.resists = [{ element, pct, remaining }],
    // decayed in updateEnemy next to the type-14 debuffs. Refresh keeps the
    // stronger pct on that element and resets the clock — ordering-invariant.
    function turnSeconds() {
        return (world.tables && world.tables.skills && world.tables.skills.turnSeconds)
            || 2.8;
    }

    function slotSlowSeconds(slot) {
        return (slot.slow.turns || 1) * turnSeconds();
    }

    function applyResists(unit, by, seconds) {
        if (unit.dead) { return; }
        if (!unit.resists) { unit.resists = []; }
        Object.keys(by).forEach(function (e) {
            const element = +e;
            let entry = null;
            for (let i = 0; i < unit.resists.length; i++) {
                if (unit.resists[i].element === element
                        && Math.sign(unit.resists[i].pct) === Math.sign(by[e])) {
                    entry = unit.resists[i]; break;
                }
            }
            if (!entry) {
                unit.resists.push({ element: element, pct: by[e], remaining: seconds });
            } else {
                entry.pct = Math.abs(by[e]) > Math.abs(entry.pct) ? by[e] : entry.pct;
                entry.remaining = Math.max(entry.remaining, seconds);
            }
            world.events.push({
                type: "resist", unit: unit, element: element,
                pct: sumResists(unit, element), seconds: seconds
            });
        });
    }

    function reportStatReset(unit, reset, changed) {
        world.events.push({ type: "statReset", unit, mode: reset.mode, stats: reset.stats, changed });
    }

    function applyStatOperation(enemy, effect, skillId, index = effect.index) {
        if (enemy.dead) return;
        if (effect.reset) {
            reportStatReset(enemy, effect.reset, resetStatChanges(enemy.debuffs, effect.reset));
        } else {
            applyStatEffect(enemy, effect.buff, skillId, index);
        }
    }

    function applyStatEffect(enemy, buff, skillId, index) {
        if (enemy.dead) { return; }
        if (!enemy.debuffs) { enemy.debuffs = []; }
        const tag = "skill:" + skillId + ":" + index;
        let entry = enemy.debuffs.find(function (b) { return b.tag === tag; });
        if (!entry) {
            entry = { tag: tag };
            enemy.debuffs.push(entry);
        }
        Object.assign(entry, buff, { remaining: (buff.turns || 1) * turnSeconds() });
        world.events.push({ type: "statChange", unit: enemy, buff: buff });
    }

    function forEnemyTarget(p, target, apply) {
        if (target === 2) {
            world.enemies.forEach(function (e) { if (!e.dead) { apply(e); } });
            return;
        }
        if (target !== 1) { return; }
        const best = selectEnemyTarget(p, world.enemies, world.aim);
        if (best) { apply(best); }
    }

    // kind 8 with an enemy target and no damage of its own: the original's
    // 单押/全体 rows. Aim folds "one enemy" to the NEAREST living enemy (the
    // aimed-shot's own rule), 全体 to every living enemy.
    function applyResistToEnemies(p, resists) {
        const seconds = (resists.turns || 1) * turnSeconds();
        forEnemyTarget(p, resists.target, function (e) {
            applyResists(e, resists.by, seconds);
        });
    }

    // kind 4 slow: duration is the documented two-turn adapter; pct uses the
    // rank resistance ladder so 减速 never locks a boss (spec/08 §2.1).
    function applySlow(enemy, pct, seconds) {
        if (!enemy || enemy.dead) { return; }
        const resist = enemy.elite ? SLOW_RESIST.elite
            : (enemy.aiType === "boss" ? SLOW_RESIST.boss : SLOW_RESIST.enemy);
        const eff = Math.min(0.8, pct * (1 - resist));
        if (eff <= 0) { return; }
        if (!enemy.slow) {
            enemy.slow = { pct: eff, remaining: seconds };
        } else {
            enemy.slow.pct = Math.max(enemy.slow.pct, eff);
            enemy.slow.remaining = Math.max(enemy.slow.remaining, seconds);
        }
        world.events.push({ type: "slow", unit: enemy, pct: enemy.slow.pct });
    }

    // Delivery comes from the original row's own target field (skills.js
    // deliveryFor): single-enemy is an aimed shot, all-enemies a ring around the
    // player. Counts and speeds are danmaku.js's defaults on purpose -- the
    // player's shots must not need numbers of their own. The bullet snapshots
    // the *buffed* offence, since refreshPlayer has already run this tick.
    function fireNormal(p) {
        const profile = p.swingProfile || p.weaponProfile, skill = p.skills.normal;
        const rules = p.swingGadgets || p.gadgets;
        const made = world.danmaku.emit("aimed", { x: p.x, y: p.y, angle: p.facing }, {
            side: "player", element: p.element, srcId: p.id, skillId: skill.id,
            forceCritical: p.nextCritical === true,
            noCrit: rules.noCrit, noAdvantage: rules.noAdvantage,
            power: skill.magic ? p.mgc : p.atk, coef: skill.coef * (p.swingGadgets?.normalDamage || 1), magic: skill.magic,
            critChance: critChanceFor(p.luck, p.critBonus, 0), critDamage: p.critDamage,
            weakElementBonus: p.skills.weakElementBonus,
            speed: profile.speed, life: profile.range / profile.speed, radius: profile.radius,
            pierce: profile.pierce || 0, blastRadius: profile.blast || 0,
            slow: profile.slow || 0, slowSeconds: 1.6, normalContext: p.swingContext
        });
        if (made > 0) {
            consumePlayerCritical(p, skill.id);
            p.skills.applyRecast(p.swingRecastSkill);
        }
        world.events.push({ type: "playerShot", unit: p, skill, pattern: "aimed", bullets: made, normal: true });
    }

    function fireSkill(p, slot) {
        const mods = {
            side: "player",
            forceCritical: p.nextCritical === true,
            noCrit: p.gadgets.noCrit, noAdvantage: p.gadgets.noAdvantage,
            element: p.element,
            power: slot.magic ? p.mgc : p.atk,
            coef: slot.coef,
            magic: slot.magic,
            critChance: critChanceFor(p.luck, p.critBonus, 0),
            critDamage: p.critDamage,
            weakElementBonus: p.skills.weakElementBonus,
            srcId: p.id,
            skillId: slot.id
        };
        // T25 riders: kind 4 slow and enemy-target kind 8 resist travel with
        // the cast's bullets and land on whoever they hit (world.onBulletHit).
        if (slot.slow && slot.slow.pct > 0) {
            mods.slow = slot.slow.pct;
            mods.slowSeconds = slotSlowSeconds(slot);
        }
        mods.statEffects = (slot.statEffects || []).filter(function (effect) {
            const target = (effect.reset || effect.buff).target;
            return target === 1 || target === 2;
        });
        if (slot.resists && slot.resists.target !== 0
                && slot.resists.target !== 3 && slot.resists.target !== 4) {
            mods.resistEffect = {
                by: slot.resists.by,
                seconds: (slot.resists.turns || 1) * turnSeconds()
            };
        }
        const pattern = slot.delivery === "ring" ? "ring" : "aimed";
        const made = world.danmaku.emit(
            pattern, { x: p.x, y: p.y, angle: p.facing }, mods);
        if (made > 0) consumePlayerCritical(p, slot.id);
        world.events.push({
            type: "playerShot", unit: p, skill: slot,
            pattern: pattern, bullets: made
        });
        return made;
    }

    // T22k 攻击方向: the swing/aimed-shot facing. Mouse aim wins when the
    // pointer is live and not directly on the player (a zero-length aim is
    // meaningless); otherwise null — the caller keeps movement/last facing.
    // Priority: aim > movement direction > last facing.
    function aimFacingFor(p) {
        const aim = world.aim;
        if (!aim) {
            const move = world.inputState && world.inputState.move;
            return move && Math.hypot(move.x, move.y) > 0.05 ? Math.atan2(move.y, move.x) : null;
        }
        const dx = aim.x - p.x;
        const dy = aim.y - p.y;
        if (Math.hypot(dx, dy) < 0.05) {
            return null;
        }
        return Math.atan2(dy, dx);
    }

    // Buffer edges through recovery and hit-stop; menus clear rather than queue
    // actions. Held basic attack still repeats, held dodge/skills never do.
    function captureAction(p, dt) {
        if (p.actionBuffer) {
            p.actionBuffer.remaining -= dt;
            if (p.actionBuffer.remaining < 0) { p.actionBuffer = null; }
        }
        const input = world.inputState || {};
        let slot = -1;
        for (let i = 0; i < p.heldSkill.length; i++) {
            const down = !!(input.skill && input.skill[i]);
            if (down && !p.heldSkill[i] && slot < 0 && !p.skills?.isSealed(i)) { slot = i; }
            p.heldSkill[i] = down;
        }
        let intent = null;
        if (input.dodge && !p.heldDodge) { intent = { kind: "dodge" }; }
        else if ((input.ultimate && !p.heldUltimate)
                || (slot === 0 && p.skills && p.skills.ultimate)) { intent = { kind: "ultimate" }; }
        else if (slot >= 0) { intent = { kind: "skill", slot: slot }; }
        else if (input.attack && !p.heldAttack) { intent = { kind: "attack" }; }
        p.heldDodge = !!input.dodge;
        p.heldUltimate = !!input.ultimate;
        p.heldAttack = !!input.attack;
        if (intent) { p.actionBuffer = Object.assign(intent, { remaining: PLAYER_TIMING.inputBuffer }); }
    }

    function updatePlayer(dt) {
        const p = world.player;
        if (!p || p.sm.state === "dead") {
            return;
        }
        p.iframes = Math.max(0, p.iframes - dt);

        const input = world.inputState;
        const assisted = assistance.update(world, input, dt);
        const move = assisted?.move || (input ? input.move : { x: 0, y: 0 });
        const before = p.sm.state;

        captureAction(p, dt);
        const intent = p.actionBuffer;
        const actionable = before === "idle" || before === "move";
        const cancel = before === "attack" && p.sm.stateTime >= PLAYER_TIMING.dodgeCancel
            && intent && intent.kind === "dodge";

        if (input && (actionable || cancel)) {
            if (intent && intent.kind === "dodge") {
                const len = Math.hypot(move.x, move.y);
                if (len > 0) {
                    p.dodgeDir.x = move.x / len;
                    p.dodgeDir.y = move.y / len;
                } else {
                    p.dodgeDir.x = Math.cos(p.facing);
                    p.dodgeDir.y = Math.sin(p.facing);
                }
                p.sm.set("dodge");
                p.iframes = Math.max(p.iframes, PLAYER_TIMING.dodgeIframes);
                world.events.push({ type: "dodge", unit: p });
                p.actionBuffer = null;
            } else if (intent && intent.kind === "ultimate") {
                requestUltimate(p);
                p.actionBuffer = null;
            } else if (intent && intent.kind === "skill") {
                if (p.skills && castSkill(p, intent.slot)) { p.actionBuffer = null; }
            } else if ((intent && intent.kind === "attack") || input.attack || assisted?.attack) {
                // T22k 攻击方向: with a mouse the swing tracks the cursor
                // (aim > movement); keyboard-only keeps facing where the
                // player walks, or the last facing when standing still.
                const aimFacing = assisted?.target ? Math.atan2(assisted.target.y - p.y, assisted.target.x - p.x) : aimFacingFor(p);
                if (aimFacing !== null) {
                    p.facing = aimFacing;
                }
                p.sm.set("attack");
                p.swingId += 1;
                p.swingHits = null;      // allocated when the hit window opens
                p.swingBonusMult = null; // captured on this swing's first contact
                p.swingContext = { bonus: null, classId: p.weaponProfile.classId };
                p.swingCritical = false; // committed when this attack actually opens
                p.castOnly = false;
                p.castSlot = -1;
                p.swingGadgets = p.gadgets;
                p.swingProfile = p.weaponProfile;
                p.swingRecastSkill = p.skills?.normal || null;
                world.events.push({ type: "swing", unit: p });
                if (p.skills?.normal) installPlayerCards(p, p.skills.normal, NORMAL_CARD_SOURCE);
                p.actionBuffer = null;
            }
        }

        // A touch drag can choose the first swing during wind-up, without a
        // preparatory movement. Once its hit window opens, the arc stays locked.
        if (p.sm.state === "attack" && !p.castOnly && !p.swingHits && input?.aimStick?.active) {
            const facing = aimFacingFor(p);
            if (facing !== null) { p.facing = facing; }
        }
        p.sm.update(dt * (p.sm.state === 'attack' && !p.castOnly ? p.swingGadgets?.rate || 1 : 1));
        const state = p.sm.state;

        // --- movement ------------------------------------------------------
        let vx = 0;
        let vy = 0;
        if (state === "dodge") {
            vx = p.dodgeDir.x * p.speed * PLAYER_TIMING.dodgeSpeedMult;
            vy = p.dodgeDir.y * p.speed * PLAYER_TIMING.dodgeSpeedMult;
        } else if (state === "idle" || state === "move") {
            const len = Math.hypot(move.x, move.y);
            if (len > 0) {
                const nx = move.x / len;
                const ny = move.y / len;
                const amount = assisted?.move ? Math.min(1, len) : 1;
                vx = nx * p.speed * amount;
                vy = ny * p.speed * amount;
                p.facing = Math.atan2(ny, nx);
                if (p.sm.state !== "move") { p.sm.set("move"); }
            } else {
                if (p.sm.state !== "idle") { p.sm.set("idle"); }
            }
        }

        // Strafe only during a normal swing. Do not rotate a committed hit arc,
        // turn a skill into a moving cast, or bypass hit/death/dodge states.
        if (state === 'attack' && !p.castOnly && p.swingGadgets?.attackMove > 0) {
            const len = Math.hypot(move.x, move.y);
            if (len > 0) {
                vx = move.x / len * p.speed * p.swingGadgets.attackMove;
                vy = move.y / len * p.speed * p.swingGadgets.attackMove;
            }
        }

        // raw next position, clamped by walls with gaps at open doors
        let nx = p.x + vx * dt;
        let ny = p.y + vy * dt;
        if (world.dungeon) {
            const clamped = clampRoom(p, nx, ny);
            nx = clamped.x;
            ny = clamped.y;
        } else {
            const clamped = moveCircle(p, nx - p.x, ny - p.y, world.roomColliders, {
                minX: p.radius, maxX: world.width - p.radius,
                minY: p.radius, maxY: world.height - p.radius
            });
            nx = clamped.x; ny = clamped.y;
        }
        p.x = nx;
        p.y = ny;

        // did the player slip through a door opening?
        if (world.dungeon) {
            tryTransition(p);
        }

        // --- melee hit window ----------------------------------------------
        // A cast borrows the swing's commitment but not its blade (castSkill).
        if (state === "attack" && !p.castOnly) {
            const t = p.sm.stateTime;
            const inWindow = t >= PLAYER_TIMING.attackHitStart && t <= PLAYER_TIMING.attackHitEnd;
            if (inWindow && !p.swingHits) {
                p.swingHits = new Set();
                world.events.push({ type: "swingActive", unit: p, swingId: p.swingId });
                if ((p.swingProfile || p.weaponProfile).kind === "projectile" && p.skills) { fireNormal(p); }
                else {
                    p.swingCritical = consumePlayerCritical(p, p.skills?.normal?.id || 0);
                    p.skills?.applyRecast(p.swingRecastSkill);
                }
            }
            if (inWindow && p.swingHits) {
                world.enemies.forEach(function (enemy) {
                    if (enemy.dead || p.swingHits.has(enemy.id)) {
                        return;
                    }
                    if (inWeaponReach(p, enemy, p.swingProfile || p.weaponProfile)) {
                        p.swingHits.add(enemy.id);
                        // With a card the swing is the class's 通常攻撃 row
                        // through the full formula (element, crit, TEMPO);
                        // without one it is stage 1's bare atk, which is what
                        // rl_combat_harness.mjs measures the hit window with.
                        // NextAttackUp (kind 11, T25 口径): ONE consumption per
                        // swing — the first contact captures the pending bonus
                        // into this swing, and every target the same swing
                        // reaches gets it (fixes T22n's first-target-only
                        // consumption). A whiff makes no contact, so the bonus
                        // stays pending; skill bullets and the ultimate are
                        // not attacks and never consume it.
                        let skill = p.skills ? p.skills.normal : null;
                        const firstContact = p.swingBonusMult === undefined || p.swingBonusMult === null;
                        const bonusMult = firstContact ? 1 + (p.nextAtkBonus || 0) : p.swingBonusMult;
                        if (bonusMult !== 1) {
                            skill = Object.assign({}, skill || { coef: 1 },
                                { coef: (skill ? skill.coef : 1) * bonusMult });
                        }
                        const normalDamage = p.swingGadgets?.normalDamage || 1;
                        if (skill && normalDamage !== 1) skill = { ...skill, coef: skill.coef * normalDamage };
                        const result = skill
                            ? tryHit(enemy, attackFrom(p, enemy, skill, { rng: world.rng,
                                forceCritical: p.swingCritical, gadgets: p.swingGadgets }))
                            : tryHit(enemy, p.atk * normalDamage);
                        if (result.hit) {
                            if (firstContact) {
                                p.swingBonusMult = bonusMult;
                                p.nextAtkBonus = 0;
                            }
                            // Knockback is the swing's feel and only the swing's:
                            // a 12-bullet ring applying the same impulse each
                            // would shove an enemy across the room (§7).
                            applyKnockback(enemy, p.x, p.y);
                            pushHit(p, enemy, result, skill);
                        }
                    }
                });
                // T22g 木桶: the same swing shatters barrels in the arc. A
                // barrel is not an enemy — no damage roll, just the break —
                // but it rides the swing's dedupe set so one swing breaks a
                // given barrel exactly once.
                world.barrels.forEach(function (barrel) {
                    if (barrel.broken || p.swingHits.has("barrel" + barrel.id)) {
                        return;
                    }
                    if (inMeleeArc(p, barrel, PLAYER_TIMING.attackRange,
                            PLAYER_TIMING.attackArc)) {
                        p.swingHits.add("barrel" + barrel.id);
                        breakBarrel(barrel, p);
                    }
                });
            }
        }
    }

    // Wall clamp with door openings: the boundary holds except in the band
    // around a door this room actually has (and that isn't locked). Doors
    // sit at wall midpoints (dungeon.js doorAt), so the bands are centered.
    function clampRoom(p, nx, ny) {
        const doors = world.roomLocked ? [] : doorsOf(world.dungeon, world.roomId);
        const has = function (side) {
            return doors.some(function (door) { return door.side === side; });
        };
        const inBandX = Math.abs(nx - world.width / 2) <= DOOR_BAND;
        const inBandY = Math.abs(ny - world.height / 2) <= DOOR_BAND;
        let x = clamp(nx, p.radius, world.width - p.radius);
        let y = clamp(ny, p.radius, world.height - p.radius);
        if (has("W") && nx < p.radius && inBandY) { x = nx; }
        if (has("E") && nx > world.width - p.radius && inBandY) { x = nx; }
        if (has("N") && ny < p.radius && inBandX) { y = ny; }
        if (has("S") && ny > world.height - p.radius && inBandX) { y = ny; }

        return moveCircle(p, x - p.x, y - p.y, world.roomColliders, {
            minX: has("W") && inBandY ? -ENTRY_OFFSET : p.radius,
            maxX: has("E") && inBandY ? world.width + ENTRY_OFFSET : world.width - p.radius,
            minY: has("N") && inBandX ? -ENTRY_OFFSET : p.radius,
            maxY: has("S") && inBandX ? world.height + ENTRY_OFFSET : world.height - p.radius
        });
    }

    // Room clear detection lives in update(), not in the damage path, so any
    // way of clearing a room (swings, future bullets, future effects) is
    // covered and the flag can never be missed.
    function checkRoomClear() {
        const room = world.room;
        if (!room || (room.type !== "battle" && room.type !== "boss")) {
            return;
        }
        const state = world.roomState.get(room.id);
        if (!state || state.cleared) {
            return;
        }
        // a room that never spawned enemies (guaranteed not to happen for
        // battle/boss by the generator, but be safe) has nothing to clear
        if (!world.enemies.length) {
            return;
        }
        if (!world.enemies.some(function (e) { return !e.dead; })) {
            state.cleared = true;
            world.events.push({ type: "roomClear", room: room });
            if (room.type === "boss") {
                world.events.push({ type: "floorClear", room: room });
            }
        }
    }

    // The page accepts one request, then presents the already committed result.
    function requestUltimate(p) {
        world.events.push({
            type: "ultimate", unit: p,
            ready: !!(p.skills && p.skills.ultimateReady),
            handled: false
        });
    }

    world.previewUltimate = function () {
        return ultimatePreview(world.player, world.enemies, world.aim);
    };

    world.useUltimate = function () {
        const p = world.player;
        if (!p || p.dead || world.frozen || !p.skills || !p.skills.ultimateReady
                || (p.sm.state !== "idle" && p.sm.state !== "move")) {
            return false;
        }
        const slot = p.skills.ultimate;
        const effects = slot.effects.map(function (effect) {
            return decodeSkill({ effects: [effect], target: effect.target,
                coef: effect.kind === 0 ? effect.args[0] / 1000 : 0,
                magic: effect.kind === 0 && !!effect.args[1] }, slot.id, 0.35, world.tables.skills?.skillCards);
        });
        const alive = world.enemies.filter(function (e) { return !e.dead; });
        if (!effects.some(function (effect) {
            return effect.usable && (alive.length || [0, 3, 4].includes(effect.target));
        }) || !p.skills.spendUltimate()) { return false; }
        // Lock the original single target for every sub-effect. A kill must not
        // move the rest of the same skill to a second enemy.
        const preview = world.previewUltimate();
        const nearest = preview.target;
        world.events.push({ type: "ultimateSpent", unit: p, skill: slot, targeting: preview.description,
            targetIds: preview.targets.map(target => target.id) });
        let forceCritical = false; // all damage segments of this committed command share it
        const gadgets = p.gadgets;
        effects.forEach(function (effect, index) {
            const targets = effect.target === 2 ? alive
                : (effect.target === 1 && nearest ? [nearest] : []);
            p.skills.applySelf(effect, (reset, changed) => reportStatReset(p, reset, changed));
            applyPlayerStatuses(p, effect);
            installPlayerCards(p, effect, 0);
            refreshPlayer(p);
            if ([0, 3, 4].includes(effect.target)) {
                if (effect.heal > 0) {
                    const before = p.hp;
                    if (allowCombatHealing(p)) {
                        p.hp = Math.min(healCeiling(p), p.hp + Math.round(p.maxHp * effect.heal));
                    }
                    world.events.push({ type: "heal", unit: p, amount: p.hp - before, skill: slot });
                }
                if (effect.regen) {
                    p.regen = { pct: effect.regen.pct, turnsLeft: effect.regen.turns, elapsed: 0 };
                }
                if (effect.nextAtk > 0) { p.nextAtkBonus = Math.max(p.nextAtkBonus || 0, effect.nextAtk); }
                for (const grant of effect.nextCriticals) grantPlayerCritical(p, slot.id);
            }
            if (effect.damage && targets.some(target => !target.dead)) {
                // Do not short-circuit: a new grant between two segments is
                // consumed by the latter even when the earlier one was forced.
                const used = consumePlayerCritical(p, slot.id);
                forceCritical = used || forceCritical;
            }
            targets.forEach(function (target) {
                if (target.dead) { return; }
                if (effect.damage) {
                    const result = tryHit(target, attackFrom(p, target, effect, { rng: world.rng, forceCritical, gadgets }));
                    if (result.hit) { pushHit(p, target, result, slot, { ultimate: true }); }
                }
                effect.statEffects.forEach(function (operation) { applyStatOperation(target, operation, slot.id, index); });
                if (effect.resists) { applyResists(target, effect.resists.by, effect.resists.turns * turnSeconds()); }
                if (effect.slow) { applySlow(target, effect.slow.pct, slotSlowSeconds(effect)); }
            });
        });
        p.castOnly = true;
        p.castSlot = 0;
        p.swingId += 1;
        p.sm.set("attack");
        checkRoomClear();
        return slot;
    };

    // spec/04 §8: the gauge fills from damage dealt *and* taken. Every damage
    // path ends in a "hit" event -- a swing, body contact, a bullet, a charger's
    // lunge raised inside enemyai.advanceDash -- so crediting from the slice of
    // the queue this tick appended counts each hit exactly once, with no second
    // call site to forget. `mark` is where the queue stood at the top of the
    // tick, because views drain it at their own cadence.
    function creditGauge(mark) {
        const p = world.player;
        if (!p || !p.skills) {
            return;
        }
        const rt = p.passives;
        for (let i = mark; i < world.events.length; i++) {
            const ev = world.events[i];
            if (ev.type === "hit" && !ev.ultimate && (ev.attacker === p || ev.target === p)) {
                p.skills.addGauge(ev.damage * (rt ? rt.gaugeMult : 1));
                // type 5 rows: a fixed fraction of the gauge ceiling per hit
                // taken, not proportional to the damage.
                if (ev.target === p && rt && rt.gaugeOnHit) {
                    p.skills.addGauge(p.skills.gaugeMax * rt.gaugeOnHit);
                }
            }
        }
    }

    // --- enemies -------------------------------------------------------------

    function updateEnemy(enemy, dt) {
        if (enemy.dead || enemy.sm.state === "dead") {
            cancelEnemyAction(enemy);
            return;
        }
        enemy.iframes = Math.max(0, enemy.iframes - dt);
        enemy.contactCooldown = Math.max(0, enemy.contactCooldown - dt);
        enemy.sm.update(dt);

        // Stun window (spec/04 §11): the enemy is out of the fight -- no
        // brain, no body contact. Timers and knockback still run so nothing
        // freezes in place mid-act when the stun lands.
        // Type-14 debuffs (被撃時全体デバフ) are timed atk/mgc multipliers
        // consumed by combat.attackFrom; refreshing the row re-arms the timer
        // rather than stacking a second copy.
        if (enemy.debuffs && enemy.debuffs.length) {
            for (let i = enemy.debuffs.length - 1; i >= 0; i--) {
                enemy.debuffs[i].remaining -= dt;
                if (enemy.debuffs[i].remaining <= 0) {
                    enemy.debuffs.splice(i, 1);
                }
            }
        }
        // T25 kind-4 slow (action-cadence multiplier in enemyai) and kind-8
        // element-resist entries: same refresh-not-stack discipline.
        if (enemy.slow) {
            enemy.slow.remaining -= dt;
            if (enemy.slow.remaining <= 0) {
                enemy.slow = null;
            }
        }
        if (enemy.resists && enemy.resists.length) {
            for (let i = enemy.resists.length - 1; i >= 0; i--) {
                enemy.resists[i].remaining -= dt;
                if (enemy.resists[i].remaining <= 0) {
                    enemy.resists.splice(i, 1);
                }
            }
        }
        // Stun suspends decisions, not the expiry of other timed effects.
        if (enemy.stunTimer > 0) {
            if (enemy.action) { cancelEnemyAction(enemy); }
            enemy.stunTimer = Math.max(0, enemy.stunTimer - dt);
            decayKnockback(enemy, dt, world);
            return;
        }
        // Preserve the existing gauge-decay rule outside the stun window.
        enemy.stunIdle += dt;
        if (enemy.stunIdle >= STUN_DECAY_DELAY && enemy.stun > 0) {
            enemy.stun = Math.max(0, enemy.stun - STUN_DECAY_PER_SEC * dt);
        }

        // The brain: hold position, telegraph, act (enemyai.js). It may raise
        // its own "hit" event -- a charger's lunge damages on the way through.
        enemyai(enemy, world, dt);
        // Enemies do not walk, so knockback is the only thing that moves them.
        decayKnockback(enemy, dt, world);

        const p = world.player;
        // Authored enemies only hurt through their warned areas: wind-up and
        // recovery really are safe for a close counterattack. Legacy lunges
        // also skip contact to avoid spending i-frames twice on one move.
        if (p && p.sm.state !== "dead" && !enemy.choreography && enemy.sm.state !== "dash") {
            const result = contactTouch(enemy, p, world.rng);
            if (result.hit) {
                pushHit(enemy, p, result, null, { contact: true });
            }
        }
    }

    // --- bullets ---------------------------------------------------------------

    function unitById(id) {
        if (!id) {
            return null;
        }
        if (world.player && world.player.id === id) {
            return world.player;
        }
        for (let i = 0; i < world.enemies.length; i++) {
            if (world.enemies[i].id === id) {
                return world.enemies[i];
            }
        }
        return null;
    }

    // A bullet carries its shooter's offence, snapshotted at emit time
    // (danmaku.js bulletFactory) -- the shooter may be dead by the time it
    // lands, which is exactly what makes a boss's last spiral still dangerous.
    // Damage still goes through the one formula, and through tryHit, so
    // i-frames and the barrier apply to a bullet like anything else.
    function onBulletHit(b, target, contact = null, fromBlast = false) {
        const source = unitById(b.srcId);
        const normal = b.normalContext;
        const bonus = normal ? (normal.bonus ?? (1 + (source && source.nextAtkBonus || 0))) : 1;
        const flag = elementFlag(b.element, target.element, b.noAdvantage);
        const result = tryHit(target, {
            atk: b.power, mgc: b.power,
            def: effectiveStat(target, "def"), mdef: effectiveStat(target, "mdef"),
            element: b.element, targetElement: target.element,
            weakElementBonus: b.weakElementBonus,
            noCrit: b.noCrit, noAdvantage: b.noAdvantage,
            healingLockChance: b.side === "enemy" ? b.healingLockChance : 0,
            healingLockSeconds: b.healingLockSeconds,
            hitStatResets: b.side === "enemy" ? b.hitStatResets : null,
            rng: world.rng,
            skill: { coef: b.coef * bonus, magic: b.magic },
            crit: rollCrit(flag === -1 ? 0 : b.critChance, world.rng, b.side === "player" && b.forceCritical, b.noCrit)
                ? CRIT_MULT + b.critDamage : false,
            tempo: b.side === "player" ? TEMPO : 1,
            // kind 8 resistance reads the LIVE entries, not a snapshot — the
            // debuff tracker's whole point is changing what later hits do.
            defenderResist: sumResists(target, b.element),
            hitFlag: flag
        });
        if (result.hit) {
            if (normal && normal.bonus === null) {
                normal.bonus = bonus;
                if (source) { source.nextAtkBonus = 0; }
            }
            // Riders land on contact only, alongside the damage (T25): the
            // cast's own hit does NOT see the resist it just applied — damage
            // above was already resolved. The next hit does.
            if (b.side === "player") {
                if (b.slow > 0) { applySlow(target, b.slow, b.slowSeconds || 1); }
                if (b.resistEffect) {
                    applyResists(target, b.resistEffect.by, b.resistEffect.seconds);
                }
                (b.statEffects || []).forEach(function (effect) {
                    applyStatOperation(target, effect, b.skillId);
                });
            }
            pushHit(source, target, result, null,
                { bullet: true, skillId: b.skillId, normal: !!normal, impact: contact });
            if (!fromBlast && b.side === "player" && b.blastRadius > 0) {
                for (const enemy of world.enemies) {
                    if (enemy !== target && !enemy.dead
                            && Math.hypot(enemy.x - target.x, enemy.y - target.y) <= b.blastRadius + enemy.radius) {
                        onBulletHit(b, enemy, null, true);
                    }
                }
                world.events.push({ type: "blast", x: target.x, y: target.y, radius: b.blastRadius, element: b.element });
            }
        }
    }

    // The held-key latches must keep tracking the keyboard while the world is
    // frozen (menu, shop, dialogue, とっておき): updatePlayer is skipped then,
    // and a key released during the freeze would stay latched down — the
    // press after the freeze ends would be swallowed as "already held".
    function latchInputEdges(p) {
        const input = world.inputState;
        if (!input || !p) {
            return;
        }
        for (let i = 0; i < p.heldSkill.length; i++) {
            p.heldSkill[i] = !!(input.skill && input.skill[i]);
        }
        p.heldUltimate = !!input.ultimate;
        p.heldDodge = !!input.dodge;
        p.heldAttack = !!input.attack;
        p.actionBuffer = null;
    }

    // 顿帧 merges like camera shake does: a longer freeze already in flight
    // is never shortened by a weaker hit landing inside it.
    world.applyHitStop = function (seconds) {
        if (seconds > world.hitStop) {
            world.hitStop = seconds;
        }
    };

    world.update = function (dt) {
        // Hit-stop freezes the simulation for a few frames so the landed hit
        // reads (T21b 打击感). The view layer keeps rendering — the shake and
        // the impact particles play through the freeze, which is the whole
        // point of the pairing. The input latches must keep tracking the
        // keyboard for the same reason the frozen branch does.
        if (world.hitStop > 0) {
            world.hitStop = Math.max(0, world.hitStop - dt);
            if (world.player) {
                if (world.frozen) { assistance.suspend(world.inputState); latchInputEdges(world.player); }
                else { captureAction(world.player, 0); }
            }
            return;
        }
        if (world.frozen) {
            assistance.suspend(world.inputState);
            if (world.player) {
                latchInputEdges(world.player);
            }
            return;
        }
        // Door transition (T21d): the room swap happens under a screen fade.
        // The walk keeps running — the player is mid-step into the doorway —
        // but enemies and bullets hold: losing HP under a fading screen is
        // not a read. Drops and room-clear still resolve, so a killing blow
        // landed on the way out still settles the room.
        if (world.transition) {
            const tr = world.transition;
            world.time += dt;
            const tp = world.player;
            if (tp && !tp.dead) { updatePlayerStatus(tp, dt); }
            if (tp && tp.skills) {
                tp.skills.update(dt);
                refreshPlayer(tp);
            }
            updatePlayer(dt);
            updateDrops();
            checkRoomClear();
            tr.t += dt;
            if (tr.t >= DOOR_FADE_OUT) {
                world.transition = null;
                world.enterRoom(tr.to, tr.fromSide);
            }
            return;
        }
        // Where the event queue stands now, so creditGauge can read back only
        // what this tick produced (views drain at their own cadence).
        const mark = world.events.length;
        world.time += dt;

        world.units.forEach(function (unit) {
            let previous = hitPositions.get(unit);
            if (!previous) { previous = {}; hitPositions.set(unit, previous); }
            previous.x = unit.x; previous.y = unit.y;
        });

        const p = world.player;
        if (p && p.dead) { clearPlayerEffects(p); }
        if (p && !p.dead) { updatePlayerStatus(p, dt); }
        if (p && !p.dead && p.skills) {
            // Cooldowns and buff timers first: a buff that expires this tick
            // must not still be multiplying the swing that happens in it.
            p.skills.update(dt);
            refreshPlayer(p);
            updateSkillCards(p, dt, entry => triggerPlayerCard(p, entry));
            if (p.regen) {
                const regen = p.regen;
                regen.elapsed += dt;
                while (regen.turnsLeft > 0 && regen.elapsed + 1e-9 >= p.skills.turnSeconds) {
                    regen.elapsed -= p.skills.turnSeconds;
                    regen.turnsLeft -= 1;
                    const before = p.hp;
                    // Recovery ticks do not trigger the weapon's over-heal
                    // passive, and must never clip HP already above maxHp.
                    if (allowCombatHealing(p)) {
                        p.hp += Math.min(Math.max(0, p.maxHp - p.hp), Math.round(p.maxHp * regen.pct));
                    }
                    if (p.hp > before) {
                        world.events.push({ type: "heal", unit: p, amount: p.hp - before, skill: null });
                    }
                }
                if (regen.turnsLeft <= 0) { p.regen = null; }
            }
        }
        updatePlayer(dt);
        // Pickups resolve after movement so the position the check reads is
        // the one the player actually occupies this tick.
        updateDrops();
        world.enemies.forEach(function (enemy) {
            updateEnemy(enemy, dt);
        });
        // Bullets move after the units that fired them, so a shot never
        // resolves against a position that is one frame stale.
        world.danmaku.update(dt, {
            width: world.width, height: world.height,
            player: world.player, enemies: world.enemies,
            previousPosition: function (unit) { return hitPositions.get(unit); },
            onHit: onBulletHit
        });
        // Charger lunges emit their hit inside enemyai. Finish cleanup in
        // this frame, before the page consumes death and freezes the world.
        if (p && p.dead) { clearPlayerEffects(p); }
        creditGauge(mark);
        checkRoomClear();
    };

    return world;
}
