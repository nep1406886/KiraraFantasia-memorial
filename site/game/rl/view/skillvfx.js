// Ordinary battle effects use the original EffectHandler scenes and Meige
// timelines. Geometry/texture provenance lives in asset/rl/native/index.json.
// This layer NEVER deals damage or owns actor bones/the combat camera.
import { createPlayer as createTimelinePlayer } from "../../../core/uniqueskill.js";
import { createEmitters } from "../../../core/usparticle.js";
import { loadNativeIndex, acquireNative, preloadNative, loadEnemyAttacks, acquireEnemyAttack } from "./nativeassets.js";
import { characterTiltX } from "./tilt.js";
import { LAYER, CHARACTER_SCALE, COMBAT_HEIGHT } from "./layers.js";
import { graphicFor, projectileEvent, normalEffectConfig, ELEMENT_NAMES } from "./effectcatalog.js";
export { graphicFor, ELEMENT_NAMES } from "./effectcatalog.js";

export const EFFECT_TYPES = { SKILL_CAST: "cast", SKILL_TRAIL: "trail", HIT_IMPACT: "impact", CHARGE: "charge", HEAL: "heal" };

// Alchemist shots are particle scenes: the emitter's peActive channel is the
// only thing that moves. When no authored frameRange ships (skill _01 scenes),
// cycle the timeline strictly over the emitted window so the loop never shows
// the closed emitter frames. Mesh scenes (warrior/mage/priest shots, knight
// full swing) have no peActive channel and keep their authored delivery.
function particleActiveRange(timeline) {
    if (!timeline || !Array.isArray(timeline.channels)) { return null; }
    // The player clamps every seek to (frames||1)-1; a peActive key beyond
    // that clamp can never be reached, and a range ending past it makes the
    // projectile loop's toEnd go non-positive (see the break guard in
    // update). Clamp the range into the reachable span up front.
    const frameCap = Math.max(0, (timeline.frames || 1) - 1);
    let first = null, last = null;
    for (const ch of timeline.channels) {
        if (!ch || ch.target !== "peActive" || !Array.isArray(ch.keys)) { continue; }
        for (const key of ch.keys) {
            if (Array.isArray(key) && key.length >= 2 && key[1] > 0) {
                const frame = Math.min(key[0], frameCap);
                if (first === null || frame < first) { first = frame; }
                if (last === null || frame > last) { last = frame; }
            }
        }
    }
    return (first === null || last === null) ? null : [first, last];
}
const COMMON = ["ef_btl_recover_00", "ef_btl_barrier_00", "ef_btl_buff_line", "ef_btl_buff_ring", "ef_btl_dmg_single_00", "ef_btl_stun_occur", "ef_btl_common_dead"];
const ROOT = new URL("../../../", import.meta.url);

export function createSkillVFX(scene, THREE, options) {
    const opts = options || {}, cap = opts.maxEffects || 28;
    const active = [], trails = [], errors = [];
    // Hold a small number of off-scene bundles, not records or world units.
    // Disposing the last material after every slash also deletes its compiled
    // shader; the next swing then stalls on the same program all over again.
    const idle = new Map(), idleLimit = Math.min(8, cap);
    const trailMaps = new Map();
    let seenBullets = new WeakMap();
    const projectileTurn = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1);
    const directionOffset = new THREE.Vector3();
    const projectileOffset = new THREE.Vector3();
    const trailGeometry = new THREE.PlaneGeometry(1, 1);
    let index = null, player = null, time = 0, generation = 0, disposed = false;
    // The template arts are authored around an anchor that is NOT their visual
    // mass centre (the water swoosh's mass sits ~1.1u above/right of its
    // origin at base scale — measured on the real page: the effect flew
    // ~120px above the logical flight line while the invisible bullet was
    // exactly on it, 2026-09-17 实机反馈). Cache each template's LOCAL
    // bounding-box centre once, so the follow placement can compensate.
    const centreCache = new Map();
    const PROJECTILE_CENTRE_K = 1.68;
    function visualCentreOf(root) {
        if (centreCache.has(root)) { return centreCache.get(root); }
        const keep = { p: root.position.clone(), q: root.quaternion.clone(),
            s: root.scale.clone() };
        root.position.set(0, 0, 0);
        root.quaternion.identity();
        root.scale.set(1, 1, 1);
        root.updateMatrixWorld(true);
        const box = new (THREE.Box3)().setFromObject(root);
        const centre = box.isEmpty()
            ? new (THREE.Vector3)()
            : new (THREE.Vector3)((box.min.x + box.max.x) / 2,
                (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
        root.position.copy(keep.p); root.quaternion.copy(keep.q);
        root.scale.copy(keep.s);
        root.updateMatrixWorld(true);
        centreCache.set(root, centre);
        return centre;
    }
    const ready = loadNativeIndex().then(data => {
        index = data;
        const textures = Object.entries(data.trails || {}).map(([element, spec]) => new Promise((resolve, reject) => {
            new THREE.TextureLoader().load(new URL(spec.file, ROOT).href, texture => {
                texture.colorSpace = THREE.SRGBColorSpace;
                if (disposed) { texture.dispose(); }
                else { trailMaps.set(element, texture); }
                resolve();
            }, undefined, reject);
        }));
        return Promise.all([preloadNative("effects", COMMON), ...textures]);
    }).catch(error => { errors.push(error.message); console.warn("Native battle effects:", error); });

    function release(resource) {
        if (resource.particles) { resource.particles.dispose(); }
        resource.instance.dispose();
    }
    function retire(record, reusable = true) {
        if (record.closed) { return; } record.closed = true;
        const resource = record.resource;
        if (resource) {
            resource.instance.root.removeFromParent();
            if (resource.timeline) { resource.timeline.pause(); }
            if (resource.particles) { resource.particles.reset(); }
            // Old hit/projectile records cannot observe a later borrower.
            record.resource = record.instance = record.timeline = record.particles = null;
            if (reusable && !disposed && !idle.has(record.reuseKey)) {
                if (idle.size >= idleLimit) {
                    const oldest = idle.keys().next().value;
                    release(idle.get(oldest)); idle.delete(oldest);
                }
                idle.set(record.reuseKey, resource);
            } else { release(resource); }
        }
        const at = active.indexOf(record); if (at >= 0) { active.splice(at, 1); }
    }
    function currentProjectile(record) {
        const body = record.config.follow;
        return body && body.alive && body.delay <= 0 && body.spawnId === record.config.spawnId;
    }
    function placeProjectile(record) {
        const body = record.config.follow, root = record.instance.root;
        const at = record.positionOf ? record.positionOf(body) : body;
        root.position.set(at.x, COMBAT_HEIGHT, at.y);
        if (opts.camera) {
            opts.camera.updateMatrixWorld();
            const e = opts.camera.matrixWorld.elements;
            const sx = body.vx * e[0] + body.vy * e[2];
            const sy = body.vx * e[4] + body.vy * e[6];
            root.quaternion.copy(opts.camera.quaternion);
            projectileTurn.setFromAxisAngle(zAxis, Math.atan2(sy, sx));
            root.quaternion.multiply(projectileTurn);
        } else { root.rotation.set(characterTiltX(), 0, -Math.atan2(body.vy, body.vx)); }
        // Ride the VISUAL CENTRE on the bullet, not the authored anchor: the
        // art's local bounding-box centre (scaled, rotated by the final
        // quaternion) is subtracted so the swoosh flies ON the logical
        // flight line instead of ~1.1u above it.
        // k: the bbox centre under-estimates the pixel mass (faint outer
        // frames pull it down); calibrated on the real page so the bright
        // swoosh rides the line (residual <=10px, was ~120px uncorrected).
        const centre = visualCentreOf(root);
        projectileOffset.copy(centre).multiplyScalar(PROJECTILE_CENTRE_K)
            .multiply(root.scale).applyQuaternion(root.quaternion);
        root.position.sub(projectileOffset);
    }
    function placeDirectional(record) {
        const cfg = record.config, root = record.instance.root;
        let angle = -cfg.angle, projectedHeight = COMBAT_HEIGHT * Math.cos(characterTiltX());
        root.rotation.set(characterTiltX(), 0, 0);
        if (opts.camera) {
            opts.camera.updateMatrixWorld();
            const e = opts.camera.matrixWorld.elements;
            const dx = Math.cos(cfg.angle), dy = Math.sin(cfg.angle);
            angle = Math.atan2(dx * e[4] + dy * e[6], dx * e[0] + dy * e[2]);
            projectedHeight = COMBAT_HEIGHT * e[5];
            root.quaternion.copy(opts.camera.quaternion);
        }
        root.rotateZ((cfg.mirror ? 0 : Math.PI) + angle);
        root.position.set(record.x, cfg.height || 0, record.y);
        if (cfg.combatPivot) {
            // The source art contains its own body-height offset. Rotate that
            // offset ABOUT the projected combat point by the CAMERA
            // quaternion only: the offset is "up along the character's body",
            // which is screen-up no matter where the player aims. Rotating it
            // by the aim-rotated root quaternion (the old code) made the
            // effect ORBIT the character as the aim swept — aiming right put
            // the slash below the unit, aiming up/down put it beside them
            // (2026-09-17 实机反馈：弹丸特效方向/位置不对).
            const baseScale = cfg.scale === undefined ? CHARACTER_SCALE : cfg.scale;
            directionOffset.set(0, projectedHeight * root.scale.y / baseScale, 0)
                .applyQuaternion(opts.camera.quaternion);
            root.position.y += COMBAT_HEIGHT;
            root.position.sub(directionOffset);
        }
    }
    function emit(effect, x, y, config) {
        const cfg = config || {};
        if (disposed || !Number.isFinite(x) || !Number.isFinite(y)) { return null; }
        if (!cfg.enemyAttack && !(index && index.effects[effect])) { return null; }
        if (active.length >= cap) {
            const old = active.find(r => r.kind === "impact" || r.kind === "charge");
            if (!old) { return null; }
            retire(old);
        }
        const token = generation;
        const reuseKey = effect + ':' + Number(!!cfg.follow || Number.isFinite(cfg.angle)) + ':' + Number(!!cfg.flipLineV);
        const record = { effect, x, y, config: cfg, start: time, reuseKey,
            kind: cfg.kind || "cast", closed: false, visualReady: false };
        active.push(record);
        const cached = idle.get(reuseKey); idle.delete(reuseKey);
        const acquired = cached ? Promise.resolve(cached)
            : (cfg.enemyAttack ? acquireEnemyAttack(effect) : acquireNative("effects", effect))
                .then(instance => ({ instance, particles: null, timeline: null }));
        acquired.then(resource => {
            if (disposed || record.closed || (token !== generation && !cfg.enemyAttack)
                    || (cfg.follow && !currentProjectile(record))) {
                release(resource); retire(record, false); return;
            }
            const instance = resource.instance;
            record.resource = resource;
            record.instance = instance;
            record.start = time;
            const root = instance.root;
            root.userData.rlOverlay = true;
            const scale = cfg.scale === undefined ? CHARACTER_SCALE : cfg.scale;
            root.scale.set(scale * (cfg.stretchX || 1) * (cfg.mirror ? -1 : 1), scale * (cfg.stretchY || 1), scale);
            root.position.set(x, cfg.height || 0, y);
            root.rotation.set(characterTiltX(), 0, 0);
            if (Number.isFinite(cfg.angle)) { placeDirectional(record); }
            if (cfg.follow) { placeProjectile(record); }
            if (Number.isFinite(cfg.angle) || cfg.follow) {
                // These owned instances already have a camera-facing parent.
                // A second lookAt under a reflected/nonuniform parent corrupts
                // both direction and width. Never change the native template
                // or the shared ultimate player's billboard behavior.
                root.traverse(node => {
                    if (node.userData.msb?.billboard === 1) { node.userData.msb.billboard = 0; }
                });
            }
            scene.add(root);
            visualCentreOf(root);
            if (!resource.timeline) {
                resource.particles = createEmitters({ THREE, root });
                resource.timeline = createTimelinePlayer({ THREE, root, timeline: instance.timeline,
                    camera: opts.camera, audio: null,
                    onEmitter(name, enabled) { if (resource.particles) { resource.particles.setActive(name, enabled); } }
                });
            } else {
                // reset() clears particles, but seek() also clears the timeline's
                // emitter-state cache. Without both, frame-0 emitters stay off.
                resource.timeline.seek(0);
            }
            record.particles = resource.particles;
            record.timeline = resource.timeline;
            record.rate = instance.timeline.duration / (cfg.duration || instance.timeline.duration || 1);
            record.duration = cfg.loop ? Infinity : (cfg.duration || Math.min(2.4, instance.timeline.duration + .1));
            if (cfg.kind === "projectile" && !cfg.frameRange) {
                cfg.frameRange = particleActiveRange(instance.timeline);
            }
            record.timeline.restart();
            if (Number.isFinite(cfg.startFrame)) { record.timeline.seek(cfg.startFrame); }
            if (cfg.frameRange) { record.timeline.seek(cfg.frameRange[0]); }
            root.traverse(node => {
                if (!node.isMesh) { return; }
                node.renderOrder = LAYER.vfx + (node.renderOrder % 10000);
                const materials = Array.isArray(node.material) ? node.material : [node.material];
                materials.forEach(material => { material.depthTest = false; material.depthWrite = false; material.toneMapped = false; });
                if (cfg.flipLineV && node.name.endsWith("_line")) {
                    // acquireNative gives each instance an owned map. There are
                    // no animated UV channels on these five supplied line masks.
                    for (const material of materials) {
                        if (!material.map) { continue; }
                        material.map.repeat.y = -1;
                        material.map.offset.y = 1;
                        material.map.updateMatrix();
                    }
                }
            });
        }).catch(error => { errors.push(effect + ": " + (error && error.message || error)); retire(record, false); });
        return record;
    }

    async function prepare(unit) {
        player = unit;
        await ready;
        if (!index || !unit || disposed) { return; }
        const skills = unit.skills ? [unit.skills.normal, ...unit.skills.slots.slice(1)] : [null];
        const keys = skills.flatMap(skill => graphicFor(index, unit, skill).events.map(ev => ev.effect))
            .filter(key => index.effects[key]);
        await preloadNative("effects", [...COMMON, ...keys]);
    }

    function cast(unit, skill, duration, normal = false) {
        if (!index || !unit || !Number.isFinite(unit.x) || !Number.isFinite(unit.y)) { return; }
        const source = normal && unit.swingProfile ? { ...unit, weaponProfile: unit.swingProfile } : unit;
        const graphic = graphicFor(index, source, skill);
        const carried = projectileEvent(graphic);
        const casts = graphic.events.filter(ev => !(carried && ev.kind === carried.kind && ev.effect === carried.effect)
            && (ev.kind === "EffectPlay" || ev.kind === "EffectAttach"));
        casts.forEach(ev => {
            // Ground delivery is realtime: caster effects stay on the caster;
            // projectile parts are attached to actual world bullets below.
            // height: the muzzle flash renders at the combat (chest) height —
            // the same plane the bolt flies in — not at the unit's feet.
            emit(ev.effect, unit.x, unit.y, { ...(normal ? normalEffectConfig(unit) : { duration: duration || .48 }),
                height: COMBAT_HEIGHT,
                mirror: Math.cos(unit.facing) > 0, kind: "cast",
                angle: !skill || skill.damage ? unit.facing : undefined });
        });
        if (!casts.length && skill && !carried) {
            emit(skill.heal > 0 || skill.regen ? "ef_btl_recover_00"
                : skill.barrier ? "ef_btl_barrier_00" : "ef_btl_buff_line", unit.x, unit.y,
                { duration: .55, kind: "cast" });
        }
    }

    function emitTrail(x, y, element) {
        const texture = trailMaps.get(ELEMENT_NAMES[element] || "fire");
        if (!texture || trails.length >= 48 || disposed) { return; }
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false,
            depthTest: false, side: THREE.DoubleSide, toneMapped: false, opacity: .7 });
        const mesh = new THREE.Mesh(trailGeometry, material);
        mesh.userData.rlOverlay = true;
        mesh.position.set(x, COMBAT_HEIGHT, y); mesh.rotation.x = characterTiltX(); mesh.scale.set(.28, .22, 1);
        mesh.renderOrder = LAYER.vfx; scene.add(mesh); trails.push({ mesh, age: 0 });
    }

    function syncProjectiles(danmaku, positionOf) {
        if (disposed || !index || !player) { return; }
        for (const record of active.slice()) {
            if (record.kind !== "projectile") { continue; }
            if (!currentProjectile(record)) { retire(record); }
            else { record.positionOf = positionOf; }
        }
        danmaku.forEach(b => {
            if (b.side !== "player" || b.delay > 0 || seenBullets.get(b)?.spawnId === b.spawnId) { return; }
            const owner = { spawnId: b.spawnId, record: null };
            seenBullets.set(b, owner);
            const skill = { id: b.skillId };
            // Element belongs to the shot's launch snapshot, not to whichever
            // equipment the player happens to hold when loading finishes.
            const source = { element: b.element, card: player.card,
                weaponProfile: { classId: b.normalContext?.classId ?? player.weaponProfile?.classId } };
            const part = projectileEvent(graphicFor(index, source, skill));
            if (!part || !index.effects[part.effect]) { return; }
            const record = emit(part.effect, b.x, b.y, { kind: "projectile", loop: true,
                scale: 1.2 * b.radius / .18, mirror: true, height: COMBAT_HEIGHT, follow: b, spawnId: b.spawnId,
                frameRange: part.frameRange, flipLineV: part.flipLineV });
            owner.record = record;
            if (record) { record.positionOf = positionOf; }
        });
    }
    function projectileVisualReady(bullet) {
        const owner = seenBullets.get(bullet), record = owner && owner.record;
        return !!(record && owner.spawnId === bullet.spawnId && !record.closed
            && record.instance && record.visualReady && currentProjectile(record));
    }

    function update(dt) {
        const step = Number.isFinite(dt) ? Math.max(0, dt) : 0; time += step;
        for (const record of active.slice()) {
            const cfg = record.config, body = cfg.follow;
            if (body && (!body.alive || body.spawnId !== cfg.spawnId)) { retire(record); continue; }
            if (!record.instance) { continue; }
            if (time - record.start >= record.duration) { retire(record); continue; }
            if (body) {
                placeProjectile(record);
            } else if (Number.isFinite(cfg.angle)) { placeDirectional(record); }
            if (record.timeline.finished && cfg.loop) { record.timeline.restart(); }
            let remaining = step * record.rate;
            while (remaining > 1e-7) {
                if (cfg.frameRange && record.timeline.frame >= cfg.frameRange[1] - 1e-7) {
                    if (record.particles) { record.particles.reset(); }
                    record.timeline.seek(cfg.frameRange[0]);
                }
                const toEnd = cfg.frameRange
                    ? (cfg.frameRange[1] - record.timeline.frame) / record.timeline.fps : Infinity;
                const part = Math.min(remaining, 1 / 30, toEnd);
                // A frameRange past the timeline's own length (peActive keys
                // beyond the authored clip, or a bundle without a frames
                // count) makes seek() clamp to lastFrame >= frameRange[1],
                // so toEnd goes non-positive and this loop would spin
                // forever, sampling once per pass until the renderer OOMs.
                // Break instead; the projectile holds its last pose, which is
                // what a finished clip shows anyway.
                if (!(part > 1e-7)) { break; }
                record.timeline.update(part);
                if (record.particles) { record.particles.update(part, opts.camera); }
                remaining -= part;
            }
            if (step > 0) {
                record.visualReady = false;
                record.instance.root.traverseVisible(node => {
                    if (!node.isMesh || node.geometry.drawRange.count === 0) { return; }
                    const materials = Array.isArray(node.material) ? node.material : [node.material];
                    if (materials.some(material => material.visible && material.opacity > .001)) {
                        record.visualReady = true;
                    }
                });
            }
        }
        for (let i = trails.length - 1; i >= 0; i--) {
            const t = trails[i]; t.age += step;
            if (t.age >= .16) { t.mesh.removeFromParent(); t.mesh.material.dispose(); trails.splice(i, 1); }
            else { t.mesh.material.opacity = .7 * (1 - t.age / .16); }
        }
    }
    function clear() {
        generation++;
        // A record whose scene is still loading has nothing on screen yet;
        // retiring it here would discard the effect the moment it arrives
        // (enemy attack bursts are requested exactly when a room begins).
        active.slice().filter(record => record.instance).forEach(record => retire(record, false));
        idle.forEach(release); idle.clear();
        seenBullets = new WeakMap();
        trails.forEach(t => { t.mesh.removeFromParent(); t.mesh.material.dispose(); }); trails.length = 0;
    }
    return {
        prepare, ready, update, clear, syncProjectiles, projectileVisualReady, emitNative: emit,
        emitSkillCast(unit, skill) { cast(unit, skill, .48); },
        emitSlash(unit) { cast(unit, unit.skills && unit.skills.normal, .25, true); },
        emitTrail,
        emitHitImpact(x, y, element, crit) { return emit("ef_btl_dmg_single_00", x, y,
            { kind: "impact", height: COMBAT_HEIGHT, scale: crit ? 1.35 : .9, duration: crit ? .36 : .25 }); },
        emitCharge(x, y) { return emit("ef_btl_buff_ring", x, y, { kind: "charge", scale: 1.2, duration: .65 }); },
        emitHeal(x, y) { return emit("ef_btl_recover_00", x, y, { kind: "heal", duration: .6 }); },
        emitPickup(x, y) { return emit("ef_btl_buff_ring", x, y, { kind: "charge", duration: .45 }); },
        emitBreak(x, y) { return emit("ef_btl_dmg_single_00", x, y, { kind: "impact", height: .3, duration: .3 }); },
        emitBuff(x, y) { return emit("ef_btl_buff_line", x, y, { kind: "cast", duration: .55 }); },
        emitStun(x, y) { return emit("ef_btl_stun_occur", x, y, { kind: "stun", duration: .8 }); },
        // Gate surface (read-only): the centre-compensation parameters, so a
        // check can reconstruct the compensated placement of a projectile
        // record (root.position == bullet − centre·k·scale rotated).
        visualCentreOf: visualCentreOf,
        projectileCentreK: PROJECTILE_CENTRE_K,
        get stats() { return { active: active.length, loaded: active.filter(r => r.instance).length,
            cached: idle.size, cacheCapacity: idleLimit,
            trails: trails.length, sources: active.map(r => r.effect), errors: errors.slice() }; },
        dispose() { disposed = true; clear(); trailGeometry.dispose(); trailMaps.forEach(t => t.dispose()); trailMaps.clear(); }
    };
}
