// ============================================================
// 落幕剧场 · 常量与全局配置
// ============================================================

export const W = 1280;
export const H = 720;
export const FLOOR = 612;
export const ROOM_W = 2480;
export const WALL = 52;
export const GRAVITY = 2300;
export const STEP = 1 / 60;
export const ROOT = '../../';

export const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif';
export const FONT_SERIF = '"Songti SC","STSong","Noto Serif SC","SimSun",serif';
export const FONT_EN = 'Georgia,"Times New Roman",serif';

export const COL = {
  ink: '#07060c',
  night: '#0b0915',
  indigo: '#141026',
  gold: '#e8c47e',
  goldSoft: '#f8e7bd',
  goldDark: '#8c6428',
  ivory: '#f4ead7',
  dim: '#a99c8f',
  rose: '#d96f8e',
  crimson: '#a92d48',
  jade: '#7bd6bf',
  violet: '#a084dc',
  white: '#fff8e8',
};

// ---------------------------------------------------------------------------
// 六属性
// ---------------------------------------------------------------------------
export const ELEMENTS = [
  { id: 'sun', name: '日', en: 'Sun', color: '#f0c96a', soft: '#ffe9b0', icon: ROOT + 'imgs/Attribute_Sun.png' },
  { id: 'moon', name: '月', en: 'Moon', color: '#b49bf0', soft: '#e3d6ff', icon: ROOT + 'imgs/Attribute_Moon.png' },
  { id: 'fire', name: '火', en: 'Fire', color: '#f07a5a', soft: '#ffcbb8', icon: ROOT + 'imgs/Attribute_Fire.png' },
  { id: 'water', name: '水', en: 'Water', color: '#66b8ea', soft: '#c4e8ff', icon: ROOT + 'imgs/Attribute_Water.png' },
  { id: 'wind', name: '风', en: 'Wind', color: '#7fd6a8', soft: '#cdf4dd', icon: ROOT + 'imgs/Attribute_Wind.png' },
  { id: 'earth', name: '土', en: 'Earth', color: '#cf9a5e', soft: '#efd2aa', icon: ROOT + 'imgs/Attribute_Earth.png' },
];
export const EL = Object.fromEntries(ELEMENTS.map((e) => [e.id, e]));

// ---------------------------------------------------------------------------
// 属性反应（15 对）
// ---------------------------------------------------------------------------
function pair(a, b, def) { return { a, b, ...def }; }
export const REACTIONS = [
  pair('sun', 'moon', { id: 'eclipse', name: '蚀爆', en: 'Eclipse', color: '#c9a0ff', dmg: 1.55, radius: 150, text: '日月相蚀，万籁俱寂' }),
  pair('fire', 'wind', { id: 'blaze', name: '燎原', en: 'Wildfire', color: '#ff9a5a', dmg: .65, radius: 110, burn: 4.5 }),
  pair('fire', 'water', { id: 'steam', name: '蒸腾', en: 'Vapour', color: '#bfe6ff', dmg: .95, radius: 105, stun: .55, knock: 260 }),
  pair('water', 'wind', { id: 'frost', name: '凝霜', en: 'Frost', color: '#9fd8ff', dmg: .55, radius: 95, freeze: 1.6 }),
  pair('earth', 'water', { id: 'bloom', name: '萌生', en: 'Bloom', color: '#8fd6a0', dmg: .5, radius: 95, root: 1.5, heal: 4 }),
  pair('fire', 'earth', { id: 'magma', name: '熔岩', en: 'Magma', color: '#ff9a5a', dmg: .8, radius: 100, armorBreak: 3, burn: 3 }),
  pair('sun', 'fire', { id: 'radiance', name: '灼耀', en: 'Radiance', color: '#ffd166', dmg: 1.15, radius: 95, burn: 3.5 }),
  pair('sun', 'water', { id: 'rainbow', name: '虹桥', en: 'Rainbow', color: '#ffd9ec', dmg: .35, radius: 80, heal: 6, ult: 10 }),
  pair('sun', 'wind', { id: 'flare', name: '曜风', en: 'Solar Flare', color: '#ffe08a', dmg: .85, radius: 130, blind: 2 }),
  pair('sun', 'earth', { id: 'crystal', name: '晶化', en: 'Crystal', color: '#ffe6a8', dmg: 1.25, radius: 90, shards: 2 }),
  pair('moon', 'fire', { id: 'ash', name: '烬月', en: 'Ash Moon', color: '#e88b9a', dmg: .7, radius: 90, armorBreak: 2.5, burn: 2 }),
  pair('moon', 'water', { id: 'tide', name: '潮月', en: 'Moon Tide', color: '#b9d8ff', dmg: .4, radius: 105, slow: 2.5, healOrb: true }),
  pair('moon', 'wind', { id: 'gale', name: '夜岚', en: 'Night Gale', color: '#b9a6e8', dmg: .5, radius: 140, pull: 220 }),
  pair('moon', 'earth', { id: 'quake', name: '地动', en: 'Quake', color: '#c9a980', dmg: 1.0, radius: 125, stun: .9 }),
  pair('wind', 'earth', { id: 'sand', name: '砂暴', en: 'Sandstorm', color: '#e0b878', dmg: .55, radius: 125, blind: 2.5, burn: 1.5 }),
];
export const REACTION_MAP = {};
for (const r of REACTIONS) {
  REACTION_MAP[r.a + '|' + r.b] = r;
  REACTION_MAP[r.b + '|' + r.a] = r;
}
export function reactionOf(a, b) {
  if (!a || !b || a === b) return null;
  return REACTION_MAP[a + '|' + b] || null;
}

// ---------------------------------------------------------------------------
// 职业
// ---------------------------------------------------------------------------
export const CLASSES = {
  fighter: { name: '战士', en: 'Fighter', color: '#e07a6a', glyph: '⚔' },
  knight: { name: '骑士', en: 'Knight', color: '#7fa8d8', glyph: '⛨' },
  priest: { name: '牧师', en: 'Priest', color: '#e8c47e', glyph: '✚' },
  mage: { name: '法师', en: 'Magician', color: '#a78ee0', glyph: '✧' },
  alchemist: { name: '炼金', en: 'Alchemist', color: '#7bc4a0', glyph: '⚗' },
  rogue: { name: '游侠', en: 'Ranger', color: '#7fd6c0', glyph: '➶' },
};

// ---------------------------------------------------------------------------
// 喝彩等级
// ---------------------------------------------------------------------------
export const RANKS = [
  { key: 'd', name: '静场', min: 0, mul: 1.0 },
  { key: 'c', name: '入戏', min: 110, mul: 1.08 },
  { key: 'b', name: '喝彩', min: 270, mul: 1.16 },
  { key: 'a', name: '满堂', min: 460, mul: 1.26 },
  { key: 's', name: '惊鸿', min: 670, mul: 1.4 },
  { key: 'ss', name: '绝唱', min: 850, mul: 1.56 },
  { key: 'sss', name: '传说', min: 1000, mul: 1.78 },
];
export const RANK_MAX = 1000;

// ---------------------------------------------------------------------------
// 演员站位 / 场景
// ---------------------------------------------------------------------------
export const A = ROOT + 'asset/img/rl/';
export const AUDIO = ROOT + 'audio/bgm/';
export const SCENES = {
  title: A + 'ui/title.webp',
  hub: A + 'ui/scene_study.webp',
  select: A + 'ui/scene_train.webp',
  shop: A + 'ui/shop.webp',
  rest: A + 'ui/scene_inn.webp',
  event: A + 'ui/scene_forge.webp',
  result: A + 'ui/result.webp',
  act1: A + 'ui/dark.webp',
  act2: A + 'ui/scene_sea.webp',
  act3: A + 'ui/scene_sand.webp',
};
export const ICONS = {
  coin: A + 'drop/coin.webp',
  star: A + 'drop/star.webp',
  heal: A + 'drop/skill-recovery.webp',
  atk: A + 'drop/skill-attack.webp',
  buff: A + 'drop/skill-buff.webp',
  debuff: A + 'drop/skill-debuff.webp',
  special: A + 'drop/skill-special.webp',
  equip: A + 'drop/equipment-frame.webp',
};

// ---------------------------------------------------------------------------
// 存档键 / 默认设置
// ---------------------------------------------------------------------------
export const SAVE_KEY = 'lastencore.save.v1';
export const DEFAULT_SETTINGS = {
  music: 0.62,
  sfx: 0.78,
  shake: true,
  damage: true,
  lowfx: false,
  touch: false,
  // 触屏设备上用户明确关闭过触屏层（touch=false 时不自动再弹出）
  touchAutoOff: false,
};

// ---------------------------------------------------------------------------
// 操作映射
// ---------------------------------------------------------------------------
export const KEYS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  jump: ['Space', 'ArrowUp', 'KeyW'],
  attack: ['KeyJ', 'KeyZ'],
  skill: ['KeyK', 'KeyX'],
  dash: ['KeyL', 'KeyC'],
  swap: ['ShiftLeft', 'ShiftRight'],
  ult: ['KeyQ', 'KeyV'],
  pause: ['Escape', 'KeyP'],
  interact: ['KeyE', 'Enter'],
  confirm: ['Enter', 'Space'],
};

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------
export const TXT = {
  ranks: RANKS.map((r) => r.name),
  title: '落幕剧场',
  titleEn: 'THE LAST ENCORE',
  tagline: '故事早已完结，但掌声还没有停。',
};
