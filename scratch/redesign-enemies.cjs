const fs = require('fs');
const p = 'site/etowaria-defense/data/campaign.js';
const lines = fs.readFileSync(p, 'utf8').split('\n');
const e7 = lines.findIndex(l => l.includes('E07: { id: "E07"'));
lines[e7] = '    E07: { id: "E07", resourceId: 11100, name: "魔偶", hp: 420, armor: 300, speed: .13, threat: 4, rockArmor: { regenPerSec: 60, delay: 3 },';
lines[e7 + 1] = '        damage: 32, period: 1.5, windup: .4, height: 1.02, description: "身披300点护甲；3秒不被打就会自动修补（原作「ロックアーマー」）。玛莉·梦魔能直接击碎护甲。" },';
const e9 = lines.findIndex(l => l.includes('E09: { id: "E09"'));
lines[e9] = lines[e9].replace('threat: 2,', 'threat: 2, battleCry: { once: true, haste: .2, duration: 5, reach: 2 },');
lines[e9 + 1] = lines[e9 + 1].replace('description: "奔跑极快，常在防线还没建好时冲到面前。"', 'description: "第一次望见同伴时嗥叫「バトルクライ」（原作技能），周围两格的来客提速20%持续5秒；本身也跑得极快。"');
const e38 = lines.findIndex(l => l.includes('E38: { id: "E38"'));
lines[e38] = lines[e38].replace('armor: 80,', 'armor: 80, roar: { period: 8, delay: 1 },');
let e38desc = -1;
for (let i = e38 + 1; i < e38 + 4; i++) { if (lines[i] && lines[i].includes('description:')) { e38desc = i; break; } }
lines[e38desc] = lines[e38desc].replace(/description: "[^"]*"/, 'description: "全副武装的小熊兵。每8秒低吼「クッマッマー」（原作技能），推迟相邻两路同伴的下一次出手1秒。"');
fs.writeFileSync(p, lines.join('\n'));
console.log('E7 at', e7 + 1, 'E9 at', e9 + 1, 'E38 at', e38 + 1, 'E38 desc at', e38desc + 1);
