import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createWorld} from '../site/game/rl/world.js';
import {makeGadget, GADGETS, rollAccessory} from '../site/game/rl/gadgets.js';
import {setAffixTable,calculateLoadout} from '../site/game/rl/equipment.js';
import {buildRunPayload,parseRunSnapshot} from '../site/game/rl/runschema.js';
setAffixTable({stack:{special:[{type:0,trigger:2,args:[0,10,0,0]}]}});
const base={hp:1000,atk:100,mgc:100,def:100,mdef:100,spd:100,luck:0};
const fixture=()=>{
 const w=createWorld({seed:31,tables:{stats:{statsFor:()=>({...base})}}});
 w.spawnPlayer({card:{id:1,class:0,element:0},x:4,y:12});
 w.inputState={move:{x:0,y:0},attack:false,dodge:false,skill:[false,false,false],ultimate:false,assist:false};
 return w;
};
function equip(w,item,commit){const d={x:w.player.x,y:w.player.y,items:[item]};w.drops.push(d);return w.takeDrop(d,item,commit);}
let checks=0;const test=(label,run)=>{run();checks++;console.log('PASS '+label);};
test('all nine treasures have a stable slot, tier and illustration',()=>{
 assert.equal(GADGETS.filter(r=>r.relic).length,9);
 for(const slot of ['armor','amulet','charm'])for(const rarity of ['common','rare','epic','legendary']){
  const item=rollAccessory(()=>.5,slot,rarity);assert.equal(item.slot,slot);assert.equal(item.affixes.length,0);
  assert.equal(item.rarity,rarity==='legendary'?'epic':rarity);
  assert(fs.readFileSync(new URL('../site/asset/img/rl/equipment/gadget-'+item.gadgetId+'.svg',import.meta.url),'utf8').includes('<svg'));
 }
});
test('health gear scales wounded health and cannot be cycled into free healing',()=>{
 const w=fixture(),p=w.player;p.hp=400;
 assert(equip(w,makeGadget('bloom')));assert.equal(p.maxHp,1250);assert.equal(p.hp,500);
 for(let i=0;i<50;i++){
  assert(equip(w,makeGadget('cotton')));assert(equip(w,makeGadget('bloom')));
 }
 assert(p.hp<=500&&p.hp>0);assert.equal(p.base.atk,95);assert.equal(p.base.def,108);
});
test('one remaining health survives lower-health gear without a healing loop',()=>{
 const w=fixture(),p=w.player;
 assert(equip(w,makeGadget('bloom')));p.hp=1;
 for(let i=0;i<50;i++){
  for(const id of ['cotton','bloom']){
   let savedHp;
   assert(equip(w,makeGadget(id),next=>{savedHp=next.hp;return true;}));
   assert.equal(p.hp,1);assert.equal(savedHp,1);assert(!p.dead);
  }
 }
});
test('rejected health-gear save cannot modify health or gear',()=>{
 const w=fixture();w.player.hp=400;const before=JSON.stringify([w.player.hp,w.player.maxHp,w.player.equipment]);
 assert.equal(equip(w,makeGadget('bloom'),()=>false),false);
 assert.equal(JSON.stringify([w.player.hp,w.player.maxHp,w.player.equipment]),before);
});
test('fixed crit, gauge and leech reach the same preview and live calculation',()=>{
 for(const id of ['ribbon','leaf','bell','edge','moon','solstice']){
  const w=fixture(),item=makeGadget(id),preview=w.previewEquipment(item);assert(preview);
  assert(equip(w,item));assert.deepEqual(w.player.base,preview.candidate);
  assert.deepEqual(w.player.passives,preview.passives.candidate);
  if(id==='ribbon')assert.equal(w.player.base.critChance,.04);
  if(id==='bell')assert.equal(w.player.passives.gaugeMult,1.3);
  if(id==='moon')assert.equal(w.player.passives.lifesteal,.035);
  if(id==='solstice'){assert.equal(w.player.maxHp,900);assert.equal(w.player.base.critChance,.14);}
 }
});
test('rate gear improves sustained attacks while preserving distinct costs',()=>{
 const swings=id=>{const w=fixture();equip(w,makeGadget(id));w.inputState.attack=true;
  for(let i=0;i<600;i++)w.update(1/60);return w.player.swingId*w.player.gadgets.normalDamage;};
 const neutral=swings('ribbon');assert(swings('rhythm')>neutral);assert(swings('comet')>swings('rhythm'));
});
test('each source of kill stacks stops at +100%, preview cannot inflate it',()=>{
 const item={slot:'weapon',rarity:'rare',affixes:['stack']};
 assert.equal(calculateLoadout(base,[item],{stackKills:5}).stats.mgc,150);
 assert.equal(calculateLoadout(base,[item],{stackKills:99999}).stats.mgc,200);
});
test('treasures round-trip through the existing schema without extra derived fields',()=>{
 const equipment=['petal','moon','solstice'].map(id=>makeGadget(id));
 const saved=buildRunPayload({schemaVersion:3,seed:31,volume:1,floor:1,cardId:1,level:1,hp:400,equipment,roomClaims:[]});
 assert.deepEqual(parseRunSnapshot(saved,20).equipment,equipment);
});
console.log(checks+' treasure contracts passed');
