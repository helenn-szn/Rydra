// Personal baselines. Rydra only ever compares a driver with their OWN usual readings.
'use strict';

const MIN_READINGS = 3;     // fewer than this = "building your baseline"
const WINDOW = 14;          // use the most recent N good departure readings

// Thresholds for "well above usual". Deliberately loose: small changes are normal.
const ABOVE = { pulseBpm: 12, pulsePct: 0.15, breathing: 4 };

function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Baseline from good-quality camera readings taken at departure. */
function computeBaseline(readings) {
  const usable = (readings || [])
    .filter((r) => r.kind === 'departure' && r.quality === 'good' && r.source !== 'questions')
    .sort((a, b) => b.at - a.at)
    .slice(0, WINDOW);
  if (usable.length < MIN_READINGS) {
    return { ready: false, count: usable.length, needed: MIN_READINGS };
  }
  return {
    ready: true,
    count: usable.length,
    pulse: median(usable.map((r) => r.pulse)),
    breathing: median(usable.map((r) => r.breathing)),
  };
}

/** Compare one reading with the baseline. Returns plain differences plus a coarse status. */
function compareToBaseline(reading, baseline) {
  if (!reading || reading.quality !== 'good') return { status: 'no-reading' };
  if (!baseline || !baseline.ready) return { status: 'building' };
  const pulseDiff = Number.isFinite(reading.pulse) && Number.isFinite(baseline.pulse) ? reading.pulse - baseline.pulse : null;
  const breathDiff = Number.isFinite(reading.breathing) && Number.isFinite(baseline.breathing) ? reading.breathing - baseline.breathing : null;
  const pulseHigh = pulseDiff != null && (pulseDiff >= ABOVE.pulseBpm || pulseDiff >= baseline.pulse * ABOVE.pulsePct);
  const breathHigh = breathDiff != null && breathDiff >= ABOVE.breathing;
  return {
    status: pulseHigh || breathHigh ? 'above' : 'usual',
    pulseDiff,
    breathDiff,
    pulseHigh,
    breathHigh,
  };
}

module.exports = { computeBaseline, compareToBaseline, median, MIN_READINGS, ABOVE };
