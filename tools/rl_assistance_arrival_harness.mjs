import assert from 'node:assert/strict';
import { createWorld } from '../site/game/rl/world.js';
import { makeGadget } from '../site/game/rl/gadgets.js';
import { createAssistance, findAttackPath } from '../site/game/rl/assistance.js';

let checks = 0, failures = 0;
function check(name, run) {
    checks++;
    try { run(); console.log('PASS ' + name); }
    catch (error) { failures++; console.error('FAIL ' + name + ': ' + error.message); }
}
function fixture(id, classId, angle, offset) {
    const x = 9, y = 8, dx = Math.cos(angle), dy = Math.sin(angle);
    const world = createWorld({ seed: 176, width: 20, height: 16 });
    const player = world.spawnPlayer({ card: { id: 1, class: classId, element: 0 },
        x: x - dx * offset, y: y - dy * offset, hp: 1000, atk: 100,
        equipment: [makeGadget(id, undefined, id === 'binding' ? 1 : undefined)] });
    const distance = player.weaponProfile.range + .5 - .15 - .01;
    const target = world.spawnEnemy({ x: x + dx * distance, y: y + dy * distance,
        hp: 100000, atk: 0, def: 0 });
    target.actionTimer = 1e9;
    world.inputState = { move: { x: 0, y: 0 }, assist: false, attack: false, dodge: false,
        ultimate: false, skill: [false, false, false] };
    return { world, player, target };
}

for (const id of ['hunter', 'prism', 'binding']) for (const classId of [0, 3]) {
    check(id + ' 职业' + classId + ' 保留最后路点并实际出手命中', () => {
        for (const fps of [30, 60, 120]) for (const degrees of [0, 23, 90, 143, 210, 289, 359]) {
            for (const offset of [.05, .1333333333, .139999]) {
                const { world: w, player: p, target: e } = fixture(id, classId, degrees * Math.PI / 180, offset);
                const path = findAttackPath(w, p, e);
                assert.equal(path.points.length, 1, '必须复现只有最后路点的边界');
                const start = { x: p.x, y: p.y };
                w.inputState.assist = true; w.update(1 / fps); w.inputState.assist = false;
                for (let step = 0; step < fps; step++) w.update(1 / fps);
                assert.ok(w.events.some(event => event.type === 'hit' && event.target === e),
                    '缺少真实命中：' + JSON.stringify({ id, classId, fps, degrees, offset, at: [p.x, p.y], assistance: w.assistance }));
                assert.ok(Math.hypot(p.x - start.x, p.y - start.y) > 0);
                assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
                assert.equal(w.inputState.attack, false);
            }
        }
    });
}

check('移动目标使旧终点失效时无零距离除法，下一步有界重算', () => {
    const { world: w, player: p, target: e } = fixture('prism', 0, 0, .1333333333);
    const controller = createAssistance(), input = w.inputState;
    input.assist = true;
    assert.ok(controller.update(w, input, 1 / 60)?.move);
    input.assist = false;
    // This explicit adapter fixture reaches the old goal exactly, then moves
    // the target by less than the 0.75 immediate-repath threshold.
    p.x = 9; p.y = 8; e.x += .2;
    assert.equal(controller.update(w, input, 1 / 60), null);
    const next = controller.update(w, input, 1 / 60);
    assert.ok(next?.move && Number.isFinite(next.move.x) && Number.isFinite(next.move.y));
    assert.ok(next.move.x > 0 && Math.hypot(next.move.x, next.move.y) <= 1);
    assert.ok(controller.status.pathNodes <= 4096);
});

console.log(checks + ' checks, ' + failures + ' failures');
process.exitCode = failures ? 1 : 0;
