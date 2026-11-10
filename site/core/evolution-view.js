// Presentation only: the caller commits progression before showing its result.
import { ELEMENT_LABELS, EVOLUTION_ITEMS } from './evolution.js';

const ROOT = new URL('../', import.meta.url);
function node(tag, className, text) {
    const el = document.createElement(tag); el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}
function comparison(preview) {
    const list = node('dl', 'evolution-stats');
    for (const {label,before,after} of preview?.stats || []) {
        const row = node('div', 'evolution-stat');
        row.append(node('dt', '', label), node('dd', '', `${before} → ${after}`)); list.append(row);
    }
    return list;
}
export function createEvolutionPanel({button, activity, reward, retention}) {
    const element = node('section', 'evolution-summary');
    const header = node('header', 'evolution-heading'), title = node('strong', '', '同行的成长');
    const state = node('span', 'evolution-state'); header.append(title,state);
    const requirements = node('div', 'evolution-requirements');
    const meters = ['同行阅历','属性进化珠'].map((label,index) => {
        const item = node('div','evolution-requirement'), icon = index ? node('img','evolution-material') : node('span','evolution-seal','✧');
        const name = node('span','',label), count = node('b',''), progress = node('progress','');
        progress.setAttribute('aria-label',label); if(index)icon.alt='属性进化珠';else icon.setAttribute('aria-hidden','true');
        item.append(icon,name,count,progress); requirements.append(item); return {item,icon,count,progress,name};
    });
    const missing = node('p','evolution-next'), detail = node('div','evolution-comparison');
    const help = node('details','evolution-help'), summary = node('summary','','如何培养与进化');
    help.append(summary,node('p','',reward+' '+retention+' 进化后可自由切换卡面与模型，能力不会随外观退回。'));
    element.append(header,requirements,missing,detail,button,help);
    return {element, update(quote,preview) {
        const ready = !quote.reason; element.dataset.state = quote.evolved?'evolved':ready?'ready':'growing';
        state.textContent = quote.evolved?'已进化':ready?'可以进化':'培养中';
        requirements.hidden = quote.evolved;
        const needExperience = Math.max(0,quote.needed-quote.experience), needPearls = Math.max(0,quote.needed-quote.owned);
        const gaps = [];if(needExperience)gaps.push(`${activity} ${needExperience} 次`);if(needPearls)gaps.push(`${ELEMENT_LABELS[quote.element]}之进化珠 ${needPearls} 枚`);
        missing.textContent = quote.evolved?'新的身影，已经与你同行。':ready?'心意与素材都已齐备，可以迎接新的成长。':'还需：'+gaps.join(' · ');
        for (let i=0;i<meters.length;i++) {
            const m=meters[i], amount=i?quote.owned:quote.experience;
            m.name.textContent=i?ELEMENT_LABELS[quote.element]+'之进化珠':'同行阅历';
            m.count.textContent=`${amount} / ${quote.needed}`;m.progress.max=quote.needed;m.progress.value=Math.min(amount,quote.needed);
            m.item.dataset.complete=String(amount>=quote.needed);
            if(i)m.icon.src=new URL(`asset/img/rl/item/${EVOLUTION_ITEMS[quote.element]}.webp`,ROOT).href;
        }
        detail.replaceChildren(node('p','evolution-caption',preview?.caption || '进化后的能力'),comparison(preview));
        button.disabled=!!quote.reason;button.textContent=quote.evolved?'已永久解锁':`消耗 ${quote.needed} 枚进化珠 · 进化`;
    }};
}

export function showEvolutionResult({name,before,after,preview,retention}) {
    const dialog=node('dialog','evolution-result'), label=node('p','ad-eyebrow','同行的下一章');
    dialog.setAttribute('aria-label',name+'进化完成');
    const title=node('h2','','进化完成'), subtitle=node('p','evolution-result-name',name);
    const cards=node('div','evolution-pair');
    for(const [src,form] of [[before,'进化前'],[after,'进化后']]) {
        const figure=node('figure','evolution-form'), image=node('img',''); image.src=src;image.alt=name+' · '+form;
        figure.append(image,node('figcaption','',form));cards.append(figure);
    }
    const close=node('button','ad-button ad-button-primary','收下这份成长');close.type='button';close.autofocus=true;
    const skip=node('button','evolution-skip','跳过动画');skip.type='button';
    skip.addEventListener('click',()=>{dialog.classList.add('settled');skip.hidden=true;close.focus();});
    close.addEventListener('click',()=>dialog.close());
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    dialog.append(skip,label,title,subtitle,cards,node('p','evolution-caption',preview?.caption || '成长已保存'),comparison(preview),node('p','evolution-retention',retention),close);
    document.body.append(dialog);dialog.showModal();
    // The result can always close, even when an illustration is unavailable.
    Promise.all([...cards.querySelectorAll('img')].map(i=>i.decode().catch(()=>{}))).then(()=>{if(dialog.isConnected)dialog.classList.add('revealed');});
    return dialog;
}
