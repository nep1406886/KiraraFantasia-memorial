// Bilingual text for the fan-game layer.
//
// Every line of script carries both `ja` and `zh`. Nothing is machine
// translated at runtime. Voice is always Japanese (the official assets only
// ship Japanese), so in `both` mode the Japanese line matches the audio and
// the Chinese line reads as a subtitle.

const STORAGE_KEY = "kirafan-fangame:lang";
const MODES = ["zh", "ja", "both"];

// `both` by default: this game is bilingual by design, and the Japanese line is
// what the voice is speaking, so showing only one language hides half of what was
// authored. A reader who wants one language picks it once and it is remembered.
let mode = "both";
const listeners = new Set();

try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && MODES.indexOf(stored) !== -1) {
        mode = stored;
    }
} catch (error) {
    // Private browsing throws on localStorage access; the default is fine.
}

export function getMode() {
    return mode;
}

export function setMode(next) {
    if (MODES.indexOf(next) === -1) {
        throw new Error("unknown language mode: " + next);
    }
    mode = next;
    try {
        window.localStorage.setItem(STORAGE_KEY, next);
    } catch (error) {
        // Non-fatal.
    }
    listeners.forEach(function (listener) { listener(mode); });
}

export function onChange(listener) {
    listeners.add(listener);
    return function () { listeners.delete(listener); };
}

// Resolve a bilingual object to what should be displayed.
// Returns { primary, secondary } -- secondary is null unless in `both` mode.
export function resolve(entry) {
    if (!entry) {
        return { primary: "", secondary: null };
    }
    if (typeof entry === "string") {
        return { primary: entry, secondary: null };
    }
    if (mode === "ja") {
        return { primary: entry.ja || entry.zh || "", secondary: null };
    }
    if (mode === "both") {
        // Japanese on top so it lines up with the voice, Chinese below as subtitle.
        return { primary: entry.ja || "", secondary: entry.zh || "" };
    }
    return { primary: entry.zh || entry.ja || "", secondary: null };
}

// Flatten to a single string, for places with no room for two lines.
export function text(entry) {
    const parts = resolve(entry);
    return parts.secondary ? parts.primary + " / " + parts.secondary : parts.primary;
}

export const UI = {
    langLabel: { ja: "言語", zh: "语言" },
    modeZh: { ja: "中国語のみ", zh: "只显示中文" },
    modeJa: { ja: "日本語のみ", zh: "只显示日文" },
    modeBoth: { ja: "日中併記", zh: "日中对照" },
    auto: { ja: "オート", zh: "自动播放" },
    skip: { ja: "スキップ", zh: "跳过" },
    back: { ja: "もどる", zh: "返回" },
    loading: { ja: "読み込み中……", zh: "载入中……" }
};
