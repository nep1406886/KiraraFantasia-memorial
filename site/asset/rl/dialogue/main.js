// Dialogue scripts: prologue + per-volume open/close (spec/05 §5 format,
// T12 deliverable "序章+5 卷卷头/卷尾"). Body text is Chinese-only
// (T22a: 全量中文为正文；日本語原稿在 git 历史). All lines are ORIGINAL — the 6-char
// collision harness (rl_dialogue_harness) checks them against every original
// game text on disk.
//
// 固定席 (spec/05 §2): きらら (protagonist), うつつ (tsukkomi/navigator),
// メディア (librarian, inter-volume host). `who` keys resolve through the
// cards.js name table (exact match first, then the 【variant】 prefix rule).
window.kirafanDialogue = Object.assign(window.kirafanDialogue || {}, {
    prologue: [
        { who: "メディア", face: "sorrow", text: "图书馆里有些书页正在变白。上面记着的相遇和约定，正一点点读不出来。" },
        { who: "きらら", face: "surprise", text: "末页上说，百个故事讲完，灯下就会出现新的篇章。可眼前这些字还没读完，就要消失了……" },
        { who: "うつつ", face: "default", text: "先别急着翻到结尾。把正在褪色的页子找回来，才知道这里还少了什么。" },
        { who: "きらら", face: "happy", text: "那就带上召唤灯，一页一页找。不能让还没说完的话，就这样消失。" }
    ],

    v1_open: [
        { who: "きらら", face: "surprise", text: "听，是潮声！可港口和海面都淡得像没涂完的画。这里发生过的故事，也快看不清了。" },
        { who: "うつつ", face: "default", text: "先沿着还能辨认的字迹走。把这一带的残页收好，再往深处找。" }
    ],
    v1_close: [
        { who: "きらら", face: "happy", text: "大海的颜色回来了！原来那些被浪声盖住的，是大家约好再见的声音。" },
        { who: "うつつ", face: "default", text: "约定还在，故事就能接着讲。……回去先把书页晾干，别又糊成一团。" }
    ],

    v2_open: [
        { who: "きらら", face: "default", text: "沙地好烫！远处好像有个市集，空气里还有炊烟和香料的味道。" },
        { who: "うつつ", face: "default", text: "这一卷记着旅人的饭桌和归途。先找能落脚的地方，再看看哪一段故事缺了页。" }
    ],
    v2_close: [
        { who: "きらら", face: "joy", text: "沙子底下的字又清楚了！好多一起吃饭的故事……说着说着，肚子真的饿了。" },
        { who: "うつつ", face: "default", text: "先回去吃饭。今天找回的故事，坐到桌边慢慢讲。" }
    ],

    v3_open: [
        { who: "きらら", face: "shy", text: "树好高，声音好像都被叶子吸走了。那个……我们刚才是从哪边进来的？" },
        { who: "うつつ", face: "default", text: "先跟着灯走。地上的脚印还在，慢一点就能认出方向。" }
    ],
    v3_close: [
        { who: "きらら", face: "happy", text: "森林里又听得见鸟叫了。藏在深处的声音，终于没有被空白吞掉。" },
        { who: "うつつ", face: "default", text: "这次安静得正好。还有风声，也听得见有人在旁边走。" }
    ],

    v4_open: [
        { who: "きらら", face: "surprise", text: "这里像座旧工房，到处都是齿轮和人偶。啊，那个刚才是不是转过头来了？" },
        { who: "うつつ", face: "default", text: "机器还在动，造它们的人却没留在记录里。我们要找的是那些被抹去的名字。" }
    ],
    v4_close: [
        { who: "きらら", face: "joy", text: "灯一盏接一盏亮起来了！这间工房，好像终于等到有人回来。" },
        { who: "うつつ", face: "default", text: "把工具和书页都放回原处吧。后来的人，会知道这里曾经有人认真做过东西。" }
    ],

    v5_open: [
        { who: "きらら", face: "sorrow", text: "越往里走，空白就越多。好像有人把故事停在了下一句话之前。" },
        { who: "うつつ", face: "default", text: "守着最后一页的人，就在前面。她为什么不肯往下写，要听她亲口说。" }
    ],
    v5_close: [
        { who: "きらら", face: "happy", text: "新的一页上，终于有字了！不是早就定好的结局，是我们还能一起写下去的故事。" },
        { who: "うつつ", face: "shy", text: "今天这一段先到这里。以后发生了什么，再回来把目录补上。" }
    ]
});
