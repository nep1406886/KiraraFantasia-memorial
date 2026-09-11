// BGM, voice and sound-effect playback for the fan-game layer.
//
// Browsers block audio until the first gesture, so nothing here starts until
// unlock() has been called from a click handler. Games should call it from
// their start button.

const BGM_ROOT = "../audio/bgm/";
const VOICE_ROOT = "../audio/gacha/";
const SE_ROOT = "../audio/se/";

let unlocked = false;
let current = null;
let currentTrack = null;
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

function fadeTo(element, target, duration, onDone) {
    if (duration <= 0) {
        element.volume = target;
        if (onDone) { onDone(); }
        return;
    }
    const start = element.volume;
    const startedAt = performance.now();
    function step(now) {
        // Clamped at both ends. The floor is not paranoia: the timestamp rAF
        // passes in is the frame's start time, which can predate the
        // performance.now() taken just above it, making the first `progress`
        // slightly negative. `volume` is a throwing setter, so an out-of-range
        // value is not a quiet glitch -- it raises IndexSizeError, and since this
        // runs inside the script's promise chain the whole chapter stops on a
        // fade-in that was a fraction of a millisecond early.
        const progress = Math.max(0, Math.min(1, (now - startedAt) / duration));
        element.volume = Math.max(0, Math.min(1, start + (target - start) * progress));
        if (progress < 1) {
            requestAnimationFrame(step);
        } else if (onDone) {
            onDone();
        }
    }
    requestAnimationFrame(step);
}

// Play a BGM track by manifest name, e.g. "bgm_battle_12_0".
// Re-requesting the playing track is a no-op, so scenes can declare their
// track without worrying about restarting it.
export function bgm(track, options) {
    const opts = options || {};
    const fade = opts.fade === undefined ? 900 : opts.fade;
    if (!unlocked) {
        currentTrack = track;
        return;
    }
    if (currentTrack === track && current && !current.paused) {
        return;
    }
    currentTrack = track;
    const previous = current;
    if (previous) {
        fadeTo(previous, 0, fade, function () {
            previous.pause();
            previous.src = "";
        });
    }
    if (!track) {
        current = null;
        return;
    }
    const element = new Audio(BGM_ROOT + track + ".mp3");
    element.loop = opts.loop !== false;
    element.volume = 0;
    current = element;
    const play = element.play();
    if (play && play.catch) {
        play.catch(function () { /* interrupted by a newer request */ });
    }
    fadeTo(element, bgmVolume, fade);
}

export function stopBgm(fade) {
    bgm(null, { fade: fade === undefined ? 600 : fade });
}

export function setBgmVolume(value) {
    bgmVolume = Math.max(0, Math.min(1, value));
    if (current) {
        current.volume = bgmVolume;
    }
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
// The game's own SE are unreachable: they shipped as CRIWARE ACB banks on
// asset-krr-prd.star-api.com, which is gone with the service, and the surviving
// community mirror carries only asset bundles -- which hold no audio objects at
// all. So there is nothing to decode, and a cue like "footstep_run" has to be
// produced rather than loaded.
//
// Files still win when present: drop an mp3 into audio/se/ named after the cue
// and it plays instead of the synth. That keeps the door open without blocking
// on it.
//
// Synthesis is WebAudio, built per call and left to be collected. Nodes are
// cheap; a pool would only add bookkeeping, and overlapping SE is normal (a
// footstep sequence over a page turn), so shared elements would cut each other
// off the way a single Audio element does.

let audioContext = null;
const seFiles = new Map();     // cue -> loaded HTMLAudioElement
const seAvailable = new Set(); // cues with a real file, per registerSeFiles()
const seProbing = new Set();   // cue -> load in flight, don't start a second

function context() {
    if (!audioContext) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) { return null; }
        try {
            audioContext = new Ctor();
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
    const duration = opts.duration;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;

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

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(when);
    source.stop(when + duration);
}

// Pitched blip: UI clicks, chimes, sparkles.
function tone(ctx, when, opts) {
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
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + duration);
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
    // Battle: a hit that lands, and a magical one that blooms.
    hit: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: 0.12, frequency: 220, sweepTo: 80, gain: level * 0.5, q: 1.1 });
        tone(ctx, at, { frequency: 150, glideTo: 60, duration: 0.1, gain: level * 0.25, wave: "square" });
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
    // A crit's accent on top of the hit thud: a tight metallic snap with a
    // tone that pierces upward. Replaces the borrowed chime (plan §2.3).
    crit: function (ctx, at, level) {
        noiseBurst(ctx, at, { duration: 0.07, frequency: 3800, gain: level * 0.5, type: "bandpass", q: 1.6 });
        tone(ctx, at + 0.01, { frequency: 1568, glideTo: 2349, duration: 0.16, gain: level * 0.12 });
    },
    // Loot into the bag: three quick ascending sines and a glint of air.
    pickup: function (ctx, at, level) {
        for (let i = 0; i < 3; i++) {
            tone(ctx, at + i * 0.045, { frequency: 1320 * Math.pow(1.25, i), duration: 0.14, gain: level * 0.1 });
        }
        noiseBurst(ctx, at, { duration: 0.12, frequency: 6000, gain: level * 0.05, type: "highpass" });
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
    death: function (ctx, at, level) {
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
    }
};

export const SE_CUES = Object.keys(RECIPES);

// Fire a sound effect by cue name. Silent before unlock(), and silent (with a
// console warning) for an unknown cue -- a missing sound should never be able to
// stop a scene.
export function se(name, options) {
    if (!unlocked || !name) { return; }
    const opts = options || {};
    const level = seVolume * (opts.volume === undefined ? 1 : opts.volume);
    if (level <= 0) { return; }

    // A real recording beats the synth, but only one the manifest vouches for --
    // probing blindly would mean a 404 per cue on a site that ships no SE files
    // at all, which is the normal case.
    if (seAvailable.has(name)) {
        const known = seFiles.get(name);
        if (known) {
            const clip = known.cloneNode();
            clip.volume = Math.min(1, level);
            const play = clip.play();
            if (play && play.catch) { play.catch(function () {}); }
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
