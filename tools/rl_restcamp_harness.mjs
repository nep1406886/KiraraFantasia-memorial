// Shared camp coordinates and clear approach paths, without DOM or rendering.
import assert from 'node:assert/strict';
import { restCampFor } from '../site/game/rl/restcamp.js';
import { createRoomLayout } from '../site/game/rl/view/roomlayout.js';
import { createWorld } from '../site/game/rl/world.js';
import { roomSize } from '../site/game/rl/dungeon.js';

let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
const room = { id: 2, type: 'rest', seed: 217, enemies: [] };
const camp = restCampFor(room), size = roomSize(room);
const clear = (x, y, radius = .35) => camp.colliders.every(b =>
    Math.abs(x - b.x) >= b.hw + radius || Math.abs(y - b.y) >= b.hh + radius);

check('camp exists only in a rest room and does not mutate its input', () => {
    const before = JSON.stringify(room);
    for (const type of ['start', 'battle', 'boss', 'shop', 'chest']) assert.equal(restCampFor({ type }), null);
    assert.equal(restCampFor(null), null);
    assert.equal(JSON.stringify(room), before);
});
check('visitor position stays compatible with the existing room', () => {
    assert.deepEqual(camp.npc, { x: 12.1, y: 13.4 });
    const world = createWorld({ seed: 2 }); world.spawnPlayer({});
    world.setDungeon({ rooms: [room], doors: [], start: room.id, boss: room.id });
    world.enterRoom(room.id);
    assert.deepEqual({ x: world.npc.x, y: world.npc.y }, camp.npc);
    world.npc.talked = true; world.enterRoom(room.id);
    assert.equal(world.npc.talked, true);
});
check('camp uses the three verified original furniture identities', () => {
    assert.deepEqual(camp.props.map(p => p.key), ['goods_1041', 'goods_1044', 'goods_1072']);
    assert.equal(camp.colliders.length, 2);
    assert.ok(clear(camp.npc.x, camp.npc.y, .55));
    for (const b of camp.colliders) {
        assert.ok(b.x - b.hw > 0 && b.x + b.hw < size.w && b.y - b.hh > 0 && b.y + b.hh < size.h);
        assert.ok(Math.abs(b.x - size.w / 2) > b.hw + 1.2);
        assert.ok(Math.abs(b.y - size.h / 2) > b.hh + 1.2);
    }
});
check('all four doors and the visitor keep continuous clear paths', () => {
    const layout = createRoomLayout(null, ['N', 'E', 'S', 'W'], size, null, camp);
    for (const path of layout.paths) for (let i = 0; i <= 100; i++) {
        const x = path.x1 + (path.x2 - path.x1) * i / 100;
        const y = path.y1 + (path.y2 - path.y1) * i / 100;
        assert.ok(clear(x, y), 'blocked camp approach');
    }
    for (const prop of camp.props) assert.ok(layout.isProtected(prop.x, prop.y, .4));
    assert.ok(layout.isProtected(camp.npc.x, camp.npc.y, .35));
    for (const bed of layout.beds) assert.ok(Math.abs(bed.x - camp.area.x) > camp.area.hw + bed.radius
        || Math.abs(bed.y - camp.area.y) > camp.area.hh + bed.radius);
});
check('200 room seeds cannot reroll camp positions or add a corridor obstacle', () => {
    for (let seed = 0; seed < 200; seed++) {
        assert.deepEqual(restCampFor({ ...room, seed }), camp);
        const landmark = { collider: { x: seed & 1 ? 4.6 : 15.4, y: 4.48, hw: 2.16, hh: 1.05 } };
        const layout = createRoomLayout(landmark, ['N', 'E', 'S', 'W'], size, null, camp);
        assert.ok(layout.isProtected(camp.npc.x, camp.npc.y, .35));
    }
});
console.log(checks + '/' + checks + ' passed');
