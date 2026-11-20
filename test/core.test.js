'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeBaseline, compareToBaseline } = require('../src/core/baseline');
const { departureAdvice, restStopAdvice, settleSummary, hasDrift } = require('../src/core/advice');
const { buildRestPlan } = require('../src/core/plan');
const { getRoute } = require('../src/core/routes');
const { badgeText } = require('../src/core/badge');
const { prune, normalize } = require('../src/core/store');
const { seedDemoData } = require('../src/core/seed');
const { summarize, collect } = require('../src/sensor/summarize');

const good = (pulse, breathing, extra = {}) => Object.assign({ kind: 'departure', quality: 'good', source: 'camera', at: Date.now(), pulse, breathing }, extra);

test('baseline needs three good departure readings', () => {
  assert.equal(computeBaseline([good(70, 14), good(72, 15)]).ready, false);
  const b = computeBaseline([good(70, 14), good(72, 15), good(68, 13), good(90, 20, { quality: 'poor' }), good(95, 22, { kind: 'arrival' })]);
  assert.equal(b.ready, true);
  assert.equal(b.count, 3);
  assert.equal(b.pulse, 70);
  assert.equal(b.breathing, 14);
});

test('questions-only checks never count toward the baseline', () => {
  const b = computeBaseline([good(70, 14), good(71, 14), good(null, null, { source: 'questions', quality: 'none' })]);
  assert.equal(b.ready, false);
});

test('comparison flags only clearly higher readings', () => {
  const base = { ready: true, pulse: 70, breathing: 14 };
  assert.equal(compareToBaseline(good(76, 15), base).status, 'usual');
  assert.equal(compareToBaseline(good(83, 15), base).status, 'above');
  assert.equal(compareToBaseline(good(72, 18.5), base).status, 'above');
  assert.equal(compareToBaseline(good(83, 15), { ready: false }).status, 'building');
  assert.equal(compareToBaseline({ quality: 'poor' }, base).status, 'no-reading');
});

test('severe sleepiness always means hold, whatever the readings', () => {
  const calm = { status: 'usual', pulseDiff: 0, breathDiff: 0 };
  assert.equal(departureAdvice({ sleepHours: 8, alertness: 1, comparison: calm }).level, 'hold');
  assert.equal(departureAdvice({ sleepHours: 3, alertness: 5, comparison: calm }).level, 'hold');
});

test('departure advice never claims safety or fatigue', () => {
  const cases = [
    { sleepHours: 8, alertness: 5, comparison: { status: 'usual' } },
    { sleepHours: 4.5, alertness: 2, comparison: { status: 'above' } },
    { sleepHours: 3, alertness: 1, comparison: { status: 'above' } },
  ];
  for (const c of cases) {
    const a = departureAdvice(c);
    const words = [a.headline, ...a.notes].join(' ').toLowerCase();
    assert.ok(!/safe to drive|you are fatigued|you're fatigued|fit to drive/.test(words), words);
  }
});

test('higher readings offer the settle routine and explain other causes', () => {
  const a = departureAdvice({ sleepHours: 8, alertness: 4, comparison: { status: 'above' } });
  assert.equal(a.offerSettle, true);
  assert.equal(a.level, 'care');
  assert.ok(a.notes.some((n) => n.includes('many reasons')));
});

test('short sleep or sleepiness shortens the break interval', () => {
  assert.equal(departureAdvice({ sleepHours: 8, alertness: 4, comparison: { status: 'usual' } }).breakEveryMin, 120);
  assert.equal(departureAdvice({ sleepHours: 4.5, alertness: 4, comparison: { status: 'usual' } }).breakEveryMin, 90);
  assert.equal(departureAdvice({ sleepHours: 8, alertness: 2, comparison: { status: 'usual' } }).breakEveryMin, 90);
});

test('rest plan for Lagos to Abuja snaps to real towns and never stretches the interval', () => {
  const stops = buildRestPlan(getRoute('lagos-abuja'), 10.5, 120);
  assert.ok(stops.length >= 3);
  assert.equal(stops[0].name, 'Ibadan');
  assert.ok(stops.some((s) => s.name === 'Lokoja'));
  let prev = 0;
  for (const s of stops) { assert.ok(s.atMin - prev <= 120, `${s.name} at ${s.atMin} after ${prev}`); prev = s.atMin; }
  assert.ok(stops[stops.length - 1].atMin <= 10.5 * 60 - 45);
});

test('custom routes get time-based stops', () => {
  const stops = buildRestPlan(getRoute('custom'), 5, 90);
  assert.deepEqual(stops.map((s) => s.atMin), [90, 180]);
  assert.equal(stops[0].town, false);
  assert.equal(buildRestPlan(getRoute('custom'), 1.5, 120).length, 0);
});

test('rest stop: own feeling outranks readings', () => {
  const dep = good(70, 14);
  assert.equal(restStopAdvice({ departure: dep, reading: good(70, 14), feeling: 1 }).level, 'hold');
  const sleepy = restStopAdvice({ departure: dep, reading: good(70, 14), feeling: 2 });
  assert.equal(sleepy.offerNap, true);
  assert.equal(restStopAdvice({ departure: dep, reading: good(71, 14), feeling: 4 }).level, 'plan');
  const drift = restStopAdvice({ departure: dep, reading: good(58, 14), feeling: 4 });
  assert.equal(drift.level, 'care');
  assert.equal(drift.drift, true);
});

test('drift ignores poor readings', () => {
  assert.equal(hasDrift(good(70, 14), { quality: 'poor', pulse: 40 }), false);
  assert.equal(hasDrift(good(70, 14), good(70, 17.5)), true);
});

test('settle summary describes the change', () => {
  assert.match(settleSummary(good(88, 19), good(76, 15)).text, /pulse down 12/);
  assert.match(settleSummary(good(88, 19), { quality: 'poor' }).text, /could not get a clear reading/);
});

test('passenger badge contains no health data', () => {
  const t = badgeText({ checkedAt: Date.now(), routeName: 'Lagos to Abuja', stopCount: 4 });
  assert.match(t, /4 planned stops/);
  assert.match(t, /no health data/i);
  assert.ok(!/bpm|breath|pulse|hrv/i.test(t.replace(/no health data/i, '')));
});

test('retention prunes old data but keeps the active trip', () => {
  const day = 86400000; const now = Date.now();
  const s = normalize({ settings: { retentionDays: 30 }, activeJourneyId: 'j_active',
    readings: [{ at: now - 40 * day }, { at: now - day }],
    journeys: [{ id: 'j_old', startedAt: now - 40 * day }, { id: 'j_active', startedAt: now - 45 * day }] });
  const p = prune(s, now);
  assert.equal(p.readings.length, 1);
  assert.deepEqual(p.journeys.map((j) => j.id), ['j_active']);
});

test('seeded demo data gives a ready baseline and is labelled', () => {
  const s = seedDemoData(null);
  const b = computeBaseline(s.readings);
  assert.equal(b.ready, true);
  assert.ok(s.readings.every((r) => r.source === 'seeded'));
});

test('sensor summary uses only stable samples', () => {
  const acc = { pulse: [], breathing: [], hrv: [] };
  collect({
    cardio: { pulseRate: [{ value: 70, stable: true }, { value: 140, stable: false }, { value: 72, stable: true }, { value: 71, stable: true }],
      hrv: [{ rmssd: 40, stable: true }, { rmssd: 90, stable: false }] },
    breathing: { rate: [{ value: 14.4, stable: true }, { value: 30, stable: false }] },
  }, acc);
  const r = summarize(acc);
  assert.equal(r.pulse, 71);
  assert.equal(r.breathing, 14.4);
  assert.equal(r.hrv, 40);
  assert.equal(r.quality, 'good');
  assert.equal(summarize({ pulse: [70], breathing: [], hrv: [] }).quality, 'poor');
});
