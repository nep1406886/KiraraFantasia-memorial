// ============================================================
// 敌人与幕终主角
// ============================================================

export const ENEMIES = {
  oni: {
    id: 'oni', name: '墨鬼', en: 'INK ONI', draw: 'oni',
    hp: 68, speed: 96, dmg: 11, w: 62, h: 108,
    color: '#1b1726', accent: '#e8c47e', eye: '#ffcf7a',
    ai: 'chaser', weight: 10, acts: [0, 1, 2],
    attack: { kind: 'melee', range: 88, windup: .62, recover: .7, dmg: 1, knock: 180, lunge: 220 },
  },
  seat: {
    id: 'seat', name: '空席', en: 'EMPTY SEAT', draw: 'seat',
    hp: 50, speed: 44, dmg: 8, w: 70, h: 84, flying: true, hover: 100,
    color: '#2a2038', accent: '#a98ad8', eye: '#ffe9b0',
    ai: 'ranged', weight: 8, acts: [0, 1, 2],
    attack: { kind: 'fan', count: 3, spread: .22, speed: 240, windup: .8, recover: .9, dmg: 1, size: 11 },
  },
  crane: {
    id: 'crane', name: '折纸鹤', en: 'PAPER CRANE', draw: 'crane',
    hp: 42, speed: 150, dmg: 9, w: 64, h: 56, flying: true, hover: 122,
    color: '#efe4cf', accent: '#d96f8e', eye: '#b8304a',
    ai: 'flyer', weight: 7, acts: [0, 1],
    attack: { kind: 'dive', windup: .7, recover: .85, dmg: 1.1, speed: 520 },
  },
  book: {
    id: 'book', name: '提词精灵', en: 'PROMPTER', draw: 'book',
    hp: 58, speed: 52, dmg: 7, w: 60, h: 78, flying: true, hover: 112,
    color: '#7a4a5c', accent: '#e8c47e', eye: '#fff3c4',
    ai: 'ranged', weight: 5, acts: [0, 1, 2],
    attack: { kind: 'homing', count: 2, spread: .3, speed: 200, windup: .95, recover: 1.1, dmg: 1, size: 10 },
  },
  jelly: {
    id: 'jelly', name: '幕布水母', en: 'CURTAIN JELLY', draw: 'jelly',
    hp: 100, speed: 38, dmg: 10, w: 90, h: 108, flying: true, hover: 106,
    color: '#5d2140', accent: '#7bd6bf', eye: '#bff5e5',
    ai: 'ranged', weight: 4, acts: [1, 2],
    attack: { kind: 'burst', count: 6, speed: 215, windup: 1.1, recover: 1.3, dmg: .9, size: 9 },
  },
  hound: {
    id: 'hound', name: '断章猎犬', en: 'CHAPTER HOUND', draw: 'hound',
    hp: 82, speed: 190, dmg: 13, w: 90, h: 76,
    color: '#241a2e', accent: '#d96f8e', eye: '#ff9db6',
    ai: 'dasher', weight: 6, acts: [1, 2],
    attack: { kind: 'charge', windup: .72, recover: .8, dmg: 1.2, speed: 700 },
  },
  puppet: {
    id: 'puppet', name: '吊线人偶', en: 'MARIONETTE', draw: 'puppet',
    hp: 260, speed: 70, dmg: 16, w: 100, h: 184,
    color: '#1d1420', accent: '#e8c47e', eye: '#ffd166',
    ai: 'chaser', weight: 0, elite: true, acts: [0, 1, 2],
    attack: { kind: 'sweep', range: 150, windup: .85, recover: 1, dmg: 1.3, knock: 300, lunge: 120 },
  },
  judge: {
    id: 'judge', name: '终幕判官', en: 'FINAL JUDGE', draw: 'judge',
    hp: 340, speed: 84, dmg: 18, w: 108, h: 192,
    color: '#20152a', accent: '#b49bf0', eye: '#e3d6ff',
    ai: 'ranged', weight: 0, elite: true, acts: [2],
    attack: { kind: 'fan', count: 4, spread: .2, speed: 275, windup: .8, recover: .9, dmg: 1.2, size: 13 },
  },
  wisp: {
    id: 'wisp', name: '灯下影', en: 'SPOTLIGHT WISP', draw: 'wisp',
    hp: 52, speed: 118, dmg: 9, w: 52, h: 52, flying: true, hover: 196,
    color: '#0f0c18', accent: '#ffe9b0', eye: '#fff3c4',
    ai: 'flyer', weight: 5, acts: [0, 1, 2],
    attack: { kind: 'beam', windup: 1, recover: 1.2, dmg: 1, length: 420 },
  },
  sandpuppet: {
    id: 'sandpuppet', name: '星砂傀儡', en: 'SAND PUPPET', draw: 'sand',
    hp: 110, speed: 78, dmg: 14, w: 74, h: 126,
    color: '#5a3a24', accent: '#e0b878', eye: '#ffe6a8',
    ai: 'chaser', weight: 9, acts: [2],
    attack: { kind: 'melee', range: 100, windup: .66, recover: .8, dmg: 1.15, knock: 220, lunge: 180 },
  },
  lamp: {
    id: 'lamp', name: '无面灯神', en: 'FACELESS LAMP', draw: 'lamp',
    hp: 90, speed: 60, dmg: 11, w: 68, h: 114, flying: true, hover: 100,
    color: '#2a2338', accent: '#e8c47e', eye: '#fff3c4',
    ai: 'ranged', weight: 6, acts: [2],
    attack: { kind: 'homing', count: 3, spread: .25, speed: 225, windup: .8, recover: 1.1, dmg: 1.1, size: 12 },
  },
};

export const ELITES = {
  0: ['puppet'],
  1: ['puppet'],
  2: ['judge'],
};

export const ACT_POOLS = [
  ['oni', 'oni', 'seat', 'crane', 'wisp', 'book'],
  ['oni', 'seat', 'crane', 'jelly', 'hound', 'book'],
  ['sandpuppet', 'sandpuppet', 'lamp', 'hound', 'jelly', 'wisp'],
];

export const BOSSES = {
  papercrown: {
    id: 'papercrown', name: '纸冠之王', en: 'THE PAPER CROWN', title: '第一幕幕终 · 牵线者',
    draw: 'papercrown', hp: 1350, w: 250, h: 420, dmg: 16,
    color: '#241526', accent: '#e8c47e', eye: '#ffd166',
    intro: '“别急着谢幕。线还在我手里。”',
    phases: [.55, .22],
    patterns: [
      { id: 'batonSweep', cd: 3.6, phase: 1 },
      { id: 'spotlights', cd: 4.4, phase: 1 },
      { id: 'paperFan', cd: 2.9, phase: 1 },
      { id: 'pullStrings', cd: 5.2, phase: 1 },
      { id: 'carousel', cd: 4.6, phase: 2 },
      { id: 'bowShock', cd: 3.8, phase: 2 },
      { id: 'summon', cd: 6.2, phase: 2 },
    ],
    music: 'bgm_battle_10_0.mp3',
  },
  diva: {
    id: 'diva', name: '沉没的歌姬', en: 'THE DROWNED DIVA', title: '第二幕幕终 · 溺音',
    draw: 'diva', hp: 1750, w: 250, h: 380, dmg: 18,
    color: '#17334a', accent: '#7bd6bf', eye: '#bff5e5',
    intro: '“听啊，观众席还在合唱。”',
    phases: [.6, .28],
    patterns: [
      { id: 'noteRing', cd: 3.2, phase: 1 },
      { id: 'tide', cd: 4.8, phase: 1 },
      { id: 'sirenDive', cd: 3.9, phase: 1 },
      { id: 'noteRain', cd: 4.2, phase: 2 },
      { id: 'spiralAria', cd: 4.4, phase: 2 },
      { id: 'flood', cd: 6.4, phase: 2 },
    ],
    music: 'bgm_battle_11_0.mp3',
  },
  starless: {
    id: 'starless', name: '无星之王', en: 'THE STARLESS KING', title: '终幕 · 所有故事的结局',
    draw: 'starless', hp: 2600, w: 360, h: 480, dmg: 21,
    color: '#0d0a18', accent: '#a084dc', eye: '#e8c47e',
    intro: '“故事都该结束。你凭什么加演？”',
    phases: [.62, .3, .1],
    patterns: [
      { id: 'handSlam', cd: 3.4, phase: 1 },
      { id: 'starfall', cd: 4.2, phase: 1 },
      { id: 'eclipseBeam', cd: 4.8, phase: 1 },
      { id: 'blackHole', cd: 5.2, phase: 2 },
      { id: 'handSlam', cd: 2.8, phase: 2 },
      { id: 'starfall', cd: 3.4, phase: 2 },
      { id: 'finalCurtain', cd: 7.5, phase: 3 },
    ],
    music: 'bgm_battle_13_0.mp3',
  },
};
