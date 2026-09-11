// Shared ground-space geometry. No rendering and no damage side effects.
const EPS = 1e-7;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function segmentDistanceSquared(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length ? clamp(((px - ax) * dx + (py - ay) * dy) / length, 0, 1) : 0;
    return (px - ax - dx * t) ** 2 + (py - ay - dy * t) ** 2;
}

// Earliest contact along a segment. Infinity means no contact, 0 starts inside.
export function sweepCircleTime(ax, ay, bx, by, cx, cy, radius) {
    const dx = bx - ax, dy = by - ay, ox = ax - cx, oy = ay - cy;
    const c = ox * ox + oy * oy - radius * radius;
    if (c <= 0) { return 0; }
    const a = dx * dx + dy * dy;
    if (a < EPS * EPS) { return Infinity; }
    const b = ox * dx + oy * dy;
    const discriminant = b * b - a * c;
    // Exact tangency can round slightly negative after the two products are
    // subtracted. Allow only floating-point roundoff, not a larger hit radius.
    const roundoff = 8 * Number.EPSILON * (b * b + Math.abs(a * c));
    if (discriminant < -roundoff) { return Infinity; }
    const t = (-b - Math.sqrt(Math.max(0, discriminant))) / a;
    return t >= 0 && t <= 1 ? t : Infinity;
}

export function circleOverlapsRect(x, y, radius, rect) {
    const dx = x - clamp(x, rect.x - rect.hw, rect.x + rect.hw);
    const dy = y - clamp(y, rect.y - rect.hh, rect.y + rect.hh);
    return dx * dx + dy * dy < Math.max(0, radius - EPS) ** 2;
}

function firstWallContact(x, y, dx, dy, radius, rect) {
    const left = rect.x - rect.hw, right = rect.x + rect.hw;
    const top = rect.y - rect.hh, bottom = rect.y + rect.hh;
    let contact = null;
    function accept(t, nx, ny) {
        const approach = dx * nx + dy * ny;
        // Tolerance is a distance, not a fraction of this frame's motion.
        if (t * Math.hypot(dx, dy) < -EPS || t > 1 || approach >= -EPS) { return; }
        if (!contact || t < contact.t) { contact = { t: Math.max(0, t), nx, ny }; }
    }
    if (dx > EPS) {
        const t = (left - radius - x) / dx, hy = y + dy * t;
        if (hy >= top && hy <= bottom) { accept(t, -1, 0); }
    } else if (dx < -EPS) {
        const t = (right + radius - x) / dx, hy = y + dy * t;
        if (hy >= top && hy <= bottom) { accept(t, 1, 0); }
    }
    if (dy > EPS) {
        const t = (top - radius - y) / dy, hx = x + dx * t;
        if (hx >= left && hx <= right) { accept(t, 0, -1); }
    } else if (dy < -EPS) {
        const t = (bottom + radius - y) / dy, hx = x + dx * t;
        if (hx >= left && hx <= right) { accept(t, 0, 1); }
    }
    // The Minkowski sum has round corners, not the old square hitbox.
    for (const cx of [left, right]) {
        for (const cy of [top, bottom]) {
            const t = sweepCircleTime(x, y, x + dx, y + dy, cx, cy, radius);
            if (!Number.isFinite(t)) { continue; }
            const hx = x + dx * t, hy = y + dy * t;
            if ((cx === left ? hx > left : hx < right)
                    || (cy === top ? hy > top : hy < bottom)) { continue; }
            const length = Math.hypot(hx - cx, hy - cy) || 1;
            accept(t, (hx - cx) / length, (hy - cy) / length);
        }
    }
    return contact;
}

// Escape only an ALREADY invalid spawn/late-loaded obstacle overlap. Test all
// obstacle boundary intersections, not sequential push-outs that can oscillate
// between overlapping props. Normal movement never enters this bounded search.
function clearInitialOverlap(x, y, radius, colliders, bounds) {
    const valid = (px, py) => px >= bounds.minX && px <= bounds.maxX
        && py >= bounds.minY && py <= bounds.maxY
        && !colliders.some(c => circleOverlapsRect(px, py, radius, c));
    if (valid(x, y)) { return { x, y }; }
    const xs = [clamp(x, bounds.minX, bounds.maxX), bounds.minX, bounds.maxX];
    const ys = [clamp(y, bounds.minY, bounds.maxY), bounds.minY, bounds.maxY];
    colliders.forEach(c => {
        xs.push(c.x - c.hw - radius - EPS, c.x + c.hw + radius + EPS);
        ys.push(c.y - c.hh - radius - EPS, c.y + c.hh + radius + EPS);
    });
    let best = null, distance = Infinity;
    for (const px of xs) {
        for (const py of ys) {
            const d = (px - x) ** 2 + (py - y) ** 2;
            if (Number.isFinite(d) && d < distance && valid(px, py)) {
                best = { x: px, y: py }; distance = d;
            }
        }
    }
    return best || { x, y }; // fully sealed room: do not invent a teleport out
}

// A committed lunge stops at the first wall rather than sliding around it.
// The same endpoint is used for its warning and its motion, preserving angle.
export function stopCircle(body, dx, dy, colliders, bounds) {
    const walls = colliders || [];
    const limits = bounds || { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
    const x = body.x, y = body.y, length = Math.hypot(dx, dy);
    if (length < EPS || x < limits.minX || x > limits.maxX || y < limits.minY || y > limits.maxY
            || walls.some(wall => circleOverlapsRect(x, y, body.radius, wall))) { return { x, y }; }
    let end = 1;
    if (dx > 0) { end = Math.min(end, (limits.maxX - x) / dx); }
    if (dx < 0) { end = Math.min(end, (limits.minX - x) / dx); }
    if (dy > 0) { end = Math.min(end, (limits.maxY - y) / dy); }
    if (dy < 0) { end = Math.min(end, (limits.minY - y) / dy); }
    for (const wall of walls) {
        const contact = firstWallContact(x, y, dx, dy, body.radius, wall);
        if (contact) { end = Math.min(end, contact.t); }
    }
    const travel = Math.max(0, end < 1 ? end - EPS / length : end);
    return { x: x + dx * travel, y: y + dy * travel };
}

export function moveCircle(body, dx, dy, colliders, bounds) {
    const walls = colliders || [];
    const limits = bounds || { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
    const start = clearInitialOverlap(body.x, body.y, body.radius, walls, limits);
    let x = start.x, y = start.y;
    dx = clamp(x + dx, limits.minX, limits.maxX) - x;
    dy = clamp(y + dy, limits.minY, limits.maxY) - y;
    for (let pass = 0; pass < 5 && Math.hypot(dx, dy) > EPS; pass++) {
        let first = null;
        for (const wall of walls) {
            const hit = firstWallContact(x, y, dx, dy, body.radius, wall);
            if (hit && (!first || hit.t < first.t)) { first = hit; }
        }
        if (!first) { x += dx; y += dy; break; }
        // Stop just BEFORE contact along the known-clear segment. Pushing out
        // along one normal can enter a second wall at a tight corner.
        const travel = Math.max(0, first.t - EPS / Math.hypot(dx, dy));
        x += dx * travel; y += dy * travel;
        dx *= 1 - travel; dy *= 1 - travel;
        const into = Math.min(0, dx * first.nx + dy * first.ny);
        dx -= into * first.nx; dy -= into * first.ny;
    }
    return { x: clamp(x, limits.minX, limits.maxX), y: clamp(y, limits.minY, limits.maxY) };
}
