// Bounded world-input assistance. No DOM events, rendering, damage, or doors.
import { circleOverlapsRect, stopCircle } from './geometry.js';

const CELL = .5, MAX_NODES = 4096, REPATH = .3, MANUAL_GRACE = .65;
const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function bounds(world, radius) {
    return { minX: radius, minY: radius, maxX: world.width - radius, maxY: world.height - radius };
}
export function clearPath(world, a, b, radius = .05) {
    const end = stopCircle({ x: a.x, y: a.y, radius }, b.x - a.x, b.y - a.y,
        world.roomColliders, bounds(world, radius));
    return length(end, b) < .0001;
}
function canFire(world, p, target) {
    const profile = p.weaponProfile;
    const range = profile.range + (profile.kind === 'projectile' ? 0 : target.radius || 0) - .15;
    return length(p, target) <= range && clearPath(world, p, target,
        profile.kind === 'projectile' ? profile.radius : .05);
}

// Four-neighbor BFS with exact swept-circle edge checks. The goal is a clear
// firing position, not the enemy's occupied center; no corner cutting occurs.
export function findAttackPath(world, player, target) {
    const targets = (Array.isArray(target) ? target : [target]).slice(0, 32);
    const radius = player.radius, w = Math.floor((world.width - 1) / CELL) + 1;
    const h = Math.floor((world.height - 1) / CELL) + 1;
    if (!(w > 0 && h > 0) || w * h > MAX_NODES) return { points: [], visited: 0 };
    const at = id => ({ x: .5 + (id % w) * CELL, y: .5 + Math.floor(id / w) * CELL });
    const blocked = new Uint8Array(w * h), previous = new Int32Array(w * h).fill(-2);
    const limit = bounds(world, radius);
    for (let i = 0; i < blocked.length; i++) {
        const p = at(i);
        blocked[i] = p.x < limit.minX || p.y < limit.minY || p.x > limit.maxX || p.y > limit.maxY
            || (world.roomColliders || []).some(box => circleOverlapsRect(p.x, p.y, radius, box));
    }
    let start = -1, best = Infinity;
    for (let i = 0; i < blocked.length; i++) {
        if (blocked[i]) continue;
        const point = at(i), distance = length(player, point);
        if (distance < best && distance <= CELL * 1.5 && clearPath(world, player, point, radius)) { start = i; best = distance; }
    }
    if (start < 0) return { points: [], visited: 0 };
    const queue = new Int32Array(w * h); queue[0] = start; previous[start] = -1;
    let read = 0, end = 1, goal = -1, reached = null;
    while (read < end && read < MAX_NODES) {
        const id = queue[read++], point = at(id);
        reached = targets.find(enemy => canFire(world, { ...player, x: point.x, y: point.y }, enemy));
        if (reached) { goal = id; break; }
        const x = id % w, y = Math.floor(id / w);
        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
            const nx = x + dx, ny = y + dy, next = ny * w + nx;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || blocked[next] || previous[next] !== -2
                    || !clearPath(world, point, at(next), radius)) continue;
            previous[next] = id; queue[end++] = next;
        }
    }
    const points = [];
    for (let id = goal; id >= 0; id = previous[id]) points.push(at(id));
    return { points: points.reverse(), visited: read, target: reached || null };
}

export function createAssistance() {
    const status = { enabled: false, state: '关闭', targetId: null, pathNodes: 0 };
    let held = false, pointer = null, grace = 0, room = null, walls = null;
    let targetId = null, targetAt = null, path = [], untilPath = 0;
    function clear() { path = []; targetId = null; targetAt = null; status.targetId = null; untilPath = 0; status.pathNodes = 0; }
    function suspend(input) { clear(); grace = MANUAL_GRACE; held = !!input?.assist; status.state = '暂停'; }
    return { status, suspend, disable() { clear(); status.enabled = false; status.state = '关闭'; },
        update(world, input, dt) {
            const p = world.player, tier = p?.gadgets?.assist || 0;
            if (world.frozen || world.transition || !p || p.dead) { suspend(input); return null; }
            if (input?.assist && !held && tier >= 2) { status.enabled = !status.enabled; clear(); }
            held = !!input?.assist;
            if (tier < 2) status.enabled = false;
            if (room !== world.room || walls !== world.roomColliders) { clear(); room = world.room; walls = world.roomColliders; }
            const moved = Math.hypot(input?.move?.x || 0, input?.move?.y || 0) > .05;
            const pointerNow = input?.pointer?.active ? input.pointer.x + ':' + input.pointer.y : null;
            const aiming = pointerNow !== null && pointerNow !== pointer;
            pointer = pointerNow;
            const manual = moved || aiming || input?.attack || input?.dodge || input?.ultimate || input?.skill?.some(Boolean);
            grace = manual ? MANUAL_GRACE : Math.max(0, grace - dt);
            const auto = tier >= 2 && status.enabled && grace <= 0;
            status.state = !tier || tier >= 2 && !status.enabled ? '关闭' : auto ? '搜索目标' : tier === 1 ? '辅助瞄准' : '手动优先';
            if (!tier || tier >= 2 && !status.enabled) { clear(); return null; }
            const living = (world.enemies || []).filter(e => !e.dead && e.sm?.state !== 'dead')
                .sort((a, b) => length(p, a) - length(p, b) || a.id - b.id);
            const visible = living.find(e => canFire(world, p, e));
            // Aim-only never steals a held movement direction or an explicit aim.
            if (!auto) { clear(); return tier === 1 && !world.aim && !moved && visible ? { target: visible, attack: false } : null; }
            if (visible) {
                clear(); status.targetId = visible.id; status.state = '自动普攻';
                // Strafe while firing instead of planting: enemy shots are aimed
                // at where you stand, and a sideways step makes them miss while
                // the swing keeps landing. The direction flips each second so
                // the player circles rather than walking into a wall and
                // stopping. A blocked step tries the other way.
                const dist = length(p, visible);
                let move = null;
                // Only the pathfinding tier strafes; the sentry (tier 2) is
                // contracted to stand still and fire in place.
                if (tier >= 3 && dist > .0001) {
                    const sign = Math.floor(world.time || 0) % 2 === 0 ? 1 : -1;
                    const tryDir = (s) => {
                        const dx = -(visible.y - p.y) / dist * s, dy = (visible.x - p.x) / dist * s;
                        const end = stopCircle({ x: p.x, y: p.y, radius: p.radius },
                            dx * p.speed * dt, dy * p.speed * dt,
                            world.roomColliders, bounds(world, p.radius));
                        return length(end, p) > .001 ? { x: dx, y: dy } : null;
                    };
                    move = tryDir(sign) || tryDir(-sign);
                }
                return { target: visible, attack: true, move: move };
            }
            if (tier < 3 || !living.length) { clear(); return null; }
            let target = living.find(e => e.id === targetId) || living[0];
            untilPath -= dt;
            if (targetId !== target.id || !targetAt || length(targetAt, target) > .75 || untilPath <= 0) {
                const found = findAttackPath(world, p, living);
                if (found.target) target = found.target;
                path = found.points; status.pathNodes = found.visited; untilPath = REPATH;
                targetId = target.id; targetAt = { x: target.x, y: target.y };
            }
            status.targetId = target.id;
            // Intermediate waypoints tolerate a small shortcut. The final
            // point must not disappear before the real player can fire;
            // otherwise a near-goal grid cell is found and discarded forever.
            while (path.length > 1 && length(p, path[0]) < .14) path.shift();
            const next = path[0];
            if (!next || !clearPath(world, p, next, p.radius)) { status.state = '无可达路线'; return null; }
            const distance = length(p, next);
            // A target can move slightly after planning while we reach the
            // old goal. Replan next tick, without dividing by zero or doing
            // a second graph search in this update.
            if (distance < .000001) { untilPath = 0; status.state = '搜索目标'; return null; }
            status.state = '寻路接敌';
            const step = Math.min(1, distance / Math.max(.001, p.speed * dt));
            return { target: null, attack: false, move: { x: (next.x - p.x) / distance * step, y: (next.y - p.y) / distance * step } };
        }
    };
}
