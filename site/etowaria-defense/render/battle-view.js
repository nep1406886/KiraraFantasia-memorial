import { DefenseStage } from "./stage.js";
import { NativeModel } from "./native-model.js";
import { ENEMY_RULES, UNIT_RULES, TICK } from "../data/campaign.js";
import { Battle } from "../sim/battle.js";
import { RangePreview } from "./range-preview.js";
import * as loader from "../../core/loader.js";
import { createEnemyMotion } from "./enemy-motion.js";
import { applyAuthoredMaterials } from "./native-model.js";
import { ICONS } from "../app/icons.js";

const BURST = "ef_btl_dmg_all_fire_00";
const IMPACT = "ef_btl_dmg_single_00";
const BIRTH = "ef_btl_buff_ring";
const ENEMY_SHOT = "ef_btl_magician_attack_sun_01";
const STATUS_EFFECTS = ["ef_btl_debuff_line", "ef_btl_stun_occur", "ef_btl_buff_line"];
const ELEMENT_BURST = ["fire", "water", "earth", "wind", "moon", "sun"].map(key => `ef_btl_dmg_all_${key}_00`);
const LOADING_PAUSES = new Set(["deploy-load", "enemy-load"]);
const STATUS_BADGES = { slow: ["迟缓", "❄"], stun: ["麻痹", "⚡"], vulnerable: ["易伤", "◆"], weaken: ["虚弱", "▼"], burn: ["灼烧", "✦"] };

export class Facility {
    constructor(view, type = "F01") {
        this.THREE = view.stage.THREE;
        this.group = new this.THREE.Group();
        this.group.name = "defense-support-desk";
        this.kind = "facility";
        this.unit = { id: type, shortName: UNIT_RULES[type].name, name: UNIT_RULES[type].name };
        this.height = .85;
        this.platformHeight = 0;
        this.action = "idle";
        const desk = view.desk.group.clone(true);
        desk.visible = true; desk.position.set(0, 0, 0);
        this.group.add(desk);
        // F11 is the bigger night-shift台: an extra desk plus the camp lantern,
        // so the two producers stay apart on sight alone.
        if (type === "F11") {
            const second = view.desk.group.clone(true);
            second.position.set(.62, 0, 0);
            this.group.add(second);
            if (view.lantern) {
                const lamp = view.lantern.group.clone(true);
                lamp.visible = true; lamp.position.set(-.42, .02, -.34);
                this.group.add(lamp);
            }
        } else {
            const book = view.book.group.clone(true);
            book.visible = true; book.position.set(.02, .46, -.08);
            this.group.add(book);
        }
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

// F13 稻草人诱饵: the original training scarecrow (スーパーかかしくん rig 5200)
// rendered as a static board prop — the pose stays authored; only the straw
// arms drift, driven by createEnemyMotion's zero-stride profile.
export class Scarecrow {
    constructor(view) {
        this.THREE = view.stage.THREE;
        this.group = new this.THREE.Group();
        this.group.name = "defense-scarecrow";
        this.kind = "facility";
        this.unit = { id: "F13", shortName: "稻草人", name: "稻草人诱饵" };
        this.height = 1.2;
        this.platformHeight = 0;
        this.action = "idle";
    }
    async load(view) {
        const loaded = await loader.load("model/enemy/model_en_5200.muast", { kind: "enemy" });
        applyAuthoredMaterials(loaded.scene, view.stage.THREE, view.stage.assets.anisotropy);
        const tilt = new this.THREE.Group();
        tilt.rotation.x = 0;
        this.group.add(tilt);
        tilt.add(loaded.scene);
        this.root = loaded.scene;
        this.mixer = new this.THREE.AnimationMixer(loaded.scene);
        this.motion = createEnemyMotion(view.stage.THREE, loaded.scene, 5200, 1, 1);
        // The rig already faces the guests; no mirror needed (mirrorForLeft
        // is false in the profile for exactly this reason).
    }
    place(row, col, rows = 5) {
        this.cell = { row, col };
        this.group.position.set((col - 4) * 1.3, 0, (row - (rows - 1) / 2) * 2.1);
    }
    bodyPoint() { return this.group.position.clone().add(new this.THREE.Vector3(0, .7, -.2)); }
    update(dt) { if (this.motion) { this.motion.apply(dt); } if (this.mixer) { this.mixer.update(dt); } }
    dispose() { this.group.removeFromParent(); }
    snapshot() { return { id: "F13", kind: "facility", cell: this.cell, position: this.group.position.toArray() }; }
}

export class BattleView {
    static async create(options) {
        const view = new BattleView(options);
        try {
            view.stage = await DefenseStage.createField({ ...options, theme: options.level.theme || "day",
                onFieldInput: cell => view.input(cell.row, cell.col, cell.event.pointerType),
                onFieldHover: (cell, point) => view.hover(cell, point),
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
        this.battle = new Battle(options.level, { deck: options.deck, seed: options.seed });
        this.models = new Map();
        this.allModels = new Set();
        this.unitPools = new Map();
        this.enemyPools = new Map();
        this.enemyLoads = new Map();
        this.heldSpawns = [];
        this.warming = new Map();
        this.retiring = new Set();
        this.spells = new Map();
        this.pickupElements = new Map();
        this.floaters = [];
        this.visualEvents = [];
        this.throttle = new Map();
        this.selected = null;
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

    unitData(type) { return this.catalogue.units.find(row => row.id === type); }

    async load() {
        const stage = this.stage;
        stage.selection.visible = false;
        stage.grid.visible = true;
        stage.renderer.domElement.setAttribute("aria-label", "布阵战场。选择卡牌后点空格部署，或使用键盘方向键和回车。");
        stage.battleTick = dt => this.tick(dt);
        stage.afterBattleFrame = dt => this.afterFrame(dt);
        stage.afterRender = () => this.projectOverlay();
        this.desk = stage.props.find(prop => prop.name === "desk");
        this.lantern = stage.props.find(prop => prop.name === "lantern");
        this.book = await stage.loadProp(stage.assets.native.furniture.goods_1083, "producer-book", .32);
        this.book.group.visible = false;
        const tasks = [];
        for (const type of this.battle.deck) {
            if (type.startsWith("U")) {
                const count = type === "U01" ? 2 : 1;
                for (let i = 0; i < count; i++) { tasks.push(() => this.createUnit(type)); }
            }
        }
        for (const [type, count] of this.enemyNeeds()) {
            for (let i = 0; i < count; i++) { tasks.push(() => this.createEnemy(type)); }
        }
        let cursor = 0;
        let complete = 0;
        const workers = Array.from({ length: 4 }, async () => {
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
        this.options.onProgress?.(.8, "准备原生招式特效");
        await stage.effects.prepare([IMPACT, BIRTH, "ef_btl_common_dead", "ef_btl_barrier_00", ...STATUS_EFFECTS], 6);
        if ([...this.battle.deck].some(type => UNIT_RULES[type].kind === "burst" || UNIT_RULES[type].kind === "lobber")) { await stage.items.prepare(); }
        if (this.battle.deck.has("F10")) { await stage.effects.prepare([BURST], 10); }
        for (const type of this.battle.deck) { await this.prepareUnitEffects(type, type === "U01" ? 5 : 3); }
        // Pre-render the range preview once so the first placement doesn't
        // stall the main thread on a fresh shader; the user sees the grid
        // only when pointing at a cell.
        this.range.show(UNIT_RULES[[...this.battle.deck][0] || "U01"], 0, 0, this.level);
        stage.render();
        this.range.clear();
        await stage.effects.prepare(this.enemyEffects(), 3);
        this.options.onProgress?.(1, "原生模型与招式已就绪");
        this.markBoard();
        this.ready = true;
        stage.startLoop();
        stage.render();
        this.notify();
    }

    // Models each enemy type needs at once: scheduled guests per type, plus
    // summons. Endless mode tops pools up as waves are planned.
    enemyNeeds() {
        const counts = new Map();
        if (this.level.endless) {
            for (const spawn of this.battle.spawns) { counts.set(spawn.type, Math.min(4, (counts.get(spawn.type) || 0) + 1)); }
        } else {
            for (const spawn of this.level.spawns) { counts.set(spawn.type, (counts.get(spawn.type) || 0) + 1); }
        }
        for (const [type, extra] of Object.entries(this.level.extraModels || {})) { counts.set(type, (counts.get(type) || 0) + extra); }
        return counts;
    }

    enemyEffects() {
        const names = new Set();
        const types = this.level.endless ? Object.keys(ENEMY_RULES) : [...this.enemyNeeds().keys()];
        for (const type of types) {
            if (ENEMY_RULES[type].ranged) { names.add(ENEMY_SHOT); }
            if (ENEMY_RULES[type].healer || ENEMY_RULES[type].revive) { names.add("ef_btl_recover_00"); names.add("ef_btl_recover_01"); }
        }
        return [...names];
    }

    async createUnit(type) {
        const unit = this.unitData(type);
        if (!unit) { throw new Error(`未绑定角色卡：${type}`); }
        const model = await NativeModel.player(this.stage.assets, unit);
        if (this.disposed || this.options.isCurrent && !this.options.isCurrent()) {
            model.dispose(); throw new Error("本次素材准备已取消");
        }
        if (UNIT_RULES[type].kind === "lobber") { model.trailTexture = await this.stage.items.prepareTrail(unit.elementId); }
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
        model.gaitRate = spec.speed * 1.3 / Math.max(.01, model.motion.speed || .2);
        this.allModels.add(model);
        if (!this.enemyPools.has(type)) { this.enemyPools.set(type, []); }
        this.enemyPools.get(type).push(model);
        return model;
    }

    // Everything a card can show, prepared before it is placed: the class
    // attack, the original skill its special draws on, and status visuals.
    plans(type) {
        const unit = this.unitData(type);
        const rule = UNIT_RULES[type];
        const attack = this.stage.effects.actionPlan(unit, "attack");
        let skill = null;
        if (rule.special || ["guard", "healer", "shielder", "beacon"].includes(rule.kind)) {
            try { skill = this.stage.effects.actionPlan(unit, "skill"); } catch { skill = null; }
        }
        return { unit, rule, attack, skill };
    }

    async prepareUnitEffects(type, copies) {
        if (!type.startsWith("U")) { return; }
        const { unit, rule, attack, skill } = this.plans(type);
        const names = attack.events.map(event => event.effect);
        if (skill) { names.push(...skill.events.map(event => event.effect)); }
        if ((unit.classId === 3 || unit.classId === 4) && ["shooter", "lobber"].includes(rule.kind)) { names.push(ENEMY_SHOT); }
        if (rule.splash || rule.onHit?.splash || rule.special?.type === "wave") { names.push(ELEMENT_BURST[unit.elementId]); }
        if (["healer", "guard"].includes(rule.kind) || rule.selfHeal) { names.push("ef_btl_recover_00", "ef_btl_recover_01"); }
        if (["shielder", "beacon"].includes(rule.kind) || rule.barrier || rule.guardReduction) { names.push("ef_btl_buff_ring", "ef_btl_buff_line"); }
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
        lines.name = "deployment-board-grid";
        lines.renderOrder = 1500;
        lines.visible = false;
        material.opacity = 0;
        this.stage.environment.add(lines);
        this.board = { lines, peak: .42 };
        if (this.level.rows === 3) {
            this.stage.field.scale.set(7 / 9, 3 / 5, 1);
        }
        // Gate badges sit left of column 0; enemies appear past the last column.
        this.stage.frame = { xMin: this.world(0, -1.3).x, xMax: this.world(0, this.level.cols + .95).x,
            zMin: this.world(-.5, 0).z, zMax: this.world(this.level.rows - .5, 0).z, headroom: 1.25, padBottom: .12 };
        this.stage.resize();
    }

    select(type) {
        // Gear is carried alongside the roster, not part of battle.deck.
        if (!this.battle.deck.has(type) && UNIT_RULES[type]?.kind !== "gear") { return; }
        if (this.selected === type && !this.recallMode) { this.cancelPlacement(); return; }
        this.clearPreview();
        this.selected = type;
        this.recallMode = false;
        this.syncBoard();
        this.holdGhost(type);
        this.options.onNotice?.(UNIT_RULES[type].help);
        this.notify();
    }

    setRecall(enabled) {
        this.clearPreview();
        this.recallMode = enabled;
        if (enabled) { this.selected = null; this.releaseGhost(); }
        this.syncBoard();
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

    // The board lines belong to the act of placing: a held card or the recall
    // tool, including a touch placement awaiting confirmation. Placing,
    // recalling or cancelling puts the card back and the lines fade out.
    boardWanted() {
        return this.ready && (!!this.selected || this.recallMode) && ["setup", "running"].includes(this.battle.phase)
            && [...this.battle.pauses].every(reason => LOADING_PAUSES.has(reason));
    }

    syncBoard(dt = 0) {
        if (!this.board) { return; }
        const { lines, peak } = this.board;
        const target = this.boardWanted() ? peak : 0;
        const opacity = lines.material.opacity;
        // Frames stop while paused, so a fade could never finish there.
        lines.material.opacity = this.options.audio.settings.reducedMotion || this.options.manualClock || this.battle.pauses.size ? target
            : opacity < target ? Math.min(target, opacity + dt * peak / .14) : Math.max(target, opacity - dt * peak / .22);
        lines.visible = lines.material.opacity > 0;
    }

    cancelPlacement() {
        this.clearPreview(); this.recallMode = false; this.selected = null;
        this.releaseGhost();
        this.syncBoard();
        this.options.onNotice?.("已取消部署。选择卡牌可以重新预览。");
        this.notify();
    }

    // The card in hand is the very model that will be planted: it rides the
    // pointer, and deploying hands it to the field instead of loading another.
    async holdGhost(type) {
        this.releaseGhost();
        const token = Symbol(type);
        this.ghostToken = token;
        let model;
        if (type === "F13") {
            const scare = new Scarecrow(this); await scare.load(this); model = scare; this.allModels.add(model);
        } else if (UNIT_RULES[type].kind === "producer") {
            model = new Facility(this, type); this.allModels.add(model);
        } else if (UNIT_RULES[type].kind === "burst") {
            if (!this.stage.items.template) { return; }
            const item = await this.stage.items.bottle(.8);
            model = { kind: "item", item, group: item.group };
        } else if (UNIT_RULES[type].kind === "gear") {
            // 装备卡是对已部署单位使用的，不在场上种植——随光标的 ghost 让它看起来像悬浮卡牌。
            // 这里只放一个透明占位，让 moveGhost 有目标可移，但不创建模型。
            const placeholder = new this.THREE.Group();
            placeholder.name = `ghost-gear-${type}`;
            model = { kind: "ghost-gear", group: placeholder };
        } else {
            if (this.warming.has(type)) { await this.warming.get(type); }
            if (!this.unitPools.get(type)?.length) {
                try { await this.createUnit(type); } catch (error) { if (!this.disposed) { this.options.onError?.(error); } return; }
            }
            if (this.disposed || this.ghostToken !== token) { return; }
            model = this.unitPools.get(type).pop();
            model.retiring = false;
            model.configureIdle?.({ enabled: false });
            if (model.action !== "idle") { model.play("idle"); }
        }
        if (this.ghostToken !== token || this.disposed) {
            this.returnGhostModel(type, model); return;
        }
        this.ghost = { type, model };
        model.group.visible = false;
        this.stage.scene.add(model.group);
        if (this.ghostPoint) { this.moveGhost(this.ghostPoint); }
        else if (this.lastTarget) { this.moveGhost(this.world(this.lastTarget.row, this.lastTarget.col)); }
    }

    returnGhostModel(type, model) {
        model.group.removeFromParent();
        model.group.visible = true;
        if (model.kind === "facility") { model.dispose(); this.allModels.delete(model); }
        else if (model.kind === "item") { this.stage.items.release(model.item); }
        else if (model.kind === "player") { this.unitPools.get(type).push(model); }
    }

    releaseGhost() {
        this.ghostToken = null;
        if (!this.ghost) { return; }
        const { type, model } = this.ghost;
        this.ghost = null;
        this.returnGhostModel(type, model);
    }

    takeGhost(type) {
        if (this.ghost?.type !== type) { return null; }
        const { model } = this.ghost;
        this.ghost = null; this.ghostToken = null;
        model.group.visible = true;
        if (model.kind === "item") { this.stage.items.release(model.item); return null; }
        model.group.removeFromParent();
        return model;
    }

    moveGhost(point) {
        const ghost = this.ghost;
        if (!ghost) { return; }
        if (!point) { ghost.model.group.visible = false; this.stage.render(); return; }
        const rows = this.stage.rows;
        const row = point.z / 2.1 + (rows - 1) / 2;
        const col = point.x / 1.3 + 4;
        const lift = .16 + (this.options.audio.settings.reducedMotion ? 0 : Math.sin(this.visualTime * 5) * .04);
        if (ghost.model.place) { ghost.model.place(row, col, rows); }
        ghost.model.group.position.set(point.x, lift + (ghost.model.kind === "item" ? .45 : 0), point.z);
        ghost.model.group.visible = true;
        this.stage.render();
    }

    // Touch drag from the card bank. Coordinates are client pixels.
    dragTo(x, y) {
        if (x === null) { this.ghostPoint = null; this.moveGhost(null); this.clearPreview(); this.notify(); return; }
        const point = this.stage.groundAt(x, y);
        this.ghostPoint = point;
        this.moveGhost(point);
        const cell = point && this.stage.cellOf(point);
        if (cell) { this.pointCell(cell.row - this.level.rowOffset, cell.col - this.level.colOffset); }
        else { this.clearPreview(); this.notify(); }
    }

    dropAt(x, y) {
        const point = this.stage.groundAt(x, y);
        const cell = point && this.stage.cellOf(point);
        this.ghostPoint = null;
        if (!cell) { this.moveGhost(null); this.clearPreview(); this.notify(); return null; }
        return this.deployCell(cell.row - this.level.rowOffset, cell.col - this.level.colOffset);
    }

    hover(cell, point = null) {
        if (!this.ready || this.loading || this.touchTarget || this.battle.pauses.size) { return; }
        this.ghostPoint = point;
        this.moveGhost(point);
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
        if (!this.ghostPoint) { this.moveGhost(this.world(row, col)); }
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
            this.options.onNotice?.(!preview?.valid ? preview?.reason || "这里无法部署"
                : this.recallMode ? "已选中要召回的对象。再次点同一格或按确认召回。" : "已显示范围。再次点同一格或按确认部署。");
            return;
        }
        return this.deployCell(row, col);
    }

    async deployCell(row, col) {
        if (!this.ready || this.disposed || this.loading) { return { ok: false, reason: "素材准备中" }; }
        if (!this.selected && !this.recallMode) {
            this.options.onNotice?.("请先选择一张卡牌。");
            return { ok: false, reason: "请先选择一张卡牌。" };
        }
        this.pointCell(row, col);
        if (this.recallMode) {
            const refunded = this.battle.phase === "setup";
            const result = this.battle.recall(row, col);
            if (!result.ok) { this.options.onNotice?.(result.reason); }
            else {
                this.clearPreview();
                this.recallMode = false;
                this.syncBoard();
                this.options.onNotice?.(refunded ? "已召回，费用全额退还。" : "已召回。开战后召回不退还费用。");
            }
            this.consumeEvents(); this.notify();
            return result;
        }
        const type = this.selected;
        const check = this.battle.canDeploy(type, row, col);
        const rule = UNIT_RULES[type];
        if (!check.ok) { this.options.onNotice?.(check.reason); return check; }
        this.loading = true;
        this.setPaused("deploy-load", true);
        let model;
        try {
            const held = this.takeGhost(type);
            if (type === "F13") {
                const scare = held || new Scarecrow(this);
                if (!held) { await scare.load(this); }
                model = scare; this.allModels.add(model);
            } else if (rule.kind === "producer") {
                model = held || new Facility(this, type);
                this.allModels.add(model);
            } else if (type.startsWith("U")) {
                if (held) { model = held; }
                else {
                    if (this.warming.has(type)) { await this.warming.get(type); }
                    if (!this.unitPools.get(type)?.length) { await this.createUnit(type); }
                    if (this.disposed) { return { ok: false }; }
                    model = this.unitPools.get(type).pop();
                }
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
                if (this.selected === type) { this.holdGhost(type); }
                return result;
            }
            if (model) { this.addModel(result.id, model, row, col); }
            this.clearPreview();
            this.selected = null;
            this.syncBoard();
            this.options.onNotice?.(`${UNIT_RULES[type].name}已部署在第${row + 1}路第${col + 1}格。`);
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
        button.className = `battle-unit-status ${model.kind}`;
        button.dataset.entity = model.entityId;
        const name = document.createElement("span"); name.className = "battle-unit-name";
        name.textContent = model.unit.name;
        const badges = document.createElement("span"); badges.className = "status-badges";
        const track = document.createElement("span"); track.className = "life-track";
        const fill = document.createElement("span"); fill.className = "life-fill"; track.append(fill);
        const shield = document.createElement("span"); shield.className = "shield-fill"; shield.hidden = true;
        const text = document.createElement("span"); text.className = "sr-only";
        button.append(name, badges, track, shield, text);
        button.addEventListener("click", event => {
            event.stopPropagation();
            const unit = this.battle.units.get(model.entityId) || this.battle.enemies.get(model.entityId);
            if (!unit) { return; }
            // While a card is held, a left click anywhere on the field means
            // "plant here" — the status label must not swallow it into an
            // inspect dialog. `deployCell` still reports why a cell refuses.
            if (this.selected || this.recallMode) {
                this.deployCell(unit.row, unit.col);
                return;
            }
            this.options.onInspect?.(unit, model.kind);
        });
        this.options.labels.append(button);
        model.label = button;
        model.labelAnchor = "head";
        model.hpFill = fill;
        model.shieldFill = shield;
        model.badges = badges;
        model.hpText = text;
        model.statusKey = null;
    }

    updateStatus(model) {
        const entity = this.battle.units.get(model.entityId) || this.battle.enemies.get(model.entityId);
        if (!entity || !model.label) { return; }
        const time = this.battle.time;
        const ratio = Math.max(0, Math.min(1, entity.hp / entity.maxHp));
        const guard = model.kind === "enemy" ? entity.armor : entity.shield + (entity.barrierHits > 0 ? 1 : 0);
        const guardMax = model.kind === "enemy" ? entity.maxArmor : Math.max(entity.maxShield || 0, entity.barrierHits > 0 ? 1 : 0);
        const statuses = model.kind === "enemy" ? Object.keys(STATUS_BADGES).filter(key => (entity[`${key}Until`] || 0) > time) : [];
        const hasted = model.kind !== "enemy" && entity.hasteUntil > time;
        const key = `${Math.round(ratio * 200)}:${Math.round(guard || 0)}:${statuses.join()}:${hasted}`;
        if (model.statusKey === key) { return; }
        model.statusKey = key;
        model.hpFill.style.transform = `scaleX(${ratio})`;
        model.label.classList.toggle("critical", ratio <= .25);
        model.label.classList.toggle("shown", ratio < .999 || guard > 0 && ratio < .999 || statuses.length > 0 || model.kind === "enemy" && entity.maxArmor > 0 && guard < entity.maxArmor);
        model.shieldFill.hidden = !(guard > 0);
        model.shieldFill.classList.toggle("armor", model.kind === "enemy");
        if (guard > 0) { model.shieldFill.style.transform = `scaleX(${Math.min(1, guard / Math.max(1, guardMax))})`; }
        model.badges.replaceChildren(...statuses.map(status => {
            const badge = document.createElement("i"); badge.className = `badge ${status}`; badge.textContent = STATUS_BADGES[status][1];
            return badge;
        }), ...(hasted ? [Object.assign(document.createElement("i"), { className: "badge haste", textContent: "»" })] : []));
        const states = statuses.map(status => STATUS_BADGES[status][0]).join("、");
        const text = `${model.unit.name}，第${entity.row + 1}路，生命${Math.ceil(entity.hp)} / ${entity.maxHp}${guard > 0 ? `，${model.kind === "enemy" ? "护甲" : "护盾"}${Math.ceil(guard)}` : ""}${states ? `，${states}` : ""}${ratio <= .25 ? "，危急" : ""}`;
        model.label.setAttribute("aria-label", text);
        model.hpText.textContent = text;
    }

    consumeEvents() {
        for (const event of this.battle.drainEvents()) {
            this.present(event);
            this.options.onEvent?.(event);
        }
    }

    // One visual answer per simulation event; the simulation never waits on these.
    async present(event) {
        const model = this.models.get(event.id);
        switch (event.type) {
        case "spawned": this.spawnModel(event); break;
        case "pickup": {
            const button = document.createElement("button"); button.className = "resource-pickup";
            button.innerHTML = ICONS.crea; button.append(`+${event.amount}`); button.dataset.pickup = event.id;
            button.setAttribute("aria-label", `收取${event.amount}クリエ`);
            button.addEventListener("click", click => { click.stopPropagation(); this.battle.collect(event.id); this.consumeEvents(); this.notify(); });
            this.options.overlay.append(button);
            this.pickupElements.set(event.id, button);
            break;
        }
        case "collected": this.pickupElements.get(event.id)?.remove(); this.pickupElements.delete(event.id); break;
        case "deployed": if (model) { this.emit(BIRTH, model.group.position.clone(), .65); } break;
        case "gearApplied":
            if (model) {
                this.emit("ef_btl_recover_00", model.group.position.clone(), model.scale || .7);
                this.emit("ef_btl_recover_01", model.group.position.clone(), model.scale || .7);
                this.equipGear(model, event.gear);
                if (event.label) { this.floater(model, event.label, "gear"); }
            }
            break;
        case "unitAction": this.unitAction(event); break;
        case "enemyAttack": this.enemyAttack(event, model); break;
        case "projectile": this.projectile(event); break;
        case "projectileRemoved": this.projectileRemoved(event); break;
        case "lob": this.lob(event); break;
        case "enemyHurt":
            if (model) {
                if (event.source !== "burn") { this.emit(IMPACT, model.bodyPoint(), event.critical ? .9 : .6); }
                if (model.action === "idle" && !model.walking && !model.hop) { model.play("damage", false); }
                if (event.amount > 0) { this.floater(model, String(event.amount), event.critical ? "critical" : event.source === "burn" ? "burn" : "damage"); }
                else if (event.absorbed > 0) { this.floater(model, "护甲", "armor"); }
            }
            break;
        case "unitHurt":
            if (model) {
                this.emit(IMPACT, model.bodyPoint(), .6);
                if (model.action === "idle" && model.kind !== "facility") { model.play("damage", false); }
                if (event.kind === "thorns") { this.floater(model, `反伤 ${event.amount}`, "hurt"); }
            }
            break;
        case "healed":
            if (model) {
                const scale = model.scale || .6;
                this.emit("ef_btl_recover_00", model.group.position.clone(), scale);
                this.emit("ef_btl_recover_01", model.group.position.clone(), scale);
                this.floater(model, `+${event.amount}`, "heal");
            }
            break;
        case "shielded":
            if (model) { this.emit("ef_btl_barrier_00", model.bodyPoint(), .7, { facing: model.kind === "enemy" ? 1 : -1 }); this.floater(model, `护盾 ${event.shield}`, "shield"); }
            break;
        case "blocked":
            if (model && this.ready && this.once(`block:${event.id}`, .35)) { this.emit("ef_btl_barrier_00", model.bodyPoint(), .8, { facing: model.kind === "enemy" ? 1 : -1 }); this.floater(model, "格挡", "shield"); }
            break;
        case "beaconPulse": this.beacon(event, model); break;
        case "status": this.status(event, model); break;
        case "armorBroken":
            if (model && this.once(`armor:${event.id}`, 1)) { this.emit("ef_btl_debuff_line", model.group.position.clone(), .7); this.floater(model, "碎甲", "armor"); }
            break;
        case "enemyHop":
            if (model) { model.hop = { start: this.visualTime, duration: .7, from: this.world(this.battle.enemies.get(event.id)?.row ?? 0, event.from).x }; }
            break;
        case "enemyDown": if (model) { model.walking = false; model.play("dead", false); this.floater(model, "还会起来……", "armor"); } break;
        case "enemyRevived":
            if (model) {
                model.play("idle");
                this.emit("ef_btl_recover_00", model.group.position.clone(), .7);
                this.emit("ef_btl_recover_01", model.group.position.clone(), .7);
            }
            break;
        case "enemySpores":
            if (model) {
                model.play("skill_1", false);
                for (const healed of event.healed.slice(0, 4)) {
                    const other = this.models.get(healed.id);
                    if (other) { this.emit("ef_btl_recover_00", other.group.position.clone(), .6); this.floater(other, `+${healed.amount}`, "enemy-heal"); }
                }
            }
            break;
        case "summon": if (model) { model.play("skill_1", false); this.options.onNotice?.(`${ENEMY_RULES[this.battle.enemies.get(event.id)?.type || "E13"].name}召唤了手下！`); } break;
        case "unitRemoved": case "enemyRemoved": this.retire(event.id, event.reason); break;
        case "gate":
            this.emit("ef_btl_barrier_00", this.world(event.row, -.4), 1.2);
            this.options.onNotice?.(`第${event.row + 1}路的紧急结界已消耗。下一次突破将失守。`);
            break;
        case "warning":
            this.options.onWarning?.(event);
            if (this.level.endless) { this.ensureEnemies(); }
            break;
        case "restockEarned": this.options.onNotice?.(
            `第${event.wave}波守完，获得一次换卡机会（打开「换卡」按钮使用）。`); break;
        case "waveCleared": this.options.onNotice?.(
            event.modifier
                ? `第${event.wave}波·${event.modifier === "boss" ? "BOSS" : event.modifier === "elite" ? "精英" : event.modifier === "rush" ? "急袭" : "群袭"}已守完，应援 +${event.bonus || 0}。`
                : `第${event.wave}波来客已全部击退。`); break;
        case "burst": {
            const item = this.spells.get(event.id);
            if (item) { this.stage.items.release(item); this.spells.delete(event.id); }
            for (let row = Math.max(0, event.row - 1); row <= Math.min(this.level.rows - 1, event.row + 1); row++) {
                for (let col = Math.max(0, event.col - 1); col <= Math.min(this.level.cols - 1, event.col + 1); col++) {
                    this.emit(BURST, this.world(row, col, .22), 1);
                }
            }
            break;
        }
        case "spellCast": {
            const item = await this.stage.items.bottle(.8);
            item.group.position.copy(this.world(event.row, event.col, .48));
            this.stage.scene.add(item.group); this.spells.set(event.id, item);
            this.options.onNotice?.("爆破药瓶将在1秒后生效。");
            break;
        }
        case "finished":
            this.clearPreview();
            this.releaseGhost(); this.selected = null; this.recallMode = false;
            this.syncBoard();
            for (const item of this.spells.values()) { this.stage.items.release(item); }
            this.spells.clear();
            this.visualEvents = [];
            this.stage.effects.reset();
            this.stage.items.reset();
            this.pickupElements.forEach(element => element.remove()); this.pickupElements.clear();
            for (const player of this.stage.players) {
                if (!player.retiring && player.actor && event.result === "won") { player.play("win_st_0", false); }
            }
            this.options.onFinished?.(event);
            break;
        default: break;
        }
    }

    emit(name, point, scale = 1, extra = {}) {
        if (!this.stage.effects.pools.has(name)) { return null; }
        return this.stage.effects.emit(name, { from: point, scale, ...extra });
    }

    once(key, seconds) {
        const last = this.throttle.get(key);
        if (last !== undefined && this.visualTime - last < seconds) { return false; }
        this.throttle.set(key, this.visualTime);
        return true;
    }

    plan(type) {
        this.planCache ??= new Map();
        if (!this.planCache.has(type)) { this.planCache.set(type, this.plans(type)); }
        return this.planCache.get(type);
    }

    unitAction(event) {
        const model = this.models.get(event.id);
        if (!model || model.retiring || !model.actor) { return; }
        const { rule, attack, skill } = this.plan(model.unit.id);
        const useSkill = skill && event.action !== "attack";
        const plan = useSkill ? skill : attack;
        try { model.play(plan.action, false); } catch { model.play("attack", false); }
        const melee = rule.kind === "fighter" || rule.kind === "guard";
        const supportAction = ["heal", "shield"].includes(event.action);
        for (const effect of plan.events) {
            if (/Attach|Trail/.test(effect.kind)) { continue; }
            if (effect.kind === "Support" && supportAction) { continue; }
            const projectile = /Projectile/.test(effect.kind);
            if (projectile && !melee) { continue; }
            this.visualEvents.push({ at: this.battle.time + effect.frame / 30, run: () => {
                const live = this.models.get(event.id);
                if (!live || live.retiring) { return; }
                if (projectile) {
                    const target = this.models.get(event.target);
                    if (!target) { return; }
                    this.emit(effect.effect, live.bodyPoint(), live.scale, { to: target.bodyPoint(), flight: .22, facing: -1 });
                    return;
                }
                const receiver = effect.kind === "Support" && effect.anchor === "ally" ? this.models.get(event.target) || live : live;
                this.emit(effect.effect, receiver.group.position.clone(), live.scale, { facing: -1 });
            } });
        }
        if (event.action === "barrier") { this.emit("ef_btl_barrier_00", model.bodyPoint(), .9, { facing: model.kind === "enemy" ? 1 : -1 }); this.floater(model, "屏障×3", "shield"); }
        if (event.special === "critical" || event.special === "power") { this.emit("ef_btl_buff_line", model.group.position.clone(), model.scale, { facing: model.kind === "enemy" ? 1 : -1 }); }
    }

    projectile(event) {
        const model = this.models.get(event.source);
        if (!model) { return; }
        const { attack, skill } = this.plan(model.unit.id);
        const penetrate = event.wave && skill?.events.find(effect => /Projectile/.test(effect.kind));
        const graphic = penetrate || attack.events.find(effect => /Projectile/.test(effect.kind))
            || (model.unit.classId === 3 || model.unit.classId === 4
                // Knight and Alchemist attack graphs carry no native projectile
                // (only the Magician line does); their ranged adaptations borrow
                // the prepared sun-bolt effect so the shot still reads on screen.
                ? { effect: ENEMY_SHOT, kind: "EffectProjectile_Straight" } : null);
        if (!graphic) { throw new Error("远程攻击没有精确原生投射物绑定"); }
        const from = model.muzzlePoint();
        const scale = model.scale * (event.critical ? 1.6 : event.wave && !penetrate ? 1.5 : 1);
        let destination = this.models.get(event.targetId)?.bodyPoint() || this.world(event.row, this.level.cols, .4);
        const startX = event.x;
        const slot = this.stage.effects.emit(graphic.effect, { from, scale, facing: -1,
            position: () => {
                const projectile = this.battle.projectiles.get(event.id);
                if (!projectile) { return null; }
                const target = this.battle.enemies.get(event.targetId);
                if (target && !event.pierce) { destination = this.models.get(target.id)?.bodyPoint() || destination; }
                const logicalEnd = event.pierce ? this.level.cols + 1.4 : target?.x ?? this.level.cols;
                const fraction = Math.max(0, Math.min(1, (projectile.x - startX) / Math.max(.1, logicalEnd - startX)));
                const position = from.clone().lerp(destination, Math.min(1, fraction * (event.pierce ? 3 : 1)));
                position.x = this.world(projectile.row, projectile.x).x;
                return position;
            } });
        // A busy pool now grows on demand (native-effects emit); if this shot
        // still misses a slot the sim keeps running — the projectile exists in
        // the simulation and still damages, it simply has no art for one frame.
    }

    projectileRemoved(event) {
        if (!event.hit) { return; }
        const target = this.models.get(event.hit);
        const source = this.models.get(this.battle.projectiles.get(event.id)?.source) || null;
        const rule = source ? UNIT_RULES[source.unit.id] : null;
        if (target && rule?.splash) { this.emit(ELEMENT_BURST[source.unit.elementId], target.group.position.clone(), .55); }
    }

    lob(event) {
        const model = this.models.get(event.source);
        const target = this.models.get(event.targetId);
        if (!model || !target || !model.trailTexture) { return; }
        const { rule, attack } = this.plan(model.unit.id);
        const attached = attack.events.find(effect => effect.kind === "EffectAttach")?.effect;
        const element = model.unit.elementId;
        this.stage.items.launch({ model, to: target.bodyPoint(), attached, texture: model.trailTexture,
            onImpact: point => {
                if (this.disposed) { return; }
                this.emit(IMPACT, point, .8);
                if (rule.onHit?.splash) { this.emit(ELEMENT_BURST[element], point.clone().setY(.1), .6); }
                if (event.special === "stun") { this.emit("ef_btl_stun_occur", point, .8); }
            } });
    }

    enemyAttack(event, model) {
        if (!model) { return; }
        if (event.ranged) {
            model.play("skill_1", false);
            const target = this.models.get(event.target);
            if (target) { this.emit(ENEMY_SHOT, model.bodyPoint(), .75, { to: target.bodyPoint(), flight: Math.max(.2, event.windup - .05), facing: 1 }); }
        } else {
            model.play("skill_0", false);
        }
    }

    beacon(event, model) {
        if (!model || !this.once(`beacon:${event.id}`, 3)) { return; }
        const { skill, attack } = this.plan(model.unit.id);
        try { model.play((skill || attack).action, false); } catch { model.play("attack", false); }
        this.emit("ef_btl_buff_ring", model.group.position.clone(), model.scale);
        for (const id of event.boosted.slice(0, 4)) {
            const ally = this.models.get(id);
            if (ally) { this.emit("ef_btl_buff_line", ally.group.position.clone(), .7); }
        }
    }

    status(event, model) {
        if (!model) { return; }
        for (const status of event.statuses) {
            if (status === "stun") { this.emit("ef_btl_stun_occur", model.bodyPoint(), .8); this.floater(model, "麻痹", "stun"); }
            else if (["slow", "vulnerable", "weaken"].includes(status) && this.once(`${status}:${event.id}`, 1.4)) {
                this.emit("ef_btl_debuff_line", model.group.position.clone(), .7);
                this.floater(model, STATUS_BADGES[status][0], status);
            } else if (status === "knockback") { this.floater(model, "击退", "status"); }
        }
    }

    // Swap the model's hand weapon to the gear's original model so combatants
    // read as holding the same 圣武器 / 职业武器 they were assigned in the
    // original game. Reset the weapon request counter so this overrides the
    // class default loaded at boot. Errors are logged; the sim outcome is
    // unaffected if a weapon GLB fails to load.
    equipGear(model, gearId) {
        if (!model?.actor) { return; }
        const spec = UNIT_RULES[gearId]?.weapon;
        if (!spec || !Number.isInteger(spec.resourceIdR ?? spec.resourceIdL)) { return; }
        const mode = { resourceIdR: spec.resourceIdR ?? spec.resourceIdL };
        model.actor.cancelEquip();
        model.actor.equip(mode).catch(error => {
            console.warn(`装备换武失败 ${gearId}`, error);
        });
    }

    // Floating combat numbers: a small pool of DOM nodes projected each frame.
    floater(model, text, kind) {
        if (!this.options.overlay || this.floaters.length > 28) { return; }
        const element = document.createElement("span");
        element.className = `battle-floater ${kind}`;
        element.textContent = text;
        element.setAttribute("aria-hidden", "true");
        this.options.overlay.append(element);
        const point = model.bodyPoint();
        point.y += .35;
        this.floaters.push({ element, point, start: this.visualTime, jitter: (this.floaters.length % 5 - 2) * 7 });
    }

    spawnModel(event) {
        const model = this.enemyPools.get(event.enemyType)?.shift();
        if (model) { this.placeEnemy(event, model); return; }
        // The rig is still loading: hold the whole battle rather than let an
        // invisible guest walk the lane.
        this.heldSpawns.push(event);
        this.setPaused("enemy-load", true);
        this.loadEnemy(event.enemyType).then(() => this.releaseHeld()).catch(error => { if (!this.disposed) { this.options.onError?.(error); } });
    }

    placeEnemy(event, model) {
        model.retiring = false; model.hop = null;
        this.addModel(event.id, model, event.row, event.x);
        model.group.position.y = 0;
        model.beginWalk();
        if (event.summoned) { this.emit("ef_btl_common_dead", model.bodyPoint(), .55); }
    }

    loadEnemy(type) {
        if (!this.enemyLoads.has(type)) {
            this.enemyLoads.set(type, this.createEnemy(type).finally(() => this.enemyLoads.delete(type)));
        }
        return this.enemyLoads.get(type);
    }

    releaseHeld() {
        if (this.disposed) { return; }
        while (this.heldSpawns.length) {
            const event = this.heldSpawns[0];
            if (!this.battle.enemies.has(event.id)) { this.heldSpawns.shift(); continue; }
            const model = this.enemyPools.get(event.enemyType)?.shift();
            if (!model) { this.loadEnemy(event.enemyType).then(() => this.releaseHeld()).catch(error => this.options.onError?.(error)); return; }
            this.heldSpawns.shift();
            this.placeEnemy(event, model);
        }
        this.setPaused("enemy-load", false);
    }

    // Endless: keep a model ready for each guest announced but not yet arrived.
    ensureEnemies() {
        const upcoming = new Map();
        for (const spawn of this.battle.spawns.slice(this.battle.spawnIndex, this.battle.spawnIndex + 12)) {
            upcoming.set(spawn.type, (upcoming.get(spawn.type) || 0) + 1);
        }
        for (const [type, count] of upcoming) {
            const ready = (this.enemyPools.get(type)?.length || 0) + (this.enemyLoads.has(type) ? 1 : 0);
            if (ready < Math.min(count, 4)) { this.loadEnemy(type).catch(error => { if (!this.disposed) { this.options.onNotice?.(`魔物模型准备失败，将在出现时重试：${error.message}`); } }); }
        }
    }

    retire(id, reason) {
        const model = this.models.get(id);
        if (!model) { return; }
        model.retiring = true;
        model.retireTime = this.visualTime;
        model.label?.remove(); model.label = null; model.statusKey = null;
        if (model.kind === "facility") {
            this.emit("ef_btl_common_dead", model.bodyPoint(), .6);
        } else {
            const clip = reason === "recall" && model.actor ? "battle_out" : "dead";
            if (!(model.kind === "enemy" && model.action === "dead")) { model.play(clip, false); }
            if (reason === "gate") { this.emit("ef_btl_common_dead", model.bodyPoint(), .6); }
        }
        this.retiring.add(model);
    }

    tick(dt) {
        if (!this.ready || this.disposed) { return; }
        this.visualTime += dt;
        try {
            for (const model of this.stage.players) {
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
            const held = new Set(this.heldSpawns.map(event => event.id));
            for (const enemy of this.battle.enemies.values()) {
                if (held.has(enemy.id)) { continue; }
                const model = this.models.get(enemy.id);
                if (!model) { throw new Error("魔物逻辑没有对应模型"); }
                const target = this.world(enemy.row, enemy.x).x;
                const position = model.group.position;
                if (model.hop) {
                    const t = Math.min(1, (this.visualTime - model.hop.start) / model.hop.duration);
                    position.x = model.hop.from + (target - model.hop.from) * t;
                    position.y = Math.sin(Math.PI * t) * 1.2;
                    if (t >= 1) { model.hop = null; position.y = 0; }
                } else if (Math.abs(position.x - target) > .06) {
                    position.x += (target - position.x) * Math.min(1, dt * 12);
                } else { position.x = target; }
                model.cell.col = enemy.x + this.level.colOffset;
                if (enemy.state === "reviving") { model.walking = false; continue; }
                if (enemy.state === "stunned") {
                    model.walking = false;
                    if (model.action !== "abnormal") { model.play("abnormal", true); }
                    continue;
                }
                if (model.action === "abnormal" || model.action === "dead") { model.play("idle"); }
                if (enemy.state === "walking" && model.action === "idle") { model.beginWalk(); }
                else if (enemy.state !== "walking") { model.walking = false; }
            }
            if (this.visualTime - this.lastHud > .08) { this.notify(); this.lastHud = this.visualTime; }
        } catch (error) {
            this.setPaused("error", true);
            this.options.onError?.(error);
        }
    }

    afterFrame(dt) {
        this.syncBoard(dt);
        if (this.ghost?.model.group.visible) {
            this.ghost.model.update?.(dt);
            this.moveGhost(this.ghostPoint || (this.lastTarget ? this.world(this.lastTarget.row, this.lastTarget.col) : null));
        }
        for (const item of this.spells.values()) {
            item.turn.rotation.z = this.options.audio.settings.reducedMotion ? 0 : Math.sin(this.visualTime * 9) * .07;
        }
        for (const model of this.retiring) {
            const elapsed = this.visualTime - model.retireTime;
            if (model.kind === "facility" ? elapsed >= .4 : model.finishedAction === "dead" || elapsed > 1.6 || elapsed > .2 && model.action === "idle") {
                this.retiring.delete(model);
                this.models.delete(model.entityId);
                const list = model.kind === "enemy" ? this.stage.enemies : this.stage.players;
                const index = list.indexOf(model); if (index >= 0) { list.splice(index, 1); }
                model.group.removeFromParent(); model.shadow?.removeFromParent(); model.shadow = null;
                if (model.kind === "player") { this.unitPools.get(model.unit.id).push(model); }
                else if (model.kind === "facility") { this.allModels.delete(model); }
                else if (model.kind === "enemy") {
                    model.hop = null; model.group.position.y = 0;
                    model.play("idle");
                    this.enemyPools.get(model.unit.id)?.push(model);
                }
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
        const still = this.options.audio.settings.reducedMotion;
        this.floaters = this.floaters.filter(floater => {
            const age = this.visualTime - floater.start;
            if (age > .9 || this.disposed) { floater.element.remove(); return false; }
            const point = floater.point.clone().project(this.stage.camera);
            floater.element.style.left = `${(point.x + 1) * this.stage.width / 2 + floater.jitter}px`;
            floater.element.style.top = `${(1 - point.y) * this.stage.height / 2 - (still ? 0 : age * 34)}px`;
            floater.element.style.opacity = String(Math.min(1, (0.9 - age) * 3.2));
            return true;
        });
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
    // resume-from-cache: rebuild the visual model for a sim-side unit that
    // the auto-cache restored directly into this.battle.units. Mirrors the
    // live deployCell path but skips battle.deploy (the sim already owns it).
    async applyDeploymentVisual(unit) {
        const type = unit.type;
        const rule = UNIT_RULES[type];
        if (!rule) { return; }
        let model;
        if (type === "F13") { const scare = new Scarecrow(this); await scare.load(this); model = scare; this.allModels.add(model); }
        else if (rule.kind === "producer") { model = new Facility(this, type); this.allModels.add(model); }
        else if (type.startsWith("U")) {
            if (this.warming.has(type)) { await this.warming.get(type); }
            if (!this.unitPools.get(type)?.length) { await this.createUnit(type); }
            if (this.disposed) { return; }
            model = this.unitPools.get(type).pop();
            const active = [...this.battle.units.values()].filter(row => row.type === type).length;
            await this.prepareUnitEffects(type, active + 3);
        } else { return; }
        if (this.disposed || !model) { return; }
        this.addModel(unit.id, model, unit.row, unit.col);
        if (unit.gear) { this.equipGear(model, unit.gear); }
        this.warm(type);
    }
    setPaused(reason, paused) {
        if (paused && !LOADING_PAUSES.has(reason)) { this.clearPreview(); }
        this.battle.pause(reason, paused);
        this.stage?.setPaused(reason, paused);
        this.syncBoard();
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
            ghost: this.ghost ? { type: this.ghost.type, visible: this.ghost.model.group.visible, position: this.ghost.model.group.position.toArray() } : null,
            boardGrid: this.board ? { wanted: this.boardWanted(), visible: this.board.lines.visible, opacity: this.board.lines.material.opacity } : null,
            spellItems: [...this.spells].map(([id, item]) => ({ id, item: "wpn_1400", position: item.group.position.toArray() })),
            models: [...this.models.values()].map(model => ({ entityId: model.entityId, retiring: model.retiring, ...model.snapshot() })),
            effects: { active: this.stage?.effects.active.size || 0, recent: this.stage?.effects.history.slice() || [] },
            floaters: this.floaters.map(floater => floater.element.textContent),
            heldSpawns: this.heldSpawns.length, viewsPending: this.warming.size };
    }
    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        this.ghost = null;
        for (const model of this.allModels) { model.dispose(); }
        this.allModels.clear();
        this.range?.dispose();
        this.stage?.dispose();
        this.pickupElements.forEach(element => element.remove());
        this.pickupElements.clear();
        this.floaters.forEach(floater => floater.element.remove()); this.floaters = [];
        this.models.clear(); this.retiring.clear();
    }
}
