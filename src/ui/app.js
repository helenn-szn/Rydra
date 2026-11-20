// Rydra renderer: screens, flow and local state.
'use strict';

const QRCode = require('qrcode');
const { computeBaseline, compareToBaseline, MIN_READINGS } = require('../core/baseline');
const { ALERTNESS, SLEEP, departureAdvice, settleSummary, restStopAdvice } = require('../core/advice');
const { buildRestPlan } = require('../core/plan');
const { pointAtMinute, unitsForLocale, fmtDistance } = require('../core/geo');
const { badgeText } = require('../core/badge');
const { PROFILES, getProfile } = require('../core/profiles');
const { CONSENT_VERSION, emptyState, normalize, prune, newId } = require('../core/store');
const { DemoSensor } = require('../sensor/demo');
const { t, setLang, getLang, detectLang, LANGS } = require('./i18n');
const { ICONS, LOGO, dots, statusTag } = require('./icons');
const { roadScene } = require('./scene');
const mapsvc = require('./mapsvc');
const { drawRoute, destroyMap } = require('./map');

// ---------------------------------------------------------------- platform

const browserPreview = typeof window.mz === 'undefined';
const api = browserPreview ? {
  load: async () => { try { return JSON.parse(localStorage.getItem('rydra') || 'null'); } catch { return null; } },
  save: async (d) => { try { localStorage.setItem('rydra', JSON.stringify(d)); } catch { /* preview only */ } return true; },
  wipe: async () => { try { localStorage.removeItem('rydra'); } catch { /* preview only */ } return true; },
  config: async () => ({ apiKey: '', demoSensor: true, platform: 'browser', keySource: 'none' }),
  setKey: async () => true,
} : window.mz;

let config = { apiKey: '', demoSensor: true };
let sensor = null;

function makeSensor() {
  if (config.demoSensor || !config.apiKey) return new DemoSensor();
  const { SmartSpectraSensor } = require('../sensor/smartspectra');
  const s = new SmartSpectraSensor({ apiKey: config.apiKey, telemetry: state.settings.telemetry });
  s.cameraId = state.settings.cameraId || null;
  return s;
}

// ---------------------------------------------------------------- state

let state = emptyState();
let view = { name: 'loading' };
let activeAbort = null;
let timers = [];

async function save() { await api.save(state); }

const journey = () => state.journeys.find((j) => j.id === state.activeJourneyId) || null;
const readingById = (id) => state.readings.find((r) => r.id === id) || null;
const profile = () => getProfile(state.settings.profile);
const mode = () => profile().mode;                       // 'trip' | 'shift'
const jmode = (j) => (j && j.mode) || mode();
const units = () => state.settings.units || unitsForLocale(navigator.language);

function addReading(kind, r) {
  const reading = {
    id: newId('r'), at: Date.now(), kind,
    pulse: r.pulse ?? null, breathing: r.breathing ?? null, hrv: r.hrv ?? null,
    quality: r.quality || 'none', source: r.source || 'questions',
  };
  state.readings.push(reading);
  return reading;
}

/** The reading that best describes the driver when they set off: after settling, if they did. */
function leavingReading(j) {
  if (!j || !j.departure) return null;
  const settled = j.departure.settle && readingById(j.departure.settle.afterId);
  return settled && settled.quality === 'good' ? settled : readingById(j.departure.readingId);
}

/** Distinct planned breaks checked so far (re-checks at the same stop don't count). */
const stopsChecked = (j) => new Set(j.checks.map((c) => c.stopIndex)).size;

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const locale = () => ({ en: undefined, pcm: 'en-NG', fr: 'fr', es: 'es' }[getLang()]);
const fmtDate = (ts) => new Date(ts).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
const fmtClock = (ts) => new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function dur(min) {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60); const r = m % 60;
  if (!h) return t('time.m', { m: r });
  return r ? t('time.hm', { h, m: r }) : t('time.h', { h });
}

function clearTimers() { timers.forEach((x) => { clearInterval(x); clearTimeout(x); }); timers = []; }

function go(name, params = {}) {
  clearTimers();
  destroyMap();
  if (activeAbort) { activeAbort.aborted = true; activeAbort = null; }
  view = Object.assign({ name }, params);
  render();
  window.scrollTo(0, 0);
}

function on(sel, evt, fn) { document.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, fn)); }

function applyTheme() {
  const pref = state.settings.theme || 'auto';
  const h = new Date().getHours();
  const night = pref === 'night' || (pref === 'auto' && (h >= 19 || h < 6));
  document.documentElement.dataset.theme = night ? 'night' : 'day';
  document.documentElement.lang = getLang() === 'pcm' ? 'pcm' : getLang();
}

// ---------------------------------------------------------------- shared pieces

const CAMERA_VIEWS = new Set(['check', 'settle']);

function shell(inner, { back, actions, wide } = {}) {
  const demo = sensor && sensor instanceof DemoSensor;
  return `
    <header class="top">
      <div class="top-l">
        ${back ? `<button class="icon-btn" data-go="${back}" aria-label="${t('nav.back')}">${ICONS.back}</button>` : ''}
        <span class="brand">${LOGO}<span>Rydra</span></span>
      </div>
      ${CAMERA_VIEWS.has(view.name) ? `<span class="cam-on" role="status"><i></i>${t('camera.on')}</span>` : `<button class="pill-btn" data-go="settings">${t('nav.settings')}</button>`}
    </header>
    ${demo ? `<p class="demo-note"><span>${t('demo.banner')}</span></p>` : ''}
    <main id="main" class="${wide ? 'wide' : ''}">${inner}</main>
    ${actions ? `<div class="actions"><div class="actions-in">${actions}</div></div>` : ''}`;
}

function bindNav() { on('[data-go]', 'click', (e) => go(e.currentTarget.dataset.go)); }

/** Lane-dash progress through the start-of-trip flow. */
function steps(active) {
  const names = [mode() === 'shift' ? 'step.shift' : 'step.trip', 'step.check', 'step.questions', 'step.plan'];
  return `<ol class="steps" aria-label="Progress">${names.map((n, i) => `<li class="${i < active ? 'done' : i === active ? 'now' : ''}" ${i === active ? 'aria-current="step"' : ''}><span>${t(n)}</span></li>`).join('')}</ol>`;
}

/** A result card: status (dots + words), headline, notes. */
function resultSign(level, headlineKey, notes) {
  return `<section class="result ${level}">
    ${statusTag(level, t(`state.${level}`))}
    <h2>${t(headlineKey)}</h2>
    ${notes.map((n) => `<p>${t(n)}</p>`).join('')}
  </section>`;
}

function sourceChip(r) {
  if (!r) return '';
  if (r.source === 'demo') return `<span class="chip warn">${t('chip.demo')}</span>`;
  if (r.source === 'seeded') return `<span class="chip warn">${t('chip.seeded')}</span>`;
  if (r.source === 'questions') return `<span class="chip">${t('chip.questions')}</span>`;
  if (r.quality !== 'good') return `<span class="chip">${t('chip.noReading')}</span>`;
  return '';
}

/**
 * Range bar: the driver's usual band, with markers for today's values.
 * @param {{label:string, unit:string, range?:[number,number], markers:{value:number,label:string,kind:string}[]}} o
 */
function rangeBar({ label, unit, range, markers }) {
  const vals = markers.map((m) => m.value).filter(Number.isFinite);
  if (!vals.length) return '';
  const all = range ? vals.concat(range) : vals;
  const span = Math.max(...all) - Math.min(...all);
  const pad = Math.max(span * 0.35, unit === 'bpm' ? 8 : 2);
  const lo = Math.min(...all) - pad; const hi = Math.max(...all) + pad;
  const pos = (v) => `${((v - lo) / (hi - lo)) * 100}%`;
  return `<figure class="range">
    <figcaption><span>${label}</span><b>${markers.map((m) => `${Math.round(m.value * 10) / 10}`).join(' → ')} <small>${unit === 'bpm' ? t('unit.bpm') : t('unit.brpm')}</small></b></figcaption>
    <div class="range-track">
      ${range ? `<div class="range-band" style="left:${pos(range[0])};width:calc(${pos(range[1])} - ${pos(range[0])})" title="${t('range.usual')}"></div>` : ''}
      ${markers.map((m) => `<div class="range-mark ${m.kind}" style="left:${pos(m.value)}"><span>${esc(m.label)}</span></div>`).join('')}
    </div>
    ${range ? `<p class="range-key"><i class="key-band"></i>${t('range.usual')}: ${Math.round(range[0] * 10) / 10}–${Math.round(range[1] * 10) / 10}</p>` : ''}
  </figure>`;
}

function readingBars(markersFor, base) {
  return `<div class="ranges">
    ${rangeBar({ label: t('range.pulse'), unit: 'bpm', range: base && base.ready ? base.pulseRange : null, markers: markersFor('pulse') })}
    ${rangeBar({ label: t('range.breathing'), unit: 'brpm', range: base && base.ready ? base.breathingRange : null, markers: markersFor('breathing') })}
  </div>`;
}

/** Progress toward the first baseline, or the moment it becomes ready. */
function baselineProgress(readingId) {
  const before = computeBaseline(state.readings.filter((r) => r.id !== readingId));
  if (before.ready) return '';
  const after = computeBaseline(state.readings);
  // A check within 4 h of another replaces it rather than adding one, so the count stays the same.
  const counted = after.count > before.count;
  if (after.ready) {
    return `<section class="progress-card ready">${statusTag('plan', t('scene.ready'))}<p>${t('base.ready')}</p></section>`;
  }
  return `<section class="progress-card">
    <div class="seg-meter" aria-hidden="true">${Array.from({ length: MIN_READINGS }, (_, i) => `<i class="${i < after.count ? 'on' : ''}"></i>`).join('')}</div>
    <p><b>${t('base.checkN', { n: after.count, needed: MIN_READINGS })}</b></p>
    ${readingId && !counted && readingById(readingId) && readingById(readingId).quality === 'good' ? `<p class="quiet">${t('base.notCounted')}</p>` : ''}
  </section>`;
}

function optionGrid(name, values, labelKey, selected) {
  return `<div class="tiles" data-q="${name}" role="radiogroup">${values.map((v) => `<button class="tile ${selected === v ? 'on' : ''}" role="radio" aria-checked="${selected === v}" data-v="${v}">${t(`${labelKey}.${v}`)}</button>`).join('')}</div>`;
}

// ---------------------------------------------------------------- cameras

/** Video cameras with readable names. Windows hides names until camera permission is granted,
 *  so if names are blank (and no check is running) we open the camera for a moment to unlock them. */
async function listCameras({ probe = false } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  let cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  if (probe && cams.some((c) => !c.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      s.getTracks().forEach((tr) => tr.stop());
      cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch { /* permission refused: keep generic names */ }
  }
  return cams.map((c, i) => ({ id: c.deviceId, name: c.label || `${t('check.camera')} ${i + 1}` }));
}

function cameraOptions(cams) {
  return `<option value="">${t('settings.cameraAuto')}</option>` + cams.map((c) => `<option value="${esc(c.id)}" ${c.id === state.settings.cameraId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

// ---------------------------------------------------------------- render

const VIEWS = {};
const AFTER = {};

function render() {
  applyTheme();
  document.body.classList.toggle('camera-live', CAMERA_VIEWS.has(view.name));
  const fn = VIEWS[view.name] || VIEWS.home;
  document.getElementById('app').innerHTML = fn();
  bindNav();
  if (AFTER[view.name]) AFTER[view.name]();
}

VIEWS.loading = () => `<main class="center"><p>${t('loading')}</p></main>`;

// ---- intro: three cards, shown once

function introCard(i) {
  if (i === 1) {
    return `${statusTag('plan', t('check.good'))}
      <h4>${t('check.departure.title')}</h4><p class="card-sub">${t('check.departure.sub')}</p>
      <div class="card-row">${ICONS.heart}<span>${t('range.pulse')}</span><b>71 ${t('unit.bpm')}</b></div>
      <div class="card-row">${ICONS.wind}<span>${t('range.breathing')}</span><b>14 ${t('unit.brpm')}</b></div>`;
  }
  if (i === 2) {
    return `<span class="chip-soft">${t('home.baseline')}</span>
      <h4>${t('range.usual')}</h4>
      <div class="mini-range"><i style="left:38%;width:22%"></i><b style="left:47%"></b></div>
      <div class="card-row">${ICONS.heart}<span>${t('range.pulse')}</span><b>69–72</b></div>`;
  }
  return `<span class="chip-soft">${t('trip.next')}</span>
    <h4>${t('plan.near', { place: 'Lokoja' })}</h4><p class="card-sub">${t('trip.in', { time: dur(80) })}</p>
    <div class="card-row">${ICONS.clock}<span>${t('btn.nap')}</span></div>`;
}

VIEWS.intro = () => {
  const i = view.i || 1;
  return `<main class="intro wide">
    <div class="hero-grid">
      <div class="hero-text">
        <div class="lang-pick">${LANGS.map((l) => `<button class="${getLang() === l.id ? 'on' : ''}" data-lang="${l.id}">${l.name}</button>`).join('')}</div>
        <h1 class="display">${t(`intro.${i}.title`)}</h1>
        <p class="lead">${t(`intro.${i}.body`)}</p>
        <div class="pager" aria-hidden="true">${[1, 2, 3].map((n) => `<i class="${n === i ? 'on' : ''}"></i>`).join('')}</div>
        <div class="row">
          ${i < 3 ? `<button class="btn primary" id="next">${t('intro.next')}</button><button class="btn text" id="skip">${t('intro.skip')}</button>`
                  : `<button class="btn primary" id="skip">${t('intro.start')}</button>`}
        </div>
      </div>
      ${roadScene(introCard(i))}
    </div>
  </main>`;
};

AFTER.intro = () => {
  on('[data-lang]', 'click', (e) => { state.settings.lang = e.currentTarget.dataset.lang; setLang(state.settings.lang); render(); });
  on('#next', 'click', () => go('intro', { i: (view.i || 1) + 1 }));
  on('#skip', 'click', async () => { state.introSeen = true; await save(); go('consent'); });
};

// ---- consent

VIEWS.consent = () => `
  <main class="narrow">
    <h1>${t('consent.title')}</h1>
    <ul class="facts">
      ${[1, 2, 3, 4, 5, 6].map((n) => `<li><b>${t(`consent.f${n}b`)}</b> ${t(`consent.f${n}`)}</li>`).join('')}
    </ul>
    <label class="check"><input type="checkbox" id="tele" ${state.settings.telemetry ? 'checked' : ''}> <span>${t('consent.tele')}</span></label>
    <label class="check"><input type="checkbox" id="agree"> <span>${t('consent.agree')}</span></label>
    <button class="btn primary big" id="continue" disabled>${t('consent.continue')}</button>
  </main>`;

AFTER.consent = () => {
  const agree = $('agree'); const btn = $('continue');
  agree.addEventListener('change', () => { btn.disabled = !agree.checked; });
  btn.addEventListener('click', async () => {
    state.consent = { at: Date.now(), version: CONSENT_VERSION };
    state.settings.telemetry = $('tele').checked;
    sensor = makeSensor();
    await save();
    go(state.settings.profile ? 'home' : 'profile');
  });
};

// ---- driver type

VIEWS.profile = () => shell(`
  <h1>${t('profile.title')}</h1>
  <div class="profiles">
    ${Object.values(PROFILES).map((p) => `<button class="profile ${state.settings.profile === p.id ? 'on' : ''}" data-p="${p.id}">
      <span class="profile-icon">${ICONS[p.icon]}</span><b>${t(`profile.${p.id}`)}</b><small>${t(`profile.${p.id}.d`)}</small></button>`).join('')}
  </div>`, { back: state.settings.profile ? 'settings' : null });

AFTER.profile = () => on('[data-p]', 'click', async (e) => {
  state.settings.profile = e.currentTarget.dataset.p; await save(); go('home');
});

// ---- home

VIEWS.home = () => {
  const j = journey();
  const m = mode();
  const base = computeBaseline(state.readings);
  const last = state.journeys.filter((x) => x.endedAt).sort((a, b) => b.endedAt - a.endedAt)[0];
  const p = profile();
  const card = `
    ${base.ready ? statusTag('plan', t('scene.ready')) : `<span class="status warn">${dots(Math.min(base.count, 2), 'warn')}<b>${t('scene.building', { n: base.count, needed: base.needed })}</b></span>`}
    <h4>${t('home.baseline')}</h4>
    <p class="card-sub">${base.ready ? t('home.baseline.ready', { n: base.count }) : t('home.baseline.buildingNote')}</p>
    <div class="card-row">${ICONS.heart}<span>${t('range.pulse')}</span><b>${base.ready ? `${Math.round(base.pulse)} ${t('unit.bpm')}` : '—'}</b></div>
    <div class="card-row">${ICONS.wind}<span>${t('range.breathing')}</span><b>${base.ready ? `${Math.round(base.breathing * 10) / 10} ${t('unit.brpm')}` : '—'}</b></div>
    ${base.ready ? '' : `<button class="card-link" id="addBase"><span>${t('base.add')}</span>${ICONS.chevron}</button>`}
    <button class="card-link" data-go="history"><span>${last ? `${t('home.last')}: ${esc(last.routeName)}` : t('home.seeHistory')}</span>${ICONS.chevron}</button>`;
  return shell(`
    <div class="hero-grid">
      <div class="hero-text">
        <button class="profile-pill" data-go="profile">${ICONS[p.icon]}<span>${t(`profile.${p.id}`)}</span></button>
        <h1 class="display">${t(`home.title.${m}`)}</h1>
        <p class="lead">${t(`home.sub.${m}`)}</p>
        <div class="row">
          ${j ? `<button class="btn primary" data-go="trip">${t(`home.continue.${jmode(j)}`)}</button>`
              : `<button class="btn primary" data-go="setup">${t(`home.start.${m}`)}</button>`}
        </div>
        <ul class="ticks">${['home.f1', m === 'shift' ? 'home.f2.shift' : 'home.f2', 'home.f3', 'home.f4'].map((k) => `<li>${ICONS.check}${t(k)}</li>`).join('')}</ul>
      </div>
      ${roadScene(card)}
    </div>`, { wide: true });
};

AFTER.home = () => on('#addBase', 'click', () => go('check', { kind: 'baseline', seconds: 60 }));

// ---- setup: map route (trip) or hours (shift / no map)

VIEWS.setup = () => {
  const m = mode();
  const useMap = m === 'trip' && state.settings.map && !view.noMap;
  const s = view.setup || {};
  return shell(`
    ${steps(0)}
    <h1>${t(`setup.title.${m}`)}</h1>
    ${useMap ? `
      <form class="place-form" id="fromForm" data-end="from">
        <label for="fromQ">${t('setup.from')}</label>
        <div class="search-row"><input id="fromQ" autocomplete="off" placeholder="${t('setup.fromPh')}" value="${esc(s.from ? s.from.name : '')}"><button class="btn icon" type="submit" aria-label="${t('setup.search')}">${ICONS.search}</button></div>
        <div class="results" id="fromResults"></div>
      </form>
      <form class="place-form" id="toForm" data-end="to">
        <label for="toQ">${t('setup.to')}</label>
        <div class="search-row"><input id="toQ" autocomplete="off" placeholder="${t('setup.toPh')}" value="${esc(s.to ? s.to.name : '')}"><button class="btn icon" type="submit" aria-label="${t('setup.search')}">${ICONS.search}</button></div>
        <div class="results" id="toResults"></div>
      </form>
      <div id="routeBox"></div>
      <button class="btn text" id="noMap">${t('setup.noMap')}</button>
    ` : `
      ${m === 'trip' && !state.settings.map ? `<p class="quiet">${t('setup.mapOff')}</p>` : ''}
      <label class="field">${t(m === 'shift' ? 'setup.shiftHours' : 'setup.hours')}
        <div class="stepper"><button class="btn icon" id="minus" aria-label="−">−</button><output id="hoursOut">${s.hours || (m === 'shift' ? 8 : 4)}</output><button class="btn icon" id="plus" aria-label="+">+</button></div>
      </label>
    `}`, {
    back: 'home',
    actions: useMap ? `<button class="btn primary big wide" id="useRoute" disabled>${t('setup.useRoute')}</button>`
                    : `<button class="btn primary big wide" id="hoursGo">${t('setup.continue')}</button>`,
  });
};

AFTER.setup = () => {
  const s = view.setup = view.setup || {};
  on('#noMap', 'click', () => go('setup', { noMap: true, setup: s }));

  // Hours stepper
  const out = $('hoursOut');
  if (out) {
    let h = parseFloat(out.textContent);
    const set = (v) => { h = Math.min(16, Math.max(0.5, v)); out.textContent = h; s.hours = h; };
    on('#minus', 'click', () => set(h - 0.5));
    on('#plus', 'click', () => set(h + 0.5));
    on('#hoursGo', 'click', () => startJourney({ hours: h }));
    return;
  }

  const showRoute = async () => {
    const box = $('routeBox'); const btn = $('useRoute');
    if (!(s.from && s.to)) return;
    box.innerHTML = `<p class="quiet">${t('setup.routing')}</p>`;
    try {
      s.route = await mapsvc.drivingRoute(s.from, s.to);
      if (view.name !== 'setup') return;
      box.innerHTML = `<div class="map" id="map"></div><p class="route-sum">${t('setup.routeSummary', { dist: fmtDistance(s.route.distanceM, units()), time: dur(s.route.minutes) })}</p>`;
      drawRoute($('map'), { path: s.route.path, from: s.from, to: s.to });
      btn.disabled = false;
    } catch (err) {
      box.innerHTML = `<p class="callout care">${t('setup.error', { msg: esc(err.message) })}</p>`;
    }
  };

  document.querySelectorAll('.place-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const end = form.dataset.end;
      const q = form.querySelector('input').value.trim();
      const res = form.querySelector('.results');
      if (!q) return;
      res.innerHTML = `<p class="quiet">${t('setup.searching')}</p>`;
      try {
        const places = await mapsvc.searchPlace(q, getLang() === 'pcm' ? 'en' : getLang());
        if (!places.length) { res.innerHTML = `<p class="quiet">${t('setup.noResults')}</p>`; return; }
        res.innerHTML = places.map((p, i) => `<button type="button" class="result-row" data-i="${i}"><b>${esc(p.name)}</b><small>${esc(p.full)}</small></button>`).join('');
        res.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => {
          s[end] = places[+b.dataset.i];
          form.querySelector('input').value = s[end].name;
          res.innerHTML = '';
          showRoute();
        }));
      } catch (err) {
        res.innerHTML = `<p class="callout care">${t('setup.error', { msg: esc(err.message) })}</p>`;
      }
    });
  });

  on('#useRoute', 'click', () => startJourney({ hours: Math.round((s.route.minutes / 60) * 10) / 10, route: { from: s.from, to: s.to, distanceM: s.route.distanceM, minutes: s.route.minutes, path: s.route.path } }));
  if (s.route) showRoute();
};

async function startJourney({ hours, route }) {
  const m = mode();
  const j = {
    id: newId('j'), startedAt: Date.now(), mode: m, profile: profile().id,
    routeName: route ? `${route.from.name.split(',')[0]} to ${route.to.name.split(',')[0]}` : (m === 'shift' ? `${dur(hours * 60)} shift` : `${dur(hours * 60)} trip`),
    tripHours: hours, route: route || null,
    departure: null, plan: null, leftAt: null, checks: [], arrival: null, endedAt: null, remindedIndex: -1,
  };
  state.journeys.push(j);
  state.activeJourneyId = j.id;
  await save();
  go('check', { kind: 'departure', seconds: 60 });
}

// ---- camera check (departure, break, arrival, settle re-measure)

const QUALITY_GROUPS = {
  light: ['tooDark', 'tooBright'],
  position: ['noFace', 'multipleFaces', 'notCentered', 'tooClose', 'tooFar', 'tooHigh', 'tooLow', 'notForward', 'chestNotVisible'],
  stillness: ['motion'],
};

function checkCopy(kind) {
  const m = jmode(journey());
  if (kind === 'departure') return { title: t(m === 'shift' ? 'check.departure.title.shift' : 'check.departure.title'), sub: t('check.departure.sub') };
  if (kind === 'reststop') return { title: t('check.reststop.title'), sub: t('check.reststop.sub') };
  if (kind === 'arrival') return { title: t(m === 'shift' ? 'check.arrival.title.shift' : 'check.arrival.title'), sub: t('check.arrival.sub') };
  if (kind === 'baseline') return { title: t('check.baseline.title'), sub: t('check.baseline.sub') };
  return { title: t('check.settle.title'), sub: t('check.settle.sub') };
}

VIEWS.check = () => {
  const c = checkCopy(view.kind);
  return shell(`
    ${view.kind === 'departure' ? steps(1) : ''}
    <h1>${c.title}</h1>
    <p>${c.sub}</p>
    <div class="camera">
      <video id="video" autoplay playsinline muted></video>
      <svg class="oval" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><defs><mask id="m"><rect width="160" height="90" fill="#fff"/><ellipse cx="80" cy="42" rx="22" ry="29" fill="#000"/></mask></defs><rect width="160" height="90" fill="rgba(20,22,25,.45)" mask="url(#m)"/><ellipse id="ovalLine" cx="80" cy="42" rx="22" ry="29" fill="none" stroke="#fff" stroke-width="1" stroke-dasharray="3 2"/></svg>
      <div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="track"/><circle cx="60" cy="60" r="52" class="prog" id="prog"/></svg><span id="count">${view.seconds}</span></div>
      <p class="hint" id="hint" role="status" aria-live="polite">${t('check.starting')}</p>
    </div>
    <ul class="quality" aria-label="Signal">
      ${['light', 'position', 'stillness'].map((g) => `<li id="q-${g}" class="pending"><i></i>${t(`check.${g}`)}</li>`).join('')}
    </ul>
    <div class="cam-row"><p class="cam-info" id="camInfo" aria-live="off"></p><label class="cam-pick" hidden id="camPickWrap">${t('check.camera')}<select id="camPick"></select></label></div>
    <div class="live">
      <div><b id="livePulse">—</b><small>${t('check.pulse')}</small></div>
      <div><b id="liveBreath">—</b><small>${t('check.breathing')}</small></div>
      <div><b id="liveQuality" class="badge">${t('check.settling')}</b><small>&nbsp;</small></div>
    </div>
    <div id="checkError"></div>`, {
    back: view.kind === 'departure' || view.kind === 'baseline' ? 'home' : 'trip',
    actions: `<button class="btn secondary wide" id="skip">${t('check.skip')}</button>`,
  });
};

AFTER.check = () => {
  const abort = { aborted: false };
  activeAbort = abort;
  const prog = $('prog');
  const C = 2 * Math.PI * 52;
  prog.style.strokeDasharray = `${C}`;
  prog.style.strokeDashoffset = `${C}`;
  const qState = { light: 'pending', position: 'pending', stillness: 'pending' };

  const startCountdown = () => {
    const t0 = Date.now();
    timers.push(setInterval(() => {
      const left = Math.max(0, view.seconds - (Date.now() - t0) / 1000);
      const el = $('count'); if (el) el.textContent = Math.ceil(left);
      prog.style.strokeDashoffset = `${C * (left / view.seconds)}`;
    }, 250));
  };

  const onHint = (code) => {
    const el = $('hint'); if (!el) return;
    el.textContent = t(`hint.${code || 'ok'}`);
    if (code === 'tuning' || code === 'lowFps' || code === 'connecting' || code === 'lightMode') return;
    // The SDK reports one issue at a time. A group turns red when it is the issue, and green once
    // the SDK reports "ok" or has moved on to a different issue.
    for (const [g, codes] of Object.entries(QUALITY_GROUPS)) {
      if (codes.includes(code)) qState[g] = 'bad';
      else if (code === 'ok' || qState[g] === 'bad') qState[g] = 'ok';
      const li = $(`q-${g}`); if (li) li.className = qState[g];
    }
    const line = $('ovalLine'); if (line) line.setAttribute('class', code === 'ok' ? 'good' : '');
  };

  on('#skip', 'click', () => { abort.aborted = true; afterCheck({ source: 'questions', quality: 'none' }, null); });

  // Camera picker: filled once the camera is running, when Windows makes camera names available.
  let pickerFilled = false;
  const fillPicker = async () => {
    if (pickerFilled || sensor instanceof DemoSensor) return;
    pickerFilled = true;
    const cams = await listCameras();
    const sel = $('camPick'); const wrap = $('camPickWrap');
    if (!sel || cams.length < 2) return;
    sel.innerHTML = cameraOptions(cams);
    wrap.hidden = false;
    sel.addEventListener('change', async () => {
      state.settings.cameraId = sel.value || null;
      await save();
      sensor.cameraId = state.settings.cameraId;
      sensor.mode = 'standard';
      go('check', { kind: view.kind, seconds: view.seconds, recheck: view.recheck });
    });
  };

  sensor.measure({
    seconds: view.seconds, video: $('video'), abort, onRunning: startCountdown, onHint,
    onCamera: (c) => {
      fillPicker();
      const el = $('camInfo'); if (!el) return;
      el.textContent = t('check.camInfo', { w: c.width || '?', h: c.height || '?', fps: c.fps });
      el.className = `cam-info ${c.fps && c.fps < 20 ? 'slow' : ''}`;
    },
    onLive: (r) => {
      const p = $('livePulse'); if (!p) return;
      p.textContent = r.pulse ?? '—';
      $('liveBreath').textContent = r.breathing ?? '—';
      const q = $('liveQuality');
      q.textContent = r.quality === 'good' ? t('check.good') : t('check.settling');
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
      afterCheck({ source: 'questions', quality: 'none' }, 'check.unavailable');
    } else {
      const box = $('checkError');
      fillPicker();
      const tip = err.code === 14 ? `<p class="quiet">${t('check.slowTip')}</p>` : '';
      if (box) box.innerHTML = `<p class="callout care">${t('check.stopped', { msg: esc(err.message) })}</p>${tip}<button class="btn primary" id="retry">${t('check.retry')}</button>`;
      on('#retry', 'click', () => go('check', { kind: view.kind, seconds: view.seconds, recheck: view.recheck }));
    }
  });
};

async function afterCheck(result, notice) {
  const kindMap = { departure: 'departure', reststop: 'reststop', arrival: 'arrival', 'settle-after': 'settle', baseline: 'baseline' };
  const reading = addReading(kindMap[view.kind], result);
  await save();
  const kind = view.kind;
  if (kind === 'departure') go('departureQuestions', { readingId: reading.id, notice });
  else if (kind === 'reststop') go('stopQuestions', { readingId: reading.id, notice, recheck: !!view.recheck });
  else if (kind === 'arrival') go('arrivalQuestions', { readingId: reading.id, notice });
  else if (kind === 'settle-after') finishSettle(reading.id);
  else if (kind === 'baseline') go('baselineDone', { readingId: reading.id, notice });
}

// ---- calm check at home (builds the baseline without a trip)

VIEWS.baselineDone = () => {
  const r = readingById(view.readingId);
  const good = r && r.quality === 'good';
  return shell(`
    ${view.notice ? `<p class="callout care">${t(view.notice)}</p>` : ''}
    <h1>${t('base.done.title')}</h1>
    <div class="chips">${sourceChip(r)}</div>
    ${good ? `<div class="live two"><div><b>${r.pulse}</b><small>${t('check.pulse')}</small></div><div><b>${r.breathing}</b><small>${t('check.breathing')}</small></div></div>` : `<p class="callout care">${t('base.noReading')}</p>`}
    ${baselineProgress(view.readingId) || `<section class="progress-card ready">${statusTag('plan', t('scene.ready'))}</section>`}`,
  { back: 'home', actions: `${good ? '' : `<button class="btn secondary wide" id="again">${t('check.retry')}</button>`}<button class="btn primary big wide" data-go="home">${t('base.doneBtn')}</button>` });
};

AFTER.baselineDone = () => on('#again', 'click', () => go('check', { kind: 'baseline', seconds: 60 }));

// ---- departure questions + result

VIEWS.departureQuestions = () => {
  const j = journey();
  return shell(`
    ${view.notice ? `<p class="callout care">${t(view.notice)}</p>` : ''}
    ${steps(2)}
    <h1>${t('q.title')}</h1>
    <h3>${t('q.sleep')}</h3>
    ${optionGrid('sleep', SLEEP, 'sleep')}
    <h3>${t('q.alert')}</h3>
    ${optionGrid('alert', ALERTNESS, 'alert')}
    <h3>${t(`q.length.${jmode(j)}`)}</h3>
    <p>${esc(j.routeName)}. ${t('q.lengthValue', { time: dur(j.tripHours * 60) })}</p>`,
  { actions: `<button class="btn primary big wide" id="done" disabled>${t('q.done')}</button>` });
};

AFTER.departureQuestions = () => {
  const ans = {};
  on('.tiles .tile', 'click', (e) => {
    const group = e.currentTarget.parentElement;
    group.querySelectorAll('.tile').forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-checked', 'false'); });
    e.currentTarget.classList.add('on'); e.currentTarget.setAttribute('aria-checked', 'true');
    ans[group.dataset.q] = parseFloat(e.currentTarget.dataset.v);
    $('done').disabled = !(ans.sleep && ans.alert);
  });
  on('#done', 'click', async () => {
    const j = journey();
    const reading = readingById(view.readingId);
    const base = computeBaseline(state.readings.filter((r) => r.id !== reading.id));
    const comparison = compareToBaseline(reading, base);
    const advice = departureAdvice({ sleepHours: ans.sleep, alertness: ans.alert, comparison });
    j.departure = { readingId: reading.id, answers: { sleepHours: ans.sleep, alertness: ans.alert }, comparison, advice, settle: null };
    await save();
    go('departureResult');
  });
};

VIEWS.departureResult = () => {
  const j0 = journey();
  if (!j0 || !j0.departure) { view = { name: 'trip' }; return VIEWS.trip(); }
  const d = j0.departure;
  const r = readingById(d.readingId);
  const after = d.settle ? readingById(d.settle.afterId) : null;
  const base = computeBaseline(state.readings.filter((x) => x.id !== d.readingId && (!after || x.id !== after.id)));
  const markers = (k) => {
    const m = [];
    const settled = after && after.quality === 'good';
    if (r && r.quality === 'good') m.push({ value: r[k], label: settled ? t('range.before') : t('range.today'), kind: 'today' });
    if (settled) m.push({ value: after[k], label: t('range.afterSettle'), kind: 'now' });
    return m;
  };
  const cmp = d.comparison.status;
  const notes = (d.settle ? d.advice.notes.filter((n) => n !== 'note.aboveUsual') : d.advice.notes).filter((n) => n !== 'note.building');
  let settleLine = '';
  if (d.settle) {
    const s = d.settle.summary;
    settleLine = s.unclear ? `<p class="callout">${t('settle.unclear')}</p>`
      : `<p class="callout ok">${t('settle.after', { p: `${s.pulseChange > 0 ? '+' : ''}${s.pulseChange}`, b: `${s.breathChange > 0 ? '+' : ''}${s.breathChange}` })}</p>`;
  }
  const offerSettle = d.advice.offerSettle && !d.settle;
  return shell(`
    <h1>${t('result.title')}</h1>
    <div class="chips">${sourceChip(r)}</div>
    ${r && r.quality === 'good' ? readingBars(markers, base) : ''}
    ${cmp === 'above' ? `<p class="callout care">${t('cmp.above')}</p>` : cmp === 'usual' ? `<p class="callout ok">${t('cmp.usual')}</p>` : ''}
    ${baselineProgress(d.readingId)}
    ${cmp === 'building' && r && r.quality === 'good' ? `<p class="quiet">${t('base.tripRef')}</p>` : ''}
    ${settleLine}
    ${resultSign(d.advice.level, d.advice.headline, notes)}`, {
    actions: d.advice.level === 'hold'
      ? `<button class="btn secondary wide" id="endHold">${t('btn.endRest')}</button>`
      : `${offerSettle ? `<button class="btn primary big wide" data-go="settle">${t('btn.settle')}</button>` : ''}<button class="btn ${offerSettle ? 'secondary' : 'primary big'} wide" id="toPlan">${t('btn.plan')}</button>`,
  });
};

AFTER.departureResult = () => {
  on('#toPlan', 'click', async () => {
    const j = journey();
    const every = j.departure.advice.breakEveryMin;
    const stops = buildRestPlan({ towns: [] }, j.tripHours, every).map((s) => {
      const p = j.route ? pointAtMinute(j.route.path, s.atMin) : null;
      return { atMin: s.atMin, lat: p ? p.lat : null, lon: p ? p.lon : null, place: null };
    });
    j.plan = { breakEveryMin: every, stops };
    await save();
    go('plan');
  });
  on('#endHold', 'click', async () => {
    const j = journey();
    j.endedAt = Date.now(); j.cancelled = 'rest-first';
    state.activeJourneyId = null;
    await save();
    go('home');
  });
};

// ---- settle routine: 60 s guided breathing with live feedback, then re-measure

VIEWS.settle = () => shell(`
  <h1>${t('settle.title')}</h1>
  <p>${t('settle.sub')}</p>
  <div class="breathe"><div class="orb" id="orb"></div><p id="phase">${t('settle.in')}</p></div>
  <div class="live two">
    <div><b id="liveBreath">—</b><small>${t('settle.yourBreathing')}</small></div>
    <div><b id="count">60</b><small>${t('settle.left')}</small></div>
  </div>
  <video id="video" autoplay playsinline muted class="mini"></video>`, { back: 'departureResult' });

AFTER.settle = () => {
  const abort = { aborted: false };
  activeAbort = abort;
  const orb = $('orb'); const phase = $('phase');
  let inhale = true;
  const cycle = () => { orb.className = `orb ${inhale ? 'grow' : 'shrink'}`; phase.textContent = inhale ? t('settle.in') : t('settle.out'); };
  cycle();
  const step = () => { inhale = !inhale; cycle(); timers.push(setTimeout(step, inhale ? 4000 : 6000)); };
  timers.push(setTimeout(step, 4000));
  const t0 = Date.now();
  timers.push(setInterval(() => { const el = $('count'); if (el) el.textContent = Math.max(0, Math.ceil(60 - (Date.now() - t0) / 1000)); }, 250));
  sensor.measure({
    seconds: 60, abort, video: $('video'),
    onLive: (r) => { const el = $('liveBreath'); if (el && r.breathing) el.textContent = r.breathing; },
  }).then(() => { if (!abort.aborted) { activeAbort = null; go('check', { kind: 'settle-after', seconds: 30 }); } })
    .catch((err) => { if (!abort.aborted && !err.cancelled) { activeAbort = null; go('check', { kind: 'settle-after', seconds: 30 }); } });
};

async function finishSettle(afterId) {
  const d = journey().departure;
  d.settle = { afterId, summary: settleSummary(readingById(d.readingId), readingById(afterId)) };
  await save();
  go('departureResult');
}

// ---- plan

function stopLabel(s, i) {
  return s.place ? t('plan.near', { place: s.place.split(',')[0] }) : t('plan.breakAt', { n: i + 1 });
}

function stopList(j, { done = -1 } = {}) {
  const m = jmode(j);
  return `<ol class="road">
    <li class="end"><b>${j.route ? esc(j.route.from.name.split(',')[0]) : t('plan.start')}</b><span>0</span></li>
    ${j.plan.stops.map((s, i) => `<li class="${i < done ? 'done' : i === done ? 'next' : ''}"><i class="num">${i + 1}</i><b>${esc(stopLabel(s, i))}</b><span>${i < done ? t('trip.checked') : t('plan.inTime', { time: dur(s.atMin) })}</span></li>`).join('')}
    <li class="end"><b>${j.route ? esc(j.route.to.name.split(',')[0]) : t(m === 'shift' ? 'plan.endShift' : 'plan.arrive')}</b><span>${dur(j.tripHours * 60)}</span></li>
  </ol>`;
}

VIEWS.plan = () => {
  const j = journey();
  const naming = j.route && j.plan.stops.some((s) => s.place == null && !s.named);
  return shell(`
    ${steps(3)}
    <h1>${t('plan.title')}</h1>
    <p>${t('plan.every', { time: dur(j.plan.breakEveryMin) })} ${j.plan.breakEveryMin < 120 ? t('plan.shorter') : ''}</p>
    ${j.route ? '<div class="map tall" id="map"></div>' : ''}
    ${naming ? `<p class="quiet" id="naming">${t('plan.naming')}</p>` : ''}
    ${stopList(j)}
    ${j.plan.stops.length === 0 ? `<p class="quiet">${t('plan.noStops')}</p>` : ''}
    <p class="quiet">${t('plan.approx')}</p>
    ${jmode(j) === 'shift' || j.profile === 'private' ? '' : `<button class="btn secondary" data-go="badge">${t('plan.badge')}</button>`}`,
  { actions: `<button class="btn primary big wide" id="leave">${t(`plan.go.${jmode(j)}`)}</button>` });
};

AFTER.plan = () => {
  const j = journey();
  if (j.route) {
    drawRoute($('map'), { path: j.route.path, from: j.route.from, to: j.route.to, stops: j.plan.stops.map((s, i) => ({ lat: s.lat, lon: s.lon, name: stopLabel(s, i) })) });
    nameStops(j);
  }
  on('#leave', 'click', async () => { journey().leftAt = Date.now(); await save(); go('trip'); });
};

/** Fill in "Near <town>" for each stop, one lookup at a time (Nominatim allows 1 per second). */
async function nameStops(j) {
  for (const s of j.plan.stops) {
    if (s.named || s.lat == null) continue;
    s.place = await mapsvc.townAt(s.lat, s.lon, getLang() === 'pcm' ? 'en' : getLang());
    s.named = true;
    await save();
    if (view.name !== 'plan') return;
    const list = document.querySelector('.road');
    if (list) list.outerHTML = stopList(j);
  }
  const n = $('naming'); if (n) n.remove();
}

VIEWS.badge = () => shell(`
  <h1>${t('badge.title')}</h1>
  <p>${t('badge.sub')}</p>
  <div class="badge-card"><img id="qr" alt="QR"><pre id="badgeText"></pre></div>`, { back: 'plan' });

AFTER.badge = () => {
  const j = journey();
  const text = badgeText({ checkedAt: j.departure ? readingById(j.departure.readingId).at : j.startedAt, routeName: j.routeName, stopCount: j.plan.stops.length, mode: jmode(j) });
  $('badgeText').textContent = text;
  QRCode.toDataURL(text, { margin: 1, width: 260, color: { dark: '#1f2326', light: '#ffffff' } }).then((url) => { const img = $('qr'); if (img) img.src = url; });
};

// ---- on the road

VIEWS.trip = () => {
  const j = journey();
  if (!j) return VIEWS.home();
  if (!j.plan) {
    // The check-in for this trip wasn't finished (e.g. the camera stopped). Offer a clear way on.
    if (!j.departure) {
      return shell(`<h1>${t('trip.unfinished')}</h1><p class="lead">${esc(j.routeName)}</p>`, {
        back: 'home',
        actions: `<button class="btn primary big wide" id="redoCheck">${t('trip.restartCheck')}</button><button class="btn secondary wide" id="cancelTrip">${t('trip.cancel')}</button>`,
      });
    }
    return shell(`<h1>${t('result.title')}</h1>`, { back: 'home', actions: `<button class="btn primary big wide" data-go="departureResult">${t('setup.continue')}</button>` });
  }
  const done = stopsChecked(j);
  const next = j.plan.stops[done];
  const elapsed = j.leftAt ? (Date.now() - j.leftAt) / 60000 : 0;
  const left = next ? next.atMin - elapsed : 0;
  const total = j.plan.stops.length;
  const card = next
    ? `<span class="chip-soft">${t('trip.next')}</span>
       <h4 id="nextName">${esc(stopLabel(next, done))}</h4>
       <p class="eta" id="eta" aria-live="polite">${left <= 0 ? t('trip.due') : t('trip.in', { time: dur(left) })}</p>
       <div class="card-row">${ICONS.clock}<span>${t('trip.driving', { time: dur(elapsed) })}</span></div>
       <div class="card-row">${ICONS.pin}<span>${t('stop.eyebrow', { n: done + 1 })} / ${total}</span>${dots(Math.min(3, Math.ceil(((done) / Math.max(1, total)) * 3)), 'good')}</div>`
    : `<span class="chip-soft">${t('trip.noMore')}</span><h4>${t('trip.pullOver')}</h4>
       <div class="card-row">${ICONS.clock}<span>${t('trip.driving', { time: dur(elapsed) })}</span></div>`;
  return shell(`
    ${roadScene(card, { compact: true })}
    ${j.route ? '<div class="map" id="map"></div>' : ''}
    ${stopList(j, { done })}
    <p class="callout">${t('trip.never')}</p>`, {
    back: 'home',
    actions: `<button class="btn primary big wide" id="atStop">${t('trip.atStop')}</button><button class="btn secondary wide" id="arrived">${t(`trip.arrived.${jmode(j)}`)}</button>`,
  });
};

AFTER.trip = () => {
  const j = journey();
  on('#redoCheck', 'click', () => go('check', { kind: 'departure', seconds: 60 }));
  on('#cancelTrip', 'click', async () => {
    state.journeys = state.journeys.filter((x) => x.id !== state.activeJourneyId);
    state.activeJourneyId = null;
    await save();
    go('home');
  });
  if (!j || !j.plan) return;
  const done = stopsChecked(j);
  if (j.route) drawRoute($('map'), { path: j.route.path, from: j.route.from, to: j.route.to, stops: j.plan.stops.map((s, i) => ({ lat: s.lat, lon: s.lon, name: stopLabel(s, i) })), nextIndex: done, interactive: false });
  on('#atStop', 'click', () => go('check', { kind: 'reststop', seconds: 30 }));
  on('#arrived', 'click', () => go('check', { kind: 'arrival', seconds: 30 }));
  const tick = () => {
    const jj = journey(); if (!jj) return;
    const d = stopsChecked(jj); const next = jj.plan.stops[d];
    if (!next || !jj.leftAt) return;
    const left = next.atMin - (Date.now() - jj.leftAt) / 60000;
    const eta = $('eta'); if (eta) eta.textContent = left <= 0 ? t('trip.due') : t('trip.in', { time: dur(left) });
    if (left <= 0 && jj.remindedIndex !== d) { jj.remindedIndex = d; save(); remind(); }
  };
  tick();
  timers.push(setInterval(tick, 15000));
};

function remind() {
  try { new Notification(t('trip.reminder'), { body: t('trip.reminderBody'), silent: false }); } catch { /* notifications unavailable */ }
  chime([660, 880]);
}

// ---- break check

VIEWS.stopQuestions = () => shell(`
  ${view.notice ? `<p class="callout care">${t(view.notice)}</p>` : ''}
  <h1>${t('q.feelNow')}</h1>
  ${optionGrid('feel', ALERTNESS, 'alert')}`);

AFTER.stopQuestions = () => {
  on('.tile', 'click', async (e) => {
    const feeling = parseInt(e.currentTarget.dataset.v, 10);
    const j = journey();
    const reading = readingById(view.readingId);
    const advice = restStopAdvice({ departure: leavingReading(j), reading, feeling });
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
  const markers = (k) => {
    const m = [];
    if (dep && dep.quality === 'good') m.push({ value: dep[k], label: t('range.setOff'), kind: 'today' });
    if (r && r.quality === 'good') m.push({ value: r[k], label: t('range.now'), kind: 'now' });
    return m;
  };
  const any = (dep && dep.quality === 'good') || (r && r.quality === 'good');
  return shell(`
    <h1>${t('stop.eyebrow', { n: c.stopIndex + 1 })}${c.recheck ? `, ${t('stop.recheck')}` : ''}</h1>
    <div class="chips">${sourceChip(r)}</div>
    ${any ? readingBars(markers, computeBaseline(state.readings)) : ''}
    ${resultSign(c.advice.level, c.advice.headline, c.advice.notes)}`, {
    actions: `${c.advice.offerNap ? `<button class="btn primary big wide" data-go="nap">${t('btn.nap')}</button>` : ''}
      ${c.advice.level === 'hold' ? '' : `<button class="btn ${c.advice.offerNap ? 'secondary' : 'primary big'} wide" data-go="trip">${t(`btn.continue.${jmode(j)}`)}</button>`}
      <button class="btn text" id="again">${t('btn.again')}</button>`,
  });
};

AFTER.stopResult = () => on('#again', 'click', () => go('check', { kind: 'reststop', seconds: 30, recheck: true }));

// ---- nap timer

VIEWS.nap = () => shell(`
  <h1>${t('nap.title')}</h1>
  <p class="timer" id="napLeft">20:00</p>
  <p>${t('nap.body')}</p>`, { back: 'stopResult', actions: `<button class="btn secondary wide" id="stopNap">${t('nap.stop')}</button>` });

AFTER.nap = () => {
  const end = Date.now() + 20 * 60 * 1000;
  timers.push(setInterval(() => {
    const left = Math.max(0, end - Date.now());
    const el = $('napLeft');
    if (el) el.textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    if (left === 0) { clearTimers(); chime([880, 880, 880, 880]); go('napDone'); }
  }, 500));
  on('#stopNap', 'click', () => go('napDone'));
};

VIEWS.napDone = () => shell(`<h1>${t('napDone.title')}</h1><p>${t('napDone.body')}</p>`,
  { actions: `<button class="btn primary big wide" id="recheck">${t('napDone.btn')}</button>` });

AFTER.napDone = () => on('#recheck', 'click', () => go('check', { kind: 'reststop', seconds: 30, recheck: true }));

function chime(freqs) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const at = ctx.currentTime + i * 0.6;
      g.gain.setValueAtTime(0.3, at); g.gain.setValueAtTime(0, at + 0.4);
      o.start(at); o.stop(at + 0.4);
    });
  } catch { /* no audio available */ }
}

// ---- arrival

VIEWS.arrivalQuestions = () => shell(`
  ${view.notice ? `<p class="callout care">${t(view.notice)}</p>` : ''}
  <h1>${t('q.tiredNow')}</h1>
  ${optionGrid('feel', ALERTNESS, 'alert')}`);

AFTER.arrivalQuestions = () => on('.tile', 'click', async (e) => {
  const j = journey();
  j.arrival = { at: Date.now(), readingId: view.readingId, feeling: parseInt(e.currentTarget.dataset.v, 10) };
  j.endedAt = Date.now();
  state.activeJourneyId = null;
  await save();
  go('arrivalDone', { journeyId: j.id });
});

VIEWS.arrivalDone = () => {
  const j = state.journeys.find((x) => x.id === view.journeyId);
  const mins = j.leftAt ? (j.endedAt - j.leftAt) / 60000 : null;
  return shell(`
    ${roadScene(`${statusTag('plan', t('history.done'))}<h4>${t('arrival.title')}</h4>${mins ? `<p class="card-sub">${t('arrival.onRoad', { time: dur(mins) })}</p>` : ''}`, { compact: true })}
    <p>${t('arrival.checked', { n: stopsChecked(j), total: j.plan ? j.plan.stops.length : 0 })}</p>
    ${j.arrival.feeling <= 2 ? `<p class="callout care">${t('arrival.sleepy')}</p>` : ''}
    <p class="quiet">${t('arrival.note')}</p>`, { actions: `<button class="btn primary big wide" data-go="home">${t('arrival.done')}</button>` });
};

// ---- history

VIEWS.history = () => {
  const list = state.journeys.slice().sort((a, b) => b.startedAt - a.startedAt);
  return shell(`
    <h1>${t('history.title')}</h1>
    <p class="quiet">${t('history.kept', { n: state.settings.retentionDays })}</p>
    ${list.length ? list.map((j) => {
      const dep = j.departure ? readingById(j.departure.readingId) : null;
      const p = getProfile(j.profile);
      return `<article class="panel hist">
        <span class="hist-icon">${ICONS[p.icon]}</span>
        <div><h3>${esc(j.routeName)}</h3>
        <p class="quiet">${fmtDate(j.startedAt)} ${fmtClock(j.startedAt)}, ${j.cancelled ? t('history.rested') : j.endedAt ? t('history.done') : t('history.inProgress')}</p>
        ${dep && dep.quality === 'good' ? `<p>${dep.pulse} ${t('unit.bpm')}, ${dep.breathing} ${t('unit.brpm')} ${sourceChip(dep)}</p>` : sourceChip(dep)}
        <p class="quiet">${j.plan ? t('history.breaks', { n: j.plan.stops.length, c: stopsChecked(j) }) : t('history.noPlan')}</p></div>
      </article>`;
    }).join('') : `<p>${t('history.none')}</p>`}`, { back: 'home' });
};

// ---- settings

function seg(id, options, current) {
  return `<div class="seg" id="${id}" role="radiogroup">${options.map(([v, label]) => `<button role="radio" aria-checked="${current === v}" class="${current === v ? 'on' : ''}" data-v="${v}">${label}</button>`).join('')}</div>`;
}

VIEWS.settings = () => {
  const s = state.settings;
  return shell(`
    <h1>${t('settings.title')}</h1>
    <section class="panel"><h3>${t('settings.lang')}</h3>${seg('setLang', LANGS.map((l) => [l.id, l.name]), getLang())}</section>
    <section class="panel"><h3>${t('settings.theme')}</h3>${seg('setTheme', [['auto', t('theme.auto')], ['day', t('theme.day')], ['night', t('theme.night')]], s.theme || 'auto')}</section>
    <section class="panel"><h3>${t('settings.profile')}</h3>${seg('setProfile', Object.values(PROFILES).map((p) => [p.id, t(`profile.${p.id}`)]), profile().id)}</section>
    ${sensor instanceof DemoSensor ? '' : `<section class="panel"><h3>${t('check.camera')}</h3>
      <select id="setCamera" class="select"><option>${t('loading')}</option></select>
      <p class="quiet">${t('settings.cameraNote')}</p></section>`}
    <section class="panel"><h3>${t('settings.units')}</h3>${seg('setUnits', [['km', t('units.km')], ['mi', t('units.mi')]], units())}</section>
    <section class="panel">
      <label class="check"><input type="checkbox" id="mapOn" ${s.map ? 'checked' : ''}> <span><b>${t('settings.map')}</b><br><small>${t('settings.mapNote')}</small></span></label>
      <label class="check"><input type="checkbox" id="tele" ${s.telemetry ? 'checked' : ''}> <span>${t('consent.tele')}</span></label>
    </section>
    ${browserPreview ? '' : `<section class="panel">
      <h3>${t('settings.key')}</h3>
      <p class="quiet">${config.keySource === 'env' ? t('settings.keyEnv') : config.apiKey ? t('settings.keySet', { end: esc(config.apiKey.slice(-4)) }) : t('settings.keyNone')}</p>
      ${config.keySource === 'env' ? '' : `<form id="keyForm" class="search-row"><input id="keyIn" type="password" autocomplete="off" placeholder="${t('settings.keyPh')}"><button class="btn primary" type="submit">${t('settings.keySave')}</button></form>
      ${config.apiKey ? `<button class="btn text" id="keyRemove">${t('settings.keyRemove')}</button>` : ''}
      <p class="quiet" id="keyMsg"></p>`}
    </section>`}
    <section class="panel"><h3>${t('settings.keep')}</h3>${seg('setKeep', [30, 90, 180].map((d) => [d, t('settings.days', { n: d })]), s.retentionDays)}</section>
    <section class="panel">
      <h3>${t('settings.stores')}</h3>
      <p>${t('settings.storesBody', { r: state.readings.length, j: state.journeys.length })}</p>
      <p class="quiet">${t('settings.sensor', { s: esc(sensor ? sensor.label : '—') })}</p>
      <button class="btn danger" id="wipe">${t('settings.delete')}</button>
      <div id="confirm" hidden><p class="callout hold">${t('settings.deleteWarn')}</p>
        <div class="row"><button class="btn danger" id="wipeYes">${t('settings.deleteYes')}</button><button class="btn secondary" id="wipeNo">${t('settings.deleteNo')}</button></div></div>
    </section>`, { back: 'home' });
};

AFTER.settings = () => {
  const pick = (id, fn) => on(`#${id} button`, 'click', async (e) => { await fn(e.currentTarget.dataset.v); await save(); render(); });
  const camSel = $('setCamera');
  if (camSel) {
    listCameras({ probe: true }).then((cams) => {
      if (!$('setCamera')) return;
      camSel.innerHTML = cameraOptions(cams);
    });
    camSel.addEventListener('change', async () => {
      state.settings.cameraId = camSel.value || null;
      if (sensor) { sensor.cameraId = state.settings.cameraId; sensor.mode = 'standard'; }
      await save();
    });
  }
  pick('setLang', (v) => { state.settings.lang = v; setLang(v); });
  pick('setTheme', (v) => { state.settings.theme = v; });
  pick('setProfile', (v) => { state.settings.profile = v; });
  pick('setUnits', (v) => { state.settings.units = v; });
  pick('setKeep', (v) => { state.settings.retentionDays = parseInt(v, 10); state = prune(state); });
  on('#mapOn', 'change', async (e) => { state.settings.map = e.currentTarget.checked; await save(); });
  on('#tele', 'change', async (e) => { state.settings.telemetry = e.currentTarget.checked; sensor = makeSensor(); await save(); });
  const applyKey = async (key) => {
    try {
      await api.setKey(key);
      config = await api.config();
      sensor = makeSensor();
      render();
    } catch (err) {
      const m = $('keyMsg'); if (m) m.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };
  const form = $('keyForm');
  if (form) form.addEventListener('submit', (e) => { e.preventDefault(); applyKey($('keyIn').value); });
  on('#keyRemove', 'click', () => applyKey(''));
  on('#wipe', 'click', () => { $('confirm').hidden = false; });
  on('#wipeNo', 'click', () => { $('confirm').hidden = true; });
  on('#wipeYes', 'click', async () => { await api.wipe(); state = emptyState(); setLang(detectLang(navigator.language)); go('intro', { i: 1 }); });
};

// ---------------------------------------------------------------- boot

(async function boot() {
  try { config = await api.config(); } catch { /* keep defaults */ }
  state = prune(normalize(await api.load()));
  setLang(state.settings.lang || detectLang(navigator.language));
  await save();
  sensor = makeSensor();
  if (browserPreview) window.__rydra = { state: () => state, sensor: () => sensor, go, save };
  timers = [];
  setInterval(applyTheme, 5 * 60 * 1000);
  if (!state.introSeen) return go('intro', { i: 1 });
  if (!state.consent || state.consent.version < CONSENT_VERSION) return go('consent');
  if (!state.settings.profile) return go('profile');
  go(state.activeJourneyId ? 'trip' : 'home');
})();
