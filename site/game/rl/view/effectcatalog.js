// Pure selection of authored effect events. Kept independent of the GPU/DOM so
// data tools can verify class, element and explicit-skill precedence directly.
export const ELEMENT_NAMES = ["fire", "water", "earth", "wind", "moon", "sun"];
const CLASSES = ["Fighter", "Magician", "Priest", "Knight", "Alchemist"];
// Supplied priest line masks occupy the opposite V half from their mesh UVs.
// The sun asset has different art and is already aligned. Keep this measured
// adapter explicit; do not flip other effects or mutate the native templates.
const PRIEST_FLIP_V = new Set(["fire", "water", "earth", "wind", "moon"]
    .map(element => "ef_btl_priest_attack_" + element + "_00"));

export function graphicFor(index, unit, skill) {
    const element = ELEMENT_NAMES[unit.element] || ELEMENT_NAMES[0];
    const name = index.skills[String(skill && skill.id)]
        || (CLASSES[unit.weaponProfile?.classId ?? unit.card?.class] || CLASSES[0]) + "_attack";
    return index.graphics[name + ":" + element] || { source: name, events: [] };
}

export function projectileEvent(graphic) {
    const authored = graphic.events.find(ev => ev.kind.startsWith("EffectProjectile"));
    if (authored) { return authored; }
    // The original priest normal is a single EffectPlay, not a projectile
    // event. Carry that exact art on the realtime shot; do not invent an oval
    // or also play the same effect at the caster. Other skill events keep their
    // authored delivery rather than being guessed into moving projectiles.
    // The alchemist's authored normal is not an EffectProjectile event either:
    // the _01 scene attaches at frame 12 and its 20-frame timeline holds the
    // launched piece through frame 19. Carry that exact section on the realtime
    // shot rather than falling back to the generic bullet.
    const alchemist = graphic.source.startsWith("Alchemist")
        && graphic.events.find(ev => ev.kind === "EffectAttach");
    if (alchemist) {
        // The normal's authored launch section (frame 12-19 of the _01 scene)
        // is fixed by measurement. Skill _01 scenes (21 frames, emitter
        // active 2-18) get their visible window resolved against the loaded
        // timeline below, so every grade/element keeps its authored launch.
        return graphic.source === "Alchemist_attack"
            ? { ...alchemist, frameRange: [12, 19] } : { ...alchemist };
    }
    const priest = graphic.source === "Priest_attack"
        && graphic.events.find(ev => ev.kind === "EffectPlay");
    // All six exported priest timelines expose the line at frame 11, hold full
    // alpha through 18, and hide it at 23 (30 fps). The world already completed
    // wind-up before spawning the shot, so cycle the authored visible section.
    if (priest) { return { ...priest, frameRange: [11, 19], flipLineV: PRIEST_FLIP_V.has(priest.effect) }; }
    // Knight class skills ship as one authored swing (charge 18-36, waves
    // 38-54, tail 62-82 across all six elements) with no separate projectile
    // scene. The world launches a fast hit-shot for those single-target hits;
    // ride the authored wave section on the shot rather than the oval.
    const knight = graphic.source.startsWith("Knight") && !graphic.source.endsWith("_attack")
        && graphic.events.find(ev => ev.kind === "EffectPlay");
    return knight ? { ...knight, frameRange: [38, 54] } : null;
}

// Only ordinary melee art is stretched. Skill scenes retain authored dimensions;
// projectile size and lifetime already follow the world's launch snapshot.
export function normalEffectConfig(unit) {
    const g = unit.swingGadgets || unit.gadgets || {};
    const profile = unit.swingProfile || unit.weaponProfile || {};
    const range = g.range || 1, width = g.width || 1;
    const config = { duration: .25 / (g.rate || 1), stretchX: range,
        stretchY: profile.kind === 'slash' ? range * width : width };
    // The world already completed wind-up before swingActive. Resume the
    // authored blade, not a second preparation; keep its existing rate/tail.
    if (profile.kind === 'slash' || profile.kind === 'thrust') {
        config.startFrame = profile.kind === 'slash' ? 9 : 11;
        config.combatPivot = true;
    }
    return config;
}
