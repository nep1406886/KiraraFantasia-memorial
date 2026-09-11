// Shared original-game cinematic presentation. Combat never runs here.
import * as us from "./uniqueskill.js";
import { createEmitters } from "./usparticle.js";
import "../asset/battle/uniqueskill.js";
export * from "./uniqueskill.js";

let voicesPromise = null;
let playbackPromise = null;
export function loadPlaybackIndex() {
    if (!playbackPromise) {
        playbackPromise = fetch(new URL("../asset/battle/skill-playback.json", import.meta.url))
            .then(function (r) { if (!r.ok) { throw new Error("skill playback " + r.status); } return r.json(); })
            .catch(function (error) { playbackPromise = null; throw error; });
    }
    return playbackPromise;
}
export function loadVoices() {
    if (!voicesPromise) {
        voicesPromise = fetch(new URL("../asset/rl/voices.json", import.meta.url))
            .then(function (r) { if (!r.ok) { throw new Error("voices " + r.status); } return r.json(); })
            .catch(function () { voicesPromise = null; return {}; });
    }
    return voicesPromise;
}

export function createStage(options) {
    const { THREE, timeline, root, object } = options;
    const scene = options.scene || new THREE.Scene();
    if (!options.scene) {
        scene.background = new THREE.Color(0x111111);
        scene.add(new THREE.AmbientLight(0xffffff, 2));
    }
    scene.add(root);
    if (object) { root.add(object); }
    const meta = timeline.camera || {};
    const aspect = meta.apertureWidth && meta.apertureHeight
        ? meta.apertureWidth / meta.apertureHeight : 1.5;
    const size = (meta.orthoSize || 177) / (meta.orthoDivisor || 354);
    const camera = new THREE.OrthographicCamera(-size * aspect, size * aspect,
        size, -size, meta.near || 0.1, meta.far || 200);
    const particles = createEmitters({ THREE, root });
    const audio = us.sceneAudio(options.resourceId);
    const voiceRows = options.voices || {};
    const voiceRow = voiceRows[options.resourceId] || Object.values(voiceRows).find(function (row) {
        return audio && audio.voice && row.sheet === audio.voice.sheet;
    });
    const playingAudio = new Set();
    let disposed = false;
    function stopAudio() {
        playingAudio.forEach(function (clip) { clip.pause(); clip.removeAttribute("src"); clip.load(); });
        playingAudio.clear();
    }
    const player = us.createPlayer({
        THREE, timeline, root, camera, aspect, audio,
        onEvent: options.onEvent,
        onState: options.onState || options.onEvent,
        onSeek: function () {
            stopAudio();
            if (particles) { particles.reset(); }
            if (options.onReset) { options.onReset(); }
        },
        onEmitter: function (index, active) {
            if (particles) { particles.setActive(index, active); }
        },
        onVoice: function (cue) {
            const file = voiceRow && voiceRow.cues[cue.cue];
            if (!file || disposed) { return; }
            const clip = new Audio(new URL("../audio/voice/" + file, import.meta.url).href);
            playingAudio.add(clip);
            clip.addEventListener("ended", function () { playingAudio.delete(clip); }, { once: true });
            clip.play().catch(function () { playingAudio.delete(clip); });
        }
    });
    function sampleActor() {
        if (options.sampleActor) { options.sampleActor(player.frame / player.fps); }
    }
    const stage = {
        root, scene, camera, player, timeline, particles, aspect,
        get frame() { return player.frame; },
        get finished() { return player.finished; },
        seek: function (frame) { player.seek(frame); sampleActor(); return stage; },
        play: function () { player.play(); return stage; },
        pause: function () { player.pause(); stopAudio(); return stage; },
        update: function (dt) {
            // Particles and events sample the same small steps even when a
            // browser stalls or a test advances more than one display frame.
            let remaining = Math.max(0, Math.min(0.25, dt || 0));
            while (!disposed && player.playing && remaining > 1e-9) {
                const step = Math.min(1 / player.fps, remaining);
                player.update(step);
                sampleActor();
                if (particles) { particles.update(step); }
                remaining -= step;
            }
            return !player.finished;
        },
        render: function (renderer) {
            const size = renderer.getSize(new THREE.Vector2());
            const oldViewport = renderer.getViewport(new THREE.Vector4());
            const oldScissor = renderer.getScissor(new THREE.Vector4());
            const oldTest = renderer.getScissorTest();
            const oldClear = renderer.getClearColor(new THREE.Color());
            const oldAlpha = renderer.getClearAlpha();
            const width = Math.min(size.x, size.y * aspect);
            const height = width / aspect;
            renderer.setScissorTest(false);
            renderer.setViewport(0, 0, size.x, size.y);
            renderer.setClearColor(0x111111, 1);
            renderer.clear();
            renderer.setViewport((size.x - width) / 2, (size.y - height) / 2, width, height);
            renderer.setScissor((size.x - width) / 2, (size.y - height) / 2, width, height);
            renderer.setScissorTest(true);
            renderer.render(scene, camera);
            renderer.setScissorTest(oldTest);
            renderer.setViewport(oldViewport);
            renderer.setScissor(oldScissor);
            renderer.setClearColor(oldClear, oldAlpha);
        },
        dispose: function () {
            if (disposed) { return; }
            disposed = true;
            player.pause();
            stopAudio();
            if (object && object.parent === root) { root.remove(object); }
            if (particles) { particles.dispose(); }
            us.disposeScene(root, THREE);
        }
    };
    return stage;
}
