// Player view: the bridge between a logic-layer unit and core/actor.js.
//
// The unit (game/rl/world.js) owns position/facing/state as plain numbers;
// this module copies them onto the three.js object and translates state
// changes into clip plays via the anchor table below. Master plan §2.3
// assumed only five clips exist; that was the *published* model export, not
// the assets -- the shared battle bundle also has dead / abnormal /
// battle_in / battle_out / win_lp_0, which tools/rl_export_anchors.py
// publishes as asset/rl/anim/anchors.glb.gz. It is loaded here and bound
// onto the actor's own mixer (the same donor-rig trick the class-actions
// packs use), so dead is a real death animation now, not damage parked on
// its last frame.
//
// The models are 2.5D paper stacks, not volume 3D: layered texture quads
// painted in authored order (MsbHandler renderOrder), exported with only the
// front-facing L30 face layers (the L60/R60/R30 sets carry face/hair
// silhouettes only -- no side-view body exists in any model, checked
// model_pl_300302). Rotating such a stack around Y shows the paper edge-on,
// so the model never rotates: it stays billboarded to the camera (whose
// azimuth is fixed by the follow camera) and direction is carried by the X
// mirror, with hysteresis so moving straight up/down does not flicker.
//
// Locomotion has exactly one clip (battle_run -- true of the original game
// too), so run direction is expressed procedurally: the mirror for left vs
// right, and a screen-plane lean into the movement when it is lateral. A
// lean is safe on a paper stack (it stays face-on to the camera); a Y
// rotation is not.
//
// The view also owns two things the model has no channel for: a contact shadow
// (view/blobshadow.js), because every prop on the map has one and a character
// without one is the only thing on screen that floats; and the top draw-order
// band (view/layers.js). stagerender.js isolates the player's depth buffer so
// scenery cannot cut off feet/torso, while the model still occludes itself.

import * as loader from "../../../core/loader.js";
import { createBlobShadow } from "./blobshadow.js";
import { LAYER, applyLayer, CHARACTER_SCALE } from "./layers.js";
import { characterTiltX } from "./tilt.js";
import { applyModelRules, createMirrorSideManager } from "./modelrules.js";
import { PLAYER_TIMING } from "../actorstate.js";
import { weaponDefinition } from "../weaponcatalog.js";

// core/loader.js owns the single three.js module instance; capture it once.
// The page boots through loadModules() before any view exists, so it is
// always resolved by the time playAnchor runs.
let THREE = null;
loader.loadModules().then(function (modules) {
    THREE = modules.THREE;
});

// Game state -> clip anchor. Everything here except "dead" ships with the
// model or the class pack; "dead" comes from the anchors supplement with a
// damage fallback so the view still works before it loads.
const ANCHOR = {
    idle: "idle",
    move: "battle_run",
    attack: "attack",
    dodge: "kirarajump_0",
    hit: "damage",
    dead: "dead"
};
const FALLBACK = { dead: "damage" };

// One-shots must not loop; looping states do.
const ONCE = { attack: true, dodge: true, hit: true, dead: true };

// Flip only once the horizontal facing component is clearly non-zero;
// |cos(facing)| inside this band keeps the previous side.
const FLIP_BAND = 0.3;

// Screen-plane lean while running laterally (~8 degrees), into the movement.
const RUN_LEAN = 0.14;
// T22m-2 measurement: the run clip's authored hips roll is only ~+17° in
// model space (raw-accessor -49° was pre-decomposition; per-frame quaternion
// sampling peaks 15.7–17.7°). It mirrors with the stack and reads as the
// sprint lean laterally. Counter-rolling it for vertical movement was tried
// and rejected: over-corrects through the sway cycle and the character
// visibly leans back mid-stride. The run reads correctly in all directions
// with the authored posture untouched — direction is carried by the mirror
// and the on-screen movement itself.
const RUN_ROLL_CANCEL = 0;

// The dodge (kirarajump_0) is the one state that leaves the ground, and it does
// so inside the clip — bones move, the object's own y stays 0 — so the shadow's
// lift cannot be read off a transform without a per-frame bounding box. It is
// approximated from the state clock instead, the same way enemyview.js supplies
// a wind-up the static models do not animate: an arc over dodgeDuration, peak
// roughly where the clip's own hop peaks. The bones hop in model space, so the
// lift scales with CHARACTER_SCALE.
const DODGE_LIFT = 1.1;

// T23e foot lift (spec/06). Measured over the whole 40-model player roster
// (tools/rl_player_dump.py): every player ships leg_L/leg_R meshes whose
// authored pose reaches 1-6cm BELOW the floor plane (mapview.js GROUND_Y),
// so the opaque ground occludes the foot stubs from the side view — the
// reported "脚被地形遮挡". The deep sub-zero geometry that also shows up in
// the dump is hair_back and weapons (authored hang), which must NOT lift —
// so the measurement reads only leg_* meshes and the lift rides on the
// actor root (position.y), which composes additively with the tilt/mirror
// and never touches the scene-level blob shadow. Idle/move only: dodge and
// hit clips hop the bones on their own. Capped so a pathological model
// cannot float; the ratchet eases in over ~80ms instead of popping.
const FLOOR_Y = -0.02;          // mapview.js GROUND_Y — keep in sync
const LEG_RE = /^leg_[LR]_/i;
const LEG_LIFT_MAX = 0.12;

export function attachPlayerView(unit, actor, scene) {
    // T22m: the same measured rules the enemy stack got — per-material depth
    // truth, alpha-blended edges, face decal, msbVisible. The actor pipeline
    // (core/actor.js → loader) ships the older cut, which is the 错位/边缘粗
    // gap against the observation room.
    const mirrorSide = createMirrorSideManager(THREE);
    loader.loadModules().then(function (modules) {
        applyModelRules(actor.object, modules.THREE, { kind: "player" });
        mirrorSide.sync(actor.object, false);   // baseline authored sides
    });
    scene.add(actor.object);
    // Keep self-depth. The stage compositor, not a material flag, isolates
    // the player from world occluders. Async material setup may safely run.
    applyLayer(actor.object, LAYER.player, false);
    // The map layer is authored for ~1.6-unit characters and the exported
    // models are half that (view/layers.js CHARACTER_SCALE). The scale rides
    // on the same object the mirror uses, so sync() writes all three axes
    // every frame and the mirror can never desync from the size.
    actor.object.scale.set(CHARACTER_SCALE, CHARACTER_SCALE, CHARACTER_SCALE);
    const shadow = createBlobShadow(THREE, scene, unit.radius * CHARACTER_SCALE);
    let lastState = null;
    let mirrored = false;
    let lateral = false;
    let runLean = 0;
    // T23e foot lift: eased current lift and the worst leg vertex seen so
    // far (a ratchet — the run cycle's lowest dip is caught whenever the
    // probe first lands in it, and never un-lifts).
    let legLift = 0;
    let legWorst = Infinity;

    // World timing owns control. Fit a complete authored gesture into that
    // window instead of leaving half a cast running over the next input.
    const durations = {
        attack: PLAYER_TIMING.attackDuration - PLAYER_TIMING.attackCooldown,
        dodge: PLAYER_TIMING.dodgeDuration,
        hit: PLAYER_TIMING.hitDuration
    };
    let lastSwingId = unit.swingId;
    let externalAction = null;
    let disposed = false;
    let equipmentKey = "default", equipmentRequest = 0;
    let weaponActions = { idle: "idle", attack: "attack" };

    function hasEquipmentModel(row) {
        const expected = row
            ? [...new Set([row.resourceIdL, row.resourceIdR].filter(id => Number.isInteger(id) && id > 0))]
            : [1000 + actor.classId * 100];
        const mounted = actor.weaponResourceIds;
        return expected.length > 0 && mounted.length === expected.length
            && expected.every(id => mounted.includes(id)) && actor.weaponParts.length > 0;
    }

    function playState(state) {
        const config = { loop: !ONCE[state], fade: state === "hit" || state === "dead" ? 0 : .055 };
        if (durations[state]) { config.duration = durations[state]; }
        if (state === 'attack' && !unit.castOnly) config.duration /= unit.swingGadgets?.rate || 1;
        let candidates = [ANCHOR[state] || ANCHOR.idle];
        if (state === "idle" || state === "attack" && !unit.castOnly) {
            candidates = [weaponActions[state], ...candidates];
        }
        if (state === "attack" && unit.castOnly && unit.castSlot >= 0) {
            const slot = unit.skills && unit.skills.slots[unit.castSlot];
            const authored = slot && slot.action !== "skill" ? slot.action : null;
            candidates = [authored, slot && slot.damage ? "class_skill_1" : "class_skill_3", "attack"];
        }
        if (FALLBACK[state]) { candidates.push(FALLBACK[state]); }
        externalAction = null;
        for (const name of candidates.filter(Boolean)) {
            if (actor.play(name, config)) { view.current = name; return true; }
        }
        return false;
    }

    const view = {
        unit: unit,
        actor: actor,
        lastState: null,
        current: null,
        // create() already attempted the default model. Its compatibility API
        // tolerates failure, so verify the actual mount rather than retrying
        // automatically or reporting a missing default weapon as ready.
        equipment: hasEquipmentModel(null) ? { status: "ready", error: null }
            : { status: "error", error: "default weapon model unavailable" },
        equipmentReady: Promise.resolve(),

        syncEquipment: function () {
            const item = (unit.equipment || []).find(item => item.slot === "weapon");
            const row = weaponDefinition(item);
            const key = row ? String(row.id) : "default";
            if (disposed || key === equipmentKey) { return view.equipmentReady; }
            equipmentKey = key;
            const ticket = ++equipmentRequest;
            // New actions may still be loading when the old model arrives.
            // Invalidate that candidate now, not only at the next equip().
            actor.cancelEquip();
            const classId = row ? row.class : actor.classId;
            view.equipment = { status: "loading", error: null };
            view.equipmentReady = actor.loadWeaponActions(classId).then(actions => {
                if (disposed || ticket !== equipmentRequest) { return; }
                return actor.equip(row || "default").then(() => {
                    if (disposed || ticket !== equipmentRequest) { return; }
                    if (!hasEquipmentModel(row)) { throw new Error("weapon model not attached"); }
                    weaponActions = actions;
                    for (const part of actor.weaponParts) {
                        applyModelRules(part, THREE, { kind: "weapon" });
                        applyLayer(part, LAYER.player, false);
                    }
                    mirrorSide.sync(actor.object, mirrored);
                    view.equipment = { status: "ready", error: null };
                    lastState = null;
                });
            }).catch(error => {
                if (disposed || ticket !== equipmentRequest) { return; }
                view.equipment = { status: "error", error: error.message };
                console.warn("Player equipment:", error);
            });
            return view.equipmentReady;
        },

        // Only an explicit user retry may request the same failed equipment.
        // A loading/ready view returns its existing promise; sync() never polls
        // the network, and the world remains the sole equipment/save owner.
        retryEquipment: function () {
            if (disposed || view.equipment.status !== "error") { return view.equipmentReady; }
            equipmentKey = null;
            return view.syncEquipment();
        },

        // Stage wiring (T09 room transitions, victory, abnormal) plays these
        // directly: battle_in / battle_out / win_lp_0 / abnormal are not
        // player states in actorstate.js.
        play: function (name, options) {
            if (!actor.play(name, options || { loop: false, fade: 0.12 })) { return false; }
            view.current = name;
            externalAction = actor.mixer._actions.find(a => a.getClip().name === name) || null;
            return true;
        },

        sync: function (dt, position) {
            if (disposed) { return; }
            view.syncEquipment();
            const state = unit.sm.state;
            const newSwing = state === "attack" && unit.swingId !== lastSwingId;
            if (state !== lastState || newSwing) {
                lastState = state;
                lastSwingId = unit.swingId;
                playState(state);
            } else if (externalAction && !externalAction.isRunning()
                    && (state === "idle" || state === "move")) {
                playState(state);
            }
            actor.update(dt || 0);
            const at = position || unit;
            actor.object.position.x = at.x;
            actor.object.position.z = at.y;
            // T23e foot lift: measure the lowest visible leg vertex in root
            // space and ease the root up until it clears the floor. Idle/move
            // only — dodge/hit clips hop the bones themselves. The mixer
            // drives bones, not the object root (object.position.y stays 0
            // for players), so this write is not fought by actor.update.
            if (unit.sm.state === "idle" || unit.sm.state === "move") {
                const rootY = actor.object.position.y;
                actor.object.traverse(function (child) {
                    if (!child.isMesh || !child.geometry || !child.visible
                            || !LEG_RE.test(child.name || "")) {
                        return;
                    }
                    child.updateWorldMatrix(true, false);
                    const p = child.geometry.attributes.position;
                    if (!p) { return; }
                    // Root-space y of each vertex = inverse of the scale the
                    // world matrix applies, then the affine part. Reading
                    // world and subtracting rootY folds in the tilt; the lift
                    // target is what clears the floor at the CURRENT pose.
                    const e = child.matrixWorld.elements;
                    for (let i = 0; i < p.count; i++) {
                        const rel = e[1] * p.getX(i) + e[5] * p.getY(i)
                            + e[9] * p.getZ(i) + e[13] - rootY;
                        if (rel < legWorst) { legWorst = rel; }
                    }
                });
                if (legWorst < Infinity) {
                    const target = Math.min(LEG_LIFT_MAX,
                        Math.max(0, FLOOR_Y - legWorst));
                    legLift += (target - legLift) * (1 - Math.exp(-(dt || 0) * 12));
                }
            }
            actor.object.position.y = legLift;
            // Billboard: the follow camera's azimuth never changes, so
            // rotation stays 0 around Y (model faces the camera) and direction
            // is carried by the mirror and the lean alone. T22m: the pitch is
            // NOT zero — a vertical paper stack under the ~54° rig is seen
            // from above, foreshortened with its paper layers showing
            // edge-on. Tilting the stack back around its feet by the live
            // camera pitch makes it perpendicular to the view ray, which is
            // the straight-on read the observation room (and the original
            // game's chara cameras at Euler(0,0,0)) measure against.
            actor.object.rotation.y = 0;
            actor.object.rotation.x = characterTiltX();
            const dirx = Math.cos(unit.facing);
            const diry = Math.sin(unit.facing);
            // T22m-4 方向修正: battle_run is authored leaning LEFT (hips
            // rotZ +17° tilts the stack toward screen-left) — the unmirrored
            // clip reads as running left. So moving LEFT must play it
            // UNMIRRORED and moving RIGHT must mirror it; the old mapping
            // had this inverted and every run read backwards (moonwalk:
            // position drifts one way, stride reads the other). The lean we
            // add below (-sign(dirx)) agrees with the clip's lean under this
            // mapping in both directions.
            if (dirx > FLIP_BAND) {
                mirrored = true;
            } else if (dirx < -FLIP_BAND) {
                mirrored = false;
            }
            actor.object.scale.x = (mirrored ? -1 : 1) * CHARACTER_SCALE;
            actor.object.scale.y = CHARACTER_SCALE;
            actor.object.scale.z = CHARACTER_SCALE;
            // T22m-4: mirroring flips triangle winding — authored cull states
            // then eat the half facing the camera (back hair/sleeves vanish
            // on the flipped side). models.html's orbitSide rule, keyed on
            // the mirror: flipped stack => force DoubleSide (weapons stay
            // FrontSide, their outline is an inverted hull).
            mirrorSide.sync(actor.object, mirrored);

            // One run clip for every direction, so the directions are told
            // apart procedurally — but the clip itself carries a ~49°
            // authored body roll (Hips rotZ -49..+2) with a ±0.8 lateral
            // sway: it is the ORIGINAL's side-facing sprint, meant to be
            // seen with the character Y-rotated toward screen-x. We
            // billboard (no Y rotation), so:
            //   lateral — the authored roll reads as a sprint lean; the
            //     mirror flips its apparent side, and our extra RUN_LEAN
            //     must sit on the SAME side as it (same sign chain), or
            //     the body fights the stride and the run reads backwards
            //     ("左右跑反了").
            //   vertical — with no lateral cue the same rolled posture
            //     reads as jogging sideways in place ("上下跑反了"), so
            //     the stack counter-rolls the authored lean upright while
            //     the legs keep pumping: a straight-ahead run read.
            const moving = unit.sm.state === "move";
            const nowLateral = moving && Math.abs(dirx) > Math.abs(diry);
            if (nowLateral !== lateral) {
                lateral = nowLateral;
            }
            // The authored roll lives on the hips, mirroring with scale.x.
            // Its apparent lean after the mirror is toward -sign-of-stride,
            // measured from the sway phase against the feet: leaning INTO
            // the run means rotation.z shares the stride's sign as seen on
            // screen. The counter-roll for vertical cancels the clip's
            // dominant roll (-RUN_ROLL_CANCEL rad) on top of the object
            // tilt, so posture stands up while legs keep cycling.
            const leanTarget = lateral ? -Math.sign(dirx) * RUN_LEAN : (moving ? RUN_ROLL_CANCEL : 0);
            // Frame-rate independent presentation only. The facing mirror and
            // committed attack direction remain immediate world-state reads.
            runLean = unit.dead || state === 'dead' ? 0
                : runLean + (leanTarget - runLean) * (1 - Math.exp(-Math.max(0, dt || 0) * 18));
            actor.object.rotation.z = runLean;

            view.lastState = lastState;

            // Contact shadow: props have one (mapview), so a character without
            // one is the only thing on screen that floats.
            const dodging = unit.sm.state === "dodge";
            const hop = dodging
                ? Math.sin(Math.PI * Math.min(1,
                    unit.sm.stateTime / PLAYER_TIMING.dodgeDuration)) * DODGE_LIFT
                : 0;
            shadow.sync(at.x, at.y, hop, !unit.dead);
        },

        dispose: function () {
            if (disposed) { return; }
            disposed = true;
            equipmentRequest++;
            actor.cancelEquip();
            shadow.dispose();
        }
    };
    // establish the initial clip so frame 0 already matches the state
    playState(unit.sm.state);
    lastState = unit.sm.state;
    view.syncEquipment();

    // The anchors supplement is 174 KB and not on the critical path: the
    // view runs on the model's own clips until it arrives.
    loader.readModel("../asset/rl/anim/anchors.glb.gz", "gzip")
        .then(function (blob) {
            return loader.loadModules().then(function (modules) {
                const url = URL.createObjectURL(blob);
                const gltfLoader = new modules.GLTFLoader();
                return new Promise(function (resolve, reject) {
                    gltfLoader.load(url, resolve, undefined, reject);
                }).then(function (gltf) {
                    URL.revokeObjectURL(url);
                    try {
                        if (disposed) { return; }
                        (gltf.animations || []).forEach(function (clip) {
                            // Supplement actions use the same hierarchy-path
                            // retargeter and playback owner as all other clips.
                            actor.registerAction(clip.name, clip, { sourceRoot: gltf.scene });
                        });
                    } finally {
                        loader.disposeObject(gltf.scene);
                    }
                });
            });
        })
        .catch(function (error) {
            console.warn("anchor clips unavailable:", error);
        });
    return view;
}
