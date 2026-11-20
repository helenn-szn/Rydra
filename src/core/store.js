// Shape of everything Rydra keeps, plus retention. All of it lives on the driver's device.
'use strict';

const CONSENT_VERSION = 2;   // v2 added the optional map (OpenStreetMap lookups)

function emptyState() {
  return {
    version: 1,
    consent: null,                       // { at, version }
    introSeen: false,
    settings: { retentionDays: 90, telemetry: false, lang: null, theme: 'auto', profile: null, units: null, map: true },
    readings: [],                        // numbers only: pulse, breathing, hrv, quality. Never video.
    journeys: [],
    activeJourneyId: null,
  };
}

function normalize(raw) {
  const s = Object.assign(emptyState(), raw || {});
  s.settings = Object.assign(emptyState().settings, (raw && raw.settings) || {});
  s.readings = Array.isArray(s.readings) ? s.readings : [];
  s.journeys = Array.isArray(s.journeys) ? s.journeys : [];
  return s;
}

/** Drop anything older than the retention window. Keeps an unfinished trip. */
function prune(state, now = Date.now()) {
  const cutoff = now - state.settings.retentionDays * 24 * 3600 * 1000;
  return Object.assign({}, state, {
    readings: state.readings.filter((r) => r.at >= cutoff),
    journeys: state.journeys.filter((j) => j.startedAt >= cutoff || j.id === state.activeJourneyId),
  });
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

module.exports = { CONSENT_VERSION, emptyState, normalize, prune, newId };
