// Dialogue scripts: boss pre/post per volume (spec/05 §7 deliverable
// "Boss 戦前後 10 节点 ×≤6 句"). Bosses come from QuestEnemyList with voice
// priority (spec/05 §3): テンペスト / カレーの化身 / 合体マタンゴ /
// メカこけし / ハイプリス. All lines original (harness-checked).
window.kirafanDialogue = Object.assign(window.kirafanDialogue || {}, {
    v1_boss_pre: [
        { who: "きらら", face: "surprise", text: "海风把散页都卷到这里了……那道身影挡住了回港的路。" },
        { who: "うつつ", face: "default", text: "先看脚下的预兆。横移躲开正面，等它停下来，再靠近。" }
    ],
    v1_boss_post: [
        { who: "きらら", face: "joy", text: "路通了！听，码头的铃声又能传到这里了。" },
        { who: "うつつ", face: "default", text: "书页还带着潮气。夹好再走，别让今天的字迹被海风吹散。" }
    ],

    v2_boss_pre: [
        { who: "きらら", face: "shy", text: "沙丘后面终于有影子了……不过，对方好像不打算让我们在这里歇脚。" },
        { who: "うつつ", face: "default", text: "把水壶收好。落点一旦亮起就离开，别为了多打一下留在原地。" }
    ],
    v2_boss_post: [
        { who: "きらら", face: "happy", text: "沙子安静下来了。现在，终于可以找个背风的地方喝口水了。" },
        { who: "うつつ", face: "default", text: "把菜单的事留到回去吧。先确认大家都没有受伤。" }
    ],

    v3_boss_pre: [
        { who: "きらら", face: "sorrow", text: "脚印在这里停住了。散页就在前面，可林子里的来客也在等我们。" },
        { who: "うつつ", face: "default", text: "别被外表骗过去。看清圈内和圈外，留一条能退回来的路。" }
    ],
    v3_boss_post: [
        { who: "きらら", face: "happy", text: "鸟叫声回来了……原来刚才不是森林太安静，是声音都被它盖住了。" },
        { who: "うつつ", face: "default", text: "让森林自己慢慢热闹起来吧。我们收好书页，不再打扰它。" }
    ],

    v4_boss_pre: [
        { who: "きらら", face: "surprise", text: "工房的钟又响了。那边也跟着动起来了……这里还藏着最后一道试炼。" },
        { who: "うつつ", face: "default", text: "留意地面的线，别沿着它逃。走进空隙，等攻击过去再出手。" }
    ],
    v4_boss_post: [
        { who: "きらら", face: "joy", text: "这次停下来的，只有战斗。听，工房的钟还在一下一下地走。" },
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
