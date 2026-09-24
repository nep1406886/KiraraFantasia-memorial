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
        this.history = [];
        this.disposed = false;
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
        const graphic = this.assets.native.skills[String(skillId)];
        return this.assets.native.graphics[`${graphic}:${elementKeys[unit.elementId]}`]?.events || [];
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
        const defense = unit.classId === 3 && skill.effects.some(effect => effect.m_Type === 2 || effect.m_Type === 18);
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
        const slot = slots.find(candidate => !candidate.busy);
        if (!slot) { return false; }
        slot.busy = true;
        slot.age = 0;
        slot.options = options;
        slot.impactSent = false;
        slot.wrapper.visible = true;
        slot.pivot.position.set(0, 0, 0);
        const scale = options.scale || 1.4;
        slot.wrapper.scale.set(scale * (options.facing || 1), scale, scale);
        slot.particles?.reset();
        slot.player.seek(0);
        slot.player.play();
        slot.wrapper.position.copy(options.from);
        this.active.add(slot);
        this.history.push({ effect: name, flight: options.flight || 0 });
        if (this.history.length > 24) { this.history.shift(); }
        return slot;
    }

    placeCentered(slot, position) {
        slot.wrapper.position.copy(position);
        slot.pivot.position.set(0, 0, 0);
        slot.wrapper.updateWorldMatrix(true, true);
        const box = posedBounds(this.THREE, slot.root, mesh => {
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            return materials.some(material => material.opacity > 0.02);
        });
        if (!box.isEmpty()) {
            const center = box.getCenter(new this.THREE.Vector3());
            slot.wrapper.worldToLocal(center);
            slot.pivot.position.sub(center);
        }
    }

    update(dt) {
        for (const slot of this.active) {
            slot.age += dt;
            slot.player.update(dt);
            slot.particles?.update(dt);
            const options = slot.options;
            if (options.position) {
                const position = options.position();
                if (!position) { this.release(slot); continue; }
                if (slot.player.finished) { slot.player.seek(0); slot.player.play(); }
                this.placeCentered(slot, position);
                continue;
            }
            if (options.to && options.flight) {
                const t = Math.min(1, slot.age / options.flight);
                const desired = options.from.clone().lerp(options.to, t);
                if (options.arc) { desired.y += Math.sin(Math.PI * t) * options.arc; }
                // Follow the visible mass, not just the original art pivot.
                this.placeCentered(slot, desired);
                if (t >= 1 && !slot.impactSent) {
                    slot.impactSent = true;
                    options.onImpact?.();
                }
            }
            if (slot.player.finished || (options.flight && slot.age >= options.flight + 0.12)) {
                if (!slot.impactSent && options.onImpact) { options.onImpact(); }
                this.release(slot);
            }
        }
    }

    release(slot) {
        slot.player.pause();
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
    }
}
