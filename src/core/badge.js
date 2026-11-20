// Passenger badge: proves a check-in happened. Contains NO health data, ever.
'use strict';

function badgeText({ checkedAt, routeName, stopCount, mode }) {
  const d = new Date(checkedAt);
  const when = `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
  return [
    `Rydra: driver ${mode === 'shift' ? 'start-of-shift' : 'pre-trip'} check-in completed`,
    `When: ${when}`,
    routeName ? `${mode === 'shift' ? 'Shift' : 'Route'}: ${routeName}` : null,
    `Rest plan: ${stopCount} planned ${stopCount === 1 ? 'break' : 'breaks'}`,
    'This badge contains no health data.',
  ].filter(Boolean).join('\n');
}

module.exports = { badgeText };
