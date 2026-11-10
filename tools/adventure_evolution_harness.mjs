import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyEvolution, earnEvolution, evolveCandidate, evolutionQuote, EVOLUTION_ITEMS } from '../site/core/evolution.js';
import { Battle } from '../site/etowaria-defense/sim/battle.js';
import { LEVELS, ENDLESS, UNIT_RULES } from '../site/etowaria-defense/data/campaign.js';
import { CampaignSave, validateProgress } from '../site/etowaria-defense/app/campaign-save.js';
import * as save from '../site/game/rl/save.js';
import { createMeta, mergeState, pagesForVolume, FINALE_PAGES } from '../site/game/rl/meta.js';
import { createProfileValidator } from '../site/game/rl/profileschema.js';
import { createStats } from '../site/asset/rl/stats.js';
import { ACHIEVEMENTS } from '../site/game/rl/achievements.js';
import { PLAYABLE_ROSTER } from '../site/game/rl/rosterids.js';
import { RUN_GENERATOR_VERSION } from '../site/game/rl/runschema.js';
import { createWorld } from '../site/game/rl/world.js';
import { setAffixTable, affixTableFromPassives, calculateLoadout } from '../site/game/rl/equipment.js';
import { setWeaponCatalog } from '../site/game/rl/weaponcatalog.js';

const read = path => JSON.parse(readFileSync(new URL('../site/' + path, import.meta.url), 'utf8'));
const catalogue = read('etowaria-defense/data/units.json');
const weapons = read('asset/rl/weapons-rl.json');
const stats = createStats({cards:read('asset/rl/cards-rl.json').cards,growth:read('asset/rl/growth.json'),enemies:read('asset/rl/enemies.json').enemies});
const validate = createProfileValidator({stats,weapons,mergeMeta:mergeState,
    pageIds:[1,2,3,4,5].flatMap(pagesForVolume).concat(FINALE_PAGES),achievementIds:ACHIEVEMENTS.map(row=>row.id)});
save.setImportValidator(validate);
setWeaponCatalog(weapons.catalog);
setAffixTable(affixTableFromPassives(weapons.passives));
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
function storage(){const memory=new Map();return {memory,fail:false,getItem:key=>memory.get(key)??null,
    setItem(key,value){if(this.fail)throw Error('quota');memory.set(key,String(value));},removeItem:key=>memory.delete(key),
    get length(){return memory.size;},key:index=>[...memory.keys()][index]??null};}
const clone=value=>JSON.parse(JSON.stringify(value));
const ready=card=>earnEvolution(emptyEvolution(),[card],3);
const tdCard={id:'U01',element:catalogue.units.find(c=>c.id==='U01').elementId,rarity:5};
const rlCard=PLAYABLE_ROSTER.find(c=>c.id===14002001);
const run={schemaVersion:3,generatorVersion:RUN_GENERATOR_VERSION,seed:12345,volume:1,floor:1,
    cardId:rlCard.id,level:1,exp:0,hp:100,gauge:0,coin:0,stackHits:0,stackKills:0,equipment:[],roomClaims:[],appearance:'base',evolved:false};
function campWith(evolution=emptyEvolution()){
    const disk=storage();save.setStorage(disk);save.write('meta',mergeState({evolution}));save.initializeStorage();
    const camp=createMeta();camp.read();return {disk,camp};
}

test('material icons follow original evolution recipes, including swapped water/wind numbering',()=>{
    const cards=new Map(read('asset/rl/_raw/CharacterList.json').map(c=>[c.m_CharaID,c]));
    for(const recipe of read('asset/rl/_raw/CharacterEvolutionList.json')){
        const card=cards.get(recipe.m_SrcCharaID);if(!card||recipe.m_RecipeType!==0)continue;
        for(const id of recipe.m_ItemIDs.filter(id=>id>=6000&&id<6030))assert.equal(id%6,EVOLUTION_ITEMS[card.m_Element]%6);
    }
});

test('five-star and seasonal four-star gates consume matching pearls once',()=>{
    const card={id:'test',element:2,rarity:5};
    assert.equal(evolveCandidate(emptyEvolution(),card).reason,'experience');
    const progress=ready(card);progress.pearls[2]=2;
    assert.equal(evolveCandidate(progress,card).reason,'pearls');
    const seasonal={...card,rarity:4},result=evolveCandidate(progress,seasonal);
    assert.equal(result.state.pearls[2],0);assert.equal(progress.pearls[2],2);
    assert.equal(evolveCandidate(result.state,seasonal).reason,'evolved');
    assert.equal(evolutionQuote(progress,{...card,element:8}).reason,'invalid');
});
test('a party earns one pearl per represented element, experience per companion',()=>{
    const cards=[tdCard,{...tdCard,id:'U02'}],state=earnEvolution(emptyEvolution(),cards);
    assert.equal(state.pearls[tdCard.element],1);assert.deepEqual(state.experience,{U01:1,U02:1});
});
test('TD victory receipts earn experience once; defeats earn none',()=>{
    const campaign=new CampaignSave(storage(),catalogue),battle=new Battle(LEVELS[0],{deck:['F01','U01']});
    battle.phase='lost';campaign.finish('lost',battle);assert.equal(campaign.evolutionQuote('U01').experience,0);
    battle.phase='won';campaign.finish('first',battle);campaign.finish('first',battle);
    assert.equal(campaign.evolutionQuote('U01').experience,1);assert.equal(campaign.evolutionQuote('U01').owned,1);
});
test('TD evolution purchase survives reload and rolls back on storage failure',()=>{
    const disk=storage(),campaign=new CampaignSave(disk,catalogue);campaign.progress.evolution=ready(tdCard);campaign.persist();
    const before=JSON.stringify(campaign.progress);disk.fail=true;
    assert.equal(campaign.evolve('U01').reason,'storage');assert.equal(JSON.stringify(campaign.progress),before);
    disk.fail=false;assert.ok(campaign.evolve('U01').ok);
    const reloaded=new CampaignSave(disk,catalogue);assert.ok(reloaded.evolutionQuote('U01').evolved);
    assert.equal(reloaded.evolve('U01').reason,'evolved');assert.equal(reloaded.evolutionQuote('U01').owned,0);
});
test('TD growth applies once to actual deployed health and attack; old setup stays base',()=>{
    const battle=new Battle(LEVELS[0],{deck:['U01'],evolved:['U01']});battle.resource=999;assert.ok(battle.deploy('U01',0,1));
    const unit=[...battle.units.values()][0],rule=UNIT_RULES.U01;
    assert.equal(unit.maxHp,Math.round(rule.hp*1.15));assert.equal(battle.unitRule(unit).damage,Math.round(rule.damage*1.12));
    const snapshot=battle.serializeSetup(),restored=new Battle(LEVELS[0],{deck:['U01']});
    assert.ok(Battle.applySetup(restored,snapshot));assert.equal([...restored.units.values()][0].maxHp,unit.maxHp);
    delete snapshot.evolved;const legacy=new Battle(LEVELS[0],{deck:['U01'],evolved:['U01']});
    assert.ok(Battle.applySetup(legacy,snapshot));assert.equal([...legacy.units.values()][0].maxHp,rule.hp);
});
test('TD malformed setup cannot partially change live battle state',()=>{
    const source=new Battle(LEVELS[0],{deck:['U01'],evolved:['U01']});source.resource=999;source.deploy('U01',0,1);
    for(const mutate of [s=>s.evolved='U01',s=>s.units.push({...s.units[0],row:99}),s=>s.readyAt=[null]]){
        const target=new Battle(LEVELS[0]),snapshot=source.serializeSetup(),before=target.serializeSetup();mutate(snapshot);
        assert.equal(Battle.applySetup(target,snapshot),false);assert.deepEqual(target.serializeSetup(),before);
    }
});
test('TD endless retains growth, rejects inconsistent units and rewards only once after reload',()=>{
    const battle=new Battle(ENDLESS,{deck:['U01'],evolved:['U01'],runId:'growth-endless',seed:55});
    battle.resource=999;battle.deploy('U01',0,1);while(battle.plannedWave<5)battle.planWave();
    battle.wave=5;battle.settledWaves.add(5);battle.waveBounds.get(5).remaining=0;
    const snapshot=battle.serializeEndless(),disk=storage(),campaign=new CampaignSave(disk,catalogue);
    const receipt={runId:battle.runId,wave:5,drops:[],bonusDrops:[],checkpoint:snapshot};
    assert.ok(campaign.settleEndlessReward(receipt).applied);
    const loaded=new CampaignSave(disk,catalogue);assert.equal(loaded.settleEndlessReward(receipt).applied,false);
    assert.equal(loaded.evolutionQuote('U01').experience,1);
    const restored=new Battle(ENDLESS,{deck:['U01']});assert.ok(Battle.applyEndless(restored,loaded.progress.endlessRun));
    assert.equal([...restored.units.values()][0].evolved,true);
    for(const mutate of [s=>s.evolved='U01',s=>s.units[0].evolved=false,s=>s.units[0].evolved='yes']){
        const bad=clone(snapshot);mutate(bad);const target=new Battle(ENDLESS),before=target.serializeEndless();
        assert.equal(Battle.applyEndless(target,bad),false);assert.deepEqual(target.serializeEndless(),before);
        assert.equal(validateProgress({...campaign.progress,endlessRun:bad}).endlessRun,null);
    }
});
test('RL progression is inside the accepted descent transaction, with failure and duplicate rejection',()=>{
    const {disk,camp}=campWith();const started=save.beginRun(run);assert.ok(started.accepted);
    const checkpoint=save.load('run');disk.fail=true;
    assert.equal(camp.descendRun(started.runId,checkpoint).ok,false);assert.equal(camp.evolutionQuote(rlCard.id).experience,0);
    disk.fail=false;save.retryStorage();const descent=camp.descendRun(started.runId,checkpoint);assert.ok(descent.ok,JSON.stringify(descent));
    assert.equal(camp.evolutionQuote(rlCard.id).experience,1);assert.equal(camp.evolutionQuote(rlCard.id).owned,1);
    assert.equal(camp.descendRun(started.runId,checkpoint).ok,false);assert.equal(camp.evolutionQuote(rlCard.id).owned,1);
    assert.equal(save.load('run').evolved,false);
});
test('RL victory awards final-floor growth once, defeat cannot award it',()=>{
    for(const outcome of ['victory','defeat']){
        const {camp}=campWith(),started=save.beginRun({...run,floor:20});
        const facts={outcome,volume:1,floor:20,cardId:rlCard.id,level:1,coin:0,items:[]};
        assert.ok(camp.settleRun(started.runId,facts).receipt);camp.settleRun(started.runId,facts);
        assert.equal(camp.evolutionQuote(rlCard.id).owned,outcome==='victory'?1:0);
    }
});
test('RL purchase preserves material on quota failure and persists through strict export/import',()=>{
    const {disk,camp}=campWith(ready(rlCard)),before=JSON.stringify(camp.state);disk.fail=true;
    assert.equal(camp.evolve(rlCard.id).reason,'storage');assert.equal(JSON.stringify(camp.state),before);
    disk.fail=false;assert.ok(camp.evolve(rlCard.id).ok);assert.equal(camp.evolve(rlCard.id).reason,'evolved');
    const exported=save.exportSave();save.setStorage(storage());assert.ok(save.importSave(exported).ok);
    const loaded=createMeta();loaded.read();assert.ok(loaded.isEvolved(rlCard.id));assert.equal(loaded.evolutionQuote(rlCard.id).owned,0);
    const bad=JSON.parse(exported);bad.meta.evolution.evolved=[rlCard.id];assert.equal(save.importSave(JSON.stringify(bad)).ok,false);
});
test('RL actual spawn and repeated equipment replacement retain growth without stat or health inflation',()=>{
    const card=stats.card(rlCard.id),world=createWorld({seed:13,tables:{stats}});
    world.spawnPlayer({card,level:1,evolved:true});const p=world.player,truth=stats.statsFor(card.id,1);
    assert.equal(p.maxHp,Math.round(truth.hp*1.15));assert.equal(p.base.atk,truth.atk*1.12);
    p.hp=Math.floor(p.maxHp*.6);
    const weapon=weapons.catalog.find(w=>w.class===card.class&&w.charaId<0&&w.rare===3);
    const item={slot:'weapon',rarity:'rare',affixes:[],catalogId:weapon.id};
    const expected=calculateLoadout(truth,[item],p).stats;
    for(let i=0;i<8;i++){
        const hp=p.hp,ratio=p.hp/p.maxHp,drop={x:p.x,y:p.y,items:[clone(item)]};world.drops.push(drop);
        assert.ok(world.previewEquipment(drop.items[0]));assert.ok(world.takeDrop(drop,drop.items[0]));
        assert.deepEqual(p.base,expected);assert.ok(p.hp/p.maxHp<=ratio+1e-9);if(i)assert.equal(p.hp,hp);
    }
    assert.deepEqual(p.truthBase,truth);
});
console.log(JSON.stringify({passed}));
