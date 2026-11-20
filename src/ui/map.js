// Leaflet map: the route drawn like a highway on a sign, stops as numbered markers.
'use strict';

const L = require('leaflet');

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

let current = null;

function destroyMap() {
  if (current) { current.remove(); current = null; }
}

/**
 * Draw a route with start, end and numbered rest stops.
 * @param {HTMLElement} el
 * @param {{path:{lat,lon}[], from?:{lat,lon,name}, to?:{lat,lon,name}, stops?:{lat,lon,name}[], nextIndex?:number}} opts
 */
function drawRoute(el, { path, from, to, stops = [], nextIndex = -1, interactive = true }) {
  destroyMap();
  const map = L.map(el, {
    zoomControl: interactive, attributionControl: true, dragging: interactive, scrollWheelZoom: false,
    doubleClickZoom: interactive, boxZoom: false, keyboard: interactive, touchZoom: interactive,
  });
  current = map;
  L.tileLayer(TILE_URL, { maxZoom: 18, attribution: ATTRIBUTION }).addTo(map);
  map.attributionControl.setPrefix(false);

  const line = path.map((p) => [p.lat, p.lon]);
  if (line.length > 1) {
    L.polyline(line, { color: '#ffffff', weight: 9, opacity: 1, lineCap: 'round' }).addTo(map);
    L.polyline(line, { color: '#8a9dff', weight: 5, opacity: 1, lineCap: 'round' }).addTo(map);
  }

  const pin = (cls, html, title) => L.divIcon({ className: `pin ${cls}`, html, iconSize: [26, 26], iconAnchor: [13, 13], title });
  if (from) L.marker([from.lat, from.lon], { icon: pin('pin-end', '', from.name), title: from.name, keyboard: false }).addTo(map);
  if (to) L.marker([to.lat, to.lon], { icon: pin('pin-end', '', to.name), title: to.name, keyboard: false }).addTo(map);
  stops.forEach((s, i) => {
    if (s.lat == null) return;
    const cls = i < nextIndex ? 'pin-done' : i === nextIndex ? 'pin-next' : 'pin-stop';
    L.marker([s.lat, s.lon], { icon: pin(cls, String(i + 1), s.name), title: s.name, keyboard: false }).addTo(map);
  });

  const bounds = L.latLngBounds(line.length ? line : [[from.lat, from.lon], [to.lat, to.lon]]);
  map.fitBounds(bounds, { padding: [28, 28] });
  // Containers sometimes size after first paint.
  setTimeout(() => map.invalidateSize(), 60);
  return map;
}

module.exports = { drawRoute, destroyMap };
