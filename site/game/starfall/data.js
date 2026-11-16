// 星降旅记 · 静态数据
// 所有素材均指向仓库内已落盘的离线资源，不热链 CDN、不新增二进制文件。
export const W = 960;
export const H = 540;
export const FLOOR = 442;
export const ROOM_W = 1760;
export const STEP = 1 / 60;

export const A_IMG = '../asset/img/rl/';
export const A_BGM = '../audio/bgm/';
export const A_ATTR = '../imgs/';

export const PAL = {
  paper: '#fffaf0', paper2: '#f6ead6', ink: '#4a372c', inkSoft: '#8a7466',
  berry: '#e7668f', berryDark: '#c04c76', gold: '#f2b53c', goldSoft: '#ffe6a8',
  mint: '#79c9a6', sky: '#78c7e8', violet: '#a98ad8', red: '#ef6a6a',
  cut: '#fffaf0',           // 剪纸裁切白边
};
export const FONT = '"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif';
export const FONT_TITLE = '"Noto Serif SC","Songti SC","SimSun",serif';

const standee = (n) => A_IMG + 'orig/illust_' + n + '.webp';
const face = (n) => A_IMG + 'orig/icon_' + n + '.webp';
const cardArt = (id) => A_IMG + 'card/' + id + '.webp';
export const bossStand = (n) => standee(n);
export const bossFace = (n) => face(n);

export const SCENE = {
  title: A_IMG + 'ui/title.webp', select: A_IMG + 'ui/select.webp',
  hub: A_IMG + 'ui/scene_town.webp', shop: A_IMG + 'ui/shop.webp',
  result: A_IMG + 'ui/result.webp', dark: A_IMG + 'ui/dark.webp',
};
export const ICON = {
  coin: A_IMG + 'drop/coin.webp', star: A_IMG + 'drop/star.webp',
  skill: A_IMG + 'drop/skill-special.webp', heal: A_IMG + 'drop/skill-recovery.webp',
  atk: A_IMG + 'drop/skill-attack.webp', buff: A_IMG + 'drop/skill-buff.webp',
  debuff: A_IMG + 'drop/skill-debuff.webp',
  gem: A_IMG + 'item/1.webp', lamp: A_IMG + 'drop/star.webp',
  barrel: A_IMG + 'item/4000.webp', spring: A_IMG + 'drop/skill-recovery.webp',
  crystal: A_IMG + 'item/1000.webp',
};

// ---------------------------------------------------------------------------
// 六属性：图标直接取原作的 Attribute_*.png
// ---------------------------------------------------------------------------
export const ELEMENTS = [
  { id: 'fire',  name: '火', en: 'Fire',  color: '#ef6a4a', soft: '#ffd0b0', icon: A_ATTR + 'Attribute_Fire.png' },
  { id: 'water', name: '水', en: 'Water', color: '#4aa8e8', soft: '#bfe6ff', icon: A_ATTR + 'Attribute_Water.png' },
  { id: 'wind',  name: '风', en: 'Wind',  color: '#63c9a0', soft: '#c7f2dd', icon: A_ATTR + 'Attribute_Wind.png' },
  { id: 'moon',  name: '月', en: 'Moon',  color: '#a98ad8', soft: '#e0d0ff', icon: A_ATTR + 'Attribute_Moon.png' },
  { id: 'sun',   name: '日', en: 'Sun',   color: '#f2b53c', soft: '#ffe6a8', icon: A_ATTR + 'Attribute_Sun.png' },
  { id: 'earth', name: '土', en: 'Earth', color: '#c08a54', soft: '#e8cfa8', icon: A_ATTR + 'Attribute_Earth.png' },
];
export const EL = Object.fromEntries(ELEMENTS.map(e => [e.id, e]));
export const elOf = (id) => EL[id] || EL.fire;

// 反应表：命中「已浸染不同属性」的敌人时触发。效果在 game.js 中实现。
export const REACTIONS = {
  'fire|wind':   { id: 'blaze',   name: '燎原', en: 'Wildfire',  color: '#ff8a3c', desc: '爆燃并向周围传播火种' },
  'wind|fire':   { id: 'blaze',   name: '燎原', en: 'Wildfire',  color: '#ff8a3c', desc: '爆燃并向周围传播火种' },
  'fire|water':  { id: 'steam',   name: '蒸腾', en: 'Vapour',    color: '#bfe6ff', desc: '蒸汽冲击，击退并造成范围伤害' },
  'water|fire':  { id: 'steam',   name: '蒸腾', en: 'Vapour',    color: '#bfe6ff', desc: '蒸汽冲击，击退并造成范围伤害' },
  'fire|sun':    { id: 'scorch',  name: '灼耀', en: 'Scorch',    color: '#ffd166', desc: '附加持续灼烧' },
  'sun|fire':    { id: 'scorch',  name: '灼耀', en: 'Scorch',    color: '#ffd166', desc: '附加持续灼烧' },
  'water|moon':  { id: 'frost',   name: '凝霜', en: 'Frost',     color: '#9fd8ff', desc: '冻结敌人' },
  'moon|water':  { id: 'frost',   name: '凝霜', en: 'Frost',     color: '#9fd8ff', desc: '冻结敌人' },
  'water|wind':  { id: 'mist',    name: '雾隐', en: 'Mist',      color: '#b6e3d2', desc: '生成减速雾区' },
  'wind|water':  { id: 'mist',    name: '雾隐', en: 'Mist',      color: '#b6e3d2', desc: '生成减速雾区' },
  'sun|moon':    { id: 'eclipse', name: '蚀爆', en: 'Eclipse',   color: '#c9a0ff', desc: '重创并处决残血敌人' },
  'moon|sun':    { id: 'eclipse', name: '蚀爆', en: 'Eclipse',   color: '#c9a0ff', desc: '重创并处决残血敌人' },
  'earth|wind':  { id: 'sand',    name: '砂暴', en: 'Sandstorm', color: '#e0b878', desc: '卷起持续伤害区域' },
  'wind|earth':  { id: 'sand',    name: '砂暴', en: 'Sandstorm', color: '#e0b878', desc: '卷起持续伤害区域' },
  'earth|water': { id: 'bloom',   name: '萌生', en: 'Bloom',     color: '#8fd6a0', desc: '藤蔓定身并回复自身' },
  'water|earth': { id: 'bloom',   name: '萌生', en: 'Bloom',     color: '#8fd6a0', desc: '藤蔓定身并回复自身' },
  'sun|earth':   { id: 'crystal', name: '晶化', en: 'Crystallise', color: '#ffe6a8', desc: '碎晶溅射' },
  'earth|sun':   { id: 'crystal', name: '晶化', en: 'Crystallise', color: '#ffe6a8', desc: '碎晶溅射' },
  'moon|wind':   { id: 'gale',    name: '夜岚', en: 'Night Gale', color: '#b9a6e8', desc: '拉扯周围敌人' },
  'wind|moon':   { id: 'gale',    name: '夜岚', en: 'Night Gale', color: '#b9a6e8', desc: '拉扯周围敌人' },
  'sun|water':   { id: 'rainbow', name: '虹桥', en: 'Rainbow',   color: '#ffd9ec', desc: '回复生命并充满星辉' },
  'water|sun':   { id: 'rainbow', name: '虹桥', en: 'Rainbow',   color: '#ffd9ec', desc: '回复生命并充满星辉' },
  'fire|moon':   { id: 'ash',     name: '烬月', en: 'Ash Moon',  color: '#e88b9a', desc: '削减敌人防御' },
  'moon|fire':   { id: 'ash',     name: '烬月', en: 'Ash Moon',  color: '#e88b9a', desc: '削减敌人防御' },
  'fire|earth':  { id: 'magma',   name: '熔岩', en: 'Magma',     color: '#ff9a5a', desc: '地面持续灼烧' },
  'earth|fire':  { id: 'magma',   name: '熔岩', en: 'Magma',     color: '#ff9a5a', desc: '地面持续灼烧' },
  'sun|wind':    { id: 'flare',   name: '曜风', en: 'Solar Flare', color: '#ffe08a', desc: '范围击退并致盲' },
  'wind|sun':    { id: 'flare',   name: '曜风', en: 'Solar Flare', color: '#ffe08a', desc: '范围击退并致盲' },
  'moon|earth':  { id: 'quake',   name: '地动', en: 'Quake',     color: '#c9a980', desc: '震晕范围内敌人' },
  'earth|moon':  { id: 'quake',   name: '地动', en: 'Quake',     color: '#c9a980', desc: '震晕范围内敌人' },
};
export const reactionOf = (a, b) => (a && b && a !== b) ? (REACTIONS[a + '|' + b] || null) : null;
export const REACTION_LIST = Object.values(REACTIONS).filter((r, i, a) => a.findIndex(x => x.id === r.id) === i);

// ---------------------------------------------------------------------------
// 同行者：开局属性决定构筑起点
// ---------------------------------------------------------------------------
export const HEROES = [
  { id: 1, name: '琪拉拉', en: 'Kirara', title: '星杖的引路人', titleEn: 'Guiding Star',
    stand: standee(1), face: face(1), card: cardArt(10002000), element: 'sun',
    hp: 100, atk: 15, spd: 2.9, nova: 1.0, color: '#f2b53c',
    desc: '挥动星杖，攻守均衡；日属性起手，易触发蚀爆与灼耀。',
    descEn: 'Balanced; starts with Sun for Eclipse and Scorch.' },
  { id: 2, name: '兰普', en: 'Lamp', title: '提灯的守望者', titleEn: 'Lantern Keeper',
    stand: standee(2), face: face(2), card: cardArt(11012000), element: 'water',
    hp: 128, atk: 12, spd: 2.6, nova: 0.9, color: '#f0a86a',
    desc: '生命更厚，进房间回复；水属性起手，易触发凝霜与蒸腾。',
    descEn: 'More HP, heals on entry; starts with Water.' },
  { id: 5, name: '梅迪亚', en: 'Media', title: '锻造的匠人', titleEn: 'Star Smith',
    stand: standee(5), face: face(5), card: cardArt(18002000), element: 'fire',
    hp: 88, atk: 21, spd: 2.8, nova: 1.0, color: '#ef7d6a',
    desc: '挥击最重、范围更广；火属性起手，燎原可连锁清场。',
    descEn: 'Heaviest swings; starts with Fire for chain Wildfire.' },
  { id: 6, name: '克蕾雅', en: 'Clea', title: '召唤的司书', titleEn: 'Summoning Scribe',
    stand: standee(6), face: face(6), card: cardArt(14002000), element: 'moon',
    hp: 92, atk: 13, spd: 2.8, nova: 1.35, color: '#a98ad8',
    desc: '星辉充能更快；月属性起手，蚀爆处决残血。',
    descEn: 'Faster nova; starts with Moon for Eclipse executes.' },
  { id: 9, name: '神无', en: 'Kanna', title: '疾风的剑士', titleEn: 'Gale Blade',
    stand: standee(9), face: face(9), card: cardArt(30002000), element: 'wind',
    hp: 94, atk: 16, spd: 3.5, nova: 1.0, color: '#79c9a6',
    desc: '移动与冲刺极快，冲刺撞敌附带风刃；天生二段跳。',
    descEn: 'Very fast, dash hits foes, innate double jump.' },
  { id: 12, name: '阿尔西芙', en: 'Archive', title: '神殿的星巫', titleEn: 'Shrine Astrologer',
    stand: standee(12), face: face(12), card: cardArt(23002000), element: 'moon',
    hp: 86, atk: 14, spd: 2.9, nova: 1.5, color: '#78c7e8',
    desc: '星辉槽上限更高，必杀可连续释放两次。',
    descEn: 'Larger nova gauge; the burst can be cast twice.' },
  { id: 10, name: '蕾涅', en: 'Leine', title: '静谧的治愈者', titleEn: 'Quiet Healer',
    stand: standee(10), face: face(10), card: cardArt(15002000), element: 'water',
    hp: 112, atk: 12, spd: 2.7, nova: 1.0, color: '#c7a6e0',
    desc: '击杀回复生命；水属性让凝霜与虹桥更易成型。',
    descEn: 'Heals on kills; Water enables Frost and Rainbow.' },
  { id: 38, name: '爱比丝', en: 'Ibis', title: '远星的旅人', titleEn: 'Far Star Traveller',
    stand: standee(38), face: face(38), card: cardArt(35002000), element: 'earth',
    hp: 96, atk: 17, spd: 3.0, nova: 1.0, color: '#e7668f',
    desc: '星屑弹轻微追踪；土属性起手，砂暴与地动控场。',
    descEn: 'Homing shots; Earth enables Sandstorm and Quake.' },
];

// ---------------------------------------------------------------------------
// 章节
// ---------------------------------------------------------------------------
export const BIOMES = [
  { name: '向阳花野', en: 'Sunlit Meadow', sub: '第一卷 · 花与星屑', subEn: 'Chapter I · Petals & Stardust',
    bg: A_IMG + 'ui/scene_field.webp', accent: '#f2b53c', ground: '#a9d479', ground2: '#6f9c4c',
    paper: '#c8e89a', foe: '#e88b6a', bgm: 'bgm_battle_1_0.mp3',
    boss: 13, bossName: '花野的守望', bossEn: 'Meadow Warden', bossEl: 'wind' },
  { name: '潮风海岸', en: 'Tidal Coast', sub: '第二卷 · 浪与灯火', subEn: 'Chapter II · Waves & Lamplight',
    bg: A_IMG + 'ui/scene_sea.webp', accent: '#78c7e8', ground: '#ecd9a8', ground2: '#b99a68',
    paper: '#f2e2b8', foe: '#6fb6d8', bgm: 'bgm_battle_3_0.mp3',
    boss: 14, bossName: '潮声的守卫', bossEn: 'Tide Sentinel', bossEl: 'water' },
  { name: '星砂古径', en: 'Stardust Ruins', sub: '第三卷 · 砂与旧梦', subEn: 'Chapter III · Sand & Old Dreams',
    bg: A_IMG + 'ui/scene_sand.webp', accent: '#e8a55a', ground: '#e0b878', ground2: '#a87d4c',
    paper: '#eed2a0', foe: '#c9a05e', bgm: 'bgm_battle_6_0.mp3',
    boss: 15, bossName: '砂海的看门人', bossEn: 'Dune Gatekeeper', bossEl: 'earth' },
  { name: '星灯王都', en: 'Starlit Capital', sub: '终卷 · 灯与归途', subEn: 'Finale · Lamps & Homeward',
    bg: A_IMG + 'ui/scene_village.webp', accent: '#a98ad8', ground: '#b9a6c8', ground2: '#7c6a90',
    paper: '#d8c8e8', foe: '#a98ad8', bgm: 'bgm_battle_9_0.mp3',
    boss: 16, bossName: '王都的星冠', bossEn: 'Crown of Stars', bossEl: 'sun' },
];
export const PLAN = ['combat', 'combat', 'shop', 'boss'];

// ---------------------------------------------------------------------------
// 敌人：全部使用现有透明立绘 / 道具图标，按属性染色与动画
// ---------------------------------------------------------------------------
// 立绘编号取自 orig/illust_N.webp：全部挑人形角色，避开玩家(1,2,5,6,9,10,12,38)
// 与首领(13,14,15,16)所用形象；3 号是白猫魔物，不用作敌人。
export const FOES = {
  ember:  { name: '星火游魂', en: 'Ember Wisp',  art: standee(42), element: 'fire',  hp: 30, atk: 9,  spd: 2.1, w: 38, h: 82,  drawH: 112, kind: 'walk',   coin: 3 },
  tide:   { name: '潮声侍者', en: 'Tide Attendant', art: standee(4), element: 'water', hp: 38, atk: 10, spd: 1.3, w: 40, h: 88,  drawH: 120, kind: 'shoot',  coin: 5 },
  gale:   { name: '疾风纸鸢', en: 'Gale Kite',   art: standee(45), element: 'wind',  hp: 24, atk: 8,  spd: 2.6, w: 36, h: 74,  drawH: 100, kind: 'fly',    coin: 4 },
  frost:  { name: '月影灯灵', en: 'Moon Lamp',   art: standee(40), element: 'moon',  hp: 34, atk: 11, spd: 1.2, w: 40, h: 86,  drawH: 116, kind: 'shoot',  coin: 5 },
  dawn:   { name: '日冕卫兵', en: 'Dawn Guard',  art: standee(47), element: 'sun',   hp: 76, atk: 16, spd: 1.5, w: 52, h: 108, drawH: 148, kind: 'charge', coin: 9 },
  stone:  { name: '星灯花',   en: 'Star Lamp Flower', art: ICON.barrel, element: 'earth', hp: 52, atk: 10, spd: 0, w: 44, h: 54,  drawH: 72,  kind: 'turret', coin: 7, icon: true },
};
export const FOE_IDS = Object.keys(FOES);

// ---------------------------------------------------------------------------
// 星辉：围绕「属性连锁」构筑协同
// ---------------------------------------------------------------------------
export const BOONS = [
  { id: 'kindle',    name: '星火种',   en: 'Kindling',   rare: 2, card: cardArt(32002000), desc: '燎原传播范围 +60%', descEn: 'Wildfire spread +60%', apply: P => { P.blazeR *= 1.6; } },
  { id: 'resonance', name: '共鸣',     en: 'Resonance',  rare: 2, card: cardArt(32172000), desc: '所有反应伤害 +45%', descEn: 'Reaction damage +45%', apply: P => { P.reactDmg *= 1.45; } },
  { id: 'twinstar',  name: '双星',     en: 'Twin Star',  rare: 2, card: cardArt(10002000), desc: '攻击同时附带副属性', descEn: 'Attacks apply a second element', apply: P => { P.dualEl = true; } },
  { id: 'echo',      name: '回响',     en: 'Echo',       rare: 1, card: cardArt(11012000), desc: '触发反应回复 14 星辉', descEn: 'Reactions refund 14 nova', apply: P => { P.reactNova += 14; } },
  { id: 'soakup',    name: '浸染',     en: 'Saturation', rare: 1, card: cardArt(18002000), desc: '每层浸染使伤害 +18%', descEn: '+18% damage per soak stack', apply: P => { P.soakBonus += 0.18; } },
  { id: 'frostbite', name: '霜噬',     en: 'Frostbite',  rare: 2, card: cardArt(14002000), desc: '冻结目标受到 +65% 伤害', descEn: 'Frozen foes take +65% damage', apply: P => { P.frostBonus += 0.65; } },
  { id: 'chain',     name: '连锁',     en: 'Chain',      rare: 2, card: cardArt(30002000), desc: '反应后 40% 概率保留浸染', descEn: '40% chance to keep soak after reaction', apply: P => { P.keepSoak += 0.4; } },
  { id: 'dive',      name: '坠星',     en: 'Falling Star', rare: 2, card: cardArt(23002000), desc: '下砸引发一次全场属性反应', descEn: 'Dive triggers a field-wide reaction', apply: P => { P.diveReact = true; } },
  { id: 'dash',      name: '星驰',     en: 'Star Dash',  rare: 1, card: cardArt(15002000), desc: '冲刺撞击附带当前属性', descEn: 'Dash hits apply your element', apply: P => { P.dashEl = true; } },
  { id: 'orbit',     name: '星环',     en: 'Orbit',      rare: 2, card: cardArt(35002000), desc: '环绕属性弹自动索敌', descEn: 'Orbiting elemental shots auto-fire', apply: P => { P.orbit = true; } },
  { id: 'power',     name: '星辰之力', en: 'Star Might', rare: 1, card: cardArt(22002000), desc: '攻击力 +6', descEn: 'Attack +6', apply: P => { P.atk += 6; } },
  { id: 'swift',     name: '疾风之靴', en: 'Gale Boots', rare: 1, card: cardArt(38002000), desc: '移动速度 +18%', descEn: 'Move speed +18%', apply: P => { P.spd *= 1.18; } },
  { id: 'heart',     name: '心之壁垒', en: 'Heart Wall', rare: 1, card: cardArt(24002000), desc: '生命上限 +28 并回复', descEn: 'Max HP +28, heal 28', apply: P => { P.maxhp += 28; P.hp = Math.min(P.maxhp, P.hp + 28); } },
  { id: 'djump',     name: '轻盈',     en: 'Feather Step', rare: 2, card: cardArt(20002000), desc: '获得二段跳 / 空中冲刺', descEn: 'Gain double jump & air dash', apply: P => { P.maxJumps = 2; } },
  { id: 'shield',    name: '守护星',   en: 'Guardian Star', rare: 2, card: cardArt(29002000), desc: '获得 1 层护盾，每房间刷新', descEn: 'Gain 1 shield, renewed each room', apply: P => { P.shieldMax += 1; P.shield = P.shieldMax; } },
  { id: 'novaup',    name: '星脉',     en: 'Star Vein',  rare: 1, card: cardArt(47002000), desc: '星辉充能 +45%', descEn: 'Nova charge +45%', apply: P => { P.novaRate *= 1.45; } },
  { id: 'drain',     name: '吸星',     en: 'Star Siphon', rare: 1, card: cardArt(28002000), desc: '击杀回复 5 生命', descEn: 'Heal 5 on each kill', apply: P => { P.drain += 5; } },
  { id: 'greed',     name: '贪星',     en: 'Star Greed', rare: 1, card: cardArt(31002000), desc: '金币获取 +60%', descEn: 'Coin gain +60%', apply: P => { P.greed *= 1.6; } },
  { id: 'burst',     name: '星爆',     en: 'Star Burst', rare: 2, card: cardArt(25002000), desc: '必杀伤害 +45%', descEn: 'Nova damage +45%', apply: P => { P.burst *= 1.45; } },
  { id: 'lucky',     name: '幸运星',   en: 'Lucky Star', rare: 1, card: cardArt(26002000), desc: '商店价格 -30%', descEn: 'Shop prices -30%', apply: P => { P.discount *= 0.7; } },
];

// ---------------------------------------------------------------------------
// 商店
// ---------------------------------------------------------------------------
export const SHOP_ITEMS = [
  { id: 'heal',   name: '蜜糖点心', en: 'Honey Cake',   icon: ICON.heal,    price: 18, desc: '回复 45 生命', descEn: 'Restore 45 HP', apply: P => { P.hp = Math.min(P.maxhp, P.hp + 45); } },
  { id: 'atk',    name: '磨星石',   en: 'Whetstone',    icon: ICON.atk,     price: 34, desc: '攻击力 +5', descEn: 'Attack +5', apply: P => { P.atk += 5; } },
  { id: 'hp',     name: '心之种',   en: 'Heart Seed',   icon: ICON.gem,     price: 40, desc: '生命上限 +20', descEn: 'Max HP +20', apply: P => { P.maxhp += 20; P.hp += 20; } },
  { id: 'shield', name: '星之护符', en: 'Star Charm',   icon: ICON.buff,    price: 30, desc: '获得 2 层护盾', descEn: 'Gain 2 shields', apply: P => { P.shieldMax += 2; P.shield += 2; } },
  { id: 'nova',   name: '星辉瓶',   en: 'Nova Vial',    icon: ICON.star,    price: 22, desc: '星辉槽充满', descEn: 'Fill the nova gauge', apply: P => { P.nova = P.novaMax; } },
  { id: 'boon',   name: '未知星辉', en: 'Mystery Boon', icon: ICON.skill,   price: 55, desc: '随机获得一枚星辉', descEn: 'Gain a random boon', boon: true, apply: () => {} },
];

// ---------------------------------------------------------------------------
// 永久升级
// ---------------------------------------------------------------------------
export const META = [
  { id: 'lamp',  name: '长明灯', en: 'Enduring Lamp', icon: ICON.heal,  max: 5, cost: l => 30 + l * 25, desc: '初始生命 +12 / 级', descEn: '+12 starting HP per level' },
  { id: 'edge',  name: '锋芒',   en: 'Keen Edge',     icon: ICON.atk,   max: 5, cost: l => 35 + l * 28, desc: '初始攻击 +2 / 级', descEn: '+2 starting ATK per level' },
  { id: 'seed',  name: '星种',   en: 'Star Seed',     icon: ICON.star,  max: 1, cost: () => 90, desc: '开局随机获得一枚星辉', descEn: 'Start each run with a random boon' },
  { id: 'ward',  name: '护符',   en: 'Warding Charm', icon: ICON.buff,  max: 3, cost: l => 45 + l * 35, desc: '开局护盾 +1 / 级', descEn: '+1 starting shield per level' },
  { id: 'prism', name: '棱镜',   en: 'Prism',         icon: ICON.crystal, max: 3, cost: l => 40 + l * 30, desc: '反应伤害 +12% / 级', descEn: '+12% reaction damage per level' },
  { id: 'purse', name: '行囊',   en: 'Traveller Purse', icon: ICON.coin, max: 3, cost: l => 25 + l * 20, desc: '开局金币 +25 / 级', descEn: '+25 starting coins per level' },
];

// ---------------------------------------------------------------------------
// 双语文案（全部原创 UI 文案）
// ---------------------------------------------------------------------------
const S = {
  zh: {
    'game.title': '星降旅记', 'game.sub': 'KIRARA · STARFALL', 'game.tag': '绘本立体书 · 六属性连锁动作肉鸽',
    'menu.start': '开始旅程', 'menu.howto': '玩法说明', 'menu.lang': '语言 / EN', 'menu.sound': '音效：开',
    'menu.soundOff': '音效：关', 'menu.best': '最佳记录', 'menu.none': '尚无记录',
    'menu.footer': '← → 移动 · 空格 跳（可蹬墙）· J 连招 · ↓+J 下砸 · Shift 冲刺 · Q 换属性 · K 星河',
    'howto.title': '玩法说明',
    'howto.1': '立体书世界由高低剪纸平台、深渊与机关组成；跳过坑洞、踩碎易碎纸片、点燃星灯。',
    'howto.2': 'J 地面三段连招（第三段上挑浮空），空中 J 空斩，空中 ↓+J 下砸砸碎平台并震晕。',
    'howto.3': 'Shift 冲刺可空中释放并撞伤敌人；贴墙按跳可蹬墙跳；↓+空格 从单向平台下穿。',
    'howto.4': 'Q / 1–6 切换六属性。攻击给敌人「浸染」，换属性再命中即触发反应。',
    'howto.5': '燎原会传播火种引发连锁，蚀爆处决残血，凝霜冻结——按属性顺序规划清场。',
    'howto.back': '返回',
    'hub.title': '星灯据点', 'hub.sub': '出发之前，先挑一位同行者',
    'hub.hero': '同行者', 'hub.stats': '生命 / 攻击 / 速度', 'hub.element': '起始属性',
    'hub.upgrade': '永久点亮', 'hub.dust': '星屑', 'hub.cost': '消耗',
    'hub.max': '已满', 'hub.buy': '点亮 (Enter)', 'hub.go': '出发 → (Enter)',
    'hub.switch': '← → 切换同行者', 'hub.back': '返回标题 (Esc)',
    'hub.best': '最远抵达', 'hub.hint': '每次旅程结束都会带回星屑',
    'room.combat': '战斗房间', 'room.shop': '星灯商店', 'room.boss': '首领之间',
    'room.clear': '房间已清空', 'room.wave': '第 {n} 波', 'room.finalWave': '最终波',
    'room.pit': '坠入星海！', 'room.fragile': '纸片碎裂',
    'hud.hp': '生命', 'hud.nova': '星辉', 'hud.coin': '金币', 'hud.kills': '击破',
    'hud.boons': '星辉', 'hud.combo': '连击', 'hud.element': '属性', 'hud.shield': '护盾',
    'hud.reaction': '反应', 'hud.next': '下一属性',
    'door.safe': '安稳之路', 'door.risk': '险峻之路', 'door.riskSub': '精英 · 额外星辉',
    'door.safeSub': '普通 · 平静前行', 'door.go': '靠近并按 ↑ / E 进入',
    'card.title': '拾取一枚星辉', 'card.sub': '选择 1 枚，按 1 / 2 / 3 或点击', 'card.nav': '← → 选择 · Enter 确认',
    'card.rare1': '常见', 'card.rare2': '珍稀', 'card.owned': '已拥有',
    'shop.title': '星灯商店', 'shop.sub': '用金币换取旅途所需',
    'shop.buy': '购买 (↑ / E)', 'shop.sold': '已售出', 'shop.leave': '离开商店 →', 'shop.poor': '金币不足',
    'pause.title': '暂停', 'pause.resume': '继续旅程', 'pause.quit': '放弃并返回据点',
    'pause.sound': '音效：开', 'pause.soundOff': '音效：关', 'pause.lang': '切换语言',
    'result.win': '星河归途', 'result.lose': '旅途暂歇',
    'result.winSub': '你走完了四卷星灯之路', 'result.loseSub': '星屑会留在据点，等你再来',
    'result.chapter': '抵达章节', 'result.rooms': '通过房间', 'result.kills': '击破星魔',
    'result.coin': '收集金币', 'result.time': '旅途时长', 'result.dust': '带回星屑',
    'result.react': '触发反应', 'result.again': '返回据点 (Enter)', 'result.newbest': '新纪录！',
    'boss.name': '首领',
    'hint.controls': '← → 移动 · 空格 跳/蹬墙 · J 连招 · ↓+J 下砸 · Shift 冲刺 · Q 换属性 · K 星河',
    'touch.jump': '跳', 'touch.atk': '击', 'touch.nova': '星', 'touch.dash': '闪', 'touch.el': '属',
    'common.back': '返回纪念主页',
  },
  en: {
    'game.title': 'Starfall Journal', 'game.sub': 'KIRARA · STARFALL', 'game.tag': 'A Pop-up Book · Six-Element Chain Roguelike',
    'menu.start': 'Begin Journey', 'menu.howto': 'How to Play', 'menu.lang': '语言 / 中文', 'menu.sound': 'Sound: On',
    'menu.soundOff': 'Sound: Off', 'menu.best': 'Best Run', 'menu.none': 'No record yet',
    'menu.footer': '← → move · Space jump/wall-jump · J combo · ↓+J dive · Shift dash · Q element · K nova',
    'howto.title': 'How to Play',
    'howto.1': 'The pop-up book has layered paper platforms, pits and props. Leap gaps, smash brittle sheets, light star lamps.',
    'howto.2': 'J = 3-hit ground combo (third launches). Air J = air slash. Air ↓+J = dive that shatters platforms and stuns.',
    'howto.3': 'Shift dashes (even airborne) and damages foes. Jump against a wall to wall-jump. ↓+Space drops through one-way sheets.',
    'howto.4': 'Q / 1–6 switches among six elements. Hits leave a "soak"; hitting again with a different element triggers a reaction.',
    'howto.5': 'Wildfire spreads embers into chains, Eclipse executes low-HP foes, Frost freezes — plan your element order.',
    'howto.back': 'Back',
    'hub.title': 'Starlamp Hub', 'hub.sub': 'Choose a companion before you set out',
    'hub.hero': 'Companion', 'hub.stats': 'HP / ATK / SPD', 'hub.element': 'Starting element',
    'hub.upgrade': 'Permanent Lights', 'hub.dust': 'Stardust', 'hub.cost': 'Cost',
    'hub.max': 'MAX', 'hub.buy': 'Light up (Enter)', 'hub.go': 'Set out → (Enter)',
    'hub.switch': '← → switch companion', 'hub.back': 'Back to title (Esc)',
    'hub.best': 'Furthest', 'hub.hint': 'Every journey brings stardust home',
    'room.combat': 'Battle Room', 'room.shop': 'Starlamp Shop', 'room.boss': 'Boss Chamber',
    'room.clear': 'Room cleared', 'room.wave': 'Wave {n}', 'room.finalWave': 'Final wave',
    'room.pit': 'Fell into the star sea!', 'room.fragile': 'Paper shattered',
    'hud.hp': 'HP', 'hud.nova': 'NOVA', 'hud.coin': 'COIN', 'hud.kills': 'KILLS',
    'hud.boons': 'BOONS', 'hud.combo': 'COMBO', 'hud.element': 'ELEMENT', 'hud.shield': 'Shield',
    'hud.reaction': 'REACTION', 'hud.next': 'next',
    'door.safe': 'Calm Path', 'door.risk': 'Perilous Path', 'door.riskSub': 'Elite · extra boon',
    'door.safeSub': 'Normal · quiet ahead', 'door.go': 'Stand close & press ↑ / E',
    'card.title': 'Pick a Star Boon', 'card.sub': 'Choose one — press 1 / 2 / 3 or click', 'card.nav': '← → choose · Enter confirm',
    'card.rare1': 'Common', 'card.rare2': 'Rare', 'card.owned': 'OWNED',
    'shop.title': 'Starlamp Shop', 'shop.sub': 'Trade coins for what the road needs',
    'shop.buy': 'Buy (↑ / E)', 'shop.sold': 'SOLD', 'shop.leave': 'Leave shop →', 'shop.poor': 'Not enough coins',
    'pause.title': 'Paused', 'pause.resume': 'Resume', 'pause.quit': 'Abandon & return to hub',
    'pause.sound': 'Sound: On', 'pause.soundOff': 'Sound: Off', 'pause.lang': 'Switch language',
    'result.win': 'Home by Starlight', 'result.lose': 'A Brief Rest',
    'result.winSub': 'You walked all four chapters of the starlit road', 'result.loseSub': 'Stardust waits at the hub until you return',
    'result.chapter': 'Chapter reached', 'result.rooms': 'Rooms cleared', 'result.kills': 'Imps defeated',
    'result.coin': 'Coins gathered', 'result.time': 'Time', 'result.dust': 'Stardust earned',
    'result.react': 'Reactions', 'result.again': 'Back to hub (Enter)', 'result.newbest': 'New best!',
    'boss.name': 'BOSS',
    'hint.controls': '← → move · Space jump/wall · J combo · ↓+J dive · Shift dash · Q element · K nova',
    'touch.jump': 'JMP', 'touch.atk': 'ATK', 'touch.nova': 'NOVA', 'touch.dash': 'DASH', 'touch.el': 'EL',
    'common.back': 'Back to Memorial',
  },
};

let LANG = 'zh';
export const getLang = () => LANG;
export const setLang = (v) => { LANG = v === 'en' ? 'en' : 'zh'; };
export function tr(key, vars) {
  let s = (S[LANG] && S[LANG][key]) || S.zh[key] || key;
  if (vars) for (const k in vars) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
  return s;
}
export const loc = (zh, en) => LANG === 'en' ? en : zh;
export const locObj = (o) => LANG === 'en' ? (o.en || o.nameZh || o.name) : (o.name || o.nameZh);
