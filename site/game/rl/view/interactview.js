// T22g 交互丰富: the view layer for the room interactables — the treasure
// chest (the treasure-mimic model, doors mesh-swapped like enemyview's
// POSTURE corpse swap), the breakable barrels and the 祭坛 event point (live
// kit-card clones), and the campfire NPC's actor.
//
// mapview merges its static props into one mesh per texture atlas, so
// anything the player can change during play (open, shatter, pick up) has to
// live out here as its own object. The chest's model is model_en_14202, the
// original's own treasure-mimic: it ships no animations, but its door and
// contents are separate meshes, so "open" is a visibility swap. The original
// scene's hidden-mesh list (msbVisible) actually hides the CLOSED doors —
// the shipped default is the open chest — so both states are authored here
// from the mesh names rather than inherited from the GLB.
//
// Barrels still use quest-map cards. The shrine instead uses verified original
// RoomObjectList furniture, owned separately from the static map candidates.

import * as loader from "../../../core/loader.js";
import { cloneMapCard, PROP_SCALE } from "./mapview.js";
import { createBlobShadow } from "./blobshadow.js";
import { LAYER, applyLayer, CHARACTER_SCALE } from "./layers.js";
import { characterTiltX } from "./tilt.js";
import { applyModelRules, createMirrorSideManager } from "./modelrules.js";
import { createPropArrangement } from "./roomprops.js";

const CHEST_MODEL = "model/enemy/model_en_14202.muast";
// The mimic is enemy-model-sized (≈1.5 units tall after CHARACTER_SCALE);
// as room furniture it reads best a notch smaller than the cast.
const CHEST_SCALE = 1.4;
const CHEST_DOORS_CLOSED = ["door_close_L_obj", "door_close_R_obj"];
const CHEST_DOORS_OPEN = ["door_open_L_obj", "door_open_R_obj"];
const CHEST_CONTENTS = [
    "crystal_1_obj", "crystal_2_obj", "bottle_obj", "fossil_obj",
    "drawer_1_obj", "drawer_2_obj", "drawer_3_obj"
];
// partly-open is a third door state the game never shows; the variant eyes
// are damage/abnormal faces the chest has no HP bar for.
const CHEST_HIDDEN_ALWAYS = [
    "door_partly_open_L_obj", "door_partly_open_R_obj",
    "eye_abnormal_obj", "eye_damage_obj"
];

const BARREL_CARDS = ["barrel_0", "barrel_1", "barrel_2"];

function setMeshes(root, names, visible) {
    root.traverse(function (child) {
        if (child.isMesh && names.indexOf(child.name) !== -1) {
            child.visible = visible;
        }
    });
}

// The chest. `chest` is the world's roomState record ({x, y, opened}).
export function attachChestView(chest, scene) {
    return loader.load(CHEST_MODEL, { kind: "enemy" }).then(function (loaded) {
        return loader.loadModules().then(function (modules) {
            const THREE = modules.THREE;
            const root = loaded.scene;
            scene.add(root);
            applyLayer(root, LAYER.enemy, false);
            root.scale.setScalar(CHEST_SCALE);
            root.position.set(chest.x, 0, chest.y);
            const shadow = createBlobShadow(THREE, scene, 0.6);
            shadow.sync(chest.x, chest.y, 0);

            function applyState(opened) {
                setMeshes(root, CHEST_DOORS_CLOSED, !opened);
                setMeshes(root, CHEST_DOORS_OPEN, opened);
                setMeshes(root, CHEST_CONTENTS, opened);
                setMeshes(root, CHEST_HIDDEN_ALWAYS, false);
            }
            applyState(!!chest.opened);

            return {
                object: root,
                open: function () { applyState(true); },
                dispose: function () {
                    scene.remove(root);
                    shadow.dispose();
                    loader.disposeObject(root);
                }
            };
        });
    });
}

// The barrels. Only intact barrels get a view — a shattered one is absent,
// which is exactly what a re-entry after leaving the room should show.
export function attachBarrelViews(barrels, scene) {
    return loader.loadModules().then(function (modules) {
        const THREE = modules.THREE;
        return Promise.allSettled(barrels.map(function (barrel, index) {
            return cloneMapCard(BARREL_CARDS[index % BARREL_CARDS.length])
                .then(function (card) {
                    const clone = card.unit.template.clone(true);
                    clone.position.set(barrel.x, 0, barrel.y);
                    clone.scale.setScalar(PROP_SCALE);
                    clone.traverse(function (child) {
                        child.userData.sharedGeometry = true;
                    });
                    applyLayer(clone, LAYER.enemy, false);
                    scene.add(clone);
                    const shadow = createBlobShadow(THREE, scene, 0.45);
                    shadow.sync(barrel.x, barrel.y, 0);
                    return {
                        object: clone,
                        barrel: barrel,
                        break: function () {
                            scene.remove(clone);
                            shadow.dispose();
                        }
                    };
                });
        })).then(results => {
            const views = results.filter(row => row.status === 'fulfilled').map(row => row.value);
            const failure = results.find(row => row.status === 'rejected');
            if (failure) { views.forEach(view => view.break()); throw failure.reason; }
            return views;
        });
    });
}

// A small ritual composition, not the old green quest-map tile. The statue,
// book and lanterns retain their native layers; only placement is adapted.
export async function attachAltarView(altar, scene) {
    const { THREE } = await loader.loadModules();
    const arrangement = await createPropArrangement(THREE, [
        { key: 'goods_1147', x: altar.x, y: altar.y - .5, height: 2.1, maxWidth: 1.8 },
        { key: 'goods_1072', x: altar.x - .94, y: altar.y + .12, height: .64, maxWidth: .55 },
        { key: 'goods_1072', x: altar.x + .94, y: altar.y + .12, height: .64, maxWidth: .55 },
        { key: 'goods_1083', x: altar.x, y: altar.y + .42, height: .8, maxWidth: .85 }
    ]);
    arrangement.root.name = 'native-shrine';
    scene.add(arrangement.root);
    const shadow = createBlobShadow(THREE, scene, .8);
    shadow.sync(altar.x, altar.y, 0);
    let disposed = false;
    function update(dt) {
        arrangement.update(dt);
        arrangement.props[3].root.visible = !altar.used;
    }
    update(0);
    return { object: arrangement.root, altar, update,
        dispose() { if (disposed) return; disposed = true; arrangement.dispose(); shadow.dispose(); } };
}

// The campfire guest: a full actor (same loader path as the player) posed
// idle by the fire. `npc` is the roomState record ({x, y, talked}); the
// caller owns the actor because building one needs the gacha card.
export function attachNpcView(npc, actor, scene) {
    return loader.loadModules().then(function (modules) {
        const THREE = modules.THREE;
        const root = actor.object;
        loader.loadModules().then(function (modules) {
            applyModelRules(root, modules.THREE, { kind: "player" });
            createMirrorSideManager(THREE).sync(root, false);
        });
        scene.add(root);
        applyLayer(root, LAYER.enemy, false);
        root.scale.setScalar(CHARACTER_SCALE);
        root.position.set(npc.x, 0, npc.y);
        // T22m billboard tilt: the guest is the same front-on paper stack as
        // the player — lean it back by the live camera pitch (view/tilt.js).
        root.rotation.x = characterTiltX();
        const shadow = createBlobShadow(THREE, scene, 0.55 * CHARACTER_SCALE);
        shadow.sync(npc.x, npc.y, 0);
        return {
            object: root,
            actor: actor,
            update: function (dt) {
                actor.update(dt || 0);
                root.rotation.x = characterTiltX();
            },
            dispose: function () {
                scene.remove(root);
                shadow.dispose();
                actor.dispose();
            }
        };
    });
}
