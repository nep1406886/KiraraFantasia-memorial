// Dialogue scripts: boss pre/post per volume (spec/05 §7 deliverable
// "Boss 戦前後 10 节点 ×≤6 句"). Bosses come from QuestEnemyList with voice
// priority (spec/05 §3): テンペスト / カレーの化身 / 合体マタンゴ /
// メカこけし / ハイプリス. All lines original (harness-checked).
window.kirafanDialogue = Object.assign(window.kirafanDialogue || {}, {
    v1_boss_pre: [
        { who: "きらら", face: "surprise", text: "是暴风的化身！那些书页都卷在风里……先让它停下来！" },
        { who: "うつつ", face: "default", text: "别急着往前冲。看清它的动作，等有空隙再靠近。" }
    ],
    v1_boss_post: [
        { who: "きらら", face: "joy", text: "风暴停了！云后面的阳光照下来了，海面也重新亮了起来！" },
        { who: "うつつ", face: "default", text: "把散开的页子收好。剩下的路，终于不用顶着风走了。" }
    ],

    v2_boss_pre: [
        { who: "きらら", face: "shy", text: "好浓的香料味……它一动，沙子都跟着翻起来了！" },
        { who: "うつつ", face: "default", text: "先看它要往哪边动。肚子再饿，也不能把对手当成晚饭。" }
    ],
    v2_boss_post: [
        { who: "きらら", face: "happy", text: "那股呛人的味道淡下来了。现在再闻，倒像有人刚做好一锅热饭。" },
        { who: "うつつ", face: "default", text: "把菜单的事留到回去吧。先确认大家都没有受伤。" }
    ],

    v3_boss_pre: [
        { who: "きらら", face: "sorrow", text: "蘑菇越聚越多，竟然合成了这么大一只！别、别再靠过来了！" },
        { who: "うつつ", face: "default", text: "看着可爱也别伸手。我们先绕开它，再找靠近的机会。" }
    ],
    v3_boss_post: [
        { who: "きらら", face: "happy", text: "鸟叫声回来了……原来刚才不是森林太安静，是声音都被它盖住了。" },
        { who: "うつつ", face: "default", text: "让森林自己慢慢热闹起来吧。我们收好书页，不再打扰它。" }
    ],

    v4_boss_pre: [
        { who: "きらら", face: "surprise", text: "好大的人偶！刚才还一动不动，怎么突然朝这边转过来了？" },
        { who: "うつつ", face: "default", text: "它把我们当成了入侵者。先躲开，再想办法让它停下来。" }
    ],
    v4_boss_post: [
        { who: "きらら", face: "joy", text: "它停下来了。刚才那么响的齿轮，现在只剩很轻的咔嗒声。" },
        { who: "うつつ", face: "default", text: "别再惊动它。把这里的记录补好，也算替工房留个交代。" }
    ],

    v5_boss_pre: [
        { who: "ハイプリス", face: "sorrow", text: "你们还想往后翻吗？如果把故事停在这里，就不会有人读到离别。" },
        { who: "きらら", face: "shy", text: "可是，别的故事正在褪色。为了让这一页不结束，就让大家的相遇消失吗？" },
        { who: "うつつ", face: "default", text: "留住一页，不该让整本书都变成空白。把路让开，我们也想听见后面的故事。" },
        { who: "ハイプリス", face: "angry", text: "说得倒轻巧……那就让我看看，你们究竟能把这些故事护到哪里。" }
    ],
    v5_boss_post: [
        { who: "ハイプリス", face: "sorrow", text: "我还是害怕结束。只是……看着你们带回来的书页，好像也没那么想把这一页合上了。" },
        { who: "きらら", face: "happy", text: "不用现在就写好结尾。愿意的话，先和我们一起想下一句吧。" },
        { who: "うつつ", face: "default", text: "也不用每次都开一场选题会。先写下今天，再说以后的事。" }
    ]
});
