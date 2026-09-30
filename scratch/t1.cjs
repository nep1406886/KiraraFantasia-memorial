const { Battle } = await import('./site/etowaria-defense/sim/battle.js');
const battle = new Battle({id:'1-1',chapter:1,theme:'day',title:'t',subtitle:'s',rows:3,cols:9,rowOffset:0,colOffset:0,startResource:1000,naturalFirst:8,naturalPeriod:16,naturalAmount:25,warningLead:6,waves:3,spawns:[],endless:false},{deck:['U01','G34']});
const r1 = battle.deploy('U01',0,1);
console.log('units:',battle.units.size);
