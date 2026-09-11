// Shared spatial grammar for a room's decoration and its painted terrain.
// This is deliberately pure data: mapview uses it for both visual placement
// and clearance, so a path cannot be drawn underneath a blocking prop.
import { ROOM_SIZE } from "../dungeon.js";

const PATH_WIDTH = 2.6;
const PLAZA_RADIUS = 2.8;
const BUILDING_CLEAR = 0.8;

function pathFor(side, size) {
    const cx = size.w / 2, cy = size.h / 2;
    if (side === "N" || side === "S") {
        return { x1: cx, y1: side === "N" ? 0 : cy, x2: cx,
            y2: side === "N" ? cy : size.h, width: PATH_WIDTH };
    }
    return { x1: side === "W" ? 0 : cx, y1: cy,
        x2: side === "W" ? cx : size.w, y2: cy, width: PATH_WIDTH };
}

export function createRoomLayout(landmark, doors, size = ROOM_SIZE, shrine = null, camp = null) {
    const center = { x: size.w / 2, y: size.h / 2 };
    const paths = [...new Set((doors || []).filter(side => ["N", "S", "E", "W"].includes(side)))]
        .map(function (door) { return { ...pathFor(door, size), side: door }; });
    if (shrine) {
        paths.push({ x1: center.x, y1: center.y, x2: shrine.x, y2: shrine.y + 1, width: 2.8 });
    }
    if (camp) {
        paths.push({ x1: center.x, y1: center.y, x2: center.x, y2: camp.npc.y, width: 2.2 });
        paths.push({ x1: center.x, y1: camp.npc.y, x2: camp.npc.x, y2: camp.npc.y, width: 2.2 });
    }
    const building = landmark && landmark.collider;
    const court = building ? { x: building.x, y: building.y + .55,
        hw: Math.max(3.5, building.hw + 1.0), hh: Math.max(2.5, building.hh + 1.4) } : null;
    if (building) {
        paths.push({ x1: center.x, y1: center.y, x2: building.x, y2: center.y, width: 2.2 });
        paths.push({ x1: building.x, y1: center.y, x2: building.x,
            y2: court.y + court.hh - .3, width: 2.2 });
    }
    // Four garden courts leave the center and every real doorway readable.
    // Their order is stable; room.seed still controls which kit card fills a
    // court, not the room's large-scale composition.
    const radius = 2.6 * Math.min(1, size.w / ROOM_SIZE.w, size.h / ROOM_SIZE.h);
    const bx = size.w * 10.7 / ROOM_SIZE.w, by = size.h * 8.3 / ROOM_SIZE.h;
    const beds = [
        { x: bx, y: by, radius },
        { x: size.w - bx, y: by, radius },
        { x: bx, y: size.h - by, radius },
        { x: size.w - bx, y: size.h - by, radius }
    ].filter(function (bed) {
        return (!building || Math.hypot(bed.x - building.x, bed.y - building.y)
            > bed.radius + Math.max(building.hw, building.hh) + BUILDING_CLEAR)
            && (!camp || Math.abs(bed.x - camp.area.x) > camp.area.hw + bed.radius
                || Math.abs(bed.y - camp.area.y) > camp.area.hh + bed.radius);
    });

    function isProtected(x, y, halfWidth) {
        const hw = halfWidth || 0;
        if (shrine && Math.abs(x - shrine.x) < 1.9 + hw && Math.abs(y - shrine.y) < 1.6 + hw) {
            return true;
        }
        if (camp && Math.abs(x - camp.area.x) < camp.area.hw + hw
            && Math.abs(y - camp.area.y) < camp.area.hh + hw) return true;
        if (Math.hypot(x - center.x, y - center.y) < PLAZA_RADIUS + hw) {
            return true;
        }
        for (let i = 0; i < paths.length; i++) {
            const p = paths[i], r = p.width / 2 + hw;
            if (Math.abs(p.x1 - p.x2) < 0.01) {
                if (Math.abs(x - p.x1) < r && y + hw >= Math.min(p.y1, p.y2)
                    && y - hw <= Math.max(p.y1, p.y2)) return true;
            } else if (Math.abs(y - p.y2) < r && x + hw >= Math.min(p.x1, p.x2)
                && x - hw <= Math.max(p.x1, p.x2)) return true;
        }
        if (building && Math.abs(x - building.x) < building.hw + hw + BUILDING_CLEAR
            && Math.abs(y - building.y) < building.hh + hw + BUILDING_CLEAR) {
            return true;
        }
        if (court && Math.abs(x - court.x) < court.hw + hw
            && Math.abs(y - court.y) < court.hh + hw) return true;
        return false;
    }

    return { size, center, paths, beds, building, court, shrine, camp, plazaRadius: PLAZA_RADIUS, isProtected };
}
