// The Rydra road scene: a top-down road with a gradient lane line, a car, a navigation puck and
// frosted roadside trees, with a floating card on top. Drawn here as SVG (no photos), themed by CSS.
'use strict';

const TREE = (cx, cy, r) => `<g class="tree"><circle cx="${cx}" cy="${cy}" r="${r}"/><circle cx="${cx - r * 0.45}" cy="${cy + r * 0.25}" r="${r * 0.7}"/><circle cx="${cx + r * 0.4}" cy="${cy - r * 0.3}" r="${r * 0.65}"/></g>`;

const CAR = `<g class="car" transform="translate(94 250)">
  <rect x="0" y="0" width="68" height="148" rx="30" class="car-body"/>
  <rect x="7" y="34" width="54" height="80" rx="20" class="car-glass"/>
  <path d="M8 34 Q34 22 60 34" class="car-line"/>
  <rect x="-7" y="44" width="10" height="7" rx="3.5" class="car-body"/>
  <rect x="65" y="44" width="10" height="7" rx="3.5" class="car-body"/>
  <rect x="12" y="4" width="14" height="5" rx="2.5" class="car-light"/>
  <rect x="42" y="4" width="14" height="5" rx="2.5" class="car-light"/>
</g>`;

/**
 * @param {string} cardHtml  content of the floating card
 * @param {{puckY?:number, compact?:boolean}} opts
 */
function roadScene(cardHtml, { compact = false } = {}) {
  return `<div class="scene ${compact ? 'compact' : ''}">
    <svg class="scene-art" viewBox="0 0 520 560" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="laneGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7f9bff"/><stop offset="1" stop-color="#b69bff"/></linearGradient>
        <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
        <filter id="frost" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.4"/></filter>
      </defs>
      <rect width="520" height="560" class="ground"/>
      <rect x="80" y="0" width="190" height="560" class="road"/>
      <rect x="86" y="0" width="3" height="560" class="edge"/>
      <rect x="261" y="0" width="3" height="560" class="edge"/>
      <rect x="173" y="0" width="5" height="560" rx="2.5" fill="url(#laneGrad)"/>
      <g filter="url(#frost)">${TREE(470, 60, 44)}${TREE(430, 170, 34)}${TREE(492, 300, 52)}${TREE(440, 440, 40)}${TREE(500, 530, 46)}${TREE(360, 40, 30)}${TREE(330, 520, 28)}</g>
      <g class="car-wrap"><g filter="url(#soft)" opacity=".5"><ellipse cx="136" cy="332" rx="40" ry="80" class="car-shadow"/></g>${CAR}</g>
      <g class="puck" transform="translate(175.5 96)"><circle r="18" class="puck-halo"/><circle r="12.5" class="puck-dot"/><path d="M-5 3L0 -5L5 3L0 1z" fill="#fff"/></g>
    </svg>
    <div class="scene-card">${cardHtml}</div>
  </div>`;
}

module.exports = { roadScene };
