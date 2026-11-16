// A run owns the quote, payment, model preparation and save transaction.
export function showRunEvolution({ title, description, choices, quote, confirm, onClose }) {
    const node = (tag, cls, text) => {
        const el = document.createElement(tag); el.className = cls;
        if (text) el.textContent = text;
        if (tag === 'button') el.type = 'button';
        return el;
    };
    const previousFocus = document.activeElement;
    const dialog = node('dialog', 'run-evolution'); dialog.setAttribute('aria-label', title);
    const header = node('header', 'run-evolution-header'), close = node('button', 'ad-button', '返回战场');
    header.append(node('h2', '', title), close);
    const intro = node('p', 'run-evolution-intro', description);
    const list = node('div', 'run-evolution-choices'); list.setAttribute('aria-label', '选择进化伙伴');
    const pair = node('div', 'run-evolution-art');
    const images = ['进化前的身影', '进化后的身影'].map(text => {
        const figure = node('figure', ''), image = node('img', ''); image.alt = text;
        figure.append(image, node('figcaption', '', text)); pair.append(figure); return image;
    });
    const name = node('h3', ''), progress = node('progress', ''), status = node('p', 'run-evolution-status');
    progress.setAttribute('aria-label', '本局成长进度'); status.setAttribute('role', 'status');
    const benefits = node('p', 'run-evolution-benefits', '生命上限 +15% · 攻击、治疗与护盾能力 +12%');
    const cost = node('button', 'ad-button ad-button-primary'); cost.dataset.action = 'evolve-run';
    const footer = node('p', 'run-evolution-note', '仅本局生效 · 当前生命比例、装备与技能冷却保留');
    let selected = choices[0], busy = false, closed = false;
    const controller = new AbortController();
    function sync() {
        if (!selected) { name.textContent = '先部署一位伙伴'; cost.disabled = true; pair.hidden = true; return; }
        const state = quote(selected.id);
        name.textContent = selected.name;
        images[0].src = selected.before; images[1].src = selected.after;
        progress.max = state.needed; progress.value = state.progress;
        status.textContent = state.reason || `成长已就绪 · 持有 ${state.owned} ${selected.currency}`;
        benefits.textContent = selected.benefits || '生命上限 +15% · 攻击、治疗与护盾能力 +12%';
        cost.textContent = state.evolved ? '本局已进化' : `使用 ${state.cost} ${selected.currency} · 进化`;
        cost.disabled = !state.ok || busy;
        for (const button of list.children) button.setAttribute('aria-pressed', String(button.dataset.id === String(selected.id)));
    }
    for (const choice of choices) {
        const button = node('button', 'run-evolution-choice', choice.name); button.dataset.id = choice.id;
        button.addEventListener('click', () => { if (!busy) { selected = choice; sync(); } }); list.append(button);
    }
    list.hidden = choices.length < 2;
    close.addEventListener('click', () => { if (!busy) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    function dispose() {
        if (closed) return;
        closed = true; controller.abort(); dialog.close(); dialog.remove(); onClose?.();
        if (previousFocus?.isConnected) previousFocus.focus();
    }
    dialog.addEventListener('close', dispose, { once: true });
    cost.addEventListener('click', async () => {
        if (busy || !selected || !quote(selected.id).ok) return;
        busy = true; cost.disabled = close.disabled = true; status.textContent = '正在准备新的身影…';
        try {
            const result = await confirm(selected.id, controller.signal);
            if (closed) return;
            if (result?.ok) { dialog.close(); return; }
            busy = false; sync(); status.textContent = result?.reason || '准备未完成，资源未扣除，可以重试。';
        } catch (error) {
            console.warn('Run evolution:', error);
            if (!closed) { busy = false; sync(); status.textContent = '操作未完成，请检查当前状态后重试。'; }
        }
        finally { busy = false; close.disabled = false; }
    });
    const body = node('div', 'run-evolution-body'), info = node('section', 'run-evolution-info');
    info.append(name, progress, status, benefits, cost, footer); body.append(pair, info);
    dialog.append(header, intro, list, body);
    document.body.append(dialog); sync(); dialog.showModal();
    return { close: () => { if (!busy) dialog.close(); }, dispose };
}
