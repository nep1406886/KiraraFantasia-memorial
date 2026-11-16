// ============================================================
// 演员表 · 9 位可操作角色
// ============================================================
import { ROOT } from '../config.js';

const stand = (n) => ROOT + 'imgs/original-characters/' + n + '_StandPic_0.png';

/*
  combo 动作字段：
  kind: melee | thrust | spin | slam | shot
  dmg: 攻击力倍率, dur: 动作总时长, hit: 命中判定时刻(0-1)
  reach/h/y: 近战判定范围, knock/launch: 击退
  shots: 远程弹幕参数
*/
export const CHARACTERS = [
  {
    id: 'kirara', name: '琪拉拉', en: 'KIRARA', title: '星杖的引路人', titleEn: 'THE GUIDING STAR',
    cls: 'priest', element: 'sun', stand: stand('Kirara'),
    hp: 104, atk: 13, speed: 322, jump: 790, weight: 1.0,
    hitColor: '#f0c96a', weapon: 'starstaff',
    quote: '把最后一束光，留给还在看的人。',
    bio: '从树根一路走到舞台边缘的引路人。她相信故事不会真正结束，只会在某个人心里换一种方式继续。今晚，她把星杖当成照明灯，也当成武器。',
    trait: { name: '星之引路', desc: '属性反应造成的伤害 +18%。' },
    combo: [
      { kind: 'melee', dmg: .58, dur: .26, hit: .42, reach: 108, h: 92, y: -76, knock: 110, launch: -30, lunge: 90, fx: 'slash' },
      { kind: 'melee', dmg: .62, dur: .28, hit: .4, reach: 112, h: 96, y: -78, knock: 130, launch: -50, lunge: 110, fx: 'slash2' },
      { kind: 'shot', dmg: .95, dur: .4, hit: .34, shots: { count: 1, spread: 0, speed: 760, size: 15, homing: .55, pierce: 0 }, lunge: -40, fx: 'star' },
    ],
    skill: {
      id: 'starClinic', name: '星屑诊疗', en: 'STAR CLINIC', cd: 8.5,
      desc: '为全队回复 10% 生命，并向四周射出 6 枚追踪星屑，每枚造成 80% 攻击伤害。',
    },
    ult: {
      id: 'galaxyTea', name: '银河茶会', en: 'GALAXY TEA PARTY',
      desc: '召唤 18 颗流星轰击整个舞台，每颗造成 120% 攻击伤害；随后为全队回复 26% 生命。',
    },
    switchIn: { name: '星环', dmg: 1.15, type: 'ring' },
    unlock: 0,
  },
  {
    id: 'lamp', name: '兰普', en: 'LAMP', title: '提灯的守望者', titleEn: 'THE LANTERN KEEPER',
    cls: 'knight', element: 'water', stand: stand('Lamp'),
    hp: 124, atk: 12, speed: 300, jump: 760, weight: 1.08,
    hitColor: '#66b8ea', weapon: 'lantern',
    quote: '灯还亮着，路就没有断。',
    bio: '总在队伍最后面提灯的人。她记得每个人的脚步声，也记得哪一段走廊最容易迷路。她说，守夜的人不需要被看见，只要灯还亮着就好。',
    trait: { name: '长明灯', desc: '全队受到的治疗效果 +22%。' },
    combo: [
      { kind: 'melee', dmg: .5, dur: .3, hit: .44, reach: 102, h: 96, y: -74, knock: 100, launch: -20, lunge: 70, fx: 'blunt' },
      { kind: 'melee', dmg: .55, dur: .32, hit: .42, reach: 106, h: 100, y: -76, knock: 120, launch: -40, lunge: 90, fx: 'blunt2' },
      { kind: 'slam', dmg: .85, dur: .48, hit: .48, reach: 120, h: 100, y: -60, knock: 180, launch: -140, lunge: 60, fx: 'lampSlam', heal: 3 },
    ],
    skill: {
      id: 'wardLight', name: '守灯之环', en: 'WARDING LIGHT', cd: 9.5,
      desc: '获得 44 点护盾，持续 5 秒，并为全队回复 9% 生命。护盾存在时受到伤害降低 15%。',
    },
    ult: {
      id: 'eternalLamp', name: '长明不夜', en: 'ETERNAL LAMP',
      desc: '全队 3 秒无敌，回复 32% 生命，并以灯焰冲击波对全场敌人造成 300% 攻击伤害。',
    },
    switchIn: { name: '灯浪', dmg: .9, type: 'wave', heal: 3 },
    unlock: 0,
  },
  {
    id: 'kanna', name: '神无', en: 'KANNA', title: '疾风的剑士', titleEn: 'THE GALE BLADE',
    cls: 'rogue', element: 'wind', stand: stand('Kanna'),
    hp: 96, atk: 15, speed: 365, jump: 810, weight: .94,
    hitColor: '#7fd6a8', weapon: 'katana',
    quote: '风会替我记得这一刀。',
    bio: '话很少的剑士，刀鞘上系着一枚旧铃铛。她从不解释自己为什么留在剧场，只在每次谢幕后，对着空座位行一个标准的礼。',
    trait: { name: '疾风', desc: '完美闪避会立刻刷新闪身，并额外获得 10 点喝彩。' },
    combo: [
      { kind: 'melee', dmg: .46, dur: .22, hit: .38, reach: 118, h: 86, y: -78, knock: 80, launch: -20, lunge: 120, fx: 'iai' },
      { kind: 'melee', dmg: .5, dur: .23, hit: .38, reach: 122, h: 90, y: -80, knock: 100, launch: -40, lunge: 130, fx: 'iai2' },
      { kind: 'thrust', dmg: .62, dur: .28, hit: .4, reach: 178, h: 62, y: -84, knock: 160, launch: -60, lunge: 260, fx: 'dashSlash' },
      { kind: 'melee', dmg: .95, dur: .4, hit: .44, reach: 150, h: 120, y: -82, knock: 220, launch: -120, lunge: 160, fx: 'iaiFinal' },
    ],
    skill: {
      id: 'parryStance', name: '居合 · 返', en: 'IAI COUNTER', cd: 6.2,
      desc: '摆出居合架势 0.55 秒。期间被击中则完全免伤，并反击周围敌人 280% 攻击伤害，触发短暂慢动作。',
    },
    ult: {
      id: 'thousandBirds', name: '风之型 · 千鸟', en: 'THOUSAND BIRDS',
      desc: '化作疾风穿行全场，斩击 14 次，每次 75% 攻击伤害。最后一次斩击造成 400% 伤害并击飞。',
    },
    switchIn: { name: '风切', dmg: 1.05, type: 'dashSlash' },
    unlock: 0,
  },
  {
    id: 'raine', name: '莱茵', en: 'RAINE', title: '焰斧的乐手', titleEn: 'THE AXE DIVA',
    cls: 'fighter', element: 'fire', stand: stand('Raine'),
    hp: 134, atk: 20, speed: 282, jump: 735, weight: 1.16,
    hitColor: '#f07a5a', weapon: 'axe',
    quote: '热闹一点，才像谢幕。',
    bio: '把战斧当吉他背在身后的乐手。她总说谢幕要热闹，于是每一次挥斧都像在敲响一面鼓。后台的墙上有她留下的半句歌词，没有人知道下一句。',
    trait: { name: '豪火', desc: '攻击有 25% 概率附加灼烧，持续 3 秒。' },
    combo: [
      { kind: 'melee', dmg: .72, dur: .38, hit: .5, reach: 136, h: 118, y: -78, knock: 160, launch: -40, lunge: 100, fx: 'heavy' },
      { kind: 'melee', dmg: .78, dur: .4, hit: .5, reach: 140, h: 122, y: -80, knock: 190, launch: -60, lunge: 120, fx: 'heavy2' },
      { kind: 'slam', dmg: 1.25, dur: .6, hit: .56, reach: 150, h: 130, y: -70, knock: 280, launch: -180, lunge: 80, fx: 'slam', shockwave: 1.0 },
    ],
    skill: {
      id: 'fireWheel', name: '烈焰轮舞', en: 'FIRE WHEEL', cd: 8,
      desc: '向前旋转突进 0.85 秒，持续斩击沿途敌人 7 次，每次 42% 攻击伤害并附加灼烧。',
    },
    ult: {
      id: 'grandFinale', name: '大团圆', en: 'GRAND FINALE',
      desc: '在舞台上炸开 5 道火焰柱，每道造成 240% 攻击伤害，最后一击为全屏爆炎，造成 380% 伤害。',
    },
    switchIn: { name: '落斧', dmg: 1.35, type: 'slam' },
    unlock: 0,
  },
  {
    id: 'cork', name: '科克', en: 'CORK', title: '后台的军火商', titleEn: 'THE BACKSTAGE SMITH',
    cls: 'alchemist', element: 'earth', stand: stand('Cork'),
    hp: 92, atk: 8, speed: 345, jump: 800, weight: .92,
    hitColor: '#cf9a5e', weapon: 'guns',
    quote: '道具、火药、退路，我都备好了。',
    bio: '剧场的道具师，也是唯一一个会在后台出售“应急方案”的人。她的口袋里永远有第三颗子弹、第四根引线，以及一张写着自己名字的退场名单。',
    trait: { name: '精打细算', desc: '星屑获取 +25%，商店价格 -12%。' },
    combo: [
      { kind: 'shot', dmg: .34, dur: .18, hit: .26, shots: { count: 1, spread: 0, speed: 980, size: 9, homing: 0, pierce: 0 }, fx: 'muzzle' },
      { kind: 'shot', dmg: .35, dur: .18, hit: .26, shots: { count: 1, spread: 0, speed: 1000, size: 9, homing: 0, pierce: 0 }, fx: 'muzzle' },
      { kind: 'shot', dmg: .3, dur: .22, hit: .28, shots: { count: 2, spread: .07, speed: 960, size: 8, homing: 0, pierce: 0 }, fx: 'muzzle2' },
      { kind: 'shot', dmg: .42, dur: .3, hit: .3, shots: { count: 3, spread: .14, speed: 900, size: 11, homing: .12, pierce: 0 }, fx: 'triple' },
    ],
    skill: {
      id: 'toolbox', name: '道具箱', en: 'TOOLBOX', cd: 7,
      desc: '向后跃开并抛出 5 枚炸药，每枚在落点爆炸，造成 95% 攻击伤害并击退敌人。',
    },
    ult: {
      id: 'fireworks', name: '烟火大会', en: 'FIREWORKS SHOW',
      desc: '架起全部礼炮，向舞台倾泻 26 发追踪烟火，每发造成 90% 攻击伤害，最后一发为 500% 的巨大烟花。',
    },
    switchIn: { name: '后撤射击', dmg: .75, type: 'backflipShots' },
    unlock: 0,
  },
  {
    id: 'claire', name: '克莱尔', en: 'CLAIRE', title: '月下的司书', titleEn: 'THE MOON SCRIBE',
    cls: 'mage', element: 'moon', stand: stand('Claire'),
    hp: 88, atk: 12, speed: 310, jump: 770, weight: .96,
    hitColor: '#b49bf0', weapon: 'tome',
    quote: '书页翻到最后，也不是结束。',
    bio: '负责整理剧本的司书。她读过所有故事的结局，却坚持在每一册的最后一页留白。她说，空白不是遗憾，是给下一次演出留的位置。',
    trait: { name: '魔导', desc: '特技冷却时间 -15%。' },
    combo: [
      { kind: 'shot', dmg: .5, dur: .3, hit: .35, shots: { count: 1, spread: 0, speed: 620, size: 15, homing: .8, pierce: 0 }, fx: 'orb' },
      { kind: 'shot', dmg: .55, dur: .32, hit: .36, shots: { count: 1, spread: 0, speed: 640, size: 16, homing: .85, pierce: 0 }, fx: 'orb' },
      { kind: 'shot', dmg: 1.0, dur: .48, hit: .4, shots: { count: 2, spread: .16, speed: 560, size: 22, homing: .6, pierce: 0 }, fx: 'bigOrb' },
    ],
    skill: {
      id: 'moonGate', name: '月之扉', en: 'MOON GATE', cd: 8.5,
      desc: '在身前打开月之门，持续 1.1 秒牵引周围敌人，随后爆炸，造成 290% 攻击伤害。',
    },
    ult: {
      id: 'finalPage', name: '终焉之页', en: 'THE FINAL PAGE',
      desc: '撕下剧本最后一页，生成吞噬一切的月蚀黑洞，并在全屏降下 8 颗月陨，每颗造成 200% 攻击伤害。',
    },
    switchIn: { name: '月辉', dmg: .78, type: 'orbFan' },
    unlock: 0,
  },
  {
    id: 'hakka', name: '哈卡', en: 'HAKKA', title: '清扫舞台的镰刀', titleEn: 'THE STAGE SWEEPER',
    cls: 'rogue', element: 'moon', stand: stand('Hakka'),
    hp: 100, atk: 11, speed: 352, jump: 800, weight: .95,
    hitColor: '#c9a0ff', weapon: 'scythe',
    quote: '打扫舞台，是我的工作。',
    bio: '女仆，也是舞台最后的清扫人。她会在所有人离场后，把散落的台词、碎掉的星光和没说完的再见一起扫进角落。她从不抬头看观众席。',
    trait: { name: '月镰', desc: '击杀敌人回复 2 点生命；对生命低于 30% 的敌人伤害 +30%。' },
    combo: [
      { kind: 'melee', dmg: .4, dur: .2, hit: .36, reach: 124, h: 104, y: -78, knock: 60, launch: -20, lunge: 100, fx: 'scythe' },
      { kind: 'melee', dmg: .42, dur: .2, hit: .36, reach: 128, h: 108, y: -80, knock: 70, launch: -30, lunge: 110, fx: 'scythe2' },
      { kind: 'melee', dmg: .46, dur: .22, hit: .38, reach: 132, h: 112, y: -80, knock: 90, launch: -50, lunge: 120, fx: 'scythe3' },
      { kind: 'spin', dmg: .72, dur: .36, hit: .4, reach: 156, h: 130, y: -78, knock: 160, launch: -100, lunge: 40, fx: 'scytheSpin' },
    ],
    skill: {
      id: 'sweep', name: '清扫时间', en: 'SWEEPING HOUR', cd: 7,
      desc: '化作月影向前突进，沿途斩击 5 次，每次 46% 攻击伤害，并回复造成伤害 12% 的生命。',
    },
    ult: {
      id: 'moonCleaning', name: '月下大扫除', en: 'MOONLIT CLEANUP',
      desc: '对全场敌人斩击 18 次，每次 65% 攻击伤害；对生命低于 15% 的非首领敌人直接处决。',
    },
    switchIn: { name: '回旋斩', dmg: .95, type: 'spin' },
    unlock: 260,
  },
  {
    id: 'highpris', name: '海普莉丝', en: 'HIGHPRIS', title: '不动的城塞', titleEn: 'THE UNMOVING WALL',
    cls: 'knight', element: 'earth', stand: stand('Highpris'),
    hp: 146, atk: 14, speed: 288, jump: 740, weight: 1.2,
    hitColor: '#cf9a5e', weapon: 'lance',
    quote: '只要我还站着，幕就落不下来。',
    bio: '前王城骑士，现在是剧场的门卫。她坚持检查每一张票根，即使观众席已经空了很久。有人问她为什么不离开，她说，总得有人替故事守门。',
    trait: { name: '守护', desc: '受到的所有伤害 -8%。' },
    combo: [
      { kind: 'thrust', dmg: .55, dur: .3, hit: .42, reach: 168, h: 64, y: -86, knock: 130, launch: -30, lunge: 120, fx: 'lance' },
      { kind: 'thrust', dmg: .6, dur: .32, hit: .42, reach: 176, h: 66, y: -88, knock: 150, launch: -40, lunge: 140, fx: 'lance2' },
      { kind: 'melee', dmg: .95, dur: .46, hit: .46, reach: 132, h: 120, y: -80, knock: 260, launch: -120, lunge: 80, fx: 'shieldBash' },
    ],
    skill: {
      id: 'bulwark', name: '铁壁', en: 'BULWARK', cd: 8,
      desc: '举盾 1 秒，期间受到伤害降低 65%，并反弹所有来袭弹幕。结束时以盾击震退周围敌人，造成 140% 攻击伤害。',
    },
    ult: {
      id: 'fortress', name: '不动城塞', en: 'THE FORTRESS',
      desc: '展开 2.5 秒的城塞结界，全队无敌；结界结束时引发震波，造成 360% 攻击伤害并眩晕全场敌人。',
    },
    switchIn: { name: '盾突', dmg: 1.1, type: 'charge', stun: 1 },
    unlock: 420,
  },
  {
    id: 'suzuran', name: '铃兰', en: 'SUZURAN', title: '花雨的长弓', titleEn: 'THE PETAL ARCHER',
    cls: 'rogue', element: 'wind', stand: stand('Suzuran'),
    hp: 90, atk: 10, speed: 332, jump: 780, weight: .9,
    hitColor: '#9fe0b8', weapon: 'bow',
    quote: '最后一箭，献给看不见的观众。',
    bio: '在剧场屋顶种花的弓手。她把每一支箭都削成花枝的样子，射出去的时候像一场倒着下的雨。她说，花会记得箭去过的地方。',
    trait: { name: '风语', desc: '攻击速度 +10%，远程攻击射程 +15%。' },
    combo: [
      { kind: 'shot', dmg: .44, dur: .26, hit: .3, shots: { count: 1, spread: 0, speed: 1120, size: 8, homing: .1, pierce: 0 }, fx: 'arrow' },
      { kind: 'shot', dmg: .46, dur: .26, hit: .3, shots: { count: 1, spread: 0, speed: 1140, size: 8, homing: .1, pierce: 0 }, fx: 'arrow' },
      { kind: 'shot', dmg: .98, dur: .4, hit: .38, shots: { count: 1, spread: 0, speed: 1260, size: 12, homing: .18, pierce: 99 }, fx: 'pierceArrow' },
    ],
    skill: {
      id: 'flowerRain', name: '花雨', en: 'PETAL RAIN', cd: 8,
      desc: '向天空射出 14 支花箭，落向指定区域，每支造成 70% 攻击伤害并减速敌人。',
    },
    ult: {
      id: 'thousandPetals', name: '百花缭乱', en: 'THOUSAND PETALS',
      desc: '释放 30 枚追踪花瓣，每枚造成 80% 攻击伤害；花瓣命中后留下花海，持续造成伤害。',
    },
    switchIn: { name: '三连射', dmg: .7, type: 'tripleShot' },
    unlock: 560,
  },
];

export const CHAR_MAP = Object.fromEntries(CHARACTERS.map((c) => [c.id, c]));
export const STARTERS = ['kirara', 'lamp', 'kanna', 'raine', 'cork', 'claire'];
export const DEFAULT_TEAM = ['kirara', 'lamp', 'kanna'];
