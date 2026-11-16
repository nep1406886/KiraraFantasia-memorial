// ============================================================
// 三幕、房间、事件、永久强化
// ============================================================
import { SCENES } from '../config.js';

export const ACTS = [
  {
    id: 'grove', no: '第一幕', name: '暮林', en: 'ACT I · TWILIGHT GROVE',
    bg: SCENES.act1, tint: '#0a1a24', tintA: .5, fog: '#6fd6c0', accent: '#7bd6bf',
    particle: 'firefly', hazards: ['spotlight'],
    desc: '树影把舞台围成一座没有出口的森林。这里演的是一个关于出发的故事。',
    quote: '“每一棵树，都记得一个没有讲完的开头。”',
    boss: 'papercrown',
  },
  {
    id: 'tide', no: '第二幕', name: '潮汐', en: 'ACT II · TIDAL STAGE',
    bg: SCENES.act2, tint: '#082238', tintA: .5, fog: '#7fc7ff', accent: '#66b8ea',
    particle: 'bubble', hazards: ['geyser'],
    desc: '海水漫过观众席，布景变成一座沉没的港。这里演的是一个关于等待的故事。',
    quote: '“潮水退去以后，台词会留在沙上。”',
    boss: 'diva',
  },
  {
    id: 'dune', no: '第三幕', name: '星砂', en: 'ACT III · STAR SAND',
    bg: SCENES.act3, tint: '#2a1326', tintA: .52, fog: '#e0b878', accent: '#e8c47e',
    particle: 'sand', hazards: ['sandstorm'],
    desc: '最后一场戏在沙海上演。观众席只剩风，和一顶没有主人的王冠。',
    quote: '“谢幕不是结束，是把灯交给下一个人。”',
    boss: 'starless',
  },
];

export const ROOM_TYPES = {
  battle: { name: '演出', en: 'PERFORMANCE', icon: '⚔', color: '#c96a7c', desc: '一场普通的演出。敌人会分波次登场。' },
  elite: { name: '加演', en: 'ENCORE', icon: '☠', color: '#d8894e', desc: '危险的加演。精英敌人镇守，奖励更丰厚。' },
  shop: { name: '后台', en: 'BACKSTAGE', icon: '◉', color: '#6fa8c9', desc: '科克的小卖部。用星屑换取共演卡与补给。' },
  rest: { name: '中场', en: 'INTERMISSION', icon: '☾', color: '#82b98c', desc: '一段安静的休息。恢复生命，或整理节目单。' },
  event: { name: '即兴', en: 'IMPROV', icon: '❖', color: '#a98acb', desc: '没有排练过的插曲。选择会带来不同的结果。' },
  treasure: { name: '宝箱', en: 'PROP BOX', icon: '✦', color: '#d6b45f', desc: '一只落满灰的道具箱。里面也许还留着上一场戏的光。' },
  boss: { name: '幕终', en: 'FINALE', icon: '♛', color: '#d96f8e', desc: '这一幕的主角登场了。' },
};

export const ROOM_PLAN = [
  { stage: 0, options: ['battle', 'battle', 'event'] },
  { stage: 1, options: ['battle', 'event', 'elite', 'treasure'] },
  { stage: 2, options: ['shop', 'rest', 'treasure', 'battle'] },
  { stage: 3, options: ['elite', 'elite', 'event'] },
  { stage: 4, options: ['boss'] },
];

export const EVENTS = [
  {
    id: 'empty-seats', portrait: '❖', title: '空无一人的观众席',
    text: '你穿过一排排蒙尘的座椅。在最前排，有一只被人遗忘的节目单，上面还留着体温。你要坐下来听完这一场吗？',
    options: [
      { label: '坐下，听完', hint: '回复 14 点生命，获得 20 星屑', effect: { heal: 14, shards: 20 } },
      { label: '翻找座椅下的失物', hint: '获得 55 星屑，失去 8 点生命', effect: { shards: 55, damage: 8 } },
    ],
  },
  {
    id: 'lost-script', portrait: '✎', title: '遗失的台词本',
    text: '一本没有署名的台词本躺在聚光灯下。纸页上只有一句反复出现的话：“再说一次，再说一次。”',
    options: [
      { label: '翻开它', hint: '获得一张共演卡', effect: { boon: true } },
      { label: '把它当柴烧', hint: '回复 22 点生命', effect: { heal: 22 } },
    ],
  },
  {
    id: 'backstage-mirror', portrait: '◈', title: '后台的镜子',
    text: '镜子里的人比你慢半拍。她抬起手，你也抬起手。她对你比了一个“嘘”的手势。',
    options: [
      { label: '触碰镜面', hint: '生命上限 +8，失去 6 点生命', effect: { maxhp: 8, damage: 6 } },
      { label: '把镜子盖上', hint: '获得 65 星屑', effect: { shards: 65 } },
    ],
  },
  {
    id: 'prompter-wish', portrait: '✧', title: '提词员的请求',
    text: '一只小小的提词精灵拦住你，说它把最后一句台词弄丢了。它愿意用收藏很久的东西交换你的帮助。',
    options: [
      { label: '帮它找台词', hint: '获得一张共演卡，失去 10 点生命', effect: { boon: true, damage: 10 } },
      { label: '收下它的谢礼', hint: '获得 45 星屑', effect: { shards: 45 } },
    ],
  },
  {
    id: 'night-rehearsal', portrait: '☾', title: '深夜排练',
    text: '舞台空着，灯却亮着。有人在你之前来过，留下了一段没有跳完的舞。',
    options: [
      { label: '跟着跳完', hint: '获得 25 星屑，喝彩 +20', effect: { shards: 25, style: 20 } },
      { label: '坐在台边休息', hint: '回复 18 点生命', effect: { heal: 18 } },
    ],
  },
  {
    id: 'flower-girl', portrait: '❀', title: '卖花的小女孩',
    text: '一个抱着花篮的小女孩从幕布后探出头。她说，今晚的观众虽然少，但花还是应该有人买。',
    options: [
      { label: '买一束（40 星屑）', hint: '回复 18 点生命，生命上限 +4', effect: { cost: 40, heal: 18, maxhp: 4 } },
      { label: '摸摸她的头', hint: '获得 20 星屑', effect: { shards: 20 } },
    ],
  },
];

export const UPGRADES = [
  { id: 'oil', name: '灯油', en: 'LAMP OIL', icon: '✦', max: 4, costs: [120, 220, 340, 480], desc: (lv) => `全队生命上限 +${7 * lv}（当前）`, per: '每级全队生命上限 +7' },
  { id: 'script', name: '台词本', en: 'SCRIPT', icon: '✎', max: 4, costs: [140, 240, 360, 520], desc: (lv) => `攻击力 +${5 * lv}%（当前）`, per: '每级攻击力 +5%' },
  { id: 'applause', name: '掌声训练', en: 'APPLAUSE', icon: '❖', max: 3, costs: [160, 280, 420], desc: (lv) => `掌声获取 +${12 * lv}%（当前）`, per: '每级掌声获取 +12%' },
  { id: 'dust', name: '星尘袋', en: 'DUST POUCH', icon: '◉', max: 3, costs: [130, 230, 360], desc: (lv) => `开演时获得 ${35 * lv} 星屑（当前）`, per: '每级开演星屑 +35' },
  { id: 'revive', name: '返场许可', en: 'ENCORE PASS', icon: '♛', max: 1, costs: [520], desc: (lv) => lv ? '每场演出全队可返场 1 次' : '解锁：每场演出全队返场 1 次', per: '每场演出全队返场 1 次' },
  { id: 'program', name: '加座节目单', en: 'EXTRA PROGRAM', icon: '▤', max: 1, costs: [620], desc: (lv) => lv ? '共演卡奖励多 1 个选项' : '解锁：共演卡奖励多 1 个选项', per: '奖励选项 +1' },
  { id: 'makeup', name: '化妆间', en: 'DRESSING ROOM', icon: '✧', max: 1, costs: [760], desc: (lv) => lv ? '每场演出开始时获得 1 张随机共演卡' : '解锁：开演时获得 1 张随机共演卡', per: '开演时获得随机共演卡' },
];

export const UPGRADE_MAP = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
