// Shared spatial grammar for a room's decoration and its painted terrain.
// This is deliberately pure data: mapview uses it for both visual placement
// and clearance, so a path cannot be drawn underneath a blocking prop.
import { ROOM_SIZE } from "../dungeon.js";
import { createRandom, hash32 } from "../random.js";

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

export function createRoomLayout(landmark, doors, size = ROOM_SIZE, shrine = null, camp = null, room = {}) {
    const center = { x: size.w / 2, y: size.h / 2 };
    const paths = [...new Set((doors || []).filter(side => ["N", "S", "E", "W"].includes(side)))]
        .map(function (door) { return { ...pathFor(door, size), side: door }; });
    // Terrain and clearance share the same gently bent segments.
    for (const path of paths) {
        const vertical = path.x1 === path.x2, bend = ((room.seed || 0) % 3 - 1) * 1.25;
        path.points = [{x:path.x1,y:path.y1},
            {x:(path.x1+path.x2)/2+(vertical?bend:0),y:(path.y1+path.y2)/2+(vertical?0:bend)},
            {x:path.x2,y:path.y2}];
    }
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
    // Seeded garden clusters leave the center and every real doorway readable.
    const rng = createRandom(hash32('layout:' + (room.seed || 0)));
    const radius = 2.6 * Math.min(1, size.w / ROOM_SIZE.w, size.h / ROOM_SIZE.h);
    const bx = center.x - Math.min(6.2,size.w*.25), by = center.y - Math.min(4.8,size.h*.25);
    const beds = [
        { x: bx, y: by, radius },
        { x: size.w - bx, y: by, radius },
        { x: bx, y: size.h - by, radius },
        { x: size.w - bx, y: size.h - by, radius },
        ...(size.w >= 36 ? [
            { x: size.w * .12, y: size.h * .3, radius: 2.1 },
            { x: size.w * .88, y: size.h * .7, radius: 2.1 }
        ] : [])
    ].map(bed => ({ x:bed.x+(rng()-.5)*1.8, y:bed.y+(rng()-.5)*1.5,
        radius:bed.radius*(.85+rng()*.25) })).filter(function (bed) {
        return (!building || Math.hypot(bed.x - building.x, bed.y - building.y)
            > bed.radius + Math.max(building.hw, building.hh) + BUILDING_CLEAR)
            && (!camp || Math.abs(bed.x - camp.area.x) > camp.area.hw + bed.radius
                || Math.abs(bed.y - camp.area.y) > camp.area.hh + bed.radius);
    });

    const plaza = { x:center.x, y:center.y, hw:room.type==='boss'?7:3.3, hh:room.type==='boss'?5.7:2.7 };
    function isProtected(x, y, halfWidth) {
        const hw = halfWidth || 0;
        if (shrine && Math.abs(x - shrine.x) < 1.9 + hw && Math.abs(y - shrine.y) < 1.6 + hw) {
            return true;
        }
        if (camp && Math.abs(x - camp.area.x) < camp.area.hw + hw
            && Math.abs(y - camp.area.y) < camp.area.hh + hw) return true;
        if (Math.abs(x-center.x)<plaza.hw+hw && Math.abs(y-center.y)<plaza.hh+hw) {
            return true;
        }
        for (let i = 0; i < paths.length; i++) {
            const p = paths[i], r = p.width / 2 + hw;
            const points=p.points||[{x:p.x1,y:p.y1},{x:p.x2,y:p.y2}];
            for(let j=1;j<points.length;j++) {
                const a=points[j-1],b=points[j],dx=b.x-a.x,dy=b.y-a.y;
                const t=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1)));
                if(Math.hypot(x-a.x-t*dx,y-a.y-t*dy)<r) return true;
            }
        }
        if (building && Math.abs(x - building.x) < building.hw + hw + BUILDING_CLEAR
            && Math.abs(y - building.y) < building.hh + hw + BUILDING_CLEAR) {
            return true;
        }
        if (court && Math.abs(x - court.x) < court.hw + hw
            && Math.abs(y - court.y) < court.hh + hw) return true;
        return false;
    }

    return { size, center, paths, beds, building, court, shrine, camp, plaza, plazaRadius: PLAZA_RADIUS, isProtected };
}
