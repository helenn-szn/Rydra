// What Rydra tells the driver, as message codes (the UI translates them). Rules:
// 1. Never say "safe to drive" or "you are fatigued". We describe readings and suggest plans.
// 2. What the driver reports about sleepiness always wins over the camera.
// 3. Every comparison carries a plain note that readings change for many reasons.
'use strict';

const ALERTNESS = [1, 2, 3, 4, 5];          // labels: alert.1 … alert.5 (1 = fighting to stay awake)
const SLEEP = [3, 4.5, 6.5, 8];             // labels: sleep.3 … sleep.8

const DEFAULT_BREAK_MIN = 120;   // a break about every 2 hours is common road-safety advice
const SHORT_BREAK_MIN = 90;

/**
 * @returns {{level:'hold'|'care'|'plan', headline:string, notes:string[], breakEveryMin:number, offerSettle:boolean}}
 */
function departureAdvice({ sleepHours, alertness, comparison }) {
  if (alertness <= 1 || sleepHours < 4) {
    return {
      level: 'hold',
      headline: 'dep.hold',
      notes: [alertness <= 1 ? 'note.fightingSleep' : 'note.sleptUnder4', 'note.restFirst'],
      breakEveryMin: SHORT_BREAK_MIN,
      offerSettle: false,
    };
  }

  const notes = [];
  const above = comparison && comparison.status === 'above';
  let breakEveryMin = DEFAULT_BREAK_MIN;
  let level = 'plan';
  if (sleepHours < 6) { notes.push('note.shortSleep'); breakEveryMin = SHORT_BREAK_MIN; level = 'care'; }
  if (alertness === 2) { notes.push('note.sleepy'); breakEveryMin = SHORT_BREAK_MIN; level = 'care'; }
  if (above) { notes.push('note.aboveUsual', 'note.manyCauses'); level = 'care'; }
  if (comparison && comparison.status === 'building') notes.push('note.building');

  return { level, headline: level === 'plan' ? 'dep.plan' : 'dep.care', notes, breakEveryMin, offerSettle: above };
}

/** Before/after of the settle routine, as numbers. Describes only; never judges. */
function settleSummary(before, after) {
  if (!before || !after || before.quality !== 'good' || after.quality !== 'good') return { unclear: true };
  return {
    unclear: false,
    pulseChange: Math.round(after.pulse - before.pulse),
    breathChange: Math.round((after.breathing - before.breathing) * 10) / 10,
  };
}

const DRIFT = { pulseBpm: 10, breathing: 3 };

function hasDrift(a, b) {
  if (!a || !b || a.quality !== 'good' || b.quality !== 'good') return false;
  const dp = Number.isFinite(a.pulse) && Number.isFinite(b.pulse) ? Math.abs(b.pulse - a.pulse) : 0;
  const db = Number.isFinite(a.breathing) && Number.isFinite(b.breathing) ? Math.abs(b.breathing - a.breathing) : 0;
  return dp >= DRIFT.pulseBpm || db >= DRIFT.breathing;
}

/** Rest-stop advice: compare with the reading when the driver set off, and the driver's own feeling. */
function restStopAdvice({ departure, reading, feeling }) {
  const drift = hasDrift(departure, reading);
  if (feeling <= 1) {
    return { level: 'hold', headline: 'stop.hold', notes: ['note.stopFighting'], offerNap: true, drift };
  }
  if (feeling === 2) {
    const notes = ['note.stopSleepyNap'];
    if (drift) notes.push('note.driftToo', 'note.manyCauses');
    return { level: 'care', headline: 'stop.longer', notes, offerNap: true, drift };
  }
  if (drift) {
    return { level: 'care', headline: 'stop.full', notes: ['note.driftRest', 'note.manyCauses'], offerNap: true, drift };
  }
  return { level: 'plan', headline: 'stop.onPlan', notes: ['note.carryOn'], offerNap: false, drift };
}

module.exports = {
  ALERTNESS, SLEEP, DEFAULT_BREAK_MIN, SHORT_BREAK_MIN, DRIFT,
  departureAdvice, settleSummary, restStopAdvice, hasDrift,
};
