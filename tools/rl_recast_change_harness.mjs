import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSkills, decodeSkill } from '../site/game/rl/skills.js';
import { affixTableFromPassives, setAffixTable, passiveRuntime } from '../site/game/rl/equipment.js';
import { createWorld } from '../site/game/rl/world.js';
import { createDanmaku } from '../site/game/rl/danmaku.js';
import { makeGadget } from '../site/game/rl/gadgets.js';
import { PLAYER_TIMING } from '../site/game/rl/actorstate.js';
import { skillWords } from '../site/game/rl/ui/infocard.js';

const read = name => JSON.parse(readFileSync(new URL('../site/asset/rl/' + name, import.meta.url), 'utf8'));
const weapons = read('weapons-rl.json'), table = { ...read('skills-rl.json'), weaponChildren: weapons.childSkills };
const cards = read('cards-rl.json').cards, card = cards.find(c => c.id === 14002001);
const mod = { slot: 'amulet', rarity: 'rare', affixes: ['32032001'] };
setAffixTable(affixTableFromPassives(weapons.passives));
const decode = id => decodeSkill(table.weaponChildren[id] || table.player[id], id, .35, table.skillCards);
const fresh = () => { const s = createSkills({ table, card, maxHp: 1000 }); s.applyWeapon(passiveRuntime([mod])); return s; };
const change = (ratio, target = 0) => decodeSkill({ target, effects: [{ kind: 14, target, args: [ratio] }] }, 10, .35);
const near = (a, b) => assert(Math.abs(a - b) < 1e-7, a + ' != ' + b);
let checks = 0, failures = 0;
function test(label, fn) { checks++; try { fn(); console.log('PASS ' + label); }
    catch (error) { failures++; console.error('FAIL ' + label + ': ' + error.message); } }

test('真实320320013重复施放不叠加持续减免，本次自身每次11.2秒', () => {
    const s = fresh();
    for (let i = 0; i < 5; i++) {
        assert(s.use(2)); near(s.slots[2].remaining, 11.2);
        s.update(11.2); assert(s.ready(2));
    }
});
test('真实冷却格数向零取整：只缩短其他当前冷却，不改基础冷却/R', () => {
    const s = fresh(); s.slots[1].remaining = 10; s.addGauge(100);
    s.use(2); near(s.slots[1].remaining, 6.5); near(s.slots[1].cooldown, 10.5); near(s.gauge, 100);
    near(s.slots[2].remaining, 11.2);
});
test('立即变化不影响下一次初始冷却或储存给未冷却技能', () => {
    const s = fresh(); s.applySelf(decode(320320013));
    near(s.slots[1].remaining, 0); s.use(1); near(s.slots[1].remaining, 10.5);
    s.update(10.5); s.use(1); near(s.slots[1].remaining, 10.5);
});
test('直接效果可作用封印槽，缩减以基础格数而非剩余百分比计算', () => {
    const s = fresh(); s.applyGadgets({ sealedSlots: [2] }); s.slots[2].remaining = 5;
    s.applySelf(change(-.35)); near(s.slots[2].remaining, 1.15); assert(s.isSealed(2));
    s.applySelf(change(-.35)); near(s.slots[2].remaining, 0); assert(!s.ready(2));
});
test('0/正值/超额变化严格钳制，不产生永久负冷却', () => {
    const s = fresh(); s.slots[1].remaining = 5;
    s.applySelf(change(0)); near(s.slots[1].remaining, 5);
    s.applySelf(change(.35)); near(s.slots[1].remaining, 8.5);
    s.applySelf(change(100)); near(s.slots[1].remaining, 10.5);
    s.applySelf(change(-100)); near(s.slots[1].remaining, 0);
    s.use(1); near(s.slots[1].remaining, 10.5);
});
test('多个即时变化保留顺序和逐次钳制，不相加为持续系数', () => {
    const s = fresh(); s.slots[1].remaining = 1;
    const row = decodeSkill({ effects: [{kind:14,target:0,args:[-1]},{kind:14,target:0,args:[.5]}] }, 10, .35);
    s.applySelf(row); near(s.slots[1].remaining, 5.25);
});
test('敌方目标、缺失与非法参数不改玩家冷却，并明确未适配', () => {
    for (const effect of [{kind:14,target:2,args:[-.35]}, {kind:14,target:0,args:[]},
        {kind:14,target:0,args:[NaN]}, {kind:14,target:0,args:[-.35,1]}, {kind:14,target:9,args:[-.35]}]) {
        const row = decodeSkill({ effects:[effect] }, 10, .35), s = fresh();
        s.slots[1].remaining = 5; s.applySelf(row); near(s.slots[1].remaining, 5);
        assert(row.unhandled.includes(14)); assert(!row.usable);
    }
});
test('自身/单友方/全友方映射同一角色；所有发货自方kind14保留解码', () => {
    for (const target of [0,3,4]) {
        const s = fresh(); s.slots[1].remaining = 5; s.applySelf(change(-.35,target)); near(s.slots[1].remaining, 1.5);
    }
    for (const rows of [table.player, table.weaponChildren]) for (const [id,row] of Object.entries(rows)) {
        const own = row.effects.filter(e => e.kind === 14 && [0,3,4].includes(e.target) && e.args[0]);
        if (own.length) assert.equal(decode(Number(id)).recastChanges.length, own.length, id);
    }
});
test('即时变化与恢复速度正交，不重复乘速率', () => {
    const s = fresh(); s.slots[2].remaining = 10;
    s.buffs.push({spd:1,remaining:5}); s.applySelf(change(-.35));
    near(s.slots[2].remaining, 6.15); near(s.cooldownSeconds(2), 3.075);
    s.update(1); near(s.slots[2].remaining, 4.15);
});
test('无原始格数的合成技能按秒比例，有限输入才能执行', () => {
    const local = { player: {1:{name:'test',cooldown:[10],effects:[{kind:0,target:1,args:[500,0]}]}} };
    const s = createSkills({table:local,card:{class:0,skillIds:{class:[1]}},maxHp:1000});
    s.slots[0].remaining=7; s.applySelf(change(-.35)); near(s.slots[0].remaining,3.5);
});
test('说明区分即时缩减、恢复速度、本次技能与R', () => {
    const words = skillWords(decode(320320013)).join('；');
    assert(words.includes('立即缩短')); assert(words.includes('本次施放')); assert(words.includes('R'));
    assert(!words.includes('-35% 冷却'));
});

const truth = {hp:1000,atk:100,mgc:100,def:100,mdef:100,spd:100,luck:0};
function world(cls=0, equipped=[mod], selectedCard=card) {
    const w=createWorld({width:32,height:24,seed:42,tables:{skills:table,stats:{statsFor:()=>({...truth})}}});
    w.spawnPlayer({card:{...selectedCard,class:cls},x:12,y:12,equipment:equipped});
    w.inputState={move:{x:0,y:0},attack:false,dodge:false,skill:[false,false,false],ultimate:false};
    w.rng=()=>.99; return w;
}
const step=(w,t,dt=1/120)=>{for(let left=t;left>1e-10;left-=dt)w.update(Math.min(dt,left));};
const start=w=>{w.inputState.attack=true;step(w,1/120);w.inputState.attack=false;};
function foe(w,dx,dy=0) {
    const p=w.player,e=w.spawnEnemy({x:p.x+dx,y:p.y+dy,hp:100000,atk:0,mgc:0,def:100,mdef:100,
        element:p.element,aiType:'sentry'});
    e.actionTimer=1e9;return e;
}
function traceRecast(s) {
    const calls=[],apply=s.applyRecast;
    s.applyRecast=(effect,excluded=-1)=>{
        const before=s.slots.map(slot=>slot.remaining),result=apply(effect,excluded);
        if(effect?.recastChanges?.length)calls.push({id:effect.id,excluded,before,after:s.slots.map(slot=>slot.remaining)});
        return result;
    };
    return calls;
}
for (const cls of [0,1,2,3,4]) test('五职业空放普攻在出手边界缩短一次，不等命中 '+cls,()=>{
    const w=world(cls),s=w.player.skills; s.slots[2].remaining=10;
    start(w); step(w,.18-1/120); near(s.slots[2].remaining,10-.18-3.85);
    step(w,.2); near(s.slots[2].remaining,10-.38-3.85);
});
test('普攻前摇被打断不缩短冷却',()=>{
    const w=world(),s=w.player.skills; s.slots[2].remaining=10;
    start(w); w.player.sm.force('hit'); step(w,.18-1/120); near(s.slots[2].remaining,9.82);
});
test('远程弹池拒绝不付出射击冷却效果',()=>{
    const w=world(1),s=w.player.skills; s.slots[2].remaining=10;
    w.danmaku=createDanmaku({capacity:1});
    w.danmaku.emit('aimed',{x:1,y:1,angle:0},{side:'enemy',count:1,speed:0,life:5});
    start(w);step(w,.18-1/120); near(s.slots[2].remaining,9.82);
});
test('暂停期间不执行普攻即时缩减，恢复只提交一次',()=>{
    const w=world(),s=w.player.skills;s.slots[2].remaining=10;
    start(w);w.frozen=true;step(w,3);near(s.slots[2].remaining,10-1/120);
    w.frozen=false;step(w,.18-1/120);near(s.slots[2].remaining,10-.18-3.85);
});
test('普攻起手后换装使用原动作冷却效果快照',()=>{
    const w=world(),p=w.player;p.skills.slots[2].remaining=10;start(w);
    const item={slot:'amulet',rarity:'common',affixes:[]},drop={x:p.x,y:p.y,items:[item]};w.drops.push(drop);
    assert(w.takeDrop(drop,item)); const baseRecasts=table.player[card.skillIds.class[1]].recasts[0];
    step(w,.18-1/120);
    near(p.skills.slots[2].remaining,10-.18-Math.trunc(baseRecasts*.35)*.35);
});
test('未带词条的普攻起手后装备，不追溯赠送即时缩减',()=>{
    const w=world(0,[]),p=w.player;p.skills.slots[2].remaining=10;start(w);
    const drop={x:p.x,y:p.y,items:[mod]};w.drops.push(drop);assert(w.takeDrop(drop,mod));
    step(w,.18-1/120);near(p.skills.slots[2].remaining,9.82);
});
test('缚技/禁暴/无相契约不改即时冷却规则',()=>{
    for (const id of ['binding','steady','prism']) {
        const gadget=makeGadget(id,undefined,id==='binding'?2:undefined), w=world(0,[mod,gadget]);
        w.player.skills.slots[2].remaining=10;start(w);step(w,.18-1/120);
        near(w.player.skills.slots[2].remaining,10-.18-3.85);
    }
});
for (const cls of [0,1,2,3,4]) test('真实多目标挥击/贯穿/爆破不重复即时缩减 '+cls,()=>{
    const w=world(cls),p=w.player,s=p.skills,calls=traceRecast(s);
    const targets=cls===2?[foe(w,1.5),foe(w,2.7),foe(w,3.9)]
        :[foe(w,1.5),foe(w,1.5,cls===1||cls===4?.9:.2)];
    s.slots[2].remaining=10;start(w);step(w,.9-1/120);
    const hits=w.events.filter(e=>e.type==='hit'&&e.attacker===p);
    for(const target of targets)assert.equal(hits.filter(e=>e.target===target).length,1,'each real target hit exactly once');
    assert.equal(calls.length,1);near(calls[0].before[2]-calls[0].after[2],3.85);
    near(s.slots[2].remaining,10-w.time-3.85);
    if(cls===1||cls===4)assert.equal(w.events.filter(e=>e.type==='blast').length,1);
    if([1,2,4].includes(cls))assert.equal(w.events.find(e=>e.type==='playerShot').bullets,1);
});
test('在途普攻命中不重新缩减后来改变的冷却',()=>{
    const w=world(2),p=w.player,s=p.skills,calls=traceRecast(s),target=foe(w,7);
    s.slots[2].remaining=8;start(w);step(w,.18-1/120);
    assert.equal(w.events.filter(e=>e.type==='hit').length,0);assert.equal(calls.length,1);
    s.applySelf(change(.35));const before=s.slots[2].remaining,time=w.time;
    step(w,1);assert.equal(w.events.filter(e=>e.type==='hit'&&e.target===target).length,1);
    assert.equal(calls.length,2,'one launch plus the explicit test effect, never the later impact');
    near(s.slots[2].remaining,before-(w.time-time));
});
test('30/60/120步长均在有效窗口后缩减一次，不提前发生',()=>{
    for(const dt of [1/30,1/60,1/120]){
        const w=world(),s=w.player.skills,calls=traceRecast(s);s.slots[2].remaining=10;
        w.inputState.attack=true;step(w,dt,dt);w.inputState.attack=false;
        step(w,PLAYER_TIMING.attackHitStart-2*dt,dt);assert.equal(calls.length,0);
        step(w,3*dt,dt);assert.equal(calls.length,1);
        near(s.slots[2].remaining,10-w.time-3.85);
    }
});
test('技能已接收而弹池拒绝伤害时，自身冷却效果仍按一次施放提交',()=>{
    const w=world(),s=w.player.skills,calls=traceRecast(s);s.slots[2].remaining=10;
    w.danmaku=createDanmaku({capacity:1});
    w.danmaku.emit('aimed',{x:1,y:1,angle:0},{side:'enemy',count:1,speed:0,life:5});
    w.inputState.skill[1]=true;step(w,1/120);w.inputState.skill[1]=false;
    assert.equal(w.events.filter(e=>e.type==='skill').length,1);
    assert.equal(w.events.find(e=>e.type==='playerShot').bullets,0);
    assert.equal(calls.length,1);near(s.slots[1].remaining,10.5);
    near(s.slots[2].remaining,10-1/120-3.85);
    step(w,.5);assert.equal(calls.length,1);near(s.slots[2].remaining,10-w.time-3.85);
});
test('封印/未就绪/前一动作拒绝技能输入，不提交即时效果',()=>{
    for(const reason of ['sealed','cooldown','hit']){
        const w=world(),p=w.player,s=p.skills,calls=traceRecast(s);s.slots[2].remaining=10;
        if(reason==='sealed')s.applyGadgets({sealedSlots:[1]});
        if(reason==='cooldown')s.slots[1].remaining=5;
        if(reason==='hit')p.sm.force('hit');
        w.inputState.skill[1]=true;step(w,1/120);w.inputState.skill[1]=false;step(w,.5);
        assert.equal(w.events.filter(e=>e.type==='skill').length,0,reason);
        assert.equal(calls.length,0,reason);near(s.slots[2].remaining,10-w.time);
    }
});
test('暂停/死亡拒绝技能输入且不恢复或缩减冷却',()=>{
    for(const reason of ['frozen','dead']){
        const w=world(),p=w.player,s=p.skills,calls=traceRecast(s);s.slots[2].remaining=10;
        if(reason==='frozen')w.frozen=true;else {p.dead=true;p.sm.force('dead');}
        w.inputState.skill[1]=true;step(w,.5);
        assert.equal(calls.length,0);assert.equal(w.events.filter(e=>e.type==='skill').length,0);
        near(s.slots[2].remaining,10);
    }
});
test('真实莓香必杀多目标伤害后只缩减一次普通槽，不重写R量能',()=>{
    const selected=cards.find(c=>c.id===20002001),w=world(selected.class,[],selected),p=w.player,s=p.skills;
    const a=foe(w,2),b=foe(w,4);a.hp=1;
    const calls=traceRecast(s);s.slots.slice(1).forEach(slot=>slot.remaining=slot.cooldown);
    const before=s.slots.map(slot=>slot.remaining);s.addGauge(s.gaugeMax);
    assert.equal(w.useUltimate().id,200020010);assert(a.dead);assert(b.hp<100000);
    assert.equal(w.events.filter(e=>e.type==='hit'&&e.ultimate).length,2);
    assert.equal(calls.length,1);
    for(let i=1;i<s.slots.length;i++)near(s.slots[i].remaining,before[i]-Math.trunc(s.slots[i].recastUnits*.35)*.35);
    near(s.slots[0].remaining,0);near(s.gauge,0);
    const committed=s.slots.map(slot=>slot.remaining);assert.equal(w.useUltimate(),false);
    assert.deepEqual(s.slots.map(slot=>slot.remaining),committed);assert.equal(calls.length,1);
});
test('真实回复必杀无敌人也执行友方即时冷却，拒绝态不执行',()=>{
    const selected=cards.find(c=>c.id===20002021),w=world(selected.class,[],selected),p=w.player,s=p.skills;
    const calls=traceRecast(s);s.slots.slice(1).forEach(slot=>slot.remaining=slot.cooldown);
    const before=s.slots.map(slot=>slot.remaining);p.hp=300;s.addGauge(s.gaugeMax);
    w.frozen=true;assert.equal(w.useUltimate(),false);w.frozen=false;
    p.sm.force('hit');assert.equal(w.useUltimate(),false);p.sm.force('idle');
    p.dead=true;assert.equal(w.useUltimate(),false);p.dead=false;
    assert.equal(calls.length,0);near(s.gauge,s.gaugeMax);assert.deepEqual(s.slots.map(slot=>slot.remaining),before);
    assert.equal(w.useUltimate().id,200020210);assert(p.hp>300);assert.equal(calls.length,1);
    for(let i=1;i<s.slots.length;i++)near(s.slots[i].remaining,before[i]-Math.trunc(s.slots[i].recastUnits*.25)*.35);
    near(s.gauge,0);assert.equal(w.events.filter(e=>e.type==='hit').length,0);
});
console.log(checks+' checks, '+failures+' failures');
process.exitCode=failures?1:0;
