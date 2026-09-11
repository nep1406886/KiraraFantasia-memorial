// Real-time delivery is an adaptation of the five original class roles.
// Coefficients, damage type and dedicated overrides remain original skill data.
import { weaponDefinition, weaponProficiency } from "./weaponcatalog.js";
import { inMeleeArc } from "./combat.js";
import { segmentDistanceSquared } from "./geometry.js";
import { PLAYER_TIMING } from "./actorstate.js";
import { gadgetRuntime } from './gadgets.js';

const PROFILES = [
    { name: "剑刃横扫", kind: "slash", range: 2.1, arc: Math.PI * 0.62 },
    { name: "魔力爆破", kind: "projectile", range: 10, speed: 10, radius: .23, blast: 1.35 },
    { name: "圣光贯穿", kind: "projectile", range: 8, speed: 12, radius: .2, pierce: 2 },
    { name: "长枪突刺", kind: "thrust", range: 3.1, width: .3 },
    { name: "炼金投掷", kind: "projectile", range: 7, speed: 7.5, radius: .26, blast: 1, slow: .15 }
];
const LEGACY = { name: "普通攻击", kind: "slash", range: PLAYER_TIMING.attackRange, arc: PLAYER_TIMING.attackArc };

export function weaponProfile(card, items = []) {
    const item = items.find(row => row.slot === "weapon");
    const weapon = weaponDefinition(item);
    const classId = weapon ? weapon.class : card?.class;
    const profile = { ...(PROFILES[classId] || LEGACY), classId, proficiency: weaponProficiency(item, card) };
    const gadgets = gadgetRuntime(items);
    profile.range *= gadgets.range;
    if (profile.arc) profile.arc = Math.min(Math.PI * 2, profile.arc * gadgets.width);
    if (profile.width) profile.width *= gadgets.width;
    if (profile.radius) profile.radius *= gadgets.width;
    return profile;
}

export function inWeaponReach(player, target, profile) {
    if (profile.kind === "slash") { return inMeleeArc(player, target, profile.range, profile.arc); }
    if (profile.kind !== "thrust") { return false; }
    const dx = Math.cos(player.facing), dy = Math.sin(player.facing);
    if ((target.x - player.x) * dx + (target.y - player.y) * dy < -target.radius) { return false; }
    return segmentDistanceSquared(target.x, target.y, player.x, player.y,
        player.x + dx * profile.range, player.y + dy * profile.range)
        <= (profile.width + target.radius) ** 2;
}
