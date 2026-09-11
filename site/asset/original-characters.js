// Names are sourced from each character's Name/Japanese field on Kirara Fantasia Wiki.
var kirafanOriginalCharacters = [
    { japanese: "きらら", romaji: "Kirara", chinese: "琪拉拉", group: "主线角色", cv: "楠木ともり / Kusunoki Tomori", artist: "蒼樹うめ / Aoki Ume", series: "きららファンタジア", wiki: "Kirara", image: "Kirara_StandPic_0.png" },
    { japanese: "ランプ", romaji: "Lamp", chinese: "兰普", group: "主线角色", cv: "高野麻里佳 / Kouno Marika", artist: "黒田bb / Kuroda BB", series: "きららファンタジア", wiki: "Lamp", image: "Lamp_StandPic_0.png" },
    { japanese: "マッチ", romaji: "Match", group: "主线角色", cv: "三森すずこ / Mimori Suzuko", artist: "黒田bb / Kuroda BB", series: "きららファンタジア", wiki: "Match", image: "Match_StandPic_0.png" },
    { japanese: "住良木 うつつ", romaji: "Sumeragi Utsutsu", chinese: "住良木乌图图", group: "主线角色", cv: "前田佳織里 / Maeda Kaori", artist: "千葉サドル / Chiba Sadoru", series: "きららファンタジア", wiki: "Sumeragi_Utsutsu", image: "Ututu_StandPic_0.png" },
    { japanese: "メディア", romaji: "Media", group: "主线角色", cv: "逢来りん / Aira Rin", artist: "原悠衣 / Hara Yui", series: "きららファンタジア", wiki: "Media", image: "Media_StandPic_0.png" },
    { japanese: "クレア", romaji: "Clea", chinese: "克蕾雅", group: "城镇角色", cv: "和氣あず未 / Waki Azumi", artist: "原悠衣 / Hara Yui", series: "きららファンタジア", wiki: "Clea", image: "Claire_StandPic_0.png" },
    { japanese: "コルク", romaji: "Cork", group: "城镇角色", cv: "桑原由気 / Kuwahara Yuki", artist: "ウロ / Uro", series: "きららファンタジア", wiki: "Cork", image: "Cork_StandPic_0.png" },
    { japanese: "ポルカ", romaji: "Polka", group: "城镇角色", cv: "松井恵理子 / Matsui Eriko", artist: "牛木義隆 / Ushiki Yoshitaka", series: "きららファンタジア", wiki: "Polka", image: "Poruka_StandPic_0.png" },
    { japanese: "カンナ", romaji: "Kanna", group: "城镇角色", cv: "日笠陽子 / Hikasa Yoko", artist: "得能正太郎 / Tokunou Shoutarou", series: "きららファンタジア", wiki: "Kanna", image: "Kanna_StandPic_0.png" },
    { japanese: "ライネ", romaji: "Leine", group: "城镇角色", cv: "茅野愛衣 / Kayano Ai", artist: "川井マコト / Makoto Kawai", series: "きららファンタジア", wiki: "Leine", image: "Raine_StandPic_0.png" },
    { japanese: "ソラ", romaji: "Sola", group: "神殿成员", cv: "ゆかな / Yukana", artist: "得能正太郎 / Tokunou Shoutarou", series: "きららファンタジア", wiki: "Sola", image: "Sora_StandPic_0.png" },
    { japanese: "アルシーヴ", romaji: "Archive", group: "神殿成员", cv: "沢城みゆき / Sawashiro Miyuki", artist: "きゆづきさとこ / Kiyuduki Satoko", series: "きららファンタジア", wiki: "Archive", image: "Archives_StandPic_0.png" },
    { japanese: "シュガー", romaji: "Sugar", group: "七贤者", cv: "井口裕香 / Iguchi Yuka", artist: "はんざわかおり / Hanzawa Kaori", series: "きららファンタジア", wiki: "Sugar", image: "Sugar_StandPic_0.png" },
    { japanese: "セサミ", romaji: "Sesame", group: "七贤者", cv: "赤﨑千夏 / Akasaki Chinatsu", artist: "ねこうめ / Nekoume", series: "きららファンタジア", wiki: "Sesame", image: "Sesame_StandPic_0.png" },
    { japanese: "カルダモン", romaji: "Cardamom", group: "七贤者", cv: "田村睦心 / Tamura Mutsumi", artist: "あfろ / Afro", series: "きららファンタジア", wiki: "Cardamom", image: "Cardamon_StandPic_0.png" },
    { japanese: "ソルト", romaji: "Salt", group: "七贤者", cv: "田中真奈美 / Manami Tanaka", artist: "はんざわかおり / Hanzawa Kaori", series: "きららファンタジア", wiki: "Salt", image: "Salt_StandPic_0.png" },
    { japanese: "ジンジャー", romaji: "Ginger", group: "七贤者", cv: "渕上舞 / Fuchigami Mai", artist: "カヅホ / Kaduho", series: "きららファンタジア", wiki: "Ginger", image: "Ginger_StandPic_0.png" },
    { japanese: "フェンネル", romaji: "Fennel", group: "七贤者", cv: "五十嵐裕美 / Igarashi Hiromi", artist: "中山幸 / Nakayama Miyuki", series: "きららファンタジア", wiki: "Fennel", image: "Fennel_StandPic_0.png" },
    { japanese: "ハッカ", romaji: "Hakka", group: "七贤者", cv: "茅原実里 / Chihara Minori", artist: "篤見唯子 / Tokumi Yuiko", series: "きららファンタジア", wiki: "Hakka", image: "Hakka_StandPic_0.png" },
    { japanese: "ハイプリス", romaji: "Highpris", group: "真実の手·首领", cv: "能登麻美子 / Noto Mamiko", artist: "黒田bb / Kuroda BB", series: "きららファンタジア", wiki: "Highpris", image: "Highpris_StandPic_0.png" },
    { japanese: "サンストーン", romaji: "Sunstone", group: "真実の手·右手", cv: "大橋彩香 / Ohashi Ayaka", artist: "はりかも / Harikamo", series: "きららファンタジア", wiki: "Sunstone", image: "Sunstone_StandPic_0.png" },
    { japanese: "ヒナゲシ", romaji: "Hinageshi", group: "真実の手·弓手", cv: "河野ひより / Kouno Hiyori", artist: "Quro", series: "きららファンタジア", wiki: "Hinageshi", image: "Hinageshi_StandPic_0.png" },
    { japanese: "リコリス", romaji: "Lycoris", group: "真実の手·左手", cv: "幸村恵理 / Yukimura Eri", artist: "ルッチーフ / ruch_f", series: "きららファンタジア", wiki: "Lycoris", image: "Lycoris_StandPic_0.png" },
    { japanese: "スズラン", romaji: "Suzuran", group: "真実の手·魔手", cv: "加藤英美里 / Katou Emiri", artist: "鴻巣覚 / Kounosu Satori", series: "きららファンタジア", wiki: "Suzuran", image: "Suzuran_StandPic_0.png" },
    { japanese: "ロベリア", romaji: "Lobelia", group: "真実の手·妙手", cv: "野中深愛 / Nonaka Mio", artist: "琴慈 / Cotoji", series: "きららファンタジア", wiki: "Lobelia", image: "Lobelia_StandPic_0.png" },
    { japanese: "スイセン", romaji: "Suisen", group: "真実の手·射手", cv: "小泉萌香 / Koizumi Moeka", artist: "荒井チェリー / Arai Cherry", series: "きららファンタジア", wiki: "Suisen", image: "Suisen_StandPic_0.png" },
    { japanese: "エニシダ", romaji: "Enishida", group: "真実の手·歌手", cv: "山田麻莉奈 / Yamada Marina", artist: "はまじあき / Hamaji Aki", series: "きららファンタジア", wiki: "Enishida", image: "Enishida_StandPic_0.png" },
    { japanese: "ダチュラ", romaji: "Datura", group: "真実の手·毒手", cv: "鈴代紗弓 / Suzushiro Sayumi", artist: "うちのまいこ / Uchino Maiko", series: "きららファンタジア", wiki: "Datura", image: "Datura_StandPic_0.png" },
    { japanese: "海岸沿いの町に住む少女", romaji: "Kaigan-zoi no Machi ni Sumu Shoujo", chinese: "住在海岸小镇的少女", group: "其他角色", cv: "未公开", artist: "昆布わかめ / Konbu Wakame", series: "きららファンタジア", wiki: "Young_Girl_1", image: "Girl_StandPic_0.png" },
    { japanese: "渓谷の町に住む少女", romaji: "Keikoku no Machi ni Sumu Shoujo", chinese: "住在峡谷小镇的少女", group: "其他角色", cv: "未公开", artist: "相崎うたう / Aizaki Utau", series: "きららファンタジア", wiki: "Young_Girl_2", image: "Girl_2_StandPic_0.png" },
    { japanese: "クロモン", romaji: "Kuromon", group: "魔物", cv: "未公开", artist: "きゆづきさとこ / Kiyuduki Satoko", series: "きららファンタジア", wiki: "Kuromon", image: "Kuromon_Face_0_Default.png" },
    { japanese: "ウツカイ", romaji: "Utsukai", group: "魔物", cv: "未公开", artist: "きゆづきさとこ / Kiyuduki Satoko", series: "きららファンタジア", wiki: "Utsukai", image: "Utukai_Face_0_Default.png" },
    { japanese: "リシュカ", romaji: "Risyuka", group: "活动角色", cv: "森永千才 / Morinaga Chitose", artist: "牛木義隆 / Ushiki Yoshitaka", series: "きららファンタジア", wiki: "Risyuka", image: "risyuka_StandPic_0.png" },
    { japanese: "アモル", romaji: "Amor", group: "活动角色", cv: "未公开", artist: "とめきち / Tomekichi", series: "きららファンタジア", wiki: "Amor", image: "Amoru_StandPic_0.png" },
    { japanese: "オルバ", romaji: "Orba", group: "活动角色", cv: "未公开", artist: "とめきち / Tomekichi", series: "きららファンタジア", wiki: "Orba", image: "Orba_StandPic_0.png" },
    { japanese: "アイビス", romaji: "Ibis", group: "活动角色", cv: "未公开", artist: "キキ / Kiki", series: "きららファンタジア", wiki: "Ibis", image: "Ibis_StandPic_0.png" },
    { japanese: "ファル", romaji: "Fal", group: "活动角色", cv: "未公开", artist: "榊 / Sakaki", series: "きららファンタジア", wiki: "Fal", image: "Fal_StandPic_0.png" },
    { japanese: "エア", romaji: "Ea", group: "活动角色", cv: "未公开", artist: "榊 / Sakaki", series: "きららファンタジア", wiki: "Ea", image: "Ea_StandPic_0.png" },
    { japanese: "ロール", romaji: "Rol", group: "活动角色", cv: "未公开", artist: "榊 / Sakaki", series: "きららファンタジア", wiki: "Rol", image: "Rol_StandPic_0.png" },
    { japanese: "ウミ", romaji: "Umi", group: "活动角色", cv: "未公开", artist: "伊藤いづも / Itou Izumo", series: "きららファンタジア", wiki: "Umi", image: "Umi_StandPic_0.png" },
    { japanese: "オトヒメ", romaji: "Otohime", group: "活动角色", cv: "未公开", artist: "伊藤いづも / Itou Izumo", series: "きららファンタジア", wiki: "Otohime", image: "Otohime_StandPic_0.png" },
    { japanese: "タマミ", romaji: "Tamami", group: "活动角色", cv: "未公开", artist: "ルッチーフ / ruch_f", series: "きららファンタジア", wiki: "Tamami", image: "Tamami_StandPic_0.png" },
    { japanese: "メイド長", romaji: "Head Maid", group: "活动角色", cv: "白石晴香 / Shiraishi Haruka", artist: "むっしゅ / Musshu", series: "きららファンタジア", wiki: "Head_Maid", image: "MaidChief_StandPic_0.png" },
    { japanese: "ローズ", romaji: "Rose", group: "活动角色", cv: "未公开", artist: "桜木蓮 / Sakuragi Ren", series: "きららファンタジア", wiki: "Rose", image: "Rose_StandPic_0.png" },
    { japanese: "シロヤギ", romaji: "Shiroyagi", group: "活动角色", cv: "未公开", artist: "原悠衣 / Hara Yui", series: "きららファンタジア", wiki: "Shiroyagi", image: "Shiroyagi_StandPic_0.png" },
    { japanese: "クロヤギ", romaji: "Kuroyagi", group: "活动角色", cv: "未公开", artist: "原悠衣 / Hara Yui", series: "きららファンタジア", wiki: "Kuroyagi", image: "Kuroyagi_StandPic_0.png" }
    ,{ japanese: "左大臣", romaji: "Sadaijin", group: "活动角色", cv: "未公开", artist: "大沖 / Daioki", series: "きららファンタジア", wiki: "Sadaizin", image: "Sadaizin_Face_0_Default.png" }
    ,{ japanese: "右大臣", romaji: "Udaijin", group: "活动角色", cv: "未公开", artist: "大沖 / Daioki", series: "きららファンタジア", wiki: "Udaizin", image: "Udaizin_Face_0_Default.png" }
    ,{ japanese: "暗黒冬将軍", romaji: "Ankoku Fuyu Shougun", group: "活动角色", cv: "未公开", artist: "永山ゆうのん / Nagayama Yuunon", series: "きららファンタジア", wiki: "Dark_Winter_General", image: "Ankoku_Fuyu_Shyougun_StandPic_0.png" }
    ,{ japanese: "ロッテ", romaji: "Rotte", group: "活动角色", cv: "未公开", artist: "火曜 / Kayou", series: "きららファンタジア", wiki: "Lotte", image: "Rotte_StandPic_0.png" }
    ,{ japanese: "発明家", romaji: "Hatsumeika", group: "活动角色", cv: "未公开", artist: "あfろ / Afro", series: "きららファンタジア", wiki: "Inventor", image: "Hatsumeika_Jijii_StandPic_0.png" }
    ,{ japanese: "ヒナ首領", romaji: "Hina Shuryou", group: "活动角色", cv: "未公开", artist: "大沖 / Daioki", series: "きららファンタジア", wiki: "Hina_Chief", image: "GamingHina_StandPic_0.png" }
    ,{ japanese: "ナビっち", romaji: "Nabicchi", group: "活动角色", cv: "未公开", artist: "わらびもちきなこ / Warabimochi Kinako", series: "きららファンタジア", wiki: "Navi", image: "Navi_StandPic_0.png" }
].map(function (character) {
    character.image = "imgs/original-characters/" + character.image;
    character.wikiUrl = "https://kirarafantasia.miraheze.org/wiki/" + character.wiki;
    return character;
});
