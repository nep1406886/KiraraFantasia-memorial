// Browser-only facing gate. The expectation comes from each rig's authored
// attack, never from the mirror table under test: skill_0 must lunge toward
// the defenders, who always stand to the left of incoming enemies.
import { ENEMY_RULES } from "../data/campaign.js";
import { loadRuntimeAssets } from "../app/assets.js";
import { NativeModel, posedBounds } from "../render/native-model.js";

// only：限定要复核的 rig（resourceId 数组），新魔物接模型后只跑增量，
// 不必每次把全部魔物拉起来。invert：实测定向背离防线的 resourceId，
// 翻转后再测（对齐 enemy-motion 的 mirrorForLeft 结论）。
export async function checkEnemyFacing({ invert = [], only = null } = {}) {
    const assets = await loadRuntimeAssets();
    const wanted = only ? new Set(only) : null;
    const results = [];
    for (const spec of Object.values(ENEMY_RULES)) {
        if (wanted && !wanted.has(spec.resourceId)) { continue; }
        const model = await NativeModel.enemy(assets, spec);
        try {
            if (invert.includes(spec.resourceId)) { model.scaled.scale.x *= -1; }
            const centre = () => {
                model.group.updateMatrixWorld(true);
                const box = posedBounds(assets.THREE, model.group);
                return (box.min.x + box.max.x) / 2;
            };
            model.play("idle");
            model.mixer.setTime(0);
            const rest = centre();
            model.play("skill_0", false);
            const duration = model.clips.get("skill_0").duration;
            let left = 0;
            let right = 0;
            for (let i = 0; i <= 48; i++) {
                model.mixer.setTime(duration * i / 48);
                const dx = centre() - rest;
                left = Math.max(left, -dx);
                right = Math.max(right, dx);
            }
            results.push({ id: spec.id, resourceId: spec.resourceId, mirrorSign: Math.sign(model.scaled.scale.x),
                lungeLeft: +left.toFixed(3), lungeRight: +right.toFixed(3) });
        } finally { model.dispose(); }
    }
    if (wanted) {
        const seen = new Set(results.map(row => row.resourceId));
        const missing = [...wanted].filter(resourceId => !seen.has(resourceId));
        if (missing.length) { throw new Error(`facing-check 缺 rig：${missing.join("、")}`); }
    }
    const wrong = results.filter(row => row.lungeLeft <= row.lungeRight);
    if (wrong.length) { throw new Error(`魔物出招背离防线：${wrong.map(row => row.resourceId).join("、")}`); }
    return results;
}
