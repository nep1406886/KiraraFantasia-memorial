// 第 5 卷终章脚本 (spec/05 §7): independent node flow. finale_pre is the
// long ハイプリス pre-battle dialogue — main.js plays it INSTEAD of
// v5_boss_pre for the final volume. boss.js v5_boss_post still handles the
// post-battle beat, v5_close the volume close; finale_end runs after that
// as the true ending. All lines original (harness-checked).
window.kirafanDialogue = Object.assign(window.kirafanDialogue || {}, {
    finale_intro: [
        { who: "きらら", face: "sorrow", text: "空白的中央只剩下一座书架。那本没有写完的书，还放在最上面。" },
        { who: "うつつ", face: "default", text: "一路找回的书页都在这里。可最后这一页，执笔的人还不肯往下写。" },
        { who: "きらら", face: "default", text: "我们去问问她吧。走了这么久，总该听听她为什么要守着这里。" }
    ],
    finale_pre: [
        { who: "ハイプリス", face: "default", text: "你们还是走到了这里。一路带回的书页，我都看见了。" },
        { who: "ハイプリス", face: "sorrow", text: "我见过许多故事结束。最怕的不是最后一个字，而是那以后，再也没有人把书翻开。" },
        { who: "きらら", face: "shy", text: "我也会舍不得合上喜欢的书。可读完以后，我还想和别人聊起它，还会从第一页再读一遍。" },
        { who: "ハイプリス", face: "surprise", text: "读到结尾之后……还会回来吗？" },
        { who: "うつつ", face: "default", text: "会。结尾不会抹掉前面发生过的事。我们来这里，就是不想让那些相遇被忘记。" },
        { who: "ハイプリス", face: "angry", text: "我还不能只凭几句话就相信。要带走这一页，就让我亲眼看看，你们能不能护住它。" }
    ],
    finale_end: [
        { who: "メディア", face: "happy", text: "新的篇章已经收进图书馆。书名还没想好，不过愿意来续写的人，已经在门外排队了。" },
        { who: "きらら", face: "joy", text: "那我先记今天的事！从出发时带了什么，一直写到大家平安回来。" },
        { who: "うつつ", face: "shy", text: "我来整理目录。茶点的事也能写，但别把每一章都写成菜单。" },
        { who: "メディア", face: "default", text: "想起新的故事时，就回来坐坐吧。书架上会为下一页留着位置。" }
    ]
});
