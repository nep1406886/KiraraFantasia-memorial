// Authored terrain dressing, not original game artwork. A single private
// canvas texture per candidate keeps the paving and landscape beds cheap.
// Geometry ownership stays with mapview; material/texture are returned to it.
import { roomSize } from "../dungeon.js";
import { createRandom, hash32 } from "../random.js";

const PIXELS_PER_UNIT = 32;
const PALETTES = {
    1: { joint: "#baa785", tile: ["#d9c7a3", "#d3bf99", "#ddccad"], bed: "#789f9c", trim: "#a3d6d1" },
    2: { joint: "#a89471", tile: ["#cdb98f", "#d3bf99", "#c6b18a"], bed: "#849466", trim: "#e6d09c" },
    3: { joint: "#77855d", tile: ["#b2b58d", "#a7ac81", "#bfc099"], bed: "#48683a", trim: "#c9d499" },
    4: { joint: "#826e57", tile: ["#b4a184", "#aa9679", "#beab8b"], bed: "#8d795f", trim: "#d2b979" },
    5: { joint: "#4a555c", tile: ["#7b888a", "#758386", "#859192"], bed: "#4c605a", trim: "#bccac2" }
};

function canvas(size) {
    const c = document.createElement("canvas");
    c.width = size.w * PIXELS_PER_UNIT;
    c.height = size.h * PIXELS_PER_UNIT;
    return c;
}

function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
}

export function createRoomSurface(THREE, cfg, layout, room, volume) {
    const size = roomSize(room);
    const c = canvas(size), ctx = c.getContext("2d"), p = PIXELS_PER_UNIT;
    const colors = PALETTES[volume] || PALETTES[1];
    const rng = createRandom(hash32("room-surface:" + room.seed + ":" + cfg.biome));
    // Composite into an OPAQUE floor, not a transparent overlay. Native town
    // facade layers intentionally do not write depth; a transparent terrain
    // sheet sorted after those layers otherwise paints paving over the house.
    ctx.fillStyle = cfg.ground.base;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = cfg.ground.mottle || cfg.ground.base;
    ctx.globalAlpha = .32;
    for (let i = 0; i < 3500; i++) {
        ctx.fillRect(rng() * c.width, rng() * c.height, .5 + rng(), .4 + rng() * .7);
    }
    ctx.globalAlpha = 1;
    // Irregular, feathered landscape beds. No repeated circular stamps or
    // fake ponds: the original kit supplies the actual plants/water/rocks.
    layout.beds.forEach(bed => {
        ctx.save();
        ctx.translate(bed.x * p, bed.y * p);
        ctx.scale(1, .82);
        ctx.beginPath();
        for (let i = 0; i <= 18; i++) {
            const angle = (i % 18) / 18 * Math.PI * 2;
            const radius = bed.radius * p * (.83 + rng() * .20);
            const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
            if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.clip();
        const gradient = ctx.createRadialGradient(0, 0, bed.radius * p * .25, 0, 0, bed.radius * p);
        gradient.addColorStop(0, colors.bed + "78");
        gradient.addColorStop(.7, colors.bed + "30");
        gradient.addColorStop(1, colors.bed + "00");
        ctx.fillStyle = gradient;
        ctx.fillRect(-bed.radius * p, -bed.radius * p, bed.radius * p * 2, bed.radius * p * 2);
        for (let i = 0; i < 45; i++) {
            const angle = rng() * Math.PI * 2, radius = Math.sqrt(rng()) * bed.radius * p;
            ctx.fillStyle = i % 3 ? colors.bed + "35" : colors.trim + "50";
            ctx.beginPath();
            ctx.ellipse(Math.cos(angle) * radius, Math.sin(angle) * radius, 2 + rng() * 4, 1 + rng() * 2,
                angle, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
    });

    // Union all roads before shading; alpha-overlapping strokes at junctions
    // used to create a giant target-shaped disc. The mask has no such seams.
    const mask = canvas(size), m = mask.getContext("2d");
    m.strokeStyle = "white"; m.fillStyle = "white"; m.lineCap = "round";
    layout.paths.forEach(path => {
        m.beginPath(); m.moveTo(path.x1 * p, path.y1 * p); m.lineTo(path.x2 * p, path.y2 * p);
        m.lineWidth = path.width * p; m.stroke();
    });
    if (room.type !== "boss") {
        m.beginPath(); m.arc(layout.center.x * p, layout.center.y * p, layout.plazaRadius * p, 0, Math.PI * 2); m.fill();
    }
    if (layout.court) {
        const r = layout.court;
        roundedRect(m, (r.x - r.hw) * p, (r.y - r.hh) * p, r.hw * p * 2, r.hh * p * 2, p * .3); m.fill();
    }
    if (layout.camp) {
        const r = layout.camp.area;
        m.beginPath(); m.ellipse(r.x * p, r.y * p, r.hw * p * .83, r.hh * p * .78, 0, 0, Math.PI * 2); m.fill();
    }
    const paving = canvas(size), t = paving.getContext("2d");
    t.fillStyle = colors.joint; t.fillRect(0, 0, c.width, c.height);
    // Staggered stone courses; the workshop instead has continuous wood
    // slats. Variation is deterministic and small enough to remain terrain.
    const tileW = p * (volume === 4 ? 2.0 : .95), tileH = p * (volume === 4 ? .33 : .64);
    for (let row = -1; row <= c.height / tileH; row++) {
        for (let col = -1; col <= c.width / tileW; col++) {
            const x = (col + (row & 1 ? .5 : 0)) * tileW, y = row * tileH;
            t.fillStyle = colors.tile[Math.floor(rng() * colors.tile.length)];
            roundedRect(t, x + 1, y + 1, tileW - 2, tileH - 2, volume === 4 ? .5 : 2); t.fill();
            t.strokeStyle = "#ffffff26"; t.lineWidth = .7;
            t.beginPath(); t.moveTo(x + 3, y + 2); t.lineTo(x + tileW - 3, y + 2); t.stroke();
            if (rng() < .14) {
                t.strokeStyle = colors.joint + "45";
                t.beginPath(); t.moveTo(x + tileW * .28, y + 2);
                t.lineTo(x + tileW * .44, y + tileH * .52);
                t.lineTo(x + tileW * .35, y + tileH - 2); t.stroke();
            }
        }
    }
    t.globalCompositeOperation = "destination-in"; t.drawImage(mask, 0, 0);
    ctx.globalAlpha = cfg.night ? .68 : .78;
    ctx.drawImage(paving, 0, 0); ctx.globalAlpha = 1;

    // Thin inset courses around the plaza are surface inlay, not new raised
    // collision geometry. The boss keeps its broad combat floor unobstructed.
    ctx.strokeStyle = colors.trim + "88"; ctx.lineWidth = 1.6;
    const radius = room.type === "boss" ? 8.5 : layout.plazaRadius - .32;
    ctx.beginPath(); ctx.arc(layout.center.x * p, layout.center.y * p, radius * p, 0, Math.PI * 2); ctx.stroke();
    if (room.type === "boss" || room.type === "chest") {
        ctx.save(); ctx.translate(layout.center.x * p, layout.center.y * p);
        ctx.strokeStyle = colors.trim + "66";
        ctx.rotate(Math.PI / 4); ctx.strokeRect(-p * .6, -p * .6, p * 1.2, p * 1.2); ctx.restore();
    }
    if (layout.camp) {
        const fire = layout.camp.props.find(prop => prop.role === 'fire');
        // A soft soot stain belongs to the authored ground, not to the source sprite.
        ctx.save(); ctx.translate(fire.x * p, fire.y * p); ctx.scale(1, .65);
        const soot = ctx.createRadialGradient(0, 0, p * .2, 0, 0, p * 1.15);
        soot.addColorStop(0, '#503c2a65'); soot.addColorStop(.55, '#76513920'); soot.addColorStop(1, '#76513900');
        ctx.fillStyle = soot; ctx.fillRect(-p * 1.2, -p * 1.2, p * 2.4, p * 2.4); ctx.restore();
    }

    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
    let material = null, geometry = null;
    try {
        material = new THREE.MeshBasicMaterial({ map: texture });
        geometry = new THREE.PlaneGeometry(size.w, size.h);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = "room-surface"; mesh.rotation.x = -Math.PI / 2;
        // Above the fallback floor (-.02), below contact shadows (-.016).
        // Boss arena geometry at -.01 remains the authoritative raised floor.
        mesh.position.set(size.w / 2, -.019, size.h / 2);
        mesh.frustumCulled = false;
        return { root: mesh, texture, material };
    } catch (error) {
        if (geometry) geometry.dispose();
        if (material) material.dispose();
        texture.dispose(); throw error;
    }
}
