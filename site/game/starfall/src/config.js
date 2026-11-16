// 星落漫游 — authored data.
// Character rows reuse the memorial site's card/resource IDs so the card art,
// face icon and 3D model stay the same asset the rest of the site shows.

export const VIEW_W = 960;
export const VIEW_H = 540;
export const FLOOR_Y = 438;
export const TILE = 40;
export const SAVE_KEY = "kirafan_starfall_v1";

export const ELEMENTS = {
  0: { id: 0, zh: "炎", color: "#ff8a5c", glow: "#ffc08d", mark: "炎" },
  1: { id: 1, zh: "水", color: "#5fb0e8", glow: "#a5dcff", mark: "水" },
  2: { id: 2, zh: "土", color: "#c08d58", glow: "#e7c195", mark: "土" },
  3: { id: 3, zh: "风", color: "#69cba8", glow: "#b1f0d9", mark: "风" },
  4: { id: 4, zh: "月", color: "#a88be6", glow: "#d6c4ff", mark: "月" },
  5: { id: 5, zh: "日", color: "#f0b64b", glow: "#ffe19a", mark: "日" }
};

// 水 > 炎 > 风 > 土 > 水；月与日互相克制。
const ADVANTAGE = { 1: 0, 0: 3, 3: 2, 2: 1, 4: 5, 5: 4 };
export function elementMultiplier(attacker, defender) {
  if (ADVANTAGE[attacker] === defender) return 1.3;
  if (ADVANTAGE[defender] === attacker) return 0.8;
  return 1;
}

export const CLASSES = {
  0: { id: 0, zh: "斗士", glyph: "⚔", role: "连击与机动" },
  1: { id: 1, zh: "魔法师", glyph: "✦", role: "远程与穿透" },
  2: { id: 2, zh: "牧师", glyph: "✚", role: "回复与星弹" },
  3: { id: 3, zh: "骑士", glyph: "⛨", role: "重击与守护" },
  4: { id: 4, zh: "炼金术士", glyph: "⚗", role: "投掷与范围" }
};

export const CHARACTERS = [
  {
    id: "kirara",
    cardId: 32002001,
    resourceId: 320002,
    classId: 2,
    element: 5,
    name: "琪拉拉",
    cardName: "琪拉拉【漫画版】",
    work: "Kirara Fantasia",
    color: "#e88b9f",
    accent: "#8d5a9e",
    hp: 112,
    atk: 1.0,
    speed: 242,
    jumps: 1,
    trait: "星愿的倾听者：每拾起一枚星愿，回复 4 点生命。",
    skill: {
      name: "星屑诊疗",
      glyph: "✚",
      cd: 7.5,
      desc: "回复 14% 生命，并向四周放出 5 枚追踪星屑（每枚 11 伤害）。",
      type: "healStars"
    },
    ult: {
      name: "银河点心",
      glyph: "★",
      desc: "召唤星屑雨：全屏 24 枚星屑坠落，每枚 12 伤害，并回复 18% 生命。",
      type: "starShower"
    },
    quote: "“去把星星捡回来吧。”"
  },
  {
    id: "chiya",
    cardId: 17002001,
    resourceId: 170004,
    classId: 3,
    element: 0,
    name: "千矢",
    cardName: "千矢",
    work: "Urara 迷路帖",
    color: "#e76f62",
    accent: "#6d3f58",
    hp: 148,
    atk: 1.14,
    speed: 218,
    jumps: 1,
    trait: "山野的直觉：受到伤害时，有 20% 概率立刻回复 6 点生命。",
    skill: {
      name: "月影冲角",
      glyph: "⛨",
      cd: 7,
      desc: "架盾向前冲撞，造成 46 伤害并获得 24 点护盾。",
      type: "shieldCharge"
    },
    ult: {
      name: "满月守护",
      glyph: "☾",
      desc: "展开满月结界：获得 60 点护盾，释放一圈冲击波造成 90 伤害。",
      type: "moonGuard"
    },
    quote: "“迷路也是旅途的一部分嘛。”"
  },
  {
    id: "cocoa",
    cardId: 30002001,
    resourceId: 300004,
    classId: 0,
    element: 3,
    name: "心爱",
    cardName: "心爱",
    work: "请问您今天要来点兔子吗？",
    color: "#f0a05c",
    accent: "#b45c4a",
    hp: 106,
    atk: 0.95,
    speed: 266,
    jumps: 2,
    trait: "元气补给：击败敌人时回复 2 点生命。",
    skill: {
      name: "元气百连",
      glyph: "⚡",
      cd: 6.5,
      desc: "向前方快速挥出 8 连击，每段 9 伤害，期间不会被打断。",
      type: "rapidFlurry"
    },
    ult: {
      name: "太阳拳",
      glyph: "☀",
      desc: "汇聚阳光轰击前方，造成 150 伤害并击退所有敌人。",
      type: "sunburst"
    },
    quote: "“姐姐我可是很可靠的哦！”"
  },
  {
    id: "aoba",
    cardId: 15002001,
    resourceId: 150004,
    classId: 1,
    element: 3,
    name: "凉风青叶",
    cardName: "凉风 青叶",
    work: "NEW GAME!",
    color: "#78c4b2",
    accent: "#4f7e9c",
    hp: 96,
    atk: 1.1,
    speed: 236,
    jumps: 1,
    trait: "绘师的手感：暴击率 +8%，暴击伤害 +10%。",
    skill: {
      name: "风之绘卷",
      glyph: "✦",
      cd: 6.8,
      desc: "放出一道穿透风刃，造成 58 伤害，可贯穿 3 名敌人。",
      type: "windPierce"
    },
    ult: {
      name: "青叶绘本",
      glyph: "❋",
      desc: "翻开绘本，召来 5 道巨大风刃横扫全场，每道 38 伤害。",
      type: "galePage"
    },
    quote: "“先画一版试试看吧。”"
  },
  {
    id: "uzuzu",
    cardId: 32172001,
    resourceId: 321702,
    classId: 4,
    element: 4,
    name: "乌兹兹",
    cardName: "乌兹兹【第2部】",
    work: "Kirara Fantasia",
    color: "#a692d6",
    accent: "#5d4b88",
    hp: 102,
    atk: 1.06,
    speed: 232,
    jumps: 1,
    trait: "悲观者的好运：生命低于 35% 时，攻击力 +20%。",
    skill: {
      name: "摇摇星瓶",
      glyph: "⚗",
      cd: 7.2,
      desc: "投出星瓶，形成 4 秒的月辉毒雾，每秒造成 13 伤害。",
      type: "poisonFlask"
    },
    ult: {
      name: "月面坠落",
      glyph: "☾",
      desc: "让一小片月亮落下来：全屏月辉爆发，造成 135 伤害并减速敌人。",
      type: "moonFall"
    },
    quote: "“反正、反正也不会顺利的吧……”"
  },
  {
    id: "karen",
    cardId: 14002001,
    resourceId: 140004,
    classId: 0,
    element: 4,
    name: "九条可怜",
    cardName: "九条 可怜",
    work: "黄金拼图",
    color: "#e7b45d",
    accent: "#8f6a3c",
    hp: 100,
    atk: 1.02,
    speed: 274,
    jumps: 2,
    trait: "黄金色的每一天：闪身冷却 -12%，闪身后首次攻击伤害 +30%。",
    skill: {
      name: "双刃回旋",
      glyph: "✧",
      cd: 6.2,
      desc: "旋身斩击三次，每次 19 伤害，并短暂提升暴击率。",
      type: "spinBlades"
    },
    ult: {
      name: "可怜百景",
      glyph: "✦",
      desc: "以黄金色的残影连斩全场，造成 12 段 18 伤害。",
      type: "hundredViews"
    },
    quote: "“世界，每天都是黄金色！”"
  }
];

// Base attack per class. `combo` rows are [damage, duration, knockback].
export const ATTACKS = {
  0: { kind: "melee", combo: [8, 9, 14], duration: [0.22, 0.22, 0.32], range: 54, reach: 36, knockback: [80, 95, 210], thirdLunge: 95 },
  1: { kind: "projectile", damage: 13, duration: [0.36], cooldown: 0.36, speed: 660, radius: 7, range: 520 },
  2: { kind: "melee", combo: [9, 10, 16], duration: [0.26, 0.26, 0.36], range: 58, reach: 40, knockback: [75, 90, 190], thirdLunge: 80 },
  3: { kind: "melee", combo: [12, 13, 21], duration: [0.3, 0.3, 0.42], range: 66, reach: 46, knockback: [100, 110, 240], thirdLunge: 70 },
  4: { kind: "lob", damage: 17, duration: [0.44], cooldown: 0.44, speed: 460, radius: 9, range: 420, blast: 58 }
};

export const META_UPGRADES = [
  { id: "vitality", name: "生命之星", glyph: "✚", max: 4, costs: [20, 40, 65, 95], desc: "最大生命 +16 / 级" },
  { id: "edge", name: "锋锐之星", glyph: "⚔", max: 4, costs: [22, 44, 70, 100], desc: "攻击力 +7% / 级" },
  { id: "stride", name: "疾行之星", glyph: "»", max: 3, costs: [25, 50, 80], desc: "移速 +2%、闪身冷却 -5% / 级" },
  { id: "fortune", name: "拾星之星", glyph: "✦", max: 3, costs: [18, 38, 62], desc: "开局星屑 +25 / 级" },
  { id: "ember", name: "不灭之星", glyph: "♡", max: 2, costs: [70, 120], desc: "每局多一次星之复起 / 级" }
];

export const BIOMES = [
  {
    id: "dawn",
    name: "晨曦花径",
    sub: "花瓣停在半空，像在等一个迟到的早晨。",
    act: "第一卷",
    skyTop: "#fff1d4",
    skyMid: "#f8c8c4",
    skyLow: "#c4a9d8",
    skyDeep: "#7d74b3",
    sun: "#fff3c9",
    sunGlow: "#ffdba8",
    cloud: ["#fff4e4", "#f7d8de"],
    far: "#b9a6d6",
    mid: "#8e86b9",
    near: "#6f689c",
    platformTop: "#ffeccd",
    platformBody: "#c48f77",
    platformEdge: "#9a635d",
    platformMoss: "#9fcb9e",
    platformFlower: ["#ffb9c9", "#fff2c4", "#f7d8ff"],
    accent: "#ffcf8a",
    particle: "#ffd7dc",
    tint: "#ffe8d5"
  },
  {
    id: "canal",
    name: "星灯水巷",
    sub: "水面上漂着没有点亮的灯，倒影里藏着另一片夜空。",
    act: "第二卷",
    skyTop: "#20204e",
    skyMid: "#3a3a78",
    skyLow: "#7366a8",
    skyDeep: "#b486b4",
    sun: "#eef1ff",
    sunGlow: "#c7d0ff",
    cloud: ["#37376b", "#4b4a83"],
    far: "#2d2e5e",
    mid: "#252750",
    near: "#1c1d40",
    platformTop: "#d9e8f5",
    platformBody: "#4e5b85",
    platformEdge: "#333d63",
    platformMoss: "#7fb7c9",
    platformFlower: ["#a8e6ff", "#ffe3a4", "#d9c8ff"],
    accent: "#9bd8ff",
    particle: "#a9d9ff",
    tint: "#cfd8ff"
  },
  {
    id: "library",
    name: "夜织书库",
    sub: "书页自己翻动起来，把最后一颗星藏进了故事的背面。",
    act: "第三卷",
    skyTop: "#130f2a",
    skyMid: "#241a46",
    skyLow: "#43265e",
    skyDeep: "#6e3a70",
    sun: "#d9c4ff",
    sunGlow: "#a786e0",
    cloud: ["#2b1d4f", "#392459"],
    far: "#211539",
    mid: "#1b102e",
    near: "#140b24",
    platformTop: "#d6c2ed",
    platformBody: "#54406f",
    platformEdge: "#38294f",
    platformMoss: "#9b7fc4",
    platformFlower: ["#f0b8e2", "#ffe6a8", "#b8c8ff"],
    accent: "#d9b8ff",
    particle: "#e2caff",
    tint: "#d8c4ff"
  }
];

export const BOSSES = {
  ginger: {
    id: "ginger",
    name: "生姜",
    title: "灼热的守卷人",
    model: 1400,
    element: 0,
    hp: 820,
    height: 154,
    hitbox: [70, 104],
    color: "#f18a6b",
    intro: "“这一页的甜味，可不会轻易分给你。”",
    outro: "“哼，星星就先借你一会儿。下一卷，可别迟到。”",
    patterns: ["slam", "fan", "charge"]
  },
  mint: {
    id: "mint",
    name: "薄荷",
    title: "静水的守卷人",
    model: 1600,
    element: 1,
    hp: 1320,
    height: 154,
    hitbox: [68, 104],
    color: "#8fc8e8",
    intro: "“静水会记住每一个脚步。包括你的。”",
    outro: "“脚步没有乱。看来，你确实听见了水的声音。”",
    patterns: ["fan", "charge", "slam", "summon"]
  },
  arshif: {
    id: "arshif",
    name: "阿尔希芙",
    title: "终卷的守望者",
    model: 1700,
    element: 4,
    hp: 1980,
    height: 168,
    hitbox: [76, 112],
    color: "#e5b7dd",
    intro: "“把星星带回去之前，先让我看看你的故事。”",
    outro: "“原来如此。这一页，写得很好。”",
    patterns: ["slam", "fan", "summon", "charge", "starfall"]
  }
};

// Regular enemy catalogue. `models` picks the colour variant per act.
export const ENEMIES = {
  blot: {
    id: "blot",
    name: "小黑怪",
    kind: "walker",
    models: [10005, 10001, 10004],
    height: 44,
    hp: 27,
    damage: 7,
    speed: 52,
    element: [5, 1, 4],
    hitbox: [30, 30]
  },
  squirrel: {
    id: "squirrel",
    name: "松鼠",
    kind: "hopper",
    models: [10103, 10101, 10104],
    height: 47,
    hp: 21,
    damage: 8,
    speed: 92,
    element: [3, 1, 4],
    hitbox: [28, 32]
  },
  dandelion: {
    id: "dandelion",
    name: "蒲公英",
    kind: "flyer",
    models: [10305, 10301, 10304],
    height: 46,
    hp: 19,
    damage: 6,
    speed: 46,
    element: [5, 1, 4],
    hitbox: [30, 30]
  },
  lizard: {
    id: "lizard",
    name: "蜥蜴",
    kind: "charger",
    models: [10403, 10401, 10404],
    height: 50,
    hp: 46,
    damage: 11,
    speed: 64,
    element: [3, 1, 4],
    hitbox: [34, 34]
  },
  fish: {
    id: "fish",
    name: "石鱼",
    kind: "turret",
    models: [10502, 10501, 10504],
    height: 35,
    hp: 42,
    damage: 8,
    speed: 0,
    element: [2, 1, 4],
    hitbox: [38, 28]
  }
};

export const ACTS = [
  {
    act: 0,
    biome: 0,
    rooms: ["combat", "combat", "rest", "boss"],
    boss: "ginger",
    pool: ["blot", "squirrel", "dandelion"],
    elitePool: ["blot", "squirrel"],
    intro: "花瓣还停在半空，像是在等一个迟到的早晨。",
    outro: "第一颗星落回了天幕。花径深处，下一页正在发光。"
  },
  {
    act: 1,
    biome: 1,
    rooms: ["combat", "elite", "shop", "boss"],
    boss: "mint",
    pool: ["lizard", "dandelion", "fish", "squirrel"],
    elitePool: ["lizard", "fish"],
    intro: "水面上漂着没有点亮的灯，倒影里藏着另一片夜空。",
    outro: "水巷的灯一盏盏亮起。再往前，是书页翻动的声音。"
  },
  {
    act: 2,
    biome: 2,
    rooms: ["combat", "elite", "rest", "boss"],
    boss: "arshif",
    pool: ["blot", "squirrel", "lizard", "fish", "dandelion"],
    elitePool: ["lizard", "blot", "fish"],
    intro: "书页自己翻动起来，把最后一颗星藏进了故事的背面。",
    outro: "最后一页合上时，夜空重新亮了起来。"
  }
];

export const BOONS = [
  { id: "edge", name: "锐利星屑", rarity: 0, glyph: "⚔", icon: "gadget-edge", tint: "#f4d6c2", desc: "攻击力 +15%。", flavor: "削铅笔时也会小心地留下星形的木屑。", max: 4 },
  { id: "vital", name: "柔软围巾", rarity: 0, glyph: "✚", icon: "gadget-cotton", tint: "#f7d7dd", desc: "最大生命 +18，并回复 18 点。", flavor: "一圈一圈，把风挡在故事外面。", max: 5 },
  { id: "haste", name: "风铃草", rarity: 0, glyph: "≫", icon: "gadget-strider", tint: "#d7eadb", desc: "移动速度 +10%。", flavor: "叮铃一声，跑起来的时候就不会冷。", max: 3 },
  { id: "swift", name: "轻快脚步", rarity: 0, glyph: "»", icon: "gadget-kite", tint: "#d6e7f4", desc: "闪身冷却 -12%。", flavor: "把影子留在原地，自己先走一步。", max: 3 },
  { id: "crit", name: "星眼", rarity: 0, glyph: "✦", icon: "gadget-aim", tint: "#f5e3c0", desc: "暴击率 +8%。", flavor: "看见星星的缝隙，就能命中它。", max: 4 },
  { id: "critdmg", name: "流星尾", rarity: 1, glyph: "☄", icon: "gadget-comet", tint: "#e8d8f5", desc: "暴击伤害 +25%。", flavor: "尾巴越亮，落点越疼。", max: 3 },
  { id: "lifesteal", name: "童话糖", rarity: 1, glyph: "♡", icon: "gadget-ribbon", tint: "#f7d3df", desc: "每次命中回复 1.2 点生命。", flavor: "甜味会顺着指尖，慢慢回到心里。", max: 4 },
  { id: "doublejump", name: "纸页翅膀", rarity: 1, glyph: "❋", icon: "gadget-petal", tint: "#e2ead8", desc: "空中跳跃 +1 次；重复拾取时改为攻击 +8%。", flavor: "书页的边缘，是可以踩上去的。", max: 1 },
  { id: "multishot", name: "分岔星路", rarity: 1, glyph: "⋔", icon: "gadget-wide", tint: "#dbe6f4", desc: "远程攻击 +1 发；近战角色改为攻击时追加一枚星弹。", flavor: "迷路的时候，多一条路总是好的。", max: 2 },
  { id: "pierce", name: "穿页针", rarity: 1, glyph: "⇥", icon: "gadget-reach", tint: "#e7dff2", desc: "远程攻击可多贯穿 1 名敌人。", flavor: "针尖比故事更细，却能穿过整本书。", max: 2 },
  { id: "dashblast", name: "爆闪", rarity: 1, glyph: "✷", icon: "gadget-bloom", tint: "#f4d8e6", desc: "闪身时对周围造成 20 伤害。", flavor: "裙摆扫过的地方，会开出一圈小小的烟花。", max: 2 },
  { id: "thorn", name: "玫瑰刺", rarity: 1, glyph: "✿", icon: "gadget-binding", tint: "#f2d3d4", desc: "受伤时对周围敌人造成 22 伤害。", flavor: "温柔的人，也会在袖口藏一根刺。", max: 2 },
  { id: "shieldstart", name: "星灯护符", rarity: 1, glyph: "⛨", icon: "gadget-aegis", tint: "#dbe9f3", desc: "进入新房间时获得 22 点护盾。", flavor: "灯还亮着，就不用怕黑。", max: 3 },
  { id: "healkill", name: "采集篮", rarity: 0, glyph: "❀", icon: "gadget-leaf", tint: "#dcead7", desc: "击败敌人回复 2 点生命。", flavor: "沿途捡一点能吃的，路就没那么长。", max: 3 },
  { id: "dust", name: "星屑财布", rarity: 0, glyph: "✧", icon: "gadget-bell", tint: "#f4e4bf", desc: "获得的星屑 +25%。", flavor: "摇一摇，里面全是碎掉的星光。", max: 3 },
  { id: "ultcharge", name: "星愿瓶", rarity: 1, glyph: "★", icon: "gadget-solstice", tint: "#f5dfc0", desc: "星坠充能速度 +25%。", flavor: "愿望装得太满，瓶口会自己发亮。", max: 3 },
  { id: "cdr", name: "秒针", rarity: 1, glyph: "⏱", icon: "gadget-rhythm", tint: "#e4e0f2", desc: "特技冷却 -15%。", flavor: "把等待折起来，塞进表盘的背面。", max: 3 },
  { id: "burn", name: "灼热糖", rarity: 1, glyph: "♨", icon: "gadget-sentry", tint: "#f5d4c8", desc: "攻击附加 2 秒灼烧，每秒 4 伤害。", flavor: "含在嘴里会冒星星的糖。", max: 2 },
  { id: "slow", name: "蜜糖霜", rarity: 1, glyph: "❄", icon: "gadget-moon", tint: "#dbe7f2", desc: "攻击使敌人减速 25%，持续 1.5 秒。", flavor: "时间也会被糖霜粘住一会儿。", max: 2 },
  { id: "knock", name: "大风", rarity: 0, glyph: "≫", icon: "gadget-hunter", tint: "#dce7df", desc: "击退 +35%，攻击力 +8%。", flavor: "翻页的风，从来不问页脚的意见。", max: 2 },
  { id: "combo", name: "连击星", rarity: 1, glyph: "✦", icon: "gadget-comet", tint: "#f8e3c8", desc: "第三段攻击伤害 +35%。", flavor: "第一颗星、第二颗星，第三颗最亮。", max: 2 },
  { id: "exec", name: "收尾星", rarity: 1, glyph: "☾", icon: "gadget-edge", tint: "#ecd8e5", desc: "对生命低于 30% 的敌人伤害 +40%。", flavor: "故事总要有人写下最后一句。", max: 2 },
  { id: "armor", name: "纸铠甲", rarity: 1, glyph: "⛨", icon: "gadget-steady", tint: "#e2e5ea", desc: "受到的伤害 -12%。", flavor: "虽然是纸做的，但也是认真折过的。", max: 3 },
  { id: "revive", name: "星之回响", rarity: 2, glyph: "✧", icon: "gadget-prism", tint: "#f3dcc7", desc: "每局一次：倒下时以 50% 生命复起。", flavor: "你在故事里留下的声音，会把你叫回来。", max: 2 },
  { id: "magnet", name: "拾星绳", rarity: 0, glyph: "⌁", icon: "gadget-reach", tint: "#e8e2f0", desc: "星屑拾取范围大幅提升，星屑 +10%。", flavor: "系在手腕上，星星会自己滚过来。", max: 2 },
  { id: "firsthit", name: "先手星", rarity: 0, glyph: "↯", icon: "gadget-aim", tint: "#f2e1c4", desc: "对满生命敌人首次命中伤害 +50%。", flavor: "打招呼要趁对方还没准备好。", max: 2 },
  { id: "skillpower", name: "特技星", rarity: 1, glyph: "✹", icon: "gadget-solstice", tint: "#f4ddc3", desc: "特技伤害 +30%。", flavor: "练过的招式，总会比昨天更亮一点。", max: 2 },
  { id: "airborne", name: "浮空星", rarity: 1, glyph: "☁", icon: "gadget-kite", tint: "#dfe8f4", desc: "空中攻击伤害 +25%。", flavor: "脚离地的时候，星星也离得更近。", max: 2 },
  { id: "healpower", name: "治愈星", rarity: 0, glyph: "♡", icon: "gadget-leaf", tint: "#dcecd9", desc: "所有回复效果 +30%。", flavor: "被照顾过的人，才更会照顾别人。", max: 3 },
  { id: "luck", name: "幸运星", rarity: 2, glyph: "✧", icon: "gadget-prism", tint: "#f5e5c8", desc: "暴击率 +5%，星屑 +10%。", flavor: "今天也会是黄金色的一天。", max: 2 }
];

export const BOON_RARITY = [
  { name: "常见星愿", color: "#8d7c93", card: "#f6efe8" },
  { name: "稀有星愿", color: "#b07c3d", card: "#fbf0d9" },
  { name: "传说星愿", color: "#b34a72", card: "#f9e2ec" }
];

export const SHOP_STOCK = [
  { id: "heal", name: "星露茶", desc: "回复 50% 生命", price: 28, icon: "drop/skill-recovery", glyph: "✚" },
  { id: "maxhp", name: "加厚书签", desc: "最大生命 +20", price: 55, icon: "drop/skill-buff", glyph: "❤" },
  { id: "boon", name: "星愿福袋", desc: "随机获得一枚星愿", price: 46, icon: "drop/skill-special", glyph: "✧" },
  { id: "rareboon", name: "描金福袋", desc: "随机获得稀有星愿", price: 78, icon: "drop/skill-special", glyph: "★" },
  { id: "shield", name: "星灯罩", desc: "获得 35 点护盾", price: 24, icon: "drop/equipment-frame", glyph: "⛨" },
  { id: "discount", name: "旧书签", desc: "永久：本局商店 -20% 价格", price: 62, icon: "drop/provenance", glyph: "％" }
];

export const STORY = {
  intro: [
    {
      kicker: "PROLOGUE · 星落的夜晚",
      title: "被翻过的夜空",
      text: "那天夜里，星空像被谁轻轻翻过一页。\n星屑落进艾特瓦利亚，把熟悉的故事染成了陌生的颜色。"
    },
    {
      kicker: "PROLOGUE · 星落的夜晚",
      title: "合上冒险手账",
      text: "琪拉拉把散落的星屑收进手账，抬头时，身边已经站好了同行的她们。\n“去把星星捡回来吧。”"
    },
    {
      kicker: "PROLOGUE · 星落的夜晚",
      title: "从这一页出发",
      text: "沿着被星屑照亮的小径，穿过三卷故事，找回想藏在书页背面的那一片夜空。\n旅途不长，但足够写下一段新的回忆。"
    }
  ],
  win: {
    title: "夜空重新亮起来了",
    text: "你捡回的每一颗星，都在她们的眼睛里。\n故事合上时，书页的边缘还留着一点温度。"
  },
  lose: {
    title: "这一页先合上了",
    text: "书页合上了。别担心，下一次翻开时，她们还在原地等你。"
  }
};

export const TIPS = [
  "闪身有无敌帧，穿过弹幕比硬吃伤害划算。",
  "空中可以再跳一次的角色，长按跳跃能跳得更高。",
  "第三段攻击最重，也会把敌人击退得更远。",
  "星坠充满后不会自动释放，记得按 Q。",
  "护盾会先于生命被消耗，进新房间前可以留着。",
  "对满血的敌人，先手星会额外发亮。",
  "商店里也可以只买一杯星露茶，再继续赶路。",
  "倒下了也没关系，星辉会留下来，星图会记得。"
];

export const KEY_BINDINGS = {
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  down: ["KeyS"],
  jump: ["Space", "KeyW", "ArrowUp"],
  attack: ["KeyJ", "KeyZ"],
  skill: ["KeyK", "KeyX"],
  dash: ["KeyL", "KeyC"],
  ult: ["KeyQ"],
  interact: ["KeyE", "ArrowDown"],
  pause: ["Escape", "KeyP"],
  confirm: ["Enter"],
  mute: ["KeyM"]
};

export const ICON_BASE = "../../asset/img/rl/";
export const EQUIPMENT_ICON_BASE = "../../asset/img/rl/equipment/";
export const CARD_BASE = "../../asset/img/rl/card/";
export const FACE_BASE = "../../asset/img/rl/icon/";

export const BGM = {
  title: "town_1",
  select: "town_1",
  battle: ["battle_1", "battle_2", "battle_5"],
  elite: "battle_6",
  boss: ["battle_3", "battle_10", "battle_13"],
  shop: "gachaplay",
  rest: "town_2",
  win: "battle_win"
};
