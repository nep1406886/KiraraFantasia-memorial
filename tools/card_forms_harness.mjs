// Check shipped form pairs against original tables, including every asset dependency.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { formsFor, withCardForm, formName } from '../site/core/card-forms.js';
import { PLAYABLE_IDS } from '../site/game/rl/rosterids.js';

const root = new URL('../site/', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const json = path => JSON.parse(read(path));
const context = { window:{} };
vm.runInNewContext(read('asset/gacha/cards.js'), context, { timeout:1000 });
const identities = new Map();
for (const card of context.window.kirafanGachaData.cards) {
    identities.set(card.id, card);
    if (card.evolvedId) identities.set(card.evolvedId, card);
}
const original = new Map(json('asset/rl/_raw/CharacterList.json').map(row=>[row.m_CharaID,row]));
const models = json('asset/models/manifest.json');
const defenseModels = json('etowaria-defense/data/models.json');
const units = json('etowaria-defense/data/units.json').units;
function file(path) {
    assert(path && existsSync(new URL(path.split('?')[0], root)), 'missing '+path);
}
function pair(card, id, manifest) {
    const identity = identities.get(id), forms = formsFor(card);
    assert(identity, 'unknown original card '+id);
    assert.equal(forms.base.cardId, identity.id);
    assert.equal(forms.evolved.cardId, identity.evolvedId);
    assert.equal(formName(card, {}), 'evolved');
    for (const name of ['base','evolved']) {
        const form = forms[name], raw = original.get(form.cardId);
        assert.equal(form.resourceId, raw.m_ResourceID);
        assert.equal(form.headId, raw.m_HeadID);
        assert.equal(raw.m_NamedType, original.get(id).m_NamedType);
        assert.equal(raw.m_Class, original.get(id).m_Class);
        assert.equal(raw.m_Rare+1, identity.rarity);
        file(form.card);file(form.icon);
        for (const [kind,key] of [['models',`model/player/model_pl_${form.resourceId}.muast`],
            ['classActions',`${raw.m_Class}:${form.headId}`],['skillActions',String(form.resourceId)]]) {
            file(manifest[kind]?.[key]?.file);
        }
        const display = withCardForm(card,name);
        assert.equal(display.id, card.id);assert.equal(display.cardId, card.cardId);
        assert.equal(display.displayCardId, form.cardId);assert.equal(display.appearance,name);
        assert.equal(display.resourceId, raw.m_ResourceID);
    }
}
for (const unit of units) {
    assert.equal(unit.rarity, identities.get(unit.cardId).rarity);
    assert.equal(unit.seasonal, identities.get(unit.cardId).name.includes('【'));
    pair(unit,unit.cardId,defenseModels);
}
for (const id of PLAYABLE_IDS) pair(identities.get(id),id,models);
assert.equal(units.filter(u=>u.rarity===5).length,155);
assert.equal(units.filter(u=>u.rarity===5||u.seasonal).length,157);
console.log(`PASS ${units.length} defense and ${PLAYABLE_IDS.length} adventure card pairs: identity, rarity, art, models and actions`);
