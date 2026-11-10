// Dialogue scripts: first-run tutorial (plan 阶段 8「菜单、教学、成就」).
// Node "tutorial" — plays once per save, at the start of the first fresh run,
// right before the on-screen hint walkthrough takes over. きらら hosts: the
// prologue ends with her sending the player off with the 召唤灯, so she's the
// one teaching the controls. Lines preview the exact hint sequence
// (move → attack/dodge/skill → interact) so the banner feels familiar.
window.kirafanDialogue = Object.assign(window.kirafanDialogue || {}, {
    "tutorial": [
        { who: "きらら", face: "happy", text: "召唤灯准备好了。出发前，先和我熟悉一下这段旅途吧。" },
        { who: "きらら", face: "default", text: "用方向键或 WASD 移动，按 J 或鼠标左键攻击。屏幕上有触控按钮的话，也可以直接拖动和点击。" },
        { who: "きらら", face: "joy", text: "靠近敌人时，普通攻击会帮你瞄准；想选定方向，就移动鼠标或拖动攻击按钮。挥击时也能慢慢走位。" },
        { who: "きらら", face: "happy", text: "地面亮起预警时，先离开标记。按 K 或空格闪避可以短暂避开伤害，等对手收招，再用 2、3 技能反击；必杀蓄满后按 R。" },
        { who: "きらら", face: "default", text: "发光的书页、商店和篝火，用 E 互动。拿到装备时先看看变化：武器可以强化招式，其他装备负责属性与战斗习惯。" },
        { who: "きらら", face: "happy", text: "不用一下记住全部，菜单里随时能翻看指南。接下来，把今天的第一行写下来吧。" }
    ]
});
