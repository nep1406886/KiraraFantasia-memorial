import * as actors from "../../core/actor.js";
import * as loader from "../../core/loader.js";
import { createEnemyMotion, enemyMirrorForLeft } from "./enemy-motion.js";
import { IdleMotion } from "./idle-motion.js";
import { siteUrl } from "../app/assets.js";

export const PITCH = Math.PI / 6;
const FACE = /(^|_)(eye|eyebrow|eyebrrow|eyeblow|mouth|cheek)(_|$)/i;
const FEET = /(^|_)(leg|foot)(_|$)/i;
const FACTORS = { Zero: "ZeroFactor", One: "OneFactor", SrcAlpha: "SrcAlphaFactor",
    OneMinusSrcAlpha: "OneMinusSrcAlphaFactor", SrcColor: "SrcColorFactor", DstColor: "DstColorFactor",
    OneMinusSrcColor: "OneMinusSrcColorFactor", OneMinusDstColor: "OneMinusDstColorFactor",
    DstAlpha: "DstAlphaFactor", OneMinusDstAlpha: "OneMinusDstAlphaFactor" };

function weaponPart(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (/^(Loc_[LR]|Weapon_)/.test(parent.name || "")) { return true; }
    }
    return false;
}

export function applyAuthoredMaterials(root, THREE, anisotropy = 1) {
    const decals = new Map();
    root.traverse(node => {
        if (!node.isMesh || !node.material) { return; }
        if (node.userData.msbVisible === false && !node.userData.visibilityGoverned) { node.visible = false; }
        node.frustumCulled = false;
        const face = FACE.test(loader.resolveNodeName(node)) && !node.userData.facePart;
        const weapon = weaponPart(node);
        const materialList = Array.isArray(node.material) ? node.material : [node.material];
        const prepared = materialList.map(original => {
            let material = original;
            if (face) {
                if (!decals.has(original)) { decals.set(original, original.clone()); }
                material = decals.get(original);
            }
            const source = material.userData;
            material.side = weapon ? THREE.FrontSide : source.authoredSide ?? material.side;
            material.transparent = false;
            material.blending = THREE.CustomBlending;
            material.blendSrc = THREE[FACTORS[source.blendSrc]] ?? THREE.SrcAlphaFactor;
            material.blendDst = THREE[FACTORS[source.blendDst]] ?? THREE.OneMinusSrcAlphaFactor;
            material.blendSrcAlpha = source.blendDst === "One" ? THREE.ZeroFactor : THREE.OneFactor;
            material.blendDstAlpha = source.blendDst === "One" ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
            material.blendEquationAlpha = THREE.AddEquation;
            material.depthWrite = face ? false : typeof source.depthWrite === "boolean" ? source.depthWrite : material.depthWrite;
            material.depthTest = true;
            material.alphaTest = face ? 0.004 : 0.01;
            material.alphaToCoverage = false;
            if (face) { material.userData.faceDecal = true; }
            for (const texture of [material.map, material.alphaMap, material.emissiveMap]) {
                if (texture && texture.anisotropy !== anisotropy) {
                    texture.anisotropy = anisotropy;
                    texture.needsUpdate = true;
                }
            }
            material.needsUpdate = true;
            return material;
        });
        node.material = Array.isArray(node.material) ? prepared : prepared[0];
        node.userData.defenseAuthoredOrder = node.renderOrder;
    });
}

export function posedBounds(THREE, root, predicate = () => true) {
    const bounds = new THREE.Box3();
    const piece = new THREE.Box3();
    root.updateWorldMatrix(true, false);
    // updateMatrixWorld dispatches SkinnedMesh's bind-matrix refresh. The
    // Object3D-only updateWorldMatrix path leaves a newly scaled rig stale.
    root.updateMatrixWorld(true);
    const skeletons = new Set();
    root.traverseVisible(mesh => {
        if (!mesh.isMesh || !mesh.geometry || !predicate(mesh)) { return; }
        if (mesh.skeleton && !skeletons.has(mesh.skeleton)) {
            mesh.skeleton.update();
            skeletons.add(mesh.skeleton);
        }
        if (mesh.isSkinnedMesh) {
            mesh.computeBoundingBox();
            piece.copy(mesh.boundingBox);
        } else {
            if (!mesh.geometry.boundingBox) { mesh.geometry.computeBoundingBox(); }
            piece.copy(mesh.geometry.boundingBox);
        }
        piece.applyMatrix4(mesh.matrixWorld);
        bounds.union(piece);
    });
    return bounds;
}

function setOrder(root, offset) {
    root.traverse(node => {
        if (node.isMesh) {
            const authored = node.userData.defenseAuthoredOrder ?? node.renderOrder;
            node.userData.defenseAuthoredOrder = authored;
            node.renderOrder = authored + offset;
        }
    });
}

export class NativeModel {
    static async player(assets, unit) {
        const actor = await actors.create({ resourceId: unit.resourceId, classId: unit.classId,
            headId: unit.headId, skillId: unit.resourceId, weapon: "default" });
        try {
            if (!actor.facialTable || !actor.actionNames.includes("attack") || !actor.actionNames.includes("idle")) {
                throw new Error(`${unit.name} 的表情或职业动作不完整`);
            }
            if (!actor.weaponResourceIds.length) { throw new Error(`${unit.name} 的原职业武器未加载`); }
            await actor.loadActions(siteUrl("asset/rl/anim/anchors.glb.gz"), { compression: "gzip" });
            applyAuthoredMaterials(actor.object, assets.THREE, assets.anisotropy);
            return new NativeModel(assets, { actor, unit, root: actor.object, mixer: actor.mixer,
                height: 1.2 * (unit.displayScale || 1), mirrored: true });
        } catch (error) {
            actor.dispose();
            throw error;
        }
    }

    static async enemy(assets, spec) {
        const loaded = await loader.load(`model/enemy/model_en_${spec.resourceId}.muast`, { kind: "enemy" });
        try {
            if (!loaded.animations.some(clip => clip.name === "idle")) { throw new Error(`${spec.name} 缺少待机动作`); }
            applyAuthoredMaterials(loaded.scene, assets.THREE, assets.anisotropy);
            const mixer = new assets.THREE.AnimationMixer(loaded.scene);
            const model = new NativeModel(assets, { root: loaded.scene, mixer,
                clips: new Map(loaded.animations.map(clip => [clip.name, clip])),
                unit: spec, height: spec.height, mirrored: enemyMirrorForLeft(spec.resourceId) });
            model.motion = createEnemyMotion(assets.THREE, loaded.scene, spec.resourceId, model.scale,
                Math.sign(model.scaled.scale.x));
            return model;
        } catch (error) {
            loader.disposeObject(loaded.scene);
            throw error;
        }
    }

    constructor(assets, options) {
        this.THREE = assets.THREE;
        this.unit = options.unit;
        this.actor = options.actor;
        this.root = options.root;
        this.mixer = options.mixer;
        this.clips = options.clips;
        this.kind = this.actor ? "player" : "enemy";
        this.height = options.height;
        this.group = new this.THREE.Group();
        this.lift = new this.THREE.Group();
        this.billboard = new this.THREE.Group();
        this.scaled = new this.THREE.Group();
        this.group.add(this.lift);
        this.lift.add(this.billboard);
        this.billboard.add(this.scaled);
        this.scaled.add(this.root);
        this.billboard.rotation.x = -PITCH;
        this.cell = { row: 0, col: 0 };
        this.platformHeight = 0;
        this.walking = false;
        this.disposed = false;
        this.action = "";
        this.finishedAction = null;
        this.onFinished = event => { this.finishedAction = event.action.getClip().name; };
        this.mixer.addEventListener("finished", this.onFinished);
        this.play("idle");
        this.actor ? this.actor.update(0) : this.mixer.update(0);
        this.billboard.rotation.x = 0;
        const bounds = posedBounds(this.THREE, this.root, mesh => !weaponPart(mesh));
        this.billboard.rotation.x = -PITCH;
        if (bounds.isEmpty() || bounds.max.y <= bounds.min.y) { throw new Error(`模型没有可见主体：${this.unit.name}`); }
        const size = bounds.getSize(new this.THREE.Vector3());
        this.scale = this.height / size.y;
        this.scaled.scale.set((options.mirrored ? -1 : 1) * this.scale, this.scale, this.scale);
        this.footMeshes = [];
        this.root.traverse(mesh => {
            if (mesh.isMesh && FEET.test(loader.resolveNodeName(mesh)) && !weaponPart(mesh)) { this.footMeshes.push(mesh); }
        });
        this.footSet = new Set(this.footMeshes);
        const foot = this.feetBounds();
        this.baseLift = foot.isEmpty() ? -posedBounds(this.THREE, this.root, mesh => !weaponPart(mesh)).min.y : -foot.min.y;
        this.lift.position.y = this.baseLift;
        this.group.updateWorldMatrix(true, true);
        this.idleMotion = this.actor ? new IdleMotion(this.THREE, this.root, this.unit.resourceId) : null;
    }

    configureIdle(options) {
        this.idleMotion?.configure(options);
        if (this.action === "room_idle_L" && (!options.enabled || !options.relaxed)) { this.play("idle"); }
    }

    feetBounds() {
        return posedBounds(this.THREE, this.root, mesh => this.footSet.has(mesh));
    }

    play(name, loop = name === "idle" || name === "battle_run") {
        if (this.disposed) { return false; }
        this.idleMotion?.reset();
        this.motion?.restore();
        this.walking = false;
        this.finishedAction = null;
        if (this.actor) {
            if (!this.actor.play(name, { loop, fade: 0.1 })) { throw new Error(`${this.unit.name} 没有原动作 ${name}`); }
            this.actor.setWeaponVisible(name !== "room_idle_L");
        } else {
            const clip = this.clips.get(name);
            if (!clip) { throw new Error(`${this.unit.name} 没有原动作 ${name}`); }
            const next = this.mixer.clipAction(clip);
            this.currentAction?.stop();
            next.reset().setLoop(loop ? this.THREE.LoopRepeat : this.THREE.LoopOnce, loop ? Infinity : 1);
            next.clampWhenFinished = !loop;
            next.play();
            this.currentAction = next;
        }
        this.action = name;
        return true;
    }

    beginWalk() {
        if (!this.motion) { throw new Error("这个模型没有经过核验的行进曲线"); }
        if (this.action !== "idle") { this.play("idle"); }
        this.walking = true;
    }

    update(dt) {
        if (this.disposed) { return; }
        this.idleMotion?.restore();
        this.motion?.restore();
        this.lift.position.y = this.baseLift;
        this.actor ? this.actor.update(dt) : this.mixer.update(dt);
        if (this.walking) { this.motion.apply(dt * (this.gaitRate || 1)); }
        if (this.idleMotion?.apply(dt, this.action === "idle") && this.actor.actionNames.includes("room_idle_L")) {
            this.play("room_idle_L", false);
        }
        const foot = this.feetBounds();
        if (!foot.isEmpty()) {
            const below = this.group.position.y - foot.min.y;
            if (below > 0 || this.action === "idle" || this.walking) { this.lift.position.y += below; }
        }
        if (this.finishedAction === this.action && this.action !== "idle" && this.action !== "dead") { this.play("idle"); }
    }

    place(row, col, rows = 5, height = 0) {
        this.cell = { row, col };
        this.platformHeight = height;
        this.group.position.set((col - 4) * 1.3, height, (row - (rows - 1) / 2) * 2.1);
        setOrder(this.root, 100000000 + row * 100000000 + (this.kind === "enemy" ? 35000000 : Math.round(col * 2000000)));
        this.group.updateWorldMatrix(true, true);
    }

    bodyPoint() {
        const position = this.group.position.clone();
        position.y += this.height * 0.52;
        position.z -= Math.sin(PITCH) * this.height * 0.52;
        return position;
    }

    muzzlePoint() {
        this.root.updateWorldMatrix(true, true);
        const socket = this.root.getObjectByName("Loc_R");
        return socket ? socket.getWorldPosition(new this.THREE.Vector3()) : this.bodyPoint();
    }

    snapshot() {
        const foot = this.feetBounds();
        let visibleMeshes = 0;
        this.root.traverseVisible(mesh => { if (mesh.isMesh) { visibleMeshes++; } });
        return { id: this.unit.id || this.unit.resourceId, resourceId: this.unit.resourceId,
            kind: this.kind, action: this.actor?.action || this.action, walking: this.walking,
            cell: { ...this.cell }, position: this.group.position.toArray(), height: this.height,
            scale: this.scale, mirrorSign: Math.sign(this.scaled.scale.x), footMin: foot.isEmpty() ? null : foot.min.y,
            idle: this.idleMotion?.snapshot() || null,
            visibleMeshes, motionBones: this.motion?.bones || [], motionPhase: this.motion?.phase ?? null,
            motionPose: this.motion ? this.motion.bones.map(name => {
                const node = this.root.getObjectByName(name);
                return { name, position: node.position.toArray(), quaternion: node.quaternion.toArray() };
            }) : [] };
    }

    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        this.idleMotion?.restore();
        this.motion?.restore();
        this.mixer.removeEventListener("finished", this.onFinished);
        if (this.actor) { this.actor.dispose(); }
        else {
            this.mixer.stopAllAction();
            this.mixer.uncacheRoot(this.root);
            loader.disposeObject(this.root);
        }
        this.group.removeFromParent();
    }
}
