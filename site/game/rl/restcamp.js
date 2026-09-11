// One deterministic camp footprint for world NPCs and map candidates.
// Furniture is scenery, not a second source of event rewards or damage.
import { roomSize } from './dungeon.js';

export function restCampFor(room) {
    if (!room || room.type !== 'rest') return null;
    const size = roomSize(room);
    // Preserve the existing visitor interaction point and saved talked flag.
    const npc = { x: size.w / 2 + 2.1, y: size.h - 2.6 };
    const props = [
        { role: 'fire', key: 'goods_1041', x: npc.x + 1.65, y: npc.y - 1.35,
            height: 1.6, maxWidth: 1.45, hw: .46, hh: .36, shadow: .51 },
        { role: 'grill', key: 'goods_1044', x: npc.x + 3.6, y: npc.y - .15,
            height: 1.45, maxWidth: 1.3, hw: .46, hh: .35, shadow: .45 },
        { role: 'lantern', key: 'goods_1072', x: npc.x + 1.4, y: npc.y + 1.25,
            height: .65, maxWidth: .6, shadow: .23 }
    ];
    return { roomId: room.id, npc, props,
        area: { x: npc.x + 1.6, y: npc.y - .1, hw: 3.15, hh: 2.45 },
        colliders: props.filter(prop => prop.hw).map(prop => ({
            x: prop.x, y: prop.y, hw: prop.hw, hh: prop.hh })) };
}
