// 战场上的辅助面片（阴影、选中框、网格、地面、射程预览）统一用
//「预乘 alpha 但留在不透明队列」的混合状态：
//
// three.js 在 transparent=false 下会把 NormalBlending 强制成 NoBlending，
// 只有 CustomBlending 的方程能保留下来；而这些面片必须留在不透明队列，
// 否则它们会被排在所有角色之后，盖住本应在前面的角色。渲染顺序因此
// 仍然由各自的 renderOrder 决定。整块值是战场的既定口径，散落在
// 各处的副本一旦漂移就会出现「某块面片突然不透」的假象。
export function premultipliedBlend(THREE) {
    return {
        transparent: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor
    };
}
