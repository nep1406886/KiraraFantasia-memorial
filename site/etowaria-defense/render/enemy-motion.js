// P0 locomotion authored for these exact enemy rigs. The source bundles only
// contain battle poses; these gait curves are a declared fan-game adaptation.
const biped = (period, stride, lift, bounce, legs = ["leg_L", "leg_R"], arms = ["arm_L", "arm_R"]) => ({ mirrorForLeft: true,
    period, stride, lift, bounce, feet: [[legs[0], 0], [legs[1], .5]], arms: arms.length ? [[arms[0], .5], [arms[1], 0]] : [] });
// Every rig here lunges toward screen-right in its authored skill_0 (checked
// with tests/facing-check.js), so all of them mirror to face the defenders.
const PROFILES = {
    10000: biped(1.05, .028, .023, .007),
    10100: biped(.72, .045, .028, .009),
    10200: { mirrorForLeft: true, period: 1.4, stride: .021, lift: .012, bounce: .002,
        feet: [["front_leg_L", 0], ["front_leg_R", .5], ["back_leg_L", .5], ["back_leg_R", 0]], arms: [] },
    10300: biped(.9, .024, .02, .006),
    10600: { mirrorForLeft: true, period: 1.3, stride: 0, lift: 0, bounce: .03, feet: [], arms: [["arm_L", .5], ["arm_R", 0]] },
    10800: biped(1.1, .018, .014, .004, ["leg_L", "leg_R"], ["arm_L_large", "arm_R_large"]),
    10900: biped(1, .022, .018, .006),
    11100: biped(1.15, .045, .03, .006),
    11400: biped(1.25, .04, .024, .005),
    11500: { mirrorForLeft: true, period: .6, stride: .045, lift: .03, bounce: .01,
        feet: [["front_leg_L", 0], ["front_leg_R", .5], ["back_leg_L", .5], ["back_leg_R", 0]], arms: [] },
    12000: biped(.95, .042, .026, .006),
    13600: biped(1.5, .04, .026, .004, ["leg_L1", "leg_R1"], ["arm_L1", "arm_R1"]),
    14300: { mirrorForLeft: true, period: 1.4, stride: .045, lift: .03, bounce: .006,
        feet: [["foot_A_L", 0], ["foot_A_R", .5], ["foot_B_L", .5], ["foot_B_R", 0], ["foot_C_L", 0], ["foot_C_R", .5]],
        arms: [["arm_A_L", .5], ["arm_A_R", 0]] },

    13500: biped(.82, .026, .032, .02, ["leg_L", "leg_R"], []),
    10400: biped(.78, .04, .02, .005, ["foot_L", "foot_R"], ["arm_L", "arm_R"]),
    13200: biped(.92, .03, .024, .007),
    11200: { mirrorForLeft: true, period: 1.5, stride: .02, lift: .014, bounce: .003,
        feet: [["front_leg_L1", 0], ["front_leg_R", .5], ["back_leg_L1", .5], ["back_leg_R1", 0]], arms: [] },
    11900: { mirrorForLeft: true, period: .95, stride: .02, lift: .01, bounce: .004,
        feet: [["leg_L_A_1", 0], ["leg_R_A_1", .5], ["leg_L_B_1", .5], ["leg_R_B_1", 0]],
        arms: [["arm_L_A", .5], ["arm_R_A", 0]] },
    13100: { mirrorForLeft: true, period: .88, stride: .016, lift: .024, bounce: .022,
        feet: [], arms: [["arm_L", .5], ["arm_R", 0]] },
    11600: { mirrorForLeft: true, period: 1.1, stride: .026, lift: .02, bounce: .005,
        feet: [["leg_L_01", 0], ["leg_R_01", .5]], arms: [["arm_L", .5], ["arm_R", 0]] },
    11300: biped(.98, .02, .012, .004, ["foot_L", "foot_R"], ["arm_L", "arm_R"]),
    10500: { mirrorForLeft: true, period: 1.15, stride: 0, lift: 0, bounce: .018,
        feet: [], arms: [["fin_A", .5], ["fin_B", 0]] },
    13400: biped(1, .04, .024, .006, ["leg_L", "leg_R"], ["arm_L1", "arm_R"]),
    // Chapter 3 rigs. Bones were read from tools/_legs.mjs output (deleted post-run).
    // E25 飞翼盗账人 — small two-leg beast, standard biped handles it.
    11000: biped(.9, .036, .024, .008, ["leg_L", "leg_R"], ["arm_L", "arm_R"]),
    // E26 深潭多足怪 — 8 legs; animate four main pairs, leave the rest still.
    11700: { mirrorForLeft: true, period: 1.5, stride: .024, lift: .014, bounce: .004,
        feet: [["leg_A", 0], ["leg_B", .5], ["leg_C", .25], ["leg_D", .75],
            ["leg_A1", .5], ["leg_B1", 0], ["leg_C1", .75], ["leg_D1", .25]], arms: [] },
    // E27 双足小妖 — hopper; lean on generic two-leg with high lift.
    12100: biped(.7, .05, .034, .02, ["leg_B", "leg_F"], []),
    // E28 岩壳魔蟹 — crab-like heavy biped; single leg pair visibly stomping.
    12200: biped(1.2, .028, .024, .01, ["leg_L", "leg_R"], []),
    // E29 迷雾蓄能师 — female biped from the same family as U19 rigs.
    13700: biped(.95, .032, .026, .007, ["leg_L", "leg_R"], ["arm_L", "arm_R"]),
    // E30 碎岩魔像 — heavy tank with Feet + Tail; use the 12200 pattern scaled.
    14400: { mirrorForLeft: true, period: 1.6, stride: .026, lift: .018, bounce: .005,
        feet: [["Foot_L", 0], ["Foot_R", .5]], arms: [["Hand_A_L", .5], ["Hand_A_R", 0]] },

    // Chapter 4 rigs. Bones read from the GLB node tables; every one of these
    // bundles carries the six standard clips (idle/damage/dead/skill_0/skill_1/abnormal).
    // E31 兔兔怪 — long-eared hopper with two visible leg pairs.
    15700: { mirrorForLeft: true, period: .8, stride: .05, lift: .04, bounce: .018,
        feet: [["leg_L", 0], ["leg_R", .5], ["leg_L_up_A_obj", .25], ["leg_R_up_A_obj", .75]], arms: [["arm_L", .5], ["arm_R", 0]] },
    // E32 砂肝太郎 — heavy biped with Feet; slower stomp.
    14000: biped(1.35, .03, .02, .006, ["leg_L", "leg_R"], ["arm_L", "arm_R"]),
    // E33 金尾魔物 — light two-leg beast, quick steps.
    16200: biped(1.0, .028, .02, .006),
    // E34 庭园守卫 — the tallest, heaviest walker; long slow stride.
    17600: biped(1.7, .026, .016, .004, ["leg_L", "leg_R"], ["arm_L", "arm_R"]),
    // E35 老鼠 — many legs; animate the four main pairs.
    14500: { mirrorForLeft: true, period: .55, stride: .05, lift: .03, bounce: .012,
        feet: [["leg_L", 0], ["leg_R", .5], ["foot_L", .25], ["foot_R", .75]], arms: [] },
    // E36 鲨鱼 — legless glide with fin-like hand sway.
    16400: { mirrorForLeft: true, period: 1.2, stride: 0, lift: 0, bounce: .026,
        feet: [], arms: [["hand_L_obj", .5], ["hand_R_obj", 0]] },
    // E37 水云 — floating; bounce only, arms drift.
    15800: { mirrorForLeft: true, period: 1.3, stride: 0, lift: 0, bounce: .028,
        feet: [], arms: [["arm_L", .5], ["arm_R", 0]] },
    // E38 熊兵 — armoured biped, deliberate march.
    15900: biped(1.1, .034, .024, .006, ["leg_L", "leg_R"], ["arm_L", "arm_R"]),
    // E39 罗贝莉亚 — towering endless boss (rig 7000); long slow stride,
    // cloak arms sway. Heavy single leg pair keeps the stomp readable.
    7000: { mirrorForLeft: true, period: 1.8, stride: .022, lift: .014, bounce: .004,
        feet: [["Leg_L", 0], ["Leg_R", .5]], arms: [["Arm_Cloth_B_L_01", .5], ["hand_R_2_A_obj", 0]] },
    // スーパーかかしくん（仮）rig 5200 — the original training scarecrow,
    // reused as the F13 decoy. It is a static prop on the defense board:
    // zero stride keeps the authored pose, the arms sway in the breeze.
    5200: { mirrorForLeft: false, period: 2.6, stride: 0, lift: 0, bounce: 0,
        feet: [["leg_L_obj", 0], ["leg_R_obj", .5]], arms: [["arm_L", .5], ["arm_R", 0]] }
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
