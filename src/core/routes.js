// Preloaded routes. Times are APPROXIMATE driving minutes from departure under normal traffic,
// for planning breaks only. Edit freely; they are not navigation data.
'use strict';

const ROUTES = [
  {
    id: 'lagos-abuja',
    name: 'Lagos to Abuja (via Lokoja)',
    hours: 10.5,
    towns: [
      { name: 'Ibadan', min: 120 },
      { name: 'Ife', min: 180 },
      { name: 'Ilesa', min: 210 },
      { name: 'Akure', min: 270 },
      { name: 'Owo', min: 315 },
      { name: 'Okene', min: 420 },
      { name: 'Lokoja', min: 480 },
    ],
  },
  {
    id: 'lagos-ph',
    name: 'Lagos to Port Harcourt',
    hours: 10,
    towns: [
      { name: 'Sagamu', min: 60 },
      { name: 'Ore', min: 210 },
      { name: 'Benin City', min: 300 },
      { name: 'Asaba', min: 390 },
      { name: 'Onitsha', min: 405 },
      { name: 'Owerri', min: 510 },
    ],
  },
  {
    id: 'abuja-kano',
    name: 'Abuja to Kano',
    hours: 6,
    towns: [
      { name: 'Kaduna', min: 150 },
      { name: 'Zaria', min: 225 },
    ],
  },
  {
    id: 'custom',
    name: 'Another route (enter hours)',
    hours: null,
    towns: [],
  },
];

function getRoute(id) {
  return ROUTES.find((r) => r.id === id) || ROUTES[ROUTES.length - 1];
}

module.exports = { ROUTES, getRoute };
