// Original SkillIcon.cs families shared by the detail sheet and battle HUD.
export const SKILL_ICON_BY_TYPE = {
    3: { name: "skill-attack", silhouette: true },
    4: { name: "skill-magic", silhouette: true },
    5: { name: "skill-recovery" },
    6: { name: "skill-buff" },
    7: { name: "skill-debuff" }
};
// UIUtility.GetIconColor's authored +1 lookup, not combat element logic.
export const ELEMENT_TINT = { 1: "#808080", 2: "#ff5714", 3: "#48bcd8",
    4: "#f58a0b", 5: "#5cc855", 6: "#e071cb" };
const ASSETS = new URL("../../../asset/img/rl/drop/", import.meta.url);

export function skillArt(slot, element) {
    const fallback = slot.damage ? (slot.damage.magic ? 4 : 3)
        : slot.heal > 0 || slot.regen ? 5 : slot.debuff ? 7 : 6;
    const art = SKILL_ICON_BY_TYPE[slot.skillType] || SKILL_ICON_BY_TYPE[fallback];
    return { ...art, url: new URL(art.name + ".webp", ASSETS).href,
        tint: ELEMENT_TINT[element + 1] || ELEMENT_TINT[1] };
}
