// MileZero renderer: screens, flow and local state.
'use strict';

const QRCode = require('qrcode');
const { ROUTES, getRoute } = require('../core/routes');
const { computeBaseline, compareToBaseline } = require('../core/baseline');
const { ALERTNESS, SLEEP, departureAdvice, settleSummary, restStopAdvice } = require('../core/advice');
const { buildRestPlan, fmtDuration } = require('../core/plan');
const { badgeText } = require('../core/badge');
const { CONSENT_VERSION, emptyState, normalize, prune, newId } = require('../core/store');
const { DemoSensor } = require('../sensor/demo');

// ---------------------------------------------------------------- platform

const browserPreview = typeof window.mz === 'undefined';
const api = browserPreview ? {
  load: async () => { try { return JSON.parse(localStorage.getItem('milezero') || 'null'); } catch { return null; } },
  save: async (d) => { try { localStorage.setItem('milezero', JSON.stringify(d)); } catch { /* preview only */ } return true; },
  wipe: async () => { try { localStorage.removeItem('milezero'); } catch { /* preview only */ } return true; },
  config: async () => ({ apiKey: '', demoSensor: true, platform: 'browser' }),
} : window.mz;

let config = { apiKey: '', demoSensor: true };
let sensor = null;

function makeSensor() {
  if (config.demoSensor || !config.apiKey) return new DemoSensor();
  const { SmartSpectraSensor } = require('../sensor/smartspectra');
  return new SmartSpectraSensor({ apiKey: config.apiKey, telemetry: state.settings.telemetry });
}

// ---------------------------------------------------------------- state

let state = emptyState();
let view = { name: 'loading' };
let activeAbort = null;
let timers = [];

async function save() { await api.save(state); }

const journey = () => state.journeys.find((j) => j.id === state.activeJourneyId) || null;
const readingById = (id) => state.readings.find((r) => r.id === id) || null;

/** The reading that best describes the driver when they set off: after settling, if they did. */
function leavingReading(j) {
  if (!j || !j.departure) return null;
  const settled = j.departure.settle && readingById(j.departure.settle.afterId);
  return settled && settled.quality === 'good' ? settled : readingById(j.departure.readingId);
}

/** Number of distinct planned stops checked so far (re-checks at the same stop don't count). */
const stopsChecked = (j) => new Set(j.checks.map((c) => c.stopIndex)).size;

function addReading(kind, r) {
  const reading = {
    id: newId('r'), at: Date.now(), kind,
    pulse: r.pulse ?? null, breathing: r.breathing ?? null, hrv: r.hrv ?? null,
    quality: r.quality || 'none', source: r.source || 'questions',
  };
  state.readings.push(reading);
  return reading;
}

// ---------------------------------------------------------------- helpers

const $app = () => document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

function clearTimers() { timers.forEach((t) => clearInterval(t)); timers = []; }

function go(name, params = {}) {
  clearTimers();
  if (activeAbort) { activeAbort.aborted = true; activeAbort = null; }
  view = Object.assign({ name }, params);
  render();
  window.scrollTo(0, 0);
}

function on(sel, evt, fn) {
  document.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, fn));
}

function readingChips(r) {
  if (!r || r.quality !== 'good') {
    const why = r && r.source === 'questions' ? 'Questions-only check' : 'No clear reading';
    return `<div class="chips"><span class="chip muted">${why}</span></div>`;
  }
  return `<div class="chips">
    <span class="chip"><b>${r.pulse ?? '—'}</b> bpm pulse</span>
    <span class="chip"><b>${r.breathing ?? '—'}</b> breaths/min</span>
    ${r.hrv ? `<span class="chip"><b>${r.hrv}</b> ms HRV</span>` : ''}
    ${r.source === 'demo' ? '<span class="chip warn">Demo sensor</span>' : ''}
    ${r.source === 'seeded' ? '<span class="chip warn">Seeded demo data</span>' : ''}
  </div>`;
}

function comparisonLine(cmp) {
  if (!cmp) return '';
  if (cmp.status === 'building') return '<p class="quiet">Building your baseline: a few more good checks and MileZero can compare you with your usual.</p>';
  if (cmp.status === 'no-reading') return '';
  const part = (d, unit) => (d == null ? '' : `${d > 0 ? '+' : ''}${Math.round(d * 10) / 10} ${unit}`);
  const diffs = [part(cmp.pulseDiff, 'bpm'), part(cmp.breathDiff, 'breaths/min')].filter(Boolean).join(', ');
  return cmp.status === 'above'
    ? `<p class="callout care">Higher than your usual (${esc(diffs)}).</p>`
    : `<p class="callout ok">Close to your usual (${esc(diffs)}).</p>`;
}

function adviceCard(a) {
  return `<div class="advice ${a.level}">
    <h2>${esc(a.headline)}</h2>
    ${a.notes.map((n) => `<p>${esc(n)}</p>`).join('')}
  </div>`;
}

function shell(inner, { back } = {}) {
  const demo = sensor && sensor instanceof DemoSensor;
  return `
    <header class="top">
      ${back ? `<button class="link back" data-go="${back}">← Back</button>` : '<span></span>'}
      <span class="brand">MileZero</span>
      <button class="link" data-go="settings" aria-label="Settings">Settings</button>
    </header>
    ${demo ? '<div class="demo-banner">Demo sensor: readings are simulated and no camera is used.</div>' : ''}
    <main>${inner}</main>`;
}

function bindNav() {
  on('[data-go]', 'click', (e) => go(e.currentTarget.dataset.go));
}

// ---------------------------------------------------------------- render

function render() {
  const fn = VIEWS[view.name] || VIEWS.home;
  $app().innerHTML = fn();
  bindNav();
  if (AFTER[view.name]) AFTER[view.name]();
}

const VIEWS = {};
const AFTER = {};

VIEWS.loading = () => '<main class="center"><p>Loading…</p></main>';

// ---- consent

VIEWS.consent = () => `
  <main class="narrow">
    <p class="eyebrow">Before you start</p>
    <h1>Your check-in, your data.</h1>
    <ul class="facts">
      <li><b>Camera only when you start a check.</b> It turns off when the check ends.</li>
      <li><b>No video is saved.</b> MileZero keeps only numbers: pulse, breathing, and HRV when available.</li>
      <li><b>Everything stays on this device.</b> No employer dashboard, no automatic reporting.</li>
      <li><b>Not a medical device.</b> MileZero never says you are safe to drive or that you are tired. It helps you plan rest.</li>
      <li><b>Delete everything anytime</b> from Settings.</li>
    </ul>
    <label class="check"><input type="checkbox" id="tele" ${state.settings.telemetry ? 'checked' : ''}>
      Share anonymous SDK usage reports with Presage (off by default). Presage says these never include video or vital signs.</label>
    <label class="check"><input type="checkbox" id="agree"> I understand and agree to use the camera for my own check-ins.</label>
    <button class="primary big" id="continue" disabled>Continue</button>
  </main>`;

AFTER.consent = () => {
  const agree = document.getElementById('agree');
  const btn = document.getElementById('continue');
  agree.addEventListener('change', () => { btn.disabled = !agree.checked; });
  btn.addEventListener('click', async () => {
    state.consent = { at: Date.now(), version: CONSENT_VERSION };
    state.settings.telemetry = document.getElementById('tele').checked;
    sensor = makeSensor();
    await save();
    go('home');
  });
};

// ---- home

VIEWS.home = () => {
  const j = journey();
  const base = computeBaseline(state.readings);
  const last = state.journeys.filter((x) => x.endedAt).sort((a, b) => b.endedAt - a.endedAt)[0];
  return shell(`
    <section class="hero">
      <p class="eyebrow">Tyres, fuel, engine… and you.</p>
      <h1>Check in before you go.</h1>
      ${j ? `<button class="primary big" data-go="trip">Continue current trip</button>`
          : `<button class="primary big" data-go="setup">Start a trip</button>`}
    </section>
    <section class="grid2">
      <div class="card">
        <h3>Your baseline</h3>
        ${base.ready
          ? `<p><b>${Math.round(base.pulse)}</b> bpm pulse · <b>${Math.round(base.breathing * 10) / 10}</b> breaths/min</p><p class="quiet">From your last ${base.count} good departure checks.</p>`
          : `<p>Building: ${base.count} of ${base.needed} good checks.</p><p class="quiet">Until then MileZero relies mainly on your answers.</p>`}
      </div>
      <div class="card">
        <h3>Last trip</h3>
        ${last ? `<p>${esc(last.routeName)}</p><p class="quiet">${fmtDate(last.startedAt)} · ${last.plan ? last.plan.stops.length : 0} planned stops · checked in at ${stopsChecked(last)}</p>`
              : '<p class="quiet">No trips yet.</p>'}
        <button class="link" data-go="history">See history</button>
      </div>
    </section>`);
};

// ---- trip setup

VIEWS.setup = () => shell(`
  <p class="eyebrow">Step 1 of 3</p>
  <h1>Where are you going?</h1>
  <div class="options" id="routes">
    ${ROUTES.map((r) => `<button class="option" data-route="${r.id}">${esc(r.name)}${r.hours ? `<span>about ${r.hours} h</span>` : ''}</button>`).join('')}
  </div>
  <div id="custom" hidden>
    <label class="field">How many hours of driving?
      <input id="hours" type="number" min="1" max="20" step="0.5" value="5"></label>
    <button class="primary" id="customGo">Continue</button>
  </div>`, { back: 'home' });

AFTER.setup = () => {
  on('[data-route]', 'click', (e) => {
    const route = getRoute(e.currentTarget.dataset.route);
    if (route.hours) return startJourney(route, route.hours);
    document.getElementById('custom').hidden = false;
  });
  on('#customGo', 'click', () => {
    const h = parseFloat(document.getElementById('hours').value);
    if (h > 0) startJourney(getRoute('custom'), h);
  });
};

async function startJourney(route, hours) {
  const j = {
    id: newId('j'), startedAt: Date.now(), routeId: route.id,
    routeName: route.id === 'custom' ? `Custom route, ${hours} h` : route.name,
    tripHours: hours, departure: null, plan: null, leftAt: null, checks: [], arrival: null, endedAt: null,
  };
  state.journeys.push(j);
  state.activeJourneyId = j.id;
  await save();
  go('check', { kind: 'departure', seconds: 60 });
}

// ---- camera check (shared by departure, rest stop, arrival)

const CHECK_COPY = {
  departure: { step: 'Step 2 of 3', title: 'Departure check', sub: 'Sit still, face the camera, breathe normally. 60 seconds.' },
  reststop: { step: 'Rest stop', title: 'Rest-stop check', sub: 'Park first. Sit still and face the camera. 30 seconds.' },
  arrival: { step: 'Arrival', title: 'Wind-down check', sub: 'You made it. Sit still for 30 seconds.' },
  'settle-after': { step: 'Settle routine', title: 'Measuring again', sub: 'Breathe normally now. 30 seconds.' },
};

VIEWS.check = () => {
  const c = CHECK_COPY[view.kind];
  return shell(`
    <p class="eyebrow">${c.step}</p>
    <h1>${c.title}</h1>
    <p>${c.sub}</p>
    <div class="camera">
      <video id="video" autoplay playsinline muted></video>
      <div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="track"/><circle cx="60" cy="60" r="52" class="prog" id="prog"/></svg><span id="count">${view.seconds}</span></div>
      <p class="hint" id="hint">Starting the camera…</p>
    </div>
    <div class="live">
      <div><span id="livePulse">—</span><small>bpm pulse</small></div>
      <div><span id="liveBreath">—</span><small>breaths/min</small></div>
      <div><span id="liveQuality" class="badge">Waiting</span><small>signal quality</small></div>
    </div>
    <div id="checkError"></div>
    <div class="row">
      <button class="secondary" id="skip">Skip camera, answer questions only</button>
    </div>`, { back: view.kind === 'departure' ? 'home' : 'trip' });
};

AFTER.check = () => {
  const abort = { aborted: false };
  activeAbort = abort;
  const prog = document.getElementById('prog');
  const C = 2 * Math.PI * 52;
  prog.style.strokeDasharray = `${C}`;
  prog.style.strokeDashoffset = `${C}`;

  const startCountdown = () => {
    const t0 = Date.now();
    timers.push(setInterval(() => {
      const left = Math.max(0, view.seconds - (Date.now() - t0) / 1000);
      const el = document.getElementById('count');
      if (el) el.textContent = Math.ceil(left);
      prog.style.strokeDashoffset = `${C * (left / view.seconds)}`;
    }, 250));
  };

  on('#skip', 'click', () => { abort.aborted = true; afterCheck({ source: 'questions', quality: 'none' }, null); });

  sensor.measure({
    seconds: view.seconds,
    video: document.getElementById('video'),
    abort,
    onRunning: startCountdown,
    onHint: (h) => { const el = document.getElementById('hint'); if (el) el.textContent = h || 'Good. Hold still.'; },
    onLive: (r) => {
      const p = document.getElementById('livePulse'); if (!p) return;
      p.textContent = r.pulse ?? '—';
      document.getElementById('liveBreath').textContent = r.breathing ?? '—';
      const q = document.getElementById('liveQuality');
      q.textContent = r.quality === 'good' ? 'Good reading' : 'Settling…';
      q.className = `badge ${r.quality === 'good' ? 'good' : ''}`;
    },
  }).then((r) => {
    if (abort.aborted) return;
    activeAbort = null;
    afterCheck(r, null);
  }).catch((err) => {
    if (err.cancelled || abort.aborted) return;
    activeAbort = null;
    if (err.connection) {
      afterCheck({ source: 'questions', quality: 'none' }, 'Camera check unavailable: could not reach Presage. Continuing with questions only.');
    } else {
      const box = document.getElementById('checkError');
      if (box) box.innerHTML = `<p class="callout care">The camera check stopped: ${esc(err.message)}</p><button class="primary" id="retry">Try again</button>`;
      on('#retry', 'click', () => go('check', { kind: view.kind, seconds: view.seconds }));
    }
  });
};

async function afterCheck(result, notice) {
  const kindMap = { departure: 'departure', reststop: 'reststop', arrival: 'arrival', 'settle-after': 'settle' };
  const reading = addReading(kindMap[view.kind], result);
  await save();
  const kind = view.kind;
  if (kind === 'departure') go('departureQuestions', { readingId: reading.id, notice });
  else if (kind === 'reststop') go('stopQuestions', { readingId: reading.id, notice, recheck: !!view.recheck });
  else if (kind === 'arrival') go('arrivalQuestions', { readingId: reading.id, notice });
  else if (kind === 'settle-after') finishSettle(reading.id);
}

// ---- departure questions + result

VIEWS.departureQuestions = () => shell(`
  ${view.notice ? `<p class="callout care">${esc(view.notice)}</p>` : ''}
  <p class="eyebrow">Step 3 of 3</p>
  <h1>Three quick questions</h1>
  <h3>How much did you sleep last night?</h3>
  <div class="options" data-q="sleep">${SLEEP.map((s) => `<button class="option" data-v="${s.value}">${s.label}</button>`).join('')}</div>
  <h3>How alert do you feel right now?</h3>
  <div class="options" data-q="alert">${ALERTNESS.map((a) => `<button class="option" data-v="${a.value}">${a.label}</button>`).join('')}</div>
  <h3>Trip length</h3>
  <p>${esc(journey().routeName)}: about <b>${journey().tripHours} h</b> of driving.</p>
  <button class="primary big" id="done" disabled>See my plan</button>`);

AFTER.departureQuestions = () => {
  const ans = {};
  on('.options button', 'click', (e) => {
    const group = e.currentTarget.parentElement;
    group.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    e.currentTarget.classList.add('on');
    ans[group.dataset.q] = parseFloat(e.currentTarget.dataset.v);
    document.getElementById('done').disabled = !(ans.sleep && ans.alert);
  });
  on('#done', 'click', async () => {
    const j = journey();
    const reading = readingById(view.readingId);
    // Compare against the baseline built from EARLIER checks, not this one.
    const base = computeBaseline(state.readings.filter((r) => r.id !== reading.id));
    const comparison = compareToBaseline(reading, base);
    const advice = departureAdvice({ sleepHours: ans.sleep, alertness: ans.alert, comparison });
    j.departure = { readingId: reading.id, answers: { sleepHours: ans.sleep, alertness: ans.alert }, comparison, advice, settle: null };
    await save();
    go('departureResult');
  });
};

VIEWS.departureResult = () => {
  const d = journey().departure;
  const r = readingById(d.readingId);
  return shell(`
    <p class="eyebrow">Your departure check</p>
    ${readingChips(r)}
    ${comparisonLine(d.comparison)}
    ${d.settle ? `<p class="callout ok">${esc(d.settle.summary)}</p>` : ''}
    ${adviceCard(d.settle ? Object.assign({}, d.advice, { notes: d.advice.notes.filter((n) => !n.includes('settle routine')) }) : d.advice)}
    <div class="row">
      ${d.advice.offerSettle && !d.settle ? '<button class="primary big" data-go="settle">Do the 60-second settle routine</button>' : ''}
      ${d.advice.level === 'hold'
        ? '<button class="secondary" id="endHold">End check-in and rest</button>'
        : `<button class="${d.advice.offerSettle && !d.settle ? 'secondary' : 'primary big'}" id="toPlan">Make my rest plan</button>`}
    </div>`);
};

AFTER.departureResult = () => {
  on('#toPlan', 'click', async () => {
    const j = journey();
    const route = getRoute(j.routeId);
    j.plan = { breakEveryMin: j.departure.advice.breakEveryMin, stops: buildRestPlan(route, j.tripHours, j.departure.advice.breakEveryMin) };
    await save();
    go('plan');
  });
  on('#endHold', 'click', async () => {
    const j = journey();
    j.endedAt = Date.now();
    j.cancelled = 'rest-first';
    state.activeJourneyId = null;
    await save();
    go('home');
  });
};

// ---- settle routine: 60 s guided breathing with live feedback, then re-measure

VIEWS.settle = () => shell(`
  <p class="eyebrow">Settle routine</p>
  <h1>Breathe with the circle</h1>
  <p>In as it grows, out as it shrinks. One minute.</p>
  <div class="breathe"><div class="orb" id="orb"></div><p id="phase">Breathe in</p></div>
  <div class="live">
    <div><span id="liveBreath">—</span><small>your breathing now</small></div>
    <div><span id="count">60</span><small>seconds left</small></div>
  </div>
  <video id="video" autoplay playsinline muted class="mini"></video>`, { back: 'departureResult' });

AFTER.settle = () => {
  const abort = { aborted: false };
  activeAbort = abort;
  const orb = document.getElementById('orb');
  const phase = document.getElementById('phase');
  let inhale = true;
  const cycle = () => { orb.className = `orb ${inhale ? 'grow' : 'shrink'}`; phase.textContent = inhale ? 'Breathe in' : 'Breathe out'; };
  cycle();
  // 4 s in, 6 s out: about 6 breaths a minute.
  const step = () => { inhale = !inhale; cycle(); timers.push(setTimeout(step, inhale ? 4000 : 6000)); };
  timers.push(setTimeout(step, 4000));
  const t0 = Date.now();
  timers.push(setInterval(() => { const el = document.getElementById('count'); if (el) el.textContent = Math.max(0, Math.ceil(60 - (Date.now() - t0) / 1000)); }, 250));

  sensor.measure({
    seconds: 60, abort, video: document.getElementById('video'),
    onLive: (r) => { const el = document.getElementById('liveBreath'); if (el && r.breathing) el.textContent = r.breathing; },
  }).then(() => { if (!abort.aborted) { activeAbort = null; go('check', { kind: 'settle-after', seconds: 30 }); } })
    .catch((err) => { if (!abort.aborted && !err.cancelled) { activeAbort = null; go('check', { kind: 'settle-after', seconds: 30 }); } });
};

async function finishSettle(afterId) {
  const d = journey().departure;
  const before = readingById(d.readingId);
  const after = readingById(afterId);
  d.settle = { afterId, summary: settleSummary(before, after).text };
  await save();
  go('departureResult');
}

// ---- plan + passenger badge

VIEWS.plan = () => {
  const j = journey();
  return shell(`
    <p class="eyebrow">${esc(j.routeName)}</p>
    <h1>Your rest plan</h1>
    <p>A break about every <b>${fmtDuration(j.plan.breakEveryMin)}</b>. ${j.plan.breakEveryMin < 120 ? 'Shorter than usual because of today\'s check-in.' : ''}</p>
    <ol class="stops">
      <li class="start"><b>Depart</b><span>0 h</span></li>
      ${j.plan.stops.map((s) => `<li><b>${esc(s.name)}</b><span>${s.town ? `about ${fmtDuration(s.atMin)} in` : ''}</span></li>`).join('')}
      <li class="end"><b>Arrive</b><span>about ${fmtDuration(j.tripHours * 60)}</span></li>
    </ol>
    ${j.plan.stops.length === 0 ? '<p class="quiet">Short trip: no planned stops. Pull over if you feel sleepy.</p>' : ''}
    <p class="quiet">Times are approximate. Your plan is saved on this device.</p>
    <div class="row">
      <button class="secondary" data-go="badge">Show passenger badge</button>
      <button class="primary big" id="leave">I'm setting off</button>
    </div>`);
};

AFTER.plan = () => {
  on('#leave', 'click', async () => { journey().leftAt = Date.now(); await save(); go('trip'); });
};

VIEWS.badge = () => shell(`
  <p class="eyebrow">Passenger badge</p>
  <h1>Checked in for this trip</h1>
  <p>Passengers can scan this. It shows only that you checked in and how many stops you planned. <b>No health data.</b></p>
  <div class="badge-card"><img id="qr" alt="Check-in QR code"><pre id="badgeText"></pre></div>`, { back: 'plan' });

AFTER.badge = () => {
  const j = journey();
  const text = badgeText({ checkedAt: j.departure ? readingById(j.departure.readingId).at : j.startedAt, routeName: j.routeName, stopCount: j.plan.stops.length });
  document.getElementById('badgeText').textContent = text;
  QRCode.toDataURL(text, { margin: 1, width: 240 }).then((url) => { const img = document.getElementById('qr'); if (img) img.src = url; });
};

// ---- on the road

VIEWS.trip = () => {
  const j = journey();
  if (!j) return VIEWS.home();
  if (!j.plan) return shell('<h1>Finish your departure check first.</h1><button class="primary" id="resume">Continue</button>');
  const done = stopsChecked(j);
  const next = j.plan.stops[done];
  return shell(`
    <p class="eyebrow">${esc(j.routeName)}</p>
    <h1>${next ? `Next stop: ${esc(next.name)}` : 'No more planned stops'}</h1>
    ${next ? `<p>${next.town ? `About ${fmtDuration(next.atMin)} after departure.` : ''} Driving for <b id="elapsed">${fmtDuration(Math.round((Date.now() - (j.leftAt || Date.now())) / 60000))}</b>.</p>` : '<p>Pull over if you feel sleepy at any point.</p>'}
    <ol class="stops">
      ${j.plan.stops.map((s, i) => `<li class="${i < done ? 'done' : i === done ? 'next' : ''}"><b>${esc(s.name)}</b><span>${i < done ? 'checked' : s.town ? `about ${fmtDuration(s.atMin)}` : ''}</span></li>`).join('')}
    </ol>
    <p class="callout">Never use MileZero while driving. Park first.</p>
    <div class="row">
      <button class="primary big" id="atStop">I'm parked at a rest stop</button>
      <button class="secondary" id="arrived">I've arrived</button>
    </div>`);
};

AFTER.trip = () => {
  on('#resume', 'click', () => go('departureResult'));
  on('#atStop', 'click', () => go('check', { kind: 'reststop', seconds: 30 }));
  on('#arrived', 'click', () => go('check', { kind: 'arrival', seconds: 30 }));
  timers.push(setInterval(() => {
    const el = document.getElementById('elapsed'); const j = journey();
    if (el && j) el.textContent = fmtDuration(Math.round((Date.now() - (j.leftAt || Date.now())) / 60000));
  }, 30000));
};

// ---- rest stop

VIEWS.stopQuestions = () => shell(`
  ${view.notice ? `<p class="callout care">${esc(view.notice)}</p>` : ''}
  <p class="eyebrow">Rest stop</p>
  <h1>How do you feel right now?</h1>
  <div class="options">${ALERTNESS.map((a) => `<button class="option" data-v="${a.value}">${a.label}</button>`).join('')}</div>`);

AFTER.stopQuestions = () => {
  on('.options button', 'click', async (e) => {
    const feeling = parseInt(e.currentTarget.dataset.v, 10);
    const j = journey();
    const departure = leavingReading(j);
    const reading = readingById(view.readingId);
    const advice = restStopAdvice({ departure, reading, feeling });
    const last = j.checks[j.checks.length - 1];
    const stopIndex = view.recheck && last ? last.stopIndex : stopsChecked(j);
    j.checks.push({ at: Date.now(), stopIndex, recheck: !!view.recheck, readingId: reading.id, feeling, advice });
    await save();
    go('stopResult');
  });
};

VIEWS.stopResult = () => {
  const j = journey();
  const c = j.checks[j.checks.length - 1];
  const r = readingById(c.readingId);
  const dep = leavingReading(j);
  return shell(`
    <p class="eyebrow">Rest stop ${c.stopIndex + 1}${c.recheck ? ', check again' : ''}</p>
    <div class="compare">
      <div><small>When you set off</small>${readingChips(dep)}</div>
      <div><small>Now</small>${readingChips(r)}</div>
    </div>
    ${adviceCard(c.advice)}
    <div class="row">
      ${c.advice.offerNap ? '<button class="primary big" data-go="nap">Start a 20-minute nap timer</button>' : ''}
      ${c.advice.level === 'hold' ? '' : `<button class="${c.advice.offerNap ? 'secondary' : 'primary big'}" data-go="trip">Continue my trip</button>`}
      <button class="secondary" id="again">Check again</button>
    </div>`);
};

AFTER.stopResult = () => {
  on('#again', 'click', () => go('check', { kind: 'reststop', seconds: 30, recheck: true }));
};

// ---- nap timer

VIEWS.nap = () => shell(`
  <p class="eyebrow">Nap timer</p>
  <h1 class="timer" id="napLeft">20:00</h1>
  <p>Park somewhere safe, lock the doors, and rest. An alarm will sound when time is up.</p>
  <div class="row"><button class="secondary" id="stopNap">Stop timer</button></div>`, { back: 'stopResult' });

AFTER.nap = () => {
  const end = Date.now() + 20 * 60 * 1000;
  timers.push(setInterval(() => {
    const left = Math.max(0, end - Date.now());
    const el = document.getElementById('napLeft');
    if (el) el.textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    if (left === 0) { clearTimers(); alarm(); go('napDone'); }
  }, 500));
  on('#stopNap', 'click', () => go('napDone'));
};

VIEWS.napDone = () => shell(`
  <h1>Welcome back.</h1>
  <p>Give yourself a few minutes to wake up fully, then check in again before you drive.</p>
  <div class="row"><button class="primary big" id="recheck">Check in again</button></div>`);

AFTER.napDone = () => on('#recheck', 'click', () => go('check', { kind: 'reststop', seconds: 30, recheck: true }));

function alarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.6, 1.2, 1.8].forEach((t) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.3, ctx.currentTime + t); g.gain.setValueAtTime(0, ctx.currentTime + t + 0.4);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.4);
    });
  } catch { /* no audio available */ }
}

// ---- arrival

VIEWS.arrivalQuestions = () => shell(`
  ${view.notice ? `<p class="callout care">${esc(view.notice)}</p>` : ''}
  <p class="eyebrow">Arrival</p>
  <h1>How tired are you now?</h1>
  <div class="options">${ALERTNESS.map((a) => `<button class="option" data-v="${a.value}">${a.label}</button>`).join('')}</div>`);

AFTER.arrivalQuestions = () => {
  on('.options button', 'click', async (e) => {
    const j = journey();
    j.arrival = { at: Date.now(), readingId: view.readingId, feeling: parseInt(e.currentTarget.dataset.v, 10) };
    j.endedAt = Date.now();
    state.activeJourneyId = null;
    await save();
    go('arrivalDone', { journeyId: j.id });
  });
};

VIEWS.arrivalDone = () => {
  const j = state.journeys.find((x) => x.id === view.journeyId);
  const mins = j.leftAt ? Math.round((j.endedAt - j.leftAt) / 60000) : null;
  return shell(`
    <p class="eyebrow">Trip complete</p>
    <h1>Well done. Time to rest.</h1>
    <div class="card">
      <p>${esc(j.routeName)}${mins ? ` · ${fmtDuration(mins)} on the road` : ''}</p>
      <p>Checked in at ${stopsChecked(j)} of ${j.plan ? j.plan.stops.length : 0} planned stops.</p>
      ${j.arrival.feeling <= 2 ? '<p class="callout care">You said you feel sleepy. Get proper sleep before your next trip.</p>' : ''}
    </div>
    <p class="quiet">Your departure readings build your personal baseline for next time.</p>
    <button class="primary big" data-go="home">Done</button>`);
};

// ---- history

VIEWS.history = () => {
  const list = state.journeys.slice().sort((a, b) => b.startedAt - a.startedAt);
  return shell(`
    <h1>History</h1>
    <p class="quiet">Kept on this device for ${state.settings.retentionDays} days.</p>
    ${list.length ? list.map((j) => {
      const dep = j.departure ? readingById(j.departure.readingId) : null;
      return `<div class="card"><h3>${esc(j.routeName)}</h3><p class="quiet">${fmtDate(j.startedAt)} ${fmtTime(j.startedAt)} · ${j.cancelled ? 'Rested instead of driving' : j.endedAt ? 'Completed' : 'In progress'}</p>
        ${readingChips(dep)}
        <p class="quiet">${j.plan ? `${j.plan.stops.length} planned stops · checked in at ${stopsChecked(j)}` : 'No plan made'}</p></div>`;
    }).join('') : '<p>No trips yet.</p>'}`, { back: 'home' });
};

// ---- settings

VIEWS.settings = () => shell(`
  <h1>Settings and your data</h1>
  <div class="card">
    <h3>Keep history for</h3>
    <div class="options" id="ret">${[30, 90, 180].map((d) => `<button class="option ${state.settings.retentionDays === d ? 'on' : ''}" data-d="${d}">${d} days</button>`).join('')}</div>
  </div>
  <div class="card">
    <label class="check"><input type="checkbox" id="tele" ${state.settings.telemetry ? 'checked' : ''}>
      Share anonymous SDK usage reports with Presage. Presage says these never include video or vital signs.</label>
  </div>
  <div class="card">
    <h3>What MileZero stores</h3>
    <p>${state.readings.length} readings (numbers only) and ${state.journeys.length} trips, all on this device. No video, no images.</p>
    <p class="quiet">Measuring with: ${esc(sensor ? sensor.label : '—')}</p>
    <button class="danger" id="wipe">Delete all my data</button>
    <div id="confirm" hidden><p class="callout care">This erases every reading, trip and setting on this device. It cannot be undone.</p>
      <button class="danger" id="wipeYes">Yes, delete everything</button> <button class="secondary" id="wipeNo">Keep my data</button></div>
  </div>`, { back: 'home' });

AFTER.settings = () => {
  on('#ret .option', 'click', async (e) => { state.settings.retentionDays = parseInt(e.currentTarget.dataset.d, 10); state = prune(state); await save(); render(); });
  on('#tele', 'change', async (e) => { state.settings.telemetry = e.currentTarget.checked; sensor = makeSensor(); await save(); });
  on('#wipe', 'click', () => { document.getElementById('confirm').hidden = false; });
  on('#wipeNo', 'click', () => { document.getElementById('confirm').hidden = true; });
  on('#wipeYes', 'click', async () => { await api.wipe(); state = emptyState(); go('consent'); });
};

// ---------------------------------------------------------------- boot

(async function boot() {
  try { config = await api.config(); } catch { /* keep defaults */ }
  state = prune(normalize(await api.load()));
  await save();
  sensor = makeSensor();
  if (browserPreview) window.__mz = { state: () => state, sensor: () => sensor, go };
  go(state.consent ? (state.activeJourneyId ? 'trip' : 'home') : 'consent');
})();
