// Contract checks for the current-card coverage ledger; not gameplay acceptance.
// node tools/rl_coverage_harness.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PLAYABLE_ROSTER } from "../site/game/rl/rosterids.js";
const root = new URL("../", import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const before = readFileSync(new URL("docs/combat-identities.json", root), "utf8");
const check = spawnSync(process.execPath, [fileURLToPath(new URL("tools/build_rl_skill_coverage.mjs", root)), "--check"], { encoding: "utf8" });
assert.equal(check.status, 0, check.stdout + check.stderr);
assert.equal(readFileSync(new URL("docs/combat-identities.json", root), "utf8"), before);
const report = read("docs/skill-coverage.json"), byId = new Map(report.characters.map(row => [row.cardId, row]));
assert.equal(report.schemaVersion, 3);
assert.equal(report.totals.characters, 41); assert.equal(report.totals.activeSkills, 82);
assert.equal(report.totals.ultimates, 41); assert.equal(report.totals.sourceSkills, 123);
assert.equal(byId.size, 41);
assert.deepEqual(new Set(byId.keys()), new Set(PLAYABLE_ROSTER.map(row => row.id)));
for (const identity of PLAYABLE_ROSTER) {
    const row = byId.get(identity.id);
    assert.equal(row.legacyId, identity.legacyId); assert.equal(row.sourceId, identity.sourceId);
    assert.equal(row.resourceId, identity.resourceId); assert.equal(row.class.id, identity.class);
    assert.equal(row.skills.length, 3); assert.equal(row.skills[0].role, "ultimate");
    assert.equal(row.skills.filter(skill => skill.role === "skill").length, 2);
    if (row.historicalEvidence) {
        assert.equal(row.historicalEvidence.cardId, identity.legacyId);
        assert.equal(row.historicalEvidence.transferable, false);
        assert.notDeepEqual(row.validation, row.historicalEvidence.validation);
    }
}
for (const [id, cls] of [[15002001, 1], [20002001, 1], [19002001, 2], [47002001, 3]]) assert.equal(byId.get(id).class.id, cls);
assert.equal(byId.get(15002001).historicalEvidence.class, 0);
assert.equal(byId.get(15002001).historicalEvidence.sameClass, false);
for (const [id, kind, range] of [[14002001, "slash", 2.1], [23002001, "projectile", 10],
    [10002001, "projectile", 8], [29002001, "thrust", 3.1], [38002001, "projectile", 7]]) {
    assert.equal(byId.get(id).defaultAttack.kind, kind); assert.equal(byId.get(id).defaultAttack.range, range);
}
assert.equal(byId.get(36002001).skills[2].executable.usable, true);
assert.ok(byId.get(36002001).skills[2].unsupported.some(effect => effect.kind === 5));
assert.equal(report.playerSpeedAdaptation.affects, "ordinary-skill-recovery");
assert.equal(report.skillCardAdaptation.namespace, "CARD");
assert.equal(report.skillCardAdaptation.persisted, false);
for (const [id, ref] of [[12002001, 10001], [21002001, 10004], [24002001, 10005],
    [25002001, 10007], [32002001, 10014], [39002001, 10050]]) {
    const slot = byId.get(id).skills.find(s => s.executable.cardPlacements.some(p => p.card.id === ref));
    assert.ok(slot, "missing actual CARD payload " + ref);
    assert.ok(!slot.unsupported.some(effect => effect.kind === 21));
}
assert.deepEqual(report.playerSpeedAdaptation.rate, { min: .5, max: 2 });
assert.equal(report.statResetAdaptation.legacySixMasks, "both-signs");
assert.equal(report.statResetAdaptation.enemySelfAndSupportUnimplemented, true);
assert.deepEqual(byId.get(46002001).skills[1].executable.statResets,
    [{ target: 0, stats: ["mdef"], mode: "down" }]);
assert.ok(!byId.get(46002001).skills[1].unsupported.some(effect => effect.kind === 3));
assert.ok(byId.get(46002001).skills[2].unsupported.some(effect => effect.kind === 4));
assert.equal(report.nextCriticalAdaptation.weaponChild, 320320013);
assert.equal(report.nextCriticalAdaptation.consumption, "committed-player-damage-action");
assert.deepEqual(report.nextCriticalAdaptation.includes, ["normal", "skill", "ultimate"]);
assert.deepEqual(report.nextCriticalAdaptation.excludes, ["CARD", "enemy-support"]);
assert.equal(report.nextCriticalAdaptation.persisted, false);
assert.ok(report.characters.every(c => c.skills.every(s => s.executable.nextCriticals.length === 0)),
    "the global weapon-affix entry is not a native skill of the current roster");
assert.equal(report.totals.sourceSkillsWithGaps, report.characters.reduce((n, c) => n + c.skills.filter(s => s.unsupported.length).length, 0));
console.log("Coverage: current 41-card provenance, 123 slots, five attack ranges, historical isolation and --check passed.");
