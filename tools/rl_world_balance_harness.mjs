import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hitStopFor } from "../site/game/rl/impact.js";
import { PLAYABLE_IDS, PLAYABLE_ROSTER } from "../site/game/rl/rosterids.js";
import { loadMeasurementData, createMeasurementWorld, measureBattle, measureVolumeRoute, summarizeMeasurements } from "./rl_world_balance.mjs";

let checks = 0;
function test(name, fn) { fn(); checks++; console.log("PASS " + name); }
const common = { cardId: 14002001, mode: "training", seconds: 20, seed: 17 };
const data = loadMeasurementData();

test("命中顿帧提取保持原有四个固定值且不修改事件", () => {
    const player = Object.freeze({ kind: "player" }), enemy = Object.freeze({ kind: "enemy" });
    const hit = Object.freeze({ type: "hit", attacker: player, target: enemy });
    assert.equal(hitStopFor(hit), .045);
    assert.equal(hitStopFor({ ...hit, bullet: true }), 0);
    assert.equal(hitStopFor({ ...hit, bullet: true, crit: true }), .08);
    assert.equal(hitStopFor({ ...hit, attacker: enemy, target: player }), .07);
    assert.equal(hitStopFor({ ...hit, attacker: enemy }), 0);
    assert.equal(hitStopFor(null), 0);
    assert.equal(hitStopFor({ type: "heal", target: player }), 0);
});
test("同种子真实固定步进的全部测量结果完全一致", () => {
    const first = measureBattle({ ...common, traceLimit: 32 });
    assert.deepEqual(measureBattle({ ...common, traceLimit: 32 }), first);
});
test("不输入动作的负例没有输出也没有凭空积累必杀量能", () => {
    const row = measureBattle({ ...common, policy: "idle", seconds: 5 });
    assert.equal(row.damage.dealt, 0);
    assert.equal(row.initial.gauge, 0);
    assert.equal(row.final.gauge, 0);
    assert.equal(row.firstUltimateSeconds, null);
    assert.equal(row.final.hp, row.initial.hp);
});
test("五职业都通过实际普攻命中，远程没有被误标成普通技能", () => {
    for (let job = 0; job < 5; job++) {
        const cardId = PLAYABLE_ROSTER.find(card => card.class === job).id;
        const row = measureBattle({ ...common, cardId, actions: "basic", seconds: 8 });
        assert.ok(row.damage.normal > 0, "职业 " + job + " 缺少实际普攻伤害");
        assert.equal(row.damage.skill, 0);
        assert.equal(row.damage.ultimate, 0);
        assert.equal(row.counts.skill || 0, 0);
        assert.equal(row.counts.ultimateSpent || 0, 0);
        if ([1, 2, 4].includes(job)) { assert.ok(row.firstHitSeconds > .2, "远程不得在出手前瞬间命中"); }
    }
});
test("混合策略只在真实伤害取得量能以后消费独立必杀", () => {
    const row = measureBattle(common);
    assert.equal(row.initial.gauge, 0);
    assert.ok(row.damage.skill > 0 && row.damage.ultimate > 0);
    assert.ok(row.firstUltimateSeconds > row.firstHitSeconds);
    assert.ok(row.counts.ultimateSpent > 0 && row.counts.ultimateSpent < row.counts.hit);
    assert.equal(row.counts.ultimate, row.counts.ultimateSpent);
    assert.equal(row.damage.dealt, row.damage.normal + row.damage.skill + row.damage.ultimate);
});
test("顿帧时间与模拟时间分开，关闭顿帧的对照不改变数值来源", () => {
    const normal = measureBattle({ ...common, actions: "basic" });
    const noPause = measureBattle({ ...common, actions: "basic", hitStop: false });
    assert.deepEqual(normal.initial, noPause.initial);
    assert.ok(normal.simulationSeconds < normal.seconds);
    assert.equal(noPause.simulationSeconds, noPause.seconds);
    assert.ok(noPause.damage.dealt > normal.damage.dealt);
});
test("第20层按真实入口生成当前卷首领并应用段级敌人等级", () => {
    const { world } = createMeasurementWorld({ ...common, mode: "boss", floor: 20 });
    assert.equal(world.room.type, "boss");
    assert.equal(world.enemies[0].enemyId, 99038006);
    assert.equal(world.enemies[0].kind, "boss");
    assert.equal(world.enemies[0].atk, data.stats.enemyStats(99038006, 4).atk);
    const early = createMeasurementWorld({ ...common, mode: "boss", floor: 5 }).world;
    assert.ok(early.enemies[0].elite);
    assert.equal(early.enemies[0].kind, "enemy");
});
test("整卷路线携带独立基线配装并保留装备快照", () => {
    const quick = { ...common, volume: 2, seconds: 1 / 60 };
    const bare = measureVolumeRoute({ ...quick, loadout: "none" });
    const matching = measureVolumeRoute({ ...quick, loadout: "matching" });
    assert.deepEqual(bare.equipment, []);
    assert.equal(matching.equipment.length, 1);
    assert.equal(matching.equipment[0].slot, "weapon");
    assert.equal(matching.initial.level, 30);
    const stage = measureVolumeRoute({ ...quick, loadout: "stage" });
    assert.deepEqual(stage.equipment.map(row => row.slot), ["weapon", "amulet", "armor", "charm"]);
    assert.ok(stage.equipment.slice(1).every(row => row.rarity === "common"
        && row.affixes?.length === 1));
});
test("超时有独立状态且绝不当作成功击杀时间混入中位数", () => {
    const timeout = measureBattle({ ...common, mode: "boss", seconds: 1 / 60, policy: "idle" });
    assert.equal(timeout.result, "timeout");
    assert.equal(timeout.clearSeconds, null);
    const summary = summarizeMeasurements([timeout, { ...timeout, result: "clear", clearSeconds: 5 }])[0];
    assert.equal(summary.timedOut, 1);
    assert.equal(summary.cleared, 1);
    assert.equal(summary.medianClearSeconds, 5);
});
test("跨职从真实装备入口生效，身份不变且有益收益保持65%", () => {
    const bare = createMeasurementWorld(common).world.player;
    const matching = createMeasurementWorld({ ...common, loadout: "matching" }).world.player;
    const cross = createMeasurementWorld({ ...common, loadout: "cross" }).world.player;
    assert.equal(matching.card.id, bare.card.id);
    assert.equal(cross.card.id, bare.card.id);
    assert.equal(matching.weaponProfile.classId, 0);
    assert.equal(cross.weaponProfile.classId, 1);
    assert.equal(cross.weaponProfile.proficiency, .65);
    assert.equal(matching.atk, bare.atk + 30);
    assert.equal(cross.mgc, bare.mgc + 30 * .65);
});
test("当前41张卡全走正常生成入口而不是旧剧情名单", () => {
    assert.equal(PLAYABLE_IDS.length, 41);
    for (const entry of PLAYABLE_ROSTER) {
        const player = createMeasurementWorld({ ...common, cardId: entry.id }).world.player;
        assert.equal(player.card.id, entry.id);
        assert.equal(player.card.resourceId, entry.resourceId);
        assert.equal(player.weaponProfile.classId, entry.class);
    }
});
test("错误配置显式拒绝，记录保持有界", () => {
    for (const change of [{ cardId: 10000000 }, { seconds: NaN }, { seconds: 0 }, { seconds: 301 },
        { volume: 6 }, { seed: -1 }, { level: 0 }, { floor: 21 }, { policy: "guessed" }, { loadout: "invented" }]) {
        assert.throws(() => measureBattle({ ...common, ...change }));
    }
    assert.equal(measureBattle({ ...common, traceLimit: 3 }).trace.length, 3);
});
test("真实命令行报告覆盖技能卡、弹池和固定步长依赖的源码指纹", () => {
    const root = new URL("../", import.meta.url);
    const output = new URL(".codex-tmp/world-balance/source-harness-" + process.pid + ".json", root);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("tools/rl_world_balance.mjs", root)),
        "--cards", "14002001", "--volumes", "1", "--seeds", "17", "--modes", "training",
        "--levels", "1", "--loadouts", "none", "--policy", "idle", "--seconds", String(1 / 60),
        "--json", fileURLToPath(output)], { cwd: fileURLToPath(root), encoding: "utf8", windowsHide: true, timeout: 20000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.rows.length, 1); assert.equal(report.rows[0].steps, 1);
    for (const file of ["site/game/rl/skillcards.js", "site/game/rl/pool.js", "site/game/rl/clock.js"]) {
        assert.equal(report.sources[file], createHash("sha256").update(readFileSync(new URL(file, root))).digest("hex"), file);
    }
});
console.log("World balance instrument: " + checks + " checks passed; not a balance approval");
