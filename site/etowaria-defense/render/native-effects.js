import * as effects from "../../core/uniqueskill.js";
import { createEmitters } from "../../core/usparticle.js";
import { elementKeys, readJson, siteUrl } from "../app/assets.js";
import { PITCH, posedBounds } from "./native-model.js";

export class NativeEffects {
    constructor(assets, scene) {
        this.assets = assets;
        this.THREE = assets.THREE;
        this.scene = scene;
        this.pools = new Map();
        this.pending = new Map();
        this.active = new Set();
        this.fallbacks = [];
        this.fallbackGeometry = null;
        this.history = [];
        this.disposed = false;
        // 飞行插值的每帧暂存向量：placeCentered 只读取不保存。
        this._flightPoint = new this.THREE.Vector3();
    }

    async prepare(names, copies = 2) {
        await Promise.all([...new Set(names)].filter(name => name !== "ef_btl_trail_alchemist")
            .map(name => this.prepareOne(name, copies)));
    }

    prepareOne(name, copies = 2) {
        if ((this.pools.get(name)?.length || 0) >= copies) { return Promise.resolve(); }
        if (this.pending.has(name)) {
            return this.pending.get(name).then(() => this.disposed ? undefined : this.prepareOne(name, copies));
        }
        if (!this.pending.has(name)) {
            const count = copies - (this.pools.get(name)?.length || 0);
            const promise = Promise.allSettled(Array.from({ length: count }, () => this.makeSlot(name))).then(results => {
                const slots = results.filter(result => result.status === "fulfilled").map(result => result.value);
                const failed = results.find(result => result.status === "rejected");
                if (this.disposed || failed) {
                    slots.forEach(slot => this.disposeSlot(slot));
                    if (failed) { throw failed.reason; }
                    return;
                }
                this.pools.set(name, [...(this.pools.get(name) || []), ...slots]);
            }).finally(() => this.pending.delete(name));
            this.pending.set(name, promise);
        }
        return this.pending.get(name);
    }

    async makeSlot(name) {
        const entry = this.assets.native.effects[name];
        if (!entry?.file || !entry.timeline) { throw new Error(`原生特效未收录：${name}`); }
        const timeline = await readJson(siteUrl(entry.timeline));
        const loaded = await effects.loadSceneEntry(entry);
        const root = loaded.scene;
        const wrapper = new this.THREE.Group();
        const pivot = new this.THREE.Group();
        wrapper.add(pivot);
        pivot.add(root);
        wrapper.rotation.x = -PITCH;
        const particles = createEmitters({ THREE: this.THREE, root });
        const player = effects.createPlayer({ THREE: this.THREE, timeline, root, audio: null,
            onEmitter: (index, active) => particles?.setActive(index, active) });
        player.seek(0);
        wrapper.visible = false;
        root.traverse(node => {
            if (node.isMesh) {
                node.frustumCulled = false;
                node.renderOrder += 850000000;
            }
        });
        this.scene.add(wrapper);
        return { name, root, wrapper, pivot, player, particles, timeline, age: 0, busy: false };
    }

    graph(unit, skillId) {
        const graphic = unit.skills.find(skill => skill.id === skillId)?.graphics
            || this.assets.native.skills[String(skillId)];
        const element = elementKeys[unit.elementId];
        // Card-specific variants share their class choreography when not exported.
        const graph = this.assets.native.graphics[`${graphic}:${element}`]
            || this.assets.native.graphics[`${graphic?.replace(/_\d+$/, "")}:${element}`];
        return graph?.events || [];
    }

    actionPlan(unit, kind) {
        if (kind === "attack") {
            const events = this.graph(unit, unit.classId + 1).filter(event => this.assets.native.effects[event.effect]
                || event.kind === "TrailAttach" && this.assets.native.trails?.[elementKeys[unit.elementId]]);
            return { action: "attack", events, support: null };
        }
        const skill = unit.classId === 3 ? unit.skills[2] : unit.skills[1];
        const mapped = this.assets.playback[String(unit.cardId)]?.skills.find(item => item.id === skill.id);
        if (!mapped?.action) { throw new Error(`${unit.name} 的职业技动作未绑定`); }
        const events = this.graph(unit, skill.id).filter(event => this.assets.native.effects[event.effect]
            || event.kind === "TrailAttach" && this.assets.native.trails?.[elementKeys[unit.elementId]]);
        const recovery = skill.effects.some(effect => effect.m_Type === 1);
        const barrier = skill.effects.some(effect => effect.m_Type === 13);
        const defense = skill.effects.some(effect => [2, 6, 8, 18, 29, 30].includes(effect.m_Type));
        if (recovery) {
            events.push({ effect: "ef_btl_recover_00", frame: 16, kind: "Support", anchor: "ally" });
            events.push({ effect: "ef_btl_recover_01", frame: 20, kind: "Support", anchor: "ally" });
        } else if (defense) {
            events.push({ effect: "ef_btl_buff_ring", frame: 14, kind: "Support", anchor: "self" });
            events.push({ effect: "ef_btl_buff_line", frame: 18, kind: "Support", anchor: "self" });
        }
        if (barrier) { events.push({ effect: "ef_btl_barrier_00", frame: 18, kind: "Support", anchor: "self" }); }
        return { action: mapped.action, events, support: recovery ? "heal" : barrier ? "barrier" : defense ? "buff" : null, skillName: skill.name };
    }

    emit(name, options = {}) {
        const slots = this.pools.get(name);
        if (!slots) { throw new Error(`特效尚未准备：${name}`); }
        let slot = slots.find(candidate => !candidate.busy);
        if (this.disposed) { return null; }
        if (!slot) {
            // Warm future capacity, but never replay an old hit after loading.
            if (slots.length < 8) { this.prepareOne(name, Math.min(8, slots.length + 2)).catch(() => {}); }
            slot = slots.reduce((oldest, candidate) => candidate.options?.position || candidate.options?.flight
                ? oldest : !oldest || candidate.age > oldest.age ? candidate : oldest, null);
            if (slot) this.release(slot);
        }
        if (this.active.size >= 48) {
            const cosmetic = [...this.active].find(candidate => !candidate.options?.position && !candidate.options?.flight);
            if (cosmetic) this.release(cosmetic);
            else slot = null;
        }
        // Up to 24 cheap silhouettes preserve travelling attacks during effect bursts.
        if (!slot && (options.position || options.flight)) slot = this.reserveFallback(name);
        if (!slot) return null;
        slot.busy = true;
        slot.age = 0;
        slot.options = options;
        slot.impactSent = false;
        slot.wrapper.visible = true;
        slot.pivot.position.set(0, 0, 0);
        const scale = options.scale || 1.4;
        slot.wrapper.scale.set(scale * (options.facing || 1), scale, scale);
        slot.particles?.reset();
        slot.player?.seek(0);
        slot.player?.play();
        slot.wrapper.position.copy(options.from);
        this.active.add(slot);
        this.history.push({ effect: name, flight: options.flight || 0 });
        if (this.history.length > 24) { this.history.shift(); }
        return slot;
    }

    reserveFallback(name) {
        let slot = this.fallbacks.find(row => !row.busy);
        if (!slot && this.fallbacks.length < 24) {
            const T = this.THREE;
            this.fallbackGeometry ||= new T.SphereGeometry(.11, 8, 6);
            const material = new T.MeshBasicMaterial({ color: 0xffd8eb, transparent: true, opacity: .85, depthWrite: false });
            const wrapper = new T.Group(), pivot = new T.Group();
            pivot.add(new T.Mesh(this.fallbackGeometry, material)); wrapper.add(pivot);
            this.scene.add(wrapper);
            slot = { wrapper, pivot, material, fallback: true, busy: false };
            this.fallbacks.push(slot);
        }
        if (slot) {
            const colors = { fire: 0xffb17a, water: 0xa9dbff, earth: 0xf4d088, wind: 0xc2ecc5, moon: 0xd8baff, sun: 0xffefac };
            slot.material.color.setHex(colors[elementKeys.find(key => name.includes(key))] || 0xffd8eb);
        }
        return slot;
    }

    placeCentered(slot, position, recenter) {
        slot.wrapper.position.copy(position);
        if (!recenter || slot.fallback) { return; }
        // 特效可见质量的中心只在半帧率重算：飞行途中美术主体的
        // 漂移以 30Hz 跟随已不可辨，但省掉了每帧的整树矩阵更新
        // 加全特效包围盒。
        slot.pivot.position.set(0, 0, 0);
        slot.wrapper.updateWorldMatrix(true, true);
        const box = posedBounds(this.THREE, slot.root, mesh => {
            const materials = mesh.material;
            if (Array.isArray(materials)) {
                for (let i = 0; i < materials.length; i++) {
                    if (materials[i].opacity > 0.02) { return true; }
                }
                return false;
            }
            return materials.opacity > 0.02;
        });
        if (!box.isEmpty()) {
            const center = this._flightPoint;
            box.getCenter(center);
            slot.wrapper.worldToLocal(center);
            slot.pivot.position.sub(center);
        }
    }

    update(dt) {
        for (const slot of this.active) {
            slot.age += dt;
            slot.player?.update(dt);
            slot.particles?.update(dt);
            const options = slot.options;
            if (options.position) {
                const position = options.position();
                if (!position) { this.release(slot); continue; }
                if (slot.player?.finished) { slot.player.seek(0); slot.player.play(); }
                slot.recenter = !(slot.recenter || false);
                this.placeCentered(slot, position, slot.recenter);
                continue;
            }
            if (options.to && options.flight) {
                const t = Math.min(1, slot.age / options.flight);
                const desired = this._flightPoint.copy(options.from).lerp(options.to, t);
                if (options.arc) { desired.y += Math.sin(Math.PI * t) * options.arc; }
                // Follow the visible mass, not just the original art pivot.
                slot.recenter = !(slot.recenter || false);
                this.placeCentered(slot, desired, slot.recenter);
                if (t >= 1 && !slot.impactSent) {
                    slot.impactSent = true;
                    options.onImpact?.();
                }
            }
            if (slot.player?.finished || (options.flight && slot.age >= options.flight + 0.12)) {
                if (!slot.impactSent && options.onImpact) { options.onImpact(); }
                this.release(slot);
            }
        }
    }

    release(slot) {
        slot.player?.pause();
        slot.wrapper.visible = false;
        slot.busy = false;
        slot.options = null;
        this.active.delete(slot);
    }

    reset() {
        for (const slot of this.active) { this.release(slot); }
    }

    disposeSlot(slot) {
        slot.player.pause();
        slot.particles?.dispose();
        effects.disposeScene(slot.root, this.THREE);
        slot.wrapper.removeFromParent();
    }

    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        this.reset();
        for (const slots of this.pools.values()) { slots.forEach(slot => this.disposeSlot(slot)); }
        this.pools.clear();
        for (const slot of this.fallbacks) { slot.wrapper.removeFromParent(); slot.material.dispose(); }
        this.fallbackGeometry?.dispose();
        this.fallbacks.length = 0;
    }
}
