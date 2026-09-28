// Cosmetic idle gestures only. No simulation RNG, timers or combat effects.
const FACES = ["happy", "joy"];
let instance = 0;

export class IdleMotion {
    constructor(THREE, root, resourceId, { actor = null, billboard = null } = {}) {
        this.THREE = THREE;
        this.actor = actor;
        this.phase = ((Number(resourceId) * 17 + ++instance * 97) % 997) / 997;
        this.gap = 6.5 + this.phase * 7;
        this.age = 0;
        this.relaxed = false;
        this.enabled = true;
        this.applied = false;
        this.faceOn = false;
        this.gesture = 0;
        this.tilting = false;
        this.tilted = false;
        this.nodes = [];
        this.axis = new THREE.Vector3(0, 0, 1);
        const view = billboard && this.axis.clone().applyQuaternion(billboard.getWorldQuaternion(new THREE.Quaternion()));
        root.traverse(node => {
            if (node.name !== "Head_root") { return; }
            // A paper stack may only turn in the picture plane; any other axis
            // shows the edge of a flat part.
            const normal = this.axis.clone().applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
            if (view && Math.abs(normal.dot(view)) < .999) { return; }
            this.nodes.push({ node, quaternion: node.quaternion.clone() });
        });
        this.turn = new THREE.Quaternion();
        this.weight = 0;
    }
    configure({ enabled = true, relaxed = false } = {}) {
        this.enabled = enabled; this.relaxed = relaxed;
        if (!enabled) { this.showFace(false); }
    }
    restore() {
        if (!this.applied) { return; }
        for (const entry of this.nodes) { entry.node.quaternion.copy(entry.quaternion); }
        this.applied = false;
    }
    // The next action applies its own authored face, so the pinned one is
    // dropped without handing it back.
    reset() { this.restore(); this.age = 0; this.weight = 0; this.faceOn = false; this.tilting = this.tilted = false; }
    showFace(on) {
        if (on === this.faceOn || !this.actor) { return; }
        this.faceOn = on;
        if (on) { this.actor.face(FACES[this.gesture % FACES.length]); }
        else { this.actor.faceAuto(); }
    }
    apply(dt, idle) {
        if (!idle) { this.age = 0; this.weight = 0; this.tilting = this.tilted = false; return false; }
        if (this.enabled) {
            this.age += dt;
            const beat = (this.age + this.phase * 5) / 7;
            const cycle = beat % 1 * 7;
            this.gesture = Math.floor(beat);
            // Skip a beat whose window opened before the settle-in time, or the
            // head would jump straight to a mid-tilt pose.
            const open = this.age - cycle >= 2 && cycle < 2.4;
            this.weight = open ? Math.sin(cycle / 2.4 * Math.PI) ** 2 : 0;
            if (open) { this.tilting = true; } else if (this.tilting) { this.tilting = false; this.tilted = true; }
            // The relaxed room clip waits for a whole tilt: a gap shorter than
            // the first beat would otherwise restart the clock before any.
            if (this.relaxed && this.age >= this.gap && !open && this.tilted) {
                this.age = 0; this.tilted = false; this.showFace(false); return true;
            }
        } else {
            // A threat in the lane eases the head back rather than snapping it.
            this.age = 0; this.tilting = this.tilted = false;
            this.weight = Math.max(0, this.weight - dt * 3);
        }
        // A head tilt with an original cheerful face, then a long still
        // interval. Legs, hands, sockets and the actor root are untouched.
        this.turn.setFromAxisAngle(this.axis, .13 * this.weight * (this.gesture % 2 ? 1 : -1));
        for (const entry of this.nodes) {
            entry.quaternion.copy(entry.node.quaternion);
            entry.node.quaternion.multiply(this.turn);
        }
        this.applied = this.weight > 0;
        this.showFace(this.enabled && this.weight > .3);
        return false;
    }
    snapshot() {
        return { enabled: this.enabled, relaxed: this.relaxed, phase: this.phase, age: this.age, weight: this.weight,
            face: this.faceOn ? FACES[this.gesture % FACES.length] : null, bones: this.nodes.length };
    }
}
