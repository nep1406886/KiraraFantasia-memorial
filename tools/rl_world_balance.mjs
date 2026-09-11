// Deterministic measurements of the shipped world, not a second combat model.
// Assumptions and exclusions: docs/world-balance-measurement-design.md.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStats } from "../site/asset/rl/stats.js";
import { createWorld } from "../site/game/rl/world.js";
import { generateDungeon, doorsOf } from "../site/game/rl/dungeon.js";
import { PLAYABLE_IDS, PLAYABLE_ROSTER } from "../site/game/rl/rosterids.js";
import { DEFAULT_STEP } from "../site/game/rl/clock.js";
import { PLAYER_TIMING } from "../site/game/rl/actorstate.js";
import { hash32, createRandom } from "../site/game/rl/random.js";
import { hitStopFor } from "../site/game/rl/impact.js";
import { setAffixPool, rollLoot } from "../site/game/rl/loot.js";
import { setAffixTable, affixTableFromPassives } from "../site/game/rl/equipment.js";
import { setWeaponCatalog } from "../site/game/rl/weaponcatalog.js";
import { makeGadget, GADGET_IDS } from "../site/game/rl/gadgets.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TRAINING_TARGET = Object.freeze({ hp: 10000000, def: 200, mdef: 200, radius: .75 });
const MODES = ["training", "battle", "boss"];
const POLICIES = ["hold", "read", "idle"];
const ACTIONS = ["basic", "full"];
const LOADOUTS = ["none", "matching", "cross", "stage"];
let loaded = null;

export function loadMeasurementData() {
    if (loaded) { return loaded; }
    const json = name => JSON.parse(readFileSync(resolve(ROOT, "site/asset/rl", name), "utf8"));
    const cards = json("cards-rl.json"), skills = json("skills-rl.json");
    const weapons = json("weapons-rl.json");
    setAffixPool(Object.keys(weapons.passives), weapons.weapons.map(row => row.id));
    setAffixTable(affixTableFromPassives(weapons.passives));
    setWeaponCatalog(weapons.catalog);
    skills.weaponChildren = weapons.childSkills || {};
    loaded = {
        stats: createStats({ cards: cards.cards, growth: json("growth.json"), enemies: json("enemies.json").enemies }),
        skills, weapons: weapons.catalog, encounters: json("encounters.json").volumes
    };
    return loaded;
}

function integer(name, value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) { throw new Error("无效参数 " + name + ": " + value); }
    return value;
}
function choice(name, value, allowed) {
    if (!allowed.includes(value)) { throw new Error("无效参数 " + name + ": " + value); }
    return value;
}
function configFor(options) {
    const o = options || {};
    if (!PLAYABLE_IDS.includes(o.cardId)) { throw new Error("不在当前可玩名单中: " + o.cardId); }
    const seconds = o.seconds ?? 120;
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) { throw new Error("seconds 必须在 (0, 300] 内"); }
    return {
        cardId: o.cardId, volume: integer("volume", o.volume ?? 1, 1, 5),
        floor: integer("floor", o.floor ?? 20, 1, 20), seed: integer("seed", o.seed ?? 17, 0, 0xFFFFFFFF),
        level: o.level == null ? null : integer("level", o.level, 1, 100), seconds,
        mode: choice("mode", o.mode ?? "boss", MODES), policy: choice("policy", o.policy ?? "read", POLICIES),
        actions: choice("actions", o.actions ?? "full", ACTIONS),
        loadout: choice("loadout", o.loadout ?? "none", LOADOUTS),
        routeLoot: choice("routeLoot", o.routeLoot ?? "none", ["none", "pickup"]),
        gadget: o.gadget === undefined ? "none" : choice("gadget", o.gadget, ["none", ...GADGET_IDS]),
        hitStop: o.hitStop !== false,
        traceLimit: integer("traceLimit", o.traceLimit ?? 0, 0, 256)
    };
}

function equipmentFor(card, kind, data, config) {
    const gadget = config.gadget;
    if (kind === "none" && (!gadget || gadget === "none")) { return []; }
    const items = [];
    if (kind !== "none") {
        const job = kind === "matching" ? card.class : (card.class + 1) % 5;
        const weapon = data.weapons.filter(row => row.class === job && row.charaId < 0 && row.rare === 3)
            .sort((a, b) => a.id - b.id)[0];
        if (!weapon) { throw new Error("缺少测量用的原作通用武器: " + job); }
        // A declared baseline stage, not a claim about what a loot run will roll.
        items.push({ slot: "weapon", rarity: "common", catalogId: weapon.id, affixes: [] });
        if (kind === "stage") {
            // Full common-gear baseline: one actual loot-pool affix per
            // non-weapon slot. Bounded and seeded, so the report can repeat.
            const rng = createRandom(hash32("measure:baseline-gear:" + config.seed));
            for (const slot of ["amulet", "armor", "charm"]) {
                for (let tries = 0; tries < 500; tries++) {
                    const [item] = rollLoot(rng, 20, 0, card, { source: "shop", slot });
                    if (item && item.slot === slot && item.rarity === "common") {
                        items.push(item);
                        break;
                    }
                }
            }
        }
    }
    // One mechanic item per run, isolated from weapon passives by design.
    // The seal contract needs a stable slot per seed, mirroring room events.
    if (gadget && gadget !== "none") {
        const sealedSlot = gadget === "binding" ? 1 + hash32("measure:seal:" + config.seed) % 2 : undefined;
        items.push(makeGadget(gadget, undefined, sealedSlot));
    }
    return items;
}

export function createMeasurementWorld(options) {
    const config = configFor(options), data = loadMeasurementData();
    const encounter = data.encounters.find(row => row.vol === config.volume);
    if (!encounter) { throw new Error("缺少卷配置: " + config.volume); }
    const world = createWorld({ seed: config.seed, volume: config.volume, floor: config.floor,
        floorsPerVolume: 20, tables: { stats: data.stats, skills: data.skills, encounter } });
    const card = data.stats.card(config.cardId);
    const equipment = equipmentFor(card, config.loadout, data, config);
    world.spawnPlayer({ card, level: config.level ?? encounter.playerLevel, equipment, x: 8, y: 12 });
    if (config.mode === "training") {
        // Deliberately synthetic and without an attack. No AI/HP rewriting in
        // the measurement loop: knockback, stun and all damage remain real.
        world.spawnEnemy({ ...TRAINING_TARGET, nameZh: "无攻击训练靶", x: 12, y: 12,
            atk: 0, mgc: 0, aiType: "sentry", moveset: { attacks: [], support: [], gimmicks: [] } });
    } else {
        const dungeon = generateDungeon(hash32("measure:" + config.seed + ":" + config.floor), { roomsMin: 6, roomsMax: 9 });
        world.setDungeon(dungeon);
        const room = dungeon.rooms.find(row => row.type === config.mode);
        if (!room) { throw new Error("种子没有请求的房型: " + config.mode); }
        const entry = doorsOf(dungeon, room.id)[0];
        world.enterRoom(room.id, entry?.side || null);
        // No GPU map is built; solid room interactables still use the normal
        // world entry point. The report explicitly excludes decorative props.
        world.setRoomColliders([]);
    }
    world.drainEvents();
    return { world, config, equipment };
}

function worthwhile(slot, player) {
    if (!slot) { return false; }
    if (slot.damage || slot.nextAtk || slot.barrier || slot.gauge || slot.recastMod
            || slot.resists || slot.slow || slot.buffs?.length || slot.weakBonuses?.length) { return true; }
    return (slot.heal > 0 || slot.regen) && player.hp < player.maxHp * .7;
}

export function driveMeasurementInput(world, config, memory) {
    const input = { move: { x: 0, y: 0 }, attack: false, dodge: false, ultimate: false, skill: [false, false, false] };
    const p = world.player;
    if (config.policy === "idle" || p.dead) { world.inputState = input; return; }
    let target = null, distance = Infinity;
    for (const enemy of world.enemies) {
        if (enemy.dead) { continue; }
        const d = Math.hypot(enemy.x - p.x, enemy.y - p.y);
        if (d < distance) { target = enemy; distance = d; }
    }
    if (!target) { world.inputState = input; return; }
    const dx = target.x - p.x, dy = target.y - p.y, length = distance || 1;
    world.aim = { x: target.x, y: target.y };
    const desired = p.weaponProfile.kind === "projectile"
        ? Math.min(6, p.weaponProfile.range * .7) : p.weaponProfile.range * .85;
    const safety = p.radius + target.radius + .25;
    if (distance > desired + .1) { input.move = { x: dx / length, y: dy / length }; }
    else if (distance < safety) { input.move = { x: -dx / length, y: -dy / length }; }

    let threat = null;
    if (config.policy === "read" && config.mode !== "training") {
        threat = world.enemies.find(enemy => !enemy.dead && enemy.sm.state === "telegraph"
            && enemy.sm.stateTime >= .32 && Math.hypot(enemy.x - p.x, enemy.y - p.y) < 10);
        world.danmaku.forEach(bullet => {
            if (threat || bullet.side !== "enemy" || bullet.delay > 0) { return; }
            const bx = bullet.x - p.x, by = bullet.y - p.y;
            const speed2 = bullet.vx ** 2 + bullet.vy ** 2;
            const ahead = speed2 > 0 ? Math.min(.25, Math.max(0, -(bx * bullet.vx + by * bullet.vy) / speed2)) : 0;
            if (Math.hypot(bx + bullet.vx * ahead, by + bullet.vy * ahead) < p.radius + bullet.radius + .12) {
                threat = bullet;
            }
        });
    }
    if (threat) {
        const tx = threat.x - p.x, ty = threat.y - p.y, len = Math.hypot(tx, ty) || 1;
        const sign = config.seed % 2 ? 1 : -1;
        input.move = { x: -ty / len * sign, y: tx / len * sign };
        const canDodge = p.sm.state === "idle" || p.sm.state === "move"
            || (p.sm.state === "attack" && p.sm.stateTime >= PLAYER_TIMING.dodgeCancel);
        if (canDodge && world.time >= (memory.nextDodge ?? 0) && !p.heldDodge) {
            input.dodge = true;
            memory.nextDodge = world.time + .85;
        }
    } else {
        const actionable = p.sm.state === "idle" || p.sm.state === "move";
        const inRange = distance <= desired + .3 && distance >= safety;
        input.attack = inRange;
        if (config.actions === "full" && actionable) {
            if (p.skills.ultimateReady && worthwhile(p.skills.ultimate, p)) {
                input.ultimate = !p.heldUltimate;
            } else {
                const index = p.skills.slots.findIndex((slot, i) => p.skills.ready(i)
                    && !p.heldSkill[i] && worthwhile(slot, p) && (!slot.damage || distance < 10));
                if (index >= 0) { input.skill[index] = true; }
            }
        }
    }
    world.inputState = input;
}

const round = value => Math.round(value * 1000000) / 1000000;
function snapshotEnemy(enemy) {
    return { enemyId: enemy.enemyId ?? null, kind: enemy.kind, elite: enemy.elite,
        hp: enemy.maxHp, atk: enemy.atk, mgc: enemy.mgc, def: enemy.def, mdef: enemy.mdef,
        element: enemy.element ?? null, aiType: enemy.aiType };
}

export function measureBattle(options) {
    const { world, config, equipment } = createMeasurementWorld(options), p = world.player;
    const initial = { level: p.level, hp: p.hp, stats: { ...p.base }, gauge: p.skills.gauge,
        gaugeMax: p.skills.gaugeMax, weaponClass: p.weaponProfile.classId,
        proficiency: p.weaponProfile.proficiency, enemies: world.enemies.map(snapshotEnemy) };
    const counts = {}, trace = [], memory = {};
    const damage = { dealt: 0, taken: 0, normal: 0, skill: 0, ultimate: 0, healed: 0 };
    let firstHit = null, firstUltimate = null, bossDefeated = null, kills = 0, steps = 0, peakBullets = 0;
    let checksum = 2166136261;
    const digest = value => {
        const text = String(value);
        for (let i = 0; i < text.length; i++) { checksum = Math.imul(checksum ^ text.charCodeAt(i), 16777619) >>> 0; }
    };
    function consume() {
        // A real ultimate request can append its committed hits. Do not drop
        // those events or defer them into the next tick's damage accounting.
        for (let pass = 0; pass < 4; pass++) {
            const events = world.drainEvents();
            if (!events.length) { return; }
            for (const event of events) {
                counts[event.type] = (counts[event.type] || 0) + 1;
                if (event.type === "ultimate" && event.ready) { world.useUltimate(); }
                if (event.type === "ultimateSpent" && firstUltimate === null) { firstUltimate = steps * DEFAULT_STEP; }
                if (event.type === "heal") { damage.healed += event.amount; }
                if (event.type === "hit") {
                    if (event.attacker === p) {
                        damage.dealt += event.damage;
                        const normal = event.normal || (!event.bullet && event.skill?.id === p.skills.normal.id);
                        damage[event.ultimate ? "ultimate" : normal ? "normal" : "skill"] += event.damage;
                        if (firstHit === null) { firstHit = steps * DEFAULT_STEP; }
                    }
                    if (event.target === p) { damage.taken += event.damage; }
                    if (event.died && event.target !== p) {
                        kills++;
                        if (event.target.kind === "boss") { bossDefeated = steps * DEFAULT_STEP; }
                    }
                    if (config.hitStop) { world.applyHitStop(hitStopFor(event)); }
                }
                // No generated unit IDs: their process-global counter is not
                // part of seed reproducibility, unlike these combat facts.
                const skillId = event.skill?.id ?? event.skillId ?? null;
                digest([steps, event.type, skillId ?? "", event.damage ?? "", event.phase ?? ""].join(":"));
                if (trace.length < config.traceLimit) {
                    trace.push({ step: steps, event: event.type, skillId,
                        damage: event.damage ?? null, gauge: round(p.skills.gauge) });
                }
            }
        }
        if (world.events.length) { throw new Error("事件级联超出测量上界"); }
    }
    const limit = Math.ceil(config.seconds / DEFAULT_STEP);
    while (steps < limit && !p.dead && world.enemies.some(enemy => !enemy.dead)) {
        driveMeasurementInput(world, config, memory);
        world.update(DEFAULT_STEP);
        steps++;
        consume();
        peakBullets = Math.max(peakBullets, world.danmaku.active);
        if (![p.x, p.y, p.hp, world.time].every(Number.isFinite)) { throw new Error("战斗产生非有限状态"); }
        if (steps % 60 === 0) {
            digest([round(p.x), round(p.y), p.hp, p.sm.state, world.danmaku.active,
                ...world.enemies.map(enemy => [round(enemy.x), round(enemy.y), enemy.hp, enemy.phase].join("/"))].join(":"));
        }
    }
    const alive = world.enemies.filter(enemy => !enemy.dead);
    const initialBossMax = initial.enemies.filter(enemy => enemy.kind === "boss").reduce((sum, enemy) => sum + enemy.hp, 0);
    const bossHpFraction = initialBossMax ? round(alive.filter(enemy => enemy.kind === "boss").reduce((sum, enemy) => sum + enemy.hp, 0) / initialBossMax) : null;
    const result = p.dead ? "death" : !alive.length ? "clear" : config.mode === "training" ? "window" : "timeout";
    return { ...config, equipment, initial, result, steps, seconds: round(steps * DEFAULT_STEP),
        simulationSeconds: round(world.time), clearSeconds: result === "clear" ? round(steps * DEFAULT_STEP) : null,
        bossDefeatedSeconds: bossDefeated === null ? null : round(bossDefeated),
        firstHitSeconds: firstHit === null ? null : round(firstHit),
        firstUltimateSeconds: firstUltimate === null ? null : round(firstUltimate),
        final: { level: p.level, hp: p.hp, gauge: round(p.skills.gauge), aliveEnemies: alive.length, bossHp: alive.filter(enemy => enemy.kind === "boss").map(enemy => round(enemy.hp)), bossHpFraction },
        damage, kills, counts, peakBullets, checksum: checksum.toString(16).padStart(8, "0"), trace };
}

// --- 整层路线测量：机械策略走完整层，不是玩家路线或最优路线 ----------------
// 口径：房间直达（不复现开门过渡的行走时间）；收益只计数不拾取；
// 单房上限与单房测量相同；最近未清战斗房优先（贪婪），不是全局最优。
function bfsPath(dungeon, fromId, toId) {
    const adjacent = new Map();
    for (const door of dungeon.doors) {
        for (const [a, b] of [[door.a, door.b], [door.b, door.a]]) {
            if (!adjacent.has(a)) { adjacent.set(a, []); }
            adjacent.get(a).push(b);
        }
    }
    const prev = new Map([[fromId, null]]);
    const queue = [fromId];
    for (let head = 0; head < queue.length; head++) {
        const id = queue[head];
        if (id === toId) { break; }
        for (const next of adjacent.get(id) || []) {
            if (!prev.has(next)) { prev.set(next, id); queue.push(next); }
        }
    }
    if (!prev.has(toId)) { return null; }
    const path = [];
    for (let id = toId; id !== null; id = prev.get(id)) { path.push(id); }
    return path.reverse();
}

function graphDistances(dungeon, fromId) {
    const adjacent = new Map();
    for (const door of dungeon.doors) {
        for (const [a, b] of [[door.a, door.b], [door.b, door.a]]) {
            if (!adjacent.has(a)) { adjacent.set(a, []); }
            adjacent.get(a).push(b);
        }
    }
    const dist = new Map([[fromId, 0]]);
    const queue = [fromId];
    for (let head = 0; head < queue.length; head++) {
        const id = queue[head];
        for (const next of adjacent.get(id) || []) {
            if (!dist.has(next)) { dist.set(next, dist.get(id) + 1); queue.push(next); }
        }
    }
    return dist;
}

function createRouteWorld(options) {
    const config = configFor({ ...options, mode: "battle" }), data = loadMeasurementData();
    const encounter = data.encounters.find(row => row.vol === config.volume);
    if (!encounter) { throw new Error("缺少卷配置: " + config.volume); }
    const world = createWorld({ seed: config.seed, volume: config.volume, floor: config.floor,
        floorsPerVolume: 20, tables: { stats: data.stats, skills: data.skills, encounter } });
    const card = data.stats.card(config.cardId);
    const equipment = equipmentFor(card, config.loadout, data, config);
    world.spawnPlayer({ card, level: config.level ?? encounter.playerLevel, equipment, x: 8, y: 12 });
    const dungeon = generateDungeon(hash32("measure:" + config.seed + ":" + config.floor), { roomsMin: 6, roomsMax: 9 });
    world.setDungeon(dungeon);
    const start = dungeon.rooms.find(row => row.id === dungeon.start);
    world.enterRoom(start.id, null);
    world.setRoomColliders([]);
    world.drainEvents();
    return { world, config, equipment, dungeon };
}

function driveRoomClear(world, config, memory, state) {
    let steps = 0;
    const limit = Math.ceil(config.seconds / DEFAULT_STEP);
    while (steps < limit && !world.player.dead && world.enemies.some(enemy => !enemy.dead)) {
        driveMeasurementInput(world, config, memory);
        world.update(DEFAULT_STEP);
        steps++;
        state.steps++;
        for (let pass = 0; pass < 4; pass++) {
            const events = world.drainEvents();
            if (!events.length) { break; }
            for (const event of events) {
                state.counts[event.type] = (state.counts[event.type] || 0) + 1;
                if (event.type === "ultimate" && event.ready) { world.useUltimate(); }
                if (event.type === "hit") {
                    if (event.attacker === world.player) { state.damage.dealt += event.damage; }
                    if (event.target === world.player) { state.damage.taken += event.damage; }
                    if (event.died && event.target !== world.player) { state.kills++; }
                    if (config.hitStop) { world.applyHitStop(hitStopFor(event)); }
                }
            }
        }
        if (world.events.length) { throw new Error("事件级联超出测量上界"); }
    }
    return steps;
}

function walkFloorRooms(world, config, dungeon, state, memory) {
    const p = world.player;
    const bossRoom = dungeon.rooms.find(row => row.type === "boss");
    const mainPath = new Set(bfsPath(dungeon, dungeon.start, bossRoom.id) || []);
    const dist = graphDistances(dungeon, dungeon.start);
    const pending = dungeon.rooms.filter(row => row.type === "battle" || row.type === "boss");
    const restRooms = dungeon.rooms.filter(row => row.type === "rest");
    const rooms = [];
    let current = dungeon.start;
    const nearestRest = () => {
        let best = null, bestHops = Infinity;
        for (const room of restRooms) {
            const hops = Math.abs(dist.get(room.id) - dist.get(current));
            if (hops < bestHops) { bestHops = hops; best = room; }
        }
        return best;
    };
    const enterRoom = room => {
        const entry = (dungeon.doors.find(d => d.a === room.id) || dungeon.doors.find(d => d.b === room.id));
        const side = entry ? (entry.a === room.id ? entry.side : null) : null;
        world.enterRoom(room.id, side);
        world.setRoomColliders([]);
        world.drainEvents();
    };
    const visitRest = room => {
        enterRoom(room);
        const before = p.hp;
        const healed = world.restHeal();
        rooms.push({ roomId: room.id, type: "rest", enemyCount: 0, onMainPath: mainPath.has(room.id),
            result: healed > 0 ? "rest" : "skipped", seconds: 0,
            healed: round(healed), hpBefore: Math.round(before) });
        state.restVisits++;
        state.restHealed += healed;
        restRooms.splice(restRooms.indexOf(room), 1);
        current = room.id;
    };
    while (pending.length && !p.dead) {
        // 路线决策：低血量且还有未用休息点时先绕路回血；回血不耗时（行走时间不计入）。
        if (p.hp < p.maxHp * .7) {
            const rest = nearestRest();
            if (rest) { visitRest(rest); continue; }
        }
        // 贪婪最近：从当前房间按图距离选最近未清战斗房；boss 最后必被选中。
        let pick = 0;
        let bestHops = Infinity;
        for (let i = 0; i < pending.length; i++) {
            const hops = Math.abs(dist.get(pending[i].id) - dist.get(current));
            if (hops < bestHops) { bestHops = hops; pick = i; }
        }
        const room = pending.splice(pick, 1)[0];
        enterRoom(room);
        const enemyCount = world.enemies.length;
        const beforeSteps = state.steps;
        driveRoomClear(world, config, memory, state);
        const clearSeconds = round(state.steps - beforeSteps) * DEFAULT_STEP;
        const roomResult = p.dead ? "death" : world.enemies.some(e => !e.dead) ? "timeout" : "clear";
        rooms.push({ roomId: room.id, type: room.type, enemyCount, onMainPath: mainPath.has(room.id),
            result: roomResult, seconds: round(clearSeconds) });
        current = room.id;
    }
    return rooms;
}

export function measureFloorRoute(options) {
    const { world, config, dungeon, equipment } = createRouteWorld(options);
    const p = world.player;
    const initial = { level: p.level, hp: p.hp, gauge: p.skills.gauge, gaugeMax: p.skills.gaugeMax };
    const state = { steps: 0, kills: 0, counts: {}, damage: { dealt: 0, taken: 0 }, restVisits: 0, restHealed: 0 };
    const memory = {};
    const rooms = walkFloorRooms(world, config, dungeon, state, memory);
    const unvisited = dungeon.rooms.filter(row => (row.type === "battle" || row.type === "boss")
        && !rooms.some(visited => visited.roomId === row.id));
    const timedOut = rooms.filter(row => row.result === "timeout").length;
    const battleSeconds = round(rooms.filter(row => row.type === "battle").reduce((sum, row) => sum + row.seconds, 0));
    const bossSeconds = round(rooms.filter(row => row.type === "boss").reduce((sum, row) => sum + row.seconds, 0));
    const mainSeconds = round(rooms.filter(row => row.onMainPath).reduce((sum, row) => sum + row.seconds, 0));
    const branchRooms = rooms.filter(row => !row.onMainPath);
    const result = p.dead ? "death" : (unvisited.length || timedOut) ? "incomplete" : "clear";
    return { ...config, mode: "route", initial, equipment, result, totalSeconds: round(state.steps * DEFAULT_STEP),
        roomCount: rooms.length, battleSeconds, bossSeconds, mainPathSeconds: mainSeconds,
        branchRoomCount: branchRooms.length, branchSeconds: round(branchRooms.reduce((sum, row) => sum + row.seconds, 0)),
        timedOutRooms: timedOut, unvisitedRoomIds: unvisited.map(row => row.id), kills: state.kills, counts: state.counts,
        damage: state.damage, final: { level: p.level, hp: p.hp, gauge: round(p.skills.gauge) },
        rooms };
}

// 连续 20 层整卷：等级由击杀经验自然成长，掉落只计数不拾取；死亡即中止。
// 回血绕路见 walkFloorRooms；boss 房逐层明细用于逐首领设计卡。
export function measureVolumeRoute(options) {
    const { world, config, equipment } = createRouteWorld(options);
    const p = world.player;
    const initial = { level: p.level, hp: p.hp, gauge: p.skills.gauge, gaugeMax: p.skills.gaugeMax };
    const state = { steps: 0, kills: 0, counts: {}, damage: { dealt: 0, taken: 0 }, restVisits: 0, restHealed: 0 };
    const memory = {};
    const floors = [];
    let deathFloor = null, anyTimedOut = false;
    for (let floor = 1; floor <= 20 && !p.dead; floor++) {
        world.floor = floor;
        const dungeon = generateDungeon(hash32("measure:" + config.seed + ":" + floor), { roomsMin: 6, roomsMax: 9 });
        world.setDungeon(dungeon);
        world.setRoomColliders([]);
        world.drainEvents();
        const before = state.steps;
        const rooms = walkFloorRooms(world, config, dungeon, state, memory);
        const mainSeconds = round(rooms.filter(row => row.onMainPath).reduce((sum, row) => sum + row.seconds, 0));
        const bossRoom = rooms.find(row => row.type === "boss") || null;
        floors.push({ floor, seconds: round((state.steps - before) * DEFAULT_STEP),
            rooms: rooms.length, timedOut: rooms.filter(row => row.result === "timeout").length,
            mainPathSeconds: mainSeconds,
            branchSeconds: round(rooms.filter(row => !row.onMainPath).reduce((sum, row) => sum + row.seconds, 0)),
            bossRoom: bossRoom ? { result: bossRoom.result, seconds: bossRoom.seconds } : null });
        if (p.dead) { deathFloor = floor; }
        if (rooms.some(room => room.result === "timeout")) { anyTimedOut = true; }
    }
    const totalSeconds = round(state.steps * DEFAULT_STEP);
    // 首领房超时不是通关：任何房间超时（含第 20 层首领）都不得记为 clear。
    const result = p.dead ? "death" : floors.length < 20 ? "incomplete"
        : anyTimedOut ? "incomplete" : "clear";
    return { ...config, mode: "route-volume", initial, equipment, result, totalSeconds,
        floorsCleared: floors.length, deathFloor,
        final: { level: p.level, hp: p.hp, gauge: round(p.skills.gauge) },
        kills: state.kills, damage: state.damage, restVisits: state.restVisits,
        restHealed: round(state.restHealed), floors };
}

function summarizeVolumeRoutes(rows) {
    const groups = new Map();
    for (const row of rows) {
        if (!groups.has(row.volume)) { groups.set(row.volume, []); }
        groups.get(row.volume).push(row);
    }
    return [...groups].sort((a, b) => a[0] - b[0]).map(([volume, entries]) => ({
        volume, samples: entries.length,
        cleared: entries.filter(row => row.result === "clear").length,
        died: entries.filter(row => row.result === "death").length,
        incomplete: entries.filter(row => row.result === "incomplete").length,
        medianTotalSeconds: median(entries.map(row => row.totalSeconds)),
        medianFloorsCleared: median(entries.map(row => row.floorsCleared)),
        deathFloorMedian: median(entries.filter(row => row.deathFloor).map(row => row.deathFloor)) }));
}

function summarizeRoutes(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = [row.volume, row.floor].join("/");
        if (!groups.has(key)) { groups.set(key, []); }
        groups.get(key).push(row);
    }
    return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([group, entries]) => ({
        group, samples: entries.length,
        cleared: entries.filter(row => row.result === "clear").length,
        died: entries.filter(row => row.result === "death").length,
        incomplete: entries.filter(row => row.result === "incomplete").length,
        medianTotalSeconds: median(entries.map(row => row.totalSeconds)),
        medianMainSeconds: median(entries.map(row => row.mainPathSeconds)),
        medianBranchSeconds: median(entries.map(row => row.branchSeconds)),
        medianBranchRoomCount: median(entries.map(row => row.branchRoomCount)) }));
}

function median(values) {
    if (!values.length) { return null; }
    const sorted = [...values].sort((a, b) => a - b), at = Math.floor(sorted.length / 2);
    return round(sorted.length % 2 ? sorted[at] : (sorted[at - 1] + sorted[at]) / 2);
}
export function summarizeMeasurements(rows) {
    const groups = new Map();
    for (const row of rows) {
        const job = PLAYABLE_ROSTER.find(card => card.id === row.cardId).class;
        const key = [row.mode, row.volume, row.floor, row.level ?? "baseline", row.loadout, row.gadget ?? "none", row.policy, row.actions, job].join("/");
        if (!groups.has(key)) { groups.set(key, []); }
        groups.get(key).push(row);
    }
    return [...groups].map(([group, entries]) => ({ group, samples: entries.length,
        cleared: entries.filter(row => row.result === "clear").length,
        died: entries.filter(row => row.result === "death").length,
        timedOut: entries.filter(row => row.result === "timeout").length,
        medianClearSeconds: median(entries.filter(row => row.result === "clear").map(row => row.clearSeconds)),
        medianDamagePerSecond: median(entries.map(row => row.damage.dealt / row.seconds)),
        medianRemainingHpFraction: median(entries.map(row => row.final.hp / row.initial.hp)) }));
}

function sourceHashes() {
    const files = ["tools/rl_world_balance.mjs", "site/asset/rl/cards-rl.json", "site/asset/rl/growth.json",
        "site/asset/rl/enemies.json", "site/asset/rl/skills-rl.json", "site/asset/rl/encounters.json", "site/asset/rl/weapons-rl.json",
        "site/asset/rl/stats.js", "site/game/rl/rosterids.js", "site/game/rl/world.js", "site/game/rl/combat.js", "site/game/rl/skills.js",
        "site/game/rl/enemyai.js", "site/game/rl/enemyroles.js", "site/game/rl/enemyactions.js",
        "site/game/rl/danmaku.js", "site/game/rl/pool.js", "site/game/rl/actorstate.js", "site/game/rl/dungeon.js", "site/game/rl/geometry.js",
        "site/game/rl/skillcards.js", "site/game/rl/clock.js",
        "site/game/rl/equipment.js", "site/game/rl/weaponcatalog.js", "site/game/rl/weaponprofile.js", "site/game/rl/impact.js",
        "site/game/rl/gadgets.js", "site/game/rl/assistance.js",
        "site/game/rl/targeting.js", "site/game/rl/playerstatus.js", "site/game/rl/random.js", "site/game/rl/loot.js", "site/game/rl/elements.js"];
    return Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(resolve(ROOT, file))).digest("hex")]));
}

function main(argv) {
    const options = { cards: PLAYABLE_IDS, volumes: [1, 2, 3, 4, 5], seeds: [17, 53, 101],
        modes: ["battle", "boss"], loadouts: ["none"], gadgets: ["none"], levels: [null], floor: 20, floors: null, seconds: 120, policy: "read", actions: "full", route: null, routeLoadout: "none" };
    let output = resolve(ROOT, ".codex-tmp/world-balance/report.json");
    for (let i = 0; i < argv.length; i += 2) {
        const flag = argv[i], value = argv[i + 1];
        if (flag === "--help") {
            console.log("真实世界战斗测量（不是玩家胜率或帧率测试）\n"
                + "--cards ID,... --volumes 1,2,... --seeds 17,53,... --modes training,battle,boss\n"
                + "--levels baseline,20,80 --loadouts none,matching,cross --gadgets none,rhythm,...\n"
                + "--floor 20 或 --floors 1,2,...,20 --seconds 120\n"
                + "--policy read|hold|idle --actions full|basic --route all|volume 整层/整卷路线测量\n"
                + "--route-loadout none|matching|cross|stage 路线基线配装 --json 输出文件");
            return;
        }
        if (value === undefined || value.startsWith("--")) { throw new Error("参数缺值: " + flag); }
        if (["--cards", "--volumes", "--seeds"].includes(flag)) { options[flag.slice(2)] = value.split(",").map(Number); }
        else if (["--modes", "--loadouts", "--gadgets"].includes(flag)) { options[flag.slice(2)] = value.split(","); }
        else if (flag === "--levels") { options.levels = value.split(",").map(v => v === "baseline" ? null : Number(v)); }
        else if (["--floor", "--seconds"].includes(flag)) { options[flag.slice(2)] = Number(value); }
        else if (flag === "--floors") { options.floors = value.split(",").map(Number); }
        else if (["--policy", "--actions"].includes(flag)) { options[flag.slice(2)] = value; }
        else if (flag === "--route") {
            if (value !== "all" && value !== "volume") { throw new Error("--route 仅支持 all|volume"); }
            options.route = value;
        }
        else if (flag === "--route-loadout") {
            if (!["none", "matching", "cross", "stage"].includes(value)) { throw new Error("--route-loadout 仅支持 none|matching|cross|stage"); }
            options.routeLoadout = value;
        }
        else if (flag === "--json") { output = resolve(value); }
        else { throw new Error("未知参数: " + flag); }
    }
    const floors = options.floors || [options.floor];
    for (const floor of floors) { integer("floor", floor, 1, 20); }
    const total = [options.cards, options.volumes, options.seeds, options.modes, options.loadouts, options.gadgets, options.levels, floors]
        .reduce((count, list) => count * list.length, 1);
    if (total > 10000) { throw new Error("测量超过单批 10000 场上限，请拆分配置"); }
    const hashes = sourceHashes(), rows = [];
    if (options.route === "volume") {
        for (const volume of options.volumes) for (const cardId of options.cards) for (const seed of options.seeds) {
            rows.push(measureVolumeRoute({ ...options, volume, cardId, seed, level: null, loadout: options.routeLoadout }));
        }
        if (JSON.stringify(sourceHashes()) !== JSON.stringify(hashes)) { throw new Error("测量期间源码变化，拒绝混合版本报告"); }
        const report = { schema: 2, instrument: "world-fixed-step-route-volume", assumptions: {
            step: DEFAULT_STEP, source: "真实生成整卷 20 层链；房间直达，不含开门过渡行走",
            policy: "贪婪最近未清战斗房优先；血量<70%且未用休息点在图上时先绕路回血；不是玩家路线或最优路线",
            loot: "只计数不拾取", restHeal: "世界真实 restHeal，行走时间不计入",
            baselineLoadout: options.routeLoadout,
            growth: "等级由击杀经验自然成长；基线配装不变（--route-loadout）", death: "死亡即中止整卷",
            roomCap: "单房上限与单房测量相同（--seconds，默认120）", hitStop: "与页面共用" },
            options, sources: hashes, summary: summarizeVolumeRoutes(rows), rows };
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
        console.log("完成 " + rows.length + " 卷真实世界整卷路线测量；不是玩家胜率或最优路线。");
        console.log(JSON.stringify(report.summary, null, 2));
        console.log(output);
        return;
    }
    if (options.route === "all") {
        for (const volume of options.volumes) for (const cardId of options.cards) for (const seed of options.seeds)
            for (const floor of floors) {
                rows.push(measureFloorRoute({ ...options, volume, cardId, seed, floor, level: null, loadout: options.routeLoadout }));
            }
        if (JSON.stringify(sourceHashes()) !== JSON.stringify(hashes)) { throw new Error("测量期间源码变化，拒绝混合版本报告"); }
        const report = { schema: 2, instrument: "world-fixed-step-route", assumptions: {
            step: DEFAULT_STEP, source: "真实生成整层房间链；房间直达，不含开门过渡行走",
            policy: "贪婪最近未清战斗房优先；血量<70%且未用休息点在图上时先绕路回血；不是玩家路线或最优路线",
            loot: "只计数不拾取", restHeal: "世界真实 restHeal，行走时间不计入",
            baselineLoadout: options.routeLoadout,
            roomCap: "单房上限与单房测量相同（--seconds，默认120）", hitStop: "与页面共用" },
            options, sources: hashes, summary: summarizeRoutes(rows), rows };
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
        console.log("完成 " + rows.length + " 层真实世界路线测量；不是玩家胜率或最优路线。");
        console.log(JSON.stringify(report.summary, null, 2));
        console.log(output);
        return;
    }
    for (const mode of options.modes) for (const volume of options.volumes) for (const level of options.levels)
        for (const loadout of options.loadouts) for (const gadget of options.gadgets) for (const cardId of options.cards) for (const seed of options.seeds)
            for (const floor of floors) {
                rows.push(measureBattle({ ...options, mode, volume, level, loadout, gadget, cardId, seed, floor }));
            }
    if (JSON.stringify(sourceHashes()) !== JSON.stringify(hashes)) { throw new Error("测量期间源码变化，拒绝混合版本报告"); }
    const report = { schema: 1, instrument: "world-fixed-step", assumptions: {
        step: DEFAULT_STEP, source: "真实生成房间与运行时命中；独立房间而非整卷经济",
        policy: "机械策略，不是玩家胜率", hitStop: "与页面共用", cinematics: "立即跳过，不计加载/观看时间",
        map: "无装饰碰撞；保留世界交互物碰撞", training: TRAINING_TARGET
    }, options, sources: hashes, summary: summarizeMeasurements(rows), rows };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log("完成 " + rows.length + " 场真实世界测量；不是玩家胜率。");
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { main(process.argv.slice(2)); }
