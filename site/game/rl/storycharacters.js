// Current actors, dialogue keys and collected WORK pages are distinct IDs.
// Explicit aliases retain old story bodies without giving another character
// their voice (notably current Kisaragi vs the historic Tomokane work page).
const rows = [
    [32002001, "kirara", "きらら", "琪拉拉", 32002000, ["灯边的空白", "记得回来的路"]],
    [32172001, "utsutsu", "うつつ", "住良木现", 32002000, ["暂缺的一行", "不必独自记住"]],
    [10002001, "yuno", "ゆの", "由乃", 10000000, ["还没画完的窗", "留给明天的颜色"]],
    [11012001, "yui_ichii", "櫟井 唯", "栎井唯", 11010000, ["没有答案的检索", "结论之外的闲话"]],
    [18002001, "yasuna", "折部 やすな", "折部安奈", 18000000, ["还没结束的游戏", "下次再来一次"]],
    [14002001, "karen", "九条 カレン", "九条可怜", 14010000, ["没寄出的消息", "写满的信纸"]],
    [30002001, "cocoa", "ココア", "保登心爱", 30001000, ["等开门的店", "给大家留一张桌"]],
    [23002001, "rin", "志摩 リン", "志摩凛", 23001000, ["独行的路标", "多留一个杯子"]],
    [15002001, "aoba", "涼風 青葉", "凉风青叶", 15000000, ["还没完成的草稿", "想交给大家的成品"]],
    [35002001, "yuko", "吉田 優子", "吉田优子", 35001000, ["写在便签上的决心", "堂堂正正的休息"]],
    [22002001, "yui_hirasawa", "平沢 唯", "平泽唯", 22000000, ["听不见的那一拍", "有人跟着打拍子"]],
    [38002001, "mira", "木ノ幡 みら", "木之幡米拉", 38001000, ["空着的观测栏", "一起抬头的夜晚"]],
    [24002001, "kaoruko", "萌田 薫子", "萌田薰子", 24001000, ["画不到下一格", "想画下的表情"]],
    [20002001, "maika", "桜ノ宮 苺香", "樱之宫莓香", 20000000, ["临时营业的休息点", "欢迎再次光临"]],
    [29002001, "haruka", "大空 遥", "大空遥", 29001000, ["没有搭档的传球", "把球传向有人的地方"]],
    [47002001, "hiyori", "海凪 ひより", "海凪日和", 47002000, ["还没抛出的线", "留在岸边的笑声"]],
    [28002001, "hanako", "花小泉 杏", "花小泉杏", 28001000, ["一路捡起的小幸运", "今天也有好事"]],
    [31002001, "kohane", "鳩谷 こはね", "鸠谷小羽", 31001000, ["给谁的加油声", "有人回应的节拍"]],
    [21002001, "hana", "一之瀬 花名", "一之濑花名", 21000000, ["不用追赶的步子", "座位还在"]],
    [19002001, "takayama", "高山 春香", "高山春香", 19000000, ["一份备用的点心", "回去以后再分一半"]],
    [37002001, "ryo", "町子 リョウ", "町子凉", 37002000, ["多备的一双筷子", "热汤与同桌的人"]],
    [34002001, "kuro", "クロ", "小黑", 34001000, ["地图上的空处", "记下相遇的地方"]],
    [39002001, "yomi", "武田 詠深", "武田咏深", 39001000, ["等一个接球的人", "投向熟悉的手套"]],
    [25002001, "kisaragi", "山口 如月", "山口如月", 25021000, ["褪色的调色盘", "画里也有同伴"]],
    [26002001, "merry", "メリー・ナイトメア", "玛莉·梦魔", 26000000, ["回去的方向", "梦醒以后再出发"]],
    [36002001, "harumi", "はるみ", "细野晴海", 36001000, ["地球人的放学路", "不用解释的日常"]],
    [14012001, "alice", "アリス・カータレット", "爱丽丝", 14010000, ["写到一半的信", "想亲口说的话"]],
    [12002001, "yuki", "丈槍 由紀", "丈枪由纪", 12000000, ["还没看清的课表", "今天的放学约定"]],
    [27002001, "naru", "関谷 なる", "关谷鸣", 27001000, ["落单的鸣子", "重合的脚步"]],
    [41002001, "tsumiki", "つみき", "御庭摘希", 41001000, ["还没递出的点心", "只留一份的小秘密"]],
    [43002001, "koharu", "こはる", "小野坂小春", 43001000, ["慢一点的午后", "不着急的约定"]],
    [42002001, "mayu", "まゆ", "篠华茉优", 42001000, ["放学后的绕路", "并肩回去"]],
    [33012001, "futaba", "小田切 双葉", "小田切双叶", 33011000, ["先留一份菜单", "三个人的餐桌"]],
    [17002001, "chiya", "千矢", "千矢", 17000000, ["被风吹散的线索", "熟悉的归路"]],
    [16002001, "tamaki", "本田 珠輝", "本田珠辉", 16000000, ["还空着的角色稿", "一起做完的游戏"]],
    [45002001, "kotone", "風色 琴音", "风色琴音", 45002000, ["写到一半的介绍", "有人想住下的地方"]],
    [40002001, "ino", "桜 衣乃", "樱衣乃", 40002000, ["等开场的舞台", "笑声里的返场"]],
    [13002001, "tooru", "トオル", "一井透", 13000000, ["少了同伴的放学路", "跟上就好"]],
    [46002001, "hitori", "後藤 ひとり", "后藤一里", 46002000, ["还没弹完的小节", "想给人听的声音"]],
    [23012001, "nadeshiko", "各務原 なでしこ", "各务原抚子", 23001000, ["等天晴的行程", "下回还一起去"]],
    [32022001, "claire", "クレア", "克蕾尔", 32002000, ["门前留下的位置", "欢迎回来的一页"]]
];

export const STORY_COMPANIONS = Object.freeze(rows.map(([cardId, key, who, name, pageId, titles]) => Object.freeze({
    cardId, key, who, name, pageId, titles: Object.freeze(titles.slice())
})));
const byCard = new Map(STORY_COMPANIONS.map(row => [row.cardId, row]));
const byName = new Map(STORY_COMPANIONS.map(row => [row.who, row]));

// These speakers have no shipped legacy bust. Reuse verified local artwork,
// not another actor's shared work page. Claire's kana name also belongs to a
// Harukana character, so the generic variant-prefix resolver cannot own it.
const portraitOverrides = Object.freeze({
    // Module-relative hrefs: plain page-relative "../.." escapes a
    // /kirafan-timer/ deployment subpath.
    kisaragi: new URL("../../asset/img/rl/card/25002001.webp", import.meta.url).href,
    claire: new URL("../../asset/img/rl/orig/illust_4.webp", import.meta.url).href
});
export function dialoguePresentationForName(who) {
    const row = byName.get(who);
    const bust = row && portraitOverrides[row.key];
    return bust ? { id: row.cardId, name: row.who, nameZh: row.name, bust } : null;
}

export function dialogueNameForCard(card) {
    if (!card) return null;
    const current = byCard.get(card.id) || byCard.get(card.evolvedId);
    if (current) return current.who;
    // Historic cards keep their own character. Never use legacyId to turn
    // an old Tomokane run into a Kisaragi scene.
    return typeof card.name === "string" && card.name ? card.name.replace(/【.*$/, "") : null;
}
