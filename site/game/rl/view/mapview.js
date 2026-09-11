// Room assembly from the questmap kits (T09, spec/02 §3, spec/06 T09).
//
// The world layer (game/rl/world.js) hands over an abstract Room; this module
// instantiates it with the ORIGINAL game's map objects from
// asset/img/rl/mapkit (built by tools/build_mapkit.py). What that means
// concretely, all measured from the bundles:
//
//   * Every unit is a 2.5D paper card — a flat XY quad facing the fixed
//     camera azimuth (spec/02 §2). Props NEVER rotate around Y (that shows
//     the paper edge-on); the only rotation here is floor/water cards tipped
//     flat around X, which the camera still sees face-on.
//   * The serialized msbVisible:false on every kit mesh is the Meige scene
//     system's dormant default, not information — the whole kit ships with
//     it, so it is ignored here (unlike character models, where hidden
//     means hidden).
//   * Each kit ships ONE shared atlas texture per biome (mapkit.json
//     `texture`), so merging all static cards by texture collapses a room
//     into a couple of draw calls.
//   * `*_Edge` entries are NOT usable outline shells and are excluded. The
//     cards already carry their outline baked into the atlas art. A separate
//     `<name>_Edge` unit was worth merging behind its card only if it were a
//     silhouette at a known offset, and it is neither: build_mapkit.py
//     recentres every unit, so the authored body/shell offset is gone and any
//     z-shift is a guess that projects as a ghost at this 54° pitch; and the
//     naming is not a convention — `Gate_Edge` is a real maroon silhouette,
//     but `Build_Edge` is a cream sheet with a brown squiggle (it painted over
//     the blue houses in every screenshot), `Coral_C`'s shell is misspelled
//     `Cpral_C_Edge` in the source data, and GreenConch's are infixed
//     `GreenConch_Edge_L/R`. Looked at one card at a time at 4× (see
//     .cache/card_zoom.py), the mechanic loses more art than it adds.
//
// Composition per room (asset/rl/floors.json, hand-authored ratios):
//   ground  — three synthesized planes in the volume's authored colours: a
//             darkened surround (room plus overhang, so the fog dissolves the
//             edge), the room rect at full brightness (the step in brightness
//             at its border IS the wall line), and for `arena` rooms a disc
//             (see §ground below for why the kits cannot supply any of it)
//   border  — a ring of upright props inside the wall line, corridors kept
//             clear at the wall midpoints where doors always are
//   scatter  — interior decoration, off the spawn area and door corridors
//   anchor  — one semantic prop for the room type (boat/tent for shop, fire
//             for rest, aura for boss), against the far wall, scaled up
//   animated— units with real idle variation, cloned per placement and
//             driven by ONE shared AnimationMixer (spec/02 §3 rule 5)
//   shadow  — one merged mesh of squashed discs under the upright props, so
//             they stand on the ground instead of being pasted onto it
//
// Every pool draws from BOTH of the volume's kits (floors.json `biome` +
// `extra`) — no single questmap kit holds a room's vocabulary; 1011_2 has the
// trees but no wall, 1011_3 has the cliff faces but no undergrowth. And every
// kit interleaves usable props with unusable fragments of them (bare trunks
// beside canopies, outline shells named like their prop, black silhouettes,
// hill pieces) under one atlas and one naming scheme. Source-verified complete
// trees in 1011_2 are now grouped BEFORE recentring; other unverified fragments
// stay rejected by name: floors.json `excludes` globally and `exclude` per volume,
// where a leading "=" means whole-name (vol 4 must drop `board` but keep
// `cardboard_2`). The volume↔kit assignment itself was made by looking at each
// card cropped out of its atlas by its own UVs, one at a time.
//
// Static card meshes are merged per texture into single BufferGeometries
// (MeshBasicMaterial + alphaTest cutout, so the z-buffer orders the cards and
// merged triangles never need sorting).
//
// Determinism: every placement draws from createRandom seeded by room.seed,
// so the same room id always rebuilds the same layout (master plan §4.3).

import * as loader from "../../../core/loader.js";
import * as BufferGeometryUtils from "../../../vendor/three/BufferGeometryUtils.js";
import { createRandom, hash32 } from "../random.js";
import { ROOM_SIZE, roomSize } from "../dungeon.js";
import { createRoomLandmark, preloadRoomBuildings } from "./roomlandmarks.js";
import { createRoomLayout } from "./roomlayout.js";
import { floorShrineFor } from '../floorshrine.js';
import { createFloorShrineView, preloadFloorShrine } from './floorshrineview.js';
import { createRestCampView } from './restcampview.js';
import { createRoomSurface } from "./roomsurface.js";

let THREE = null;
loader.loadModules().then(function (modules) {
    THREE = modules.THREE;
});

const FLOORS_URL = "../asset/rl/floors.json";
const MAPKIT_URL = "../asset/rl/mapkit.json";
const MAPKIT_DIR = "../asset/img/rl/mapkit";

// Border props stand this far inside the wall line.
const BORDER_INSET = 1.1;
// Kit cards are authored for the quest map, where a room-sized area is a few
// hundred pixels wide: the tallest prop in the whole 64-kit library is a 1.5
// unit tent and the tallest tree is 1.1, against a ~1.6 unit character. Every
// card is therefore scaled uniformly on placement — one factor for the whole
// kit, so authored proportions between props survive — which puts a fir tree
// just above eye height and a tent at 2.4 units. Atlases are 512², and a card
// this size still samples at about 1:1 on a 1280-wide canvas, so the scale
// costs no sharpness.
export const PROP_SCALE = 1.6;
// A room's anchor (the shop's tent, the rest room's campfire, the boss gate)
// gets a further bump: it has to read as the thing the room is about from the
// doorway, against a ring built from the same pool.
const ANCHOR_SCALE = 1.35;
// Door corridors stay clear of props. Doors sit at the wall midpoints
// (dungeon.js doorAt) with a logic DOOR_BAND of 1.5; props also have width,
// so the visual clearance is wider than the walkable band.
const DOOR_CLEAR = 2.4;
// Nothing decorative within this radius of the room center (spawn area).
const CENTER_CLEAR = 2.2;
// The ground reaches this far past the wall line. The camera (height 9, back
// 6.5, fov 34) sees ~5.3 units beyond whatever it is centred on, so 3.0 left a
// strip of clear colour along the top of the frame whenever the player pressed
// against the far wall.
const FLOOR_OVERHANG = 16.0;
// Upright cards at least this wide (or wall category / MeshCollider source)
// become logic AABBs. Small flowers and grass never block movement. In CARD
// space, so PROP_SCALE applies on top: 1.0 here is a prop 1.6 units wide on
// screen, about a character's shoulders — the smallest thing a player would be
// annoyed to walk through.
const BIG_FOOTPRINT = 1.0;
const COLLIDER_MIN_HW = 0.3;
// Scatter placements keep this distance from each other.
const SPACING = 1.6;
// Water patches (T22c 房间类型差异化): a room-type recipe may ask for a few
// large flat water cards — puddles and ponds differentiate a battle room's
// floor from a rest room's without touching the synthesized ground. Only
// cards at least this wide read as water and not as a dropped rag; the tiny
// SeaAnemone_*_Edge water-category units stay out.
const WATER_PATCH_MIN_W = 1.0;
const WATER_PATCH_SCALE = 1.35;
// Prop recipes in floors.json are authored against the launch 16×12 room.
// The rooms grew to 24×18 (T21c); counts scale by area so the authored
// DENSITY survives — a ring of 12 trees around a 16-wide room is a wall, the
// same 12 around a 24-wide one is a dotted line.
const BASE_ROOM_AREA = 24 * 16;
// Static ground detail follows area; live animated props stay capped so a
// larger room does not multiply the number of per-frame mixers/draw calls.
function recipeCount(n, size) {
    return Math.round((n || 0) * size.w * size.h / BASE_ROOM_AREA);
}

// Effect sheets whose atlas is a flat white ramp (QuestMapObj_*_eff_white_noa,
// 136 bytes) are tinted per stage in the original. Untinted they place white
// shards over the arena, so they stay out of the prop pools until 阶段 8 owns
// their colour.
const WHITE_SHEET = /_eff_white/i;

// --- ground ------------------------------------------------------------------
//
// The kits ship no tileable ground. Every biome's one `floor`-category unit is
// a single decorative card -- 1011_1's meadow oval, 1011_6's lake, 1075_7's
// wooden pier -- so tiling it paves the room with piers instead of laying a
// surface, with the clear colour showing between cards. The 1015_* battle
// stages are worse than useless as floors: their `base` card is a round dais
// PAINTED IN 3/4 VIEW for the battle screen's front camera, so laying it flat
// under this camera double-applies the perspective and it reads as a wooden
// washtub the fight happens next to.
//
// So the ground is synthesized from the volume's authored colours
// (floors.json `ground`) in three layers, all sharing one seamless canvas
// texture and differing only by a colour multiplier:
//
//   surround — room plus overhang, darkened. Everything outside the wall line.
//   floor    — exactly the room rect, full brightness. The step in brightness
//              at its edge IS the wall: the room is bounded by collision, so
//              the player has to be able to see where.
//   arena    — a disc, for rooms whose recipe asks (boss). Decoration inside
//              the floor rect, never a substitute for it.

const GROUND_TILE = 256;        // canvas pixels per grain tile
const GROUND_PATCH = 2.2;       // world units one grain tile covers
const SURROUND_Y = -0.03;
const GROUND_Y = -0.02;
const ARENA_Y = -0.01;
const SURROUND_DIM = 0x8c8c8c;  // outside the walls
const ARENA_DIM = 0xc4c4c4;     // the boss stage disc
const ARENA_RIM = 0x9c9c9c;     // and the ring that makes it read as raised
const ARENA_RIM_WIDTH = 0.32;
const ARENA_COVER = 0.92;       // disc diameter over the room's short side
// Door strips (T21d): the lit path that opens the wall's brightness step at
// each doorway. Width matches DOOR_CLEAR — the corridor the prop ring already
// leaves empty — so the strip and the gap in the tree line read as one opening.
const DOOR_STRIP_W = 2.4;
const DOOR_STRIP_LEN = 3.2;
const DOOR_LOCKED_DIM = 0x8c8c8c;  // same read as the surround: the way is shut
const groundCache = new Map();  // "base|mottle" → { texture, floor, … }

// A ground stain and a contact shadow are the same drawing — a soft dark ellipse
// on the floor — so the synthesized ground carries its two scales in two
// different places, and neither of them can produce an ellipse.
//
// Grain lives in the texture. It is 1.5–4.6 px of speckle on a 256 px tile that
// covers GROUND_PATCH world units, i.e. features far smaller than the tile, so
// its repeat is invisible and the eye reads pebbles.
//
// Large-scale tone lives in the ground planes' VERTEX COLOURS. It cannot live in
// the texture: a patch big enough to read as tonal drift is a feature the size
// of the 2.2-unit tile itself, so it repeats about seven times across a 16×12
// room and the eye catches the period immediately — volume 4's sand came out as
// a regular field of overlapping soft ellipses, which is worse than the
// hard-edged version it replaced, and no amount of feathering fixes a periodic
// blotch. Interpolated vertex tone has no period inside the room and no edge
// anywhere, which is exactly what a shadow always has.
//
// Amplitude is measured, not chosen: as Weber contrast (|Δluma| / luma_base) the
// five authored base/mottle pairs run 8% (volume 1's sand, the one that was
// looked at and accepted) to 21% (volume 5's slate), while a contact shadow is a
// 20% black wash (SHADOW_ALPHA). Tone is capped at volume 1's separation so no
// volume's ground drifts as dark as a shadow.
const GROUND_WEBER = 0.085;
// World units per tone lattice cell, and per plane subdivision. The cell is
// wider than the room's short side so the room shows part of a swell rather
// than a tiling of them; the subdivision has to be finer than the cell or the
// interpolation is what samples the noise.
const TONE_PERIOD = 13.0;
const TONE_SEGMENT = 1.3;

function rgbOf(text) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(text).trim());
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

function lumaOf(rgb) {
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

// Smooth value noise on an integer lattice, hashed so it is deterministic
// without a seeded stream: the ground is rebuilt per room and must not drift.
function toneNoise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const sx = (x - xi) * (x - xi) * (3 - 2 * (x - xi));
    const sy = (y - yi) * (y - yi) * (3 - 2 * (y - yi));
    const at = function (ix, iy) {
        return (hash32("tone:" + ix + ":" + iy) >>> 8) / 0xffffff;
    };
    const top = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx;
    const bottom = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
    return top + (bottom - top) * sy;
}

function groundKit(cfg) {
    const colors = (cfg && cfg.ground) || {};
    const base = colors.base || "#c9c4b4";
    const mottle = colors.mottle || base;
    const key = base + "|" + mottle;
    if (groundCache.has(key)) {
        return groundCache.get(key);
    }
    // Tone amplitude comes from the volume's own pair, capped (§GROUND_WEBER):
    // a palette authored closer together than the cap keeps its own subtlety.
    const baseRGB = rgbOf(base);
    const mottleRGB = rgbOf(mottle);
    let amp = GROUND_WEBER;
    if (baseRGB && mottleRGB) {
        const baseLuma = lumaOf(baseRGB);
        const weber = baseLuma > 1
            ? Math.abs(lumaOf(mottleRGB) - baseLuma) / baseLuma
            : 0;
        amp = Math.min(GROUND_WEBER, weber);
    }
    const canvas = document.createElement("canvas");
    canvas.width = GROUND_TILE;
    canvas.height = GROUND_TILE;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, GROUND_TILE, GROUND_TILE);
    ctx.fillStyle = mottle;
    // Seamless by construction: every speck is drawn in all nine wrap offsets,
    // so one crossing an edge continues across the opposite edge.
    const rng = createRandom(hash32("ground:" + key));
    const speck = function (r, alpha) {
        const x = rng() * GROUND_TILE;
        const y = rng() * GROUND_TILE;
        ctx.globalAlpha = alpha;
        for (let ox = -1; ox <= 1; ox++) {
            for (let oy = -1; oy <= 1; oy++) {
                ctx.save();
                ctx.translate(x + ox * GROUND_TILE, y + oy * GROUND_TILE);
                ctx.scale(1, 0.8);
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }
    };
    // Grain only, at full authored strength: a speck is 1.5–4.6 px and reads as
    // a pebble however dark it is. Two sizes, because one is a screen door.
    for (let i = 0; i < 70; i++) {
        speck(GROUND_TILE * (0.006 + rng() * 0.012), 0.35 + rng() * 0.45);
    }
    for (let i = 0; i < 130; i++) {
        speck(GROUND_TILE * (0.002 + rng() * 0.004), 0.25 + rng() * 0.35);
    }
    ctx.globalAlpha = 1;
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    // The ground is the one surface this camera sees almost edge-on, so its
    // mip chain is chosen by the compressed axis and the speckle smears to a
    // flat tone past mid-screen without this. three.js clamps to the device max.
    texture.anisotropy = 8;
    const material = function (dim) {
        return new THREE.MeshBasicMaterial({
            map: texture, color: dim, vertexColors: true
        });
    };
    const kit = {
        texture: texture,
        amp: amp,
        floor: material(0xffffff),
        surround: material(SURROUND_DIM),
        arena: material(ARENA_DIM),
        rim: material(ARENA_RIM)
    };
    groundCache.set(key, kit);
    return kit;
}


// One texture instance serves every layer: the repeat lives in the geometry's
// UVs instead, so planes of different sizes keep one physical patch scale.
//
// The large-scale tone is written here as vertex colour (§GROUND_WEBER). Every
// layer gets a COLOR attribute even at amp 0 — the materials are shared and
// declare vertexColors, so a geometry without one would sample an unbound
// attribute and come out black.
function groundLayer(geometry, material, worldW, worldH, y, amp, origin, size = ROOM_SIZE) {
    const ox = origin ? origin.x : size.w / 2;
    const oz = origin ? origin.y : size.h / 2;
    const uv = geometry.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * worldW / GROUND_PATCH,
            uv.getY(i) * worldH / GROUND_PATCH);
    }
    uv.needsUpdate = true;
    const position = geometry.getAttribute("position");
    const tint = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
        // The mesh is tipped -90° about X and centred on `origin`, so a plane's
        // local (x, y) lands at world (ox + x, _, oz - y). Sampling in world
        // space is what makes the surround, the room rect and the door strips
        // agree along their shared edges, leaving the wall line a pure
        // brightness step.
        const wx = ox + position.getX(i);
        const wz = oz - position.getY(i);
        const t = amp ? amp * toneNoise(wx / TONE_PERIOD, wz / TONE_PERIOD) : 0;
        // Vertex colour multiplies in linear light while the amplitude was
        // measured on encoded luma, so the requested step is un-gamma'd here;
        // written straight it would land at about amp/2.2 on screen.
        const v = t ? Math.pow(1 - t, 2.2) : 1;
        tint[i * 3] = v;
        tint[i * 3 + 1] = v;
        tint[i * 3 + 2] = v;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(tint, 3));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;      // tipped flat around X, never Y
    mesh.position.set(ox, y, oz);
    mesh.frustumCulled = false;
    return mesh;
}

// Per-room material for the door strips: a clone of the floor's so locking a
// room (battle uncleared) dims only the strips, never the floor itself.
// Owned by the room candidate, never by a module-global in-flight build.
function doorMaterial(kit, owner) {
    if (!owner.doorMat) {
        owner.doorMat = kit.floor.clone();
    }
    return owner.doorMat;
}

// One doorway's lit path: runs outward from the wall midpoint into the
// surround, at the room floor's own height and with the floor's own tone, so
// the wall's brightness step opens up instead of ending.
function doorStrip(kit, side, amp, owner, size) {
    const geometry = new THREE.PlaneGeometry(DOOR_STRIP_W, DOOR_STRIP_LEN, 2, 3);
    const origin = { x: 0, y: 0 };
    if (side === "N") {
        origin.x = size.w / 2; origin.y = 0;
        geometry.translate(0, DOOR_STRIP_LEN / 2, 0);
    } else if (side === "S") {
        origin.x = size.w / 2; origin.y = size.h;
        geometry.translate(0, -DOOR_STRIP_LEN / 2, 0);
    } else {
        geometry.rotateZ(Math.PI / 2);
        if (side === "W") {
            origin.x = 0; origin.y = size.h / 2;
            geometry.translate(-DOOR_STRIP_LEN / 2, 0, 0);
        } else {
            origin.x = size.w; origin.y = size.h / 2;
            geometry.translate(DOOR_STRIP_LEN / 2, 0, 0);
        }
    }
    const along = (side === "N" || side === "S")
        ? [DOOR_STRIP_W, DOOR_STRIP_LEN] : [DOOR_STRIP_LEN, DOOR_STRIP_W];
    const mesh = groundLayer(geometry, doorMaterial(kit, owner), along[0], along[1],
        GROUND_Y, amp, origin);
    mesh.name = "door:" + side;
    return mesh;
}

function groundGroup(cfg, arena, doors, owner) {
    const kit = groundKit(cfg);
    const size = owner.size, origin = { x: size.w / 2, y: size.h / 2 };
    const group = new THREE.Group();
    group.name = "ground";
    owner.group.add(group);     // partial builds are owned before any later step can fail
    const outerW = size.w + FLOOR_OVERHANG * 2;
    const outerH = size.h + FLOOR_OVERHANG * 2;
    // Subdivided at TONE_SEGMENT so the tone lattice is sampled by the vertices
    // rather than by the interpolation between two corners.
    group.add(groundLayer(new THREE.PlaneGeometry(outerW, outerH,
        Math.ceil(outerW / TONE_SEGMENT), Math.ceil(outerH / TONE_SEGMENT)),
        kit.surround, outerW, outerH, SURROUND_Y, kit.amp, origin));
    group.add(groundLayer(new THREE.PlaneGeometry(size.w, size.h,
        Math.ceil(size.w / TONE_SEGMENT), Math.ceil(size.h / TONE_SEGMENT)),
        kit.floor, size.w, size.h, GROUND_Y, kit.amp, origin));
    if (arena) {
        const d = Math.min(size.w, size.h) * ARENA_COVER;
        // Rim first (it sits just outside the disc, so the two never overlap):
        // a bright disc alone reads as a light patch, a disc with a darker ring
        // around it reads as a raised stage — the same brightness-step trick
        // the room rect uses for its wall line.
        //
        // Both get amp 0: a circle fan and a ring only have vertices on their
        // rings, so tone written onto them could only vary with angle, which is
        // a pinwheel, not ground.
        const outer = d / 2 + ARENA_RIM_WIDTH;
        group.add(groundLayer(new THREE.RingGeometry(d / 2, outer, 64),
            kit.rim, outer * 2, outer * 2, ARENA_Y - 0.002, 0, origin));
        group.add(groundLayer(new THREE.CircleGeometry(d / 2, 64),
            kit.arena, d, d, ARENA_Y, 0, origin));
    }
    (doors || []).forEach(function (side) {
        group.add(doorStrip(kit, side, kit.amp, owner, size));
    });
    return group;
}

// --- prop shadows -------------------------------------------------------------
//
// Kit cards are unlit cutouts with nothing under them, so an upright prop looks
// pasted onto the ground rather than standing on it. One squashed disc per prop
// fixes the contact; they all merge into a single transparent mesh, so the whole
// ring of 42 costs one draw call. Squashed because the camera is pitched 54°:
// a circle on the ground already projects as an ellipse, and flattening it
// further is what reads as "shadow" instead of "coaster".
const SHADOW_Y = GROUND_Y + 0.004;
const SHADOW_ALPHA = 0.2;
const SHADOW_SQUASH = 0.46;
const SHADOW_MIN_R = 0.22;
let shadowTemplate = null;
let shadowMaterial = null;

function shadowDisc() {
    if (!shadowTemplate) {
        // position+uv only, non-indexed: the same shape mergeGeometries accepts
        // from collectGeometries, so both can share one merge path if needed.
        const disc = new THREE.CircleGeometry(1, 14).toNonIndexed();
        disc.deleteAttribute("normal");
        shadowTemplate = disc;
    }
    return shadowTemplate;
}

function shadowMat() {
    if (!shadowMaterial) {
        shadowMaterial = new THREE.MeshBasicMaterial({
            color: 0x000000,
            transparent: true,
            opacity: SHADOW_ALPHA,
            depthWrite: false       // never occlude a prop standing behind it
        });
    }
    return shadowMaterial;
}

// --- documents ------------------------------------------------------------------

let docsPromise = null;
let floorsDoc = null;       // cached once loaded; accessors below need it sync
let kitDoc = null;

function loadDocs() {
    if (!docsPromise) {
        docsPromise = Promise.all([
            fetch(MAPKIT_URL).then(function (r) {
                if (!r.ok) { throw new Error("mapkit.json " + r.status); }
                return r.json();
            }),
            fetch(FLOORS_URL).then(function (r) {
                if (!r.ok) { throw new Error("floors.json " + r.status); }
                return r.json();
            })
        ]).then(function (docs) {
            kitDoc = docs[0];
            floorsDoc = docs[1];
            return docs;
        }).catch(function (error) {
            docsPromise = null;
            throw error;
        });
    }
    return docsPromise;
}

function requireFloors() {
    if (!floorsDoc) {
        throw new Error("floors.json not loaded yet (await preloadVolume first)");
    }
    return floorsDoc;
}

// Volume config for a given floor. Each 卷 is 4 生态段 × 5 层 (roguelike-plan
// §0.2); `segments` is a sparse overlay on the volume base — segment 0 is the
// base itself (its entry stays `{}`), later segments override only the fields
// they carry. Shallow merge on purpose: a segment that reassigns the biome
// authors a complete ground/prefer pair, not a patch on the previous segment.
export function volumeConfig(volume, floor) {
    const volumes = requireFloors().volumes || {};
    const base = volumes[String(volume)] || volumes["1"];
    const segments = base && base.segments;
    if (!segments || !segments.length || !(floor >= 1)) { return base; }
    const segIndex = Math.min(segments.length - 1, Math.floor((floor - 1) / 5));
    const seg = segments[segIndex] || {};
    const merged = Object.assign({}, base, seg);
    delete merged.segments;
    return merged;
}

// The biome a room renders with.
// Every room in a 卷-segment is dressed from the same pair of kits, boss
// included: the boss room is told apart by its arena disc and its 42-prop
// ring, not by a different biome. (An earlier table gave the boss its own kit;
// the 13 kits that role could point at turned out to ship no usable props at
// all.)
export function biomeFor(room, volume, floor) {
    return volumeConfig(volume, floor).biome;
}

// --- kit cache -------------------------------------------------------------------

// Successful units/atlases are shared; failed or cancelled requests are not.
const kitCache = new Map();
const materialCache = new Map();     // "biome/texture" → MeshBasicMaterial
const atlasRequests = new Map();
const atlasAttempts = new Map();

// Kit cards are unlit cutouts, so scene.js's moonlight key can never reach
// them: on volume 5 the 1011_8 sandstone rocks came out at full daylight
// brightness and were the brightest thing in a slate-and-fog night room. The
// only honest knob on an unlit material is its colour multiplier, so night
// volumes get the light the cards would have received if they were lit —
// scene.js's night key #c9d4f0 at that volume's 0.8 ambient — applied directly.
const NIGHT_TINT = 0xa1a9bf;

// One material per biome/texture is shared by the merged static meshes and the
// animated clones alike, and a room only ever shows one volume, so the tint is
// set on activation, never while preparing an off-scene candidate.
function tintKits(kits, tint) {
    kits.forEach(function (kit) {
        kit.units.forEach(function (unit) {
            const material = materialCache.get(
                unit.entry.biome + "/" + unit.entry.texture);
            if (material) { material.color.setHex(tint); }
        });
    });
}

function kitMaterial(biome, texture) {
    const key = biome + "/" + texture;
    if (materialCache.has(key)) {
        return Promise.resolve(materialCache.get(key));
    }
    if (atlasRequests.has(key)) { return atlasRequests.get(key).promise; }
    const attempt = (atlasAttempts.get(key) || 0) + 1;
    atlasAttempts.set(key, attempt);
    // ImageLoader coalesces equal in-flight URLs. A retry must not attach to
    // the very image request that timed out, even after our promise is reset.
    const url = MAPKIT_DIR + "/" + key + (attempt > 1 ? "?loadAttempt=" + attempt : "");
    const request = { promise: null, cancel: null };
    request.promise = new Promise(function (resolve, reject) {
        let finished = false;
        function fail(error) {
            if (finished) { return; }
            finished = true;
            if (atlasRequests.get(key) === request) { atlasRequests.delete(key); }
            reject(error);
        }
        request.cancel = function () { fail(new Error("地图图集请求已取消：" + key)); };
        // A kit is ready only after its atlas decodes. Cancelled images may
        // finish later, but own no live material and must release their texture.
        const pending = new THREE.TextureLoader().load(url, function (map) {
            if (finished) { map.dispose(); return; }
            finished = true;
            map.colorSpace = THREE.SRGBColorSpace;
            map.flipY = false;       // glTF's top-left UV origin, not a mirrored atlas
            const material = new THREE.MeshBasicMaterial({
                alphaTest: 0.5, side: THREE.DoubleSide, map: map
            });
            materialCache.set(key, material);
            atlasRequests.delete(key);
            resolve(material);
        }, undefined, function () {
            pending.dispose();
            fail(new Error("地图图集加载失败：" + key));
        });
    });
    atlasRequests.set(key, request);
    return request.promise;
}

function disposeTemplate(template, materials = false) {
    const geometries = new Set(), ownedMaterials = new Set();
    template.traverse(function (child) {
        if (child.geometry) { geometries.add(child.geometry); }
        if (materials && child.material) {
            (Array.isArray(child.material) ? child.material : [child.material])
                .forEach(function (material) { ownedMaterials.add(material); });
        }
    });
    geometries.forEach(function (geometry) { geometry.dispose(); });
    ownedMaterials.forEach(function (material) { material.dispose(); });
}

function loadUnit(biome, entry) {
    return loader.readModel(MAPKIT_DIR + "/" + biome + "/" + entry.file, "gzip")
        .then(function (blob) {
            return loader.loadModules().then(function (modules) {
                const url = URL.createObjectURL(blob);
                return new Promise(function (resolve, reject) {
                    new modules.GLTFLoader().load(url, resolve, undefined, reject);
                }).then(function (gltf) {
                    const template = gltf.scene;
                    return kitMaterial(biome, entry.texture).then(function (material) {
                        const replaced = new Set();
                        template.traverse(function (child) {
                            if (!child.isMesh) { return; }
                            (Array.isArray(child.material) ? child.material : [child.material])
                                .forEach(function (old) { if (old) { replaced.add(old); } });
                            child.material = material;
                            child.castShadow = false;
                            child.receiveShadow = false;
                        });
                        replaced.forEach(function (old) { old.dispose(); });
                        return { template: template, clips: gltf.animations || [], entry: entry };
                    }, function (error) {
                        disposeTemplate(template, true);
                        throw error;
                    });
                }).finally(function () { URL.revokeObjectURL(url); });
            });
        });
}

function kitPromise(biome, strict = false) {
    if (!kitCache.has(biome)) {
        kitCache.set(biome, { units: new Map(), promise: null, generation: 0 });
    }
    const kit = kitCache.get(biome);
    const entries = kitDoc.entries.filter(function (e) { return e.biome === biome; });
    if (!kit.promise) {
        const generation = kit.generation;
        kit.promise = Promise.all(entries.filter(function (entry) {
            return !kit.units.has(entry.name);
        }).map(function (entry) {
            return loadUnit(biome, entry).then(function (unit) {
                if (generation !== kit.generation) { disposeTemplate(unit.template); return; }
                kit.units.set(entry.name, unit);
            }).catch(function (error) {
                console.warn("mapkit unit failed:", biome + "/" + entry.name, error);
            });
        })).then(function () { return kit; }).finally(function () {
            if (generation === kit.generation) { kit.promise = null; }
        });
    }
    return kit.promise.then(function () {
        const missing = entries.filter(function (entry) { return !kit.units.has(entry.name); });
        if (strict && (!entries.length || missing.length)) {
            throw new Error("地图套件未完整加载：" + biome + "（缺少 " + missing.length + " 项），请重试。");
        }
        return kit;
    });
}

function retryKits(names) {
    // GLTFLoader cannot abort; generations let a retry bypass a timed-out
    // request without allowing the old result to overwrite a current unit.
    names.forEach(function (biome) {
        const kit = kitCache.get(biome);
        if (kit) { kit.generation += 1; kit.promise = null; }
        kitDoc.entries.filter(function (entry) { return entry.biome === biome; })
            .forEach(function (entry) {
                const request = atlasRequests.get(biome + "/" + entry.texture);
                if (request) { request.cancel(); }
            });
    });
}

// T22g: a live clone of a kit card, for the room's interactables (breakable
// barrels, the altar crystal). Static props merge into the room geometry and
// can never come back out, so anything that has to disappear on interaction
// stays its own object. The card's kit loads on demand — the barrel and
// crystal cards live in 1075_0, which is not every volume's biome — and
// kitPromise caches, so the first clone pays one fetch per session.
export function cloneMapCard(name) {
    return loadDocs().then(function () {
        const entry = kitDoc.entries.find(function (e) { return e.name === name; });
        if (!entry) {
            throw new Error("no mapkit card named " + name);
        }
        return kitPromise(entry.biome).then(function (kit) {
            const unit = kit.units.get(entry.name);
            if (!unit) {
                throw new Error("mapkit unit missing: " + entry.biome + "/" + entry.name);
            }
            return { unit: unit, entry: entry };
        });
    });
}

// --- pool selection ----------------------------------------------------------------

// Patterns are lowercase substrings, except that a leading "=" means the whole
// name. floors.json needs both: vol 4 has to drop the outline shell literally
// named `board` while keeping the prop named `cardboard_2`, and a substring
// rule cannot express that.
function matchesAny(name, patterns) {
    const lower = name.toLowerCase();
    for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i];
        const hit = pattern.charAt(0) === "="
            ? lower === pattern.slice(1)
            : lower.indexOf(pattern) !== -1;
        if (hit) {
            return true;
        }
    }
    return false;
}

// Pool = units of the wanted categories from every kit of the 卷 (main + extra),
// minus excluded abstract/frame units. `prefer` orders the pool (substring
// rank), footprint width breaks ties descending — every biome then yields its
// most room-appropriate AND visible props, even when the prefer list names
// things the biome lacks.
function pickPool(kits, categories, prefer, excludes) {
    const list = [];
    kits.forEach(function (kit) {
        kit.units.forEach(function (unit) {
            if (categories.indexOf(unit.entry.category) === -1) { return; }
            if (matchesAny(unit.entry.name, excludes)) { return; }
            if (WHITE_SHEET.test(unit.entry.texture || "")) { return; }
            list.push(unit);
        });
    });
    const rank = function (unit) {
        for (let i = 0; i < prefer.length; i++) {
            if (matchesAny(unit.entry.name, [prefer[i]])) {
                return i;
            }
        }
        return prefer.length;
    };
    list.sort(function (a, b) {
        const byRank = rank(a) - rank(b);
        if (byRank !== 0) { return byRank; }
        return b.entry.footprint[0] - a.entry.footprint[0];
    });
    return list;
}

// --- geometry merge ------------------------------------------------------------------

// Collect a template's meshes as world-transformed geometries into the
// per-texture bucket. Only POSITION/UV survive, and by allowlist rather than
// blocklist: mergeGeometries needs the whole bucket to agree on its attribute
// set and returns null on the first mismatch, and mapview then drops the
// bucket — so ONE odd card silently erases every prop sharing its atlas.
// 1018_8's GroundSheet is a SkinnedMesh; on a `skinIndex` blocklist miss it
// took the luggage, sandals and juice down with it.
//
// `seat` re-seats a tipped card onto y=0: a kit centres its units at the node
// level, and those offsets are arbitrary along the card plane's normal —
// GroundSheet's plane lives at z=-0.12 — so tipping turns an invisible depth
// offset into height and lays the mat 0.19 UNDER a floor only 0.02 down.
// Seating the baked bbox erases the whole class without a per-card table.
function collectGeometries(root, matrix, bucket, seat) {
    root.updateMatrixWorld(true);
    root.traverse(function (child) {
        if (!child.isMesh || !child.geometry) { return; }
        if (!child.geometry.getAttribute("position") || !child.geometry.getAttribute("uv")) {
            return;
        }
        const geometry = child.geometry.clone();
        geometry.applyMatrix4(child.matrixWorld);
        if (matrix) { geometry.applyMatrix4(matrix); }
        if (seat) {
            geometry.computeBoundingBox();
            geometry.translate(0, -geometry.boundingBox.min.y, 0);
        }
        Object.keys(geometry.attributes).forEach(function (key) {
            if (key !== "position" && key !== "uv") {
                geometry.deleteAttribute(key);
            }
        });
        geometry.morphAttributes = {};
        // mergeGeometries needs all-or-none indexed; quads are tiny, so
        // normalizing to non-indexed costs little and always merges
        if (geometry.index) {
            bucket.push(geometry.toNonIndexed());
            geometry.dispose();
        } else { bucket.push(geometry); }
    });
}

// --- placement -----------------------------------------------------------------------

let rotFlatMatrix = null;
let scaleMatrix = null;

function propScale() {
    if (!scaleMatrix) {
        scaleMatrix = new THREE.Matrix4().makeScale(PROP_SCALE, PROP_SCALE, PROP_SCALE);
    }
    return scaleMatrix;
}

// Card space, read off the GLB POSITION accessors: x is centered on 0 and
// y runs [0, h] upward from the card's foot. Tipping it flat around X sends
// +y to −z, so the card would lie one full depth *behind* its placement point;
// pre-translating by −h/2 (i.e. down in card space) is what centers it. The
// scale sits between the two, so the recentring shrinks with the card and the
// placement point stays the middle of the flat card.
function flatMatrix(x, z, cardH, scale) {
    if (!rotFlatMatrix) {
        rotFlatMatrix = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    }
    const m = new THREE.Matrix4().makeTranslation(x, 0, z);
    m.multiply(rotFlatMatrix);
    if (scale && scale !== 1) {
        m.multiply(new THREE.Matrix4().makeScale(
            PROP_SCALE * scale, PROP_SCALE * scale, PROP_SCALE * scale
        ));
    } else {
        m.multiply(propScale());
    }
    m.multiply(new THREE.Matrix4().makeTranslation(0, -cardH / 2, 0));
    return m;
}

// Upright cards keep their foot on the ground, so the scale goes after the
// translation and grows the card upward from its placement point.
function uprightMatrix(x, z, zOffset, scale) {
    const m = new THREE.Matrix4().makeTranslation(x, 0, z + (zOffset || 0));
    if (scale && scale !== 1) {
        return m.multiply(new THREE.Matrix4().makeScale(
            PROP_SCALE * scale, PROP_SCALE * scale, PROP_SCALE * scale
        ));
    }
    return m.multiply(propScale());
}

function inDoorCorridor(x, y, size) {
    const midX = Math.abs(x - size.w / 2) < DOOR_CLEAR;
    const midY = Math.abs(y - size.h / 2) < DOOR_CLEAR;
    return (midX && (y < DOOR_CLEAR || y > size.h - DOOR_CLEAR))
        || (midY && (x < DOOR_CLEAR || x > size.w - DOOR_CLEAR));
}

function borderSpots(total, rng, size) {
    const spots = [];
    const sides = [
        { len: size.w, at: function (t) { return { x: t, y: BORDER_INSET }; } },
        { len: size.w, at: function (t) { return { x: t, y: size.h - BORDER_INSET }; } },
        { len: size.h, at: function (t) { return { x: BORDER_INSET, y: t }; } },
        { len: size.h, at: function (t) { return { x: size.w - BORDER_INSET, y: t }; } }
    ];
    const perimeter = 2 * (size.w + size.h);
    sides.forEach(function (side) {
        const n = Math.max(1, Math.round(total * side.len / perimeter));
        for (let i = 0; i < n; i++) {
            const t = (i + 0.5 + (rng() - 0.5) * 0.6) * side.len / n;
            const p = side.at(t);
            if (!inDoorCorridor(p.x, p.y, size)) {
                spots.push(p);
            }
        }
    });
    return spots;
}

function scatterSpots(count, rng, taken, layout, size) {
    const out = [];
    let guard = count * 40;
    while (out.length < count && guard-- > 0) {
        // Scatter belongs to one of the garden courts. A broad uniform field
        // made the old map look unfinished: valid cards had no relationship
        // to one another and left an empty center with no usable composition.
        const bed = layout && layout.beds.length
            ? layout.beds[Math.floor(rng() * layout.beds.length)] : null;
        const x = bed ? bed.x + (rng() - .5) * bed.radius * 1.5
            : 1.4 + rng() * (size.w - 2.8);
        const y = bed ? bed.y + (rng() - .5) * bed.radius * 1.5
            : 1.4 + rng() * (size.h - 2.8);
        if (Math.hypot(x - size.w / 2, y - size.h / 2) < CENTER_CLEAR) { continue; }
        if (inDoorCorridor(x, y, size)) { continue; }
        if (layout && layout.isProtected(x, y, .35)) { continue; }
        let clash = false;
        for (let i = 0; i < taken.length; i++) {
            if (Math.hypot(x - taken[i].x, y - taken[i].y) < SPACING) { clash = true; break; }
        }
        if (clash) { continue; }
        out.push({ x: x, y: y });
        taken.push({ x: x, y: y });
    }
    return out;
}

// --- module -------------------------------------------------------------------------

// `volume` decides the ground palette (floors.json `ground`) and supplies the
// surround kit for arenas; the biome passed to buildRoom decides the props.
export function createMapView(scene, volume) {
    const vol = volume || 1;
    let currentFloor = 1;
    let active = null;
    let buildRequest = 0, lifetime = 0;
    const candidates = new Set();

    // The 20-layer descent (spec/02 §3): one 卷 spans 4 segments, and each
    // segment reads its own kit pair, fog and ground out of floors.json.
    // main.js advances this before regenerating the dungeon for floor N+1.
    function setFloor(floor) {
        const next = Math.max(1, floor | 0);
        if (next !== currentFloor) { buildRequest += 1; }
        currentFloor = next;
    }

    function releaseRoom(candidate) {
        if (!candidate || candidate.disposed) { return; }
        candidate.disposed = true;
        candidates.delete(candidate);
        candidate.group.removeFromParent();
        if (candidate.landmark) { candidate.landmark.dispose(); }
        if (candidate.floorShrine) { candidate.floorShrine.dispose(); }
        if (candidate.restCamp) { candidate.restCamp.dispose(); }
        const geometries = new Set();
        candidate.group.traverse(function (child) {
            // animated clones SHARE geometry with the cached template —
            // only room-owned merged geometry may be disposed here
            if (child.geometry && !child.userData.sharedGeometry) {
                geometries.add(child.geometry);
            }
        });
        geometries.forEach(function (geometry) { geometry.dispose(); });
        if (candidate.mixer) {
            candidate.mixer.stopAllAction();
            candidate.animatedRoots.forEach(function (root) { candidate.mixer.uncacheRoot(root); });
            candidate.mixer.uncacheRoot(candidate.group);
        }
        if (candidate.doorMat) { candidate.doorMat.dispose(); }
        if (candidate.surfaceMaterial) { candidate.surfaceMaterial.dispose(); }
        if (candidate.surfaceTexture) { candidate.surfaceTexture.dispose(); }
    }

    function disposeRoom() {
        buildRequest += 1; lifetime += 1;
        candidates.forEach(releaseRoom);
        active = null;
    }

    // Battle rooms lock their doors until cleared (world.roomLocked): the
    // strips dim to the surround's read while locked. No-ops before the
    // first build and for rooms built without doors.
    function setDoorsLocked(locked) {
        if (active && active.doorMat) { active.doorMat.color.set(locked ? DOOR_LOCKED_DIM : 0xffffff); }
    }

    // buildRoom(room, biome?, doors?) → Promise<{ colliders, placements, buildMs }>
    // Synchronous in practice once the volume's kits are preloaded
    // (preloadVolume); the promise only covers the very first load.
    // The biome argument is optional — an explicit biome only exists so the
    // view gate can rebuild the start room deterministically; the floor's own
    // segment config is the source of truth. `doors` (T21d) is the room's
    // door sides; without it no strips are built, so legacy two-arg callers
    // (the view gate) see the room they always saw.
    function prepareRoom(room, biome, doors, options = {}) {
        const started = performance.now();
        const size = roomSize(room);
        const floor = options.floor === undefined ? currentFloor : options.floor;
        const generation = lifetime;
        return loadDocs().then(function () {
            const cfg = volumeConfig(vol, floor);
            // A 卷 dresses from its main biome plus any number of `extra`
            // kits (T22c widened the pair to a trio: `extra` + `extra2`).
            // Neither questmap kit alone holds a room's vocabulary —
            // 1011_2 has the trees but no wall, 1011_3 has the cliff faces but
            // no undergrowth — so the pools are the UNION of all of them,
            // ordered by the volume's prefer list. (Not a fallback: a fallback
            // only ever shows the second kit when the first is empty, which
            // never happens, so the second kit was dead weight in the preload.)
            const kitNames = [biome || cfg.biome, cfg.extra, cfg.extra2]
                .filter(function (name, i, all) {
                    return name && all.indexOf(name) === i;
                });
            return Promise.all(kitNames.map(function (name) { return kitPromise(name, !!options.strict); }))
                .then(async function (loaded) {
                const kits = loaded;
                if (generation !== lifetime) { throw new Error("地图装配请求已失效。"); }
                if (!THREE) { throw new Error("three not ready"); }
                const floors = requireFloors();
                const recipe = (floors.rooms || {})[room.type]
                    || (floors.rooms || {}).battle || {};
                // Global fragment names plus this volume's own: the kits name
                // their unusable pieces (bare trunks, outline shells, hill
                // silhouettes) exactly like their props, and build_mapkit.py
                // recentres every placement unit. Verified trees are composed
                // in the exporter; unverified fragments stay excluded here.
                const excludes = (floors.excludes || []).concat(cfg.exclude || []);
                const prefer = cfg.prefer || {};
                // A card's projection is not in its category. `water`/`floor`
                // cards are painted from above and mapview always laid them
                // down, but a few `prop` cards are painted from above too —
                // 1075_3's cardboard_0/_1 are folded sheets seen from overhead,
                // and stood upright they read as pale bars hovering over their
                // own contact shadow. floors.json names them per volume.
                const flatNames = cfg.flat || [];
                const laysFlat = function (entry) {
                    return entry.category === "water" || entry.category === "floor"
                        || matchesAny(entry.name, flatNames);
                };
                const rng = createRandom((room.seed ^ hash32("mapview:" + room.type)) >>> 0);

                const group = new THREE.Group();
                group.name = "room:" + room.id;
                let mixer = null;
                const candidate = { group, floor, size, kits, tint: cfg.night ? NIGHT_TINT : 0xffffff,
                    mixer: null, doorMat: null, animatedRoots: [], disposed: false, result: null,
                    dispose: function () { if (active !== candidate) { releaseRoom(candidate); } } };
                candidates.add(candidate);

                // texture path → geometry list; one merged mesh per texture
                const buckets = new Map();
                const bucketOf = function (unit) {
                    const key = unit.entry.biome + "/" + unit.entry.texture;
                    if (!buckets.has(key)) { buckets.set(key, []); }
                    return buckets.get(key);
                };

                const colliders = [];
                const placements = [];
                const taken = [];
                const shadows = [];
                try {
                const landmark = await createRoomLandmark(THREE, room, vol);
                if (candidate.disposed || generation !== lifetime) {
                    if (landmark) { landmark.dispose(); }
                    throw new Error("地图装配请求已失效。");
                }
                candidate.landmark = landmark;
                if (landmark) {
                    group.add(landmark.root);
                    colliders.push(landmark.collider); placements.push(landmark.placement);
                    taken.push(landmark.collider);
                }
                const floorShrine = await createFloorShrineView(THREE, room);
                if (candidate.disposed || generation !== lifetime) {
                    if (floorShrine) { floorShrine.dispose(); }
                    throw new Error('雕像装配请求已失效。');
                }
                candidate.floorShrine = floorShrine;
                if (floorShrine) { group.add(floorShrine.object); placements.push(floorShrine.placement); }
                const restCamp = await createRestCampView(THREE, room);
                if (candidate.disposed || generation !== lifetime) {
                    if (restCamp) restCamp.dispose();
                    throw new Error('营地装配请求已失效。');
                }
                candidate.restCamp = restCamp;
                if (restCamp) {
                    group.add(restCamp.object);
                    colliders.push(...restCamp.colliders); placements.push(...restCamp.placements);
                    taken.push(...restCamp.colliders);
                }
                const layout = createRoomLayout(landmark, doors, size, floorShrineFor(room), restCamp?.camp);
                candidate.layout = layout;
                const surface = createRoomSurface(THREE, cfg, layout, room, vol);
                candidate.surfaceMaterial = surface.material;
                candidate.surfaceTexture = surface.texture;
                group.add(surface.root);
                function overlapsLandmark(entry, x, y, scale) {
                    if (!landmark) { return false; }
                    const box = landmark.collider;
                    const hw = Math.max(COLLIDER_MIN_HW, entry.footprint[0] * PROP_SCALE * (scale || 1) * .5);
                    return Math.abs(x - box.x) < box.hw + hw + .7 && Math.abs(y - box.y) < box.hh + hw + .7;
                }

                // Footprints are card-space, so the placed prop's half-width is
                // the scale away from its collider.
                function colliderFor(entry, x, y, scale) {
                    const hw = Math.max(COLLIDER_MIN_HW,
                        entry.footprint[0] * PROP_SCALE * (scale || 1) * 0.4);
                    return { x: x, y: y, hw: hw, hh: hw };
                }
                // Reserve continuous 2.4-unit paths from the center to every
                // wall midpoint. Testing only prop centers let wide scenery
                // reach into a doorway or enclose the spawn area.
                function crossesWalkway(box) {
                    return Math.abs(box.x - size.w / 2) < box.hw + 1.2
                        || Math.abs(box.y - size.h / 2) < box.hh + 1.2;
                }

                function addShadow(entry, x, y, scale) {
                    const rx = Math.max(SHADOW_MIN_R,
                        entry.footprint[0] * PROP_SCALE * (scale || 1) * 0.42);
                    const disc = shadowDisc().clone();
                    disc.scale(rx, rx * SHADOW_SQUASH, 1);
                    disc.rotateX(-Math.PI / 2);
                    disc.translate(x, SHADOW_Y, y);
                    shadows.push(disc);
                }

                // Bake a static unit into the merged room geometry. Upright
                // by default; `flat` tips ground/water cards onto the floor.
                function placeStatic(unit, x, y, flat, collidable, scale, allowPath) {
                    const entry = unit.entry;
                    if (overlapsLandmark(entry, x, y, scale)) { return; }
                    const blocks = !flat && (collidable || entry.collider
                        || entry.category === "wall" || entry.footprint[0] >= BIG_FOOTPRINT);
                    const collider = blocks ? colliderFor(entry, x, y, scale) : null;
                    if (collider && crossesWalkway(collider)) { return; }
                    if (collider && colliders.some(box => Math.abs(x - box.x) < collider.hw + box.hw + .15
                        && Math.abs(y - box.y) < collider.hh + box.hh + .15)) { return; }
                    if ((!allowPath || collider) && layout.isProtected(x, y,
                        collider ? collider.hw : Math.max(COLLIDER_MIN_HW, entry.footprint[0] * PROP_SCALE * (scale || 1) * .5))) {
                        return;
                    }
                    const cardH = entry.footprint[1] || 1;
                    const matrix = flat
                        ? flatMatrix(x, y, cardH, scale)
                        : uprightMatrix(x, y, 0, scale);
                    collectGeometries(unit.template, matrix, bucketOf(unit), flat);
                    if (!flat) { addShadow(entry, x, y, scale); }
                    if (collider) { colliders.push(collider); }
                    placements.push({ name: entry.name, x: x, y: y, flat: !!flat });
                    taken.push({ x: x, y: y });
                }

                // Animated units stay live clones (one shared mixer,
                // spec/02 §3 rule 5); they are few, and merging would freeze
                // the one thing that moves. Flat cards are NOT placed here —
                // see the animated loop.
                function placeAnimated(unit, x, y) {
                    if (overlapsLandmark(unit.entry, x, y, 1)) { return; }
                    if (layout.isProtected(x, y, Math.max(.3,
                        unit.entry.footprint[0] * PROP_SCALE * .5))) { return; }
                    const collider = unit.entry.collider || unit.entry.footprint[0] >= BIG_FOOTPRINT
                        ? colliderFor(unit.entry, x, y, 1) : null;
                    if (collider && crossesWalkway(collider)) { return; }
                    if (collider && colliders.some(box => Math.abs(x - box.x) < collider.hw + box.hw + .15
                        && Math.abs(y - box.y) < collider.hh + box.hh + .15)) { return; }
                    const clone = unit.template.clone(true);
                    clone.position.set(x, 0, y);
                    clone.scale.setScalar(PROP_SCALE);
                    clone.traverse(function (child) {
                        child.userData.sharedGeometry = true;
                    });
                    group.add(clone);
                    const idle = unit.clips.find(function (clip) { return clip.name === "idle"; })
                        || unit.clips[0];
                    if (idle) {
                        mixer.clipAction(idle, clone).play();
                        candidate.animatedRoots.push(clone);
                    }
                    placements.push({
                        name: unit.entry.name, x: x, y: y,
                        animated: true, flat: false
                    });
                    taken.push({ x: x, y: y });
                    addShadow(unit.entry, x, y, 1);
                    if (collider) { colliders.push(collider); }
                }

                const pickFrom = function (pool) {
                    return pool[Math.floor(rng() * Math.min(pool.length, 6))];
                };

                // The volume's prefer list comes first, the room recipe's
                // second: which props a 卷 actually owns is a fact about its
                // kits, while the recipe only says what kind of room this is.
                const pool = function (categories, volumePrefer, roomPrefer) {
                    return pickPool(kits, categories,
                        (volumePrefer || []).concat(roomPrefer || []), excludes);
                };

                // -- ground: synthesized, never tiled from the kit -------------
                // The kits ship no tileable ground and no top-down dais (see
                // §ground), so the whole surface is authored colour: darkened
                // surround, room rect, and a disc for `arena` rooms.
                groundGroup(cfg, !!recipe.arena, doors, candidate);

                // -- border ring --------------------------------------------------
                const borderPool = pool(["prop", "wall", "animated"],
                    prefer.border, recipe.borderPrefer);
                borderSpots(Math.round((recipe.border || 0) * (size.w + size.h) / 28), rng, size).forEach(function (spot) {
                    const unit = pickFrom(borderPool);
                    if (unit) {
                        placeStatic(unit, spot.x, spot.y, laysFlat(unit.entry), false, 1.25);
                    }
                });

                // One substantial silhouette per landscape bed gives the
                // small accents a place to belong. Keep original kit artwork
                // and proportions, and reject cards too wide for a court.
                const focalPool = borderPool.filter(unit => !laysFlat(unit.entry)
                    && unit.entry.footprint[1] >= .4
                    && unit.entry.footprint[0] * PROP_SCALE * 1.35 < 5);
                // A landscape focal is not a random wall fragment. Use the
                // explicit whole-object preference when the segment owns it;
                // broad border vocabulary remains available around the room.
                const preferredFocals = focalPool.filter(unit =>
                    matchesAny(unit.entry.name, prefer.focal || []));
                layout.beds.forEach(function (bed) {
                    const unit = pickFrom(preferredFocals.length ? preferredFocals : focalPool);
                    if (unit) placeStatic(unit, bed.x, bed.y, false, true, 1.35);
                });

                // -- anchor: the room's semantic landmark ------------------------
                // Landmarks read as landmarks by being bigger than the ring.
                // pickPool only *sorts* by prefer, so its head is "the widest
                // prop in the volume" whenever no anchor name matches — a
                // landmark by accident. Keep only real matches; floors.json
                // gives shop/rest/boss generic tails so all five volumes still
                // resolve one. Water/floor anchors lie flat, like scatter does:
                // a pond stood on end is a wall.
                if (recipe.anchor && !restCamp) {
                    const anchorPool = pool(["prop", "wall", "animated", "water"],
                        null, recipe.anchor).filter(function (unit) {
                        return matchesAny(unit.entry.name, recipe.anchor);
                    });
                    if (anchorPool.length) {
                        const unit = anchorPool[0];
                        const x = size.w / 2 + (rng() - 0.5) * 1.5;
                        const y = size.h - BORDER_INSET - 1.2;
                        const flat = laysFlat(unit.entry);
                        if (!inDoorCorridor(x, y, size)) {
                            // Semantic anchors sit at the service edge of the
                            // court. Their collider remains active; allowing
                            // the visual path here avoids hiding the anchor.
                            placeStatic(unit, x, y, flat, true, ANCHOR_SCALE, true);
                        }
                    }
                }

                // -- scatter --------------------------------------------------------
                // floor units scatter too (laid flat): 1011_1's `road` cards
                // become dirt patches across its otherwise uniform meadow —
                // most biomes have no extra floor unit, so this is a no-op
                // for them.
                const scatterPool = pool(["prop", "water", "floor"],
                    prefer.scatter, recipe.scatterPrefer);
                scatterSpots(recipeCount(recipe.scatter, size), rng, taken, layout, size).forEach(function (spot) {
                    const unit = pickFrom(scatterPool);
                    if (unit) {
                        // water and extra floor cards are ground features:
                        // lay them flat, never blocking
                        placeStatic(unit, spot.x, spot.y, laysFlat(unit.entry), false);
                    }
                });

                // -- water patches (T22c 房间类型差异化铺法) ---------------------
                // A per-room-type `water` count lays a few big flat water
                // cards — pond / river / sea / WaterSurface — wherever the
                // segment's kits actually own one. Laid flat like scatter,
                // never blocking, and bigger than scatter so they read as
                // terrain rather than decoration.
                const waterPool = pickPool(kits, ["water"], [], excludes)
                    .filter(function (unit) {
                        return Math.max(unit.entry.footprint[0] || 0,
                                        unit.entry.footprint[1] || 0)
                            >= WATER_PATCH_MIN_W;
                    });
                scatterSpots(recipeCount(recipe.water, size), rng, taken, layout, size)
                    .forEach(function (spot) {
                        const unit = pickFrom(waterPool);
                        if (unit) {
                            placeStatic(unit, spot.x, spot.y, true, false,
                                WATER_PATCH_SCALE);
                        }
                    });

                // -- animated decorations -------------------------------------------
                mixer = new THREE.AnimationMixer(group);
                candidate.mixer = mixer;
                const animatedPool = pool(["animated"],
                    prefer.scatter, recipe.scatterPrefer);
                scatterSpots(Math.round((recipe.animated || 0) * Math.min(2.25,
                    size.w * size.h / BASE_ROOM_AREA)), rng, taken, layout, size).forEach(function (spot) {
                    const unit = pickFrom(animatedPool);
                    if (!unit) { return; }
                    // Flat means baked, always. Tipping a live clone cannot
                    // work: the mixer owns the inner nodes, and the kit's
                    // recentring lives on one of them — 1018_8's GroundSheet
                    // node carries a -0.12 z that its child cancels with
                    // +0.12, and the idle clip overwrites that child's
                    // position. Upright the leftover is a 0.19-unit nudge in
                    // depth; tipped it becomes 0.19 in Y, and the mat sinks
                    // under a ground plane only 0.02 down. An overhead card
                    // has nothing to animate anyway — its sway was authored
                    // for a billboard — so bake it like a pond.
                    if (laysFlat(unit.entry)) {
                        placeStatic(unit, spot.x, spot.y, true, false);
                    } else {
                        placeAnimated(unit, spot.x, spot.y);
                    }
                });

                // -- merge per texture ------------------------------------------------
                buckets.forEach(function (geometries, key) {
                    if (!geometries.length) { return; }
                    const merged = BufferGeometryUtils.mergeGeometries(geometries, false);
                    geometries.forEach(function (g) { g.dispose(); });
                    geometries.length = 0;
                    if (!merged) {
                        throw new Error("地图几何合并失败：" + key);
                    }
                    const mesh = new THREE.Mesh(merged, materialCache.get(key));
                    mesh.name = "kit:" + key;
                    mesh.frustumCulled = false;     // room-sized; one per texture
                    group.add(mesh);
                });

                // -- contact shadows, one mesh for the whole room ----------------------
                if (shadows.length) {
                    const merged = BufferGeometryUtils.mergeGeometries(shadows, false);
                    shadows.forEach(function (g) { g.dispose(); });
                    shadows.length = 0;
                    if (!merged) { throw new Error("地图阴影合并失败。"); }
                    {
                        const mesh = new THREE.Mesh(merged, shadowMat());
                        mesh.name = "propshadow";
                        mesh.frustumCulled = false;
                        mesh.renderOrder = -1;      // before the props, after the ground
                        group.add(mesh);
                    }
                }

                group.userData.colliders = colliders;
                // Static props are merged, so a mesh name can no longer say what
                // is standing where. Checks that need to name a prop read this.
                group.userData.placements = placements;
                candidate.result = {
                    colliders: colliders,
                    placements: placements,
                    buildMs: performance.now() - started
                };
                return candidate;
                } catch (error) {
                    releaseRoom(candidate);
                    throw error;
                } finally {
                    buckets.forEach(function (geometries) { geometries.forEach(function (g) { g.dispose(); }); });
                    shadows.forEach(function (g) { g.dispose(); });
                }
            });
        });
    }

    // Preload one floor's kits (its segment's main biome plus its `extra`) so
    // room switches only instantiate — the 换层 <1.5s bar (spec/02 §4).
    // Descending preloads the NEXT floor's segment pair before the room
    // switch happens, so a descent through a segment boundary never stalls.
    function preloadVolume(which, floor, options = {}) {
        return loadDocs().then(function () {
            const cfg = volumeConfig(which || vol, floor || (which ? 1 : currentFloor));
            const kitNames = [cfg.biome, cfg.extra, cfg.extra2]
                .filter(function (name, i, all) {
                    return name && all.indexOf(name) === i;
                });
            if (options.retry) {
                // Interactable cards may belong to a different kit than the floor.
                const pending = Array.from(kitCache).filter(([, kit]) => kit.promise).map(([name]) => name);
                retryKits(Array.from(new Set([...kitNames, ...pending])));
            }
            return Promise.all([preloadRoomBuildings(which || vol), preloadFloorShrine(),
                ...kitNames.map(function (name) { return kitPromise(name, !!options.strict); })]);
        });
    }

    function activateRoom(candidate) {
        if (!candidates.has(candidate) || candidate.disposed) { throw new Error("地图候选已释放或不属于当前视图。"); }
        if (active === candidate) { return candidate.result; }
        scene.add(candidate.group);
        tintKits(candidate.kits, candidate.tint);
        const previous = active;
        active = candidate;
        currentFloor = candidate.floor;
        buildRequest += 1;
        releaseRoom(previous);
        return candidate.result;
    }

    function buildRoom(room, biome, doors, options = {}) {
        const request = ++buildRequest, floor = currentFloor;
        return prepareRoom(room, biome, doors, { ...options, floor }).then(function (candidate) {
            if (request !== buildRequest || floor !== currentFloor || options.isCurrent && !options.isCurrent()) {
                candidate.dispose();
                return null;
            }
            return activateRoom(candidate);
        });
    }

    function update(dt) {
        if (active && active.mixer) { active.mixer.update(dt || 0); }
        if (active && active.landmark) { active.landmark.update(); }
        if (active && active.floorShrine) { active.floorShrine.update(dt); }
        if (active && active.restCamp) { active.restCamp.update(dt); }
    }

    return {
        buildRoom: buildRoom,
        prepareRoom: prepareRoom,
        activateRoom: activateRoom,
        cancelBuild: function () { buildRequest += 1; },
        preloadVolume: preloadVolume,
        setFloor: setFloor,
        get floor() { return currentFloor; },
        update: update,
        setDoorsLocked: setDoorsLocked,
        dispose: disposeRoom,
        get floorShrine() { return active ? active.floorShrine : null; },
        get restCamp() { return active ? active.restCamp : null; },
        get group() { return active ? active.group : null; }
    };
}
