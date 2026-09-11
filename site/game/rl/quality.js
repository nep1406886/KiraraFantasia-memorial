// T29 画质档位 (spec/08 §5): presentation-only render budget tiers. The >=2x
// character-restoration scheme stays the default (high). A tier changes only
// the render pixel ratio and view-layer particle spawn rates; world logic,
// hit ranges and the fixed step never read these values.
// 阴影 remains a documented gap: the stage ships no shadow pass yet.
export const QUALITY_LEVELS = ["high", "balanced", "performance"];

export const quality = {
    level: "high",
    pixelRatio: 2,
    trailRate: 18
};

export function normalizeQuality(value) {
    return QUALITY_LEVELS.includes(value) ? value : "high";
}

export function applyQuality(level, devicePixelRatio) {
    const dpr = Math.max(1, Number(devicePixelRatio) || 1);
    quality.level = normalizeQuality(level);
    if (quality.level === "high") {
        quality.pixelRatio = Math.min(Math.max(2, dpr), 3);
        quality.trailRate = 18;
    } else if (quality.level === "balanced") {
        quality.pixelRatio = Math.min(Math.max(1.5, dpr), 2);
        quality.trailRate = 12;
    } else {
        quality.pixelRatio = Math.min(dpr, 1);
        quality.trailRate = 6;
    }
    return quality;
}
