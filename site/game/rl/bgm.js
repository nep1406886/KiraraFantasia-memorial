// BGM System for Roguelike Mode
// Task 4.1: Background music with scene-based switching
//
// Architecture:
// - Local mp3s under audio/bgm/ (mirrored from the CRI GitLab Pages archive;
//   runtime must not hotlink CDN hosts -- the harness greps fail on a hit and
//   the gate env has no proxy)
// - HTML5 Audio API with loop and crossfade
// - Scene-based track selection: menu, explore, battle, boss, victory
// - Volume control with fade in/out transitions

/**
 * BGM track registry
 * Maps scene types to BGM cue names (without _0 suffix)
 */
const BGM_TRACKS = {
    menu: "bgm_town_1",           // Roster selection / menu
    explore: "bgm_questselect",   // Dungeon exploration
    battle: "bgm_battle_1",       // Combat rooms
    boss: "bgm_battle_13",        // Boss fight (usually most intense)
    victory: "bgm_battle_win",    // Victory fanfare
    prologue: "bgm_Prologue",     // Intro sequence
    shop: "bgm_gachaplay",        // Shop rooms (spec/04 §10)
    rest: "bgm_town_2"            // Rest rooms — calm campfire beat
};

// 游玩说明 §七 promises "BGM 原作 69 首，按卷/场景切换". Each 卷 carries its own
// explore/battle/boss/rest cue, escalating through the original's track numbers
// so later volumes read as later chapters: questselect screens for the early
// light-hearted volumes, adv chapter ambience for the later ones, and the
// battle series stepping up to battle_13 at the final boss. shop/menu/victory/
// prologue stay global — they are identity cues (gacha jingle, home, fanfare)
// and repeating them is the point. The seasonal tracks (xmas/shougatsu) and
// the class-5 set stay reserved for event/class hooks, not run-of-the-mill
// rooms, so they are deliberately absent here.
const VOLUME_TRACKS = {
    1: { explore: "bgm_questselect",   battle: "bgm_battle_1",  boss: "bgm_battle_3",  rest: "bgm_town_2" },
    2: { explore: "bgm_questselect_2", battle: "bgm_battle_2",  boss: "bgm_battle_6",  rest: "bgm_town_3" },
    3: { explore: "bgm_questselect_3", battle: "bgm_battle_5",  boss: "bgm_battle_10", rest: "bgm_town_4" },
    4: { explore: "bgm_adv_7",         battle: "bgm_battle_9",  boss: "bgm_battle_11", rest: "bgm_town_5" },
    5: { explore: "bgm_adv_13",        battle: "bgm_battle_12", boss: "bgm_battle_13", rest: "bgm_town_2" }
};

// The 卷 the run is in (main.js calls this once the ?volume= param is read).
// Module-level rather than a play() argument so every existing playBGM call
// site gets volume-qualified tracks without each one threading the index.
let chapterVolume = 1;

/**
 * Which chapter (卷) the run is in; 1-5, out-of-range values clamp.
 */
export function setBGMChapter(volumeIndex) {
    const n = parseInt(volumeIndex, 10);
    chapterVolume = Math.min(5, Math.max(1, isNaN(n) ? 1 : n));
    return chapterVolume;
}

/**
 * Resolve a scene to its cue for a given 卷 (pure, exported for the harness):
 * the per-volume table wins, the global registry is the fallback.
 */
export function bgmTrackFor(scene, volumeIndex) {
    const per = VOLUME_TRACKS[volumeIndex];
    return (per && per[scene]) || BGM_TRACKS[scene];
}

/**
 * BGM base path, relative to game/roguelike.html (same convention as the
 * voice playback in main.js: "../../audio/voice/..."). Files are named
 * bgm_<name>_0.mp3.
 */
const BGM_BASE_URL = "../../audio/bgm/";

/**
 * BGM manager instance
 */
let bgmManager = null;

/**
 * Create BGM manager
 * @returns {Object} BGM manager with play/stop/setVolume methods
 */
export function createBGMManager() {
    const audio = new Audio();
    audio.loop = true;
    audio.volume = 0.5; // Default 50%

    let currentTrack = null;
    let targetVolume = 0.5;
    let fadeInterval = null;

    /**
     * Build BGM URL from cue name
     * @param {string} cueName - Track name from BGM_TRACKS
     * @returns {string} Full URL to mp3 file
     */
    function buildURL(cueName) {
        // Resolve against this module, not the page: Audio src alone escapes a
        // /kirafan-timer/ deployment subpath (the page sits two levels deep).
        return new URL(BGM_BASE_URL + cueName + "_0.mp3", import.meta.url).href;
    }

    /**
     * Fade audio volume gradually
     * @param {number} from - Start volume (0-1)
     * @param {number} to - Target volume (0-1)
     * @param {number} duration - Fade duration in ms
     * @param {Function} onComplete - Callback when fade completes
     */
    function fade(from, to, duration, onComplete) {
        if (fadeInterval) {
            clearInterval(fadeInterval);
        }

        const steps = 20;
        const stepDuration = duration / steps;
        const volumeStep = (to - from) / steps;
        let currentStep = 0;

        audio.volume = from;

        fadeInterval = setInterval(function() {
            currentStep++;
            audio.volume = Math.max(0, Math.min(1, from + volumeStep * currentStep));

            if (currentStep >= steps) {
                clearInterval(fadeInterval);
                fadeInterval = null;
                audio.volume = to;
                if (onComplete) {
                    onComplete();
                }
            }
        }, stepDuration);
    }

    /**
     * Play BGM track by scene name
     * @param {string} scene - Scene name from BGM_TRACKS keys
     * @param {Object} options - { fadeIn: ms, volume: 0-1 }
     */
    function play(scene, options) {
        options = options || {};
        const fadeInDuration = options.fadeIn !== undefined ? options.fadeIn : 1000;
        const volume = options.volume !== undefined ? options.volume : targetVolume;

        const trackName = bgmTrackFor(scene, chapterVolume);
        if (!trackName) {
            console.warn("BGM: Unknown scene", scene);
            return;
        }

        // Same track already playing
        if (currentTrack === trackName && !audio.paused) {
            return;
        }

        currentTrack = trackName;
        const url = buildURL(trackName);

        // Fade out current, then switch
        if (!audio.paused) {
            fade(audio.volume, 0, 500, function() {
                audio.src = url;
                audio.load();
                audio.play().then(function() {
                    fade(0, volume, fadeInDuration);
                }).catch(function(err) {
                    console.warn("BGM play failed:", err);
                });
            });
        } else {
            // No current track, start directly
            audio.src = url;
            audio.volume = 0;
            audio.load();
            audio.play().then(function() {
                fade(0, volume, fadeInDuration);
            }).catch(function(err) {
                console.warn("BGM play failed:", err);
            });
        }
    }

    /**
     * Stop BGM with fade out
     * @param {Object} options - { fadeOut: ms }
     */
    function stop(options) {
        options = options || {};
        const fadeOutDuration = options.fadeOut !== undefined ? options.fadeOut : 1000;

        if (audio.paused) {
            return;
        }

        fade(audio.volume, 0, fadeOutDuration, function() {
            audio.pause();
            currentTrack = null;
        });
    }

    /**
     * Set target volume (affects next play and current track)
     * @param {number} volume - Volume 0-1
     */
    function setVolume(volume) {
        targetVolume = Math.max(0, Math.min(1, volume));
        if (!audio.paused) {
            fade(audio.volume, targetVolume, 300);
        }
    }

    /**
     * Get current volume
     * @returns {number} Volume 0-1
     */
    function getVolume() {
        return targetVolume;
    }

    /**
     * Check if BGM is playing
     * @returns {boolean}
     */
    function isPlaying() {
        return !audio.paused;
    }

    /**
     * Get current track name
     * @returns {string|null}
     */
    function getCurrentTrack() {
        return currentTrack;
    }

    return {
        play: play,
        stop: stop,
        setVolume: setVolume,
        getVolume: getVolume,
        isPlaying: isPlaying,
        getCurrentTrack: getCurrentTrack
    };
}

/**
 * Initialize BGM system
 * Call once on game start
 */
export function initBGM() {
    if (bgmManager) {
        return bgmManager;
    }
    bgmManager = createBGMManager();
    return bgmManager;
}

/**
 * Get BGM manager instance
 * @returns {Object|null}
 */
export function getBGM() {
    return bgmManager;
}

/**
 * Play BGM by scene name
 * Convenience wrapper for getBGM().play()
 * @param {string} scene - Scene name (menu/explore/battle/boss/victory)
 * @param {Object} options - Play options
 */
export function playBGM(scene, options) {
    if (!bgmManager) {
        console.warn("BGM not initialized, call initBGM() first");
        return;
    }
    bgmManager.play(scene, options);
}

/**
 * Stop BGM
 * Convenience wrapper for getBGM().stop()
 * @param {Object} options - Stop options
 */
export function stopBGM(options) {
    if (!bgmManager) {
        return;
    }
    bgmManager.stop(options);
}
