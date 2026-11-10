import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Battle } from '../site/etowaria-defense/sim/battle.js';
import { LEVELS, UNIT_RULES, TICK, DECK_ORDER } from '../site/etowaria-defense/data/campaign.js';
import { COMPANIONS } from '../site/etowaria-defense/data/companions.js';

const fixture = { ...LEVELS[0], rows:3, cols:9, startResource:1000,
    spawns:[{at:1000,row:0,type:'E01',wave:1}] };
let checks=0;
const test=(name,run)=>{run();checks++;console.log('PASS '+name);};
test('five facilities have different captured original art and source records',()=>{
    const base=new URL('../site/etowaria-defense/assets/items/',import.meta.url);
    const sources=JSON.parse(fs.readFileSync(new URL('sources.json',base)));
    const hashes=['F01','F11','F13','F10','F12'].map(id=>{
        assert(sources[id]?.length); const png=fs.readFileSync(new URL(id+'.png',base));
        assert.equal(png.readUInt32BE(16),256);
        return createHash('sha256').update(png).digest('hex');
    });
    assert.equal(new Set(hashes).size,5);
});
for(const [id] of COMPANIONS) test(id+' repeatedly acts with finite combat state',()=>{
    assert(DECK_ORDER.includes(id));
    const rule=UNIT_RULES[id],b=new Battle(fixture,{deck:[id,'U12']});
    assert(b.deploy(id,1,3).ok);assert(b.deploy('U12',1,4).ok);b.start();
    const unit=[...b.units.values()].find(u=>u.type===id),guard=[...b.units.values()].find(u=>u.type==='U12');
    const enemy=b.spawn({type:'E01',row:1,x:4.1,wave:1,hpScale:1000});
    enemy.stunUntil=1000;const hp=enemy.hp;
    for(let i=0;i<1800;i++){
        if(rule.healing)guard.hp=guard.maxHp/2;
        b.step(TICK);
    }
    assert(Number.isFinite(unit.nextAction)&&Number.isFinite(unit.hp),id);
    if(rule.healing) assert(b.stats.healed>rule.healing*3,id);
    else {assert(unit.attacks>=5,id);assert(enemy.hp<hp,id);}
    if(rule.tempo){unit.attacks=1000;assert.equal(b.cadence(unit,1),1-rule.tempo.max);}
});
test('effective healing grants capped shields without reducing a stronger shield',()=>{
    const b=new Battle(fixture,{deck:['U105','U12']});b.deploy('U105',1,3);b.deploy('U12',1,4);b.start();
    const [healer,guard]=[...b.units.values()],action={kind:'heal',source:healer.id,target:guard.id};
    b.resolveAction(action);assert.equal(guard.shield,0);
    for(let i=0;i<10;i++){guard.hp-=60;b.resolveAction(action);}assert.equal(guard.shield,70);
    guard.shield=200;guard.hp-=60;b.resolveAction(action);assert.equal(guard.shield,200);
});
test('melee weakness and periodic critical coexist',()=>{
    const b=new Battle(fixture,{deck:['U117']});b.deploy('U117',1,3);b.start();
    const unit=[...b.units.values()][0],enemy=b.spawn({type:'E01',row:1,x:4,wave:1,hpScale:100});
    unit.attacks=3;unit.nextAction=0;b.updateUnit(unit);
    const action=b.pending.find(a=>a.source===unit.id);assert.equal(action.special.type,'critical');
    const hp=enemy.hp;b.resolveAction(action);assert.equal(hp-enemy.hp,77);assert.equal(enemy.vulnerable,.18);
});
test('weaker debuffs cannot extend stronger effects and equal strengths can refresh',()=>{
    const b=new Battle(fixture,{deck:['U01']});b.start();
    const enemy=b.spawn({type:'E01',row:1,x:5,wave:1,hpScale:1000});
    b.hitEnemy(enemy,1,'test',{onHit:{slow:.5,slowDuration:2,vulnerable:.4,vulnerableDuration:2,weaken:.4,weakenDuration:2,burn:10,burnDuration:2}});
    b.time=1;
    b.hitEnemy(enemy,1,'test',{onHit:{slow:.2,slowDuration:10,vulnerable:.2,vulnerableDuration:10,weaken:.2,weakenDuration:10,burn:3,burnDuration:10}});
    for(const key of ['slowUntil','vulnerableUntil','weakenUntil','burnUntil'])assert.equal(enemy[key],2);
    b.hitEnemy(enemy,1,'test',{onHit:{slow:.5,slowDuration:3}});assert.equal(enemy.slowUntil,4);
    b.time=4;
    b.hitEnemy(enemy,1,'test',{onHit:{slow:.2,slowDuration:3}});assert.equal(enemy.slowFactor,.2);assert.equal(enemy.slowUntil,7);
});
console.log(checks+' companion contracts passed');
