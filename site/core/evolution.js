// Shared progression rules; each game owns its transactional save boundary.
// Adapted from CharacterEvolutionList and EditUtility.CanEvolution: earn the
// prerequisite, spend matching materials once, retain identity and progression.
export const EVOLUTION_POWER = 1.12;
export const EVOLUTION_HEALTH = 1.15;
export const ELEMENT_LABELS = ['炎', '水', '土', '风', '月', '阳'];
// CharacterEvolutionList orders materials fire/wind/earth/water/moon/sun.
export const EVOLUTION_ITEMS = [6000, 6003, 6002, 6001, 6004, 6005];
export function emptyEvolution() { return { experience:{}, evolved:[], pearls:[0,0,0,0,0,0] }; }
export function normalizeEvolution(raw, ids) {
    const result=emptyEvolution(), known=new Set([...ids].map(String));
    if (!raw || typeof raw !== 'object') return result;
    for (const [id, amount] of Object.entries(raw.experience || {})) {
        if (known.has(id) && Number.isInteger(amount) && amount>=0 && amount<=3) result.experience[id]=amount;
    }
    result.evolved=[...new Set(Array.isArray(raw.evolved)?raw.evolved:[])].filter(id=>typeof id==='string'&&known.has(id));
    result.pearls=result.pearls.map((_,i)=>Number.isInteger(raw.pearls?.[i])?Math.min(9999,Math.max(0,raw.pearls[i])):0);
    return result;
}
export function isEvolved(state,id) { return state?.evolved?.includes(String(id)) || false; }
export function evolutionQuote(state,card) {
    const id=String(card?.id), element=card?.element, needed=card?.rarity===4?2:3;
    const valid=card && Number.isInteger(element) && element>=0 && element<6;
    const experience=state?.experience?.[id] || 0, owned=state?.pearls?.[element] || 0;
    const evolved=isEvolved(state,id);
    return {id,element,needed,experience,owned,evolved,
        reason:!valid?'invalid':evolved?'evolved':experience<needed?'experience':owned<needed?'pearls':null};
}
export function earnEvolution(state,cards,amount=1) {
    const next={experience:{...state.experience},evolved:[...state.evolved],pearls:[...state.pearls]};
    const elements=new Set();
    for (const card of cards) {
        const q=evolutionQuote(state,card);if(q.reason==='invalid')continue;
        next.experience[q.id]=Math.min(3,(next.experience[q.id]||0)+amount);
        elements.add(q.element);
    }
    for (const element of elements) next.pearls[element]=Math.min(9999,next.pearls[element]+amount);
    return next;
}
export function evolveCandidate(state,card) {
    const quote=evolutionQuote(state,card);
    if (quote.reason) return {reason:quote.reason};
    const next={experience:{...state.experience},evolved:[...state.evolved,quote.id],pearls:[...state.pearls]};
    next.pearls[quote.element]-=quote.needed;
    return {state:next,quote};
}
export function evolvedStats(stats,evolved) {
    if (!evolved) return stats;
    return {...stats,hp:Math.round(stats.hp*EVOLUTION_HEALTH),
        atk:stats.atk*EVOLUTION_POWER,mgc:stats.mgc*EVOLUTION_POWER};
}
