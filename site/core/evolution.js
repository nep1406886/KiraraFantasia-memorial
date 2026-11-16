// Each run owns growth, payment and the resulting form. Legacy permanent
// records remain readable for backup compatibility; they no longer grant stats.
export const EVOLUTION_POWER = 1.12;
export const EVOLUTION_HEALTH = 1.15;
export const DEFENSE_EVOLUTION_SECONDS = 20;
export const ADVENTURE_EVOLUTION_ROOMS = 3;
export const ADVENTURE_EVOLUTION_COINS = 60;
export const defenseEvolutionCost = cost => Math.max(80, Math.ceil(cost * .8 / 10) * 10);
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
export function evolvedStats(stats,evolved) {
    if (!evolved) return stats;
    return {...stats,hp:Math.round(stats.hp*EVOLUTION_HEALTH),
        atk:stats.atk*EVOLUTION_POWER,mgc:stats.mgc*EVOLUTION_POWER};
}
