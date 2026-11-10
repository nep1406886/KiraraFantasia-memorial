import { MusicBus } from "../../core/music.js";

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
    1: { explore: "bgm_questselect",   battle: "bgm_battle_1",  boss: "bgm_battle_3",  bossLate: "bgm_battle_1",  rest: "bgm_town_2" },
    2: { explore: "bgm_questselect_2", battle: "bgm_battle_2",  boss: "bgm_battle_6",  bossLate: "bgm_battle_12", rest: "bgm_town_3" },
    3: { explore: "bgm_questselect_3", battle: "bgm_battle_5",  boss: "bgm_battle_10", bossLate: "bgm_battle_11", rest: "bgm_town_4" },
    4: { explore: "bgm_adv_7",         battle: "bgm_battle_9",  boss: "bgm_battle_11", bossLate: "bgm_battle_13", rest: "bgm_town_5" },
    5: { explore: "bgm_adv_13",        battle: "bgm_battle_12", boss: "bgm_battle_13", bossLate: "bgm_battle_9",  rest: "bgm_town_2" }
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
    const music = new MusicBus(cue => new URL(BGM_BASE_URL + cue + "_0.mp3", import.meta.url).href,
        error => console.warn("音乐播放暂时不可用：", error.message));
    return {
        play(scene, options = {}) {
            const cue = bgmTrackFor(scene, chapterVolume);
            if (!cue) return;
            if (options.volume !== undefined) music.setVolume(options.volume);
            return music.play(cue, { loop: scene !== "victory", fade: options.fadeIn ?? 800 });
        },
        stop: (options = {}) => music.stop(options.fadeOut ?? 700),
        setVolume: volume => music.setVolume(volume),
        duck: value => music.setVolume(music.volume, value),
        suspend: value => music.suspend(value),
        dispose: () => music.dispose(),
        getVolume: () => music.volume,
        isPlaying: () => !music.audio.paused,
        getCurrentTrack: () => music.track
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
