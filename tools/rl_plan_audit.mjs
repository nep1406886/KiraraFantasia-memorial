// Read-only measurements for docs/plan-implementation-audit-2026-09-08.md.
// This reports implementation gaps; exit 0 does not certify release readiness.
// node tools/rl_plan_audit.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createStats } from "../site/asset/rl/stats.js";
import { PLAYABLE_IDS } from "../site/game/rl/rosterids.js";
import { mergeState } from "../site/game/rl/meta.js";
import { decodeSkill } from "../site/game/rl/skills.js";
import { generateDungeon } from "../site/game/rl/dungeon.js";
import { layoutSeedFor } from "../site/game/rl/runschema.js";
import { createDanmaku } from "../site/game/rl/danmaku.js";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");
const stats = createStats({ cards: JSON.parse(read("site/asset/rl/cards-rl.json")).cards });
const table = JSON.parse(read("site/asset/rl/skills-rl.json"));
const scope = { window: {} };
vm.runInNewContext(read("site/asset/gacha/cards.js"), scope, { timeout: 1000 });
const rendered = new Map();
for (const card of scope.window.kirafanGachaData.cards) {
    rendered.set(card.id, card);
    if (card.evolvedId) rendered.set(card.evolvedId, card);
}
const persistedIds = mergeState(null).chars;
const source = stats.all().filter(row => rendered.has(row.id) && row.rare === 5
    && PLAYABLE_IDS.includes(row.id) && persistedIds.includes(row.id));
const missing = [], slots = [];
for (const id of PLAYABLE_IDS) {
    const card = stats.card(id);
    if (!card) { missing.push({ cardId: id }); continue; }
    for (const [index, skillId] of [card.skillIds.chara, ...card.skillIds.class].entries()) {
        const raw = table.player[skillId];
        if (!raw) { missing.push({ cardId: id, skillId }); continue; }
        const decoded = decodeSkill(raw, skillId, table.recastSeconds);
        slots.push({ cardId: id, character: card.characterZh, skillId,
            role: index === 0 ? "ultimate" : "skill" + index, usable: decoded.usable,
            unhandledKinds: decoded.unhandled,
            playerRecoverySpeed: (raw.effects || []).some(effect => effect.kind === 2
                && effect.args?.[6] && [0, 3, 4].includes(effect.target)),
            extraDamageArgsGap: (raw.effects || []).some(effect => effect.kind === 0
                && effect.args?.slice(2).some(value => value !== 0)) });
    }
}
const gapSlots = slots.filter(row => row.unhandledKinds.length || row.extraDamageArgsGap);
const kindSlots = {};
for (const slot of slots) for (const kind of slot.unhandledKinds) kindSlots[kind] = (kindSlots[kind] || 0) + 1;

// Dijkstra on room types, independent of the generator's BFS boss selection.
// Zero-cost rooms are start/rest/shop/chest; battle and guard cost one each.
// This is topology only: it does not measure collision paths or player time.
function minimumBattleRoute(dungeon) {
    const rooms = new Map(dungeon.rooms.map(room => [room.id, room]));
    const paths = new Map([[dungeon.start, { cost: 0, path: [dungeon.start] }]]);
    const pending = new Set(rooms.keys());
    while (pending.size) {
        const id = [...pending].filter(id => paths.has(id)).sort((a, b) =>
            paths.get(a).cost - paths.get(b).cost || paths.get(a).path.length - paths.get(b).path.length || a - b)[0];
        if (id === undefined) return null;
        pending.delete(id);
        const current = paths.get(id);
        if (id === dungeon.boss) return { cost: current.cost,
            path: current.path.map(id => ({ id, type: rooms.get(id).type })) };
        for (const door of dungeon.doors) {
            const next = door.a === id ? door.b : door.b === id ? door.a : null;
            if (next === null || !pending.has(next)) continue;
            const cost = current.cost + (["battle", "boss"].includes(rooms.get(next).type) ? 1 : 0);
            const previous = paths.get(next);
            if (!previous || cost < previous.cost
                    || (cost === previous.cost && current.path.length + 1 < previous.path.length)) {
                paths.set(next, { cost, path: [...current.path, next] });
            }
        }
    }
    return null;
}
const distribution = {}, witnesses = [];
let unreachableGuard = 0, missingRest = 0;
for (let seed = 0; seed < 1000; seed++) {
    const layoutSeed = layoutSeedFor(seed, 1);
    const dungeon = generateDungeon(layoutSeed, { roomsMin: 6, roomsMax: 9 });
    const route = minimumBattleRoute(dungeon);
    if (!route) { unreachableGuard++; continue; }
    if (!dungeon.rooms.some(room => room.type === "rest")) missingRest++;
    distribution[route.cost] = (distribution[route.cost] || 0) + 1;
    if (route.cost < 2 && witnesses.length < 3) witnesses.push({ runSeed: seed, floor: 1, layoutSeed, ...route });
}
const danmaku = createDanmaku({ capacity: 5 });
const emitted = danmaku.emit("fan", { x: 10, y: 10, angle: 0 }, { count: 7, side: "enemy" });
console.log(JSON.stringify({
    scope: "只读字段与布局测量；不改账本、不写存档、不运行浏览器，不是全量验收。",
    roster: { authored: PLAYABLE_IDS.length, uniqueAuthored: new Set(PLAYABLE_IDS).size,
        persistedIdentityCount: persistedIds.length, normalEntrySource: source.length,
        absentFromSource: PLAYABLE_IDS.filter(id => !source.some(card => card.id === id)),
        uiVerification: "node tools/rl_roster_entry_harness.mjs" },
    skills: { sourceSlots: slots.length, slotsWithGaps: gapSlots.length,
        slotsWithUnhandledKinds: slots.filter(row => row.unhandledKinds.length).length,
        playerRecoverySpeedSlots: slots.filter(row => row.playerRecoverySpeed).length,
        extraDamageArgsGapSlots: slots.filter(row => row.extraDamageArgsGap).length,
        affectedCharacters: new Set(gapSlots.map(row => row.cardId)).size,
        missing, unhandledKindSlotCounts: kindSlots,
        unusable: slots.filter(row => !row.usable), gapSlots,
        limitation: "未处理 kind 与伤害附加参数仍计缺口；玩家速度已进入技能恢复。不代表效果条数或完整实战覆盖率，单人仇恨等允许明确例外。" },
    topology: { seeds: "0..999", floor: 1, samples: 1000, includesGuard: true,
        minimumBattleCountDistribution: distribution, unreachableGuard, missingRest, witnesses,
        limitation: "只测房间图的最低战斗成本，不测走位、支路收益或游玩时长；2–4 为规划试调目标。" },
    saturation: { pattern: "fan", capacity: 5, requested: 7, emitted,
        atomicGroup: emitted === 0 || emitted === 7,
        rejectedGroups: danmaku.rejectedGroups, dropped: danmaku.dropped,
        limitation: "仅测容量不足时整组拒绝；八种阵型与真实输入见 rl_admission_harness，不代替遭遇或设备验收。" }
}, null, 2));
