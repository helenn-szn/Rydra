// Demo history for the video and for judges: six past departure checks, clearly marked as seeded.
'use strict';

const { normalize, newId, CONSENT_VERSION } = require('./store');

function seedDemoData(existing, now = Date.now()) {
  const s = normalize(existing);
  if (s.readings.some((r) => r.source === 'seeded')) return s;   // seed once, not on every launch
  const day = 24 * 3600 * 1000;
  const past = [
    [6, 71, 14.2], [5, 68, 13.8], [4, 73, 14.6], [3, 70, 13.9], [2, 69, 14.4], [1, 72, 14.0],
  ];
  for (const [ago, pulse, breathing] of past) {
    s.readings.push({ id: newId('r'), at: now - ago * day, kind: 'departure', pulse, breathing, hrv: null, quality: 'good', source: 'seeded' });
  }
  if (!s.consent) s.consent = { at: now - 7 * day, version: CONSENT_VERSION };
  s.introSeen = true;
  return s;
}

module.exports = { seedDemoData };
