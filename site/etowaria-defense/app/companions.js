import { siteUrl } from './assets.js';
import { UNIT_RULES } from '../data/campaign.js';
import { withCardForm, readFormPreferences, formName, saveFormPreference } from '../../core/card-forms.js';

// The gallery owns browsing and the six observation slots, never campaign growth.
export function createCompanionGallery({ catalogue, party, onChange, onSelect }) {
    const $ = id => document.getElementById(id);
    const preferences = readFormPreferences(), entries = new Map();
    const sources = new Map(catalogue.units.map(card => [card.id, card]));
    let selected = party[0] || catalogue.units[0].id, filter = 'all', search = '', pending = null;
    const unit = id => {
        const card = sources.get(id);
        return card && withCardForm(card, formName(card, preferences));
    };
    const node = (tag, cls, text) => {
        const el = document.createElement(tag); el.className = cls;
        if (text) el.textContent = text;
        if (tag === 'button') el.type = 'button';
        return el;
    };
    function change(next) { party = next; pending = null; onChange([...party]); sync(); }
    function toggle(id) {
        if (party.includes(id)) change(party.filter(value => value !== id));
        else if (party.length < 6) change([...party, id]);
        else { pending = pending === id ? null : id; sync(); }
    }
    function select(id) { selected = id; onSelect(unit(id)); sync(); }
    function sync() {
        const card = unit(selected), rule = UNIT_RULES[selected];
        const art = siteUrl(card.card || card.icon);
        if ($('detail-card').getAttribute('src') !== art) $('detail-card').src = art;
        $('detail-card').alt = card.name + ' · ' + (card.appearance === 'base' ? '进化前' : '进化后');
        $('detail-name').textContent = card.name;
        $('detail-work').textContent = card.work;
        $('detail-identity').textContent = `★${card.rarity} · ${card.className} · ${card.elementName}`;
        $('detail-role').textContent = rule.help;
        $('detail-cost').textContent = `${rule.role} · 巡守部署 ${rule.cost} 应援`;
        for (const button of $('companion-forms').children) {
            button.setAttribute('aria-pressed', String(button.dataset.form === card.appearance));
            button.disabled = !card.forms?.[button.dataset.form];
        }
        const skills = $('detail-skills');
        if (skills.dataset.unit !== selected) {
            skills.dataset.unit = selected; skills.replaceChildren();
            for (const skill of card.skills) skills.append(node('h4', '', skill.name), node('p', '', skill.detail));
        }
        const included = party.includes(selected);
        $('toggle-party').textContent = included ? '移出观察队伍' : party.length === 6 ? '选择一位替换' : '加入观察队伍';
        $('toggle-party').setAttribute('aria-pressed', String(included));
        let count = 0;
        for (const [id, entry] of entries) {
            const source = entry.card, added = party.includes(id);
            const featured = source.rarity === 5 || source.seasonal;
            entry.root.hidden = !(filter === 'legacy' ? !featured : featured && (filter === 'all' || String(source.classId) === filter))
                || !`${source.name} ${source.work} ${source.className} ${UNIT_RULES[id].role}`.toLocaleLowerCase().includes(search);
            if (!entry.root.hidden) count++;
            entry.root.classList.toggle('is-current', id === selected);
            entry.preview.setAttribute('aria-pressed', String(id === selected));
            entry.add.textContent = added ? '−' : pending === id ? '…' : '+';
            entry.add.setAttribute('aria-label', `${added ? '移除' : party.length === 6 ? '替换为' : '添加'}${source.name}`);
            entry.add.setAttribute('aria-pressed', String(added));
            const src = siteUrl(unit(id).icon);
            if (entry.image.getAttribute('src') !== src) entry.image.src = src;
        }
        $('companion-count').textContent = `${count} 位伙伴`;
        $('companion-empty').hidden = count > 0;
        $('party-count').textContent = pending ? `选择下方一位，替换为${unit(pending).name}` : `观察队伍 ${party.length} / 6`;
        $('party-cancel').hidden = !pending;
        $('roster-enter').disabled = !party.length || !!pending;
        const focused = document.activeElement?.dataset.partyAction;
        const slots = $('party-slots'); slots.replaceChildren();
        for (let index = 0; index < 6; index++) {
            const member = unit(party[index]);
            const slot = node('div', 'companion-slot');
            if (member) {
                const preview = node('button', 'companion-slot-preview');
                const image = node('img', ''); image.src = siteUrl(member.icon); image.alt = '';
                preview.append(image, node('span', '', member.name));
                preview.dataset.partyAction = 'view-' + member.id;
                preview.setAttribute('aria-label', `${pending ? '替换' : '查看'}${member.name}`);
                preview.classList.toggle('is-replace', !!pending);
                preview.addEventListener('click', () => pending
                    ? change(party.map(id => id === member.id ? pending : id)) : select(member.id));
                const remove = node('button', 'companion-remove', '×');
                remove.dataset.partyAction = 'remove-' + member.id;
                remove.setAttribute('aria-label', '移除' + member.name);
                remove.addEventListener('click', () => change(party.filter(id => id !== member.id)));
                slot.append(preview, remove);
            } else {
                const add = node('button', 'companion-slot-empty', '+');
                add.setAttribute('aria-label', '搜索并添加伙伴');
                add.addEventListener('click', () => $('companion-search').focus()); slot.append(add);
            }
            slots.append(slot);
        }
        if (focused) (slots.querySelector(`[data-party-action="${focused}"]`) || slots.querySelector('button'))?.focus();
    }
    for (const card of catalogue.units) {
        const root = node('article', 'companion-card'), preview = node('button', 'companion-preview');
        const image = node('img', 'companion-icon'); image.alt = ''; image.loading = 'lazy'; image.width = image.height = 72;
        preview.dataset.unit = card.id; preview.setAttribute('aria-label', '查看' + card.name);
        preview.append(image, node('strong', '', card.name), node('small', '', `${card.className} · ${card.elementName}`));
        preview.addEventListener('click', () => select(card.id));
        const add = node('button', 'companion-add'); add.dataset.add = card.id;
        add.addEventListener('click', () => toggle(card.id)); root.append(preview, add);
        $('roster-grid').append(root); entries.set(card.id, { root, preview, image, add, card });
    }
    for (const [id, label] of [['all', '精选'], [0, '战士'], [1, '魔法使'], [3, '骑士'], [2, '僧侣'], [4, '炼金术士'], ['legacy', '旧版收藏']]) {
        const button = node('button', 'companion-filter', label); button.setAttribute('aria-pressed', String(id === 'all'));
        button.addEventListener('click', () => {
            filter = String(id);
            for (const child of $('roster-tabs').children) child.setAttribute('aria-pressed', String(child === button));
            sync();
        }); $('roster-tabs').append(button);
    }
    for (const [name, label] of [['base', '进化前'], ['evolved', '进化后']]) {
        const button = node('button', 'companion-filter', label); button.dataset.form = name;
        button.addEventListener('click', () => { saveFormPreference(unit(selected), name, preferences); sync(); });
        $('companion-forms').append(button);
    }
    $('companion-search').addEventListener('input', event => { search = event.target.value.trim().toLocaleLowerCase(); sync(); });
    $('toggle-party').addEventListener('click', () => toggle(selected));
    $('party-cancel').addEventListener('click', () => { pending = null; sync(); });
    $('restore-party').addEventListener('click', () => change(catalogue.defaultParty.slice()));
    return { render: sync, unit };
}
