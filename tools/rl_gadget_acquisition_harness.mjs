import assert from 'node:assert/strict';
import * as gadgets from '../site/game/rl/gadgets.js';
import { rollLoot, setAffixPool } from '../site/game/rl/loot.js';
import { setAffixTable } from '../site/game/rl/equipment.js';
import { createRandom } from '../site/game/rl/random.js';
import { createWorld } from '../site/game/rl/world.js';
import { buildRunPayload, parseRunSnapshot } from '../site/game/rl/runschema.js';

setAffixPool(['a','b','c','d'], []);
setAffixTable({a:{mults:{atk:1.1}},b:{mults:{def:1.1}},c:{mults:{mgc:1.1}},d:{mults:{hp:1.1}}});
let total=0,failed=0;
function check(name,run){total++;try{run();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+e.stack);}}
const BASIC=['rhythm','strider','reach','wide','aim'];
const PRICE={rhythm:40,strider:45,reach:45,wide:40,aim:30,sentry:90,hunter:130,steady:120,prism:160,binding:180};
const ADVANCED=['sentry','hunter','steady','prism','binding'];
function batch(source,floor,count=12000){const rng=createRandom(81511+floor),out=[];
    for(let i=0;i<count;i++)out.push(...rollLoot(rng,floor,0,null,{source}));return out;}
const truth={hp:1000,atk:100,mgc:100,def:100,mdef:100,spd:100,luck:0};
const dungeon={start:0,boss:4,rooms:['start','shop','chest','rest','boss','battle'].map((type,id)=>
    ({id,type,seed:4421+id,doors:{},enemies:[]}))};
function fixture(floor=9){const w=createWorld({seed:992,floor,tables:{stats:{statsFor:()=>({...truth})},skills:{}}});
    w.spawnPlayer({card:{id:15000000,class:0,element:0},hp:1000});w.setDungeon(dungeon);w.coin=300;w.drainEvents();return w;}
function equip(w,item){const entry={x:w.player.x,y:w.player.y,items:[item]};w.drops.push(entry);assert.equal(w.takeDrop(entry,item),true);w.drainEvents();}
function snapshot(w){return JSON.stringify({coin:w.coin,hp:w.player.hp,equipment:w.player.equipment,claims:w.getRoomClaims(),events:w.events});}

check('机制固有品质与定价固定，旧品质仍可读取而不改能力',()=>{
    for(const id of [...BASIC,...ADVANCED]){const seal=id==='binding'?1:undefined;
        const row=gadgets.gadgetDefinition(gadgets.makeGadget(id,undefined,seal));
        assert.equal(row.price,PRICE[id]);assert.equal(row.rarity,BASIC.includes(id)?'rare':'epic');
        assert.equal(gadgets.makeGadget(id,undefined,seal).rarity,row.rarity);
        assert.deepEqual(gadgets.gadgetRuntime([gadgets.makeGadget(id,'common',seal)]),gadgets.gadgetRuntime([gadgets.makeGadget(id,'legendary',seal)]));}
});
check('普通敌人不再按词条哈希改造成机制',()=>{for(const floor of [1,5,9,20])assert.ok(batch('enemy',floor).every(i=>!i.gadgetId));});
check('宝箱保底稀有，基础机制45%，高级机关不混入',()=>{const items=batch('chest',1),count=items.filter(i=>i.gadgetId).length;
    assert.equal(items.length,12000);assert.ok(items.every(i=>i.rarity!=='common'));
    assert.ok(Math.abs(count/12000-.45)<.02);assert.ok(items.filter(i=>i.gadgetId).every(i=>BASIC.includes(i.gadgetId)));
    assert.deepEqual([...new Set(items.filter(i=>i.gadgetId).map(i=>i.gadgetId))].sort(),BASIC.slice().sort());
});
check('精英独立35%机制渠道，守望按第五层开放',()=>{for(const floor of [4,5,9]){const items=batch('elite',floor),mechanics=items.filter(i=>i.gadgetId);
    assert.equal(items.length,12000);assert.ok(items.every(i=>i.rarity!=='common'));assert.ok(Math.abs(mechanics.length/12000-.35)<.02);
    assert.equal(mechanics.some(i=>i.gadgetId==='sentry'),floor>=5);assert.ok(!mechanics.some(i=>i.gadgetId==='hunter'));}});
check('守卫和首領按25%/40%开放高级机制，其余为武器，绝无普通品质',()=>{
    for(const [source,chance] of [['guardian',.25],['boss',.4]])for(const floor of [4,5,8,9,20]){
        const items=batch(source,floor);assert.equal(items.length,12000);const gear=items.filter(i=>i.gadgetId);
        assert.ok(Math.abs(gear.length/12000-(floor<5?0:chance))<.02);
        assert.ok(items.every(i=>i.gadgetId?ADVANCED.includes(i.gadgetId):i.slot==='weapon'));
        assert.equal(gear.some(i=>i.gadgetId==='hunter'),floor>=9);
        assert.equal(gear.some(i=>i.gadgetId==='steady'),floor>=9);
        for(const id of ['prism','binding'])assert.equal(gear.some(i=>i.gadgetId===id),floor>=13);
        assert.ok(items.every(i=>source==='boss'?['epic','legendary'].includes(i.rarity):i.rarity!=='common'));
    }
});
check('未知来源拒绝；相同种子同来源确定，不使用装备词条哈希',()=>{
    assert.throws(()=>rollLoot(createRandom(1),1,0,null,{source:'typo'}));
    assert.throws(()=>gadgets.rollGadget(createRandom(1),'__proto__',9));
    assert.deepEqual(batch('elite',9,200),batch('elite',9,200));assert.notDeepEqual(batch('chest',9,200),batch('guardian',9,200));
});
check('真实死亡管线区分普通敌/精英/守卫/首领，清层和重返不再追加奖励',()=>{
    for(const source of ['enemy','elite','guardian','boss'])for(let seed=0;seed<24;seed++){
        const w=fixture(9);w.rng=createRandom(seed+2401);const room=source==='enemy'||source==='elite'?5:4;
        w.enterRoom(room);w.player.x=3;w.player.y=3;
        const target=w.spawnEnemy({x:16,y:12,hp:1,aiType:source==='boss'?'boss':'sentry',elite:source==='elite'||source==='guardian'});
        target.actionTimer=1e9;w.drainEvents();
        w.danmaku.emit('aimed',{x:15,y:12,angle:0},{side:'player',power:99999999,coef:1,count:1,speed:10,life:3});
        for(let i=0;i<60&&!target.dead;i++)w.update(1/60);
        assert.equal(target.dead,true);const items=w.drops.flatMap(d=>d.items);
        if(source!=='enemy')assert.equal(items.length,1);else assert.ok(items.every(i=>!i.gadgetId));
        if(source==='guardian'||source==='boss')assert.ok(items.every(i=>i.gadgetId?['sentry','hunter','steady'].includes(i.gadgetId):i.slot==='weapon'));
        const before=JSON.stringify(items),coin=w.coin;for(let i=0;i<120;i++)w.update(1/60);
        assert.equal(w.floor,9);assert.equal(w.player.equipment.length,0);assert.equal(JSON.stringify(w.drops.flatMap(d=>d.items)),before);
        w.enterRoom(0);w.enterRoom(room);assert.equal(w.coin,coin);assert.equal(JSON.stringify(w.drops.flatMap(d=>d.items)),before);
    }
});
check('主动开宝箱才发对应渠道的一件奖励，不能重开重领',()=>{
    for(let seed=0;seed<30;seed++){const w=fixture(1);w.rng=createRandom(seed);w.enterRoom(2);
        assert.equal(w.drops.length,0);assert.ok(w.openChest());assert.equal(w.drops.length,1);
        const item=w.drops[0].items[0];assert.notEqual(item.rarity,'common');assert.ok(!item.gadgetId||BASIC.includes(item.gadgetId));
        assert.equal(w.openChest(),null);assert.equal(w.drops.length,1);
    }
});
check('商店三货位有明确分工，机制按身份收费和层数开放',()=>{
    for(const floor of [1,4,5,8,9,20]){const found=new Set();for(let seed=0;seed<100;seed++){
        const w=fixture(floor);w.dungeon.rooms[1].seed=seed;w.enterRoom(1);const rows=w.getShopOffer();
        assert.equal(rows.length,3);assert.equal(rows[0].item.slot,'weapon');assert.ok(!rows[0].item.gadgetId);
        assert.ok(rows[1].item.slot!=='weapon'&&!rows[1].item.gadgetId);
        assert.ok(rows[2].item.gadgetId);assert.equal(rows[2].price,PRICE[rows[2].item.gadgetId]);found.add(rows[2].item.gadgetId);
    }assert.equal(found.has('sentry'),floor>=5);assert.equal(found.has('hunter'),floor>=9);}
});
check('旧库存和价格从消费记录恢复，不按新渠道重抽',()=>{
    const w=fixture();w.enterRoom(1);const offer=w.getShopOffer();offer[2]={item:gadgets.makeGadget('hunter','common'),price:17,bought:false};
    const claims=w.getRoomClaims(),restored=fixture(1);restored.setDungeon(dungeon,claims);restored.enterRoom(1);
    assert.deepEqual(restored.getShopOffer(),offer);
});
check('同机制不同旧品质不重复收费，另一机制仍可购买',()=>{
    const w=fixture();w.enterRoom(1);equip(w,gadgets.makeGadget('hunter','common'));
    const entry=w.getShopOffer()[2];entry.item=gadgets.makeGadget('hunter','legendary');entry.price=130;
    const before=snapshot(w);assert.equal(w.getShopQuote(2).enabled,false);assert.match(w.getShopQuote(2).reason,/同一机制/);
    assert.equal(w.buyShopItem(2,entry.item),null);assert.equal(snapshot(w),before);
    entry.item=gadgets.makeGadget('sentry');assert.equal(w.getShopQuote(2).enabled,true);assert.ok(w.buyShopItem(2,entry.item));
});
check('商店保存拒绝和抛错不扣钱不换装，重试只提交一次',()=>{
    const w=fixture();w.enterRoom(1);const entry=w.getShopOffer()[2],before=snapshot(w);let writes=0;
    const reject=patch=>{writes++;assert.equal(snapshot(w),before);assert.equal(patch.coin,300-entry.price);
        assert.ok(patch.equipment.some(i=>i===entry.item));assert.equal(patch.roomClaims.find(c=>c.id===1).offer[2].bought,true);return false;};
    assert.equal(w.buyShopItem(2,entry.item,reject),null);assert.equal(snapshot(w),before);
    assert.equal(w.buyShopItem(2,entry.item,()=>{throw Error('disk');}),null);assert.equal(snapshot(w),before);
    assert.ok(w.buyShopItem(2,entry.item,patch=>{writes++;assert.equal(snapshot(w),before);return true;}));
    assert.equal(w.coin,300-entry.price);assert.equal(entry.bought,true);
    assert.equal(w.buyShopItem(2,entry.item,()=>{writes++;return true;}),null);assert.equal(writes,2);
});
check('商店报价纯读取，过期物品、换房、死亡与无效价格均拒绝',()=>{
    const w=fixture();w.enterRoom(1);const entry=w.getShopOffer()[2],before=snapshot(w);
    for(let i=0;i<10;i++)w.getShopQuote(2);assert.equal(snapshot(w),before);
    assert.equal(w.buyShopItem(2,{...entry.item}),null);assert.equal(snapshot(w),before);
    w.transition={};assert.equal(w.buyShopItem(2,entry.item),null);w.transition=null;
    entry.price=NaN;assert.equal(w.buyShopItem(2,entry.item),null);entry.price=1;
    w.player.dead=true;assert.equal(w.buyShopItem(2,entry.item),null);w.player.dead=false;
    w.enterRoom(0);assert.equal(w.buyShopItem(2,entry.item),null);
});
check('营地明确未开放条件，同效选项禁用，取消报价不消耗随机流',()=>{
    const early=fixture(4);early.enterRoom(3);const locked=early.getSupplyOffer().options.find(o=>o.id==='commission');
    assert.equal(locked.enabled,false);assert.match(locked.reason,/5/);assert.equal(early.chooseSupply('commission',3),null);
    const w=fixture(9);w.enterRoom(3);const item=w.getSupplyOffer().options.find(o=>o.id==='commission').item;
    equip(w,{...item,rarity:'legendary'});const before=snapshot(w);let rngCalls=0;w.rng=()=>{rngCalls++;return .5;};
    const option=w.getSupplyOffer().options.find(o=>o.id==='commission');assert.equal(option.enabled,false);assert.match(option.reason,/同一机制/);
    assert.equal(w.chooseSupply('commission',3),null);assert.equal(snapshot(w),before);assert.equal(rngCalls,0);
});
check('营地免费调校也不消耗同效机会；祭坛誓约不重复扣血',()=>{
    const w=fixture();w.enterRoom(3);const tune=w.getSupplyOffer().options.find(o=>o.id==='tune');equip(w,tune.item);
    const before=snapshot(w);assert.equal(w.chooseSupply('tune',3),null);assert.equal(snapshot(w),before);
    w.enterRoom(5);assert.equal(w.roomLocked,false);w.altar={x:16,y:12,used:false};
    const oath=w.getAltarOffer().options.find(o=>o.id==='oath');equip(w,{...oath.item,rarity:'common'});
    const altarBefore=snapshot(w);assert.equal(w.useAltar('oath',5),null);assert.equal(snapshot(w),altarBefore);
});
check('不同机制事件保持先保存后提交，物品/资源/消费记录一起续档',()=>{
    const w=fixture();w.enterRoom(3);const row=w.getSupplyOffer().options.find(o=>o.id==='commission'),before=snapshot(w);
    assert.equal(row.enabled,true);assert.equal(row.coinCost,Math.ceil(PRICE[row.item.gadgetId]*.6));
    assert.equal(w.chooseSupply('commission',3,()=>false),null);assert.equal(snapshot(w),before);
    let patch;assert.ok(w.chooseSupply('commission',3,p=>{patch=p;assert.equal(snapshot(w),before);return true;}));
    const saved=buildRunPayload({schemaVersion:3,seed:992,volume:1,floor:9,cardId:15000000,level:1,hp:1000,...patch});
    assert.ok(parseRunSnapshot(saved,20));assert.equal(saved.coin,w.coin);assert.deepEqual(saved.equipment,w.player.equipment);
    assert.ok(saved.roomClaims.find(c=>c.id===3).rested);assert.equal(w.chooseSupply('commission',3),null);
});
console.log(total+' checks, '+failed+' failures');process.exitCode=failed?1:0;
