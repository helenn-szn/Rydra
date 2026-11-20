// Rest plan: breaks spaced by time, placed at real towns on the route where possible.
'use strict';

const SNAP_WINDOW_MIN = 60;   // a town within 60 minutes BEFORE the target time counts
const END_BUFFER_MIN = 45;    // no break in the last 45 minutes of the trip

/**
 * @param {{towns:{name:string,min:number}[]}} route
 * @param {number} tripHours
 * @param {number} breakEveryMin
 * @returns {{name:string, atMin:number, town:boolean}[]}
 */
function buildRestPlan(route, tripHours, breakEveryMin) {
  const total = Math.round(tripHours * 60);
  const towns = ((route && route.towns) || []).slice().sort((a, b) => a.min - b.min);
  const stops = [];
  let last = 0;

  while (true) {
    const target = last + breakEveryMin;
    if (target > total - END_BUFFER_MIN) break;
    // Prefer the latest town before the target (never stretch past the interval), within the window.
    const candidates = towns.filter((t) => t.min > last + 30 && t.min <= target && t.min >= target - SNAP_WINDOW_MIN);
    const pick = candidates[candidates.length - 1];
    const stop = pick ? { name: pick.name, atMin: pick.min, town: true } : { name: `Stop around ${fmtDuration(target)} in`, atMin: target, town: false };
    stops.push(stop);
    last = stop.atMin;
  }
  return stops;
}

function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

module.exports = { buildRestPlan, fmtDuration };
