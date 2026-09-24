// Browser-only regression driver. Import explicitly in ?review=1 through the
// preview tools. It drives actual UI controls and never changes money or HP.
import { UNIT_RULES, LEVELS } from "../data/campaign.js";

export function createCampaignDriver() {
    if (!window.__defenseReview?.campaignStep) { throw new Error("需要固定时钟验收入口 ?review=1"); }
    const state = () => window.__defense.snapshot().campaign;
    const actions = [];
    const waitForReady = async () => {
        const end = performance.now() + 25000;
        while (!state()?.battle?.ready && !state()?.error && performance.now() < end) {
            await new Promise(resolve => setTimeout(resolve, 80));
        }
        if (!state()?.battle?.ready || state().error) { throw new Error(state()?.error || "战场准备超时"); }
    };
    const driver = {
        actions, state,
        async begin(action = "prepare") {
            document.querySelector(`[data-action="${action}"]`).click();
            await waitForReady();
            document.querySelector('[data-action="brief-close"]').click();
            const level = LEVELS.find(row => row.id === state().level);
            await this.deploy("F01", Math.floor(level.rows / 2), 0);
            await this.deploy("U01", Math.floor(level.rows / 2), 1);
            document.querySelector('[data-action="start"]').click();
            return state();
        },
        async deploy(type, row, col) {
            let battle = state().battle;
            if (battle.resource < UNIT_RULES[type].cost || battle.cooldowns[type] > .001
                || battle.units.some(unit => unit.row === row && unit.col === col)) { return false; }
            const card = document.querySelector(`[data-card="${type}"]`);
            if (!card || card.disabled) { return false; }
            card.click();
            const point = window.__defenseReview.cellPoint(row, col);
            const canvas = document.querySelector(".battle-canvas canvas");
            const hit = document.elementFromPoint(point.x, point.y);
            if (hit !== canvas && hit && !hit.closest(".battle-canvas")) { throw new Error(`部署位置被界面遮挡：${hit.className}`); }
            for (const name of ["pointerdown", "pointerup"]) {
                canvas.dispatchEvent(new PointerEvent(name, { bubbles: true, clientX: point.x, clientY: point.y,
                    pointerId: 4, pointerType: "mouse", button: 0 }));
            }
            const end = performance.now() + 20000;
            while (state().battle.loading && performance.now() < end) { await new Promise(resolve => setTimeout(resolve, 70)); }
            if (state().error || state().battle.loading) { throw new Error(state().error || "部署准备超时"); }
            battle = state().battle;
            const success = battle.units.some(unit => unit.type === type && unit.row === row && unit.col === col);
            if (success) { actions.push({ level: battle.level, time: battle.time, type, row, col, balance: battle.resource }); }
            return success;
        },
        async tick() {
            document.querySelector('[data-action="collect"]').click();
            let battle = state().battle;
            const level = LEVELS.find(row => row.id === battle.level);
            const order = [...new Set([Math.floor(level.rows / 2), 0, level.rows - 1, 1, 3].filter(row => row < level.rows))];
            if (battle.units.filter(unit => unit.type === "F01").length < 2 && battle.time < 35) {
                const row = order.find(lane => !battle.units.some(unit => unit.row === lane && unit.col === 0));
                if (row !== undefined) { await this.deploy("F01", row, 0); }
            }
            battle = state().battle;
            const missing = order.filter(row => !battle.units.some(unit => unit.type === "U01" && unit.row === row));
            const row = missing.find(lane => battle.enemies.some(enemy => enemy.row === lane)) ?? missing[0];
            if (row !== undefined) { await this.deploy("U01", row, 1); }
            battle = state().battle;
            const covered = order.every(lane => battle.units.some(unit => unit.type === "U01" && unit.row === lane));
            if (covered && state().unlocked.includes("U11")) {
                const guard = battle.units.find(unit => unit.type === "U11"
                    && !battle.units.some(other => other.row === unit.row && other.col === 2));
                const needsHealer = state().unlocked.includes("U15") && guard;
                if (needsHealer) { await this.deploy("U15", guard.row, 2); }
                for (const tank of battle.enemies.filter(enemy => enemy.type === "E04").sort((a, b) => a.x - b.x)) {
                    if (!needsHealer && tank.x > 4.8) { await this.deploy("U11", tank.row, 4); }
                }
            }
            window.__defenseReview.campaignStep(.25);
            if (state().error) { throw new Error(state().error); }
        },
        async run(seconds = 30) {
            const start = state().battle.time;
            const deadline = performance.now() + 18000;
            while (state().battle.phase === "running" && state().battle.time < start + seconds && performance.now() < deadline) {
                await this.tick();
            }
            const battle = state().battle;
            return { level: battle.level, phase: battle.phase, time: battle.time, resource: battle.resource,
                stats: battle.stats, unlocked: state().unlocked, progress: state().progress };
        }
    };
    return driver;
}
