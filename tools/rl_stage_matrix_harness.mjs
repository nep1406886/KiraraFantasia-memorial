// Real Three matrices, renderer's documented automatic-update contract, no GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderStage } from '../site/game/rl/view/stagerender.js';
const THREE = await import('data:text/javascript;base64,' + readFileSync(
    new URL('../site/vendor/three/three.core.min.js', import.meta.url)).toString('base64'));
let failures = 0;
function check(name, action) {
    try { action(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
}
function fixture({ automatic = true, failPass = 0, local = true } = {}) {
    const scene = new THREE.Scene(), world = new THREE.Group(), player = new THREE.Group();
    const body = new THREE.Group(), overlay = new THREE.Group(), hidden = new THREE.Group();
    player.add(body); player.position.set(24, .12, 18); body.position.set(.25, 1.1, .5);
    world.position.set(10, 0, 12); overlay.position.set(25, 1, 18);
    overlay.userData.rlOverlay = true; hidden.visible = false;
    for (let i = 0; i < 40; i++) world.add(new THREE.Group());
    scene.add(world, player, overlay, hidden);
    scene.background = new THREE.Color('#c9e6e4');
    const camera = new THREE.OrthographicCamera(-8, 8, 6, -6, .1, 100);
    camera.position.set(24, 9, 24.5); camera.lookAt(24, 0, 18);
    const localCamera = local ? new THREE.Camera() : null;
    scene.updateMatrixWorld(); camera.updateMatrixWorld();
    scene.matrixWorldAutoUpdate = automatic;
    let sceneUpdates = 0, worldUpdates = 0, playerUpdates = 0;
    const sceneUpdate = scene.updateMatrixWorld, worldUpdate = world.updateMatrixWorld;
    const playerUpdate = player.updateMatrixWorld;
    scene.updateMatrixWorld = function (...args) { sceneUpdates++; return sceneUpdate.apply(this, args); };
    world.updateMatrixWorld = function (...args) { worldUpdates++; return worldUpdate.apply(this, args); };
    player.updateMatrixWorld = function (...args) { playerUpdates++; return playerUpdate.apply(this, args); };
    const draws = [], depthClears = [];
    const position = object => [object.matrixWorld.elements[12], object.matrixWorld.elements[13], object.matrixWorld.elements[14]];
    const renderer = {
        autoClear: true, info: { autoReset: true, calls: 0, reset() { this.calls = 0; } },
        render(nextScene, nextCamera) {
            // Exactly the auto-update checks in our shipped Three renderer.
            if (nextScene.matrixWorldAutoUpdate === true) nextScene.updateMatrixWorld();
            if (nextCamera.parent === null && nextCamera.matrixWorldAutoUpdate === true) nextCamera.updateMatrixWorld();
            this.info.calls++;
            draws.push({world: position(world), player: position(player), body: position(body),
                overlay: position(overlay), camera: position(nextCamera), automatic: scene.matrixWorldAutoUpdate,
                visibility: scene.children.map(root => root.visible)});
            if (failPass && draws.length === failPass) throw Error('render fault');
        },
        clearDepth() { depthClears.push(draws.length); }
    };
    return { scene, world, player, body, overlay, hidden, camera, localCamera, renderer, draws, depthClears,
        get sceneUpdates() { return sceneUpdates; }, get worldUpdates() { return worldUpdates; },
        get playerUpdates() { return playerUpdates; }, position,
        run() { renderStage(renderer, scene, camera, player, localCamera); } };
}
check('三通道每帧只更新一次世界矩阵，局部玩家仅重算必要子树', () => {
    const f=fixture(); f.run();
    assert.equal(f.draws.length,3); assert.equal(f.sceneUpdates,1); assert.equal(f.worldUpdates,1);
    // Automatic scenes defer the restore recompute: pass 0 + localized shift
    // only; the stale localized matrixWorld is refreshed by the settle below.
    assert.equal(f.playerUpdates,2);
    assert.deepEqual(f.draws[1].player,[0,.12,0]);
    assert.deepEqual(f.draws[1].body,[.25,1.2200000000000002,.5]);
    assert.deepEqual(f.draws[1].camera,[0,9,6.5]);
    f.scene.updateMatrixWorld();
    assert.deepEqual(f.position(f.player),[24,.12,18]);
    assert.deepEqual(f.draws[2].overlay,[25,1,18]);
    assert.equal(f.scene.matrixWorldAutoUpdate,true);
});
check('无局部相机仍只更新一次世界，不更改角色坐标', () => {
    const f=fixture({local:false}); f.run();
    assert.equal(f.sceneUpdates,1); assert.equal(f.playerUpdates,1);
    assert.deepEqual(f.draws[1].player,[24,.12,18]);
});
check('调用者手动管理世界矩阵时保留其标志，局部玩家仍正确', () => {
    const f=fixture({automatic:false}); f.run();
    assert.equal(f.sceneUpdates,0); assert.equal(f.worldUpdates,0);
    assert.equal(f.playerUpdates,2);
    assert.deepEqual(f.draws[1].player,[0,.12,0]);
    assert.deepEqual(f.position(f.player),[24,.12,18]);
    assert.equal(f.scene.matrixWorldAutoUpdate,false);
});
check('相邻帧移动、骨骼姿态与前景变换不使用旧缓存', () => {
    const f=fixture(); f.run();
    f.world.position.x+=3; f.player.position.x+=2; f.body.position.x+=.5;
    f.overlay.position.y+=1; f.run();
    assert.equal(f.sceneUpdates,2); assert.equal(f.worldUpdates,2);
    assert.deepEqual(f.draws[3].world,[13,0,12]);
    assert.deepEqual(f.draws[4].body,[.75,1.2200000000000002,.5]);
    assert.deepEqual(f.draws[5].overlay,[25,2,18]);
    f.scene.updateMatrixWorld();
    assert.deepEqual(f.position(f.player),[26,.12,18]);
});
check('每个通道失败都恢复局部玩家、自动更新标志和渲染所有权', () => {
    for(const automatic of [true,false]) for(const failPass of [1,2,3]) {
        const f=fixture({automatic,failPass}), background=f.scene.background;
        assert.throws(()=>f.run(),/render fault/);
        assert.equal(f.scene.matrixWorldAutoUpdate,automatic);
        // Manual-matrix callers get the immediate restore recompute; automatic
        // callers defer it, so settle before asserting the matrixWorld value.
        f.scene.updateMatrixWorld();
        assert.deepEqual(f.position(f.player),[24,.12,18]);
        assert.deepEqual(f.player.position.toArray(),[24,.12,18]);
        assert.deepEqual(f.scene.children.map(root=>root.visible),[true,true,true,false]);
        assert.equal(f.scene.background,background);
        assert.equal(f.renderer.autoClear,true); assert.equal(f.renderer.info.autoReset,true);
    }
});
check('精简通道不增加世界计算，下一帧恢复自动更新', () => {
    const f=fixture(); f.overlay.visible=false; f.run();
    assert.equal(f.draws.length,2); assert.equal(f.sceneUpdates,1);
    f.player.visible=false; f.run();
    assert.equal(f.draws.length,3); assert.equal(f.sceneUpdates,2);
    assert.equal(f.scene.matrixWorldAutoUpdate,true);
});
if(failures) process.exitCode=1;

