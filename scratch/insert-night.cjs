const fs = require('fs');
const p = 'site/etowaria-defense/data/campaign.js';
const lines = fs.readFileSync(p, 'utf8').split('\n');
const i = lines.findIndex(l => l.includes('"1-6"'));
let k = i;
while (!/help: "[^"]*" \},/.test(lines[k].replace(/\r$/, ''))) k++;
const insert = [
  '',
  '    {',
  '        id: "1-7", chapter: 1, theme: "night", title: "夜路没有应援", subtitle: "夜里不再掉落クリエ，学会自己产经济。',
  '        rows: 5, cols: 9, rowOffset: 0, colOffset: 0, startResource: 250,',
  '        naturalFirst: 999999, naturalPeriod: 999999, naturalAmount: 0, warningLead: 7,',
  '        waves: 4, estimate: "约4分钟", newEnemy: "E16", recommended: ["F01", "F11", "U01", "U12", "U03", "U19", "U15", "F10"],',
  '        story: [',
  '            { name: "千戶", text: "这条路晚上没有天然的クリエ……我带的储备采集台可以顶上！" },',
  '            { name: "兰普", text: "夜袭的客人脚程不慢。先把两台应援台放下，再谈别的。" }',
  '        ],',
  '        spawns: [spawn(26, 2, "E16"), spawn(42, 0), spawn(58, 4, "E02"),',
  '            ...series(76, 7, [1, 3, 0, 4, 2], ["E16", "E01", "E02", "E16", "E01"], 2),',
  '            ...series(118, 5, [3, 1, 4, 2, 0], ["E02", "E16", "E01", "E09", "E16"], 3),',
  '            ...series(158, 4, [2, 0, 4, 1, 3, 2], ["E16", "E09", "E01", "E02", "E16", "E04"], 4)],',
  '        objective: "夜里没有天然应援，靠采集台自己产经济，守住快脚步的夜袭。",',
  '        optional: "不消耗紧急结界", openingTip: "开局先放两台应援采集台；夜晚没有天降クリエ，所有经济都要自己产。"',
  '    },',
];
lines.splice(k + 1, 0, ...insert);
fs.writeFileSync(p, lines.join('\n'));
console.log('inserted after line', k + 1);
