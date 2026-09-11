// T29 辅助设置 (spec/06): view-layer feedback switches. The flags are read at
// call time by the camera and enemy views, so a mid-run menu change applies
// without rebuilding any view or touching world logic, hit ranges or the
// fixed step. Storage stays the single source of truth; boot and the menu
// both funnel their settings snapshot through applyAccessibility.
export const accessibility = {
    reducedShake: false,
    reducedFlash: false,
    simplifiedUltimates: false
};

export function applyAccessibility(settings) {
    accessibility.reducedShake = settings["reduced-shake"] === true;
    accessibility.reducedFlash = settings["reduced-flash"] === true;
    accessibility.simplifiedUltimates = settings["simplified-ultimates"] === true;
    return accessibility;
}
