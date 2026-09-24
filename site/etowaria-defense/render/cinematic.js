import * as actorFactory from "../../core/actor.js";
import * as skill from "../../core/skillstage.js";
import { createEmitters } from "../../core/usparticle.js";
import { installModelRenderOrder } from "../../core/model-render-order.js";
import { applyAuthoredMaterials } from "./native-model.js";

export async function createCinematic(assets, unit, audio) {
    const { THREE } = assets;
    const playback = assets.playback[String(unit.cardId)];
    if (!playback?.ultimate?.action || !unit.ultimateScene) { throw new Error(`${unit.name} 的原必杀绑定不完整`); }
    const timeline = await skill.loadTimeline(playback.ultimate.sceneId);
    const results = await Promise.allSettled([
        skill.loadSceneEntry(unit.ultimateScene),
        actorFactory.create({ resourceId: unit.resourceId, classId: unit.classId,
            headId: unit.headId, skillId: unit.resourceId, weapon: "default", stageMotion: true })
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) {
        if (results[0].status === "fulfilled") { skill.disposeScene(results[0].value.scene, THREE); }
        if (results[1].status === "fulfilled") { results[1].value.dispose(); }
        throw failure.reason;
    }
    const loaded = results[0].value;
    const actor = results[1].value;
    applyAuthoredMaterials(actor.object, THREE, assets.anisotropy);
    if (!actor.play(playback.ultimate.action, { loop: false, fade: 0 })) {
        skill.disposeScene(loaded.scene, THREE);
        actor.dispose();
        throw new Error(`${unit.name} 缺少必杀动作 ${playback.ultimate.action}`);
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x171d25);
    const root = loaded.scene;
    scene.add(root);
    root.add(actor.object);
    const meta = timeline.camera || {};
    const aspect = meta.apertureWidth && meta.apertureHeight ? meta.apertureWidth / meta.apertureHeight : 1.5;
    const size = (meta.orthoSize || 177) / (meta.orthoDivisor || 354);
    const camera = new THREE.OrthographicCamera(-size * aspect, size * aspect, size, -size, meta.near || 0.1, meta.far || 200);
    const particles = createEmitters({ THREE, root });
    const applyState = event => {
        if (event.event === "weaponVisible") { actor.setWeaponVisible(Boolean(event.args[0])); }
    };
    const player = skill.createPlayer({ THREE, timeline, root, camera, aspect,
        audio: skill.sceneAudio(unit.resourceId), onEvent: applyState, onState: applyState,
        onEmitter: (index, active) => particles?.setActive(index, active),
        onVoice: cue => audio.playVoice(unit.voice, cue.cue) });
    let disposed = false;
    let removeSort;
    player.seek(0);
    actor.seek(0);
    player.play();
    audio.beginCinematic();
    return {
        unit, scene, camera, player, timeline,
        get finished() { return player.finished; },
        get weaponVisible() { return actor.weaponParts.some(part => part.visible); },
        update(dt) {
            if (disposed) { return; }
            let remaining = Math.min(dt, 0.15);
            while (remaining > 1e-8 && !player.finished) {
                const step = Math.min(1 / (timeline.fps || 30), remaining);
                player.update(step);
                actor.seek(player.frame / player.fps);
                particles?.update(step);
                remaining -= step;
            }
        },
        render(renderer) {
            if (!removeSort) { removeSort = installModelRenderOrder(renderer, scene, THREE); }
            const renderSize = renderer.getSize(new THREE.Vector2());
            const width = Math.min(renderSize.x, renderSize.y * aspect);
            const height = width / aspect;
            renderer.setScissorTest(false);
            renderer.setViewport(0, 0, renderSize.x, renderSize.y);
            renderer.setClearColor(0x171d25, 1);
            renderer.clear();
            renderer.setViewport((renderSize.x - width) / 2, (renderSize.y - height) / 2, width, height);
            renderer.setScissor((renderSize.x - width) / 2, (renderSize.y - height) / 2, width, height);
            renderer.setScissorTest(true);
            renderer.render(scene, camera);
            renderer.setScissorTest(false);
            renderer.setViewport(0, 0, renderSize.x, renderSize.y);
            renderer.setClearColor(0x000000, 0);
        },
        dispose() {
            if (disposed) { return; }
            disposed = true;
            player.pause();
            removeSort?.();
            particles?.dispose();
            actor.object.removeFromParent();
            actor.dispose();
            skill.disposeScene(root, THREE);
            audio.endCinematic();
        }
    };
}
