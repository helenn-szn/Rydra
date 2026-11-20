// Passenger badge: proves a check-in happened. Contains NO health data, ever.
'use strict';

function badgeText({ checkedAt, routeName, stopCount }) {
  const d = new Date(checkedAt);
  const when = `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  return [
    'MileZero: driver pre-trip check-in completed',
    `When: ${when}`,
    routeName ? `Route: ${routeName}` : null,
    `Rest plan: ${stopCount} planned ${stopCount === 1 ? 'stop' : 'stops'}`,
    'This badge contains no health data.',
  ].filter(Boolean).join('\n');
}

module.exports = { badgeText };
