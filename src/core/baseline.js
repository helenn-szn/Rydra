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

function quantile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

/** "Usual range": middle 60% once there are 6+ readings, otherwise the full spread. */
function usualRange(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return v.length >= 6 ? [quantile(v, 0.2), quantile(v, 0.8)] : [Math.min(...v), Math.max(...v)];
}

const SPACING_MS = 4 * 3600 * 1000;   // readings closer than 4 h count once, so "usual" spans different days

/** Readings that count toward the baseline: good start-of-trip or calm at-home checks, spaced 4 h apart. */
function baselineReadings(readings) {
  const good = (readings || [])
    .filter((r) => (r.kind === 'departure' || r.kind === 'baseline') && r.quality === 'good' && r.source !== 'questions')
    .sort((a, b) => b.at - a.at);
  const kept = [];
  for (const r of good) {
    if (!kept.length || kept[kept.length - 1].at - r.at >= SPACING_MS) kept.push(r);
    if (kept.length === WINDOW) break;
  }
  return kept;
}

/** Baseline from good-quality camera readings taken at the start of trips or as calm checks at home. */
function computeBaseline(readings) {
  const usable = baselineReadings(readings);
  if (usable.length < MIN_READINGS) {
    return { ready: false, count: usable.length, needed: MIN_READINGS };
  }
  const pulses = usable.map((r) => r.pulse);
  const breaths = usable.map((r) => r.breathing);
  return {
    ready: true,
    count: usable.length,
    pulse: median(pulses),
    breathing: median(breaths),
    pulseRange: usualRange(pulses),
    breathingRange: usualRange(breaths),
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

module.exports = { computeBaseline, baselineReadings, compareToBaseline, median, quantile, usualRange, MIN_READINGS, ABOVE, SPACING_MS };
