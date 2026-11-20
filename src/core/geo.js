// Route geometry helpers: where along the road a driver will be after N minutes.
'use strict';

/**
 * Build a time-indexed polyline from an OSRM route (geojson geometry + per-segment durations).
 * @param {[number,number][]} coords  [lon, lat] pairs
 * @param {number[]} durations        seconds per segment (coords.length - 1 entries)
 * @returns {{lat:number, lon:number, min:number}[]}
 */
function timeline(coords, durations) {
  const out = [];
  let t = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) t += (durations[i - 1] || 0) / 60;
    out.push({ lon: coords[i][0], lat: coords[i][1], min: t });
  }
  return out;
}

/** Interpolated position at `min` minutes of driving. */
function pointAtMinute(tl, min) {
  if (!tl.length) return null;
  if (min <= 0) return { lat: tl[0].lat, lon: tl[0].lon };
  for (let i = 1; i < tl.length; i++) {
    if (tl[i].min >= min) {
      const a = tl[i - 1]; const b = tl[i];
      const f = b.min === a.min ? 0 : (min - a.min) / (b.min - a.min);
      return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    }
  }
  const last = tl[tl.length - 1];
  return { lat: last.lat, lon: last.lon };
}

/** Keep every Nth point so long routes stay light to store and draw. */
function simplify(coords, maxPoints = 600) {
  if (coords.length <= maxPoints) return coords;
  const step = Math.ceil(coords.length / maxPoints);
  const out = coords.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== coords[coords.length - 1]) out.push(coords[coords.length - 1]);
  return out;
}

// Countries that sign road distances in miles.
const MILES = new Set(['US', 'GB', 'LR', 'MM']);

function unitsForLocale(locale) {
  const region = (String(locale || '').split(/[-_]/)[1] || '').toUpperCase();
  return MILES.has(region) ? 'mi' : 'km';
}

function fmtDistance(meters, units) {
  const v = units === 'mi' ? meters / 1609.344 : meters / 1000;
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units}`;
}

module.exports = { timeline, pointAtMinute, simplify, unitsForLocale, fmtDistance };
