// The floor ritual is a room object, never an exit or a loot requirement.
// World collision and map clearance share this deterministic anchor.
import { roomSize } from './dungeon.js';

export const FLOOR_SHRINE_RANGE = 1.9;
export const FLOOR_SHRINE_KEY = 'goods_1147';

export function floorShrineFor(room) {
    if (!room || room.type !== 'boss') return null;
    const size = roomSize(room);
    return { roomId: room.id, x: size.w / 2, y: size.h / 2 - 3.1,
        hw: .65, hh: .42, key: FLOOR_SHRINE_KEY };
}

export function nearFloorShrine(shrine, player) {
    return !!(shrine && player && Number.isFinite(player.x) && Number.isFinite(player.y)
        && Math.hypot(player.x - shrine.x, player.y - shrine.y) <= FLOOR_SHRINE_RANGE);
}
