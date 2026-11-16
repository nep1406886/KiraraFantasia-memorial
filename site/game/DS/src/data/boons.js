// ============================================================
// 星纹卡 · 共演者（Roguelike 被动构筑）
// ============================================================
import { ROOT } from '../config.js';

export const CARD_ART = (id) => ROOT + 'asset/img/rl/card/' + id + '.webp';

export const CATS = {
  blade: { name: '刃', en: 'BLADE', color: '#d96f6f', glyph: '⚔' },
  star: { name: '星', en: 'STAR', color: '#e8c47e', glyph: '✦' },
  stage: { name: '幕', en: 'STAGE', color: '#b49bf0', glyph: '◈' },
  life: { name: '生', en: 'LIFE', color: '#7bd6bf', glyph: '✚' },
  fortune: { name: '财', en: 'FORTUNE', color: '#79b8d8', glyph: '◉' },
};

export const RARITY = [
  null,
  { name: '银幕', color: '#b9b3a8', stars: 1 },
  { name: '金幕', color: '#e8c47e', stars: 2 },
  { name: '星幕', color: '#f4b8d8', stars: 3 },
];

const B = (o) => ({
  ...o,
  art: CARD_ART(o.card),
  tags: [CATS[o.cat].name, RARITY[o.rarity].name],
});

export const BOONS = [
  B({
    id: 'kirara-manga', card: '32002001', owner: '琪拉拉【漫画版】', name: '星屑应援', title: '把星星别在胸口',
    cat: 'star', rarity: 2, mods: { cdr: .1, ultGain: .14 },
    desc: '特技冷却 -10%；星辉获取 +14%。',
  }),
  B({
    id: 'yuno', card: '10002001', owner: '由乃', name: '温柔的包扎', title: '别逞强，先坐下',
    cat: 'life', rarity: 1, mods: { heal: .22, roomHeal: 4 },
    desc: '受到的治疗 +22%；每场开演回复 4 点生命。',
  }),
  B({
    id: 'yui', card: '11012001', owner: '栞井 唯', name: '画室的笔锋', title: '线条要更利落',
    cat: 'blade', rarity: 1, mods: { atk: .12, crit: .06 },
    desc: '攻击力 +12%；暴击率 +6%。',
  }),
  B({
    id: 'anna', card: '18002001', owner: '折部 安奈', name: '不可思议的力气', title: '交给我吧！',
    cat: 'blade', rarity: 2, mods: { critDmg: .35 },
    desc: '暴击伤害 +35%。',
  }),
  B({
    id: 'karen', card: '14002001', owner: '九条 可怜', name: '大小姐的剑', title: '优雅地解决',
    cat: 'blade', rarity: 1, mods: { melee: .16 },
    desc: '近战攻击伤害 +16%。',
  }),
  B({
    id: 'cocoa', card: '30002001', owner: '心爱', name: '元气充电', title: '累了就要好好休息',
    cat: 'life', rarity: 1, mods: { hp: 18, heal: .1 },
    desc: '生命上限 +18；受到的治疗 +10%。',
  }),
  B({
    id: 'rin', card: '23002001', owner: '志摩 凛', name: '换装时间', title: '下一套，更适合舞台',
    cat: 'stage', rarity: 2, mods: { switchCdr: .28, switchDmg: .3 },
    desc: '换演冷却 -28%；登场技伤害 +30%。',
  }),
  B({
    id: 'aoba', card: '15002001', owner: '凉风 青叶', name: '写生观察', title: '先看清，再落笔',
    cat: 'star', rarity: 2, mods: { ranged: .16, markDur: 1.2 },
    desc: '远程攻击伤害 +16%；属性印记持续时间 +1.2 秒。',
  }),
  B({
    id: 'yuko', card: '35002001', owner: '吉田 优子', name: '部费管理', title: '每一枚都要记账',
    cat: 'fortune', rarity: 1, mods: { shards: .3, shop: -.1 },
    desc: '星屑获取 +30%；商店价格 -10%。',
  }),
  B({
    id: 'yui-hirasawa', card: '22002001', owner: '平泽 唯', name: '放学后的和弦', title: '再来一遍！',
    cat: 'blade', rarity: 2, mods: { as: .14 }, flags: ['thirdWave'],
    desc: '攻击速度 +14%；连击第 3 段释放一道音波，造成 45% 攻击伤害。',
  }),
  B({
    id: 'mira', card: '38002001', owner: '木之幡 米拉', name: '星图测绘', title: '每颗星都有名字',
    cat: 'star', rarity: 2, mods: { reaction: .2 }, flags: ['markSpread'],
    desc: '属性反应伤害 +20%；反应会把属性印记扩散给附近敌人。',
  }),
  B({
    id: 'kaoruko', card: '24002001', owner: '萌田 薰子', name: '漫画家的耐力', title: '截稿日还没到',
    cat: 'life', rarity: 1, mods: { dmgTaken: -.07, hp: 8 },
    desc: '受到的伤害 -7%；生命上限 +8。',
  }),
  B({
    id: 'mashiro', card: '20002001', owner: '樱之宫 莓香', name: '微笑服务', title: '欢迎光临后台',
    cat: 'fortune', rarity: 2, mods: { shop: -.18 }, flags: ['healDiscount'],
    desc: '商店所有价格 -18%；治疗类商品额外 -30%。',
  }),
  B({
    id: 'haruka', card: '29002001', owner: '大空 遥', name: '钓到大鱼', title: '今天运气不错',
    cat: 'life', rarity: 2, mods: { healOnKill: 2.5 },
    desc: '击杀敌人回复 2.5 点生命。',
  }),
  B({
    id: 'hinata', card: '47002001', owner: '海凪 日和', name: '海风印记', title: '潮水会记得',
    cat: 'star', rarity: 1, mods: { waterReaction: .35 },
    desc: '水属性参与的反应伤害 +35%。',
  }),
  B({
    id: 'anzu', card: '28002001', owner: '花小泉 杏', name: '探险预算', title: '再挖一点就好',
    cat: 'fortune', rarity: 1, mods: { shards: .2, startShards: 45 },
    desc: '每场开演获得 45 星屑；星屑获取 +20%。',
  }),
  B({
    id: 'koharu', card: '31002001', owner: '鸠谷 小羽', name: '快门连拍', title: '这个瞬间很棒',
    cat: 'blade', rarity: 2, mods: { crit: .1 }, flags: ['critStar'],
    desc: '暴击率 +10%；暴击时额外射出一枚星弹，造成 50% 攻击伤害。',
  }),
  B({
    id: 'hana', card: '21002001', owner: '一之濑 花名', name: '花语疗愈', title: '花会替你说话',
    cat: 'life', rarity: 2, mods: { heal: .25 }, flags: ['switchHeal'],
    desc: '受到的治疗 +25%；换演时为全队回复 3 点生命。',
  }),
  B({
    id: 'haruka-k', card: '19002001', owner: '高山 春香', name: '舞台气场', title: '看这边！',
    cat: 'stage', rarity: 3, mods: { applause: .25, styleDecay: -.3 },
    desc: '喝彩获取 +25%；喝彩衰减速度 -30%。',
  }),
  B({
    id: 'ryo', card: '37002001', owner: '町子 凉', name: '温热的汤', title: '先喝一口再上场',
    cat: 'life', rarity: 2, mods: { roomHeal: 9, heal: .1 },
    desc: '每场开演回复 9 点生命；受到的治疗 +10%。',
  }),
  B({
    id: 'kuro', card: '34002001', owner: '小黑', name: '猫步', title: '落地要轻',
    cat: 'blade', rarity: 2, mods: { dashDmg: .6, dashCd: .15 }, flags: ['dashStrike'],
    desc: '闪身冷却 -15%；闪身穿过敌人时造成 60% 攻击伤害。',
  }),
  B({
    id: 'nagisa', card: '39002001', owner: '武田 咏深', name: '长弓的呼吸', title: '吸气，然后放手',
    cat: 'star', rarity: 2, mods: { ranged: .2 },
    desc: '远程攻击伤害 +20%。',
  }),
  B({
    id: 'kisaragi', card: '25002001', owner: '山口 如月', name: '忍者身法', title: '看不见我',
    cat: 'stage', rarity: 3, mods: { dashCharge: 1 },
    desc: '获得一次额外的空中闪身。',
  }),
  B({
    id: 'mary', card: '26002001', owner: '玛莉 · 梦魔', name: '梦魔的低语', title: '做个好梦',
    cat: 'star', rarity: 2, mods: { moonReaction: .35 },
    desc: '月属性参与的反应伤害 +35%。',
  }),
  B({
    id: 'harumi', card: '36002001', owner: '细野 晴海', name: '海边的呼吸', title: '慢慢来',
    cat: 'life', rarity: 2, mods: { hp: 14 }, flags: ['roomShield15'],
    desc: '生命上限 +14；每场开演获得 15 点护盾。',
  }),
  B({
    id: 'alice', card: '14012001', owner: '爱丽丝【圣诞节】', name: '圣诞礼物', title: '拆开看看？',
    cat: 'fortune', rarity: 3, mods: { extraChoice: 1 },
    desc: '共演卡奖励多一个选项。',
  }),
  B({
    id: 'yuki', card: '12002001', owner: '丈枪 由纪', name: '无忧无虑', title: '没关系，明天还会来',
    cat: 'stage', rarity: 3, flags: ['revive'], mods: {},
    desc: '每场演出第一次受到致命伤时，以 1 点生命留下，并获得 1.5 秒无敌。',
  }),
  B({
    id: 'narumi', card: '27002001', owner: '关谷 鸣', name: '音波共鸣', title: '听见了吗？',
    cat: 'star', rarity: 3, mods: { reaction: .25, reactionRadius: .3 }, flags: ['reactionHeal'],
    desc: '属性反应伤害 +25%、范围 +30%；触发反应时回复 2 点生命。',
  }),
  B({
    id: 'tsumiki', card: '41002001', owner: '御庭 摘希', name: '猫爪', title: '一下就够了',
    cat: 'blade', rarity: 2, mods: { as: .1 }, flags: ['firstHit'],
    desc: '攻击速度 +10%；对满血敌人的第一次攻击伤害翻倍。',
  }),
  B({
    id: 'koharu-o', card: '43002001', owner: '小野坂 小春', name: '照顾人的手', title: '让我来帮你',
    cat: 'life', rarity: 2, mods: { heal: .18 }, flags: ['downedHeal'],
    desc: '受到的治疗 +18%；每次进入休息室时，倒下的演员以 35% 生命归队。',
  }),
  B({
    id: 'mayu', card: '42002001', owner: '篠华 茉优', name: '姐姐的掩护', title: '躲到我身后',
    cat: 'stage', rarity: 2, mods: {}, flags: ['switchShield12'],
    desc: '换演时为登场的演员提供 12 点护盾。',
  }),
  B({
    id: 'tamaki', card: '16002001', owner: '本田 珠辉', name: '精确射击', title: '瞄准，然后扣下扳机',
    cat: 'star', rarity: 1, mods: { ranged: .12, projectileSpeed: .25 },
    desc: '远程攻击伤害 +12%；弹道速度 +25%。',
  }),
  B({
    id: 'kotone', card: '45002001', owner: '風色 琴音', name: '伴奏', title: '我在这里',
    cat: 'stage', rarity: 2, mods: {}, flags: ['switchHeal4'],
    desc: '换演时为全队回复 4 点生命。',
  }),
  B({
    id: 'ino', card: '40002001', owner: '樱 衣乃', name: '制作人的眼光', title: '这个孩子会发光',
    cat: 'fortune', rarity: 2, mods: { rerollDiscount: .5 },
    desc: '商店刷新价格减半。',
  }),
  B({
    id: 'toru', card: '13002001', owner: '透', name: '沉默的拳头', title: '别说话，打',
    cat: 'blade', rarity: 3, mods: {}, flags: ['lowHpRage'],
    desc: '生命低于 35% 时，攻击力 +35%。',
  }),
  B({
    id: 'bocchi', card: '46002001', owner: '後藤 ひとり', name: '孤独摇滚', title: '一个人也要弹完',
    cat: 'star', rarity: 3, mods: { ultGain: .22, ultDmg: .18 },
    desc: '星辉获取 +22%；谢幕技伤害 +18%。',
  }),
  B({
    id: 'nadeshiko', card: '23012001', owner: '抚子【泳装】', name: '海滩假期', title: '偶尔也要休息',
    cat: 'life', rarity: 1, mods: { hp: 10, roomHeal: 5 },
    desc: '生命上限 +10；每场开演回复 5 点生命。',
  }),
];

export const BOON_MAP = Object.fromEntries(BOONS.map((b) => [b.id, b]));

export function emptyStats() {
  return {
    atk: 0, melee: 0, ranged: 0, crit: 0, critDmg: 0, as: 0, hp: 0,
    heal: 0, dmgTaken: 0, cdr: 0, ultGain: 0, applause: 0, styleDecay: 0,
    shards: 0, shop: 0, switchCdr: 0, switchDmg: 0, reaction: 0, markDur: 0,
    lifesteal: 0, dashDmg: 0, healOnKill: 0, critStar: 0, projectileSpeed: 0,
    reactionRadius: 0, waterReaction: 0, moonReaction: 0, ultDmg: 0,
    startShards: 0, dashCharge: 0, extraChoice: 0, rerollDiscount: 0,
    roomHeal: 0, roomShield: 0, dashCd: 0, firstHit: 0, lowHpRage: 0, revive: 0,
    flags: new Set(),
  };
}

export function computeStats(boons) {
  const s = emptyStats();
  for (const b of boons) {
    const m = b.mods || {};
    for (const k in m) {
      if (k in s && typeof s[k] === 'number') s[k] += m[k];
    }
    for (const f of b.flags || []) s.flags.add(f);
  }
  s.critDmg = 1.5 + s.critDmg;
  // 特定标志的数值化
  if (s.flags.has('roomShield15')) s.roomShield += 15;
  if (s.flags.has('switchShield12')) s.switchShield = 12;
  if (s.flags.has('critStar')) s.critStar = 1;
  if (s.flags.has('firstHit')) s.firstHit = 1;
  if (s.flags.has('lowHpRage')) s.lowHpRage = 1;
  if (s.flags.has('revive')) s.revive += 1;
  if (s.flags.has('extraChoice')) s.extraChoice += 1;
  return s;
}

export function rollBoonOptions(count, owned, rng) {
  const ownedIds = new Set(owned.map((b) => b.id));
  const pool = BOONS.filter((b) => !ownedIds.has(b.id));
  const weights = { 1: 58, 2: 32, 3: 10 };
  const out = [];
  const used = new Set();
  while (out.length < count && used.size < pool.length) {
    const avail = pool.filter((b) => !used.has(b.id));
    if (!avail.length) break;
    let total = 0;
    for (const b of avail) total += weights[b.rarity] || 1;
    let r = rng.next() * total;
    let chosen = avail[avail.length - 1];
    for (const b of avail) {
      r -= weights[b.rarity] || 1;
      if (r <= 0) { chosen = b; break; }
    }
    used.add(chosen.id);
    out.push(chosen);
  }
  return out;
}
