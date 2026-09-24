import * as loader from "../../core/loader.js";
import * as nativeScene from "../../core/uniqueskill.js";
import { installModelRenderOrder } from "../../core/model-render-order.js";
import { loadRuntimeAssets, siteUrl } from "../app/assets.js";
import { NativeModel, PITCH, posedBounds } from "./native-model.js";
import { NativeEffects } from "./native-effects.js";
import { NativeItems } from "./native-items.js";

const ENEMIES = [
    { id: "E01", resourceId: 10000, name: "小黑怪", height: 0.82 },
    { id: "E02", resourceId: 10100, name: "松鼠", height: 0.92 },
    { id: "E04", resourceId: 10200, name: "土台", height: 0.82 }
];
const PLACEMENT = { U01: [0, 2], U07: [2, 4], U11: [0, 5], U12: [2, 5], U15: [2, 2], U19: [4, 2] };
const THEMES = {
    day: { title: "里口花径", caption: "里外的花径", rows: 5 },
    camp: { title: "星灯营地", caption: "营灯点亮之后", rows: 5 },
    water: { title: "浅湾合宿", caption: "先准备好落脚的地方", rows: 6 }
};

export class DefenseStage {
    static async create(options) {
        const assets = await loadRuntimeAssets();
        const stage = new DefenseStage(assets, options);
        try {
            await stage.load();
            return stage;
        } catch (error) {
            stage.dispose();
            throw error;
        }
    }

    static async createField(options) {
        const assets = await loadRuntimeAssets();
        const stage = new DefenseStage(assets, { ...options, units: [] });
        try {
            await stage.loadScenery();
            if (options.isCurrent && !options.isCurrent()) { throw new Error("本次场地准备已取消"); }
            await stage.setTheme("day");
            return stage;
        } catch (error) {
            stage.dispose();
            throw error;
        }
    }

    constructor(assets, options) {
        this.assets = assets;
        this.THREE = assets.THREE;
        this.options = options;
        this.audio = options.audio;
        this.host = options.host;
        this.viewport = this.host.parentElement;
        this.labels = options.labels;
        this.theme = "day";
        this.rows = 5;
        this.players = [];
        this.enemies = [];
        this.props = [];
        this.platforms = [];
        this.events = [];
        this.pauseReasons = new Set();
        this.time = 0;
        this.frames = 0;
        this.demo = false;
        this.epoch = 0;
        this.disposed = false;
        this.busy = false;
        this.selected = options.units[0]?.id;
        const THREE = this.THREE;
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.domElement.tabIndex = 0;
        this.renderer.domElement.setAttribute("aria-label", "原生模型场景：点击伙伴选择，点击空格试摆");
        this.host.replaceChildren(this.renderer.domElement);
        assets.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-8, 8, 3.2, -3.2, 0.1, 100);
        this.camera.position.set(0, 18.55, 18 / Math.tan(PITCH));
        this.camera.lookAt(0, 0.55, 0);
        this.environment = new THREE.Group();
        this.scene.add(this.environment);
        this.effects = new NativeEffects(assets, this.scene);
        this.items = new NativeItems(this);
        this.removeSort = installModelRenderOrder(this.renderer, this.scene, THREE, {
            getAuthoredOrder: mesh => mesh.userData.defenseAuthoredOrder ?? mesh.renderOrder,
            frameStamp: () => this.frames
        });
        this.ray = new THREE.Raycaster();
        this.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this.pointer = new THREE.Vector2();
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.viewport);
        this.pointerDown = event => {
            this.down = { x: event.clientX, y: event.clientY };
            this.renderer.domElement.focus({ preventScroll: true });
        };
        this.pointerUp = event => {
            if (!this.down || Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 8) { return; }
            this.down = null;
            this.pick(event);
        };
        this.pointerCancel = () => { this.down = null; };
        this.pointerMove = event => {
            if (event.pointerType !== "touch" && !event.buttons && this.options.onFieldHover) {
                this.options.onFieldHover(this.cellAt(event));
            }
        };
        this.pointerLeave = event => {
            this.down = null;
            if (event.pointerType !== "touch") { this.options.onFieldHover?.(null); }
        };
        this.contextMenu = event => {
            if (this.options.onFieldCancel) { event.preventDefault(); this.options.onFieldCancel(); }
        };
        this.renderer.domElement.addEventListener("pointerdown", this.pointerDown);
        this.renderer.domElement.addEventListener("pointerup", this.pointerUp);
        this.renderer.domElement.addEventListener("pointercancel", this.pointerCancel);
        this.renderer.domElement.addEventListener("pointermove", this.pointerMove);
        this.renderer.domElement.addEventListener("pointerleave", this.pointerLeave);
        this.renderer.domElement.addEventListener("contextmenu", this.contextMenu);
        this.makeGroundHelpers();
        this.resize();
    }

    async load() {
        const tasks = [
            ...this.options.units.map(unit => async () => {
                const model = await NativeModel.player(this.assets, unit);
                if (this.disposed) { model.dispose(); return; }
                this.players.push(model);
                this.scene.add(model.group);
                this.makeLabel(model);
                this.makeShadow(model);
            }),
            ...ENEMIES.map(spec => async () => {
                const model = await NativeModel.enemy(this.assets, spec);
                if (this.disposed) { model.dispose(); return; }
                this.enemies.push(model);
                this.scene.add(model.group);
                this.makeShadow(model);
            }),
            () => this.loadScenery()
        ];
        let complete = 0;
        const results = await Promise.allSettled(tasks.map(async task => {
            await task();
            complete++;
            this.options.onProgress?.(complete / tasks.length, `模型、场地与表情 ${complete} / ${tasks.length}`);
        }));
        const failed = results.find(result => result.status === "rejected");
        if (failed) { throw failed.reason; }
        this.players.sort((a, b) => this.options.units.indexOf(a.unit) - this.options.units.indexOf(b.unit));
        this.enemies.sort((a, b) => ENEMIES.indexOf(a.unit) - ENEMIES.indexOf(b.unit));
        this.resetPositions();
        await this.setTheme("day");
        const primary = this.players.find(model => model.unit.id === "U01") || this.players[0];
        const plan = this.effects.actionPlan(primary.unit, "attack");
        await this.effects.prepare(plan.events.map(event => event.effect));
        this.options.onProgress?.(1, "原生场景已准备好");
        this.select(this.selected);
        this.render();
        this.startLoop();
    }

    startLoop() {
        this.lastFrame = performance.now();
        const frame = now => {
            if (this.disposed) { return; }
            const dt = Math.min(0.08, Math.max(0, (now - this.lastFrame) / 1000));
            this.lastFrame = now;
            this.update(dt);
            this.render();
            this.raf = requestAnimationFrame(frame);
        };
        if (!this.options.manualClock) { this.raf = requestAnimationFrame(frame); }
    }

    makeGroundHelpers() {
        const THREE = this.THREE;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 64;
        const context = canvas.getContext("2d");
        const shade = context.createRadialGradient(32, 32, 2, 32, 32, 31);
        shade.addColorStop(0, "rgba(35,42,20,.55)");
        shade.addColorStop(.55, "rgba(35,42,20,.22)");
        shade.addColorStop(1, "rgba(35,42,20,0)");
        context.fillStyle = shade;
        context.fillRect(0, 0, 64, 64);
        this.shadowTexture = new THREE.CanvasTexture(canvas);
        this.shadowMaterial = new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: false,
            depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor, side: THREE.DoubleSide });
        this.shadowGeometry = new THREE.PlaneGeometry(1, 1);
        this.selection = new THREE.Mesh(new THREE.PlaneGeometry(1.24, 2), new THREE.MeshBasicMaterial({
            color: 0xffec89, opacity: 0.08, transparent: false, depthWrite: false,
            blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneMinusSrcAlphaFactor, side: THREE.DoubleSide }));
        this.selection.rotation.x = -Math.PI / 2;
        this.selection.renderOrder = 1000;
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(this.selection.geometry),
            new THREE.LineBasicMaterial({ color: 0xfff4be, opacity: .85, transparent: false,
                depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor,
                blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor,
                blendDstAlpha: THREE.OneMinusSrcAlphaFactor }));
        outline.renderOrder = 1100;
        this.selection.add(outline);
        this.environment.add(this.selection);
        this.grid = new THREE.Group();
        this.environment.add(this.grid);
        this.grid.visible = false;
        this.buildGrid();
    }

    buildGrid() {
        for (const child of this.grid.children.slice()) {
            child.geometry.dispose(); child.material.dispose(); this.grid.remove(child);
        }
        const points = [];
        for (let col = 0; col <= 9; col++) {
            const x = (col - 4.5) * 1.3;
            points.push(x, 0.015, -this.rows * 1.05, x, 0.015, this.rows * 1.05);
        }
        for (let row = 0; row <= this.rows; row++) {
            const z = (row - this.rows / 2) * 2.1;
            points.push(-5.85, 0.015, z, 5.85, 0.015, z);
        }
        const geometry = new this.THREE.BufferGeometry();
        geometry.setAttribute("position", new this.THREE.Float32BufferAttribute(points, 3));
        const material = new this.THREE.LineBasicMaterial({ color: 0xebe8be, opacity: .56,
            transparent: false, depthWrite: false, blending: this.THREE.CustomBlending,
            blendSrc: this.THREE.SrcAlphaFactor, blendDst: this.THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: this.THREE.OneFactor, blendDstAlpha: this.THREE.OneMinusSrcAlphaFactor });
        const lines = new this.THREE.LineSegments(geometry, material);
        lines.renderOrder = 1500;
        this.grid.add(lines);
    }

    makeLabel(model) {
        const label = document.createElement("span");
        label.className = "actor-label";
        label.textContent = model.unit.name;
        this.labels.append(label);
        model.label = label;
    }

    makeShadow(model) {
        const shadow = new this.THREE.Mesh(this.shadowGeometry, this.shadowMaterial);
        shadow.rotation.x = -Math.PI / 2;
        shadow.scale.set(model.kind === "player" ? .7 : .62, .38, 1);
        shadow.renderOrder = 900;
        this.environment.add(shadow);
        model.shadow = shadow;
    }

    async loadProp(entry, name, height) {
        const loaded = await nativeScene.loadSceneEntry(entry);
        if (this.disposed) { nativeScene.disposeScene(loaded.scene, this.THREE); return null; }
        const group = new this.THREE.Group();
        const tilt = new this.THREE.Group();
        group.name = name;
        tilt.rotation.x = -PITCH;
        group.add(tilt);
        tilt.add(loaded.scene);
        const box = posedBounds(this.THREE, loaded.scene);
        if (box.isEmpty() || box.max.y <= box.min.y) {
            nativeScene.disposeScene(loaded.scene, this.THREE);
            throw new Error(`原场景物件不可见：${name}`);
        }
        const scale = height / (box.max.y - box.min.y);
        tilt.scale.setScalar(scale);
        const scaled = posedBounds(this.THREE, loaded.scene);
        tilt.position.set(-(scaled.max.x + scaled.min.x) / 2, -scaled.min.y, 0);
        loaded.scene.traverse(mesh => { if (mesh.isMesh) { mesh.renderOrder = 5000 + Math.abs(mesh.renderOrder % 1000); } });
        this.environment.add(group);
        const prop = { name, group, root: loaded.scene, height };
        this.props.push(prop);
        return prop;
    }

    async loadScenery() {
        const THREE = this.THREE;
        const textureLoader = new THREE.TextureLoader();
        const themes = await Promise.all(Object.keys(THEMES).map(async theme => {
            const texture = await textureLoader.loadAsync(new URL(`../assets/stage/${theme}.webp`, import.meta.url).href);
            texture.colorSpace = THREE.SRGBColorSpace;
            return [theme, texture];
        }));
        this.backgrounds = Object.fromEntries(themes);
        this.fieldTextures = Object.fromEntries(await Promise.all(Object.keys(THEMES).map(async theme => {
            const texture = await textureLoader.loadAsync(new URL(`../assets/stage/${theme}-field.webp`, import.meta.url).href);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = this.assets.anisotropy;
            return [theme, texture];
        })));
        this.field = new THREE.Mesh(new THREE.PlaneGeometry(11.7, 10.5), new THREE.MeshBasicMaterial({
            map: this.fieldTextures.day, transparent: false, depthWrite: false, blending: THREE.CustomBlending,
            blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor }));
        this.field.rotation.x = -Math.PI / 2;
        this.field.position.y = .001;
        this.field.renderOrder = -200;
        this.environment.add(this.field);
        const waterTexture = await textureLoader.loadAsync(new URL("../assets/stage/water-surface.webp", import.meta.url).href);
        waterTexture.colorSpace = THREE.SRGBColorSpace;
        waterTexture.wrapS = waterTexture.wrapT = THREE.RepeatWrapping;
        waterTexture.repeat.set(5, 1);
        const sandTexture = await textureLoader.loadAsync(new URL("../assets/stage/sand-surface.webp", import.meta.url).href);
        sandTexture.colorSpace = THREE.SRGBColorSpace;
        sandTexture.wrapS = sandTexture.wrapT = THREE.RepeatWrapping;
        sandTexture.repeat.set(8, .15);
        this.water = new THREE.Group();
        this.environment.add(this.water);
        const surface = new THREE.Mesh(new THREE.PlaneGeometry(28, 4.2), new THREE.MeshBasicMaterial({ map: waterTexture }));
        surface.rotation.x = -Math.PI / 2;
        surface.position.y = .004;
        surface.renderOrder = -100;
        this.water.add(surface);
        for (const z of [-2.21, 2.21]) {
            const bank = new THREE.Mesh(new THREE.PlaneGeometry(28, .24), new THREE.MeshBasicMaterial({ map: sandTexture }));
            bank.rotation.x = -Math.PI / 2;
            bank.position.set(0, .009, z);
            bank.renderOrder = -90;
            this.water.add(bank);
        }
        this.water.visible = false;
        const entries = this.assets.rooms;
        const native = this.assets.native;
        const jobs = [
            [entries.desk_1001, "desk", .57],
            [entries.goods_1001, "plant", .7],
            [entries.goods_1043, "tent", 1.35],
            [entries.hobby_1014, "float", .25],
            [native.furniture.goods_1041, "fire", .5],
            [native.furniture.goods_1072, "lantern", .5],
            [native.buildings.bld_100000_0, "house", 2]
        ];
        const results = await Promise.allSettled(jobs.map(([entry, name, height]) => this.loadProp(entry, name, height)));
        const failure = results.find(result => result.status === "rejected");
        if (failure) { throw failure.reason; }
        this.floatTemplate = this.props.find(prop => prop.name === "float");
        this.floatTemplate.group.visible = false;
    }

    async setTheme(theme) {
        if (!THEMES[theme]) { return; }
        this.closeCinematic();
        this.demo = false;
        this.events = [];
        this.items.reset();
        this.effects.reset();
        this.theme = theme;
        this.rows = THEMES[theme].rows;
        this.scene.background = this.backgrounds[theme];
        this.host.style.backgroundImage = `url("${new URL(`../assets/stage/${theme}.webp`, import.meta.url).href}")`;
        this.water.visible = theme === "water";
        this.field.material.map = this.fieldTextures[theme];
        this.field.scale.y = this.rows / 5;
        for (const prop of this.props) {
            prop.group.visible = prop.name !== "float";
            const positions = { house: [-7.1, -2.9], desk: [-6.8, 4.3], plant: [-7.7, 5.2],
                tent: [-7, 4.3], fire: [-6.5, 5.7], lantern: [-7.2, 1.9] };
            if (positions[prop.name]) { prop.group.position.set(positions[prop.name][0], 0, positions[prop.name][1]); }
            if (prop.name === "house" || prop.name === "desk" || prop.name === "plant") { prop.group.visible = theme === "day"; }
            if (prop.name === "tent") { prop.group.visible = theme !== "day"; }
            if (prop.name === "fire" || prop.name === "lantern") { prop.group.visible = theme === "camp"; }
        }
        this.buildGrid();
        this.resetPositions();
        this.options.onTheme?.(THEMES[theme]);
        this.audio.playTheme(theme);
        this.resize();
        this.render();
    }

    refreshPlatforms() {
        for (const platform of this.platforms) { platform.removeFromParent(); }
        this.platforms = [];
        for (const model of this.players) {
            const wet = this.theme === "water" && (model.cell.row === 2 || model.cell.row === 3);
            const cell = model.cell;
            model.place(cell.row, cell.col, this.rows, wet ? .12 : 0);
            if (wet) {
                const platform = this.floatTemplate.group.clone(true);
                platform.visible = true;
                platform.position.set(model.group.position.x, 0, model.group.position.z);
                this.environment.add(platform);
                this.platforms.push(platform);
            }
        }
    }

    resetPositions() {
        this.demo = false;
        this.events = [];
        this.items.reset();
        this.effects.reset();
        this.epoch++;
        const occupied = new Set();
        for (let i = 0; i < this.players.length; i++) {
            const model = this.players[i];
            const defaultCell = PLACEMENT[model.unit.id] || [Math.floor(i / 2) * 2, i % 2 ? 5 : 2];
            let row = Math.min(defaultCell[0], this.rows - 1);
            let col = defaultCell[1];
            while (occupied.has(`${row}:${col}`)) { col = col >= 6 ? 1 : col + 1; }
            occupied.add(`${row}:${col}`);
            model.place(row, col, this.rows);
            model.play("idle");
        }
        for (let i = 0; i < this.enemies.length; i++) {
            const model = this.enemies[i];
            const lane = this.theme === "water" ? [0, 1, 5][i] : Math.min(i * 2, this.rows - 1);
            model.place(lane, 7.1 + i * .32, this.rows);
            model.play("idle");
        }
        if (this.floatTemplate) { this.refreshPlatforms(); }
        this.select(this.selected);
        this.options.onDemo?.(false);
        this.render();
    }

    select(id) {
        const model = this.players.find(player => player.unit.id === id) || this.players[0];
        if (!model) { return; }
        this.selected = model.unit.id;
        for (const player of this.players) { player.label.classList.toggle("selected", player === model); }
        this.selection.position.set(model.group.position.x, .02, model.group.position.z);
        this.options.onSelect?.(model.unit);
        this.render();
    }

    setPaused(reason, paused) {
        if (paused) { this.pauseReasons.add(reason); }
        else { this.pauseReasons.delete(reason); }
        this.audio.suspend(this.pauseReasons.size > 0);
        this.lastFrame = performance.now();
        this.render();
    }

    toggleGrid(value) { this.grid.visible = value; this.render(); }

    async preparePlan(model, plan) {
        await this.effects.prepare(plan.events.map(event => event.effect));
        if (model.unit.classId === 4) {
            model.trailTexture = await this.items.prepareTrail(model.unit.elementId);
            await this.effects.prepare(["ef_btl_dmg_single_00"]);
        }
    }

    async playSelected(kind) {
        const model = this.players.find(player => player.unit.id === this.selected);
        if (!model || this.busy || this.cinematic || this.disposed) { return; }
        if (this.pauseReasons.size) { this.options.onNotice?.("先继续场景，再查看动作。"); return; }
        if (this.demo) { this.stopDemo(); }
        if (kind === "damage" || kind === "win") {
            model.presentationSequence = (model.presentationSequence || 0) + 1;
            model.play(kind === "damage" ? "damage" : "win_st_0", false);
            this.options.onNotice?.(`${model.unit.name}：原作${kind === "damage" ? "受击" : "胜利"}动作`);
            return;
        }
        this.busy = true;
        const epoch = this.epoch;
        try {
            const plan = this.effects.actionPlan(model.unit, kind);
            this.options.onNotice?.(`准备${model.unit.name}的原作招式…`);
            await this.preparePlan(model, plan);
            if (this.disposed || epoch !== this.epoch) { return; }
            this.scheduleAction(model, plan);
            this.options.onNotice?.(`${model.unit.name}：${plan.skillName || "普通攻击"}`);
        } finally { this.busy = false; }
    }

    scheduleAction(model, plan) {
        model.presentationSequence = (model.presentationSequence || 0) + 1;
        const sequence = model.presentationSequence;
        model.play(plan.action, false);
        const target = this.enemies.find(enemy => enemy.cell.row === model.cell.row);
        const ally = this.players.find(player => player !== model && player.unit.classId === 3
            && player.cell.row === model.cell.row) || model;
        const melee = model.unit.classId === 0 || model.unit.classId === 3;
        const closeTarget = target && target.group.position.x >= model.group.position.x
            && target.group.position.x - model.group.position.x <= 1.3 * 1.6;
        for (const event of plan.events) {
            // The original ribbon follows the weapon, not a standalone effect
            // scene. Its texture is attached to the bottle at the release frame.
            if (event.kind === "TrailAttach") { continue; }
            this.events.push({ at: this.time + event.frame / 30, run: () => {
                if (model.presentationSequence !== sequence) { return; }
                if (model.unit.classId === 4 && event.kind === "EffectAttach") {
                    if (!target) { return; }
                    this.items.launch({ model, to: target.bodyPoint(), attached: event.effect, texture: model.trailTexture,
                        onImpact: point => {
                            if (this.disposed) { return; }
                            this.effects.emit("ef_btl_dmg_single_00", { from: point, scale: .8 });
                            target.play("damage", false);
                        } });
                    return;
                }
                if (event.kind === "Support") {
                    const receiver = event.anchor === "ally" ? ally : model;
                    const point = receiver.group.position.clone();
                    point.y += .04;
                    this.effects.emit(event.effect, { from: point, scale: receiver.scale });
                    return;
                }
                const projectile = /Projectile|Attach/.test(event.kind);
                if (projectile) {
                    if (!target) { return; }
                    const entry = this.assets.native.effects[event.effect];
                    const flight = Math.max(.15, Math.min(.6, (entry.duration || .8) * .7));
                    this.effects.emit(event.effect, { from: model.muzzlePoint(), to: target.bodyPoint(), flight,
                        arc: model.unit.classId === 4 ? .7 : 0, scale: model.scale, facing: -1,
                        onImpact: () => { if (!this.disposed) { target.play("damage", false); } } });
                } else {
                    // eSkillActionEffectPosType: 0=self, 1/3=opponent,
                    // 2/4=own party. Origin is not the weapon locator.
                    const receiver = event.target === 1 || event.target === 3 ? target
                        : event.target === 2 || event.target === 4 ? ally : model;
                    if (!receiver) { return; }
                    const point = event.locator === -1 ? receiver.group.position.clone() : receiver.bodyPoint();
                    this.effects.emit(event.effect, { from: point, scale: model.scale,
                        facing: receiver.kind === "player" ? -1 : 1 });
                    if (melee && closeTarget) {
                        this.events.push({ at: this.time + .28, run: () => {
                            if (model.presentationSequence === sequence) { target.play("damage", false); }
                        } });
                    }
                }
            } });
        }
    }

    stopDemo() {
        this.demo = false;
        this.events = [];
        this.items.reset();
        this.effects.reset();
        for (const enemy of this.enemies) {
            if (enemy.walking) { enemy.play("idle"); }
        }
        this.options.onDemo?.(false);
        this.audio.playTheme(this.theme);
    }

    async startDemo() {
        if (this.busy || this.cinematic || this.disposed) { return; }
        if (this.pauseReasons.size) { this.options.onNotice?.("先继续场景，再开始试演。"); return; }
        if (this.demo) { this.stopDemo(); return; }
        this.busy = true;
        const epoch = this.epoch;
        try {
            const plans = this.players.map(model => ({ model,
                plan: this.effects.actionPlan(model.unit, model.unit.classId === 2 || model.unit.classId === 3 ? "skill" : "attack") }));
            await Promise.all(plans.map(({ model, plan }) => this.preparePlan(model, plan)));
            if (this.disposed || epoch !== this.epoch) { return; }
            this.resetPositions();
            this.demo = true;
            this.demoStart = this.time;
            for (const enemy of this.enemies) { enemy.beginWalk(); }
            for (let round = 0; round < 3; round++) {
                plans.forEach(({ model, plan }, index) => {
                    this.events.push({ at: this.time + 2 + round * 4.5 + index * .24,
                        run: () => this.scheduleAction(model, plan) });
                });
            }
            this.events.push({ at: this.time + 16.5, run: () => {
                this.demo = false;
                for (const enemy of this.enemies) { if (enemy.walking) { enemy.play("idle"); } }
                this.options.onDemo?.(false);
                this.options.onNotice?.("试演结束。可以选伙伴单独查看动作，或调整站位。");
                this.audio.playTheme(this.theme);
            } });
            this.options.onDemo?.(true);
            this.options.onNotice?.("按原骨架补充的行进动作，配合原生攻击、治疗与增益演出。");
            this.audio.setTrack("bgm_battle_1");
        } finally { this.busy = false; }
    }

    async playUltimate() {
        const model = this.players.find(player => player.unit.id === this.selected);
        if (!model || this.busy || this.cinematic || this.pauseReasons.size) { return; }
        this.busy = true;
        const epoch = this.epoch;
        this.options.onNotice?.("正在准备原作とっておき场景…");
        try {
            const { createCinematic } = await import("./cinematic.js");
            const cinematic = await createCinematic(this.assets, model.unit, this.audio);
            if (this.disposed || epoch !== this.epoch) { cinematic.dispose(); return; }
            this.cinematic = cinematic;
            this.options.onCinematic?.(true, model.unit.skills[0].name);
            this.resize();
        } finally { this.busy = false; }
    }

    closeCinematic() {
        if (!this.cinematic) { return; }
        this.cinematic.dispose();
        this.cinematic = null;
        this.options.onCinematic?.(false);
        this.resize();
        this.lastFrame = performance.now();
        this.render();
    }

    cellAt(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        if (!rect.width || !rect.height) { return null; }
        this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
        this.ray.setFromCamera(this.pointer, this.camera);
        const point = this.ray.ray.intersectPlane(this.ground, new this.THREE.Vector3());
        if (!point) { return null; }
        const col = Math.round(point.x / 1.3 + 4);
        const row = Math.round(point.z / 2.1 + (this.rows - 1) / 2);
        return row < 0 || row >= this.rows || col < 0 || col > 8 ? null : { row, col };
    }

    pick(event) {
        if (event.button !== 0 || this.busy || this.cinematic || this.demo || this.pauseReasons.size) { return; }
        const cell = this.cellAt(event);
        if (!cell) { return; }
        const { row, col } = cell;
        if (this.options.onFieldInput) {
            this.options.onFieldInput({ row, col, event });
            return;
        }
        const occupant = this.players.find(player => player.cell.row === row && player.cell.col === col);
        if (occupant) { this.select(occupant.unit.id); return; }
        if (this.enemies.some(enemy => enemy.cell.row === row && Math.abs(enemy.cell.col - col) < .6)) {
            this.options.onNotice?.("这里留给来袭魔物，请选择其他空格。"); return;
        }
        const model = this.players.find(player => player.unit.id === this.selected);
        model.place(row, col, this.rows);
        this.refreshPlatforms();
        this.select(model.unit.id);
        this.options.onNotice?.(`${model.unit.name}：第 ${row + 1} 路，第 ${col + 1} 格。`);
    }

    update(dt) {
        if (this.pauseReasons.size || this.busy) { return; }
        if (this.cinematic) {
            this.cinematic.update(dt);
            if (this.cinematic.finished) { this.closeCinematic(); }
            return;
        }
        this.time += dt;
        if (this.battleTick) {
            this.battleTick(dt);
            for (const model of [...this.players, ...this.enemies]) { model.update(dt); }
            this.items.update(dt);
            this.effects.update(dt);
            this.afterBattleFrame?.(dt);
            return;
        }
        const ready = this.events.filter(event => event.at <= this.time);
        this.events = this.events.filter(event => event.at > this.time);
        for (const event of ready) { event.run(); }
        for (const enemy of this.enemies) {
            if (this.demo && enemy.action === "idle") { enemy.walking = true; }
            if (enemy.walking) {
                const limit = (5.5 - 4) * 1.3;
                enemy.group.position.x = Math.max(limit, enemy.group.position.x - enemy.motion.speed * dt);
                enemy.cell.col = enemy.group.position.x / 1.3 + 4;
                if (enemy.group.position.x <= limit) { enemy.play("skill_0", false); }
            }
            enemy.update(dt);
        }
        for (const player of this.players) {
            player.configureIdle?.({ enabled: !this.audio.settings.reducedMotion, relaxed: !this.demo });
            player.update(dt);
        }
        this.items.update(dt);
        this.effects.update(dt);
    }

    resize() {
        if (this.disposed) { return; }
        const width = Math.max(1, this.viewport.clientWidth);
        const height = Math.max(1, this.viewport.clientHeight);
        this.width = width; this.height = height;
        this.renderer.setSize(width, height, false);
        const aspect = width / height;
        const span = Math.max(this.rows === 6 ? 7.45 : 6.4, 16.2 / aspect);
        this.camera.left = -span * aspect / 2;
        this.camera.right = span * aspect / 2;
        this.camera.top = span / 2;
        this.camera.bottom = -span / 2;
        this.camera.updateProjectionMatrix();
        const background = this.scene.background;
        if (background?.isTexture && background.image) {
            const sourceAspect = background.image.width / background.image.height;
            if (aspect > sourceAspect) {
                background.repeat.set(1, sourceAspect / aspect);
                background.offset.set(0, (1 - background.repeat.y) / 2);
            } else {
                background.repeat.set(aspect / sourceAspect, 1);
                background.offset.set((1 - background.repeat.x) / 2, 0);
            }
            background.updateMatrix();
        }
        this.render();
    }

    render() {
        if (this.disposed) { return; }
        this.frames++;
        if (this.cinematic) { this.cinematic.render(this.renderer); return; }
        for (const model of [...this.players, ...this.enemies]) {
            if (model.shadow) {
                model.shadow.position.set(model.group.position.x, .019 + model.platformHeight, model.group.position.z);
            }
            if (model.label) {
                const point = model.group.position.clone();
                point.y -= .035;
                point.project(this.camera);
                model.label.style.left = `${(point.x + 1) / 2 * this.width}px`;
                model.label.style.top = `${(1 - point.y) / 2 * this.height + 4}px`;
            }
        }
        this.renderer.render(this.scene, this.camera);
        this.afterRender?.();
    }

    capture(width, height) {
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 180 || width > 2400 || height > 1600) {
            throw new Error("验收图尺寸超出允许范围");
        }
        const THREE = this.THREE;
        const target = new THREE.WebGLRenderTarget(width, height, { samples: 4 });
        target.texture.colorSpace = THREE.SRGBColorSpace;
        const oldTarget = this.renderer.getRenderTarget();
        const oldViewport = this.renderer.getViewport(new THREE.Vector4());
        const oldScissor = this.renderer.getScissor(new THREE.Vector4());
        const oldScissorTest = this.renderer.getScissorTest();
        const oldClearColor = this.renderer.getClearColor(new THREE.Color());
        const oldClearAlpha = this.renderer.getClearAlpha();
        const scene = this.cinematic?.scene || this.scene;
        const camera = (this.cinematic?.camera || this.camera).clone();
        const background = scene.background?.isTexture ? scene.background : null;
        const repeat = background?.repeat.clone();
        const offset = background?.offset.clone();
        const aspect = width / height;
        try {
            if (!this.cinematic) {
                const span = Math.max(this.rows === 6 ? 7.45 : 6.4, 16.2 / aspect);
                camera.left = -span * aspect / 2; camera.right = span * aspect / 2;
                camera.top = span / 2; camera.bottom = -span / 2;
                camera.updateProjectionMatrix();
                if (background) {
                    const sourceAspect = background.image.width / background.image.height;
                    background.repeat.set(aspect > sourceAspect ? 1 : aspect / sourceAspect,
                        aspect > sourceAspect ? sourceAspect / aspect : 1);
                    background.offset.set((1 - background.repeat.x) / 2, (1 - background.repeat.y) / 2);
                    background.updateMatrix();
                }
            }
            this.frames++;
            this.renderer.setRenderTarget(target);
            this.renderer.setScissorTest(false);
            this.renderer.setViewport(0, 0, width, height);
            if (this.cinematic) {
                const nativeAspect = (camera.right - camera.left) / (camera.top - camera.bottom);
                const viewWidth = Math.min(width, height * nativeAspect);
                const viewHeight = viewWidth / nativeAspect;
                this.renderer.setClearColor(0x171d25, 1);
                this.renderer.clear();
                this.renderer.setViewport((width - viewWidth) / 2, (height - viewHeight) / 2, viewWidth, viewHeight);
                this.renderer.setScissor((width - viewWidth) / 2, (height - viewHeight) / 2, viewWidth, viewHeight);
                this.renderer.setScissorTest(true);
            }
            this.renderer.render(scene, camera);
            const bytes = new Uint8Array(width * height * 4);
            this.renderer.readRenderTargetPixels(target, 0, 0, width, height, bytes);
            const canvas = document.createElement("canvas");
            canvas.width = width; canvas.height = height;
            const context = canvas.getContext("2d");
            const image = context.createImageData(width, height);
            for (let y = 0; y < height; y++) {
                image.data.set(bytes.subarray((height - y - 1) * width * 4, (height - y) * width * 4), y * width * 4);
            }
            context.putImageData(image, 0, 0);
            return canvas.toDataURL("image/png");
        } finally {
            if (background) {
                background.repeat.copy(repeat); background.offset.copy(offset); background.updateMatrix();
            }
            this.renderer.setRenderTarget(oldTarget);
            this.renderer.setViewport(oldViewport);
            this.renderer.setScissor(oldScissor);
            this.renderer.setScissorTest(oldScissorTest);
            this.renderer.setClearColor(oldClearColor, oldClearAlpha);
            target.dispose();
            this.render();
        }
    }

    snapshot() {
        return { phase: "P0 visual study", theme: this.theme, rows: this.rows, frames: this.frames,
            time: this.time, paused: [...this.pauseReasons], busy: this.busy, demo: this.demo,
            selected: this.selected, viewport: [this.width, this.height],
            players: this.players.map(model => model.snapshot()), enemies: this.enemies.map(model => model.snapshot()),
            effects: { active: this.effects.active.size, recent: this.effects.history.slice() },
            items: { airborne: this.items.flights.size, recent: this.items.history.slice() },
            renderer: { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles,
                textures: this.renderer.info.memory.textures, geometries: this.renderer.info.memory.geometries },
            cinematic: this.cinematic ? { frame: this.cinematic.player.frame, frames: this.cinematic.timeline.frames,
                weaponVisible: this.cinematic.weaponVisible } : null };
    }

    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        this.epoch++;
        cancelAnimationFrame(this.raf);
        this.resizeObserver.disconnect();
        this.cinematic?.dispose();
        this.items.dispose();
        this.effects.dispose();
        this.removeSort?.();
        for (const model of [...this.players, ...this.enemies]) { model.dispose(); }
        loader.disposeObject(this.environment);
        this.shadowTexture?.dispose();
        for (const texture of Object.values(this.fieldTextures || {})) { texture.dispose(); }
        for (const background of Object.values(this.backgrounds || {})) { background.dispose(); }
        this.renderer.domElement.removeEventListener("pointerdown", this.pointerDown);
        this.renderer.domElement.removeEventListener("pointerup", this.pointerUp);
        this.renderer.domElement.removeEventListener("pointercancel", this.pointerCancel);
        this.renderer.domElement.removeEventListener("pointermove", this.pointerMove);
        this.renderer.domElement.removeEventListener("pointerleave", this.pointerLeave);
        this.renderer.domElement.removeEventListener("contextmenu", this.contextMenu);
        this.renderer.dispose();
        this.renderer.domElement.remove();
        this.labels.replaceChildren();
    }
}
