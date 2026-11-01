// 纸面骨架屏：载入期的占位骨条。颜色（--line-soft 打底、--paper-raised 高光）
// 与 1.4s 呼吸 shimmer 全部定义在 styles/shell.css 的 .load-bones / .load-bone 里，
// 这里只负责搭 DOM，不写内联动画；减动效由 shell.css 末尾的全局减动效块接管。

// 生成一节骨条。单格场景（肖像垫块、网格单元）直接取回元素自行定位。
export function loadBoneCell() {
    const bone = document.createElement("div");
    bone.className = "load-bone";
    return bone;
}

// 在 host 里铺一组骨条（默认 3 条，条宽由 shell.css 的 nth-child 错开），
// 返回容器元素；载入完成后调用方以 group.remove() 收走即可。
export function loadBones(host, { rows = 3 } = {}) {
    const group = document.createElement("div");
    group.className = "load-bones";
    group.setAttribute("aria-hidden", "true");
    for (let i = 0; i < Math.max(1, rows); i++) { group.append(loadBoneCell()); }
    host.append(group);
    return group;
}
