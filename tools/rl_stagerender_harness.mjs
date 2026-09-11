import assert from "node:assert/strict";
import { renderStage } from "../site/game/rl/view/stagerender.js";

function fixture(failPass = -1) {
    const world = { visible: true, userData: {} };
    const player = { visible: true, userData: {} };
    const effect = { visible: true, userData: { rlOverlay: true } };
    const hidden = { visible: false, userData: { rlOverlay: true } };
    const light = { visible: true, isLight: true, userData: {} };
    const scene = { children: [world, player, effect, hidden, light], background: {} };
    player.parent = scene;
    const draws = [], clears = [];
    const renderer = {
        autoClear: true,
        info: { autoReset: true, calls: 0, reset() { this.calls = 0; } },
        render(s) {
            draws.push(s.children.map(n => n.visible));
            this.info.calls++;
            if (draws.length === failPass) { throw new Error("render fault"); }
        },
        clearDepth() { clears.push(draws.length); }
    };
    return { world, player, effect, hidden, light, scene, renderer, draws, clears };
}

const f = fixture(), bg = f.scene.background;
renderStage(f.renderer, f.scene, {}, f.player);
assert.deepEqual(f.draws, [[true, false, false, false, true],
    [false, true, false, false, true], [false, false, true, false, true]]);
assert.deepEqual(f.clears, [1, 2]);
assert.equal(f.renderer.info.calls, 3);
assert.deepEqual(f.scene.children.map(n => n.visible), [true, true, true, false, true]);
assert.equal(f.scene.background, bg);
assert.equal(f.renderer.autoClear, true);
assert.equal(f.renderer.info.autoReset, true);
console.log("PASS separate world/player/effect passes preserve state and cumulative diagnostics");

for (const failPass of [1, 2, 3]) {
    const x = fixture(failPass), background = x.scene.background;
    assert.throws(() => renderStage(x.renderer, x.scene, {}, x.player), /render fault/);
    assert.deepEqual(x.scene.children.map(n => n.visible), [true, true, true, false, true]);
    assert.equal(x.scene.background, background);
    assert.equal(x.renderer.autoClear, true);
    assert.equal(x.renderer.info.autoReset, true);
}
console.log("PASS each partial render failure restores visibility and renderer ownership");

for (const absent of [null, { visible: true, parent: null }]) {
    const x = fixture(); renderStage(x.renderer, x.scene, {}, absent);
    assert.equal(x.draws.length, 1); assert.equal(x.clears.length, 0);
}
const empty = fixture(); empty.effect.visible = false;
renderStage(empty.renderer, empty.scene, {}, empty.player);
assert.equal(empty.draws.length, 2);
console.log("PASS no player/overlay does not add an unnecessary pass");
