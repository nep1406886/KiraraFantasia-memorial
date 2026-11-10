// Controlled combat probes, not campaign completion claims. Actual damage is
// measured through Battle at 60 Hz; targets have large HP to avoid overkill bias.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Battle} from '../site/etowaria-defense/sim/battle.js';
import {LEVELS,UNIT_RULES,TICK} from '../site/etowaria-defense/data/campaign.js';

const cards=Object.values(UNIT_RULES).filter(r=>r.id.startsWith('U'));
const level={...LEVELS[0],rows:3,cols:9,startResource:1500,
    spawns:[{at:1000,row:0,type:'E01',wave:1}]};
const report=[];
for(const rule of cards){
    const row={id:rule.id,name:rule.name,kind:rule.kind,cost:rule.cost};
    for(const grouped of [false,true]){
        const b=new Battle(level,{deck:[rule.id,'F13']});
        assert(b.deploy(rule.id,1,3).ok);b.start();
        const unit=[...b.units.values()][0];
        const targets=[];
        if(!rule.healing&&!['shielder','beacon'].includes(rule.kind)){
            for(const lane of grouped?[0,1,2]:[1])for(let i=0;i<(grouped?3:1);i++){
                const enemy=b.spawn({type:'E01',row:lane,x:4+i*.3,wave:1,hpScale:10000});
                targets.push({enemy,x:enemy.x,hp:enemy.hp});
            }
        }else{
            for(const lane of grouped?[0,1,2]:[1]){
                b.readyAt.delete('F13');assert(b.deploy('F13',lane,4).ok);
            }
        }
        for(let tick=0;tick<3600;tick++){
            // Immobile targets still receive the rule's real statuses. This
            // separates output from attack range and enemy movement decisions.
            targets.forEach(({enemy,x})=>{enemy.x=x;enemy.nextAttack=b.time+10;});
            for(const ally of b.units.values())if(ally!==unit){ally.hp=ally.maxHp/2;ally.shield=0;}
            b.step(TICK);b.drainEvents();
        }
        const damage=targets.reduce((sum,{enemy,hp})=>sum+hp-enemy.hp,0);
        const value=damage||b.stats.healed||b.stats.shielded||0;
        row[grouped?'cluster':'single']=+(value/60).toFixed(2);
    }
    row.efficiency=+(row.single/rule.cost*100).toFixed(2);
    if(rule.kind==='guard'){
        // Continuous pressure from three basic foes; no healer or equipment.
        const b=new Battle(level,{deck:[rule.id]});assert(b.deploy(rule.id,1,3).ok);b.start();
        const unit=[...b.units.values()][0];
        for(let i=0;i<3;i++)b.spawn({type:'E01',row:1,x:3.55,wave:1,hpScale:10000});
        for(let i=0;i<18000&&b.units.has(unit.id);i++){b.step(TICK);b.drainEvents();}
        row.survival=+b.time.toFixed(2);row.survivalPer100=+(b.time/rule.cost*100).toFixed(2);
    }
    assert(Number.isFinite(row.single)&&Number.isFinite(row.cluster));report.push(row);
}
fs.mkdirSync('.codex-tmp',{recursive:true});
fs.writeFileSync('.codex-tmp/defense-balance.json',JSON.stringify(report,null,2));
for(const kind of ['fighter','shooter','lobber','healer','guard']){
    const rows=report.filter(r=>r.kind===kind).sort((a,b)=>b.efficiency-a.efficiency);
    console.log(kind+' output per 100 cost: '+rows.slice(0,5).map(r=>r.id+'='+r.efficiency).join(', '));
    if(kind==='guard')console.log('survival per 100: '+rows.sort((a,b)=>b.survivalPer100-a.survivalPer100).slice(0,6).map(r=>r.id+'='+r.survivalPer100).join(', '));
}
console.log(`${report.length} cards measured in isolated single/cluster scenarios.`);
