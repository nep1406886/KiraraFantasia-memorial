// Read-only ground warnings. These are explicit gameplay aids, not original
// effect assets. Every mesh comes from the exact area used by the world hit test.
import { SPECIAL_THREAT_LIMIT } from "../enemyactions.js";
import { LAYER } from "./layers.js";

const GROUND_Y = .035, WARNING = 0xffad32, ACTIVE = 0xef5064;

function areaGeometry(THREE, area) {
    if (area.kind === "disc") { return new THREE.CircleGeometry(area.radius, 96); }
    if (area.kind === "annulus") { return new THREE.RingGeometry(area.inner, area.outer, 96); }
    if (area.kind === "sector") {
        return new THREE.CircleGeometry(area.radius, Math.max(16, Math.ceil(96 * area.arc / (2 * Math.PI))),
            area.angle - area.arc / 2, area.arc);
    }
    if (area.kind === "lane") {
        const length = Math.hypot(area.x2 - area.x1, area.y2 - area.y1), radius = area.radius;
        if (length < 1e-7) { return new THREE.CircleGeometry(radius, 96); }
        const shape = new THREE.Shape();
        shape.moveTo(0, radius); shape.lineTo(length, radius);
        shape.absarc(length, 0, radius, Math.PI / 2, -Math.PI / 2, true);
        shape.lineTo(0, -radius);
        shape.absarc(0, 0, radius, -Math.PI / 2, -Math.PI * 1.5, true);
        shape.closePath();
        const geometry = new THREE.ShapeGeometry(shape, 24);
        geometry.rotateZ(Math.atan2(area.y2 - area.y1, area.x2 - area.x1));
        return geometry;
    }
    throw new Error("Unknown enemy area: " + area.kind);
}

export function createEnemyTelegraphs(scene, THREE) {
    const root = new THREE.Group(); root.name = "enemy-telegraphs";
    scene.add(root);
    const entries = new Map();
    // Geometry belongs to an action; materials belong to this room view.
    // Keep at most one independent pair per admitted threat so an idle gap
    // does not delete both compiled shaders and recompile them next attack.
    const idleMaterials = [];
    let disposed = false;
    function makeMaterials() {
        const fill = new THREE.MeshBasicMaterial({ color: WARNING, transparent: true,
            opacity: .2, depthTest: true, depthWrite: false, side: THREE.DoubleSide,
            forceSinglePass: true, fog: false, toneMapped: false });
        const edge = new THREE.LineBasicMaterial({ color: WARNING, transparent: true,
            opacity: .9, depthTest: true, depthWrite: false, fog: false, toneMapped: false });
        return { fill, edge };
    }
    function create(action) {
        const group = new THREE.Group();
        const { fill, edge } = idleMaterials.pop() || makeMaterials();
        const geometries = [];
        for (const area of action.shapes) {
            const geometry = areaGeometry(THREE, area), outline = new THREE.EdgesGeometry(geometry);
            geometries.push(geometry, outline);
            const anchor = new THREE.Group();
            anchor.name = "enemy-area-" + area.kind;
            anchor.userData.enemyArea = area;
            anchor.rotation.x = Math.PI / 2; // local +Y maps to the world's +Z
            anchor.position.set(area.kind === "lane" ? area.x1 : area.x, GROUND_Y,
                area.kind === "lane" ? area.y1 : area.y);
            const mesh = new THREE.Mesh(geometry, fill), rim = new THREE.LineSegments(outline, edge);
            mesh.renderOrder = LAYER.enemy - 10; rim.renderOrder = LAYER.enemy - 9;
            anchor.add(mesh, rim); group.add(anchor);
        }
        root.add(group);
        return { group, fill, edge, geometries };
    }
    function release(action, entry, reusable = true) {
        entry.group.removeFromParent();
        entry.geometries.forEach(geometry => geometry.dispose());
        if (reusable) { idleMaterials.push({ fill: entry.fill, edge: entry.edge }); }
        else { entry.fill.dispose(); entry.edge.dispose(); }
        entries.delete(action);
    }
    function clear() {
        for (const [action, entry] of entries) { release(action, entry, false); }
        idleMaterials.forEach(pair => { pair.fill.dispose(); pair.edge.dispose(); });
        idleMaterials.length = 0;
    }
    return {
        object: root,
        get count() { return entries.size; },
        get shapeCount() { let count = 0; for (const entry of entries.values()) { count += entry.group.children.length; } return count; },
        sync(world) {
            if (disposed) { return; }
            const used = new Set();
            if (!world.player?.dead) {
                for (const unit of world.enemies) {
                    const action = unit.action;
                    if (unit.dead || unit.stunTimer > 0 || !action
                            || !["windup", "active"].includes(action.stage)) { continue; }
                    if (used.size >= SPECIAL_THREAT_LIMIT) { break; }
                    used.add(action);
                }
            }
            // Retire before acquiring: active + idle can never exceed the
            // world threat limit, even when every action changes this frame.
            for (const [action, entry] of entries) { if (!used.has(action)) { release(action, entry); } }
            for (const action of used) {
                let entry = entries.get(action);
                if (!entry) { entry = create(action); entries.set(action, entry); }
                const active = action.stage === "active";
                entry.fill.color.setHex(active ? ACTIVE : WARNING);
                entry.edge.color.copy(entry.fill.color);
                entry.fill.opacity = active ? .48 : .18 + .16 * Math.min(1, action.age / action.move.warning);
                entry.edge.opacity = active ? 1 : .9;
            }
        },
        clear,
        dispose() {
            if (disposed) { return; }
            disposed = true; clear(); root.removeFromParent();
        }
    };
}
