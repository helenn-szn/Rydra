// What Rydra says to the driver. Rules:
// 1. Never say "safe to drive" or "you are fatigued". We describe readings and suggest plans.
// 2. What the driver reports about sleepiness always wins over the camera.
// 3. Every comparison carries a plain note that readings change for many reasons.
'use strict';

const ALERTNESS = [
  { value: 1, label: 'Fighting to stay awake' },
  { value: 2, label: 'Sleepy' },
  { value: 3, label: 'Okay' },
  { value: 4, label: 'Alert' },
  { value: 5, label: 'Very alert' },
];

const SLEEP = [
  { value: 3, label: 'Under 4 hours' },
  { value: 4.5, label: '4 to 5 hours' },
  { value: 6.5, label: '6 to 7 hours' },
  { value: 8, label: '8 hours or more' },
];

const MANY_CAUSES = 'Pulse and breathing change for many reasons, like heat, coffee, stress or rushing around. They do not show tiredness on their own.';

const DEFAULT_BREAK_MIN = 120;   // a break about every 2 hours is common road-safety advice
const SHORT_BREAK_MIN = 90;

/**
 * Departure advice from the driver's answers plus the baseline comparison.
 * @returns {{level:'hold'|'care'|'plan', headline:string, notes:string[], breakEveryMin:number, offerSettle:boolean}}
 */
function departureAdvice({ sleepHours, alertness, comparison }) {
  const notes = [];
  const above = comparison && comparison.status === 'above';

  if (alertness <= 1 || sleepHours < 4) {
    return {
      level: 'hold',
      headline: "Don't start this trip until you've rested.",
      notes: [
        alertness <= 1 ? 'You said you are fighting to stay awake.' : 'You slept under 4 hours.',
        'Rest first, then check in again. This advice stands whatever your readings show.',
      ],
      breakEveryMin: SHORT_BREAK_MIN,
      offerSettle: false,
    };
  }

  let breakEveryMin = DEFAULT_BREAK_MIN;
  let level = 'plan';
  if (sleepHours < 6) { notes.push('You slept under 6 hours, so your plan has more frequent breaks.'); breakEveryMin = SHORT_BREAK_MIN; level = 'care'; }
  if (alertness === 2) { notes.push('You said you feel sleepy, so your plan has more frequent breaks.'); breakEveryMin = SHORT_BREAK_MIN; level = 'care'; }
  if (above) { notes.push('Your readings are higher than your usual. Try the 60-second settle routine before you set off.'); notes.push(MANY_CAUSES); level = 'care'; }
  if (comparison && comparison.status === 'building') notes.push('Still building your baseline, so this check relies mostly on your answers.');

  return {
    level,
    headline: level === 'plan' ? "Here's your rest plan for today." : 'Take it easy today. Your plan has extra care built in.',
    notes,
    breakEveryMin,
    offerSettle: above,
  };
}

/** Before/after of the settle routine. Describes only; never judges. */
function settleSummary(before, after) {
  if (!before || !after || before.quality !== 'good' || after.quality !== 'good') {
    return { text: 'We could not get a clear reading both times, so there is no before-and-after this time.' };
  }
  const p = Math.round(after.pulse - before.pulse);
  const b = Math.round((after.breathing - before.breathing) * 10) / 10;
  const dir = (n, unit) => (n === 0 ? `no change in ${unit}` : `${unit} ${n < 0 ? 'down' : 'up'} ${Math.abs(n)}`);
  return {
    pulseChange: p,
    breathChange: b,
    text: `After settling: ${dir(p, 'pulse')} bpm, ${dir(b, 'breathing')} breaths/min.`,
  };
}

/**
 * Rest-stop advice: compare with the departure reading and the driver's own feeling.
 * @param {{departure?:object, reading?:object, feeling:number}} args
 */
function restStopAdvice({ departure, reading, feeling }) {
  const drift = hasDrift(departure, reading);

  if (feeling <= 1) {
    return {
      level: 'hold',
      headline: "Don't continue yet.",
      notes: ['You said you are fighting to stay awake. Take a proper rest or a nap, then check in again.'],
      offerNap: true,
      drift,
    };
  }
  if (feeling === 2) {
    const notes = ['You said you feel sleepy. A 20-minute nap before you continue is a good idea.'];
    if (drift) notes.push('Your readings have also changed since you set off.', MANY_CAUSES);
    return { level: 'care', headline: 'Take a longer break.', notes, offerNap: true, drift };
  }
  if (drift) {
    return {
      level: 'care',
      headline: 'Take your full planned break.',
      notes: ['Your readings have changed since you set off. Rest for the whole break and check again before you leave.', MANY_CAUSES],
      offerNap: true,
      drift,
    };
  }
  return { level: 'plan', headline: "You're on plan.", notes: ['Take your planned break, then carry on to your next stop.'], offerNap: false, drift };
}

const DRIFT = { pulseBpm: 10, breathing: 3 };

function hasDrift(a, b) {
  if (!a || !b || a.quality !== 'good' || b.quality !== 'good') return false;
  const dp = Number.isFinite(a.pulse) && Number.isFinite(b.pulse) ? Math.abs(b.pulse - a.pulse) : 0;
  const db = Number.isFinite(a.breathing) && Number.isFinite(b.breathing) ? Math.abs(b.breathing - a.breathing) : 0;
  return dp >= DRIFT.pulseBpm || db >= DRIFT.breathing;
}

module.exports = {
  ALERTNESS, SLEEP, MANY_CAUSES, DEFAULT_BREAK_MIN, SHORT_BREAK_MIN, DRIFT,
  departureAdvice, settleSummary, restStopAdvice, hasDrift,
};
