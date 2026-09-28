// Browser-only facing gate. The expectation comes from each rig's authored
// attack, never from the mirror table under test: skill_0 must lunge toward
// the defenders, who always stand to the left of incoming enemies.
import { ENEMY_RULES } from "../data/campaign.js";
import { loadRuntimeAssets } from "../app/assets.js";
import { NativeModel, posedBounds } from "../render/native-model.js";

export async function checkEnemyFacing({ invert = [] } = {}) {
    const assets = await loadRuntimeAssets();
    const results = [];
    for (const spec of Object.values(ENEMY_RULES)) {
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
    const wrong = results.filter(row => row.lungeLeft <= row.lungeRight);
    if (wrong.length) { throw new Error(`魔物出招背离防线：${wrong.map(row => row.resourceId).join("、")}`); }
    return results;
}
