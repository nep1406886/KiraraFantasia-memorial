// Original damage rows are selected by exact owner + skill ID. All area
// geometry, timing and sequencing below are explicit realtime adaptations.
// Provenance and counterplay: docs/enemy-choreography-design.md.
const PI = Math.PI;
const move = (key, skillId, label, kind, values) => ({ key, skillId, label, kind,
    warning: .9, active: .18, recovery: 1.0, clip: "skill_1", ...values });
const sweep = (key, id, label, radius = 3.5, arc = PI * .8) => move(key, id, label, "sector", {
    radius, arc, warning: .8, recovery: 1.1, clip: "skill_0", counter: "离开正面，绕到侧后方反击" });
const charge = (key, id, label, range = 7) => move(key, id, label, "charge", {
    range, warning: 1, active: .42, recovery: 1.25, clip: "skill_0", counter: "横移避开冲刺线，停下后反击" });
const ring = (key, id, label, inner = 2.2, outer = 6) => move(key, id, label, "annulus", {
    inner, outer, warning: 1.1, recovery: 1.1, counter: "进入内圈或退出外圈" });
const disc = (key, id, label, radius = 3.2) => move(key, id, label, "disc", {
    radius, warning: .9, recovery: 1.15, counter: "退出近身震圈，结束后靠近" });
const spots = (key, id, label, radius = 1.4, count = 2) => move(key, id, label, "spots", {
    radius, count, spacing: 3.8, warning: 1.15, recovery: .95, counter: "落点已经锁定，离开标记区域" });
const line = (key, id, label, range = 12) => move(key, id, label, "line", {
    range, radius: .55, warning: .95, recovery: .9, clip: "skill_0", counter: "瞄准已锁定，横移离开直线" });
const lanes = (key, id, label) => move(key, id, label, "lanes", {
    range: 13, radius: .55, spacing: 2.0, warning: 1.1, recovery: 1.1, counter: "站到两条封锁线之间" });
const cross = (key, id, label, onPlayer = false) => move(key, id, label, "cross", {
    range: 6.5, radius: .5, onPlayer, warning: 1.2, recovery: 1.25, counter: "离开十字，进入斜向空隙" });
const profile = (key, moves, rotations) => ({ key, moves,
    rotations: rotations || [moves.map(row => row.key)] });

export const ENEMY_ROLES = Object.freeze({
    99038006: profile("storm", [sweep("claw", 38004, "爪翼横扫"),
        charge("dive", 38006, "俯冲利爪", 8), ring("eye", 38003, "疾风之眼", 2.3, 6.5)],
        [["claw", "dive"], ["dive", "eye", "claw"], ["eye", "dive", "claw", "eye"]]),
    99248003: profile("spice", [sweep("pour", 48006, "热汤倾倒", 5.2, PI * .6),
        spots("spice", 48005, "香料落点", 1.55, 3), disc("boil", 48004, "沸腾震圈", 3.8)],
        [["pour", "spice"], ["spice", "boil", "pour"], ["boil", "spice", "pour", "spice"]]),
    99318603: profile("spore", [sweep("vine", 18623, "触手横扫", 3.7, PI * 1.15),
        spots("bloom", 18624, "孢子萌发", 1.45, 3), ring("burst", 18626, "孢子外爆", 2.4, 6.2)],
        [["vine", "bloom"], ["bloom", "burst", "vine"], ["burst", "bloom", "vine", "burst"]]),
    99619003: profile("artillery", [line("aim", 19052, "锁定炮击"),
        lanes("battery", 19059, "平行炮道"), cross("crossfire", 19060, "交叉扫射")],
        [["aim", "battery"], ["battery", "crossfire", "aim"], ["crossfire", "aim", "battery"]]),
    90238005: profile("eclipse", [ring("sanctum", 83010, "寂静内环", 2.5, 6.8),
        cross("collapse", 83011, "崩解十字", true), spots("verdict", 83025, "终幕落点", 1.6, 3)],
        [["sanctum", "collapse"], ["collapse", "verdict", "sanctum"], ["verdict", "sanctum", "collapse", "verdict"]]),
    90013003: profile("salt", [sweep("sauce", 13012, "酱刃横扫"), spots("arrabbiata", 13016, "辛辣落点")]),
    99510002: profile("sugar", [disc("custard", 10020, "奶油重击"), charge("rush", 10021, "甜点冲撞")]),
    90222001: profile("sniper", [line("delay", 68011, "延迟狙击"), lanes("double", 68009, "双线狙击")]),
    99312000: profile("duelist", [charge("cut", 12011, "切入突袭"), ring("circle", 12012, "回旋切割")]),
    90014005: profile("breaker", [charge("knock", 14024, "破阵冲拳", 6), sweep("bone", 14009, "碎骨重击", 3.2, PI * .65)]),
    99311001: profile("rain", [ring("aqua", 11001, "水环扩散"), spots("rain", 11002, "深雨落点")]),
    99415004: profile("crescent", [charge("sting", 15001, "月刺突进"), sweep("flare", 15002, "弦月横扫", 4, PI)]),
    99316004: profile("spell", [lanes("cliff", 16067, "峭壁封锁"), line("chorus", 16002, "轮唱锁定")]),
    90426005: profile("sunblade", [charge("dawn", 74004, "晓光突进"), sweep("sunset", 74018, "落日挥斩", 4, PI)]),
    90023000: profile("arsenal", [sweep("edge", 69001, "花刃横扫"), cross("arsenal", 69002, "交叉兵装")]),
    90136002: profile("palm", [disc("palm", 73006, "震掌"), spots("blast", 73008, "爆破落点", 1.7, 2)])
});

export function enemyRole(enemyId, moveset) {
    const authored = ENEMY_ROLES[enemyId];
    if (!authored) { return null; }
    const attacks = moveset?.attacks || [];
    const moves = authored.moves.flatMap(row => {
        const skill = attacks.find(attack => attack.id === row.skillId);
        return skill ? [{ ...row, skill }] : [];
    });
    if (!moves.length) { return null; }
    return { key: authored.key, moves, rotations: authored.rotations.map(rotation => {
        const available = rotation.filter(key => moves.some(row => row.key === key));
        return available.length ? available : moves.map(row => row.key);
    }) };
}
