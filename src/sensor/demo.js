// DEMO SENSOR: simulated readings for development and screen previews, with no camera.
// The app labels every demo reading as "Demo sensor" so it is never mistaken for a real measurement.
'use strict';

const { summarize } = require('./summarize');

class DemoSensor {
  constructor() {
    this.label = 'Demo sensor (simulated, no camera)';
    this.scenario = 'usual';      // 'usual' | 'elevated' | 'settled' | 'drift'
  }

  measure({ seconds, onLive, onHint, onRunning, abort }) {
    const centre = {
      usual: { pulse: 71, breathing: 14.2 },
      elevated: { pulse: 88, breathing: 19.0 },
      settled: { pulse: 76, breathing: 15.1 },
      drift: { pulse: 59, breathing: 11.0 },
    }[this.scenario] || { pulse: 71, breathing: 14.2 };

    const acc = { pulse: [], breathing: [], hrv: [] };
    const jitter = (s) => (Math.random() - 0.5) * 2 * s;
    const ticks = Math.max(1, Math.round(seconds * 2));

    return new Promise((resolve, reject) => {
      if (onHint) onHint('tuning');
      if (onRunning) onRunning();
      let i = 0;
      const iv = setInterval(() => {
        if (abort && abort.aborted) { clearInterval(iv); const e = new Error('Cancelled'); e.cancelled = true; reject(e); return; }
        i += 1;
        if (onHint && i === 2) onHint('tooDark');
        if (onHint && i === 4) onHint('ok');
        if (i > 4) acc.pulse.push(centre.pulse + jitter(2));
        if (i > 8 && i % 3 === 0) acc.breathing.push(centre.breathing + jitter(0.6));
        if (seconds >= 60 && i > 20 && i % 5 === 0) acc.hrv.push(42 + jitter(6));
        if (onLive) onLive(summarize(acc));
        if (i >= ticks) { clearInterval(iv); resolve(Object.assign(summarize(acc), { source: 'demo' })); }
      }, 500);
    });
  }
}

module.exports = { DemoSensor };
