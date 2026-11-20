// Inline SVG icons (stroke-based, inherit currentColor).
'use strict';

const svg = (body, size = 24) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  bus: svg('<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 18v2M16 18v2"/><circle cx="8" cy="14.5" r="1"/><circle cx="16" cy="14.5" r="1"/>'),
  cab: svg('<path d="M5 17h14v-4l-2-5H7l-2 5z"/><path d="M9 8l1-3h4l1 3"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/>'),
  car: svg('<path d="M3 16h18v-3l-3-5H6l-3 5z"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>'),
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 16),
  chevron: svg('<path d="M9 6l6 6-6 6"/>', 16),
  heart: svg('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>', 16),
  wind: svg('<path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/>', 16),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 16),
  pin: svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>', 16),
};

/** Rydra mark: a rounded tile with a lane line and a direction chevron. */
const LOGO = `<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><rect width="28" height="28" rx="8" fill="currentColor"/><path d="M14 5v18" stroke="url(#lg)" stroke-width="3" stroke-linecap="round" stroke-dasharray="3 3"/><path d="M9.5 13.5L14 9l4.5 4.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8aa2ff"/><stop offset="1" stop-color="#b79cff"/></linearGradient></defs></svg>`;

/** Dot meter: three dots, `filled` of them lit. Count carries meaning as well as colour. */
function dots(filled, tone) {
  return `<span class="dots3 ${tone}" aria-hidden="true">${[0, 1, 2].map((i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('')}</span>`;
}

const LEVEL = { plan: { n: 3, tone: 'good' }, care: { n: 2, tone: 'warn' }, hold: { n: 1, tone: 'bad' } };

/** Status tag for results: dots + words. */
function statusTag(level, label) {
  const l = LEVEL[level] || LEVEL.plan;
  return `<span class="status ${l.tone}">${dots(l.n, l.tone)}<b>${label}</b></span>`;
}

module.exports = { ICONS, LOGO, dots, statusTag };
