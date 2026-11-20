// Turns a stream of SmartSpectra samples into one reading. Only "stable" samples count
// (the SDK marks a sample stable when its confidence meets Presage's accuracy standard).
'use strict';

const { median } = require('../core/baseline');

const MIN_STABLE_PULSE = 3;
const MIN_STABLE_BREATH = 1;

function summarize({ pulse = [], breathing = [], hrv = [] }) {
  const good = pulse.length >= MIN_STABLE_PULSE && breathing.length >= MIN_STABLE_BREATH;
  const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  return {
    pulse: pulse.length ? Math.round(median(pulse)) : null,
    breathing: breathing.length ? round1(median(breathing)) : null,
    hrv: hrv.length ? Math.round(median(hrv)) : null,   // RMSSD in ms, only when stable
    quality: good ? 'good' : 'poor',
    samples: { pulse: pulse.length, breathing: breathing.length, hrv: hrv.length },
  };
}

/** Pull stable values out of one decoded Metrics packet into the accumulators. */
function collect(metrics, acc) {
  const cardio = metrics && metrics.cardio;
  const breathing = metrics && metrics.breathing;
  for (const m of (cardio && cardio.pulseRate) || []) if (m.stable && Number.isFinite(m.value)) acc.pulse.push(m.value);
  for (const m of (breathing && breathing.rate) || []) if (m.stable && Number.isFinite(m.value)) acc.breathing.push(m.value);
  for (const h of (cardio && cardio.hrv) || []) if (h.stable && Number.isFinite(h.rmssd)) acc.hrv.push(h.rmssd);
  return acc;
}

module.exports = { summarize, collect, MIN_STABLE_PULSE, MIN_STABLE_BREATH };
