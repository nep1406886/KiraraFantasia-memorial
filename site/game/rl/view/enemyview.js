// Enemy view: loads an enemy model through the shared loader and mirrors a
// logic unit onto it. Enemy models never have class-action bundles, so this
// is its own small mixer rather than core/actor.js (whose create() hardcodes
// the model/player/ path).
//
// 139 of 604 enemy models are animated (idle/damage/dead/skill_*); the rest
// are static meshes. Like the player models they are 2.5D layered sprite
// stacks, so they never rotate around Y (that shows the paper edge-on):
// facing reads as an X mirror, and a static model stays alive through the
// float bob alone — no spin. Both kinds get their world position from the
// logic unit every frame: a static model that only bobbed would sit at the
// room origin, and 44 of the 66 shipped roster models are static.
//
// Two things the model itself cannot supply are added here: a contact shadow
// (view/blobshadow.js — the map's props have one, so a character without one is
// the only thing on screen that floats) and a draw-order band above the kit
// cards (view/layers.js).

import * as loader from "../../../core/loader.js";
import { ENEMY_TIMING } from "../actorstate.js";
import { createBlobShadow } from "./blobshadow.js";
import { LAYER, applyLayer, CHARACTER_SCALE } from "./layers.js";
import { characterTiltX } from "./tilt.js";
import { applyModelRules, createMirrorSideManager } from "./modelrules.js";
import { accessibility } from "../accessibility.js";

// The authored clip vocabulary, measured across all 26 animated models in the
// shipped roster (asset/rl/encounters.json + tools/rl_anim_audit.py): every
// one has idle / abnormal / damage / dead / skill_0 / skill_1, 15 also have
// charge_skill (the other 11 fall back). So the states map onto clips that
// exist rather than onto names this file would prefer to exist -- there is
// no "telegraph" clip anywhere in the game's data.
const CLIP = {
    idle: "idle",
    recover: "idle",
    telegraph: "charge_skill",   // the wind-up the original itself uses
    dash: "charge_skill",        // the lunge continues its own wind-up
    damage: "damage",
    dead: "dead"
};
// Which skill clip a pattern reads as: the sweeping ones get the second slot.
const SKILL_CLIP = {
    ring: "skill_1", spiral: "skill_1",
    wave: "skill_1", cross: "skill_1", wall: "skill_1"
};
// A model missing the clip degrades instead of freezing.
const CLIP_FALLBACK = {
    charge_skill: "skill_0", skill_1: "skill_0", skill_0: "idle",
    damage: "idle", dead: "damage", abnormal: "idle"
};
// Clips that loop, keyed by the RESOLVED clip name, not the state: the audit
// measured every charge_skill and idle as cyclic (first frame == last frame,
// error < 0.001), while every skill/damage clip is a one-shot authored to
// return to the neutral pose. Looping must follow that, or a LoopRepeat
// one-shot snaps back mid-gesture -- and the 11 models without charge_skill
// would telegraph on a LOOPED attack clip, which reads as the enemy firing.
const LOOP = { idle: true, charge_skill: true };

// Static models (44 of the 66 roster entries) have no wind-up clip, and the
// telegraph is the player's whole dodge window -- an enemy that shows nothing
// for 0.70 s and then fires is unreadable. So the view supplies the tell:
// swell through the telegraph, then ease the release over a few frames. Scale
// is the only channel available (rotation is off-limits on a paper stack and
// the materials belong to the asset), and it costs no art.
const WINDUP = { swell: 0.16, snap: 0.10 };

// Damage feedback the models cannot supply themselves. 44 of 66 roster models
// are static (no damage clip), and bosses never flinch by design
// (actorstate.js BOSS_STATES) -- without something here, hitting either kind
// reads as a number floating over an untouched statue. The channel is colour,
// and it must OVERBRIGHTEN, not whiten: every kit character material is
// MeshBasicMaterial with color (1,1,1) and the art in the map (measured), so
// lerping toward white changes nothing at all. Values above 1 are legal in a
// Color and there is no tone mapping in the pipeline, so the framebuffer just
// clips -- bright texels blow out to white while the dark outlines (the
// silhouette) survive, which is exactly the original's own damage flash. The
// materials are per-load (core/loader.js load() is uncached), so tinting one
// enemy never leaks into another.
const FLASH_TIME = 0.12;
const FLASH_GAIN = 2.6;         // peak overbright multiplier at t = 1
// 辅助设置“减少受击闪烁”：保留轮廓仍在过曝通道上可读的最低增益，
// 只把峰值拉低，不缩短或取消闪烁，命中反馈不会凭空消失。
const FLASH_GAIN_REDUCED = 1.2;

// T21e 姿态修整 (spec/06): the posture audit (tools/rl_enemy_audit.py)
// measured all 63 shipped models in the live rendering context and tuned
// the ones whose rest pose is actually broken. EnemyResourceListDB_Param.cs
// has no y-offset field, so the authored table lives here in the view
// layer. deadParts (12001 ships a baked corpse pose) hides the corpse
// meshes under the live body and swaps to them on death instead of the
// generic sink -- deadLift puts the slumped body on the ground with the
// sword tip left in the dirt, as authored.
//
// T23e re-measure (tools/rl_posture_probe.py -> .cache/posture.json): the
// float bob below used to dip sin to -0.06, sinking every entryless static
// up to 6cm through the floor each cycle. The bob is now a half-wave
// (never negative), which on its own leaves a static's lowest vertex at
// minYover + 0.06; every static still measured under -0.08 at its deepest
// got an entry sized lift = -0.075 - minYover, putting the lowest vertex
// 5mm above the floor plane (-0.02). The T21e/T22e hand-audited entries
// were re-sized in T24e once the billboard tilt made them float (see the
// T24e block below); 12001 keeps its hand lift -- it rests +0.022 and the
// corpse-swap bands are tuned around it. Animated
// models keep their clip's root curves -- their lift is re-applied after
// mixer.update every frame but UNWRAPPED first (see sync): idles without a
// root translation track never rewrite root.y, so a bare additive lift
// accumulated lift x frames and flew the model into the sky. Sized so the
// idle clip's deepest dip clears the floor: lift = -0.015 - minYover.
// Attack clips were not measured and may dip deeper; the posture probe
// re-run is the check.
const POSTURE = {
    "model/enemy/model_en_12001.muast": {
        lift: 0.12,
        deadParts: ["deadbody_obj", "deadsword_obj"],
        deadLift: 0.30
    },
    // T24e re-measure (2026-09-06): the billboard tilt (root.rotation.x =
    // characterTiltX(), ~54.7°) maps z into world Y, so the T21e hand
    // audits -- taken upright, before the tilt went live -- overstate
    // depth. Their recorded local min -0.487 is 2.0 x the glb bind-space
    // -0.2436 exactly (no tilt term); once tilted the same mesh measures
    // -0.287, and every hand-audited entry floated 10-26cm. Re-sized from
    // bob-exact world minima (T23e probe and tools/rl_posture_diag.py
    // agree to 4 decimals) with the T23e static formula
    // lift = -0.015 - minYover: 14304 -0.287 -> 0.27, 11804/11801 -0.170
    // -> 0.155, 11301 -0.102 -> 0.087. 12001 keeps its hand lift (rests
    // +0.022, within grazing tolerance); 13702/13703 were already
    // T23e-sized and rest at -0.015/-0.018.
    "model/enemy/model_en_14304.muast": { lift: 0.27 },
    "model/enemy/model_en_11804.muast": { lift: 0.155 },
    // T22e additions: 11801 shares 11804's sunk pose (same family), and the
    // 137xx pair ships its bulk below the origin -- both read as standing in
    // the ground without these. T23e re-measure: the 137xx pair still sank
    // ~20cm at its deepest; raised to clear the floor. T24e: 11801 re-sized
    // with 11804 (same -0.170 local min).
    "model/enemy/model_en_11801.muast": { lift: 0.155 },
    "model/enemy/model_en_13702.muast": { lift: 0.284 },
    "model/enemy/model_en_13703.muast": { lift: 0.281 },
    "model/enemy/model_en_11301.muast": { lift: 0.087 },
    // T23e statics: entryless models measured under -0.08 at the deepest
    // bob dip (floor -0.02, half-wave bob). Sized lift = -0.075 - minYover.
    "model/enemy/model_en_8400.muast": { lift: 0.100 },
    "model/enemy/model_en_10812.muast": { lift: 0.041 },
    "model/enemy/model_en_10923.muast": { lift: 0.035 },
    "model/enemy/model_en_11201.muast": { lift: 0.067 },
    "model/enemy/model_en_11402.muast": { lift: 0.083 },
    "model/enemy/model_en_11403.muast": { lift: 0.083 },
    "model/enemy/model_en_11404.muast": { lift: 0.082 },
    "model/enemy/model_en_11901.muast": { lift: 0.189 },
    "model/enemy/model_en_12103.muast": { lift: 0.037 },
    "model/enemy/model_en_12104.muast": { lift: 0.037 },
    "model/enemy/model_en_12201.muast": { lift: 0.079 },
    "model/enemy/model_en_12303.muast": { lift: 0.063 },
    "model/enemy/model_en_12403.muast": { lift: 0.057 },
    "model/enemy/model_en_12503.muast": { lift: 0.041 },
    "model/enemy/model_en_12800.muast": { lift: 0.040 },
    "model/enemy/model_en_12902.muast": { lift: 0.010 },
    "model/enemy/model_en_13002.muast": { lift: 0.064 },
    "model/enemy/model_en_13603.muast": { lift: 0.053 },
    "model/enemy/model_en_13804.muast": { lift: 0.076 },
    "model/enemy/model_en_14502.muast": { lift: 0.097 },
    "model/enemy/model_en_15000.muast": { lift: 0.010 },
    "model/enemy/model_en_15203.muast": { lift: 0.035 },
    "model/enemy/model_en_15701.muast": { lift: 0.019 },
    "model/enemy/model_en_15901.muast": { lift: 0.060 },
    "model/enemy/model_en_16801.muast": { lift: 0.078 },
    // T23e animated: the lift rides on top of the clip curves, unwrapped and
    // re-applied each frame (sync, around mixer.update) because not every
    // idle clip drives the root. Sized lift = -0.015 - minYover from the
    // idle clip's deepest dip.
    "model/enemy/model_en_1000.muast": { lift: 0.142 },
    "model/enemy/model_en_1100.muast": { lift: 0.075 },
    "model/enemy/model_en_1200.muast": { lift: 0.129 },
    "model/enemy/model_en_1400.muast": { lift: 0.019 },
    "model/enemy/model_en_3800.muast": { lift: 0.037 },
    "model/enemy/model_en_4800.muast": { lift: 0.049 },
    "model/enemy/model_en_6800.muast": { lift: 0.023 },
    "model/enemy/model_en_7300.muast": { lift: 0.090 },
    "model/enemy/model_en_7400.muast": { lift: 0.078 },
    "model/enemy/model_en_11600.muast": { lift: 0.020 },
    "model/enemy/model_en_13400.muast": { lift: 0.006 },
    "model/enemy/model_en_14800.muast": { lift: 0.006 },
    "model/enemy/model_en_16700.muast": { lift: 0.033 },
    "model/enemy/model_en_17300.muast": { lift: 0.064 },
    "model/enemy/model_en_17400.muast": { lift: 0.072 }
};

function collectMaterials(root) {
    const materials = [];
    root.traverse(function (child) {
        if (!child.isMesh || !child.material) {
            return;
        }
        (Array.isArray(child.material) ? child.material : [child.material])
            .forEach(function (material) {
                if (materials.indexOf(material) === -1) {
                    materials.push(material);
                }
            });
    });
    return materials;
}

// tint > 1 is mid-flash: each material's colour is pushed past 1.0 toward
// FLASH_GAIN (see the comment above for why "toward white" would be a no-op).
// The base colours are captured once, so a future palette still round-trips.
// Nothing is allocated in update() -- the sync loop runs every frame.
function makeFlasher(THREE, root) {
    const materials = collectMaterials(root);
    const bases = materials.map(function (material) {
        return material.color.clone();
    });
    const fullFlash = new THREE.Color(FLASH_GAIN, FLASH_GAIN, FLASH_GAIN);
    const softFlash = new THREE.Color(FLASH_GAIN_REDUCED, FLASH_GAIN_REDUCED, FLASH_GAIN_REDUCED);
    let t = 0;
    return {
        trigger: function () {
            t = 1;
        },
        update: function (dt) {
            if (t <= 0) {
                return;
            }
            t = Math.max(0, t - dt / FLASH_TIME);
            const target = accessibility.reducedFlash ? softFlash : fullFlash;
            for (let i = 0; i < materials.length; i++) {
                materials[i].color.copy(bases[i]).lerp(target, t);
            }
        },
        // Diagnostic surface for the accessibility regression: the peak
        // overbright multiplier the flag selects and whether a flash is live.
        state: function () {
            return { gain: accessibility.reducedFlash ? FLASH_GAIN_REDUCED : FLASH_GAIN, t: t };
        }
    };
}

// Flip only once the horizontal facing component is clearly non-zero;
// inside the band the previous side is kept, so up/down pursuit does not
// flicker the mirror every frame.
const FLIP_BAND = 0.3;

function attachBillboardFlip(root, baseScale, onFlip) {
    let mirrored = false;
    return function (facing, mult) {
        const dirx = Math.cos(facing);
        if (dirx > FLIP_BAND) {
            mirrored = false;
        } else if (dirx < -FLIP_BAND) {
            mirrored = true;
        }
        const s = baseScale * (mult === undefined ? 1 : mult);
        root.scale.x = (mirrored ? -1 : 1) * s;
        root.scale.y = s;
        root.scale.z = s;
        if (onFlip) {
            onFlip(mirrored);
        }
    };
}

function windupScale(unit, state) {
    if (state === "telegraph") {
        const p = Math.min(1, unit.sm.stateTime / (unit.action?.move.warning || ENEMY_TIMING.telegraph));
        return 1 + WINDUP.swell * p * p;
    }
    if (state === "skill" || state === "dash") {
        return 1 - WINDUP.snap;
    }
    return 1;
}

function resolveClip(state, pattern, actions, committedClip) {
    let name = state === "skill" || (state === "dash" && committedClip)
        ? (committedClip || SKILL_CLIP[pattern] || "skill_0")
        : (CLIP[state] || "idle");
    for (let guard = 0; guard < 4 && !actions[name]; guard++) {
        name = CLIP_FALLBACK[name] || "idle";
    }
    return actions[name] ? name : null;
}

export function attachEnemyView(unit, scene) {
    return loader.load(unit.model, { kind: "enemy" }).then(function (loaded) {
        return loader.loadModules().then(function (modules) {
            const THREE = modules.THREE;
            const root = loaded.scene;
            // T22m: bring the material handling up to the measured models.html
            // state — per-material depth truth, alpha-blended edges, the
            // hidden EN_flash/blur/damage shells and msbVisible meshes. The
            // loader's older rules are what read as 错位/边缘粗.
            applyModelRules(root, THREE, { kind: "enemy" });
            // T22m-4: same mirror-winding rule as the player stack — a
            // flipped enemy's authored cull states eat the camera-facing
            // half (hair/sleeves vanish on the flipped side).
            const mirrorSide = createMirrorSideManager(THREE);
            mirrorSide.sync(root, false);
            scene.add(root);
            // Above every kit card, still depth-tested against them and each
            // other; only the player escapes the z-buffer (see view/layers.js).
            applyLayer(root, LAYER.enemy, false);
            // CHARACTER_SCALE (view/layers.js): the map is authored for
            // ~1.6-unit characters and the models export at half that. The
            // authored baseScale rides the same uniform factor so a boss
            // stays a boss next to the scaled-up player.
            const baseScale = (unit.scale && unit.scale !== 1 ? unit.scale : 1)
                * CHARACTER_SCALE;
            const shadow = createBlobShadow(THREE, scene, unit.radius * CHARACTER_SCALE);
            if (baseScale !== 1) {
                root.scale.setScalar(baseScale);
            }
            const applyFacing = attachBillboardFlip(root, baseScale,
                function (mirrored) { mirrorSide.sync(root, mirrored); });
            const flasher = makeFlasher(THREE, root);

            let mixer = null;
            let pattern = null;      // last telegraphed danmaku pattern
            let lastStateTime = -1;  // damage re-entry detector (see sync)
            let deadSwapped = false; // corpse-pose swap ran (see sync)
            let deathAge = 0;
            let deathOrigin = null;
            let retired = false;
            let currentAction = null, fadingAction = null, fadeUntil = 0;
            let lastLogicState = null, presentationScale = 1;
            const deathMaterials = collectMaterials(root).map(material => ({
                material: material, opacity: material.opacity
            }));
            let postureLift = 0;     // lift currently riding on root.y (see sync)
            const posture = POSTURE[unit.model] || null;
            const deadNames = posture && posture.deadParts;
            if (deadNames) {
                // The baked corpse must not render under the live body.
                root.traverse(function (child) {
                    if (child.isMesh
                            && deadNames.indexOf(child.name) !== -1) {
                        child.visible = false;
                    }
                });
            }
            const actions = {};
            if (loaded.animations && loaded.animations.length) {
                mixer = new THREE.AnimationMixer(root);
                loaded.animations.forEach(function (clip) {
                    actions[clip.name] = mixer.clipAction(clip);
                });
            }

            const view = {
                unit: unit,
                object: root,
                current: null,
                // Exposed for diagnostics (posture probe): the closure keeps
                // the live mixer private, but gates need to know whether the
                // view is clip-driven at all.
                mixer: null,
                hit: function () { if (!retired) { flasher.trigger(); } },
                flashState: function () { return flasher.state(); },

                play: function (name, options) {
                    const action = actions[name];
                    if (!action) {
                        return false;
                    }
                    const config = options || {};
                    const terminal = unit.dead || unit.sm.state === 'dead' || name === 'dead';
                    const fade = terminal ? 0 : config.fade === undefined ? .07 : config.fade;
                    // A short two-action handoff, with bounded retirement. Death
                    // must not blend a still-running idle or skill into its pose.
                    if (terminal) { mixer.stopAllAction(); }
                    else if (fadingAction && fadingAction !== currentAction && fadingAction !== action) {
                        fadingAction.stop();
                    }
                    fadingAction = null;
                    action.reset();
                    action.stopFading(); action.stopWarping(); action.setEffectiveWeight(1);
                    action.setEffectiveTimeScale(1);
                    action.setLoop(
                        config.loop === false ? THREE.LoopOnce : THREE.LoopRepeat,
                        config.loop === false ? 1 : Infinity
                    );
                    action.clampWhenFinished = config.loop === false;
                    if (!terminal && currentAction && currentAction !== action && currentAction.isScheduled()) {
                        if (fade > 0) {
                            action.crossFadeFrom(currentAction, fade, false);
                            fadingAction = currentAction; fadeUntil = mixer.time + fade;
                        } else { currentAction.stop(); }
                    }
                    action.play();
                    currentAction = action;
                    view.current = name;
                    return true;
                },

                sync: function (dt, now, position) {
                    if (retired) { return; }
                    const step = dt || 0;
                    const state = unit.dead ? "dead" : unit.sm.state;
                    const deathEntered = state === 'dead' && lastLogicState !== 'dead';
                    lastLogicState = state;
                    const at = position || unit;
                    if (unit.dead && deathOrigin === null) {
                        deathOrigin = root.position.y;
                    }
                    // A (re)entered "damage" state is the flinch the model
                    // cannot always show itself: static models have no clip
                    // and bosses never flinch (BOSS_STATES), so the flash is
                    // the feedback in both cases. Re-entry resets stateTime,
                    // so any fresh or repeated hit reads as time going
                    // backwards -- no separate last-state bookkeeping needed.
                    // damageEntered gates the flinch REPLAY below: testing
                    // "state is damage" instead of "damage just entered"
                    // re-triggered the action on every frame of the state,
                    // and action.reset() re-zeroed the clip each time -- the
                    // flinch froze on frame 0 for its whole window and only
                    // played out after the state had already ended.
                    let damageEntered = false;
                    if (state === "damage" && unit.sm.stateTime < lastStateTime) {
                        flasher.trigger();
                        damageEntered = true;
                    }
                    lastStateTime = unit.sm.stateTime;
                    // unit.pending is live only during the telegraph (enemyai.js
                    // clears it on the frame the skill window opens), so the
                    // pattern is snapshotted here and reused for "skill"/"dash".
                    if (unit.pending && unit.pending.pattern) {
                        pattern = unit.pending.pattern;
                    }
                    const targetScale = windupScale(unit, state);
                    presentationScale = unit.dead ? 1 : presentationScale + (targetScale - presentationScale)
                        * (1 - Math.exp(-Math.max(0, step) * 28));
                    const windup = presentationScale;
                    flasher.update(step);
                    // T22m billboard tilt: same as the player stack — the
                    // enemy models are front-on paper exports, so they lean
                    // back by the live camera pitch to read straight-on
                    // instead of foreshortened-from-above (view/tilt.js).
                    root.rotation.x = characterTiltX();

                    if (mixer) {
                        const clip = resolveClip(state, pattern, actions, unit.action?.move.clip);
                        // The state windows are this game's compression of the
                        // original's cinematic timelines (skill clips run
                        // 1.2-3.8 s against a 0.45 s window, damage 0.6-1.5 s
                        // against 0.35 s). Playing them at natural speed and
                        // switching the clip on every state exit truncates each
                        // gesture at 15-40% and pops back to idle -- so a
                        // committed one-shot (skill, damage) is allowed to
                        // LINGER past its state into idle/recover until the
                        // clip finishes; the attack cadence (~2.8 s between
                        // decisions) leaves room for it, and because every
                        // one-shot is authored to end on the neutral pose the
                        // handoff to idle does not pop. Anything that carries
                        // information (a new telegraph, a flinch, death, or a
                        // skill slot change) still cuts it immediately.
                        let lingering = false;
                        if (clip && clip !== view.current
                                && (state === "idle" || state === "recover")
                                && !LOOP[view.current]) {
                            const held = actions[view.current];
                            lingering = held
                                && held.time < held.getClip().duration - 1e-3;
                        }
                        // Keyed by the resolved clip, not by the state:
                        // telegraph and dash share charge_skill, and restarting
                        // it mid-lunge would rewind the tell the player just
                        // read. A repeated "damage" re-triggers on ENTRY
                        // (damageEntered), because sm.set re-enters and the
                        // flinch has to be visible.
                        if (clip && !lingering
                                && (clip !== view.current || damageEntered || deathEntered)) {
                            view.play(clip, { loop: state !== "dead" && Boolean(LOOP[clip]),
                                fade: state === 'dead' || state === 'damage' ? 0 : .07 });
                        }
                        // Unwrap last frame's posture lift before the mixer
                        // rewrites the root. Animated idles WITHOUT a root
                        // translation track never touch root.y, so a bare
                        // += below accumulated lift x frames (measured: root
                        // climbed 8-24 m in a 2.6 s probe). Unwrap-then-rewrap
                        // keeps the clip's own root motion AND makes the lift
                        // idempotent whether or not the clip drives the root.
                        root.position.y -= postureLift;
                        postureLift = 0;
                        mixer.update(step);
                        if (fadingAction && mixer.time >= fadeUntil) {
                            fadingAction.stop(); fadingAction = null;
                        }
                        applyFacing(unit.facing, windup);
                        if (!unit.dead && posture) {
                            // T23e: animated sinkers ride their authored clip.
                            // postureLift tracks exactly what was added, so
                            // the next frame's unwrap removes precisely that
                            // -- idempotent even when the clip has no root
                            // track (see the unwrap above). Sized from the
                            // idle clip's deepest dip; attack clips may dip
                            // deeper.
                            postureLift = posture.lift;
                            root.position.y += postureLift;
                        }
                    } else {
                        // Static model: the view provides the motion. The
                        // float bob reads as hovering; a spin would show the
                        // layered quads edge-on, so facing is only the
                        // mirror. Dead units sink and stop -- unless the
                        // model ships its own corpse pose (POSTURE.deadParts),
                        // which swaps in and holds at deadLift instead.
                        view.current = state;
                        if (!unit.dead) {
                            applyFacing(unit.facing, windup);
                            // Half-wave bob (T23e): the sine's negative half
                            // dipped every entryless static up to 6cm through
                            // the floor each cycle. Clamping to the positive
                            // half keeps the hover at or above the rest pose;
                            // the POSTURE lifts above are sized against this
                            // clamp, so change them together.
                            root.position.y = (posture ? posture.lift : 0)
                                + Math.max(0, Math.sin((now || 0) / 600)) * 0.06;
                        } else if (deadNames) {
                            if (!deadSwapped) {
                                deadSwapped = true;
                                root.traverse(function (child) {
                                    if (child.isMesh) {
                                        child.visible =
                                            deadNames.indexOf(child.name) !== -1;
                                    }
                                });
                            }
                            root.position.y = posture.deadLift || posture.lift || 0;
                        } else {
                            root.position.y = Math.max(root.position.y - step * 1.0, -0.8);
                        }
                    }

                    root.position.x = at.x;
                    root.position.z = at.y;
                    if (unit.dead) {
                        // Authored deaths assume the original fade-out pass.
                        // Bound it here for BOTH animated and static enemies.
                        deathAge += step;
                        const t = Math.min(1, deathAge / 0.75);
                        const base = deadNames ? (posture.deadLift || 0) : deathOrigin;
                        root.position.y = base - t * 0.4;
                        deathMaterials.forEach(function (entry) {
                            entry.material.transparent = true;
                            entry.material.opacity = entry.opacity * (1 - t * t);
                        });
                        if (t >= 1) {
                            retired = true;
                            root.visible = false;
                            if (mixer) { mixer.stopAllAction(); }
                        }
                    }
                    // The float bob and the death sink are both real height, so
                    // the shadow reads them straight off the model.
                    shadow.sync(at.x, at.y,
                        Math.max(0, root.position.y), !unit.dead);
                },

                dispose: function () {
                    retired = true;
                    if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(root); }
                    shadow.dispose();
                    scene.remove(root);
                    loader.disposeObject(root);
                }
            };
            // The closure mixer is assigned after the literal is built; the
            // property above keeps it reachable for diagnostics.
            view.mixer = mixer;
            view.sync(0, 0);
            return view;
        });
    });
}
