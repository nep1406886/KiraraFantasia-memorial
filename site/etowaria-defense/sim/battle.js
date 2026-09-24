import { TICK, UNIT_RULES, ENEMY_RULES } from "../data/campaign.js";
import { attackContains, healingContains, burstContains } from "./targeting.js";

const EPS = 1e-8;
const cellKey = (row, col) => `${row}:${col}`;

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
            healed: 0, gatesUsed: 0, defeatedUnits: 0, breachRow: null };
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

    canDeploy(type, row, col) {
        const rule = UNIT_RULES[type];
        if (this.phase !== "setup" && this.phase !== "running") { return { ok: false, reason: "本次巡守已结束" }; }
        if (this.pauses.size) { return { ok: false, reason: "先继续巡守，再进行部署" }; }
        if (!rule || !this.deck.has(type)) { return { ok: false, reason: "这张卡不在本次编队中" }; }
        if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= this.level.rows || col < 0 || col >= this.level.cols) {
            return { ok: false, reason: "这里不在本关的布阵区域内" };
        }
        const remaining = Math.max(0, (this.readyAt.get(type) || 0) - this.time);
        if (remaining > EPS) {
            return { ok: false, reason: this.phase === "setup" ? "这张卡的冷却将在开局后推进" : `还需等待 ${Math.ceil(remaining)} 秒`, cooldown: remaining };
        }
        if (this.resource < rule.cost) { return { ok: false, reason: `还差 ${rule.cost - this.resource} クリエ`, shortage: rule.cost - this.resource }; }
        if (rule.kind !== "burst") {
            if (this.occupancy.has(cellKey(row, col))) { return { ok: false, reason: "这里已有同伴或设施" }; }
            if ([...this.enemies.values()].some(enemy => enemy.row === row && Math.abs(enemy.x - col) < .7)) {
                return { ok: false, reason: "来敌正占用这里，请选择其他位置" };
            }
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
        if (rule.kind === "burst") {
            const id = this.id("spell-");
            this.pending.push({ kind: "burst", id, at: this.time + rule.windup, row, col, type });
            this.emit("spellCast", { id, unitType: type, row, col, windup: rule.windup });
            return { ok: true, id };
        }
        const unit = { id: this.id("unit-"), type, row, col, hp: rule.hp, maxHp: rule.hp,
            nextAction: this.time, nextIncome: this.time + (rule.firstIncome || 0),
            nextGuard: this.time, guardUntil: 0, createdAt: this.time };
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
        const enemy = { id: this.id("enemy-"), type: entry.type, row: entry.row, x: this.level.cols + .6,
            hp: rule.hp, maxHp: rule.hp, speed: rule.speed, nextAttack: this.time,
            state: "walking", targetId: null, wave: entry.wave };
        this.enemies.set(enemy.id, enemy);
        this.wave = Math.max(this.wave, entry.wave);
        this.emit("spawned", { id: enemy.id, enemyType: enemy.type, row: enemy.row, x: enemy.x, wave: entry.wave });
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
                this.createPickup(unit.row, unit.col, rule.income, unit.id);
                unit.nextIncome += rule.incomePeriod;
                this.emit("produced", { id: unit.id });
            }
        }
        for (const pickup of this.pickups.values()) {
            if (this.time + EPS >= pickup.autoAt) { this.collect(pickup.id); }
        }
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
        for (const unit of this.units.values()) { this.updateUnit(unit); }
        this.updateProjectiles();
        if (this.phase === "running" && this.spawnIndex === this.spawns.length && this.enemies.size === 0) {
            this.phase = "won";
            this.pending = [];
            this.projectiles.clear();
            this.emit("finished", { result: "won", stats: { ...this.stats } });
        }
    }

    updateEnemy(enemy) {
        const rule = ENEMY_RULES[enemy.type];
        let blocker = null;
        for (const unit of this.units.values()) {
            const edge = unit.col + .55;
            if (unit.row === enemy.row && edge <= enemy.x + EPS && (!blocker || unit.col > blocker.col)) { blocker = unit; }
        }
        const next = enemy.x - rule.speed * TICK;
        if (blocker && next <= blocker.col + .55 + EPS) {
            enemy.x = blocker.col + .55;
            enemy.state = "attacking";
            enemy.targetId = blocker.id;
            if (enemy.nextAttack <= this.time + EPS) {
                enemy.nextAttack = this.time + rule.period;
                this.pending.push({ kind: "enemyHit", at: this.time + rule.windup, source: enemy.id, target: blocker.id });
                this.emit("enemyAttack", { id: enemy.id, target: blocker.id });
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
                    if (other.row === enemy.row) { this.damageEnemy(other, other.hp, "gate"); }
                }
            } else {
                this.phase = "lost";
                this.stats.breachRow = enemy.row;
                this.pending = [];
                this.projectiles.clear();
                this.emit("finished", { result: "lost", row: enemy.row, stats: { ...this.stats } });
            }
        }
    }

    targetFor(unit, rule) {
        let target = null;
        for (const enemy of this.enemies.values()) {
            if (attackContains(unit, enemy, rule)
                && (!target || enemy.x < target.x || enemy.x === target.x && enemy.id < target.id)) { target = enemy; }
        }
        return target;
    }

    updateUnit(unit) {
        const rule = UNIT_RULES[unit.type];
        if (rule.kind === "producer" || unit.nextAction > this.time + EPS) { return; }
        if (rule.kind === "healer") {
            const candidates = [...this.units.values()].filter(other => other.hp < other.maxHp
                && healingContains(unit, other, rule));
            candidates.sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp || a.id.localeCompare(b.id));
            if (!candidates.length) { return; }
            unit.nextAction = this.time + rule.period;
            this.pending.push({ kind: "heal", at: this.time + rule.windup, source: unit.id, target: candidates[0].id });
            this.emit("unitAction", { id: unit.id, action: "heal", target: candidates[0].id });
            return;
        }
        const target = this.targetFor(unit, rule);
        if (!target) { return; }
        if (rule.kind === "guard" && unit.nextGuard <= this.time + EPS && unit.hp < unit.maxHp) {
            unit.nextGuard = this.time + rule.guardPeriod;
            unit.guardUntil = this.time + rule.guardDuration;
            unit.nextAction = this.time + 2.4;
            this.emit("unitAction", { id: unit.id, action: "guard", target: unit.id });
            return;
        }
        unit.nextAction = this.time + rule.period;
        this.pending.push({ kind: rule.kind === "shooter" ? "shoot" : "melee", at: this.time + rule.windup,
            source: unit.id, target: target.id });
        this.emit("unitAction", { id: unit.id, action: "attack", target: target.id });
    }

    resolveAction(action) {
        if (this.phase !== "running") { return; }
        if (action.kind === "burst") {
            const rule = UNIT_RULES[action.type];
            this.emit("burst", { id: action.id, row: action.row, col: action.col, radius: rule.radius });
            for (const enemy of [...this.enemies.values()]) {
                if (burstContains(action, enemy, rule)) {
                    this.damageEnemy(enemy, rule.damage, action.id);
                }
            }
            return;
        }
        if (action.kind === "enemyHit") {
            const enemy = this.enemies.get(action.source);
            const unit = this.units.get(action.target);
            if (!enemy || !unit || enemy.row !== unit.row || Math.abs(enemy.x - (unit.col + .55)) > .08) { return; }
            const rule = UNIT_RULES[unit.type];
            const reduction = unit.guardUntil > this.time ? rule.guardReduction || 0 : 0;
            const amount = Math.max(1, Math.round(ENEMY_RULES[enemy.type].damage * (1 - reduction)));
            unit.hp = Math.max(0, unit.hp - amount);
            this.emit("unitHurt", { id: unit.id, amount, hp: unit.hp });
            if (unit.hp === 0) { this.stats.defeatedUnits++; this.removeUnit(unit, "defeated"); }
            return;
        }
        const unit = this.units.get(action.source);
        if (!unit) { return; }
        const rule = UNIT_RULES[unit.type];
        if (action.kind === "heal") {
            const ally = this.units.get(action.target);
            if (!ally || !healingContains(unit, ally, rule)) { return; }
            const amount = Math.min(rule.healing, ally.maxHp - ally.hp);
            if (amount <= 0) { return; }
            ally.hp += amount;
            this.stats.healed += amount;
            this.emit("healed", { id: ally.id, source: unit.id, amount, hp: ally.hp });
            return;
        }
        const target = this.enemies.get(action.target) || this.targetFor(unit, rule);
        if (!target || !attackContains(unit, target, rule)) { return; }
        if (action.kind === "shoot") {
            const projectile = { id: this.id("projectile-"), source: unit.id, unitType: unit.type,
                row: unit.row, x: unit.col + .22, previousX: unit.col + .22, targetId: target.id,
                speed: rule.projectileSpeed, damage: rule.damage, createdAt: this.time };
            this.projectiles.set(projectile.id, projectile);
            this.emit("projectile", { ...projectile });
        } else {
            this.damageEnemy(target, rule.damage, unit.id);
        }
    }

    updateProjectiles() {
        for (const projectile of [...this.projectiles.values()]) {
            projectile.previousX = projectile.x;
            projectile.x += projectile.speed * TICK;
            const candidates = [...this.enemies.values()].filter(enemy => enemy.row === projectile.row
                && enemy.x + .2 >= projectile.previousX && enemy.x - .2 <= projectile.x);
            candidates.sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
            if (candidates.length) {
                this.damageEnemy(candidates[0], projectile.damage, projectile.source);
                this.projectiles.delete(projectile.id);
                this.emit("projectileRemoved", { id: projectile.id, hit: candidates[0].id });
            } else if (projectile.x > this.level.cols + 1.4) {
                this.projectiles.delete(projectile.id);
                this.emit("projectileRemoved", { id: projectile.id, hit: null });
            }
        }
    }

    damageEnemy(enemy, amount, source) {
        if (!this.enemies.has(enemy.id)) { return; }
        enemy.hp = Math.max(0, enemy.hp - amount);
        this.emit("enemyHurt", { id: enemy.id, amount, hp: enemy.hp, source });
        if (enemy.hp === 0) {
            this.enemies.delete(enemy.id);
            this.stats.kills++;
            this.emit("enemyRemoved", { id: enemy.id, reason: source === "gate" ? "gate" : "defeated" });
        }
    }

    removeUnit(unit, reason) {
        this.units.delete(unit.id);
        this.occupancy.delete(cellKey(unit.row, unit.col));
        this.emit("unitRemoved", { id: unit.id, unitType: unit.type, reason, row: unit.row, col: unit.col });
    }

    snapshot() {
        return { level: this.level.id, phase: this.phase, time: this.time, resource: this.resource,
            wave: this.wave, totalWaves: this.level.waves, scheduledRemaining: this.spawns.length - this.spawnIndex,
            pauses: [...this.pauses], gates: this.gates.slice(), stats: { ...this.stats },
            units: [...this.units.values()].map(unit => ({ ...unit })),
            enemies: [...this.enemies.values()].map(enemy => ({ ...enemy })),
            projectiles: [...this.projectiles.values()].map(projectile => ({ ...projectile })),
            pickups: [...this.pickups.values()].map(pickup => ({ ...pickup })),
            cooldowns: Object.fromEntries([...this.deck].map(id => [id, Math.max(0, (this.readyAt.get(id) || 0) - this.time)])) };
    }
}
