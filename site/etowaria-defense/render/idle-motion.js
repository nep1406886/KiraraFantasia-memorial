// Cosmetic idle gestures only. No simulation RNG, timers or combat effects.
let instance = 0;

export class IdleMotion {
    constructor(THREE, root, resourceId) {
        this.THREE = THREE;
        this.phase = ((Number(resourceId) * 17 + ++instance * 97) % 997) / 997;
        this.gap = 6.5 + this.phase * 7;
        this.age = 0;
        this.relaxed = false;
        this.enabled = true;
        this.applied = false;
        this.nodes = [];
        root.traverse(node => {
            if (node.name === "Neck" || node.name === "Head_root") {
                this.nodes.push({ node, quaternion: node.quaternion.clone() });
            }
        });
        this.turn = new THREE.Quaternion();
        this.axis = new THREE.Vector3(0, 0, 1);
        this.weight = 0;
    }
    configure({ enabled = true, relaxed = false } = {}) {
        this.enabled = enabled; this.relaxed = relaxed;
        if (!enabled) { this.restore(); this.age = 0; this.weight = 0; }
    }
    restore() {
        if (!this.applied) { return; }
        for (const entry of this.nodes) { entry.node.quaternion.copy(entry.quaternion); }
        this.applied = false;
    }
    reset() { this.restore(); this.age = 0; this.weight = 0; }
    apply(dt, idle) {
        if (!this.enabled || !idle) { this.age = 0; this.weight = 0; return false; }
        this.age += dt;
        if (this.relaxed && this.age >= this.gap) { this.age = 0; return true; }
        // A gentle head look, with long still intervals. Legs, hands, sockets
        // and the actor root are untouched; every pose is restored before mix.
        const cycle = (this.age + this.phase * 5) % 7;
        this.weight = this.age > 2 && cycle < 2.2 ? Math.sin(cycle / 2.2 * Math.PI) ** 2 : 0;
        const angle = .022 * Math.sin(cycle / 2.2 * Math.PI * 2) * this.weight;
        for (const entry of this.nodes) {
            entry.quaternion.copy(entry.node.quaternion);
            this.turn.setFromAxisAngle(this.axis, angle * (entry.node.name === "Neck" ? .3 : 1));
            entry.node.quaternion.multiply(this.turn);
        }
        this.applied = true;
        return false;
    }
    snapshot() { return { enabled: this.enabled, relaxed: this.relaxed, phase: this.phase, age: this.age, weight: this.weight }; }
}
