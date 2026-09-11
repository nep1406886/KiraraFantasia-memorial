import assert from 'node:assert/strict';
import { createWorld } from '../site/game/rl/world.js';
import { GADGETS, makeGadget, gadgetDefinition, gadgetRuntime } from '../site/game/rl/gadgets.js';
import { applyEquipment, setAffixTable } from '../site/game/rl/equipment.js';
import { findAttackPath, clearPath } from '../site/game/rl/assistance.js';
import { parseRunSnapshot, RUN_SCHEMA_VERSION, RUN_GENERATOR_VERSION } from '../site/game/rl/runschema.js';
import { circleOverlapsRect } from '../site/game/rl/geometry.js';
import { normalEffectConfig } from '../site/game/rl/view/effectcatalog.js';

let checks=0,failures=0;
function check(name,run){checks++;try{run();console.log('PASS '+name);}catch(e){failures++;console.error('FAIL '+name+': '+e.message);}}
setAffixTable({});
function fixture(id,cls=0){
    const w=createWorld({seed:31,width:32,height:24});
    const p=w.spawnPlayer({card:{id:1,class:cls,element:0},hp:100,atk:100,def:100,x:4,y:12,equipment:id?[makeGadget(id)]:[]});
    w.inputState={move:{x:0,y:0},attack:false,dodge:false,skill:[false,false,false],ultimate:false,assist:false};
    return {w,p,input:w.inputState};
}
function tick(w,seconds){for(let i=0;i<Math.round(seconds*60);i++)w.update(1/60);}
function enemy(w,x,y){const e=w.spawnEnemy({x,y,hp:100000,atk:0,def:0});e.actionTimer=1e9;return e;}
function equip(w,item){const d={x:w.player.x,y:w.player.y,items:[item]};w.drops.push(d);assert.equal(w.takeDrop(d,item),true);}

check('十类机制有明确收益/代价且不伪造原作被动',()=>{assert.equal(GADGETS.length,10);for(const row of GADGETS){assert.ok(row.benefit&&row.cost);assert.equal(gadgetDefinition(makeGadget(row.id,undefined,row.sealSkill?1:undefined)).id,row.id);}});
check('未知机制/混装专武/错槽/额外词条拒绝',()=>{for(const item of [{...makeGadget('aim'),gadgetId:'__proto__'},{...makeGadget('aim'),slot:'weapon'},{...makeGadget('aim'),catalogId:1},{...makeGadget('aim'),affixes:['1']}])assert.throws(()=>gadgetDefinition(item));});
check('自动化代价参与真实面板，重复重算不累乘',()=>{const base={hp:100,atk:100,mgc:100,def:100,mdef:100,luck:0};for(let i=0;i<100;i++){const s=applyEquipment(base,[makeGadget('hunter')]);assert.equal(s.atk,75);assert.equal(s.def,80);}assert.deepEqual(base,{hp:100,atk:100,mgc:100,def:100,mdef:100,luck:0});});
check('射程增加25%，判定宽度不会跟着增加',()=>{for(const cls of [0,1,2,3,4]){const a=fixture(null,cls).p.weaponProfile,b=fixture('reach',cls).p.weaponProfile;assert.equal(b.range,a.range*1.25);assert.equal(b.radius,a.radius);assert.equal(b.width,a.width);}});
check('判定增加30%，射程保持原样',()=>{for(const cls of [0,1,2,3,4]){const a=fixture(null,cls).p.weaponProfile,b=fixture('wide',cls).p.weaponProfile;assert.equal(b.range,a.range);const key=cls===0?'arc':cls===3?'width':'radius';assert.equal(b[key],a[key]*1.3);}});
check('轻击腕带提高实际普攻节拍',()=>{const a=fixture(),b=fixture('rhythm');a.input.attack=b.input.attack=true;tick(a.w,6);tick(b.w,6);assert.ok(b.p.swingId>=a.p.swingId*1.14,{base:a.p.swingId,fast:b.p.swingId});});
check('游走护符只允许普攻中走位且保持挥击方向',()=>{const a=fixture(),b=fixture('strider');for(const f of [a,b]){f.input.attack=true;f.w.update(1/60);f.input.attack=false;f.input.move.y=1;tick(f.w,.15);}assert.equal(a.p.y,12);assert.ok(b.p.y>12.2&&b.p.y<12.4);assert.equal(b.p.facing,0);});
check('普通攻击代价不被绕过，挥击一次仅一次命中',()=>{const f=fixture('wide'),e=enemy(f.w,5,12);f.input.attack=true;f.w.update(1/60);f.input.attack=false;tick(f.w,.3);const hits=f.w.events.filter(e=>e.type==='hit'&&e.attacker===f.p);assert.equal(hits.length,1);assert.equal(hits[0].damage,88);});
check('真实拾取、替换后机制无残留',()=>{const f=fixture();equip(f.w,makeGadget('reach'));assert.equal(f.p.weaponProfile.range,2.625);equip(f.w,{slot:'amulet',rarity:'common',affixes:[]});assert.equal(f.p.weaponProfile.range,2.1);assert.equal(f.p.def,100);});
check('瞄准饰章只在无手动朝向时对准敌人',()=>{const f=fixture('aim');enemy(f.w,4,13.5);f.input.attack=true;f.w.update(1/60);assert.ok(Math.abs(f.p.facing-Math.PI/2)<1e-6);const manual=fixture('aim');enemy(manual.w,4,13.5);manual.w.aim={x:8,y:12};manual.input.attack=true;manual.w.update(1/60);assert.equal(manual.p.facing,0);});
check('守望机关必须显式开启，不自动移动或施放技能',()=>{const f=fixture('sentry');enemy(f.w,5.4,12);tick(f.w,1);assert.equal(f.p.swingId,0);f.input.assist=true;f.w.update(1/60);f.input.assist=false;tick(f.w,1);assert.ok(f.p.swingId>0);assert.equal(f.p.x,4);assert.ok(!f.w.events.some(e=>e.type==='skill'||e.type==='ultimate'));});
check('自动化中手动走位优先，暂停无输入污染',()=>{const f=fixture('hunter');enemy(f.w,22,12);f.input.assist=true;f.w.update(1/60);f.input.assist=false;tick(f.w,.8);assert.ok(f.p.x>4);f.input.move.x=-1;const x=f.p.x;tick(f.w,.15);assert.ok(f.p.x<x);assert.equal(f.input.attack,false);f.w.frozen=true;const pos=[f.p.x,f.p.y];tick(f.w,1);assert.deepEqual([f.p.x,f.p.y],pos);assert.equal(f.input.move.x,-1);});
check('寻路绕障碍且每段能通过角色半径，预算有限',()=>{const f=fixture('hunter'),e=enemy(f.w,13,12);f.w.roomColliders=[{x:8,y:12,hw:.4,hh:3}];const result=findAttackPath(f.w,f.p,e);assert.ok(result.points.length>10);assert.ok(result.visited<=4096);let prev=f.p;for(const at of result.points){assert.ok(clearPath(f.w,prev,at,f.p.radius));assert.ok(!f.w.roomColliders.some(b=>circleOverlapsRect(at.x,at.y,f.p.radius,b)));prev=at;}const wall=f.w.roomColliders[0];assert.ok(result.points.some(p=>p.y<wall.y-wall.hh-f.p.radius||p.y>wall.y+wall.hh+f.p.radius));});
check('封死路线不会穿墙、瞬移或越界',()=>{const f=fixture('hunter'),e=enemy(f.w,13,12);f.w.roomColliders=[{x:8,y:12,hw:.5,hh:12}];assert.equal(findAttackPath(f.w,f.p,e).points.length,0);f.input.assist=true;f.w.update(1/60);f.input.assist=false;tick(f.w,1);assert.equal(f.p.x,4);});
check('移除自动化装备立即关闭，后续没有残留攻击',()=>{const f=fixture('sentry');enemy(f.w,5.4,12);f.input.assist=true;f.w.update(1/60);f.input.assist=false;tick(f.w,.6);equip(f.w,{slot:'armor',rarity:'common',affixes:[]});const count=f.p.swingId;tick(f.w,1);assert.equal(f.p.swingId,count);assert.equal(f.w.assistance?.enabled,false);});
check('机制装备续档保留ID，伪造ID与错槽拒绝',()=>{const raw={schemaVersion:RUN_SCHEMA_VERSION,generatorVersion:RUN_GENERATOR_VERSION,seed:7,volume:1,floor:1,cardId:1,level:1,hp:100,equipment:[makeGadget('hunter')],roomClaims:[]};assert.equal(parseRunSnapshot(raw,20).equipment[0].gadgetId,'hunter');assert.equal(parseRunSnapshot({...raw,equipment:[{...makeGadget('hunter'),gadgetId:'unknown'}]},20),null);});
check('原作普攻特效随本次挥击快照缩放和加速，卸装不改变在途效果',()=>{
    const p=fixture('reach').p;p.swingGadgets={...p.gadgets,rate:1.2,width:1.3};p.swingProfile=p.weaponProfile;
    p.gadgets=gadgetRuntime([]);const c=normalEffectConfig(p);assert.equal(c.duration,.25/1.2);
    assert.equal(c.stretchX,1.25);assert.equal(c.stretchY,1.25*1.3);
    p.swingProfile={kind:'thrust'};assert.equal(normalEffectConfig(p).stretchY,1.3);
});
check('最近敌人不可达时选择另一可达目标，不隔墙锁死',()=>{
    const f=fixture('hunter');f.w.roomColliders=[{x:8,y:12,hw:.5,hh:12}];
    const blocked=enemy(f.w,10,12),accessible=enemy(f.w,4,21);
    const result=findAttackPath(f.w,f.p,[blocked,accessible]);assert.equal(result.target,accessible);
    assert.ok(result.points.length>0&&result.visited<=4096);
});
check('关闭高阶自动化后普通攻击保持手动方向',()=>{
    const f=fixture('hunter');enemy(f.w,4,13.5);f.input.attack=true;f.w.update(1/60);assert.equal(f.p.facing,0);
});
console.log(checks+' checks, '+failures+' failures');process.exitCode=failures?1:0;
