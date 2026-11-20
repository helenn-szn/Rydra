// Inline SVG icons (stroke-based, inherit currentColor). Sign shapes carry meaning, not just colour.
'use strict';

const svg = (body, size = 24) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  bus: svg('<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M8 18v2M16 18v2"/><circle cx="8" cy="14.5" r="1"/><circle cx="16" cy="14.5" r="1"/>'),
  cab: svg('<path d="M5 17h14v-4l-2-5H7l-2 5z"/><path d="M9 8l1-3h4l1 3"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/>'),
  car: svg('<path d="M3 16h18v-3l-3-5H6l-3 5z"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  pin: svg('<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
};

/** Road-sign shapes for result states: green panel, yellow diamond, red octagon. */
function signShape(level, size = 44) {
  if (level === 'hold') {
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true"><path d="M16 3h16l13 13v16L32 45H16L3 32V16z" fill="var(--sign-red)" stroke="#fff" stroke-width="3"/><rect x="14" y="21.5" width="20" height="5" rx="1" fill="#fff"/></svg>`;
  }
  if (level === 'care') {
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true"><path d="M24 2l22 22-22 22L2 24z" fill="var(--sign-yellow)" stroke="var(--asphalt)" stroke-width="3"/><rect x="21.8" y="12" width="4.4" height="16" rx="1.5" fill="var(--asphalt)"/><circle cx="24" cy="34" r="2.8" fill="var(--asphalt)"/></svg>`;
  }
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true"><rect x="3" y="7" width="42" height="34" rx="6" fill="var(--sign-green)" stroke="#fff" stroke-width="3"/><path d="M14 24l7 7 13-14" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

module.exports = { ICONS, signShape };
