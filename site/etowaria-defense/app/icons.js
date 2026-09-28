// Inline SVG glyphs for the battle HUD; currentColor follows the button.
const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
export const ICONS = {
    back: svg('<path d="M14.5 5 7.5 12l7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'),
    gear: svg('<circle cx="12" cy="12" r="3.4" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M5.5 18.5l2.1-2.1M16.4 7.6l2.1-2.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
    pause: svg('<rect x="6.5" y="5" width="4" height="14" rx="1.4" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.4" fill="currentColor"/>'),
    play: svg('<path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2Z" fill="currentColor"/>'),
    check: svg('<path d="m5 12.5 4.6 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>'),
    cross: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'),
    collect: svg('<path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9Z" fill="currentColor"/><path d="M5 19.5h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
    recall: svg('<path d="M9 7H15.5a4.5 4.5 0 0 1 0 9H8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M11.5 3.5 7.8 7l3.7 3.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 20h12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
    list: svg('<path d="M9 6.5h10M9 12h10M9 17.5h10" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><circle cx="5" cy="6.5" r="1.5" fill="currentColor"/><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="5" cy="17.5" r="1.5" fill="currentColor"/>'),
    crea: '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><defs><linearGradient id="crea-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff6b8"/><stop offset=".45" stop-color="#ffc0e0"/><stop offset="1" stop-color="#9fd4ff"/></linearGradient></defs><path d="M16 1.8 19.4 12.6 30.2 16 19.4 19.4 16 30.2 12.6 19.4 1.8 16 12.6 12.6Z" fill="url(#crea-g)" stroke="#b7876a" stroke-width="1.2" stroke-linejoin="round"/><path d="M16 7.5 17.6 14.4 24.5 16 17.6 17.6 16 24.5 14.4 17.6 7.5 16 14.4 14.4Z" fill="#fffdf2" opacity=".75"/></svg>'
};
