import * as loader from "../../core/loader.js";
import { applyAuthoredMaterials, posedBounds, PITCH } from "./native-model.js";
import { siteUrl, elementKeys } from "../app/assets.js";

export class NativeItems {
    constructor(stage) {
        this.stage = stage; this.THREE = stage.THREE;
        this.template = null; this.promise = null; this.disposed = false;
        this.instances = new Set(); this.trailTextures = new Map();
        this.flights = new Set(); this.history = [];
    }
    async prepare() {
        if (!this.promise) {
            this.promise = loader.load("model/weapon/wpn_1400.muast", { kind: "weapon" }).then(loaded => {
                if (this.disposed) { loader.disposeObject(loaded.scene); return; }
                applyAuthoredMaterials(loaded.scene, this.THREE, this.stage.assets.anisotropy);
                const bounds = posedBounds(this.THREE, loaded.scene);
                if (bounds.isEmpty()) { loader.disposeObject(loaded.scene); throw new Error("原药瓶模型不可见"); }
                this.template = { root: loaded.scene, center: bounds.getCenter(new this.THREE.Vector3()), height: bounds.max.y - bounds.min.y };
            }).catch(error => { this.promise = null; throw error; });
        }
        await this.promise;
    }
    async prepareTrail(elementId) {
        await this.prepare();
        const key = elementKeys[elementId];
        if (!this.trailTextures.has(key)) {
            const entry = this.stage.assets.native.trails?.[key];
            if (!entry) { throw new Error(`缺少原炼金拖尾：${key}`); }
            const promise = new this.THREE.TextureLoader().loadAsync(siteUrl(entry.file)).then(texture => {
                if (this.disposed) { texture.dispose(); return null; }
                texture.colorSpace = this.THREE.SRGBColorSpace;
                return texture;
            }).catch(error => { this.trailTextures.delete(key); throw error; });
            this.trailTextures.set(key, promise);
        }
        return this.trailTextures.get(key);
    }
    bottle(height = .48) {
        if (!this.template) { throw new Error("原药瓶尚未准备好"); }
        const group = new this.THREE.Group();
        const turn = new this.THREE.Group();
        const artwork = this.template.root.clone(true);
        artwork.position.copy(this.template.center).multiplyScalar(-1);
        turn.add(artwork); turn.scale.setScalar(height / this.template.height);
        group.add(turn); group.rotation.x = -PITCH;
        artwork.traverse(mesh => { if (mesh.isMesh) { mesh.renderOrder = 875000000; } });
        group.userData.nativeItem = "wpn_1400";
        this.instances.add(group);
        return { group, turn, height };
    }
    release(item) { item.group.removeFromParent(); this.instances.delete(item.group); }

    makeTrail(texture) {
        const THREE = this.THREE;
        const count = 16;
        const positions = new Float32Array(count * 2 * 3);
        const uv = new Float32Array(count * 2 * 2);
        const indices = [];
        for (let i = 0; i < count; i++) {
            uv.set([i / (count - 1), 0, i / (count - 1), 1], i * 4);
            if (i < count - 1) { const a = i * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); geometry.setIndex(indices);
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending, opacity: .85 });
        const mesh = new THREE.Mesh(geometry, material); mesh.renderOrder = 874000000; mesh.frustumCulled = false;
        this.stage.scene.add(mesh);
        return { mesh, geometry, material, positions, count, samples: [] };
    }
    launch({ model, to, attached, onImpact, texture }) {
        const item = this.bottle(.4 * Math.max(.9, model.scale));
        const from = model.muzzlePoint();
        const target = to.clone();
        const flight = { item, from, to: target, position: from.clone(), age: 0, duration: .64,
            model, onImpact, trail: this.makeTrail(texture), attachment: null };
        item.group.position.copy(from); this.stage.scene.add(item.group);
        model.throwOwner = flight;
        model.actor?.setWeaponVisible(false);
        if (attached) {
            flight.attachment = this.stage.effects.emit(attached, { from, scale: model.scale, facing: -1,
                position: () => this.flights.has(flight) ? flight.position.clone() : null });
        }
        this.flights.add(flight);
        this.history.push({ resourceId: model.unit.resourceId, elementId: model.unit.elementId,
            item: "wpn_1400", trail: elementKeys[model.unit.elementId], attached, duration: flight.duration });
        if (this.history.length > 16) { this.history.shift(); }
        return flight;
    }
    update(dt) {
        const up = new this.THREE.Vector3(0, Math.cos(PITCH), -Math.sin(PITCH));
        for (const flight of this.flights) {
            flight.age += dt;
            const t = Math.min(1, flight.age / flight.duration);
            flight.position.copy(flight.from).lerp(flight.to, t);
            flight.position.y += Math.sin(t * Math.PI) * .9;
            flight.item.group.position.copy(flight.position);
            flight.item.turn.rotation.z = -t * Math.PI * 2;
            const trail = flight.trail;
            trail.samples.unshift(flight.position.clone());
            if (trail.samples.length > trail.count) { trail.samples.pop(); }
            for (let i = 0; i < trail.count; i++) {
                const point = trail.samples[Math.min(i, trail.samples.length - 1)];
                const halfWidth = .09 * (1 - i / trail.count);
                for (let side = 0; side < 2; side++) {
                    const vertex = point.clone().addScaledVector(up, side ? halfWidth : -halfWidth);
                    trail.positions.set(vertex.toArray(), (i * 2 + side) * 3);
                }
            }
            trail.geometry.attributes.position.needsUpdate = true;
            if (t >= 1) {
                flight.onImpact?.(flight.to);
                this.finish(flight);
            }
        }
    }
    finish(flight) {
        if (flight.attachment?.busy) { this.stage.effects.release(flight.attachment); }
        this.release(flight.item);
        flight.trail.mesh.removeFromParent(); flight.trail.geometry.dispose(); flight.trail.material.dispose();
        if (flight.model.throwOwner === flight) {
            flight.model.throwOwner = null;
            flight.model.actor?.setWeaponVisible(flight.model.action !== "room_idle_L");
        }
        this.flights.delete(flight);
    }
    reset() { for (const flight of this.flights) { this.finish(flight); } }
    dispose() {
        if (this.disposed) { return; }
        this.disposed = true; this.reset();
        this.instances.forEach(group => group.removeFromParent()); this.instances.clear();
        if (this.template) { loader.disposeObject(this.template.root); }
        this.trailTextures.forEach(promise => promise.then(texture => texture?.dispose()).catch(() => {}));
        this.trailTextures.clear();
    }
}
