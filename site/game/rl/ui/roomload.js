// Presentation only. The driver owns room identity, retries and frozen state.
export function createRoomLoading(parent, { onRetry, onStorage }) {
    const panel = document.createElement('section');
    panel.id = 'room-load-status'; panel.hidden = true;
    panel.setAttribute('aria-labelledby', 'room-load-title');
    const title = document.createElement('h2'); title.id = 'room-load-title';
    const text = document.createElement('p'); text.setAttribute('role', 'status');
    // 仅 busy 相位显示的两行骨架线（theme.css .paper-skeleton）：装配进行中
    // 的纸面占位；failed 相位换成操作按钮，骨架线让位。
    const skeleton = document.createElement('div'); skeleton.className = 'room-load-skeleton';
    skeleton.hidden = true; skeleton.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 2; i++) {
        const line = document.createElement('div');
        line.className = 'paper-skeleton room-load-skeleton-line';
        skeleton.appendChild(line);
    }
    const actions = document.createElement('div'); actions.className = 'room-load-actions';
    for (const [id, label, callback] of [['retry', '重试房间装配', onRetry], ['storage', '检查存档与备份', onStorage]]) {
        const button = document.createElement('button'); button.id = 'room-load-' + id;
        button.type = 'button'; button.textContent = label; button.addEventListener('click', callback);
        actions.appendChild(button);
    }
    panel.append(title, text, skeleton, actions); parent.appendChild(panel);
    return {
        show(phase, message) {
            panel.dataset.phase = phase; panel.hidden = false;
            title.textContent = phase === 'failed' ? '房间尚未就绪' : '正在整理下一间房间';
            text.textContent = message;
            skeleton.hidden = phase === 'failed';
            actions.hidden = phase !== 'failed';
            if (phase === 'failed' && !document.querySelector('dialog[open]')) actions.firstChild.focus({ preventScroll: true });
        },
        hide() { panel.hidden = true; }
    };
}

// CSS transitions may be disabled or cancelled, and headless rAF may be held.
// Use their authored duration as a bounded fallback, never a gameplay timer.
export function waitForRoomFade(cover, opacity) {
    if (!cover || Math.abs(Number(getComputedStyle(cover).opacity) - opacity) < .001) return Promise.resolve();
    const style = getComputedStyle(cover);
    const seconds = value => Math.max(...value.split(',').map(v => parseFloat(v) * (v.trim().endsWith('ms') ? .001 : 1)), 0);
    const duration = seconds(style.transitionDuration) + seconds(style.transitionDelay);
    return new Promise(resolve => {
        let timer;
        const finish = () => { clearTimeout(timer); cover.removeEventListener('transitionend', ended); resolve(); };
        const ended = event => { if (event.target === cover && event.propertyName === 'opacity') finish(); };
        cover.addEventListener('transitionend', ended);
        timer = setTimeout(finish, duration * 1000 + 50);
    });
}
