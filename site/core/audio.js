// BGM, voice and sound-effect playback for the fan-game layer.
//
// Browsers block audio until the first gesture, so nothing here starts until
// unlock() has been called from a click handler. Games should call it from
// their start button.
import { MusicBus } from "./music.js";

const BGM_ROOT = "../audio/bgm/";
const VOICE_ROOT = "../audio/gacha/";
const SE_ROOT = "../audio/se/";

let unlocked = false;
let music = null;
let bgmVolume = 0.55;
let voiceVolume = 1;
let seVolume = 0.7;
const voices = new Set();

export function unlock() {
    unlocked = true;
}

export function isUnlocked() {
    return unlocked;
}

// Keep the original API while sharing the games' bounded music lifecycle.
export function bgm(track, options) {
    if (!unlocked) return;
    const { fade = 900, loop = true } = options || {};
    if (!track) return stopBgm(fade);
    if (!music) {
        music = new MusicBus(name => BGM_ROOT + name + ".mp3");
        music.setVolume(bgmVolume);
    }
    return music.play(track, { fade, loop });
}

export function stopBgm(fade = 600) {
    music?.stop(fade);
}

export function setBgmVolume(value) {
    bgmVolume = Math.max(0, Math.min(1, value));
    music?.setVolume(bgmVolume);
}

// Fire-and-forget voice clip. Path is relative to audio/gacha/.
export function voice(file) {
    if (!unlocked || !file) {
        return null;
    }
    const element = new Audio(VOICE_ROOT + file);
    element.volume = voiceVolume;
    voices.add(element);
    element.addEventListener("ended", function () { voices.delete(element); });
    const play = element.play();
    if (play && play.catch) {
        play.catch(function () { voices.delete(element); });
    }
    return element;
}

export function stopVoices() {
    voices.forEach(function (element) {
        element.pause();
        element.src = "";
    });
    voices.clear();
}

export function setVoiceVolume(value) {
    voiceVolume = Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// Sound effects
//
// No original SE banks are bundled locally, so missing cues are synthesised.
//
// Files still win when present: drop an mp3 into audio/se/ named after the cue
// and it plays instead of the synth. That keeps the door open without blocking
// on it.
//
// One noise buffer and a compressed output bus. Short-lived sources are bounded
// and disconnected on completion, so crowded fights cannot grow the audio graph.

let audioContext = null;
let seBus = null;
let noiseBuffer = null;
let seSuspended = false;
const seSources = new Set();
const seClips = new Set();
const lastCue = new Map();
const seFiles = new Map();     // cue -> loaded HTMLAudioElement
const seAvailable = new Set(); // cues with a real file, per registerSeFiles()
const seProbing = new Set();   // cue -> load in flight, don't start a second

function context() {
    if (!audioContext) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) { return null; }
        try {
            audioContext = new Ctor();
            seBus = audioContext.createGain();
            seBus.gain.value = seVolume;
            const compressor = audioContext.createDynamicsCompressor();
            compressor.threshold.value = -18;
            compressor.knee.value = 12;
            compressor.ratio.value = 5;
            compressor.attack.value = .003;
            compressor.release.value = .16;
            seBus.connect(compressor).connect(audioContext.destination);
        } catch (error) {
            return null;
        }
    }
    // Autoplay policy can leave a context created before the gesture suspended.
    // resume() rejects on some states rather than no-opping, and a sound effect
    // must never be able to break the scene that asked for it.
    if (audioContext.state === "suspended") {
        try {
            const resumed = audioContext.resume();
            if (resumed && resumed.catch) { resumed.catch(function () {}); }
        } catch (error) { /* not resumable; the graph below still renders */ }
    }
    return audioContext;
}

// Short noise burst: footsteps, cloth, paper, impacts.
function noiseBurst(ctx, when, opts) {
    if (seSources.size >= 48) return;
    const duration = opts.duration;
    if (!noiseBuffer) {
        noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.type || "lowpass";
    filter.frequency.value = opts.frequency;
    filter.Q.value = opts.q === undefined ? 1 : opts.q;
    if (opts.sweepTo) {
        filter.frequency.setValueAtTime(opts.frequency, when);
        filter.frequency.exponentialRampToValueAtTime(opts.sweepTo, when + duration);
    }

    const gain = ctx.createGain();
    // exponentialRamp cannot reach 0, hence the small floor.
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(opts.gain, when + (opts.attack || 0.004));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);

    source.connect(filter).connect(gain).connect(seBus);
    releaseOnEnd(source, [filter, gain]);
    source.start(when, Math.random());
    source.stop(when + duration);
}

// Pitched blip: UI clicks, chimes, sparkles.
function tone(ctx, when, opts) {
    if (seSources.size >= 48) return;
    const duration = opts.duration;
    const osc = ctx.createOscillator();
    osc.type = opts.wave || "sine";
    osc.frequency.setValueAtTime(opts.frequency, when);
    if (opts.glideTo) {
        osc.frequency.exponentialRampToValueAtTime(opts.glideTo, when + duration);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(opts.gain, when + (opts.attack || 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain).connect(seBus);
    releaseOnEnd(osc, [gain]);
    osc.start(when);
    osc.stop(when + duration);
}

function releaseOnEnd(source, nodes) {
    seSources.add(source);
    source.onended = () => {
        source.disconnect();
        nodes.forEach(node => node.disconnect());
        seSources.delete(source);
    };
}

export function suspendSe(value) {
    seSuspended = value;
    if (!value) return;
    for (const source of seSources) { try { source.stop(); } catch {} }
    for (const clip of seClips) clip.pause();
    seClips.clear(); lastCue.clear();
}

// Cue recipes. Keyed by the names scripts already use; RECIPES is also the list
// of cues a script may ask for, so an unknown name is a caught mistake rather
// than silence.
const RECIPES = {
    // A run-up before an entrance: six quick steps, alternating weight so it
    // reads as a person rather than a metronome, easing as they arrive.
    // Gains here look large next to the tonal cues, and have to be: a lowpass at
    // 300Hz discards most of a white-noise burst's energy, so a nominal 0.5
    // lands near 0.05 in the render. Measured, not guessed -- see the peak
    // figures in the commit that added these.
    footstep_run: function (ctx, at, level) {
        const steps = 6;
        for (let i = 0; i < steps; i++) {
            const when = at + i * 0.115 + (i % 2 ? 0.012 : 0);
            noiseBurst(ctx, when, {
                duration: 0.075,
                frequency: i % 2 ? 340 : 300,
                sweepTo: 130,
                gain: level * (2.6 - i * 0.23),
                q: 0.9
            });
        }
    },
    footstep: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: 0.085, frequency: 320, sweepTo: 130, gain: level * 2.4, q: 0.9 });
    },
    // Paper, not a slam: high band, fast decay, a little grit.
    page_turn: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: 0.16, frequency: 1800, sweepTo: 4200, gain: level * 0.3, type: "bandpass", q: 0.7 });
        noiseBurst(ctx, at + 0.055, { duration: 0.1, frequency: 2600, sweepTo: 1400, gain: level * 0.2, type: "bandpass", q: 0.8 });
    },
    // 聖典 losing a page -- the story's own sound. Airy, upward, unresolved.
    page_fade: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: 0.9, frequency: 900, sweepTo: 5000, gain: level * 0.16, type: "bandpass", q: 0.5 });
        tone(ctx, at + 0.05, { frequency: 1320, glideTo: 2640, duration: 0.8, gain: level * 0.05, wave: "sine" });
    },
    ui_confirm: function (ctx, at, level) {
        tone(ctx, at, { frequency: 880, duration: 0.09, gain: level * 0.16 });
        tone(ctx, at + 0.06, { frequency: 1320, duration: 0.12, gain: level * 0.13 });
    },
    ui_cancel: function (ctx, at, level) {
        tone(ctx, at, { frequency: 440, glideTo: 300, duration: 0.14, gain: level * 0.15, wave: "triangle" });
    },
    ui_click: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: 0.03, frequency: 2400, gain: level * 0.7, type: "bandpass", q: 1.4 });
    },
    // Chapter title / reveal: a struck bell, two partials and a soft noise wash.
    chime: function (ctx, at, level) {
        tone(ctx, at, { frequency: 1046, duration: 1.1, gain: level * 0.14 });
        tone(ctx, at + 0.01, { frequency: 1568, duration: 0.85, gain: level * 0.07 });
        noiseBurst(ctx, at, { duration: 0.2, frequency: 3000, gain: level * 0.05, type: "bandpass", q: 0.6 });
    },
    // Scene change / camera move.
    whoosh: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: 0.42, frequency: 240, sweepTo: 1800, gain: level * 1.1, type: "bandpass", q: 0.8, attack: 0.12 });
    },
    magic: function (ctx, at, level) {
        for (let i = 0; i < 5; i++) {
            tone(ctx, at + i * 0.045, {
                frequency: 660 * Math.pow(1.26, i),
                duration: 0.3,
                gain: level * 0.09,
                wave: "triangle"
            });
        }
        noiseBurst(ctx, at, { duration: 0.5, frequency: 1200, sweepTo: 4800, gain: level * 0.12, type: "bandpass", q: 0.6, attack: 0.08 });
    },
    // とっておき activation.
    special: function (ctx, at, level) {
        tone(ctx, at, { frequency: 220, glideTo: 1760, duration: 0.55, gain: level * 0.16, wave: "sawtooth" });
        noiseBurst(ctx, at + 0.4, { duration: 0.7, frequency: 2000, sweepTo: 6000, gain: level * 0.2, type: "bandpass", q: 0.5, attack: 0.03 });
        tone(ctx, at + 0.45, { frequency: 1046, duration: 0.9, gain: level * 0.12 });
    },
    // The sidestep: a short rising whip of air, then a softer tail as the
    // foot plants. Snappier than whoosh -- this is the player's own body
    // moving, not the camera.
    dodge: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: 0.13, frequency: 1500, sweepTo: 4200, gain: level * 0.55, type: "bandpass", q: 0.8 });
        noiseBurst(ctx, at + 0.09, { duration: 0.08, frequency: 2200, sweepTo: 1200, gain: level * 0.22, type: "bandpass", q: 0.9 });
    },
    // A door unlocking and swinging open: the bolt's low thunk first, then
    // the hinge swells over a slow attack. The open-door moment is the
    // roomClear beat, not the crossing -- crossing keeps its page_fade.
    door: function (ctx, at, level) {
        tone(ctx, at, { frequency: 130, glideTo: 65, duration: 0.18, gain: level * 0.4, wave: "square" });
        noiseBurst(ctx, at + 0.1, { duration: 0.5, frequency: 500, sweepTo: 1600, gain: level * 1.4, q: 0.9, attack: 0.18 });
    },
    // Death as the story tells it (spec/05 §5): a page folding closed, not
    // a scream. Two soft descending tones over a low wash, resolving down.
    defeat: function (ctx, at, level) {
        tone(ctx, at, { frequency: 660, glideTo: 440, duration: 0.5, gain: level * 0.12, wave: "triangle" });
        tone(ctx, at + 0.28, { frequency: 440, glideTo: 220, duration: 0.7, gain: level * 0.12, wave: "triangle" });
        noiseBurst(ctx, at + 0.2, { duration: 0.8, frequency: 1200, sweepTo: 300, gain: level * 0.18, type: "bandpass", q: 0.6, attack: 0.1 });
    },
    // Level up: a bright square-wave fanfare, three quick notes and a held
    // fourth. Square and rhythmic on purpose -- magic's triangles are the
    // spell; this is the number going up.
    levelup: function (ctx, at, level) {
        const arp = [523, 659, 784];
        for (let i = 0; i < arp.length; i++) {
            tone(ctx, at + i * 0.09, { frequency: arp[i], duration: 0.12, gain: level * 0.1, wave: "square" });
        }
        tone(ctx, at + 0.27, { frequency: 1046, duration: 0.45, gain: level * 0.12, wave: "square" });
        noiseBurst(ctx, at + 0.27, { duration: 0.35, frequency: 4000, gain: level * 0.06, type: "bandpass", q: 0.5 });
    },
    // A resisted hit (いまいち) as a deflection ping over the duller thud.
    // The original's guard is a turn command (BattleCommandParser.cs isGuard
    // → GuardCoef) with no action-game equivalent, so the cue lands on the
    // closest moment: the enemy's affinity turning the blow aside.
    guard: function (ctx, at, level) {
        tone(ctx, at, { frequency: 1980, glideTo: 1400, duration: 0.14, gain: level * 0.12, wave: "triangle" });
        noiseBurst(ctx, at, { duration: 0.05, frequency: 3000, gain: level * 0.35, type: "bandpass", q: 2.2 });
    },
    // 防卫战提示音，分为瞬态、主体与特征三层；最终音量由压缩总线控制。
    plant: function (ctx, at, level) {
        // 种植：两段落土——先软土（闷、慢），再一颗短促的定根「噗」。
        noiseBurst(ctx, at, { duration: 0.07, frequency: 900, sweepTo: 200, gain: level * 0.8, q: 0.6 });
        noiseBurst(ctx, at + 0.06, { duration: 0.11, frequency: 320, sweepTo: 100, gain: level * 1.4, q: 0.9 });
        tone(ctx, at + 0.05, { frequency: 140, glideTo: 70, duration: 0.14, gain: level * 0.5, wave: 'triangle' });
    },
    shovel: function (ctx, at, level) {
        // 铲除：挥铲的掠风（高频带扫上去）+铲头入土的低顿。
        noiseBurst(ctx, at, { duration: 0.09, frequency: 700, sweepTo: 2600, gain: level * 1.1, type: 'bandpass', q: 0.7 });
        noiseBurst(ctx, at + 0.1, { duration: 0.13, frequency: 380, sweepTo: 90, gain: level * 1.5, q: 1 });
        tone(ctx, at + 0.1, { frequency: 120, glideTo: 60, duration: 0.12, gain: level * 0.4, wave: 'triangle' });
    },
    gear: function (ctx, at, level) {
        // 佩戴：金属「叮」两连，第二声更高更轻，像卡扣落位。
        tone(ctx, at, { frequency: 1245, duration: 0.09, gain: level * 0.4, wave: 'triangle' });
        noiseBurst(ctx, at, { duration: 0.04, frequency: 5200, gain: level * 0.5, type: 'highpass', q: 1 });
        tone(ctx, at + 0.07, { frequency: 1865, duration: 0.14, gain: level * 0.28, wave: 'triangle' });
    },
    gate: function (ctx, at, level) {
        // 结界被烧穿：低频爆裂 + 长衰减，像玻璃被砸碎后的轰响。
        noiseBurst(ctx, at, { duration: 0.18, frequency: 1400, sweepTo: 300, gain: level * 1.2, q: 0.8 });
        tone(ctx, at, { frequency: 130, glideTo: 45, duration: 0.7, gain: level * 0.6, wave: 'triangle' });
        noiseBurst(ctx, at + 0.04, { duration: 0.5, frequency: 500, sweepTo: 80, gain: level * 1.1, q: 0.7 });
    },
    hit: function (ctx, at, level) {
        // 击中敌人：短「啪」——高频瞬态 + 低频冲击，攻击手感的核心。
        noiseBurst(ctx, at, { duration: 0.045, frequency: 3600, sweepTo: 1400, gain: level * 0.9, type: 'bandpass', q: 0.7 });
        tone(ctx, at, { frequency: 190, glideTo: 90, duration: 0.07, gain: level * 0.55, wave: 'triangle' });
    },
    swing: function (ctx, at, level) {
        // 挥击破空：窄带噪声快速下扫，刀风不是风声。
        noiseBurst(ctx, at, { duration: 0.1, frequency: 2200, sweepTo: 500, gain: level * 1.2, type: 'bandpass', q: 1.4 });
    },
    crit: function (ctx, at, level) {
        // 会心：比普通击中多一层高频铃 + 更重的低频，一耳朵分辨。
        noiseBurst(ctx, at, { duration: 0.05, frequency: 5200, sweepTo: 2200, gain: level * 0.8, type: 'bandpass', q: 0.6 });
        tone(ctx, at, { frequency: 240, glideTo: 70, duration: 0.12, gain: level * 0.7, wave: 'triangle' });
        tone(ctx, at + 0.01, { frequency: 1319, duration: 0.12, gain: level * 0.16, wave: 'sine' });
    },
    shoot_fire: function (ctx, at, level) {
        // 炎弹：吐息感的嘶声 + 低频推力。
        noiseBurst(ctx, at, { duration: 0.14, frequency: 2400, sweepTo: 700, gain: level * 0.9, type: 'bandpass', q: 0.8 });
        tone(ctx, at, { frequency: 220, glideTo: 110, duration: 0.1, gain: level * 0.3, wave: 'sawtooth' });
    },
    shoot_water: function (ctx, at, level) {
        // 水弹：闷泡——低频扫 + 短水花带。
        tone(ctx, at, { frequency: 420, glideTo: 160, duration: 0.13, gain: level * 0.4, wave: 'sine' });
        noiseBurst(ctx, at + 0.02, { duration: 0.1, frequency: 1100, sweepTo: 500, gain: level * 0.7, q: 0.8 });
    },
    shoot_earth: function (ctx, at, level) {
        // 土弹：石块磨出的糙声 + 短促低顿。
        noiseBurst(ctx, at, { duration: 0.09, frequency: 800, sweepTo: 240, gain: level * 1.3, q: 1.1 });
        tone(ctx, at + 0.04, { frequency: 110, glideTo: 55, duration: 0.09, gain: level * 0.5, wave: 'triangle' });
    },
    shoot_wind: function (ctx, at, level) {
        // 风刃：利落的窄带掠声，频率比挥击更高、更快。
        noiseBurst(ctx, at, { duration: 0.12, frequency: 3200, sweepTo: 900, gain: level * 0.8, type: 'bandpass', q: 1.8 });
    },
    shoot_moon: function (ctx, at, level) {
        // 月弹：冷感——高频正弦叮 + 尾随暗哑下扫。
        tone(ctx, at, { frequency: 1568, glideTo: 1175, duration: 0.11, gain: level * 0.3, wave: 'sine' });
        noiseBurst(ctx, at + 0.02, { duration: 0.12, frequency: 1800, sweepTo: 600, gain: level * 0.5, type: 'bandpass', q: 1.2 });
    },
    shoot_sun: function (ctx, at, level) {
        // 阳弹：亮泽双音上行，暖。
        tone(ctx, at, { frequency: 660, glideTo: 990, duration: 0.1, gain: level * 0.3, wave: 'sine' });
        tone(ctx, at + 0.03, { frequency: 1320, glideTo: 1980, duration: 0.09, gain: level * 0.2, wave: 'sine' });
    },
    shoot_wave: function (ctx, at, level) {
        // 贯穿波（周期必杀的越障波）：低频轰鸣横扫，比普攻弹重得多。
        tone(ctx, at, { frequency: 300, glideTo: 90, duration: 0.35, gain: level * 0.6, wave: 'sawtooth' });
        noiseBurst(ctx, at, { duration: 0.3, frequency: 1600, sweepTo: 300, gain: level * 0.9, type: 'bandpass', q: 0.9 });
    },
    death: function (ctx, at, level) {
        // Dissolve into light: no vocal/formant sweep on every defeated enemy.
        noiseBurst(ctx, at, { duration: .16, frequency: 2600, sweepTo: 1100, gain: level * .35, type: 'highpass', q: .6 });
        tone(ctx, at + .025, { frequency: 1760, duration: .13, gain: level * .1, wave: 'sine' });
    },
    enemy_rally: function (ctx, at, level) {
        // A two-beat signal for the pack's haste, deliberately non-vocal.
        [0, .14].forEach(delay => {
            noiseBurst(ctx, at + delay, { duration: .12, frequency: 460, sweepTo: 180, gain: level * .7, q: .6 });
            tone(ctx, at + delay, { frequency: 110, duration: .12, gain: level * .25, wave: 'sine' });
        });
    },
    enemy_roar: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: .38, frequency: 300, sweepTo: 100, gain: level * .8, q: .55 });
        tone(ctx, at, { frequency: 65, duration: .3, gain: level * .25, wave: 'sine' });
    },
    enemy_shot: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: .09, frequency: 1600, sweepTo: 650, gain: level * .65, type: 'bandpass', q: .7 });
        tone(ctx, at, { frequency: 540, duration: .06, gain: level * .12, wave: 'sine' });
    },
    enemy_swipe: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: .09, frequency: 1000, sweepTo: 380, gain: level * .65, type: 'bandpass', q: .6 });
    },
    pickup: function (ctx, at, level) {
        // 收取クリエ：清脆双音上行「叮铃」，PVZ 收阳光的爽感。
        tone(ctx, at, { frequency: 987, duration: 0.07, gain: level * 0.3, wave: 'sine' });
        tone(ctx, at + 0.05, { frequency: 1318, duration: 0.1, gain: level * 0.25, wave: 'sine' });
    },
    boss_phase: function (ctx, at, level) {
        tone(ctx, at, { frequency: 98, glideTo: 49, duration: 0.5, gain: level * 0.34, wave: "sine" });
        noiseBurst(ctx, at, { duration: 0.3, frequency: 180, sweepTo: 60, gain: level * 0.5, q: 1.0 });
        tone(ctx, at + 0.32, { frequency: 587, duration: 0.5, gain: level * 0.11, wave: "triangle" });
        tone(ctx, at + 0.44, { frequency: 880, duration: 0.7, gain: level * 0.09, wave: "triangle" });
    }
};

export const SE_CUES = Object.keys(RECIPES);

// Fire a sound effect by cue name. Silent before unlock(), and silent (with a
// console warning) for an unknown cue -- a missing sound should never be able to
// stop a scene.
export function se(name, options) {
    if (!unlocked || !name || seSuspended) { return; }
    const opts = options || {};
    const level = opts.volume === undefined ? 1 : opts.volume;
    if (level <= 0 || seVolume <= 0) { return; }
    const now = performance.now();
    if (now - (lastCue.get(name) ?? -Infinity) < 55) return;
    lastCue.set(name, now);

    // A real recording beats the synth, but only one the manifest vouches for --
    // probing blindly would mean a 404 per cue on a site that ships no SE files
    // at all, which is the normal case.
    if (seAvailable.has(name)) {
        const known = seFiles.get(name);
        if (known) {
            if (seClips.size >= 12) return;
            const clip = known.cloneNode();
            clip.volume = Math.min(1, level * seVolume);
            seClips.add(clip);
            clip.addEventListener("ended", () => seClips.delete(clip), { once: true });
            clip.addEventListener("error", () => seClips.delete(clip), { once: true });
            const play = clip.play();
            if (play && play.catch) { play.catch(() => seClips.delete(clip)); }
            return;
        }
        loadFile(name);
        // Fall through to the synth: this call should not be silent while the
        // file is still in flight.
    }

    const recipe = RECIPES[name];
    if (!recipe) {
        console.warn("audio.se: unknown cue \"" + name + "\"");
        return;
    }
    const ctx = context();
    if (!ctx) { return; }
    recipe(ctx, ctx.currentTime + 0.01, Math.min(1, level));
}

function loadFile(name) {
    if (seProbing.has(name)) { return; }
    seProbing.add(name);
    const element = new Audio(SE_ROOT + name + ".mp3");
    element.addEventListener("canplaythrough", function () {
        seProbing.delete(name);
        seFiles.set(name, element);
    });
    element.addEventListener("error", function () {
        // Listed but unloadable: stop trying and let the synth cover it.
        seProbing.delete(name);
        seAvailable.delete(name);
    });
    element.load();
}

// Declare which cues have real recordings in audio/se/. Call once at startup,
// e.g. from a fetch of audio/se/index.json. Unlisted cues synthesise, so this is
// optional -- it exists so real audio can be dropped in later without touching
// any script.
export function registerSeFiles(names) {
    seAvailable.clear();
    seFiles.clear();
    (names || []).forEach(function (name) { seAvailable.add(name); });
}

export function setSeVolume(value) {
    seVolume = Math.max(0, Math.min(1, value));
    if (seBus) seBus.gain.setTargetAtTime(seVolume, audioContext.currentTime, .015);
    if (!seVolume) { for (const clip of seClips) clip.pause(); seClips.clear(); }
}

export function getSeVolume() {
    return seVolume;
}

// Track names present in audio/bgm/, grouped for scene selection.
export const TRACKS = {
    prologue: "bgm_Prologue_0",
    town: ["bgm_town_1_0", "bgm_town_2_0", "bgm_town_3_0", "bgm_town_4_0", "bgm_town_5_0"],
    townSeasonal: { newYear: "bgm_town_shougatu_0", christmas: "bgm_town_xmas_0" },
    battle: [
        "bgm_battle_1_0", "bgm_battle_2_0", "bgm_battle_3_0", "bgm_battle_4_0",
        "bgm_battle_5_0", "bgm_battle_6_0", "bgm_battle_7_0", "bgm_battle_8_0",
        "bgm_battle_9_0", "bgm_battle_10_0", "bgm_battle_11_0", "bgm_battle_12_0",
        "bgm_battle_13_0"
    ],
    battleWin: "bgm_battle_win_0",
    questSelect: ["bgm_questselect_0", "bgm_questselect_2_0", "bgm_questselect_3_0"],
    // Class victory themes, indexed to match cards.CLASSES.
    classTheme: [
        "bgm_5_fighter_0", "bgm_5_magician_0", "bgm_5_priest_0",
        "bgm_5_knight_0", "bgm_5_alchemist_0"
    ]
};
