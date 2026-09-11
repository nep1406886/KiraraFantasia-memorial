// Dialogue scripts: first-run tutorial (plan 阶段 8「菜单、教学、成就」).
// Node "tutorial" — plays once per save, at the start of the first fresh run,
// right before the on-screen hint walkthrough takes over. きらら hosts: the
// prologue ends with her sending the player off with the 召唤灯, so she's the
// one teaching the controls. Lines preview the exact hint sequence
// (move → attack/dodge/skill → interact) so the banner feels familiar.
window.kirafanDialogue = Object.assign(window.kirafanDialogue || {}, {
    "tutorial": [
        { who: "きらら", face: "happy", text: "欢迎来到司书的修行现场！我是前辈琪拉拉……嗯，前辈这个词，念起来真顺口！" },
        { who: "きらら", face: "default", text: "工作内容很简单：把褪色书页里的大家平安带回来。操作就跟着屏幕上方的提示做，一条一条来！" },
        { who: "きらら", face: "joy", text: "移动是 WASD 或方向键，攻击是 J 或鼠标左键。来，先在原地走两步试试脚感！" },
        { who: "きらら", face: "happy", text: "危急关头按 K 或空格闪避，那一下是无敌的！技能键是 1、2、3——放技能的瞬间超帅气的！" },
        { who: "きらら", face: "default", text: "看到会发光的东西就按 E 互动。残页、商店、篝火……它们都是书架这边的伙伴。" },
        { who: "きらら", face: "happy", text: "那么出发！把故事一页一页救回来吧——欻——！" }
    ]
});
