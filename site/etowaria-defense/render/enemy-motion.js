// P0 locomotion authored for these exact enemy rigs. The source bundles only
// contain battle poses; these gait curves are a declared fan-game adaptation.
const PROFILES = {
    10000: { mirrorForLeft: false, period: 1.05, stride: 0.028, lift: 0.023, bounce: 0.007,
        feet: [["leg_L", 0], ["leg_R", 0.5]], arms: [["arm_L", 0.5], ["arm_R", 0]] },
    10100: { mirrorForLeft: true, period: 0.72, stride: 0.045, lift: 0.028, bounce: 0.009,
        feet: [["leg_L", 0], ["leg_R", 0.5]], arms: [["arm_L", 0.5], ["arm_R", 0]] },
    10200: { mirrorForLeft: true, period: 1.4, stride: 0.021, lift: 0.012, bounce: 0.002,
        feet: [["front_leg_L", 0], ["front_leg_R", 0.5], ["back_leg_L", 0.5], ["back_leg_R", 0]], arms: [] }
};

export function enemyMirrorForLeft(resourceId) {
    const profile = PROFILES[resourceId];
    if (!profile) { throw new Error(`尚未核验的魔物朝向：${resourceId}`); }
    return profile.mirrorForLeft;
}

function strideAt(phase) {
    // In stance the foot travels toward screen-right relative to the body,
    // cancelling the enemy's leftward world movement. The return is lifted.
    if (phase < 0.5) { return { x: phase * 4 - 1, y: 0 }; }
    const t = (phase - 0.5) * 2;
    return { x: 1 - 2 * t, y: Math.sin(Math.PI * t) };
}

export function createEnemyMotion(THREE, root, resourceId, scale, mirrorSign = 1) {
    if (mirrorSign !== 1 && mirrorSign !== -1) { throw new Error("行进镜像符号必须为1或-1"); }
    const profile = PROFILES[resourceId];
    if (!profile) { throw new Error(`尚未核验的行进骨架：${resourceId}`); }
    const entries = [];
    for (const [name, phase] of [...profile.feet, ...profile.arms]) {
        const node = root.getObjectByName(name);
        if (!node) { throw new Error(`魔物骨架缺少 ${resourceId}/${name}`); }
        entries.push({ node, name, phase, position: node.position.clone(), quaternion: node.quaternion.clone() });
    }
    const hips = root.getObjectByName("Hips");
    const hipPosition = hips?.position.clone();
    const turn = new THREE.Quaternion();
    const axis = new THREE.Vector3(0, 0, 1);
    let applied = false;
    let elapsed = 0;
    return {
        period: profile.period,
        speed: 4 * profile.stride * scale / profile.period,
        restore() {
            if (!applied) { return; }
            for (const entry of entries) {
                entry.node.position.copy(entry.position);
                entry.node.quaternion.copy(entry.quaternion);
            }
            if (hips) { hips.position.copy(hipPosition); }
            applied = false;
        },
        apply(dt) {
            elapsed += dt;
            for (const entry of entries) {
                entry.position.copy(entry.node.position);
                entry.quaternion.copy(entry.node.quaternion);
                const phase = (elapsed / profile.period + entry.phase) % 1;
                const stride = strideAt(phase);
                if (profile.feet.some(([name]) => name === entry.name)) {
                    // Compensate in world space even when the paper rig is mirrored.
                    entry.node.position.x += profile.stride * stride.x * mirrorSign;
                    entry.node.position.y += profile.lift * stride.y;
                    turn.setFromAxisAngle(axis, -0.1 * stride.x * mirrorSign);
                } else {
                    turn.setFromAxisAngle(axis, 0.15 * Math.sin(phase * Math.PI * 2) * mirrorSign);
                }
                entry.node.quaternion.multiply(turn);
            }
            if (hips) {
                hipPosition.copy(hips.position);
                hips.position.y += profile.bounce * Math.sin(elapsed / profile.period * Math.PI * 4);
            }
            applied = true;
        },
        get phase() { return (elapsed / profile.period) % 1; },
        get bones() { return entries.map(entry => entry.name); }
    };
}
