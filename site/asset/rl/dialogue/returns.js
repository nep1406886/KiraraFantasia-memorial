// Original rest scenes about a confirmed previous trip. Conditions and stable
// archive identities live in game/rl/story.js; these bodies perform no effects.
window.kirafanDialogue = Object.assign(window.kirafanDialogue || {}, {
    return_v1_defeat: [
        { who: "きらら", face: "sorrow", text: "上次从褪色之海回来，灯还亮着，大家却已经走不动了。想起那阵潮声，还是有些不甘心。" },
        { who: "うつつ", face: "default", text: "先把湿掉的衣角烤干。海不会因为我们歇了一晚就消失，下次也不必用勉强自己来证明什么。" }
    ],
    return_v1_victory: [
        { who: "きらら", face: "happy", text: "褪色之海的那一段已经走完了。现在想起浪声，先想到的竟然不是害怕，而是大家一起回头看的时候。" },
        { who: "うつつ", face: "default", text: "记住那一刻就好。下一段路未必也有相同的潮汐，能照着走的，是一起确认方向的习惯。" }
    ],
    return_v2_defeat: [
        { who: "きらら", face: "sorrow", text: "上次那趟沙漠之行没能走到底。回来以后，脑子里还是一片晃眼的沙色。" },
        { who: "うつつ", face: "default", text: "在这里把呼吸缓下来。没能走完，不等于之前认真辨过的方向都作废了。" }
    ],
    return_v2_victory: [
        { who: "きらら", face: "happy", text: "上次走过沉眠之沙，最难忘的不是终点，是途中那些等人落座的空桌子。" },
        { who: "うつつ", face: "default", text: "先给后来的人留一把椅子吧。人不一定能同时到齐。愿意回来，就还有下一次相聚。" }
    ],
    return_v3_defeat: [
        { who: "きらら", face: "sorrow", text: "上次进森林的时候，还在猜那股甜味从哪里来。后来走得太累，连这件事都忘了。" },
        { who: "うつつ", face: "default", text: "树影可以下次再认，疲惫不能假装没看见。先把这一顿饭好好吃完。" }
    ],
    return_v3_victory: [
        { who: "きらら", face: "happy", text: "上次离开贪食之森时，身后的回声终于不再空荡荡的。现在篝火一响，还会想起那阵树叶声。" },
        { who: "うつつ", face: "default", text: "还能记住那些声音，说明这一路不只有战斗。先把它们记下来，再听听眼前的人想说什么。" }
    ],
    return_v4_defeat: [
        { who: "きらら", face: "sorrow", text: "上次在机械之心停下的时候，总觉得自己像少装了一枚齿轮，怎么都跟不上。" },
        { who: "うつつ", face: "default", text: "人不是少了零件的机器。累了就停一停，不必把每一次出发都变成修理自己的功课。" }
    ],
    return_v4_victory: [
        { who: "きらら", face: "default", text: "机械之心的那段路走完后，反而常常想起工房里那些没写名字的小东西。它们也有人认真做过吧。" },
        { who: "うつつ", face: "default", text: "就算不知道名字，也能记得有人为它们花过心思。下次用到时，再想一想那个人吧。" }
    ],
    return_v5_defeat: [
        { who: "きらら", face: "sorrow", text: "上次没能走完真实之影。明明还有想带回来的故事，却只能先合上书，心里总像空着一块。" },
        { who: "うつつ", face: "default", text: "暂时合上，不是替它们写下结尾。把灯照得到的这一小段走稳，其他的等有力气时再说。" }
    ],
    return_v5_victory: [
        { who: "きらら", face: "happy", text: "走过终之书架以后，看到空白的纸也没那么不安了。原来故事告一段落，身边的人还会有新的话想说。" },
        { who: "うつつ", face: "default", text: "所以不用急着把空白填满。给下一次相遇留点位置，也给愿意继续写的人留一盏灯。" }
    ]
});
