import { placementCoverage } from "../sim/targeting.js";

const COLORS = { attack: 0x315d94, healing: 0x278a5b, burst: 0x986127, placement: 0x9d8550 };

export class RangePreview {
    constructor(stage, world) {
        this.stage = stage;
        this.world = world;
        this.group = new stage.THREE.Group();
        this.group.name = "deployment-range-preview";
        this.group.visible = false;
        stage.environment.add(this.group);
        const THREE = stage.THREE;
        this.geometry = new THREE.PlaneGeometry(1, 1);
        this.edges = new THREE.EdgesGeometry(this.geometry);
        const blend = { transparent: false, depthWrite: false, blending: THREE.CustomBlending,
            blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };
        this.fill = new THREE.MeshBasicMaterial({ ...blend, color: COLORS.attack, opacity: .2, side: THREE.DoubleSide });
        this.border = new THREE.LineBasicMaterial({ ...blend, color: COLORS.attack, opacity: .75 });
        this.tiles = [];
        this.current = null;
    }

    show(rule, row, col, board) {
        const area = placementCoverage(rule, row, col, board);
        if (!area) { this.clear(); return null; }
        this.current = area;
        this.fill.color.setHex(COLORS[area.kind]);
        this.border.color.setHex(COLORS[area.kind]);
        while (this.tiles.length < area.cells.length) {
            const tile = new this.stage.THREE.Group();
            tile.rotation.x = -Math.PI / 2;
            const fill = new this.stage.THREE.Mesh(this.geometry, this.fill);
            const border = new this.stage.THREE.LineSegments(this.edges, this.border);
            fill.renderOrder = 920; border.renderOrder = 930;
            tile.add(fill, border);
            this.group.add(tile); this.tiles.push(tile);
        }
        this.tiles.forEach((tile, index) => {
            const cell = area.cells[index];
            tile.visible = !!cell;
            if (!cell) { return; }
            tile.position.copy(this.world(cell.row, (cell.left + cell.right) / 2, .024));
            tile.scale.set(Math.max(.01, cell.right - cell.left - .04) * 1.3, 2.02, 1);
        });
        this.group.visible = true;
        return area;
    }

    clear() { this.group.visible = false; this.current = null; }
    snapshot() { return this.current ? { ...this.current, cells: this.current.cells.map(cell => ({ ...cell })) } : null; }
    dispose() {
        this.group.removeFromParent();
        this.geometry.dispose(); this.edges.dispose(); this.fill.dispose(); this.border.dispose();
        this.tiles = []; this.current = null;
    }
}
