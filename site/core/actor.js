// One playable character: model + animation + face + weapon.
//
// The four games all need "put Yuno on screen, make her swing, make her smile",
// and none of them should have to know that a swing lives in a shared
// class-action bundle while the face lives in a per-character layer table.
// This module is that boundary.
//
// What it wraps, and why each piece is not optional:
//
//   * Model      asset/models/model_pl_<resourceID>/model.glb.gz, via
//                core/loader.js so the alpha/depth rules stay in one place.
//   * Actions    idle / attack / class_skill_1..3 do NOT ship with the model.
//                They live in one bundle per (class, head) pair, shared by
//                every character with that combination, which is why a 685-card
//                roster needs 20 action bundles instead of 685.
//   * Skill      a handful of characters have a dedicated clip of their own in
//                manifest.skillActions; where it exists it replaces the class
//                skill rather than adding to it.
//   * Face       expressions are not morph targets. The head ships every eye,
//                brow and mouth variant as a separate node named L30_<layer>,
//                and an expression is a set of those layers being visible.
//                asset/models/facial/<character>.json is the authored table.
//   * Facial ev  the clips carry MabAnimEvents saying which facial ID to show
//                on which frame, extracted into facial/actions.json. Without
//                them a damaged character keeps smiling.
//   * Blink      not authored anywhere. CharacterAnim runs it on its own timer
//                and only over a resting face.
//   * Weapon     a separate model, mounted into the Loc_L / Loc_R sockets.
//
// The facial logic here is a port of the code models.js arrived at over several
// commits, not a re-derivation: the same layer indexing, the same override
// sets, the same "what does the action want right now" rule that keeps a blink
// from undoing a victory pose.

import * as loader from "./loader.js";
import { loadPlayerVisibility, createPlayerVisibility } from "./actorvisibility.js";

// Resolve manifest assets from the loader module, independent of page depth.
const FACIAL_ACTIONS_URL = "asset/models/facial/actions.json";

function siteUrl(path) {
    return loader.assetUrl(path);
}

// CharacterAnim's blink timing, in milliseconds.
const BLINK_CLOSED_MS = 115;
const BLINK_GAP_MS = 2800;
const BLINK_JITTER_MS = 2600;

// The class-default weapon resource IDs are 1000 + class * 100.
const CLASS_WEAPON_BASE = 1000;
const CLASS_WEAPON_STEP = 100;

const WEAPON_SIDE = /_([LR])$/i;

let actionsPromise = null;
const facialCache = new Map();

// facial/actions.json: { version, fps, actions: { <clip>: [[frame, facialId, overrideSet], ...] } }
function loadFacialActions() {
    if (!actionsPromise) {
        actionsPromise = loader.loadManifest().then(function (manifest) {
            return fetch(siteUrl(manifest.facialActions || FACIAL_ACTIONS_URL));
        }).then(function (response) {
            if (!response.ok) {
                throw new Error("facial actions " + response.status);
            }
            return response.json();
        }).catch(function () {
            // A missing table costs expressions, not the character. Every game
            // still runs; faces just stay at rest.
            return { fps: 30, actions: {} };
        });
    }
    return actionsPromise;
}

// Per-character layer table. The manifest names the file on the model entry
// because two characters from the same work can share one table.
function loadFacialTable(url) {
    if (!url) {
        return Promise.resolve(null);
    }
    if (!facialCache.has(url)) {
        facialCache.set(url, fetch(siteUrl(url))
            .then(function (response) {
                if (!response.ok) {
                    throw new Error("facial table " + response.status);
                }
                return response.json();
            })
            .catch(function () { return null; }));
    }
    return facialCache.get(url);
}

// --- facial state -------------------------------------------------------

// One authored layer can arrive as several nodes -- mirrored pieces, plus the
// separate outline material -- so each name keeps a list.
function indexFacialLayers(root) {
    const layers = new Map();
    root.traverse(function (child) {
        const name = loader.resolveNodeName(child);
        if (name.slice(0, 4).toLowerCase() !== "l30_") {
            return;
        }
        const layer = name.slice(4);
        if (!layers.has(layer)) {
            layers.set(layer, []);
        }
        layers.get(layer).push(child);
    });
    return layers;
}

// Characters whose facial table never shipped (the Bocchi cast, kirara
// Part-2, Sawako) still carry the full L30_ layer stack in their model --
// every authored eye/mouth variant visible at once. The shipped tables all
// agree on the resting composition (eye_A + eyebrow_A + mouth_A, blush and
// tears off), so rebuild that from the layer names alone: within each
// feature group that has an "A" variant show only the A meshes, hide cry/
// cheek, and leave everything the tables never mention (head base, hair,
// unlettered base meshes like eyelight) untouched. Returns false when the
// model has no L30_ layers -- nothing to do.
function applyRestingFallback(root) {
    const nodes = [];
    root.traverse(function (child) {
        const name = loader.resolveNodeName(child);
        if (name.slice(0, 4).toLowerCase() === "l30_") {
            nodes.push({ node: child, name: name.slice(4) });
        }
    });
    if (!nodes.length) {
        return false;
    }
    const hasA = { eye: false, brow: false, mouth: false };
    nodes.forEach(function (entry) {
        const group = layerGroup(entry.name);
        if (hasA.hasOwnProperty(group) && layerLetter(entry.name) === "A") {
            hasA[group] = true;
        }
    });
    nodes.forEach(function (entry) {
        const group = layerGroup(entry.name);
        if (group === "cry" || group === "cheek") {
            entry.node.visible = false;
            return;
        }
        if (!hasA.hasOwnProperty(group) || !hasA[group]) {
            return;                 // head base / other / no A to key off
        }
        const letter = layerLetter(entry.name);
        if (letter !== "") {
            entry.node.visible = letter === "A";
        }
    });
    return true;
}

// --- the actor ----------------------------------------------------------

// create(options) -> Promise<actor>
//   options.resourceId   required; the model's m_ResourceID (e.g. 100003)
//   options.classId      needed for class actions and the default weapon
//   options.headId       which head variant, for picking the action bundle
//   options.weapon       "none" | "default" | "dedicated"  (default "default")
//   options.dedicatedWeapon  { resourceIdL, resourceIdR } from the card
//   options.actions      false to skip the class-action bundle entirely
//   options.skillId      resource ID whose dedicated skill clip to load
//   options.faces        { <name>: <stateIndex> } hand-picked expression names,
//                        overriding the inference in emotionIndex()
export function create(options) {
    const opts = options || {};
    const resourceId = String(opts.resourceId);
    const assetKey = "model/player/model_pl_" + resourceId + ".muast";

    return Promise.all([
        loader.loadModules(),
        loader.load(assetKey, { kind: "player", onProgress: opts.onProgress }),
        loadFacialActions(),
        loadPlayerVisibility(siteUrl("asset/models/visibility.json"))
    ]).then(function (parts) {
        const modules = parts[0];
        const loaded = parts[1];
        const facialActions = parts[2];

        return Promise.all([
            loadFacialTable(loaded.entry.facial),
            opts.actions === false
                ? Promise.resolve(null)
                : loader.loadClassActions(opts.classId || 0, opts.headId || 0)
                    .catch(function () { return null; }),
            opts.skillId ? loadSkillActions(opts.skillId) : Promise.resolve(null)
        ]).then(function (extra) {
            const actor = build({
                modules: modules,
                loaded: loaded,
                facialTable: extra[0],
                facialActions: facialActions,
                visibilityTable: parts[3],
                classActions: extra[1],
                skillActions: extra[2],
                faces: opts.faces || null,
                opts: opts
            });
            const mode = opts.weapon === undefined ? "default" : opts.weapon;
            return actor.equip(mode).then(function () { return actor; });
        });
    });
}

function loadSkillActions(skillId) {
    return loader.loadManifest().then(function (manifest) {
        const entry = (manifest.skillActions || {})[String(skillId)];
        if (!entry) {
            return null;
        }
        return loader.loadModules().then(function (modules) {
            return loader.readModelCached(siteUrl(entry.file), entry.compression)
                .then(function (blob) { return blob.arrayBuffer(); })
                .then(function (buffer) {
                    return parseActionBundle(modules, buffer, entry.meshopt);
                })
                .then(function (result) {
                    const actions = {
                        animations: result.animations || [], names: entry.animations || [],
                        sourceRoot: result.scene
                    };
                    return actions;
                });
        });
    }).catch(function () { return null; });
}

// Build a path index for a donor or target hierarchy. UUIDs are intentionally
// excluded: GLTFLoader gives every parsed file fresh UUIDs, while Unity's
// transform names and parent paths are stable across the model and action pack.
function hierarchyPath(root, node) {
    const names = [];
    for (let current = node; current; current = current.parent) {
        const name = current.userData && current.userData.name || current.name;
        if (name) {
            names.unshift(name);
        }
        // The outer GLB wrapper names differ between a character and an action
        // bundle. The stable identity begins at the Unity rig anchor, matching
        // the viewer's embedded-clip repair rule.
        if (name === "root" || name === "Head_root") {
            return names.join("/");
        }
        if (current === root) {
            break;
        }
    }
    return "";
}

function hierarchyAnchor(node) {
    for (let current = node; current; current = current.parent) {
        const name = current.userData && current.userData.name || current.name;
        if (name === "root" || name === "Head_root") {
            return current;
        }
    }
    return null;
}

function hierarchyIndex(root) {
    const usedAnchors = new Set();
    root.traverse(function (node) {
        if (node.isSkinnedMesh && node.skeleton) {
            node.skeleton.bones.forEach(function (bone) {
                const anchor = hierarchyAnchor(bone);
                if (anchor) {
                    usedAnchors.add(anchor);
                }
            });
        }
    });
    const index = new Map();
    root.traverse(function (node) {
        const path = hierarchyPath(root, node);
        const previous = index.get(path);
        const anchor = hierarchyAnchor(node);
        if (path && (!previous
            || (!usedAnchors.has(hierarchyAnchor(previous)) && usedAnchors.has(anchor)))) {
            index.set(path, node);
        }
    });
    return index;
}

function repairEmbeddedClips(THREE, root, clips) {
    const targets = hierarchyIndex(root);
    clips.forEach(function (clip) {
        clip.tracks = clip.tracks.map(function (track) {
            const separator = track.name.lastIndexOf(".");
            if (separator < 0) {
                return track;
            }
            const source = THREE.PropertyBinding.findNode(root, track.name.slice(0, separator));
            const target = source && (targets.get(hierarchyPath(root, source)) || source);
            if (!target) {
                return track;
            }
            // Mixer bindings are keyed by the track name, not the resolved
            // object. Even an already-correct node must use the same UUID as
            // donor clips, or a fading alias can restore over the live pose.
            const repaired = track.clone();
            repaired.name = target.uuid + track.name.slice(separator);
            return repaired;
        });
    });
}

function retargetClip(THREE, clip, donorRoot, targetRoot, bindPositions) {
    if (!donorRoot || !targetRoot) {
        return clip;
    }
    const targets = hierarchyIndex(targetRoot);
    const tracks = clip.tracks.map(function (track) {
        const separator = track.name.lastIndexOf(".");
        if (separator < 0) {
            return null;
        }
        const sourceName = track.name.slice(0, separator);
        const sourceNode = THREE.PropertyBinding.findNode(donorRoot, sourceName);
        const targetNode = sourceNode && targets.get(hierarchyPath(donorRoot, sourceNode));
        if (!targetNode) {
            return null;
        }
        const retargeted = track.clone();
        retargeted.name = targetNode.uuid + track.name.slice(separator);
        const semantic = sourceNode.userData.name || sourceNode.name;
        if (bindPositions && track.name.slice(separator) === ".position"
                && /^(Loc_[LR]|Weapon_[LR]|(Hand|Arm)_[LR]_assist|Arm_accessories_[LR]\d+)$/.test(semantic)) {
            // Keep the authored motion relative to the donor's bind position.
            // Zero is not the target's bind pose: clearing these tracks moves
            // sleeves/hands/weapon grips onto their parent's origin.
            // A donor may finish loading in the middle of an attack. Retarget
            // against the immutable bind pose, never that transient pose.
            const delta = bindPositions.get(targetNode.uuid).clone().sub(sourceNode.position);
            for (let i = 0; i < retargeted.values.length; i += 3) {
                retargeted.values[i] += delta.x;
                retargeted.values[i + 1] += delta.y;
                retargeted.values[i + 2] += delta.z;
            }
        }
        return retargeted;
    }).filter(Boolean);
    return new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
}

// Skill packs are exported from the original cut-in stage. Their root tracks
// contain camera/stage travel (often several world units) that must not move a
// roguelike unit away from its logic position. Keep all pose tracks and remove
// only translations on the scene root. `Head_root` is a separate visual rig
// whose position is the authored head-to-body bind offset; clearing it drops
// the head to the character's feet.
function stripStageRootMotion(THREE, clip, root) {
    const tracks = clip.tracks.map(function (track) {
        const separator = track.name.lastIndexOf(".");
        if (separator < 0) { return track; }
        const node = root.getObjectByProperty("uuid", track.name.slice(0, separator));
        const semantic = node && (node.userData.name || node.name);
        if (semantic === "root" && track.name.indexOf(".position") !== -1) {
            const cleaned = track.clone();
            cleaned.values.fill(0);
            return cleaned;
        }
        return track;
    });
    return new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
}

function parseActionBundle(modules, buffer, meshopt) {
    const gltfLoader = new modules.GLTFLoader();
    if (meshopt) {
        gltfLoader.setMeshoptDecoder(modules.MeshoptDecoder);
    }
    return new Promise(function (resolve, reject) {
        gltfLoader.parse(buffer, "", resolve, reject);
    });
}

function build(context) {
    const THREE = context.modules.THREE;
    const root = context.loaded.scene;
    const opts = context.opts;
    const facialTable = context.facialTable;
    const facialActions = (context.facialActions && context.facialActions.actions) || {};
    const facialFps = (context.facialActions && context.facialActions.fps) || 30;

    repairEmbeddedClips(THREE, root, context.loaded.animations || []);
    const bindPositions = new Map();
    root.traverse(node => bindPositions.set(node.uuid, node.position.clone()));
    const mixer = new THREE.AnimationMixer(root);
    const clips = new Map();
    const clipIdentity = new Map();
    const weaponActionLoads = new Map();
    const visibility = createPlayerVisibility(root, context.visibilityTable,
        opts.classId, loader.resolveNodeName);

    // Clip sources in priority order: the model's own clips, then the shared
    // class actions, then a dedicated skill clip. Later sources win, because a
    // character with an authored skill should use it over the class default.
    (context.loaded.animations || []).forEach(function (clip) {
        clips.set(clip.name, clip);
    });
    if (context.classActions) {
        context.classActions.animations.forEach(function (clip, i) {
            const name = context.classActions.names[i] || clip.name;
            const bound = stripStageRootMotion(THREE,
                retargetClip(THREE, clip, context.classActions.sourceRoot, root,
                    opts.stageMotion ? null : bindPositions), root);
            bound.name = name;
            clips.set(name, bound);
        });
        loader.disposeObject(context.classActions.sourceRoot);
    }
    if (context.skillActions) {
        context.skillActions.animations.forEach(function (clip, i) {
            const name = context.skillActions.names[i] || clip.name;
            const retargeted = retargetClip(THREE, clip, context.skillActions.sourceRoot, root,
                opts.stageMotion ? null : bindPositions);
            const bound = opts.stageMotion ? retargeted : stripStageRootMotion(THREE, retargeted, root);
            bound.name = name;
            clips.set(name, bound);
        });
        loader.disposeObject(context.skillActions.sourceRoot);
    }

    const layerNodes = facialTable ? indexFacialLayers(root) : new Map();

    let action = null;           // the running THREE.AnimationAction
    let fadingAction = null;
    let fadeUntil = 0;
    let actionName = "";
    let actionSourceName = "";
    let faceIndex = -1;
    let faceFollowsAction = true;
    let facialEventIndex = -1;
    let blinkActive = false;
    let blinkUntil = 0;
    let nextBlinkAt = BLINK_GAP_MS;
    let elapsed = 0;
    let weaponParts = [];
    let weaponSources = [];
    let weaponRequest = 0;
    let weaponResourceIds = [];
    let weaponVisible = true;
    const faceAliases = Object.assign(Object.create(null), context.faces || {});
    let disposed = false;

    // Apply one row of the table: the layers it lists go visible, every other
    // switched layer goes hidden, and the layers the table records as unused
    // stay hidden. Layers the table never mentions are the head base -- hair,
    // face, backhead -- which is on for every expression and must not be
    // touched.
    function applyFace(index, automatic) {
        if (!facialTable) {
            return false;
        }
        const state = facialTable.states[index];
        if (!state) {
            return false;
        }
        const wanted = new Set();
        state.forEach(function (layerIndex) {
            const layer = facialTable.layers[layerIndex];
            if (layer) {
                wanted.add(layer);
            }
        });
        facialTable.layers.forEach(function (layer) {
            (layerNodes.get(layer) || []).forEach(function (node) {
                node.visible = wanted.has(layer);
            });
        });
        (facialTable.hide || []).forEach(function (layer) {
            (layerNodes.get(layer) || []).forEach(function (node) {
                node.visible = false;
            });
        });
        faceIndex = index;
        faceFollowsAction = Boolean(automatic);
        return true;
    }

    // facialID -> state index, through the override sets the events carry.
    // CharacterFacialDB gives some characters a different face for the same
    // event; a zero set means no override.
    function stateForId(facialId, overrideSet) {
        if (!facialTable) {
            return -1;
        }
        if (overrideSet && facialTable.overrides) {
            const replaced = facialTable.overrides[String(overrideSet)];
            if (replaced !== undefined && replaced >= 0) {
                return replaced;
            }
        }
        const index = facialTable.ids[facialId];
        return index === undefined ? -1 : index;
    }

    function restingFace() {
        return facialTable ? facialTable["default"] : -1;
    }

    // The face the action wants *right now* -- the event the clip has reached,
    // not its frame-0 event. win_st_0 is neutral until frame 7 and winning
    // after it, so a blink ending at frame 40 must hand back the winning face.
    function wantedFace() {
        const events = facialActions[actionSourceName];
        if (!events || !events.length) {
            return restingFace();
        }
        const event = events[facialEventIndex >= 0 ? facialEventIndex : 0];
        const state = stateForId(event[1], event[2]);
        return state >= 0 ? state : restingFace();
    }

    function faceFromClip() {
        if (!facialTable || !faceFollowsAction || !action) {
            return;
        }
        const events = facialActions[actionSourceName];
        if (!events || !events.length) {
            return;
        }
        const clip = action.getClip();
        let time = action.time;
        if (clip && clip.duration) {
            time = time % clip.duration;      // a looping clip replays its events
        }
        // Nudge by a thousandth of a frame: accumulating 1/30 fourteen times
        // and scaling back gives 13.9999996, so frame 14 would land on 15.
        const frame = time * facialFps + 0.001;
        let index = 0;
        for (let i = 0; i < events.length; i++) {
            if (events[i][0] <= frame) {
                index = i;
            }
        }
        if (index === facialEventIndex) {
            return;
        }
        const state = stateForId(events[index][1], events[index][2]);
        if (state >= 0) {
            facialEventIndex = index;
            applyFace(state, true);
        }
    }

    function updateBlink(ms) {
        if (!facialTable) {
            return;
        }
        // Test what the action wants, not what is on screen: the blink itself
        // changes what is on screen, so testing that would stop the face
        // resting the instant it blinked and leave the eye shut.
        const wanted = wantedFace();
        const canBlink = faceFollowsAction
            && wanted === restingFace()
            && facialTable.blink >= 0
            && facialTable.blink !== restingFace();
        if (canBlink) {
            if (!blinkActive && ms >= nextBlinkAt) {
                blinkActive = true;
                blinkUntil = ms + BLINK_CLOSED_MS;
                applyFace(facialTable.blink, true);
            } else if (blinkActive && ms >= blinkUntil) {
                blinkActive = false;
                nextBlinkAt = ms + BLINK_GAP_MS + Math.random() * BLINK_JITTER_MS;
                applyFace(wanted, true);
            }
        } else {
            if (blinkActive) {
                // Interrupted mid-blink by a move that wants its own face:
                // hand the face back rather than leaving the eye shut.
                applyFace(wanted, true);
            }
            blinkActive = false;
            nextBlinkAt = ms + BLINK_GAP_MS;
        }
        if (!blinkActive) {
            faceFromClip();     // must not overwrite a closed eye
        }
    }

    function weaponIds(mode) {
        if (mode === "none") {
            return [];
        }
        if (mode && typeof mode === "object") {
            return [...new Set([mode.resourceIdL, mode.resourceIdR].filter(id => Number.isInteger(id) && id > 0))];
        }
        if (mode === "dedicated" && opts.dedicatedWeapon) {
            return [opts.dedicatedWeapon.resourceIdL, opts.dedicatedWeapon.resourceIdR]
                .filter(function (id) { return Number.isFinite(id); });
        }
        if (Number.isFinite(opts.classId)) {
            return [CLASS_WEAPON_BASE + opts.classId * CLASS_WEAPON_STEP];
        }
        return [];
    }

    function clearWeapon() {
        // Put all owned pieces back under one disposal root. Mounted halves
        // and unused pieces can share materials, textures, and geometry.
        const owned = new THREE.Group();
        weaponParts.forEach(function (part) {
            owned.add(part);
        });
        weaponSources.forEach(function (source) { owned.add(source); });
        loader.disposeObject(owned);
        weaponParts = [];
        weaponSources = [];
    }

    const actor = {
        resourceId: String(opts.resourceId),
        object: root,
        mixer: mixer,
        entry: context.loaded.entry,
        facialTable: facialTable,
        classId: opts.classId,
        get weaponParts() { return weaponParts.slice(); },
        get weaponResourceIds() { return weaponResourceIds.slice(); },

        get actionNames() { return Array.from(clips.keys()); },
        get action() { return actionName; },
        get faceIndex() { return faceIndex; },
        get faceNames() {
            return facialTable
                ? facialTable.states.map(function (_s, i) { return faceTag(facialTable, i); })
                : [];
        },

        // Cross-fade into a clip. Unknown names are a no-op returning false, so
        // a game can offer class_skill_3 without checking whether this class has
        // one.
        play: function (name, options) {
            if (disposed) { return false; }
            const config = options || {};
            const clip = clips.get(String(name));
            if (!clip) {
                return false;
            }
            const next = mixer.clipAction(clip);
            if (fadingAction && fadingAction !== action && fadingAction !== next) {
                fadingAction.stop();
            }
            fadingAction = null;
            next.reset();
            next.stopFading();
            next.stopWarping();
            next.setEffectiveWeight(1);
            next.setLoop(
                config.loop === false ? THREE.LoopOnce : THREE.LoopRepeat,
                config.loop === false ? 1 : Infinity
            );
            next.clampWhenFinished = config.loop === false;
            next.setEffectiveTimeScale(config.duration > 0
                ? clip.duration / config.duration : (config.speed || 1));
            const fade = config.fade === undefined ? 0.18 : config.fade;
            if (action && action !== next && action.isScheduled() && fade > 0) {
                next.crossFadeFrom(action, fade, false);
                fadingAction = action;
                fadeUntil = mixer.time + fade;
            }
            next.play();
            if (action && action !== next && fade <= 0) {
                action.stop();
            }
            action = next;
            actionName = String(name);
            const identity = clipIdentity.get(actionName);
            actionSourceName = identity ? identity.sourceName : actionName;
            visibility.select(actionSourceName, identity ? identity.classId : opts.classId);
            // A new action owns the face again, from its own frame 0.
            facialEventIndex = -1;
            blinkActive = false;
            faceFollowsAction = true;
            if (facialTable) {
                const events = facialActions[actionSourceName];
                const state = events && events.length
                    ? stateForId(events[0][1], events[0][2])
                    : -1;
                applyFace(state >= 0 ? state : restingFace(), true);
            }
            return true;
        },

        // Pin the face until the next play(). Accepts a state index, a tag like
        // "default" / "blink" / "abnormal" / "action:win_st", or an emotion name
        // like "sad" / "excited" / "smile-tired" (see emotionIndex).
        face: function (which) {
            if (disposed || !facialTable) {
                return false;
            }
            const alias = typeof which === "string" && faceAliases[which] !== undefined
                ? faceAliases[which] : which;
            const index = which === undefined || which === null
                ? restingFace() : resolveFace(facialTable, alias, faceAliases);
            if (index < 0 || !applyFace(index, false)) { return false; }
            blinkActive = false;
            return true;
        },

        // Add a runtime face name without editing the generated facial table.
        // The value may be a table state index or any name accepted by face().
        registerFace: function (name, state) {
            if (disposed || !facialTable || typeof name !== "string" || !name.trim()
                || (typeof state !== "number" && typeof state !== "string")) {
                return false;
            }
            const index = resolveFace(facialTable, state, faceAliases);
            if (!Number.isInteger(index) || !facialTable.states[index]) { return false; }
            faceAliases[name] = index;
            return true;
        },

        removeFace: function (name) {
            if (disposed || !Object.prototype.hasOwnProperty.call(faceAliases, name)) { return false; }
            return delete faceAliases[String(name)];
        },

        // Register an AnimationClip. Pass sourceRoot when the clip came from a
        // donor GLB; tracks are then retargeted by transform path and bound to
        // this actor's UUIDs. With no sourceRoot, the clip must already target
        // this actor (the useful form for clips exported from the model itself).
        registerAction: function (name, clip, options) {
            if (disposed || typeof name !== "string" || !name.trim() || !clip
                || typeof clip.clone !== "function" || !Array.isArray(clip.tracks)) {
                return false;
            }
            const config = options || {};
            if (clips.has(name) && config.replace !== true) { return false; }
            let prepared = config.sourceRoot
                ? retargetClip(THREE, clip, config.sourceRoot, root,
                    config.mountOffsets === true ? bindPositions : null)
                : clip.clone();
            if (!config.sourceRoot) { repairEmbeddedClips(THREE, root, [prepared]); }
            if (config.inPlace) { prepared = stripStageRootMotion(THREE, prepared, root); }
            if (!prepared.tracks.length) {
                return false;
            }
            actor.removeAction(name);
            prepared.name = name;
            clips.set(name, prepared);
            clipIdentity.set(name, { sourceName: config.sourceName || name,
                classId: Number.isInteger(config.classId) ? config.classId : opts.classId });
            return true;
        },

        // Borrow only the weapon's ordinary stance/attack. Character skills and
        // cinematics retain their own class. Donor rigs are always disposed.
        loadWeaponActions: function (classId) {
            if (classId === opts.classId) { return Promise.resolve({ idle: "idle", attack: "attack" }); }
            if (!Number.isInteger(classId) || classId < 0 || classId > 4 || disposed) {
                return Promise.reject(new Error("invalid weapon class"));
            }
            if (!weaponActionLoads.has(classId)) {
                const pending = loader.loadClassActions(classId, opts.headId || 0).then(bundle => {
                    try {
                        if (disposed) { return null; }
                        bundle.animations.forEach((clip, index) => {
                            const sourceName = bundle.names[index] || clip.name;
                            actor.registerAction("ext_" + classId + "_" + sourceName, clip, {
                                sourceRoot: bundle.sourceRoot, sourceName, classId,
                                mountOffsets: true, inPlace: true
                            });
                        });
                        return { idle: "ext_" + classId + "_idle", attack: "ext_" + classId + "_attack" };
                    } finally { loader.disposeObject(bundle.sourceRoot); }
                }).catch(error => { weaponActionLoads.delete(classId); throw error; });
                weaponActionLoads.set(classId, pending);
            }
            return weaponActionLoads.get(classId);
        },

        removeAction: function (name) {
            const key = String(name);
            const clip = clips.get(key);
            if (disposed || !clip) { return false; }
            const existing = mixer.existingAction(clip);
            if (existing) { existing.stop(); }
            mixer.uncacheClip(clip);
            clipIdentity.delete(key);
            if (actionName === key) {
                action = null;
                actionName = "";
                actor.faceAuto();
            }
            return clips.delete(key);
        },

        // Load an external GLB/GLB.GZ action pack and register every clip. URL
        // is resolved by the page, so game code can use an asset-relative path.
        loadActions: function (url, options) {
            if (disposed) { return Promise.resolve([]); }
            const config = options || {};
            return loader.readModelCached(url, config.compression, config.onProgress)
                .then(function (blob) { return disposed ? null : blob.arrayBuffer(); })
                .then(function (buffer) {
                    return buffer ? parseActionBundle(context.modules, buffer, config.meshopt) : null;
                })
                .then(function (gltf) {
                    if (!gltf) { return []; }
                    try {
                        if (disposed) { return []; }
                        const names = Array.isArray(config.names) ? config.names : [];
                        const loaded = [];
                        (gltf.animations || []).forEach(function (clip, index) {
                            const name = names[index] || clip.name;
                            if (actor.registerAction(name, clip, {
                                sourceRoot: config.retarget === false
                                    ? null : (config.sourceRoot || gltf.scene),
                                replace: config.replace === true
                            })) {
                                loaded.push(name);
                            }
                        });
                        return loaded;
                    } finally {
                        loader.disposeObject(gltf.scene);
                    }
                });
        },

        // Give the face back to the clip's own facial events.
        faceAuto: function () {
            if (disposed || !facialTable) { return false; }
            facialEventIndex = -1;
            blinkActive = false;
            faceFollowsAction = true;
            applyFace(restingFace(), true);
            faceFromClip();
            return true;
        },

        // Retire a pending candidate without changing the committed weapon.
        // The load still owns its resources and disposes them when it arrives.
        cancelEquip: function () {
            weaponRequest++;
            return actor;
        },

        // mode: "none" | "default" | "dedicated" | {resourceIdL, resourceIdR}
        equip: function (mode) {
            if (disposed) { return Promise.resolve(actor); }
            const request = ++weaponRequest;
            const ids = weaponIds(mode || "default");
            if (!ids.length) {
                if (mode && typeof mode === "object") { return Promise.reject(new Error("weapon has no model resources")); }
                clearWeapon();
                weaponResourceIds = [];
                return Promise.resolve(actor);
            }
            return Promise.all(ids.map(function (id) {
                return loader.load("model/weapon/wpn_" + id + ".muast", { kind: "weapon" })
                    .catch(function () { return null; });
            })).then(function (results) {
                if (disposed || request !== weaponRequest) {
                    results.filter(Boolean).forEach(function (result) { loader.disposeObject(result.scene); });
                    return actor;
                }
                if (results.some(result => !result)) {
                    results.filter(Boolean).forEach(result => loader.disposeObject(result.scene));
                    if (mode && typeof mode === "object") { throw new Error("weapon model unavailable: " + ids.join(",")); }
                    return actor;
                }
                clearWeapon();
                weaponResourceIds = ids.slice();
                const rigNodes = Array.from(hierarchyIndex(root).values());
                results.filter(Boolean).forEach(function (result) {
                    weaponSources.push(result.scene);
                    result.scene.children.slice().forEach(function (part) {
                        const match = WEAPON_SIDE.exec(part.name || "");
                        if (!match) {
                            return;
                        }
                        const side = match[1].toUpperCase();
                        const socket = rigNodes.find(function (node) {
                            return (node.userData.name || node.name) === "Loc_" + side;
                        }) || rigNodes.find(function (node) {
                            return (node.userData.name || node.name) === "Weapon_" + side;
                        }) || root.getObjectByName("Loc_" + side) || root.getObjectByName("Weapon_" + side);
                        if (!socket) {
                            return;
                        }
                        socket.add(part);
                        part.position.set(0, 0, 0);
                        part.rotation.set(0, 0, 0);
                        part.scale.setScalar(1);
                        part.visible = weaponVisible;
                        weaponParts.push(part);
                    });
                });
                return actor;
            });
        },

        // dt in seconds. Drives the mixer, the clip's facial events and the
        // blink timer together, because all three have to agree on one clock.
        update: function (dt) {
            if (disposed) { return actor; }
            const step = dt || 0;
            elapsed += step * 1000;
            mixer.update(step);
            if (fadingAction && mixer.time >= fadeUntil) {
                fadingAction.stop();
                fadingAction = null;
            }
            updateBlink(elapsed);
            if (action) { visibility.update(action.time); }
            return actor;
        },

        // A cinematic owns the clock; pose the active action without advancing it.
        seek: function (seconds) {
            if (disposed || !action) { return actor; }
            action.paused = true;
            action.time = Math.max(0, Math.min(action.getClip().duration, seconds));
            mixer.update(0);
            facialEventIndex = -1;
            faceFromClip();
            visibility.update(action.time);
            return actor;
        },

        setWeaponVisible: function (visible) {
            weaponVisible = !!visible;
            weaponParts.forEach(function (part) { part.visible = weaponVisible; });
        },

        facialId: function (id) {
            const index = stateForId(id, 0);
            return index >= 0 && actor.face(index);
        },

        dispose: function () {
            if (disposed) { return; }
            disposed = true;
            weaponRequest++;
            clearWeapon();
            mixer.stopAllAction();
            mixer.uncacheRoot(root);
            clips.clear();
            clipIdentity.clear();
            weaponActionLoads.clear();
            bindPositions.clear();
            action = null;
            actionName = "";
            if (root.parent) {
                root.parent.remove(root);
            }
            loader.disposeObject(root);
        }
    };

    if (facialTable && layerNodes.size) {
        applyFace(restingFace(), true);
    } else {
        // No table, or a table no layer matched: fall back to the resting
        // face implied by the layer names themselves.
        applyRestingFallback(root);
    }
    if (clips.has("idle")) {
        actor.play("idle", { fade: 0 });
    }
    return actor;
}

// A state is named only by the evidence the table records. The layer letters
// carry no meaning -- eye_C is a different eye on every character -- so an
// intrinsic tag wins over an action tag, and a bare number is the honest answer
// when the table records neither.
const FACE_LABELS = {
    "default": { zh: "通常", ja: "通常" },
    blink: { zh: "闭眼", ja: "まばたき" },
    abnormal: { zh: "异常状态", ja: "状態異常" },
    "action:win_st": { zh: "胜利", ja: "勝利" },
    "action:win_lp": { zh: "胜利", ja: "勝利" },
    "action:kirarajump": { zh: "跳跃", ja: "きらら跳躍" },
    "action:damage": { zh: "受击", ja: "被弾" },
    "action:dead": { zh: "倒下", ja: "戦闘不能" },
    "action:abnormal": { zh: "异常状态", ja: "状態異常" },
    "action:battle_in": { zh: "登场", ja: "登場" },
    "action:battle_out": { zh: "退场", ja: "退場" },
    "action:battle_run": { zh: "跑动", ja: "走行" },
    "action:room_idle_R": { zh: "待机", ja: "待機" }
};

export function faceTag(facialTable, index) {
    const tags = (facialTable && facialTable.tags && facialTable.tags[index]) || [];
    const intrinsic = ["default", "blink", "abnormal"];
    for (let i = 0; i < intrinsic.length; i++) {
        if (tags.indexOf(intrinsic[i]) >= 0) {
            return FACE_LABELS[intrinsic[i]];
        }
    }
    for (let i = 0; i < tags.length; i++) {
        if (FACE_LABELS[tags[i]]) {
            return FACE_LABELS[tags[i]];
        }
    }
    return { zh: "表情 " + (index + 1), ja: "表情 " + (index + 1) };
}

// --- emotion names ------------------------------------------------------
//
// A script wants to say `face: "sad"`, but the tables only tag four states and
// the original game addressed ADV faces by raw index. The letters are not a
// vocabulary either -- eye_C is a different eye on every character -- so a name
// cannot be mapped globally.
//
// What IS consistent across all 239 tables is the *composition* convention:
// the resting face is (eye_A, eyebrow_A, mouth_A), `cheek` is a blush, `cry` is
// tears, and a state departs from rest in the features the emotion needs. So
// emotions are scored by which features moved, which generalises to characters
// nobody has hand-checked.
//
// This is inference over unlabelled data, so it is a fallback: a character with
// a hand-picked map (asset/story/cast.js `faces`) uses that instead, and the
// score is only consulted for the rest.

// Layer names carry typos in the shipped data (`cheeck_A`, `eyebrrow_A`), so
// the group is matched loosely rather than by exact prefix.
function layerGroup(name) {
    const lower = String(name).toLowerCase();
    if (lower.indexOf("cry") === 0) { return "cry"; }
    if (lower.indexOf("cheek") === 0 || lower.indexOf("cheeck") === 0) { return "cheek"; }
    if (lower.indexOf("eyebr") === 0) { return "brow"; }
    if (lower.indexOf("eye") === 0) { return "eye"; }
    if (lower.indexOf("mouth") === 0) { return "mouth"; }
    return "other";
}

// "eye_C" -> "C", "eyebrow_C_2" -> "C" (the _2 suffix is a second mesh of the
// same layer, not a different expression).
function layerLetter(name) {
    const match = /_([A-Za-z])(?:_\d+)?$/.exec(String(name));
    return match ? match[1].toUpperCase() : "";
}

// Describe one state in terms of what moved away from rest.
function describeState(facialTable, index) {
    const state = (facialTable.states && facialTable.states[index]) || [];
    const shape = { eye: "", brow: "", mouth: "", cheek: false, cry: false };
    state.forEach(function (layerIndex) {
        const name = facialTable.layers[layerIndex];
        if (!name) { return; }
        const group = layerGroup(name);
        if (group === "cheek") { shape.cheek = true; return; }
        if (group === "cry") { shape.cry = true; return; }
        if (group === "eye" || group === "brow" || group === "mouth") {
            shape[group] = layerLetter(name);
        }
    });
    return shape;
}

// How well a state fits an emotion. Higher wins; a negative score disqualifies.
// Each rule reads as "the emotion needs these features to have moved".
const EMOTION_RULES = {
    // Talking with a neutral face: rest, but the mouth is open.
    talk: function (s) {
        return (s.eye === "A" ? 2 : 0) + (s.brow === "A" ? 2 : 0)
            + (s.mouth !== "A" && s.mouth ? 3 : -5) + (s.cheek ? -1 : 0) + (s.cry ? -9 : 0);
    },
    // Pleased: blush and/or an open mouth, brow still relaxed.
    smile: function (s) {
        return (s.cheek ? 3 : 0) + (s.brow === "A" ? 2 : -1)
            + (s.mouth !== "A" && s.mouth ? 2 : 0) + (s.cry ? -9 : 0);
    },
    // Excited is smile turned up: blush AND a changed eye AND an open mouth.
    excited: function (s) {
        return (s.cheek ? 3 : -1) + (s.eye !== "A" && s.eye ? 3 : 0)
            + (s.mouth !== "A" && s.mouth ? 2 : -3) + (s.brow === "A" ? 1 : 0)
            + (s.cry ? -9 : 0);
    },
    // Surprised: the eye changed and the mouth opened, but no blush and the
    // brow is not the troubled one -- that would be distress instead.
    surprised: function (s) {
        return (s.eye !== "A" && s.eye ? 3 : -4) + (s.mouth !== "A" && s.mouth ? 2 : 0)
            + (s.cheek ? -2 : 1) + (s.cry ? -9 : 0);
    },
    // Troubled: the brow moved, the mouth is not a grin, no blush.
    sad: function (s) {
        return (s.brow !== "A" && s.brow ? 3 : -4) + (s.cheek ? -2 : 1)
            + (s.eye === "A" ? 1 : 0) + (s.cry ? -3 : 0);
    },
    // Crying is unambiguous: the table has a dedicated `cry` layer.
    cry: function (s) {
        return s.cry ? 10 : -99;
    },
    // Serious: the brow moved but the eye and mouth stayed composed.
    serious: function (s) {
        return (s.brow !== "A" && s.brow ? 3 : -3) + (s.mouth === "A" ? 3 : 0)
            + (s.eye === "A" ? 1 : 0) + (s.cheek ? -2 : 0) + (s.cry ? -9 : 0);
    },
    // Angry: the brow moved AND the mouth is open, with no blush.
    //
    // Composition cannot really tell anger from worry -- both knit the brow --
    // so this leans on the other half of the picture. In all three hand-picked
    // cast maps the face that reads as anger has an open mouth (ランプ 6 and
    // きらら 7 are both mouth_F, アルシーヴ 2 is her tight-lipped 郑重 because she
    // does not raise her voice), while the sad face has a closed or small one.
    // So: same brow test as `sad`, opposite mouth test. That keeps angry,
    // sorrow and serious on three different states on most tables, which is the
    // point -- three names landing on one face makes a scene look flat.
    angry: function (s) {
        return (s.brow !== "A" && s.brow ? 3 : -4) + (s.mouth !== "A" && s.mouth ? 3 : -2)
            + (s.cheek ? -3 : 1) + (s.eye === "A" ? 1 : 0) + (s.cry ? -9 : 0);
    },
    // Vacant: the eye changed, nothing else did. This is the 呆 face -- and it
    // must not collide with blink, which is excluded before scoring.
    blank: function (s) {
        return (s.eye !== "A" && s.eye ? 3 : -4) + (s.brow === "A" ? 2 : -1)
            + (s.mouth === "A" ? 2 : 0) + (s.cheek ? -2 : 0) + (s.cry ? -9 : 0);
    }
};

// Names that are answered from the table's own tags rather than by scoring.
const INTRINSIC_EMOTIONS = { "default": "default", neutral: "default",
    blink: "blink", hurt: "abnormal", abnormal: "abnormal" };

// The game's own expression vocabulary, taken from how it names ADV face tiles:
// adv/standpic/<chara>/<Chara>_Face_0_{Default,Angry,Happy,Joy,Shy,Sorrow,
// Surprise,Unique1..3}.png. Scripts are written in these names, because they are
// the ones the original uses and every character has all ten.
//
// The 3D facial tables carry no such names, so each one is expressed in terms of
// the scoring rules below. The three `unique` slots have no scoring equivalent --
// a unique face is character-specific by definition -- so those resolve only
// through a hand-picked map in the cast table, or fall back.
export const GAME_EXPRESSIONS = ["default", "angry", "happy", "joy", "shy",
    "sorrow", "surprise", "unique1", "unique2", "unique3"];

const GAME_TO_RULE = {
    happy: "smile",
    joy: "excited",
    shy: "smile",        // 照れ: blush with a relaxed brow, which is what smile scores
    sorrow: "sad",
    surprise: "surprised"
};

// What to show when a name has no face on this particular model.
//
// Facial tables vary a lot: きらら's has 15 states with eyes, brows, mouth, blush
// and tears, while はるみねーしょん's has 14 states built from two eye variants and
// no brows at all -- there is no sorrow face on that model, and no amount of
// scoring will find one. Without a fallback, face("sorrow") returns false and
// leaves the previous expression pinned, which means a smile can sit through a
// sad line. Falling back to the nearest coarser face is wrong in a small way; a
// held smile is wrong in a way the player notices.
//
// Chains end at "default", which every table has by definition.
//
// Exported because the flat standpic renderer in core/advstage.js walks the same
// chain against the list of expression files a character actually has. Sharing
// the table is what keeps the two renderers agreeing on what a name means.
export const EMOTION_FALLBACK = {
    serious: "sorrow",
    joy: "happy", shy: "happy", happy: "talk",
    cry: "sorrow", sorrow: "blank",
    unique1: "happy", unique2: "sorrow", unique3: "surprise"
};

// How far down the ranking a modifier reaches. "smile-tired" is a weaker smile
// than "smile", and "smile-faint" weaker still, so they have to be different
// depths -- treating every modifier as "second best" made the two identical and
// きらら's smile stopped thinning out across the scene.
const EMOTION_MODIFIERS = { slight: 1, tired: 1, weak: 2, faint: 2, small: 1 };

// emotionIndex(facialTable, name) -> state index, or -1
//
// Accepts a raw index, an intrinsic name, a tag the table carries, an emotion
// name from EMOTION_RULES, or a hyphenated compound like "smile-tired", which
// is read as "smile, but not the strongest one" -- the second-best smile.
export function emotionIndex(facialTable, name) {
    if (!facialTable || !facialTable.states) {
        return -1;
    }
    if (typeof name === "number") {
        return name;
    }
    if (name === undefined || name === null) {
        return facialTable["default"];
    }
    const key = String(name).toLowerCase();

    if (INTRINSIC_EMOTIONS[key] !== undefined) {
        const intrinsic = facialTable[INTRINSIC_EMOTIONS[key]];
        return intrinsic === undefined ? -1 : intrinsic;
    }
    // An exact tag beats any inference.
    const tagged = (facialTable.tags || []).findIndex(function (tags) {
        return tags.indexOf(key) >= 0 || tags.indexOf("action:" + key) >= 0;
    });
    if (tagged >= 0) {
        return tagged;
    }

    // "smile-tired" / "smile-faint": same emotion, a weaker instance of it. The
    // script uses these because きらら smiles the whole prologue and the smile
    // is supposed to thin out; picking the runner-up gives a different face
    // without inventing a rule for "tired".
    const parts = key.split("-");
    // Scripts speak the game's vocabulary (`sorrow`, `surprise`, `joy`), so it is
    // translated into a scoring rule here rather than every script having to know
    // which names the 3D inference happens to understand. `angry` and `unique*`
    // have no rule on purpose -- they come from the cast table's map or not at all.
    const base = GAME_TO_RULE[parts[0]] || parts[0];
    const rule = EMOTION_RULES[base];
    if (!rule) {
        return -1;
    }
    let rank = 0;
    for (let i = 1; i < parts.length; i++) {
        rank += EMOTION_MODIFIERS[parts[i]] || 1;
    }

    const scored = [];
    for (let i = 0; i < facialTable.states.length; i++) {
        // blink is the eye-shut frame; offering it as an emotion would look
        // like the character fell asleep mid-line. abnormal is the pain face --
        // a script that wants distress asks for it by name, and letting the
        // scorer reach it made "surprised" render as agony.
        if (i === facialTable.blink || i === facialTable.abnormal) {
            continue;
        }
        const score = rule(describeState(facialTable, i));
        if (score > 0) {
            scored.push({ index: i, score: score });
        }
    }
    if (!scored.length) {
        return -1;
    }
    // Stable: equal scores resolve to the lower index, so a table's own order
    // decides and the same script renders the same way every run.
    scored.sort(function (a, b) { return b.score - a.score || a.index - b.index; });
    return scored[Math.min(rank, scored.length - 1)].index;
}

// resolveFace(facialTable, name, overrides) -> state index, or -1
//
// The whole lookup in one call: a hand-picked override first, then inference,
// then the fallback chain. A script asks for the expression the line needs and
// gets the closest thing this model can do, which is what lets the same script
// run on a 15-state table and a 14-state one.
export function resolveFace(facialTable, name, overrides) {
    let key = name;
    // Bounded by the chain, but guarded anyway: a bad edit to EMOTION_FALLBACK
    // should degrade to the resting face rather than hang the frame.
    for (let hop = 0; hop < 8; hop++) {
        // An override wins over inference: it comes from the cast table, where a
        // name has been checked by eye against the actual model.
        if (overrides && typeof key === "string" && overrides[key] !== undefined) {
            return overrides[key];
        }
        const index = emotionIndex(facialTable, key);
        if (index >= 0) {
            return index;
        }
        if (typeof key !== "string") {
            return -1;
        }
        // "happy-tired" with no happy at all falls back as plain "happy" would.
        const base = key.split("-")[0];
        const next = EMOTION_FALLBACK[base];
        if (!next) {
            return facialTable["default"] === undefined ? -1 : facialTable["default"];
        }
        key = next;
    }
    return facialTable["default"] === undefined ? -1 : facialTable["default"];
}

// Every emotion name the scorer understands, for a UI that wants to list them.
// The game's own names come first because those are the ones scripts should use.
export const EMOTIONS = GAME_EXPRESSIONS
    .filter(function (n) { return n === "default" || GAME_TO_RULE[n]; })
    .concat(Object.keys(EMOTION_RULES), ["blink", "abnormal"]);
