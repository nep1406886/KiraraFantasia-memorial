import { TICK, UNIT_RULES, ENEMY_RULES, ENDLESS_ROSTER } from "../data/campaign.js";
import { attackContains, healingContains, burstContains, areaContains, ATTACK_BACK_REACH } from "./targeting.js";

const EPS = 1e-8;
const cellKey = (row, col) => `${row}:${col}`;
const active = (until, time) => until > time + EPS;

// Seeded PRNG for endless waves; the simulation itself never draws randomness.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class Battle {
    constructor(level, options = {}) {
        this.level = level;
        this.deck = new Set(options.deck || ["F01", "U01"]);
        this.phase = "setup";
        this.time = 0;
        this.tick = 0;
        this.accumulator = 0;
        this.pauses = new Set();
        this.resource = level.startResource;
        this.units = new Map();
        this.enemies = new Map();
        this.projectiles = new Map();
        this.lobs = new Map();
        this.pickups = new Map();
        this.occupancy = new Map();
        this.readyAt = new Map();
        this.pending = [];
        this.events = [];
        this.sequence = 0;
        this.spawnIndex = 0;
        this.warned = new Set();
        this.spawns = level.spawns.map((entry, index) => ({ ...entry, index })).sort((a, b) => a.at - b.at || a.index - b.index);
        this.gates = Array(level.rows).fill(true);
        this.nextNatural = level.naturalFirst;
        this.wave = 1;
        this.stats = { kills: 0, deployed: 0, recalls: 0, collected: 0, generated: 0, spent: 0,
            healed: 0, shielded: 0, blocked: 0, gatesUsed: 0, defeatedUnits: 0, breachRow: null, wavesCleared: 0 };
        if (level.endless) {
            this.seed = Number.isInteger(options.seed) ? options.seed : 20260926;
            this.rng = mulberry32(this.seed);
            this.plannedWave = 0;
            this.nextWaveAt = 24;
            this.waveBounds = new Map();
        this.restocks = 0;
            this.planWave();
        }
    }

    emit(type, detail = {}) { this.events.push({ type, time: this.time, ...detail }); }
    drainEvents() { const events = this.events; this.events = []; return events; }
    id(prefix) { return `${prefix}${++this.sequence}`; }
    start() {
        if (this.phase !== "setup") { return false; }
        this.phase = "running";
        this.emit("started");
        return true;
    }
    pause(reason, paused) {
        if (paused) { this.pauses.add(reason); }
        else { this.pauses.delete(reason); }
        this.accumulator = 0;
    }

    planWave() {
        const n = ++this.plannedWave;
        const pool = ENDLESS_ROSTER.filter(entry => n >= entry.from);
        const budget = 3 + n * 2.0 + Math.floor(n / 3);
        const picks = [];
        // Wave modifiers give endless its rhythm: a label and a structural
        // tweak, bound to the wave so the HUD can announce it and the sim can
        // react when the wave is cleared.
        let modifier = null;
        if (n % 5 === 0) {
            modifier = { kind: "boss", label: "BOSS" };
            // From wave 20 the true endless queen takes the boss slot; before
            // that the classic bosses alternate so early runs stay readable.
            picks.push(n >= 20 ? "E39" : n >= 15 && n % 15 === 0 ? "E30" : "E13");
        } else if (n >= 4 && n % 3 === 0) {
            modifier = { kind: "elite", label: "精英" };
        } else if (n >= 7 && n % 7 === 0) {
            modifier = { kind: "rush", label: "急袭" };
        } else if (n >= 6 && n % 4 === 2) {
            modifier = { kind: "swarm", label: "群袭" };
        }
        let spent = picks.length ? 4 : 0;
        const isSwarm = modifier?.kind === "swarm";
        const cap = isSwarm ? Math.ceil(budget * 1.5) : budget;
        while (spent < cap) {
            const choice = pool[Math.floor(this.rng() * pool.length)].type;
            const threat = ENEMY_RULES[choice].threat;
            if (threat > cap - spent + 1 && spent > 0) {
                const cheap = pool.filter(entry => ENEMY_RULES[entry.type].threat <= cap - spent + 1);
                if (!cheap.length) { break; }
                const fallback = cheap[Math.floor(this.rng() * cheap.length)].type;
                picks.push(fallback); spent += ENEMY_RULES[fallback].threat; continue;
            }
            picks.push(choice); spent += threat;
        }
        if (isSwarm) {
            // More, weaker bodies instead of a statier front line.
            for (const type of [...picks]) {
                if (ENEMY_RULES[type].threat < 2) { picks.push(type); }
            }
        }
        // Fisher-Yates with the seeded stream keeps node and browser identical.
        for (let i = picks.length - 1; i > 0; i--) {
            const j = Math.floor(this.rng() * (i + 1));
            [picks[i], picks[j]] = [picks[j], picks[i]];
        }
        const start = this.nextWaveAt;
        const isRush = modifier?.kind === "rush";
        const duration = Math.min(40, (16 + n * 1.4) * (isRush ? .55 : 1));
        const hpScale = (n > 9 ? 1 + (n - 9) * .08 : 1) * (isSwarm ? .8 : 1);
        const base = this.spawns.length;
        picks.forEach((type, index) => {
            const at = +(start + duration * index / Math.max(1, picks.length) + this.rng() * 1.5).toFixed(3);
            const row = Math.floor(this.rng() * this.level.rows);
            const elite = modifier?.kind === "elite" && index === 0;
            this.spawns.push({ at, row, type, wave: n, hpScale: elite ? hpScale * 2.2 : hpScale, elite, index: base + index });
        });
        this.spawns.sort((a, b) => a.at - b.at || a.index - b.index);
        this.waveBounds.set(n, { remaining: picks.length, modifier });
        this.nextWaveAt = start + duration + (isRush ? 6 : 10);
    }

    canDeploy(type, row, col) {
        const rule = UNIT_RULES[type];
        if (this.phase !== "setup" && this.phase !== "running") { return { ok: false, reason: "本次巡守已结束" }; }
        if (this.pauses.size) { return { ok: false, reason: "先继续巡守，再进行部署" }; }
        if (!rule || (!this.deck.has(type) && rule.kind !== "gear")) { return { ok: false, reason: "这张卡不在本次编队中" }; }
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= this.level.rows || col < 0 || col >= this.level.cols) {
            return { ok: false, reason: "这里不在本关的布阵区域内" };
        }
        const remaining = Math.max(0, (this.readyAt.get(type) || 0) - this.time);
        if (remaining > EPS) {
            return { ok: false, reason: this.phase === "setup" ? "这张卡的冷却将在开局后推进" : `还需等待 ${Math.ceil(remaining)} 秒`, cooldown: remaining };
        }
        const cost = rule.kind === "gear" ? Math.max(10, Math.round(rule.cost * (this.townGear || 1))) : rule.cost;
        if (this.resource < cost) { return { ok: false, reason: `还差 ${cost - this.resource} クリエ`, shortage: cost - this.resource }; }
        if (rule.kind === "gear") {
            const host = this.units.get(this.occupancy.get(cellKey(row, col)));
            if (!host) { return { ok: false, reason: "装备要放在已经部署的同伴上" }; }
            const hostRule = UNIT_RULES[host.type];
            if (hostRule.kind === "producer" || hostRule.kind === "gear" || hostRule.kind === "burst") {
                return { ok: false, reason: "这种同伴不需要装备" };
            }
            // 通用装备:不带 hosts 字段;专属装备:必须 match 当前同伴 type。
            if (rule.gearFor && !rule.gearFor.includes(host.type)) {
                return { ok: false, reason: `${hostRule.name}无法佩戴「${rule.name}」` };
            }
            if (host.gear) { return { ok: false, reason: "这名同伴已经带着装备" }; }
        } else if (rule.kind !== "burst") {
            if (this.occupancy.has(cellKey(row, col))) { return { ok: false, reason: "这里已有同伴或设施" }; }
        }
        return { ok: true };
    }

    deploy(type, row, col) {
        const check = this.canDeploy(type, row, col);
        if (!check.ok) { return check; }
        const rule = UNIT_RULES[type];
        this.resource -= rule.cost;
        this.stats.spent += rule.cost;
        this.stats.deployed++;
        this.readyAt.set(type, this.time + rule.deployCooldown);
        if (rule.kind === "gear") {
            const host = this.units.get(this.occupancy.get(cellKey(row, col)));
            this.applyGear(host, rule);
            return { ok: true, id: host.id };
        }
        if (rule.kind === "burst") {
            const id = this.id("spell-");
            this.pending.push({ kind: "burst", id, at: this.time + rule.windup, row, col, type });
            this.emit("spellCast", { id, unitType: type, row, col, windup: rule.windup });
            return { ok: true, id };
        }
        const unit = { id: this.id("unit-"), type, row, col, hp: rule.hp, maxHp: rule.hp,
            nextAction: this.time, nextIncome: this.time + (rule.firstIncome || 0),
            nextGuard: this.time, guardUntil: 0, createdAt: this.time, attacks: 0,
            shield: 0, maxShield: 0, barrierHits: 0, nextBarrier: this.time,
            nextSelfHeal: this.time + (rule.selfHeal?.period || 0), hasteUntil: 0, haste: 0 };
        this.units.set(unit.id, unit);
        this.occupancy.set(cellKey(row, col), unit.id);
        this.emit("deployed", { id: unit.id, unitType: type, row, col });
        return { ok: true, id: unit.id };
    }

    recall(row, col) {
        if (this.phase !== "setup" && this.phase !== "running") { return { ok: false, reason: "本次巡守已结束" }; }
        if (this.pauses.size) { return { ok: false, reason: "巡守暂停中" }; }
        const unit = this.units.get(this.occupancy.get(cellKey(row, col)));
        if (!unit) { return { ok: false, reason: "这个位置没有可召回的对象" }; }
        if (this.phase === "setup") {
            this.resource += UNIT_RULES[unit.type].cost;
            this.stats.spent -= UNIT_RULES[unit.type].cost;
            this.readyAt.delete(unit.type);
        }
        this.stats.recalls++;
        this.removeUnit(unit, "recall");
        return { ok: true };
    }

    collect(id) {
        if (this.phase !== "running" || this.pauses.size) { return false; }
        const pickup = this.pickups.get(id);
        if (!pickup) { return false; }
        this.pickups.delete(id);
        this.resource += pickup.amount;
        this.stats.collected += pickup.amount;
        this.emit("collected", { id, amount: pickup.amount });
        return true;
    }

    collectAll() {
        for (const id of [...this.pickups.keys()]) { this.collect(id); }
    }

    createPickup(row, col, amount, source) {
        const pickup = { id: this.id("pickup-"), row, col, amount, source, createdAt: this.time, autoAt: this.time + 8 };
        this.pickups.set(pickup.id, pickup);
        this.stats.generated += amount;
        this.emit("pickup", { ...pickup });
    }

    spawn(entry) {
        const rule = ENEMY_RULES[entry.type];
        if (!rule) { throw new Error(`未知魔物：${entry.type}`); }
        const hp = Math.round(rule.hp * (entry.hpScale || 1));
        const enemy = { id: this.id("enemy-"), type: entry.type, row: entry.row, x: entry.x ?? this.level.cols + .6,
            hp, maxHp: hp, speed: rule.speed, nextAttack: this.time,
            state: "walking", targetId: null, wave: entry.wave,
            armor: rule.armor || 0, maxArmor: rule.armor || 0,
            slowUntil: 0, slowFactor: 0, stunUntil: 0, vulnerableUntil: 0, vulnerable: 0,
            weakenUntil: 0, weaken: 0, burnUntil: 0, burnDps: 0, nextBurn: 0,
            hopped: false, revived: false, reviveAt: null,
            nextSpecial: this.time + (rule.healer?.period || rule.summon?.period || 0), summoned: !!entry.summoned };
        this.enemies.set(enemy.id, enemy);
        this.wave = Math.max(this.wave, entry.wave);
        this.emit("spawned", { id: enemy.id, enemyType: enemy.type, row: enemy.row, x: enemy.x, wave: entry.wave,
            summoned: enemy.summoned, boss: !!rule.boss, elite: !!entry.elite });
        return enemy;
    }

    step(seconds = TICK) {
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 1) { throw new Error("模拟步长必须为0–1秒"); }
        if (this.phase !== "running" || this.pauses.size) { this.accumulator = 0; return; }
        this.accumulator += seconds;
        while (this.accumulator + EPS >= TICK && this.phase === "running" && !this.pauses.size) {
            this.accumulator -= TICK;
            this.tick++;
            this.time = this.tick * TICK;
            this.tickOnce();
        }
        if (this.phase !== "running") { this.accumulator = 0; }
    }

    tickOnce() {
        while (this.nextNatural <= this.time + EPS) {
            const ordinal = Math.round((this.nextNatural - this.level.naturalFirst) / this.level.naturalPeriod);
            const row = (ordinal * 2 + 1) % this.level.rows;
            const col = 1 + (ordinal * 3) % Math.max(1, this.level.cols - 2);
            this.createPickup(row, col, this.level.naturalAmount, "natural");
            this.nextNatural += this.level.naturalPeriod;
        }
        for (const unit of this.units.values()) {
            const rule = UNIT_RULES[unit.type];
            if (rule.kind === "producer" && this.time + EPS >= unit.nextIncome) {
                this.createPickup(unit.row, unit.col, Math.round(rule.income * (this.townProducer || 1)), unit.id);
                unit.nextIncome += rule.incomePeriod;
                this.emit("produced", { id: unit.id });
            }
            if (rule.kind === "beacon" && this.time + EPS >= unit.nextAction) {
                unit.nextAction = this.time + rule.period;
                this.pending.push({ kind: "beacon", at: this.time, source: unit.id });
            }
        }
        for (const pickup of this.pickups.values()) {
            if (this.time + EPS >= pickup.autoAt) { this.collect(pickup.id); }
        }
        if (this.level.endless && this.spawnIndex >= this.spawns.length) { this.planWave(); }
        for (let i = this.spawnIndex; i < this.spawns.length; i++) {
            const spawn = this.spawns[i];
            if (spawn.at - this.level.warningLead > this.time + EPS) { break; }
            if (!this.warned.has(spawn.index)) {
                this.warned.add(spawn.index);
                this.emit("warning", { row: spawn.row, enemyType: spawn.type, at: spawn.at, wave: spawn.wave });
            }
        }
        while (this.spawnIndex < this.spawns.length && this.spawns[this.spawnIndex].at <= this.time + EPS) {
            this.spawn(this.spawns[this.spawnIndex++]);
        }
        const due = this.pending.filter(action => action.at <= this.time + EPS);
        this.pending = this.pending.filter(action => action.at > this.time + EPS);
        for (const action of due) { this.resolveAction(action); }
        for (const enemy of [...this.enemies.values()]) {
            if (this.enemies.has(enemy.id)) { this.updateEnemy(enemy); }
            if (this.phase !== "running") { return; }
        }
        for (const unit of [...this.units.values()]) { if (this.units.has(unit.id)) { this.updateUnit(unit); } }
        this.updateProjectiles();
        this.updateLobs();
        if (this.phase === "running" && !this.level.endless && this.spawnIndex === this.spawns.length && this.enemies.size === 0) {
            this.phase = "won";
            this.pending = [];
            this.projectiles.clear();
            this.lobs.clear();
            this.emit("finished", { result: "won", stats: { ...this.stats } });
        }
    }

    frontUnit(enemy) {
        let blocker = null;
        for (const unit of this.units.values()) {
            const edge = unit.col + .55;
            if (unit.row === enemy.row && edge <= enemy.x + EPS && (!blocker || unit.col > blocker.col)) { blocker = unit; }
        }
        return blocker;
    }

    updateEnemy(enemy) {
        const rule = ENEMY_RULES[enemy.type];
        if (enemy.state === "reviving") {
            if (this.time + EPS >= enemy.reviveAt) {
                enemy.hp = Math.round(enemy.maxHp * rule.revive.ratio);
                enemy.state = "walking";
                enemy.nextAttack = this.time + rule.period;
                this.emit("enemyRevived", { id: enemy.id, hp: enemy.hp });
            }
            return;
        }
        // 原作「ロックアーマー」：3 秒未被击中就开始自动修补护甲。
        if (rule.rockArmor && enemy.armor < (enemy.maxArmor ?? enemy.armor)) {
            if (!enemy.armorBrokenAt) { enemy.armorBrokenAt = this.time; }
            if (this.time - enemy.armorBrokenAt >= rule.rockArmor.delay) {
                const before = enemy.armor;
                enemy.armor = Math.min(enemy.maxArmor ?? before, enemy.armor + rule.rockArmor.regenPerSec * TICK);
                if (Math.round(enemy.armor) > Math.round(before)) { enemy.armorBrokenAt = this.time - rule.rockArmor.delay; }
            }
        }
        if (active(enemy.burnUntil, this.time) && this.time + EPS >= enemy.nextBurn) {
            enemy.nextBurn = this.time + .5;
            this.damageEnemy(enemy, Math.max(1, Math.round(enemy.burnDps * .5)), "burn");
            if (!this.enemies.has(enemy.id) || enemy.state === "reviving") { return; }
        }
        if (active(enemy.stunUntil, this.time)) { enemy.state = "stunned"; enemy.targetId = null; return; }
        if (rule.healer && this.time + EPS >= enemy.nextSpecial) {
            enemy.nextSpecial = this.time + rule.healer.period;
            const healed = [];
            for (const other of this.enemies.values()) {
                if (other === enemy || other.state === "reviving" || other.hp >= other.maxHp) { continue; }
                if (Math.abs(other.row - enemy.row) <= 1 && Math.abs(other.x - enemy.x) <= rule.healer.reach) {
                    const amount = Math.min(rule.healer.amount, other.maxHp - other.hp);
                    other.hp += amount; healed.push({ id: other.id, amount });
                }
            }
            this.emit("enemySpores", { id: enemy.id, healed });
        }
        if (rule.summon && this.time + EPS >= enemy.nextSpecial) {
            enemy.nextSpecial = this.time + rule.summon.period;
            const rows = [enemy.row - 1, enemy.row + 1].filter(row => row >= 0 && row < this.level.rows);
            if (!rows.length) { rows.push(enemy.row); }
            for (let i = 0; i < rule.summon.count; i++) {
                this.spawn({ type: rule.summon.type, row: rows[i % rows.length], wave: enemy.wave, x: Math.min(this.level.cols + .6, enemy.x + .4), summoned: true });
            }
            this.emit("summon", { id: enemy.id });
        }
        // 原作「バトルクライ」：第一次望见同伴时嗥叫，为周围来客提速。
        if (rule.battleCry && !enemy.cried) {
            const sight = this.frontUnit(enemy);
            if (sight) {
                enemy.cried = true;
                const boosted = [];
                for (const other of this.enemies.values()) {
                    if (other === enemy || other.state === "reviving") { continue; }
                    if (Math.abs(other.row - enemy.row) <= 1 && Math.abs(other.x - enemy.x) <= rule.battleCry.reach) {
                        other.cryHaste = Math.max(other.cryHaste || 0, rule.battleCry.haste);
                        other.cryUntil = Math.max(other.cryUntil || 0, this.time + rule.battleCry.duration);
                        boosted.push(other.id);
                    }
                }
                this.emit("battleCry", { id: enemy.id, boosted, haste: rule.battleCry.haste, duration: rule.battleCry.duration });
            }
        }
        // 原作「クッマッマー」：周期性低吼，推迟相邻两路同伴的下一次出手。
        if (rule.roar && this.time + EPS >= (enemy.nextRoar ?? this.time)) {
            enemy.nextRoar = this.time + rule.roar.period;
            const affected = [];
            for (const unit of this.units.values()) {
                if (Math.abs(unit.row - enemy.row) <= 1 && Math.abs(unit.col - enemy.x) <= 2) {
                    const uRule = this.unitRule(unit);
                    if (!uRule.immuneStun) { unit.nextAction = Math.max(unit.nextAction, this.time) + rule.roar.delay; affected.push(unit.id); }
                }
            }
            if (affected.length) { this.emit("enemyRoar", { id: enemy.id, affected, delay: rule.roar.delay }); }
        }
        const crySpeed = active(enemy.cryUntil, this.time) ? 1 + (enemy.cryHaste || 0) : 1;
        const slow = active(enemy.slowUntil, this.time) ? 1 - enemy.slowFactor : 1;
        const speedFactor = slow * crySpeed;
        const blocker = this.frontUnit(enemy);
        const next = enemy.x - rule.speed * speedFactor * TICK;
        if (rule.ranged && blocker && enemy.x - (blocker.col + .55) <= rule.ranged.range + EPS) {
            enemy.state = "shooting";
            enemy.targetId = blocker.id;
            if (enemy.nextAttack <= this.time + EPS) {
                enemy.nextAttack = this.time + rule.ranged.period;
                this.pending.push({ kind: "enemyShot", at: this.time + rule.ranged.windup, source: enemy.id, target: blocker.id });
                this.emit("enemyAttack", { id: enemy.id, target: blocker.id, ranged: true, windup: rule.ranged.windup });
            }
        } else if (blocker && next <= blocker.col + .55 + EPS) {
            if (rule.hop && !enemy.hopped && !UNIT_RULES[blocker.type].tall) {
                enemy.hopped = true;
                const from = enemy.x;
                enemy.x = blocker.col - .6;
                enemy.state = "walking";
                enemy.targetId = null;
                this.emit("enemyHop", { id: enemy.id, from, to: enemy.x, over: blocker.id });
            } else {
                enemy.x = blocker.col + .55;
                enemy.state = "attacking";
                enemy.targetId = blocker.id;
                if (enemy.nextAttack <= this.time + EPS) {
                    enemy.nextAttack = this.time + rule.period;
                    this.pending.push({ kind: "enemyHit", at: this.time + rule.windup, source: enemy.id, target: blocker.id });
                    this.emit("enemyAttack", { id: enemy.id, target: blocker.id });
                }
            }
        } else {
            enemy.state = "walking";
            enemy.targetId = null;
            enemy.x = next;
        }
        if (enemy.x <= -.65) {
            if (this.gates[enemy.row]) {
                this.gates[enemy.row] = false;
                this.stats.gatesUsed++;
                this.emit("gate", { row: enemy.row });
                for (const other of [...this.enemies.values()]) {
                    if (other.row === enemy.row) { this.killEnemy(other, "gate"); }
                }
            } else {
                this.phase = "lost";
                this.stats.breachRow = enemy.row;
                this.pending = [];
                this.projectiles.clear();
                this.lobs.clear();
                this.emit("finished", { result: "lost", row: enemy.row, wave: this.wave, stats: { ...this.stats } });
            }
        }
    }

    targetFor(unit, rule) {
        let target = null;
        for (const enemy of this.enemies.values()) {
            if (enemy.state === "reviving") { continue; }
            if (attackContains(unit, enemy, rule)
                && (!target || enemy.x < target.x || enemy.x === target.x && enemy.id < target.id)) { target = enemy; }
        }
        return target;
    }

    // Nearest enemy strictly on `row` for multi-lane shooters.
    targetOnRow(unit, rule, row) {
        let target = null;
        for (const enemy of this.enemies.values()) {
            if (enemy.state === "reviving" || enemy.row !== row) { continue; }
            const distance = enemy.x - unit.col;
            if (distance < -ATTACK_BACK_REACH || distance > rule.range) { continue; }
            if (!target || enemy.x < target.x || enemy.x === target.x && enemy.id < target.id) { target = enemy; }
        }
        return target;
    }

    cadence(unit, period) {
        return period * (active(unit.hasteUntil, this.time) ? 1 - unit.haste : 1);
    }

    updateUnit(unit) {
        const rule = this.unitRule(unit);
        if (rule.barrier && this.time + EPS >= unit.nextBarrier) {
            unit.nextBarrier = this.time + rule.barrier.period;
            unit.barrierHits = rule.barrier.hits;
            this.emit("unitAction", { id: unit.id, action: "barrier", target: unit.id });
        }
        if (rule.selfHeal && this.time + EPS >= unit.nextSelfHeal && unit.hp < unit.maxHp) {
            unit.nextSelfHeal = this.time + rule.selfHeal.period;
            const amount = Math.min(Math.round(unit.maxHp * rule.selfHeal.ratio), unit.maxHp - unit.hp);
            unit.hp += amount;
            this.stats.healed += amount;
            this.emit("unitAction", { id: unit.id, action: "selfheal", target: unit.id });
            this.emit("healed", { id: unit.id, source: unit.id, amount, hp: unit.hp });
        }
        if (rule.kind === "producer" || rule.kind === "beacon" || unit.nextAction > this.time + EPS) { return; }
        if (rule.kind === "healer") {
            // 溢出治疗（原作 overheal 装备）：带 overhealCap 的治疗者把
            // 「已满血」也算作可治疗对象，上限是 maxHp+overhealCap。
            const capOf = other => rule.overhealCap ? other.hp < other.maxHp + rule.overhealCap : other.hp < other.maxHp;
            const candidates = [...this.units.values()].filter(other => capOf(other)
                && (rule.area ? areaContains(unit, other) : healingContains(unit, other, rule)));
            candidates.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id.localeCompare(b.id));
            if (!candidates.length) { return; }
            unit.nextAction = this.time + this.cadence(unit, rule.period);
            this.pending.push({ kind: rule.area ? "healArea" : "heal", at: this.time + rule.windup, source: unit.id, target: candidates[0].id });
            this.emit("unitAction", { id: unit.id, action: "heal", target: candidates[0].id, area: !!rule.area });
            return;
        }
        if (rule.kind === "shielder") {
            const candidates = [...this.units.values()].filter(other => areaContains(unit, other) && other.shield < rule.maxShield
                && (other.hp < other.maxHp || other.shield === 0));
            candidates.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.shield - b.shield || a.id.localeCompare(b.id));
            const threatened = candidates.filter(other => [...this.enemies.values()].some(enemy => enemy.row === other.row));
            const target = threatened[0] || (candidates[0]?.hp < candidates[0]?.maxHp ? candidates[0] : null);
            if (!target) { return; }
            unit.nextAction = this.time + this.cadence(unit, rule.period);
            this.pending.push({ kind: "shield", at: this.time + rule.windup, source: unit.id, target: target.id });
            this.emit("unitAction", { id: unit.id, action: "shield", target: target.id });
            return;
        }
        const target = this.targetFor(unit, rule);
        if (!target) { return; }
        if (rule.guardReduction && unit.nextGuard <= this.time + EPS && unit.hp < unit.maxHp) {
            unit.nextGuard = this.time + rule.guardPeriod;
            unit.guardUntil = this.time + rule.guardDuration;
            unit.nextAction = this.time + 2.4;
            this.emit("unitAction", { id: unit.id, action: "guard", target: unit.id });
            return;
        }
        unit.attacks++;
        const gearSkill = rule.gearSkill && unit.attacks % rule.gearSkill.every === 0 ? rule.gearSkill : null;
        const special = gearSkill || (rule.special && unit.attacks % rule.special.every === 0 ? rule.special : null);
        unit.nextAction = this.time + this.cadence(unit, rule.period);
        const kind = rule.kind === "shooter" ? "shoot" : rule.kind === "lobber" ? "lob" : "melee";
        const shots = kind === "shoot" && rule.volley ? rule.volley : 1;
        for (let i = 0; i < shots; i++) {
            this.pending.push({ kind, at: this.time + rule.windup + i * (rule.volleyGap || 0), source: unit.id, target: target.id, special, shot: i });
        }
        if (kind === "shoot" && rule.multi) {
            const gap = rule.multi.gap || 0;
            const lanes = [target.row];
            for (let r = Math.max(0, unit.row - rule.multi.rows); r <= Math.min(this.level.rows - 1, unit.row + rule.multi.rows); r++) {
                if (r === unit.row) { continue; }
                let laneTarget = null;
                for (const enemy of this.enemies.values()) {
                    if (enemy.state === "reviving" || enemy.row !== r) { continue; }
                    const distance = enemy.x - unit.col;
                    if (distance < -ATTACK_BACK_REACH || distance > rule.range) { continue; }
                    if (!laneTarget || enemy.x < laneTarget.x || enemy.x === laneTarget.x && enemy.id < laneTarget.id) { laneTarget = enemy; }
                }
                if (!laneTarget) { continue; }
                lanes.push(r);
                const offset = lanes.length - 1;
                for (let i = 0; i < shots; i++) {
                    this.pending.push({ kind, at: this.time + rule.windup + offset * gap + i * (rule.volleyGap || 0),
                        source: unit.id, target: laneTarget.id, special, shot: i, laneRow: r });
                }
            }
        }
        this.emit("unitAction", { id: unit.id, action: special ? "skill" : "attack", special: special?.type || null, target: target.id, volley: shots });
    }

    resolveAction(action) {
        if (this.phase !== "running") { return; }
        if (action.kind === "burst") {
            const rule = UNIT_RULES[action.type];
            this.emit("burst", { id: action.id, row: action.row, col: action.col, radius: rule.radius, freeze: rule.freeze?.duration || 0 });
            for (const enemy of [...this.enemies.values()]) {
                if (burstContains(action, enemy, rule)) {
                    this.damageEnemy(enemy, rule.damage, action.id);
                    // F12 冻结术式: survivors of the blast stay frozen.
                    if (rule.freeze && this.enemies.has(enemy.id)) { enemy.stunUntil = Math.max(enemy.stunUntil, this.time + rule.freeze.duration); }
                }
            }
            return;
        }
        if (action.kind === "beacon") {
            const unit = this.units.get(action.source);
            const rule = unit && UNIT_RULES[unit.type];
            if (!unit || !rule) { return; }
            const boosted = [];
            for (const other of this.units.values()) {
                if (other !== unit && areaContains(unit, other) && UNIT_RULES[other.type].kind !== "producer") {
                    other.hasteUntil = this.time + rule.hasteDuration;
                    other.haste = Math.max(active(other.hasteUntil, this.time) ? other.haste : 0, rule.haste);
                    boosted.push(other.id);
                }
            }
            if (boosted.length) { this.emit("beaconPulse", { id: unit.id, row: unit.row, col: unit.col, boosted }); }
            return;
        }
        if (action.kind === "enemyHit" || action.kind === "enemyShot") {
            const enemy = this.enemies.get(action.source);
            const unit = this.units.get(action.target);
            if (!enemy || !unit || enemy.state === "reviving" || active(enemy.stunUntil, this.time)) { return; }
            if (action.kind === "enemyHit" && (enemy.row !== unit.row || Math.abs(enemy.x - (unit.col + .55)) > .08)) { return; }
            if (action.kind === "enemyShot" && enemy.row !== unit.row) { return; }
            const rule = ENEMY_RULES[enemy.type];
            const unitRule = UNIT_RULES[unit.type];
            if (action.kind === "enemyShot") { this.emit("enemyShot", { id: enemy.id, target: unit.id }); }
            const reduction = unit.guardUntil > this.time ? unitRule.guardReduction || 0 : 0;
            const weaken = active(enemy.weakenUntil, this.time) ? enemy.weaken : 0;
            const base = action.kind === "enemyShot" ? rule.ranged.damage : rule.damage;
            this.hurtUnit(unit, Math.max(1, Math.round(base * (1 - reduction) * (1 - weaken))), enemy.id);
            return;
        }
        const unit = this.units.get(action.source);
        if (!unit) { return; }
        const rule = this.unitRule(unit);
        if (action.kind === "heal" || action.kind === "healArea") {
            const primary = this.units.get(action.target);
            const receivers = action.kind === "healArea"
                ? [...this.units.values()].filter(other => areaContains(unit, other) && (rule.overhealCap ? other.hp < other.maxHp + rule.overhealCap : other.hp < other.maxHp))
                : primary && healingContains(unit, primary, rule) ? [primary] : [];
            for (const ally of receivers) {
                const healCap = rule.overhealCap ? ally.maxHp + rule.overhealCap - ally.hp : ally.maxHp - ally.hp;
                const amount = Math.min(Math.round(rule.healing * (this.townHeal || 1)), healCap);
                if (amount <= 0) { continue; }
                ally.hp += amount;
                this.stats.healed += amount;
                this.emit("healed", { id: ally.id, source: unit.id, amount, hp: ally.hp });
            }
            return;
        }
        if (action.kind === "shield") {
            const ally = this.units.get(action.target);
            if (!ally || !areaContains(unit, ally)) { return; }
            const before = ally.shield;
            ally.shield = Math.min(rule.maxShield, ally.shield + rule.shield);
            ally.maxShield = Math.max(ally.maxShield, ally.shield);
            this.stats.shielded += ally.shield - before;
            this.emit("shielded", { id: ally.id, source: unit.id, shield: ally.shield });
            return;
        }
        const target = this.enemies.get(action.target) || this.targetFor(unit, rule);
        if (action.kind === "lob") {
            const aim = target && target.state !== "reviving" && attackContains(unit, target, rule) ? target : this.targetFor(unit, rule);
            if (!aim) { return; }
            const lob = { id: this.id("lob-"), source: unit.id, unitType: unit.type, row: unit.row, targetId: aim.id,
                x: aim.x, landAt: this.time + rule.flight, damage: rule.damage, special: action.special };
            this.lobs.set(lob.id, lob);
            this.emit("lob", { id: lob.id, source: unit.id, targetId: aim.id, row: unit.row, flight: rule.flight, special: action.special?.type || null });
            return;
        }
        const special = action.special;
        if (action.kind === "shoot") {
            const wave = special?.type === "wave";
            const multiplier = special?.type === "power" || special?.type === "critical" ? special.multiplier : 1;
            const laneRow = Number.isInteger(action.laneRow) ? action.laneRow : unit.row;
            let shotTarget = target;
            if (laneRow !== unit.row) {
                shotTarget = this.targetOnRow(unit, rule, laneRow);
                if (!shotTarget || shotTarget.state === "reviving") { return; }
                if (shotTarget.row !== laneRow || shotTarget.x - unit.col < -ATTACK_BACK_REACH || shotTarget.x - unit.col > rule.range) { return; }
            } else {
                if (!shotTarget || shotTarget.state === "reviving" || !attackContains(unit, shotTarget, rule)) { return; }
            }
            const projectile = { id: this.id("projectile-"), source: unit.id, unitType: unit.type,
                row: laneRow, x: unit.col + .22, previousX: unit.col + .22, targetId: shotTarget.id,
                speed: rule.projectileSpeed * (wave ? .8 : 1), damage: wave ? special.damage : rule.damage * multiplier,
                createdAt: this.time, pierce: !!rule.pierce || wave, wave, critical: special?.type === "critical",
                pierceBoost: rule.pierceArmorDamageBoost || 1,
                hit: [], onHit: this.skillOnHit(special, { ...(rule.onHit || {}) }), splash: rule.splash || 0, splashDamage: rule.splashDamage || 0, shot: action.shot };
            this.projectiles.set(projectile.id, projectile);
            this.emit("projectile", { ...projectile, hit: undefined });
            return;
        }
        if (!target || target.state === "reviving" || !attackContains(unit, target, rule)) { return; }
        // Melee.
        const victims = rule.cleave
            ? [...this.enemies.values()].filter(enemy => enemy.state !== "reviving" && attackContains(unit, enemy, rule))
            : [target];
        let amount = rule.damage;
        if (special?.type === "critical") { amount *= special.multiplier; }
        if (special?.type === "expose") { amount = special.damage; }
        for (const enemy of victims) {
            const onHit = {};
            this.skillOnHit(special, onHit);
            if (rule.sleepChance && this.rng && this.rng() < rule.sleepChance) {
                enemy.stunUntil = Math.max(enemy.stunUntil, this.time + 1.2);
                this.emit("status", { id: enemy.id, statuses: ["stun"], source: unit.id });
            }
            this.hitEnemy(enemy, amount, unit.id, { pierceArmor: rule.pierceArmor, pierceBoost: rule.pierceArmorDamageBoost || 1, stunBonus: rule.stunBonus, onHit,
                critical: special?.type === "critical" });
            const thorns = ENEMY_RULES[enemy.type].thorns;
            if (thorns && this.units.has(unit.id)) { this.hurtUnit(unit, thorns, enemy.id, "thorns"); }
        }
    }

    hurtUnit(unit, amount, source, kind = "hit") {
        if (unit.barrierHits > 0) {
            unit.barrierHits--;
            this.stats.blocked++;
            this.emit("blocked", { id: unit.id, source, left: unit.barrierHits });
            return;
        }
        let remaining = amount;
        if (unit.shield > 0) {
            const absorbed = Math.min(unit.shield, remaining);
            unit.shield -= absorbed; remaining -= absorbed;
            if (unit.shield === 0) { unit.maxShield = 0; }
        }
        const uRule = this.unitRule(unit);
        if (uRule.lastStand && !unit.lastStandUsed && remaining >= unit.hp) {
            // 原作「1回だけHPが1残り全回復」：濒死免死一次并全恢复。
            unit.lastStandUsed = true;
            unit.hp = uRule.maxHp || unit.maxHp;
            this.emit("lastStand", { id: unit.id, hp: unit.hp });
            return;
        }
        unit.hp = Math.max(0, unit.hp - remaining);
        this.emit("unitHurt", { id: unit.id, amount, hp: unit.hp, shield: unit.shield, source, kind });
        if (unit.hp === 0) { this.stats.defeatedUnits++; this.removeUnit(unit, "defeated"); }
    }

    // A stat bonus scales whichever number a skill actually deals with.
    boostedSkill(skill, bonus) {
        const scaled = { ...skill };
        if (skill.type === "wave") { scaled.damage = Math.round((skill.damage || 0) * (1 + bonus)); }
        else if (skill.type === "expose") {
            // Expose scales two levers: flat damage, or the vulnerability it paints.
            if (skill.damage) { scaled.damage = Math.round(skill.damage * (1 + bonus)); }
            if (skill.vulnerable) { scaled.vulnerable = Math.min(1, skill.vulnerable * (1 + bonus)); }
        }
        else if (skill.type === "critical" || skill.type === "power") { scaled.multiplier = skill.multiplier * (1 + bonus); }
        else if (skill.type === "knockback") { scaled.distance = skill.distance * (1 + bonus); }
        else if (skill.type === "stun") { scaled.duration = skill.duration * (1 + bonus); }
        return scaled;
    }
    // on-hit statuses; critical/power/wave are already baked into the damage.
    skillOnHit(special, onHit) {
        if (special?.type === "expose") { onHit.vulnerable = special.vulnerable; onHit.vulnerableDuration = special.duration; }
        if (special?.type === "knockback") { onHit.knockback = special.distance; }
        if (special?.type === "stun") { onHit.stun = special.duration; }
        return onHit;
    }
    hitEnemy(enemy, amount, source, options = {}) {
        if (!this.enemies.has(enemy.id) || enemy.state === "reviving") { return; }
        let damage = amount;
        if (active(enemy.vulnerableUntil, this.time)) { damage *= 1 + enemy.vulnerable; }
        if (options.stunBonus && active(enemy.stunUntil, this.time)) { damage *= options.stunBonus; }
        this.damageEnemy(enemy, Math.max(1, Math.round(damage)), source, options);
        if (!this.enemies.has(enemy.id) || enemy.state === "reviving") { return; }
        const hit = options.onHit || {};
        const applied = [];
        if (hit.slow) {
            enemy.slowFactor = active(enemy.slowUntil, this.time) ? Math.max(enemy.slowFactor, hit.slow) : hit.slow;
            enemy.slowUntil = Math.max(enemy.slowUntil, this.time + hit.slowDuration); applied.push("slow");
        }
        if (hit.vulnerable) {
            enemy.vulnerable = active(enemy.vulnerableUntil, this.time) ? Math.max(enemy.vulnerable, hit.vulnerable) : hit.vulnerable;
            enemy.vulnerableUntil = Math.max(enemy.vulnerableUntil, this.time + hit.vulnerableDuration); applied.push("vulnerable");
        }
        if (hit.weaken) {
            enemy.weaken = active(enemy.weakenUntil, this.time) ? Math.max(enemy.weaken, hit.weaken) : hit.weaken;
            enemy.weakenUntil = Math.max(enemy.weakenUntil, this.time + hit.weakenDuration); applied.push("weaken");
        }
        if (hit.burn) {
            enemy.burnDps = Math.max(active(enemy.burnUntil, this.time) ? enemy.burnDps : 0, hit.burn);
            if (!active(enemy.burnUntil, this.time)) { enemy.nextBurn = this.time + .5; }
            enemy.burnUntil = Math.max(enemy.burnUntil, this.time + hit.burnDuration); applied.push("burn");
        }
        if (hit.stun) { enemy.stunUntil = Math.max(enemy.stunUntil, this.time + hit.stun); applied.push("stun"); }
        if (hit.knockback) {
            enemy.x = Math.min(this.level.cols + .6, enemy.x + hit.knockback);
            enemy.state = "walking"; enemy.targetId = null; applied.push("knockback");
        }
        if (hit.delayAttack) { enemy.nextAttack = Math.max(enemy.nextAttack, this.time) + hit.delayAttack; applied.push("delay"); }
        if (applied.length) { this.emit("status", { id: enemy.id, statuses: applied, source }); }
    }

    updateProjectiles() {
        for (const projectile of [...this.projectiles.values()]) {
            projectile.previousX = projectile.x;
            projectile.x += projectile.speed * TICK;
            const candidates = [...this.enemies.values()].filter(enemy => enemy.row === projectile.row && enemy.state !== "reviving"
                && !projectile.hit.includes(enemy.id) && enemy.x + .2 >= projectile.previousX && enemy.x - .2 <= projectile.x);
            candidates.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
            const struck = projectile.pierce ? candidates : candidates.slice(0, 1);
            for (const enemy of struck) {
                projectile.hit.push(enemy.id);
                const onHit = projectile.onHit ? { ...projectile.onHit } : {};
                const sleepRule = this.units.has(projectile.source) ? this.unitRule(this.units.get(projectile.source)) : null;
                if (sleepRule?.sleepChance && this.rng && this.rng() < sleepRule.sleepChance) {
                    enemy.stunUntil = Math.max(enemy.stunUntil, this.time + 1.2);
                    this.emit("status", { id: enemy.id, statuses: ["stun"], source: projectile.source });
                }
                this.hitEnemy(enemy, projectile.damage, projectile.source, { onHit, critical: projectile.critical, pierceBoost: projectile.pierceBoost || 1 });
                if (projectile.splash > 0) { this.splash(enemy, projectile.row, projectile.splash, projectile.splashDamage, projectile.source, {}); }
            }
            if (struck.length && !projectile.pierce) {
                this.projectiles.delete(projectile.id);
                this.emit("projectileRemoved", { id: projectile.id, hit: struck[0].id });
            } else if (projectile.x > this.level.cols + 1.4) {
                this.projectiles.delete(projectile.id);
                this.emit("projectileRemoved", { id: projectile.id, hit: null });
            }
        }
    }

    updateLobs() {
        for (const lob of [...this.lobs.values()]) {
            const target = this.enemies.get(lob.targetId);
            if (target && target.state !== "reviving") { lob.x = target.x; }
            if (lob.landAt > this.time + EPS) { continue; }
            this.lobs.delete(lob.id);
            const rule = UNIT_RULES[lob.unitType];
            let victim = target && target.state !== "reviving" ? target : null;
            if (!victim) {
                victim = [...this.enemies.values()].filter(enemy => enemy.row === lob.row && enemy.state !== "reviving" && Math.abs(enemy.x - lob.x) <= .6)
                    .sort((a, b) => Math.abs(a.x - lob.x) - Math.abs(b.x - lob.x) || a.id.localeCompare(b.id))[0] || null;
            }
            this.emit("lobLanded", { id: lob.id, row: lob.row, x: lob.x, hit: victim?.id || null, source: lob.source });
            if (!victim) { continue; }
            const onHit = { ...(rule.onHit || {}) };
            this.skillOnHit(lob.special, onHit);
            const { splash, splashDamage } = onHit;
            delete onHit.splash; delete onHit.splashDamage;
            this.hitEnemy(victim, rule.damage, lob.source, { onHit });
            if (splash) { this.splash(victim, lob.row, splash, splashDamage, lob.source, rule.onHit?.slow ? { slow: rule.onHit.slow, slowDuration: rule.onHit.slowDuration } : {}); }
        }
    }

    splash(center, row, radius, damage, source, onHit) {
        for (const other of [...this.enemies.values()]) {
            if (other.id === center.id || other.state === "reviving") { continue; }
            if (Math.abs(other.row - row) <= 1 && Math.abs(other.x - center.x) <= radius) {
                this.hitEnemy(other, damage, source, { onHit });
            }
        }
    }

    damageEnemy(enemy, amount, source, options = {}) {
        if (!this.enemies.has(enemy.id) || enemy.state === "reviving") { return; }
        let absorbed = 0;
        if (options.pierceArmor) {
            const boost = options.pierceBoost || 1;
            if (enemy.armor > 0) { const broken = Math.min(enemy.armor, amount); enemy.armor -= broken; enemy.armorBrokenAt = this.time; this.emit("armorBroken", { id: enemy.id, source, stripped: broken }); }
            amount = Math.round(amount * boost);
        } else {
            absorbed = Math.min(enemy.armor, amount);
            enemy.armor -= absorbed;
            if (absorbed > 0) { enemy.armorBrokenAt = this.time; }
        }
        const dealt = amount - absorbed;
        enemy.lastHitBy = source;
        enemy.hp = Math.max(0, enemy.hp - dealt);
        this.emit("enemyHurt", { id: enemy.id, amount: dealt, absorbed, hp: enemy.hp, armor: enemy.armor, source, critical: !!options.critical });
        if (enemy.hp === 0) {
            const revive = ENEMY_RULES[enemy.type].revive;
            if (revive && !enemy.revived && source !== "gate") {
                enemy.revived = true;
                enemy.state = "reviving";
                enemy.reviveAt = this.time + revive.delay;
                enemy.targetId = null;
                enemy.stunUntil = 0; enemy.slowUntil = 0; enemy.burnUntil = 0;
                this.emit("enemyDown", { id: enemy.id, revive: true });
                return;
            }
            this.killEnemy(enemy, source === "gate" ? "gate" : "defeated");
        }
    }

    killEnemy(enemy, reason) {
        if (!this.enemies.has(enemy.id)) { return; }
        this.enemies.delete(enemy.id);
        this.stats.kills++;
        if (enemy.lastHitBy && this.units.has(enemy.lastHitBy)) {
            const killer = this.units.get(enemy.lastHitBy);
            const killerRule = this.unitRule(killer);
            if (killerRule.hasteOnKill) {
                // 原作「敵を倒すたび行動速度アップ」：击杀后缩短下一次出手。
                killer.nextAction = Math.max(this.time, killer.nextAction - killerRule.period * killerRule.hasteOnKill);
                this.emit("killHaste", { id: killer.id, source: enemy.id });
            }
        }
        if (this.level.endless && !enemy.summoned) {
            const bound = this.waveBounds.get(enemy.wave);
            // 断点续玩：断点前已击退的本波成员已把 remaining 预扣过，
            // 敌人本体却不在存档里——这条击退不能再次计数。
            if (bound && this._resumeWaveKilled > 0 && enemy.wave === this.wave) { this._resumeWaveKilled--; }
            else if (bound && --bound.remaining === 0) {
                this.stats.wavesCleared++;
                const bonus = 25 + 5 * Math.floor(enemy.wave / 5);
                this.resource += bonus;
                this.stats.generated += bonus;
                this.emit("waveCleared", { wave: enemy.wave, bonus, modifier: bound.modifier?.kind || null });
                // Every fifth wave cleared grants one card-swap credit, so long
                // runs can rotate the bench without restarting the level.
                if (enemy.wave > 0 && enemy.wave % 5 === 0) {
                    this.restocks++;
                    // 城镇素材掉落（原作 QuestWaveDrops 概率表折算）：
                    // 每清 5 波必掉 1 个职业象征，35% 概率再掉 1 个。
                    const materials = ["M1", "M2", "M3", "M4", "M5"];
                    const drops = [materials[Math.floor(this.rng() * materials.length)]];
                    if (this.rng() < .35) { drops.push(materials[Math.floor(this.rng() * materials.length)]); }
                    this.materials = this.materials || [];
                    this.materials.push(...drops);
                    this.emit("restockEarned", { wave: enemy.wave, credits: this.restocks, drops });
                }
            }
        }
        this.emit("enemyRemoved", { id: enemy.id, reason });
    }

    removeUnit(unit, reason) {
        this.units.delete(unit.id);
        this.occupancy.delete(cellKey(unit.row, unit.col));
        this.emit("unitRemoved", { id: unit.id, unitType: unit.type, reason, row: unit.row, col: unit.col });
    }

    // Mutating a field of a unit rule in place would leak into UNIT_RULES —
    // gear instead clones the bonus onto the unit and resolves through
    // unitRule(unit) so the original rule stays frozen.
    applyGear(unit, gearRule) {
        unit.gear = gearRule.id;
        if (gearRule.gear.maxHp) {
            unit.maxHp += gearRule.gear.maxHp;
            if (gearRule.gear.heal) { unit.hp = Math.min(unit.maxHp, unit.hp + gearRule.gear.heal); }
        }
        if (gearRule.gear.barrier) { unit.barrierHits += gearRule.gear.barrier; }
        this.emit("gearApplied", { id: unit.id, gear: gearRule.id, row: unit.row, col: unit.col, label: gearRule.gear.label });
    }

    // 搭档加成：特定两张卡同时部署在同一战场时各自获得强化。
    static PAIRINGS = [
        { pair: ["U73", "U74"], label: "麻耶×惠", bonus: unit => {
            if (unit.type === "U73") { return { damage: Math.round(UNIT_RULES.U73.damage * .08) || 2 }; }
            return { extraShield: 15 }; } },
        { pair: ["U81", "U82"], label: "冠（情人节）×荣依子（情人节）", bonus: unit => {
            if (unit.type === "U81") { return { specialBonus: .1 }; }
            return { extraShield: 20 }; } },
    ];
    pairingBonus(unit) {
        // True when the partner named by a pairing table is also on the field.
        const out = {};
        for (const entry of Battle.PAIRINGS) {
            if (!entry.pair.includes(unit.type)) { continue; }
            const partner = entry.pair.find(id => id !== unit.type);
            const present = [...this.units.values()].some(other => other.type === partner);
            if (!present) { continue; }
            const b = entry.bonus(unit);
            Object.assign(out, b);
        }
        return out;
    }
    unitRule(unit) {
        const base = UNIT_RULES[unit.type];
        if (!unit.gear) { return this.withPairing(unit, base); }
        const key = `${base.id}+${unit.gear}`;
        if (!this._gearRuleCache) { this._gearRuleCache = new Map(); }
        if (!this._gearRuleCache.has(key)) {
            const merged = { ...base };
            const gear = UNIT_RULES[unit.gear].gear;
            if (gear.damage) { merged.damage = (base.damage || 0) + gear.damage; }
            if (gear.periodScale) { merged.period = base.period * gear.periodScale; }
            if (gear.maxHp) {
                // maxHp 已经在 applyGear 里通过 unit.maxHp 改了,这里不重复。
            }
            if (gear.specialBonus && base.special) { merged.special = this.boostedSkill(base.special, gear.specialBonus); }
            if (gear.pierceArmorBonus && base.pierceArmor) {
                // 既是 pierceArmor 又有 bonus → 输出额外乘数。
                merged.pierceArmorDamageBoost = 1 + gear.pierceArmorBonus;
            }
            if (gear.rowsBonus && base.multi) {
                merged.multi = { ...base.multi, rows: base.multi.rows + gear.rowsBonus };
            }
            if (gear.barrier) { merged.extraBarrierHits = gear.barrier; }
            if (gear.guardReductionBonus && base.guardReduction != null) {
                merged.guardReduction = Math.min(.95, base.guardReduction + gear.guardReductionBonus);
            }
            if (gear.critBoost && base.special && (base.special.type === "critical" || base.special.type === "power")) {
                merged.special = { ...merged.special, multiplier: merged.special.multiplier * (1 + gear.critBoost) };
            }
            if (gear.stunBonusPct && base.special && base.special.type === "stun") {
                merged.special = { ...merged.special, duration: merged.special.duration * (1 + gear.stunBonusPct) };
            }
            if (gear.knockbackBonusPct && base.special && base.special.type === "knockback") {
                merged.special = { ...merged.special, distance: merged.special.distance * (1 + gear.knockbackBonusPct) };
            }
            if (gear.waveLane) {
                // 原作「通常攻撃が全体攻撃になる」：第N次的贯穿波同时扫过上下两路。
                merged.multi = { ...(merged.multi || base.multi || { rows: 0, gap: .12 }), rows: (merged.multi?.rows || base.multi?.rows || 0) + 1 };
                merged.multi.gap = merged.multi.gap || .12;
            }
            if (gear.hasteOnKill) { merged.hasteOnKill = gear.hasteOnKill; }
            if (gear.sleepChance) { merged.sleepChance = gear.sleepChance; }
            if (gear.lastStand) { merged.lastStand = true; }
            if (gear.immuneStun) { merged.immuneStun = true; }
            if (gear.overheal) { merged.overhealCap = gear.overheal; }
            if (gear.skill) { merged.gearSkill = gear.specialBonus ? this.boostedSkill(gear.skill, gear.specialBonus) : { ...gear.skill }; }
            this._gearRuleCache.set(key, Object.freeze(merged));
        }

        const rule = this._gearRuleCache.get(key);
        return this.withPairing(unit, rule);
    }

    // 搭档加成叠加在 gear 合并之后的最终数值上（麻耶×惠、冠×荣依子）。
    withPairing(unit, rule) {
        const bonus = this.pairingBonus(unit);
        if (!Object.keys(bonus).length) { return rule; }
        const merged = { ...rule };
        if (bonus.damage) { merged.damage = (rule.damage || 0) + bonus.damage; }
        if (bonus.extraShield) { merged.shield = (rule.shield || 0) + bonus.extraShield; merged.maxShield = Math.max(rule.maxShield || 0, merged.shield); }
        if (bonus.specialBonus && rule.special) { merged.special = this.boostedSkill(rule.special, bonus.specialBonus); }
        return merged;
    }

    // Every cooldown the HUD needs — seed cards and carried gear alike. Gear is
    // not in `deck`, so deriving from `deck` alone would leave the tray blind
    // to its own cooldowns.
    cooldowns() {
        const ids = new Set([...this.deck, ...this.readyAt.keys()]);
        return Object.fromEntries([...ids].map(id => [id, Math.max(0, (this.readyAt.get(id) || 0) - this.time)]));
    }

    snapshot() {
        // The HUD polls this ~12×/s. Spawn-scan results are cached by
        // (spawnIndex, wave) so the two filter() passes only rerun when a
        // spawn actually fires; the row spreads remain but are the honest
        // cost of giving the HUD an immutable view.
        const scheduled = this.spawns.length - this.spawnIndex;
        if (this._waveTick !== this.spawnIndex + this.wave * 1e7) {
            this._waveTick = this.spawnIndex + this.wave * 1e7;
            const waveSpawns = this.spawns.filter(spawn => spawn.wave === this.wave).length;
            const waveDone = this.spawns.slice(0, this.spawnIndex).filter(spawn => spawn.wave === this.wave).length;
            this._waveCounts = { waveSpawns, waveDone };
        }
        const { waveSpawns, waveDone } = this._waveCounts;
        const currentBound = this.level.endless ? this.waveBounds.get(this.wave) : null;
        const nextBound = this.level.endless ? this.waveBounds.get(this.wave + 1) : null;
        return { level: this.level.id, phase: this.phase, time: this.time, resource: this.resource, endless: !!this.level.endless,
            wave: this.wave, waveModifier: currentBound?.modifier || null, nextWaveModifier: nextBound?.modifier || null,
            totalWaves: this.level.endless ? null : this.level.waves, scheduledRemaining: scheduled,
            totalSpawns: this.spawns.length, waveProgress: waveSpawns ? waveDone / waveSpawns : 0,
            pauses: [...this.pauses], gates: this.gates.slice(), stats: { ...this.stats },
            units: [...this.units.values()].map(unit => ({ ...unit })),
            enemies: [...this.enemies.values()].map(enemy => ({ ...enemy })),
            projectiles: [...this.projectiles.values()].map(projectile => ({ ...projectile, hit: projectile.hit.slice() })),
            lobs: [...this.lobs.values()].map(lob => ({ ...lob })),
            pickups: [...this.pickups.values()].map(pickup => ({ ...pickup })),
            cooldowns: this.cooldowns(),
            restocks: this.restocks || 0 };
    }

    // 城镇加成：按存档等级折算开局资源、产量、治疗与装备费。数值极小
    // （每级 6-8%），只改变手感不改变关卡设计。
    static applyTownBuffs(battle, town) {
        const lv = id => town?.[id] || 0;
        battle.resource += 25 * lv("B4");
        battle.townHeal = 1 + .06 * lv("B3");
        battle.townProducer = 1 + .08 * lv("B1");
        battle.townGear = 1 - .06 * lv("B2");
        // 图书馆：无尽开局多跳过已守过的波次。波次跳跃必须发生在
        // seed 波形规划之前——plannedWave 从跳过数起算，难度曲线不变。
        battle.townWaveSkip = Math.max(0, lv("B5"));
    }

    // 无尽开局按城镇图书馆等级跳过前 N 波：等价于从第 N+1 波开局。
    // 跳过的波不给掉落、不给换卡（那是打完第 5 波才有的奖励）；只把
    // wave/planWave 光标推到对应位置。种子掺入跳过数，所以跳过后的
    // 第一波就是全新的第 N+1 波，而不是复用旧录像。构造器已经规划
    // 过第 1 波（plannedWave=1），这里从 0 重来。
    static skipEndlessWaves(battle) {
        const skip = battle.townWaveSkip || 0;
        if (!battle.level.endless || skip <= 0 || battle.phase !== "setup") { return false; }
        battle.rng = mulberry32((battle.seed || 20260926) ^ (0x5a5a5a * skip));
        battle.plannedWave = 0;
        battle.spawns = [];
        battle.spawnIndex = 0;
        battle.warned.clear();
        battle.nextWaveAt = 24;
        while (battle.plannedWave < skip) { battle.planWave(); }
        battle.wave = skip + 1;
        // 跳过的波不排队生成。第 skip+1 波仍按原来的节奏在 nextWaveAt
        // 开打——开局时刻本身就是 24 秒热身，跳过波次不改变波距曲线，
        // 只是第一条路的热身比从第 1 波开局更短（相对难度已经更高）。
        battle.spawns = [];
        battle.spawnIndex = 0;
        // 波界只保留未跳过的：waveBounds 的 remaining 是清波判据，
        // 跳过的波永远等不到「最后一只被击退」。
        for (const n of [...battle.waveBounds.keys()]) { if (n <= skip) { battle.waveBounds.delete(n); } }
        return true;
    }

    // Endless mid-run checkpoint. Unlike serializeSetup this captures a
    // RUNNING run: the wave clock, the resources, the bench (units + gear),
    // and how many planned waves already fired. Enemies are deliberately NOT
    // snapshotted — on resume the endless planner replays the seeded stream,
    // and spawns whose time already passed simply don't spawn (the wave
    // counter is restored so the run's difficulty curve stays correct).
    serializeEndless() {
        if (!this.level.endless || this.phase === "lost") { return null; }
        // 当前波的击杀进度一并带上：恢复时波界 remaining 若不扣掉
        // 已击退的成员，这一波就永远等不到「全部击退」，第五波的
        // 换卡/素材奖励会在断点续玩时凭空消失。spawned 统计「本波已
        // 进场的数量」，alive 是场上还活着的——两者之差就是已击退。
        const bound = this.waveBounds.get(this.wave);
        const spawnedThisWave = this.spawns.slice(0, this.spawnIndex).filter(spawn => spawn.wave === this.wave).length;
        const aliveThisWave = [...this.enemies.values()].filter(enemy => enemy.wave === this.wave && !enemy.summoned).length;
        const waveProgress = bound ? { total: bound.remaining, killed: Math.max(0, spawnedThisWave - aliveThisWave) } : null;
        return { version: 1, level: this.level.id, seed: this.seed, deck: [...this.deck],
            time: Math.round(this.time * 10) / 10, wave: this.wave, resource: Math.round(this.resource),
            restocks: this.restocks || 0, waveProgress,
            units: [...this.units.values()].map(unit => ({ type: unit.type, row: unit.row, col: unit.col, gear: unit.gear || null, hp: unit.hp })),
            stats: { kills: this.stats.kills, healed: this.stats.healed, gatesUsed: this.stats.gatesUsed } };
    }

    static applyEndless(battle, data) {
        if (!data || data.version !== 1 || data.level !== battle.level.id || !battle.level.endless) { return false; }
        if (battle.phase !== "setup") { return false; }
        if (!Number.isInteger(data.seed)) { return false; }
        battle.seed = data.seed;
        battle.rng = mulberry32(data.seed);
        battle.time = 0;
        // Restore the deck before units so gear validation sees the carriers.
        const deck = new Set(Array.isArray(data.deck) && data.deck.length ? data.deck : [...battle.deck]);
        for (const id of deck) { if (!UNIT_RULES[id]) { return false; } }
        battle.deck = deck;
        // Replay the planned waves up to the saved wave so endless state
        // (bounds, next wave time, roster unlocks) matches, then fast-forward
        // the spawn queue: everything scheduled before the save time is
        // dropped, and the remaining queue is re-anchored to t=0 so the first
        // surviving spawn arrives after a normal warm-up, not at the clock
        // offset it happened to have when saved.
        battle.plannedWave = 0;
        battle.spawns = [];
        battle.nextWaveAt = battle.level.naturalFirst > 0 ? 24 : 24;
        while (battle.plannedWave < data.wave - 1) { battle.planWave(); }
        battle.wave = data.wave;
        // 重建当前波的波界并扣掉断点前已击退的数量，让「波已守完」
        // 的判定在续局里仍然可达。剩余人数最低保 1：断点时刻场上
        // 活着的成员不在重建范围里（敌人不入存档），波界按仍会进场
        // 的新成员数计算，已击退的扣掉。
        battle._resumeWaveKilled = 0;
        const bound = battle.waveBounds.get(data.wave);
        if (bound && data.waveProgress && Number.isInteger(data.waveProgress.killed)) {
            const killed = Math.max(0, Math.min(bound.remaining, data.waveProgress.killed));
            battle._resumeWaveKilled = killed;
            bound.remaining = Math.max(1, bound.remaining - killed);
        }
        const savedAt = Math.max(0, data.time || 0);
        const future = battle.spawns.filter(spawn => spawn.at > savedAt);
        // 续局重锚：存留下来的生成点平移到 24 秒热身后开打；存留为空
        // 时当前波由首次 tick 的 planWave 重排，它读 nextWaveAt，这里
        // 同步归位到热身节奏。
        const shift = savedAt > 0 ? Math.max(0, (future[0]?.at ?? savedAt) - 24) : 0;
        battle.spawns = future.map(spawn => ({ ...spawn, at: spawn.at - shift, index: spawn.index - (battle.spawns.length - future.length) }));
        battle.nextWaveAt = Math.max(24, battle.nextWaveAt - shift);
        battle.spawnIndex = 0;
        battle.warned.clear();
        battle.resource = Math.max(0, data.resource || 0);
        battle.restocks = data.restocks || 0;
        if (data.stats) { Object.assign(battle.stats, data.stats); }
        for (const entry of data.units || []) {
            const rule = UNIT_RULES[entry.type];
            if (!rule || !deck.has(entry.type)) { continue; }
            if (!Number.isInteger(entry.row) || !Number.isInteger(entry.col) ||
                entry.row < 0 || entry.row >= battle.level.rows || entry.col < 0 || entry.col >= battle.level.cols) { continue; }
            const cellId = cellKey(entry.row, entry.col);
            if (battle.occupancy.has(cellId)) { continue; }
            const unit = { id: battle.id("unit-"), type: entry.type, row: entry.row, col: entry.col,
                hp: Math.max(1, Math.round(entry.hp || rule.hp)), maxHp: rule.hp, nextAction: battle.time,
                nextIncome: battle.time + (rule.firstIncome || 0), nextGuard: 0, guardUntil: 0, createdAt: 0, attacks: 0,
                shield: 0, maxShield: 0, barrierHits: 0, nextBarrier: 0,
                nextSelfHeal: battle.time + (rule.selfHeal?.period || 0), hasteUntil: 0, haste: 0 };
            if (entry.gear) {
                const gearRule = UNIT_RULES[entry.gear];
                if (gearRule?.kind === "gear" && (!gearRule.gearFor || gearRule.gearFor.includes(entry.type))) {
                    unit.gear = entry.gear;
                    if (gearRule.gear.maxHp) { unit.maxHp += gearRule.gear.maxHp; unit.hp = Math.min(unit.maxHp, unit.hp + (gearRule.gear.heal || 0)); }
                    if (gearRule.gear.barrier) { unit.barrierHits += gearRule.gear.barrier; }
                }
            }
            battle.units.set(unit.id, unit);
            battle.occupancy.set(cellId, unit.id);
        }
        return true;
    }

    // Setup-phase-only persistence. Deploying already happened, then the player
    // closed the page: on next boot we offer to resume the same battle from
    // the placement step. The running phase deliberately has no cache — the
    // running sim is a stream of resolved actions that we would need to
    // serialize at a much deeper level than is worth the surface.
    serializeSetup() {
        if (this.phase !== "setup") { return null; }
        return { version: 1, level: this.level.id, deck: [...this.deck], seed: this.level.endless ? this.seed : null,
            resource: this.resource,
            readyAt: [...this.readyAt.entries()],
            units: [...this.units.values()].map(unit => ({ id: unit.id, type: unit.type, row: unit.row, col: unit.col, gear: unit.gear || null })),
            stats: { ...this.stats }
        };
    }
    static applySetup(battle, data) {
        if (!data || data.version !== 1 || data.level !== battle.level.id) { return false; }
        if (battle.phase !== "setup") { return false; }
        if (battle.level.endless && data.seed !== null && data.seed !== battle.seed) { return false; }
        const units = Array.isArray(data.units) ? data.units : [];
        const deck = new Set(Array.isArray(data.deck) && data.deck.length ? data.deck : [...battle.deck]);
        for (const id of deck) {
            if (!UNIT_RULES[id]) { return false; }
        }
        battle.deck = deck;
        for (const entry of units) {
            const rule = UNIT_RULES[entry.type];
            if (!rule || !deck.has(entry.type)) { return false; }
            if (!Number.isInteger(entry.row) || !Number.isInteger(entry.col) ||
                entry.row < 0 || entry.row >= battle.level.rows || entry.col < 0 || entry.col >= battle.level.cols) { return false; }
            if (battle.occupancy.has(cellKey(entry.row, entry.col))) { return false; }
            const unit = { id: battle.id("unit-"), type: entry.type, row: entry.row, col: entry.col,
                hp: rule.hp, maxHp: rule.hp, nextAction: 0,
                nextIncome: rule.firstIncome || 0, nextGuard: 0, guardUntil: 0, createdAt: 0, attacks: 0,
                shield: 0, maxShield: 0, barrierHits: 0, nextBarrier: 0,
                nextSelfHeal: rule.selfHeal?.period || 0, hasteUntil: 0, haste: 0 };
            if (entry.gear) {
                const gearRule = UNIT_RULES[entry.gear];
                if (!gearRule || gearRule.kind !== "gear") { return false; }
                unit.gear = entry.gear;
                if (gearRule.gear.maxHp) { unit.maxHp += gearRule.gear.maxHp; unit.hp = Math.min(unit.maxHp, unit.hp + (gearRule.gear.heal || 0)); }
                if (gearRule.gear.barrier) { unit.barrierHits += gearRule.gear.barrier; }
            }
            battle.units.set(unit.id, unit);
            battle.occupancy.set(cellKey(entry.row, entry.col), unit.id);
        }
        battle.resource = data.resource;
        for (const [type, at] of Array.isArray(data.readyAt) ? data.readyAt : []) {
            if (deck.has(type) && Number.isFinite(at) && at >= 0) { battle.readyAt.set(type, at); }
        }
        if (data.stats && typeof data.stats === "object") { Object.assign(battle.stats, data.stats); }
        return true;
    }
}
