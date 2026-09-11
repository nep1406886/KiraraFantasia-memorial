// Read-only local-room navigation plus a fog-of-war room graph.
// Geometry is rebuilt only on room/door/collider changes; moving markers reuse
// their SVG nodes and consume the same interpolated positions as the stage.
import { ROOM_SIZE, roomSize, doorsOf } from "../dungeon.js";

const NS = "http://www.w3.org/2000/svg";
const SIDE_NAMES = { N: "北", E: "东", S: "南", W: "西" };
const SIDE_ANGLES = { N: 0, E: 90, S: 180, W: 270 };
const ROOM_NAMES = { start: "入口", battle: "战斗", chest: "宝箱", shop: "商店", rest: "营地", boss: "首领" };
function svgNode(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    if (parent) parent.appendChild(node);
    return node;
}
function title(node, text) { svgNode("title", {}, node).textContent = text; }

export function createMinimap(container, options) {
    const cfg = Object.assign({ cell: 16, gap: 6, max: 12 }, options || {});
    container.classList.add("rl-minimap");
    container.setAttribute("aria-label", "小地图");
    const local = svgNode("svg", { class: "minimap-local", viewBox: "-3 -3 " + (ROOM_SIZE.w + 6) + " " + (ROOM_SIZE.h + 6),
        role: "img", "aria-label": "当前房间：玩家、敌人和出口" });
    const graph = svgNode("svg", { class: "minimap-graph", role: "img", "aria-label": "已探索的房间及相邻通路" });
    container.replaceChildren(local, graph);
    let dungeon = null, currentRoom = null, visited = new Set();
    let lastLocked = null, lastColliders = null, lastColliderCount = -1;
    let markerLayer = null;
    let size = ROOM_SIZE;
    const markers = new Map();

    function drawGraph() {
        graph.replaceChildren();
        if (!dungeon || !visited.size) return;
        const known = new Set(visited);
        for (const door of dungeon.doors) {
            if (visited.has(door.a)) known.add(door.b);
            if (visited.has(door.b)) known.add(door.a);
        }
        const rooms = dungeon.rooms.filter(room => known.has(room.id));
        if (!rooms.length) return;
        const minX = Math.min(...rooms.map(r => r.x)), minY = Math.min(...rooms.map(r => r.y));
        const spanX = Math.max(...rooms.map(r => r.x)) - minX + 1;
        const spanY = Math.max(...rooms.map(r => r.y)) - minY + 1;
        const cell = cfg.cell / Math.max(1, spanX / cfg.max, spanY / cfg.max), step = cell + cfg.gap;
        graph.setAttribute("viewBox", "-3 -3 " + (spanX * step + 6) + " " + (spanY * step + 6));
        const point = room => ({ x: (room.x - minX) * step + cell / 2, y: (room.y - minY) * step + cell / 2 });
        for (const door of dungeon.doors) {
            if (!visited.has(door.a) && !visited.has(door.b)) continue;
            const a = rooms.find(r => r.id === door.a), b = rooms.find(r => r.id === door.b);
            if (!a || !b) continue;
            const p = point(a), q = point(b);
            svgNode("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: "minimap-link",
                "data-current": String(door.a === currentRoom || door.b === currentRoom),
                "data-locked": String(lastLocked && (door.a === currentRoom || door.b === currentRoom)) }, graph);
        }
        for (const room of rooms) {
            const p = point(room), seen = visited.has(room.id);
            const rect = svgNode("rect", { x: p.x - cell / 2, y: p.y - cell / 2, width: cell, height: cell, rx: 3,
                class: "minimap-room", "data-room": room.id, "data-type": seen ? room.type : "unknown",
                "data-current": String(room.id === currentRoom), "data-visited": String(seen) }, graph);
            title(rect, seen ? ROOM_NAMES[room.type] || "房间" : "未探索");
            if (room.id === currentRoom) svgNode("circle", { cx: p.x, cy: p.y, r: 2.5, class: "minimap-you" }, graph);
        }
    }

    function drawLocal(world) {
        local.replaceChildren(); markers.clear();
        size = roomSize(dungeon?.rooms.find(room => room.id === currentRoom));
        local.setAttribute("viewBox", "-3 -3 " + (size.w + 6) + " " + (size.h + 6));
        svgNode("rect", { x: 0, y: 0, width: size.w, height: size.h, rx: .5, class: "minimap-floor" }, local);
        const obstacles = svgNode("g", { class: "minimap-obstacles" }, local);
        for (const box of world?.roomColliders || []) {
            const x = Math.max(0, box.x - box.hw), y = Math.max(0, box.y - box.hh);
            const w = Math.min(size.w, box.x + box.hw) - x, h = Math.min(size.h, box.y + box.hh) - y;
            if (w > 0 && h > 0) svgNode("rect", { x, y, width: w, height: h, rx: .2 }, obstacles);
        }
        for (const door of dungeon ? doorsOf(dungeon, currentRoom) : []) {
            const group = svgNode("g", { class: "minimap-door", "data-side": door.side, "data-locked": String(!!lastLocked),
                transform: "translate(" + door.at.x + " " + door.at.y + ") rotate(" + SIDE_ANGLES[door.side] + ")" }, local);
            svgNode("rect", { x: -1.3, y: -.5, width: 2.6, height: 1, rx: .2 }, group);
            svgNode("path", { d: lastLocked ? "M-.55,-.55 L.55,.55 M.55,-.55 L-.55,.55" : "M-.7,-.2 L0,-1 L.7,-.2" }, group);
            const room = dungeon.rooms.find(r => r.id === door.to);
            title(group, SIDE_NAMES[door.side] + "侧出口 · " + (lastLocked ? "封锁" : "可通行")
                + " · " + (visited.has(door.to) ? ROOM_NAMES[room?.type] || "房间" : "未探索"));
        }
        markerLayer = svgNode("g", { class: "minimap-markers" }, local);
        lastColliders = world?.roomColliders || null;
        lastColliderCount = lastColliders ? lastColliders.length : 0;
    }

    function setDungeon(d) {
        dungeon = d; visited = new Set(); currentRoom = null;
        lastLocked = null; lastColliders = null; lastColliderCount = -1;
        local.replaceChildren(); graph.replaceChildren(); markers.clear(); markerLayer = null;
    }
    function setCurrent(roomId) {
        if (currentRoom === roomId || !dungeon?.rooms.some(room => room.id === roomId)) return;
        currentRoom = roomId; visited.add(roomId); lastLocked = null; markerLayer = null;
        drawGraph();
    }
    return {
        setDungeon, setCurrent,
        visit(roomId) {
            if (!dungeon?.rooms.some(room => room.id === roomId) || visited.has(roomId)) return;
            visited.add(roomId); drawGraph();
        },
        update(world, positionOf) {
            container.hidden = !world?.player || !world.dungeon || world.player.dead;
            if (container.hidden) return;
            if (world.dungeon !== dungeon) setDungeon(world.dungeon);
            setCurrent(world.roomId);
            const oldSize = visited.size;
            for (const [id, state] of world.roomState) if (state.visited) visited.add(id);
            const locked = world.roomLocked, changed = locked !== lastLocked || oldSize !== visited.size;
            lastLocked = locked;
            if (!markerLayer || changed || lastColliders !== world.roomColliders || lastColliderCount !== world.roomColliders.length) drawLocal(world);
            if (changed) drawGraph();
            const used = new Set();
            const place = (key, unit, kind, at) => {
                if (!markers.has(key)) {
                    const node = kind === "player" ? svgNode("path", { d: "M0,-1 L.7,.75 L0,.4 L-.7,.75 Z" }, markerLayer)
                        : svgNode("circle", { r: kind === "boss" ? .9 : kind === "enemy" ? .55 : .7 }, markerLayer);
                    node.setAttribute("class", "minimap-unit"); node.dataset.kind = kind;
                    markers.set(key, node);
                }
                const x = Math.max(0, Math.min(size.w, at.x)), y = Math.max(0, Math.min(size.h, at.y));
                markers.get(key).setAttribute("transform", "translate(" + x.toFixed(2) + " " + y.toFixed(2) + ")"
                    + (kind === "player" ? " rotate(" + ((unit.facing || 0) * 180 / Math.PI + 90).toFixed(1) + ")" : ""));
                used.add(key);
            };
            for (const enemy of world.enemies) if (!enemy.dead) place(enemy, enemy, enemy.kind === "boss" ? "boss" : "enemy", positionOf ? positionOf(enemy) : enemy);
            for (const [key, unit, usedUp] of [["chest", world.chest, "opened"], ["altar", world.altar, "used"], ["npc", world.npc, "talked"]]) {
                if (unit && !unit[usedUp]) place(key, unit, key, unit);
            }
            place(world.player, world.player, "player", positionOf ? positionOf(world.player) : world.player);
            for (const [key, node] of markers) if (!used.has(key)) { node.remove(); markers.delete(key); }
        }
    };
}
