// Appearance never changes card identity, combat stats, equipment or progression.
const ART = 'asset/img/rl/';
const KEY = 'kirafan.card-forms.v1';
export function formsFor(card) {
    if (card.forms) return card.forms;
    const form = (id, resourceId, headId) => ({ cardId:id, resourceId, headId:headId || 0,
        card:`${ART}card/${id}.webp`, icon:`${ART}icon/${id}.webp` });
    return { base:form(card.id, card.resourceId, card.headId),
        evolved:card.evolvedId ? form(card.evolvedId, card.evolvedResourceId, card.evolvedHeadId) : null };
}
export function readFormPreferences() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY));
        return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch { return {}; }
}
export function formName(card, preferences) {
    return preferences?.[formsFor(card).base.cardId] === 'base' || !formsFor(card).evolved ? 'base' : 'evolved';
}
export function saveFormPreference(card, name, preferences) {
    preferences[formsFor(card).base.cardId] = name === 'base' ? 'base' : 'evolved';
    try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch { /* Keep the session choice. */ }
}
export function withCardForm(card, name) {
    const forms = formsFor(card), form = forms[name] || forms.evolved || forms.base;
    return { ...card, resourceId:form.resourceId, headId:form.headId,
        card:form.card, icon:form.icon, displayCardId:form.cardId, appearance:form === forms.base ? 'base' : 'evolved' };
}
