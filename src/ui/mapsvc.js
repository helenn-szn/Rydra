// OpenStreetMap services: place search + town names (Nominatim) and driving routes (OSRM).
// Only place names and coordinates are sent. Readings never leave the device.
// Nominatim's policy allows at most 1 request per second and no search-as-you-type, so
// searches run only when the driver presses Search, and calls are queued 1.1 s apart.
'use strict';

const { timeline, simplify } = require('../core/geo');

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM = 'https://router.project-osrm.org';

let lastNominatim = 0;
async function nominatim(path, lang) {
  const wait = Math.max(0, lastNominatim + 1100 - Date.now());
  lastNominatim = Date.now() + wait;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const res = await fetch(`${NOMINATIM}${path}`, { headers: { 'Accept-Language': lang || 'en' } });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  return res.json();
}

function placeName(p) {
  const a = p.address || {};
  const main = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || p.name || (p.display_name || '').split(',')[0];
  const region = a.state || a.country;
  return region && region !== main ? `${main}, ${region}` : main;
}

/** Search a place by text. Returns up to 5 matches. */
async function searchPlace(query, lang) {
  const q = encodeURIComponent(query.trim());
  const rows = await nominatim(`/search?format=jsonv2&addressdetails=1&limit=5&q=${q}`, lang);
  return rows.map((p) => ({ name: placeName(p), full: p.display_name, lat: +p.lat, lon: +p.lon }));
}

/** Nearest town name for a point on the route (city-level zoom). */
async function townAt(lat, lon, lang) {
  try {
    const p = await nominatim(`/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${lat}&lon=${lon}`, lang);
    return p && !p.error ? placeName(p) : null;
  } catch {
    return null;
  }
}

/** Driving route between two places. */
async function drivingRoute(from, to) {
  const url = `${OSRM}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&annotations=duration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Route lookup failed (${res.status})`);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('No driving route found between these places.');
  const r = data.routes[0];
  const coords = r.geometry.coordinates;
  const durations = r.legs.flatMap((l) => (l.annotation && l.annotation.duration) || []);
  const tl = timeline(coords, durations);
  // Store a lighter copy: enough to draw and to place stops.
  const light = simplify(tl.map((p) => [p.lon, p.lat, p.min]));
  return {
    distanceM: r.distance,
    minutes: r.duration / 60,
    path: light.map(([lon, lat, min]) => ({ lat, lon, min })),
  };
}

module.exports = { searchPlace, townAt, drivingRoute, placeName };
