// One source for the existing impact pauses. Presentation and deterministic
// world drivers share this query; only world.applyHitStop owns the freeze.
export function hitStopFor(event) {
    if (!event || event.type !== "hit") { return 0; }
    if (event.target?.kind === "player") { return 0.07; }
    if (event.attacker?.kind !== "player") { return 0; }
    if (event.crit) { return 0.08; }
    return event.bullet ? 0 : 0.045;
}
