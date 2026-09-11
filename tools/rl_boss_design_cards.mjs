// 逐首领设计卡数据：真实解码技能载荷与编排，合并当前版实测压力。数字全部可溯源。
// 数据源：encounters/volumes/enemies/skills-rl（真解码 enemyMoveset/enemyRole）
// + boss-scan.json（孤立首领战，当前版测量器）+ route-volume-scan.json（整卷链 boss 房明细）。
// 输出 .codex-tmp/world-balance/boss-cards.json；这不是平衡批准，也不是玩家胜率。
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enemyMoveset } from "../site/game/rl/skills.js";
import { enemyRole } from "../site/game/rl/enemyroles.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = name => JSON.parse(readFileSync(resolve(ROOT, name), "utf8"));
const round = value => Math.round(value * 1000000) / 1000000;
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    if (!sorted.length) { return null; }
    const at = Math.floor(sorted.length / 2);
    return round(sorted.length % 2 ? sorted[at] : (sorted[at - 1] + sorted[at]) / 2);
}

function main() {
    const volumes = read("site/asset/rl/encounters.json").volumes;
    const volumeMeta = read("site/asset/rl/volumes.json");
    const metaList = Array.isArray(volumeMeta.volumes) ? volumeMeta.volumes : Object.values(volumeMeta);
    const enemies = read("site/asset/rl/enemies.json").enemies;
    const skills = read("site/asset/rl/skills-rl.json");
    const bossScan = read(".codex-tmp/world-balance/boss-scan.json").rows;
    const chainScan = read(".codex-tmp/world-balance/route-volume-scan.json").rows;
    const CONFUSION = 999999; // enemyMoveset 运行时排除的混乱行为行
    const rows = volumes.map(enc => {
        const boss = enc.boss;
        const narrative = (metaList.find(row => row.vol === enc.vol) || {}).boss || null;
        const enemyRow = enemies.find(row => row.id === boss.id) || null;
        const moveset = enemyMoveset(skills, boss.skills);
        const role = enemyRole(boss.id, moveset);
        const iso = bossScan.filter(row => row.volume === enc.vol);
        const isoPerCard = [...new Set(iso.map(row => row.cardId))].map(cardId => {
            const list = iso.filter(row => row.cardId === cardId);
            return { cardId, results: list.map(row => row.result),
                clearSeconds: list.filter(row => row.clearSeconds).map(row => row.clearSeconds),
                bossHpFraction: list.map(row => row.final?.bossHpFraction).filter(v => v != null) };
        });
        const isoPooled = {
            samples: iso.length,
            clear: iso.filter(row => row.result === "clear").length,
            death: iso.filter(row => row.result === "death").length,
            timeout: iso.filter(row => row.result === "timeout").length,
            medianClearSeconds: median(iso.filter(row => row.result === "clear").map(row => row.clearSeconds)),
            timeoutBossHpFractionMedian: median(iso.filter(row => row.result === "timeout")
                .map(row => row.final?.bossHpFraction).filter(v => v != null)),
            deathBossHpFractionMedian: median(iso.filter(row => row.result === "death")
                .map(row => row.final?.bossHpFraction).filter(v => v != null))
        };
        const chains = chainScan.filter(row => row.volume === enc.vol);
        const bossRooms = chains.flatMap(row => (row.floors || [])
            .filter(floor => floor.bossRoom).map(floor => ({ ...floor.bossRoom, floor: floor.floor })));
        // 每层小首领房与第 20 层真首领分开统计：encounters 的卷首领只在第 20 层出场。
        const finalRooms = bossRooms.filter(row => row.floor === 20);
        const chained = {
            runs: chains.length,
            volumeClears: chains.filter(row => row.result === "clear").length,
            bossRoomSamples: bossRooms.length,
            bossClears: bossRooms.filter(row => row.result === "clear").length,
            bossDeaths: bossRooms.filter(row => row.result === "death").length,
            bossTimeouts: bossRooms.filter(row => row.result === "timeout").length,
            medianClearSeconds: median(bossRooms.filter(row => row.result === "clear").map(row => row.seconds)),
            finalBossSamples: finalRooms.length,
            finalBossClears: finalRooms.filter(row => row.result === "clear").length,
            finalBossDeaths: finalRooms.filter(row => row.result === "death").length,
            finalBossTimeouts: finalRooms.filter(row => row.result === "timeout").length,
            finalBossMedianClearSeconds: median(finalRooms.filter(row => row.result === "clear").map(row => row.seconds))
        };
        return { volume: enc.vol, playerLevel: enc.playerLevel, tier: enc.tier,
            narrative, fight: { id: boss.id, name: boss.name, nameZh: boss.nameZh || null,
                model: boss.model, element: boss.element, shadowScale: boss.shadowScale,
                voiceCueSheet: boss.voiceCueSheet || "", hpScale: boss.hpScale, skillIds: boss.skills },
            stats: enemyRow ? { init: enemyRow.init, max: enemyRow.max, stunCoef: enemyRow.stunCoef } : null,
            moveset, role, isolated: { pooled: isoPooled, perCard: isoPerCard }, chained };
    });
    const sourceFiles = ["site/asset/rl/encounters.json", "site/asset/rl/volumes.json", "site/asset/rl/enemies.json",
        "site/asset/rl/skills-rl.json", "site/game/rl/skills.js", "site/game/rl/enemyroles.js",
        "tools/rl_world_balance.mjs", "tools/rl_boss_design_cards.mjs"];
    const hashes = Object.fromEntries(sourceFiles.map(file => [file,
        createHash("sha256").update(readFileSync(resolve(ROOT, file))).digest("hex")]));
    const report = { schema: 1, instrument: "boss-design-cards", assumptions: {
        isolated: "floor20 基线等级五代表 × seed 17,53,101（boss-scan.json，当前版测量器）",
        chained: "整卷链 boss 房明细（等级由经验成长），来源 route-volume-scan.json",
        moveset: "site/game/rl/skills.js enemyMoveset 真实解码；" + CONFUSION + " 混乱行为行按运行时定义排除",
        identity: "叙事首领（volumes.json）与战斗首领（encounters.json）分别记录，不按数值相等合并",
        role: "site/game/rl/enemyroles.js 授权编排，含每个动作的预警/恢复与对策文案"
    }, sources: hashes, rows };
    const output = resolve(ROOT, ".codex-tmp/world-balance/boss-cards.json");
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log("逐首领设计卡数据完成：" + rows.length + " 卡；输出 " + output);
}

main();
