import { DefenseStage } from "./stage.js";
import { NativeModel } from "./native-model.js";
import { ENEMY_RULES, UNIT_RULES, TICK } from "../data/campaign.js";
import { Battle } from "../sim/battle.js";
import { RangePreview } from "./range-preview.js";

const BURST = "ef_btl_dmg_all_fire_00";
const IMPACT = "ef_btl_dmg_single_00";
const BIRTH = "ef_btl_buff_ring";

export class Facility {
    constructor(view) {
        this.THREE = view.stage.THREE;
        this.group = new this.THREE.Group();
        this.group.name = "defense-support-desk";
        this.kind = "facility";
        this.unit = { id: "F01", shortName: "应援台", name: "应援采集台" };
        this.height = .85;
        this.platformHeight = 0;
        this.action = "idle";
        const desk = view.desk.group.clone(true);
        desk.visible = true; desk.position.set(0, 0, 0);
        const book = view.book.group.clone(true);
        book.visible = true; book.position.set(.02, .46, -.08);
        this.group.add(desk, book);
        this.group.traverse(node => {
            if (node.isMesh) { node.userData.defenseAuthoredOrder = node.renderOrder; }
        });
        this.root = this.group;
    }
    place(row, col, rows = 5) {
        this.cell = { row, col };
        this.group.position.set((col - 4) * 1.3, 0, (row - (rows - 1) / 2) * 2.1);
        this.group.traverse(node => {
            if (node.isMesh) { node.renderOrder = 100000000 + row * 100000000 + col * 2000000 + node.userData.defenseAuthoredOrder; }
        });
    }
    bodyPoint() { return this.group.position.clone().add(new this.THREE.Vector3(0, .55, -.2)); }
    update() {}
    dispose() { this.group.removeFromParent(); }
    snapshot() { return { id: "F01", kind: "facility", cell: this.cell, position: this.group.position.toArray() }; }
}

export class BattleView {
    static async create(options) {
        const view = new BattleView(options);
        try {
            view.stage = await DefenseStage.createField({ ...options,
                onFieldInput: cell => view.input(cell.row, cell.col, cell.event.pointerType),
                onFieldHover: cell => view.hover(cell),
                onFieldCancel: () => view.cancelPlacement() });
            view.range = new RangePreview(view.stage, (row, col, y) => view.world(row, col, y));
            if (options.isCurrent && !options.isCurrent()) { throw new Error("本次素材准备已取消"); }
            await view.load();
            return view;
        } catch (error) {
            view.dispose();
            throw error;
        }
    }

    constructor(options) {
        this.options = options;
        this.level = options.level;
        this.catalogue = options.catalogue;
        this.battle = new Battle(options.level, { deck: options.deck });
        this.models = new Map();
        this.allModels = new Set();
        this.unitPools = new Map();
        this.enemyPools = new Map();
        this.warming = new Map();
        this.retiring = new Set();
        this.spells = new Map();
        this.pickupElements = new Map();
        this.visualEvents = [];
        this.selected = "F01";
        this.recallMode = false;
        this.ready = false;
        this.disposed = false;
        this.loading = false;
        this.visualTime = 0;
        this.lastHud = -1;
        this.lastTarget = null;
        this.touchTarget = null;
        this.preview = null;
    }

    async load() {
        const stage = this.stage;
        stage.selection.visible = false;
        stage.grid.visible = true;
        stage.renderer.domElement.setAttribute("aria-label", "布阵战场。选择卡牌后点空格部署，或使用键盘方向键和回车。");
        stage.battleTick = dt => this.tick(dt);
        stage.afterBattleFrame = dt => this.afterFrame(dt);
        stage.afterRender = () => this.projectOverlay();
        this.desk = stage.props.find(prop => prop.name === "desk");
        this.book = await stage.loadProp(stage.assets.native.furniture.goods_1083, "producer-book", .32);
        this.book.group.visible = false;
        const tasks = [];
        for (const type of this.battle.deck) {
            if (type.startsWith("U")) {
                const count = type === "U01" ? 3 : 1;
                for (let i = 0; i < count; i++) { tasks.push(() => this.createUnit(type)); }
            }
        }
        const enemyCounts = new Map();
        for (const spawn of this.level.spawns) { enemyCounts.set(spawn.type, (enemyCounts.get(spawn.type) || 0) + 1); }
        for (const [type, count] of enemyCounts) {
            for (let i = 0; i < count; i++) { tasks.push(() => this.createEnemy(type)); }
        }
        let cursor = 0;
        let complete = 0;
        const workers = Array.from({ length: 3 }, async () => {
            while (cursor < tasks.length && !this.disposed) {
                const task = tasks[cursor++];
                await task();
                complete++;
                this.options.onProgress?.(.12 + complete / tasks.length * .65, `准备原生模型 ${complete} / ${tasks.length}`);
            }
        });
        const results = await Promise.allSettled(workers);
        const failure = results.find(result => result.status === "rejected");
        if (failure) { throw failure.reason; }
        if (this.disposed) { return; }
        await stage.effects.prepare([IMPACT, BIRTH, "ef_btl_common_dead", "ef_btl_barrier_00"], 8);
        if (this.battle.deck.has("F10")) {
            await stage.items.prepare();
            await stage.effects.prepare([BURST], 10);
        }
        for (const type of this.battle.deck) { await this.prepareUnitEffects(type, type === "U01" ? 5 : 3); }
        this.options.onProgress?.(1, "原生模型与招式已就绪");
        this.markBoard();
        this.ready = true;
        stage.startLoop();
        stage.render();
        this.notify();
    }

    async createUnit(type) {
        const unit = this.catalogue.units.find(row => row.id === type);
        if (!unit) { throw new Error(`未绑定角色卡：${type}`); }
        const model = await NativeModel.player(this.stage.assets, unit);
        if (this.disposed || this.options.isCurrent && !this.options.isCurrent()) {
            model.dispose(); throw new Error("本次素材准备已取消");
        }
        this.allModels.add(model);
        if (!this.unitPools.has(type)) { this.unitPools.set(type, []); }
        this.unitPools.get(type).push(model);
        return model;
    }

    async createEnemy(type) {
        const spec = ENEMY_RULES[type];
        const model = await NativeModel.enemy(this.stage.assets, spec);
        if (this.disposed || this.options.isCurrent && !this.options.isCurrent()) {
            model.dispose(); throw new Error("本次素材准备已取消");
        }
        model.gaitRate = spec.speed * 1.3 / model.motion.speed;
        this.allModels.add(model);
        if (!this.enemyPools.has(type)) { this.enemyPools.set(type, []); }
        this.enemyPools.get(type).push(model);
        return model;
    }

    async prepareUnitEffects(type, copies) {
        if (!type.startsWith("U")) { return; }
        const unit = this.catalogue.units.find(row => row.id === type);
        const names = this.stage.effects.actionPlan(unit, "attack").events.map(event => event.effect);
        if (type === "U11" || type === "U15") {
            names.push(...this.stage.effects.actionPlan(unit, "skill").events.map(event => event.effect));
        }
        await this.stage.effects.prepare(names, copies);
    }

    warm(type) {
        if (!type.startsWith("U") || this.warming.has(type) || this.disposed || (this.unitPools.get(type)?.length || 0) > 0) { return; }
        const pending = this.createUnit(type).catch(error => {
            if (!this.disposed) { this.options.onNotice?.(`备用模型准备未完成，下次部署时将重试：${error.message}`); }
        }).finally(() => this.warming.delete(type));
        this.warming.set(type, pending);
    }

    world(row, col, y = 0) {
        return new this.stage.THREE.Vector3((col + this.level.colOffset - 4) * 1.3, y,
            (row + this.level.rowOffset - (this.stage.rows - 1) / 2) * 2.1);
    }

    markBoard() {
        const THREE = this.stage.THREE;
        const points = [];
        for (let row = 0; row <= this.level.rows; row++) {
            const start = this.world(row - .5, -.5, .022);
            const end = this.world(row - .5, this.level.cols - .5, .022);
            points.push(...start.toArray(), ...end.toArray());
        }
        for (let col = 0; col <= this.level.cols; col++) {
            points.push(...this.world(-.5, col - .5, .022).toArray(),
                ...this.world(this.level.rows - .5, col - .5, .022).toArray());
        }
        this.stage.grid.visible = false;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
        const material = new THREE.LineBasicMaterial({ color: 0xfff1bf, transparent: false, opacity: .42,
            depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor });
        const lines = new THREE.LineSegments(geometry, material);
        lines.renderOrder = 1500;
        this.stage.environment.add(lines);
        if (this.level.rows === 3) {
            this.stage.field.scale.set(7 / 9, 3 / 5, 1);
        }
    }

    select(type) {
        if (!this.battle.deck.has(type)) { return; }
        this.clearPreview();
        this.selected = type;
        this.recallMode = false;
        this.options.onNotice?.(UNIT_RULES[type].help);
        this.notify();
    }

    setRecall(enabled) {
        this.clearPreview();
        this.recallMode = enabled;
        this.options.onNotice?.(enabled
            ? this.battle.phase === "setup" ? "点选已部署对象，准备阶段召回会退还全部费用。" : "点选要召回的对象。开战后不退还费用。"
            : "选择一张卡，再点空格部署。");
        this.notify();
    }

    clearPreview() {
        this.lastTarget = null; this.touchTarget = null; this.preview = null;
        this.range?.clear();
        if (this.stage) { this.stage.selection.visible = false; this.stage.render(); }
    }

    cancelPlacement() {
        this.clearPreview(); this.recallMode = false; this.selected = null;
        this.options.onNotice?.("已取消部署。选择卡牌可以重新预览。");
        this.notify();
    }

    hover(cell) {
        if (!this.ready || this.loading || this.touchTarget || this.battle.pauses.size) { return; }
        if (!cell) { this.clearPreview(); this.notify(); return; }
        this.pointCell(cell.row - this.level.rowOffset, cell.col - this.level.colOffset);
    }

    pointCell(row, col) {
        if (!this.ready || (!this.selected && !this.recallMode)
            || row < 0 || row >= this.level.rows || col < 0 || col >= this.level.cols
            || !["setup", "running"].includes(this.battle.phase)) {
            this.clearPreview(); this.notify(); return null;
        }
        this.lastTarget = { row, col };
        this.stage.selection.visible = true;
        this.stage.selection.position.copy(this.world(row, col, .027));
        const check = this.recallMode ? { ok: this.battle.occupancy.has(`${row}:${col}`), reason: "这里没有可召回的对象" }
            : this.battle.canDeploy(this.selected, row, col);
        const area = this.recallMode ? null : this.range.show(UNIT_RULES[this.selected], row, col, this.level);
        if (this.recallMode) { this.range.clear(); }
        this.preview = { row, col, valid: check.ok, reason: check.ok ? "" : check.reason,
            kind: area?.kind || "recall", text: area?.text || "召回此格的同伴或设施", cells: area?.cells || [] };
        this.stage.selection.material.color.set(check.ok ? 0xffec89 : 0xd48080);
        this.notify(); this.stage.render();
        return this.preview;
    }

    confirmPlacement() {
        const target = this.touchTarget;
        if (!target || this.loading) { return; }
        return this.deployCell(target.row, target.col);
    }

    async input(displayRow, displayCol, pointerType = "mouse") {
        const row = displayRow - this.level.rowOffset;
        const col = displayCol - this.level.colOffset;
        if (row < 0 || row >= this.level.rows || col < 0 || col >= this.level.cols) {
            this.clearPreview(); this.notify();
            this.options.onNotice?.("这里不在本关的布阵区域内。"); return;
        }
        if (!this.selected && !this.recallMode) { this.options.onNotice?.("请先选择一张卡牌。"); return; }
        if (pointerType === "touch") {
            if (this.touchTarget?.row === row && this.touchTarget?.col === col) { return this.confirmPlacement(); }
            this.touchTarget = { row, col };
            const preview = this.pointCell(row, col);
            this.options.onNotice?.(preview?.valid ? "已显示范围。再次点同一格或按确认部署。" : preview?.reason || "这里无法部署");
            return;
        }
        return this.deployCell(row, col);
    }

    async deployCell(row, col) {
        if (!this.ready || this.disposed || this.loading) { return { ok: false, reason: "素材准备中" }; }
        this.pointCell(row, col);
        if (this.recallMode) {
            const result = this.battle.recall(row, col);
            if (!result.ok) { this.options.onNotice?.(result.reason); }
            else { this.clearPreview(); }
            this.consumeEvents(); this.notify();
            return result;
        }
        const type = this.selected;
        const check = this.battle.canDeploy(type, row, col);
        if (!check.ok) { this.options.onNotice?.(check.reason); return check; }
        this.loading = true;
        this.setPaused("deploy-load", true);
        let model;
        try {
            if (type === "F01") { model = new Facility(this); this.allModels.add(model); }
            else if (type.startsWith("U")) {
                if (this.warming.has(type)) { await this.warming.get(type); }
                if (!this.unitPools.get(type)?.length) { await this.createUnit(type); }
                if (this.disposed) { return { ok: false }; }
                model = this.unitPools.get(type).pop();
                const active = [...this.battle.units.values()].filter(unit => unit.type === type).length;
                await this.prepareUnitEffects(type, active + 3);
            }
            if (this.disposed) { return { ok: false }; }
            this.setPaused("deploy-load", false);
            const result = this.battle.deploy(type, row, col);
            if (!result.ok) {
                if (model?.kind === "facility") { model.dispose(); this.allModels.delete(model); }
                else if (model) { this.unitPools.get(type).push(model); }
                this.options.onNotice?.(result.reason);
                return result;
            }
            if (model) { this.addModel(result.id, model, row, col); }
            this.clearPreview();
            this.consumeEvents();
            this.warm(type);
            this.notify();
            return result;
        } catch (error) {
            if (model && !this.models.has(model.entityId)) {
                if (model.kind === "facility") { model.dispose(); this.allModels.delete(model); }
                else { this.unitPools.get(type)?.push(model); }
            }
            if (!this.disposed) { this.options.onError?.(error); }
            return { ok: false, reason: error.message };
        } finally {
            this.loading = false;
            if (!this.disposed) { this.setPaused("deploy-load", false); this.notify(); }
        }
    }

    addModel(id, model, row, col) {
        model.entityId = id;
        model.retiring = false;
        model.place(row + this.level.rowOffset, col + this.level.colOffset, this.stage.rows);
        if (model.kind !== "facility") { model.play("idle"); }
        this.stage.scene.add(model.group);
        this.stage.makeShadow(model);
        (model.kind === "enemy" ? this.stage.enemies : this.stage.players).push(model);
        this.models.set(id, model);
        this.makeStatus(model);
    }

    makeStatus(model) {
        const button = document.createElement("button");
        button.className = "battle-unit-status";
        button.dataset.entity = model.entityId;
        const name = document.createElement("span"); name.className = "battle-unit-name";
        name.textContent = model.unit.name;
        const track = document.createElement("span"); track.className = "life-track";
        const fill = document.createElement("span"); fill.className = "life-fill"; track.append(fill);
        const text = document.createElement("span"); text.className = "sr-only";
        button.append(name, track, text);
        button.addEventListener("click", event => {
            event.stopPropagation();
            const unit = this.battle.units.get(model.entityId) || this.battle.enemies.get(model.entityId);
            if (unit) { this.options.onInspect?.(unit, model.kind); }
        });
        this.options.labels.append(button);
        model.label = button;
        model.hpFill = fill;
        model.hpText = text;
    }

    updateStatus(model) {
        const entity = this.battle.units.get(model.entityId) || this.battle.enemies.get(model.entityId);
        if (!entity || !model.label) { return; }
        const ratio = Math.max(0, Math.min(1, entity.hp / entity.maxHp));
        model.hpFill.style.transform = `scaleX(${ratio})`;
        model.label.classList.toggle("critical", ratio <= .25);
        const text = `${model.unit.name}，第${entity.row + 1}路，生命${Math.ceil(entity.hp)} / ${entity.maxHp}${ratio <= .25 ? "，危急" : ""}`;
        model.label.setAttribute("aria-label", text);
        model.label.title = text;
        model.hpText.textContent = text;
    }

    consumeEvents() {
        for (const event of this.battle.drainEvents()) {
            if (event.type === "spawned") {
                const model = this.enemyPools.get(event.enemyType)?.shift();
                if (!model) { throw new Error(`魔物预载数量不足：${event.enemyType}`); }
                this.addModel(event.id, model, event.row, event.x);
                model.beginWalk();
            } else if (event.type === "pickup") {
                const button = document.createElement("button"); button.className = "resource-pickup";
                button.textContent = `+${event.amount}`; button.dataset.pickup = event.id;
                button.setAttribute("aria-label", `收取${event.amount}クリエ`);
                button.addEventListener("click", click => { click.stopPropagation(); this.battle.collect(event.id); this.consumeEvents(); this.notify(); });
                this.options.overlay.append(button);
                this.pickupElements.set(event.id, button);
            } else if (event.type === "collected") {
                this.pickupElements.get(event.id)?.remove(); this.pickupElements.delete(event.id);
            } else if (event.type === "deployed") {
                const model = this.models.get(event.id);
                if (model) { this.stage.effects.emit(BIRTH, { from: model.group.position.clone(), scale: .65 }); }
            } else if (event.type === "unitAction") {
                this.unitAction(event);
            } else if (event.type === "enemyAttack") {
                const model = this.models.get(event.id);
                if (model) { model.play("skill_0", false); }
            } else if (event.type === "projectile") {
                this.projectile(event);
            } else if (event.type === "unitHurt" || event.type === "enemyHurt") {
                const model = this.models.get(event.id);
                if (model) {
                    this.stage.effects.emit(IMPACT, { from: model.bodyPoint(), scale: .6 });
                    if (model.action === "idle" && !model.walking && model.kind !== "facility") { model.play("damage", false); }
                }
            } else if (event.type === "healed") {
                const model = this.models.get(event.id);
                if (model) {
                    this.stage.effects.emit("ef_btl_recover_00", { from: model.group.position.clone(), scale: model.scale });
                    this.stage.effects.emit("ef_btl_recover_01", { from: model.group.position.clone(), scale: model.scale });
                }
            } else if (event.type === "unitRemoved" || event.type === "enemyRemoved") {
                this.retire(event.id, event.reason);
            } else if (event.type === "gate") {
                this.stage.effects.emit("ef_btl_barrier_00", { from: this.world(event.row, -.4), scale: 1.2 });
                this.options.onNotice?.(`第${event.row + 1}路的紧急结界已消耗。下一次突破将失守。`);
            } else if (event.type === "warning") {
                this.options.onWarning?.(event);
            } else if (event.type === "burst") {
                const item = this.spells.get(event.id);
                if (item) { this.stage.items.release(item); this.spells.delete(event.id); }
                for (let row = Math.max(0, event.row - 1); row <= Math.min(this.level.rows - 1, event.row + 1); row++) {
                    for (let col = Math.max(0, event.col - 1); col <= Math.min(this.level.cols - 1, event.col + 1); col++) {
                        this.stage.effects.emit(BURST, { from: this.world(row, col, .22), scale: 1 });
                    }
                }
            } else if (event.type === "spellCast") {
                const item = this.stage.items.bottle(.8);
                item.group.position.copy(this.world(event.row, event.col, .48));
                this.stage.scene.add(item.group); this.spells.set(event.id, item);
                this.options.onNotice?.("爆破药瓶将在1秒后生效。");
            } else if (event.type === "finished") {
                this.clearPreview();
                for (const item of this.spells.values()) { this.stage.items.release(item); }
                this.spells.clear();
                this.visualEvents = [];
                this.stage.effects.reset();
                this.pickupElements.forEach(element => element.remove()); this.pickupElements.clear();
                for (const model of this.stage.players) {
                    if (!model.retiring && model.actor && event.result === "won") { model.play("win_st_0", false); }
                }
                this.options.onFinished?.(event);
            }
            this.options.onEvent?.(event);
        }
    }

    unitAction(event) {
        const model = this.models.get(event.id);
        if (!model || model.retiring) { return; }
        const plan = this.stage.effects.actionPlan(model.unit, event.action === "attack" ? "attack" : "skill");
        model.play(plan.action, false);
        for (const effect of plan.events) {
            if (/Projectile|Attach|Trail/.test(effect.kind) || event.action === "heal") { continue; }
            this.visualEvents.push({ at: this.battle.time + effect.frame / 30, source: event.id, run: () => {
                const live = this.models.get(event.id);
                if (!live || live.retiring) { return; }
                this.stage.effects.emit(effect.effect, { from: live.group.position.clone(), scale: live.scale, facing: -1 });
            } });
        }
    }

    projectile(event) {
        const model = this.models.get(event.source);
        if (!model) { return; }
        const plan = this.stage.effects.actionPlan(model.unit, "attack");
        const graphic = plan.events.find(effect => /Projectile/.test(effect.kind));
        if (!graphic) { throw new Error("远程攻击没有精确原生投射物绑定"); }
        const from = model.muzzlePoint();
        let destination = this.models.get(event.targetId)?.bodyPoint() || this.world(event.row, this.level.cols, .4);
        const startX = event.x;
        const slot = this.stage.effects.emit(graphic.effect, { from, scale: model.scale, facing: -1,
            position: () => {
                const projectile = this.battle.projectiles.get(event.id);
                if (!projectile) { return null; }
                const target = this.battle.enemies.get(event.targetId);
                if (target) { destination = this.models.get(target.id)?.bodyPoint() || destination; }
                const logicalEnd = target?.x ?? this.level.cols;
                const fraction = Math.max(0, Math.min(1, (projectile.x - startX) / Math.max(.1, logicalEnd - startX)));
                const position = from.clone().lerp(destination, fraction);
                position.x = this.world(projectile.row, projectile.x).x;
                return position;
            } });
        if (!slot) { throw new Error("原生投射物池已满，已停止本局，避免不可见攻击"); }
    }

    retire(id, reason) {
        const model = this.models.get(id);
        if (!model) { return; }
        model.retiring = true;
        model.retireTime = this.visualTime;
        model.label?.remove(); model.label = null;
        if (model.kind === "facility") {
            this.stage.effects.emit("ef_btl_common_dead", { from: model.bodyPoint(), scale: .6 });
        } else {
            const clip = reason === "recall" && model.actor ? "battle_out" : "dead";
            model.play(clip, false);
        }
        this.retiring.add(model);
    }

    tick(dt) {
        if (!this.ready || this.disposed) { return; }
        this.visualTime += dt;
        try {
            const ready = this.stage.players;
            for (const model of ready) {
                const unit = this.battle.units.get(model.entityId);
                const threatened = unit && [...this.battle.enemies.values()].some(enemy => enemy.row === unit.row);
                model.configureIdle?.({ enabled: !this.options.audio.settings.reducedMotion && !model.retiring && !threatened,
                    relaxed: this.battle.phase === "setup" });
            }
            this.battle.step(dt);
            this.consumeEvents();
            const due = this.visualEvents.filter(event => event.at <= this.battle.time);
            this.visualEvents = this.visualEvents.filter(event => event.at > this.battle.time);
            due.forEach(event => event.run());
            for (const enemy of this.battle.enemies.values()) {
                const model = this.models.get(enemy.id);
                if (!model) { throw new Error("魔物逻辑没有对应模型"); }
                model.group.position.x = this.world(enemy.row, enemy.x).x;
                model.cell.col = enemy.x + this.level.colOffset;
                if (enemy.state === "walking" && model.action === "idle") { model.beginWalk(); }
                else if (enemy.state !== "walking") { model.walking = false; }
            }
            if (this.visualTime - this.lastHud > .08) { this.notify(); this.lastHud = this.visualTime; }
        } catch (error) {
            this.setPaused("error", true);
            this.options.onError?.(error);
        }
    }

    afterFrame() {
        for (const item of this.spells.values()) {
            item.turn.rotation.z = this.options.audio.settings.reducedMotion ? 0 : Math.sin(this.visualTime * 9) * .07;
        }
        for (const model of this.retiring) {
            const elapsed = this.visualTime - model.retireTime;
            if (model.kind === "facility" ? elapsed >= .4 : model.finishedAction === "dead" || elapsed > .2 && model.action === "idle") {
                this.retiring.delete(model);
                this.models.delete(model.entityId);
                const list = model.kind === "enemy" ? this.stage.enemies : this.stage.players;
                const index = list.indexOf(model); if (index >= 0) { list.splice(index, 1); }
                model.group.removeFromParent(); model.shadow?.removeFromParent(); model.shadow = null;
                if (model.kind === "player") { this.unitPools.get(model.unit.id).push(model); }
                else if (model.kind === "facility") { this.allModels.delete(model); }
            }
        }
        for (const model of this.models.values()) { this.updateStatus(model); }
        this.projectOverlay();
    }

    projectOverlay() {
        if (!this.stage || this.disposed) { return; }
        for (const [id, element] of this.pickupElements) {
            const pickup = this.battle.pickups.get(id);
            if (!pickup) { continue; }
            const point = this.world(pickup.row, pickup.col, pickup.source === "natural" ? 1 : .9);
            point.project(this.stage.camera);
            element.style.left = `${(point.x + 1) * this.stage.width / 2}px`;
            element.style.top = `${(1 - point.y) * this.stage.height / 2}px`;
        }
    }

    notify() {
        if (this.preview) {
            const { row, col } = this.preview;
            const check = this.recallMode ? { ok: this.battle.occupancy.has(`${row}:${col}`), reason: "这里没有可召回的对象" }
                : this.battle.canDeploy(this.selected, row, col);
            this.preview.valid = check.ok; this.preview.reason = check.ok ? "" : check.reason;
            this.stage.selection.material.color.set(check.ok ? 0xffec89 : 0xd48080);
        }
        this.options.onState?.(this.battle.snapshot(), { selected: this.selected, recall: this.recallMode,
            loading: this.loading, preview: this.preview, touchConfirm: !!this.touchTarget });
    }
    start() { if (this.ready && !this.loading && !this.battle.pauses.size && this.battle.start()) { this.options.audio.setTrack("bgm_battle_1"); this.consumeEvents(); this.notify(); } }
    collectAll() { this.battle.collectAll(); this.consumeEvents(); this.notify(); }
    setPaused(reason, paused) {
        if (paused && reason !== "deploy-load") { this.clearPreview(); }
        this.battle.pause(reason, paused);
        this.stage?.setPaused(reason, paused);
        this.notify();
    }
    reviewStep(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) { throw new Error("验收步长必须为0-30秒"); }
        for (let remaining = seconds; remaining > 1e-8; remaining -= TICK) { this.stage.update(Math.min(TICK, remaining)); }
        this.stage.render();
        return this.snapshot();
    }
    snapshot() {
        return { ...this.battle.snapshot(), ready: this.ready, loading: this.loading, selected: this.selected, recall: this.recallMode,
            preview: this.preview, touchConfirm: !!this.touchTarget,
            spellItems: [...this.spells].map(([id, item]) => ({ id, item: "wpn_1400", position: item.group.position.toArray() })),
            models: [...this.models.values()].map(model => ({ entityId: model.entityId, retiring: model.retiring, ...model.snapshot() })),
            effects: { active: this.stage?.effects.active.size || 0, recent: this.stage?.effects.history.slice() || [] },
            viewsPending: this.warming.size };
    }
    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        for (const model of this.allModels) { model.dispose(); }
        this.allModels.clear();
        this.range?.dispose();
        this.stage?.dispose();
        this.pickupElements.forEach(element => element.remove());
        this.pickupElements.clear();
        this.models.clear(); this.retiring.clear();
    }
}
