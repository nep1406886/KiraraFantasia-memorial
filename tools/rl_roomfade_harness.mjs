// T29 房间过渡：shadeFog HSL 亮度计算验收。
// 纯函数测试——不依赖 DOM 或 three.js。
import assert from "node:assert/strict";

// Extract the shadeFog function from main.js by reading the source and
// evaluating it in isolation. This avoids importing main.js (which needs
// a full browser environment).
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../site/game/rl/main.js", import.meta.url), "utf8");
const fnMatch = src.match(/function shadeFog\(hex, delta\)\s*\{([\s\S]*?)\n\}/);
assert.ok(fnMatch, "shadeFog function found in main.js");
const shadeFog = new Function("hex", "delta", fnMatch[1]);

let checks = 0;
function test(label, fn) { fn(); checks++; console.log("PASS " + label); }

// --- basic round-trip: delta=0 returns the same colour -----------------------
test("delta=0 returns the same hex", () => {
    assert.equal(shadeFog("#c9e6e4", 0), "#c9e6e4");
    assert.equal(shadeFog("#e8e0c8", 0), "#e8e0c8");
});

// --- lightening: +12 makes a mid-tone brighter --------------------------------
test("+12 lightens a mid-tone", () => {
    const result = shadeFog("#808080", 12);
    // #808080 is L=50%. +12 → L=62%. Result should be lighter.
    const r = parseInt(result.slice(1, 3), 16);
    assert.ok(r > 128, "lightened grey is lighter than #80: " + result);
});

// --- darkening: -12 makes a mid-tone darker ----------------------------------
test("-12 darkens a mid-tone", () => {
    const result = shadeFog("#808080", -12);
    const r = parseInt(result.slice(1, 3), 16);
    assert.ok(r < 128, "darkened grey is darker than #80: " + result);
});

// --- volume fog colours produce valid hex ------------------------------------
const VOLUME_FOGS = {
    1: "#c9e6e4", // 港町 mint
    2: "#e8e0c8", // 沙漠 sand
    3: "#b8d8b0", // 林边 green
    4: "#c0ccd8", // 机关 grey
    5: "#8a8aa8", // 神殿 night purple
};
test("all five volume fog colours produce valid hex after shading", () => {
    for (const [vol, fog] of Object.entries(VOLUME_FOGS)) {
        const light = shadeFog(fog, vol === "5" ? -12 : 12);
        assert.match(light, /^#[0-9a-f]{6}$/, "volume " + vol + " light: " + light);
        // The light colour must differ from the fog
        assert.notEqual(light, fog, "volume " + vol + " light differs from fog");
    }
});

// --- clamping: very light +12 stays in [0,255] --------------------------------
test("light clamping: #ffffff +12 stays valid", () => {
    const result = shadeFog("#ffffff", 12);
    assert.match(result, /^#[0-9a-f]{6}$/);
});

// --- clamping: very dark -12 stays in [0,255] --------------------------------
test("dark clamping: #000000 -12 stays valid", () => {
    const result = shadeFog("#000000", -12);
    assert.match(result, /^#[0-9a-f]{6}$/);
});

// --- night volume: -12 darkens the fog ---------------------------------------
test("night volume (5) fog is darkened by -12", () => {
    const fog = VOLUME_FOGS[5]; // #8a8aa8
    const dark = shadeFog(fog, -12);
    // Parse both and compare luminance
    const lum = hex => {
        const r = parseInt(hex.slice(1, 3), 16),
              g = parseInt(hex.slice(3, 5), 16),
              b = parseInt(hex.slice(5, 7), 16);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    assert.ok(lum(dark) < lum(fog), "night fog darkened: " + dark + " < " + fog);
});

// --- day volume: +12 lightens the fog ----------------------------------------
test("day volume (1) fog is lightened by +12", () => {
    const fog = VOLUME_FOGS[1]; // #c9e6e4
    const light = shadeFog(fog, 12);
    const lum = hex => {
        const r = parseInt(hex.slice(1, 3), 16),
              g = parseInt(hex.slice(3, 5), 16),
              b = parseInt(hex.slice(5, 7), 16);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    assert.ok(lum(light) > lum(fog), "day fog lightened: " + light + " > " + fog);
});

// --- non-hex input passes through --------------------------------------------
test("non-hex input passes through unchanged", () => {
    assert.equal(shadeFog("var(--kf-sky)", 12), "var(--kf-sky)");
    assert.equal(shadeFog("", 12), "");
    assert.equal(shadeFog(null, 12), "");
});

console.log("Room fade shade: " + checks + " checks passed.");
process.exitCode = 0;
