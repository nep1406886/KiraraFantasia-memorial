// Autonomous cards belong to the player, not to the buff or projectile pool.
// CARD definitions are immutable; a source slot owns at most one live timer.
export const NORMAL_CARD_SOURCE = 3; // 0/1/2 retain the three skill-slot identities.
const EPS = 1e-9;
const positive = value => Number.isFinite(value) && value > 0;
const alive = unit => unit && unit.kind === "player" && !unit.dead;

export function placeSkillCard(unit, sourceSlot, sourceSkillId, placement, turnSeconds) {
    if (!alive(unit) || !Number.isInteger(sourceSlot) || sourceSlot < 0 || sourceSlot > NORMAL_CARD_SOURCE
            || !placement?.card || !positive(turnSeconds)
            || !Number.isSafeInteger(placement.count) || placement.count <= 0) return null;
    const interval = turnSeconds * placement.card.loadFactor;
    const extra = unit.passives?.extraCardTriggers || 0;
    const count = placement.count + extra;
    if (!positive(interval) || !Number.isSafeInteger(count) || count <= 0) return null;
    if (!unit.skillCards) unit.skillCards = [];
    const existing = unit.skillCards.find(entry => entry.sourceSlot === sourceSlot);
    if (existing) {
        // The original refreshes aliveNum only, not its frame/order or payload.
        existing.remaining = count;
        return { action: "refreshed", entry: existing };
    }
    unit.skillCardSerial = (unit.skillCardSerial || 0) + 1;
    const entry = { id: unit.skillCardSerial, ownerId: unit.id, sourceSlot, sourceSkillId,
        card: placement.card, interval, next: interval, remaining: count, triggers: 0 };
    unit.skillCards.push(entry);
    return { action: "placed", entry };
}

export function clearSkillCards(unit) {
    if (unit?.skillCards) unit.skillCards.length = 0;
}

export function updateSkillCards(unit, dt, trigger) {
    if (!alive(unit) || !positive(dt) || typeof trigger !== "function") return;
    let left = dt;
    while (unit.skillCards?.length && alive(unit)) {
        const cards = unit.skillCards;
        const next = Math.min(...cards.map(entry => entry.next));
        if (next > left + EPS) {
            for (const entry of cards) entry.next -= left;
            break;
        }
        for (const entry of cards) entry.next = Math.max(0, entry.next - next);
        left = Math.max(0, left - next);
        // Tie order is creation order, independent of slot or object-key order.
        const due = cards.filter(entry => entry.next <= EPS);
        for (const entry of due) {
            if (!alive(unit) || !unit.skillCards.includes(entry)) break;
            entry.remaining -= 1;
            entry.triggers += 1;
            entry.next = entry.interval;
            if (entry.remaining <= 0) unit.skillCards.splice(unit.skillCards.indexOf(entry), 1);
            // Debit before calling world code: a death/room clear inside the
            // callback cannot leave the same occurrence payable a second time.
            trigger(entry);
        }
        if (left <= EPS) break;
    }
}
