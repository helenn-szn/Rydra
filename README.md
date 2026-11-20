# Rydra

**A private check-in for long-distance drivers, before, during and after the journey.**

Drivers check their tyres, fuel and engine before a long trip. Rydra is a check for the person behind the wheel. It uses the [Presage SmartSpectra SDK](https://smartspectra.presagetech.com/docs/nodejs) to read live pulse and breathing from a laptop camera, compares them with the driver's *own* usual readings, and builds a rest plan with breaks at real towns on the route.

Built for the Presage SmartSpectra SDK Challenge on DEV.

> Rydra is a wellness and planning aid. It is **not a medical device** and never says a driver is "safe to drive" or "fatigued."

## Who it's for

| Driver | How Rydra works for them |
| --- | --- |
| Bus or coach | Plan a route on the map. Breaks are placed along the road, named after the nearest town, with a passenger badge. |
| Taxi or ride-hail | Start a shift by length (e.g. 8 h). Breaks are spaced through the shift, with start- and end-of-shift checks. |
| Private car | Plan any trip on the map, or just enter the driving time. |

Works anywhere: place search and routing use OpenStreetMap data worldwide. Interface in **English, Nigerian Pidgin, French and Spanish**. Distances in km or miles (set from your region, changeable).

## What it does

| Stage | What happens | How live signals change it |
| --- | --- | --- |
| Start check | 60-second camera check with a face guide and live light / position / stillness dots, plus 3 questions | Pulse or breathing well above the driver's usual range offers a 60-second settle routine |
| Settle routine | Paced breathing (4 s in, 6 s out) with live breathing feedback, then a 30-second re-measure | Shows before and after on the driver's usual-range bars |
| Rest plan | Breaks about every 2 h (90 min after short sleep or sleepiness), drawn on the route map | Shorter interval when the check-in calls for extra care |
| On the road | A big green "Next break" sign with a live countdown, plus a notification and chime when a break is due | |
| Passenger badge | QR code passengers can scan (bus and coach) | Shows only "check-in completed" and the number of breaks, **never readings** |
| Break check | 30-second check + "How do you feel?" | Change since setting off, plus feeling sleepy, suggests a longer break or a 20-minute nap timer |
| Arrival / end of shift | Wind-down check | Start-of-trip readings build the baseline for next time |

What the driver says always outranks the camera: "fighting to stay awake" or under 4 hours' sleep means *don't start until rested*, whatever the readings show. Results use road-sign shapes (green panel, yellow diamond, red octagon), so they never rely on colour alone.

Design: Overpass (an open typeface based on the highway-sign alphabet), real sign colours, a day/night display that switches automatically after 7 pm, and large touch targets with the main action pinned under the thumb.

## Setup

Requirements: Node.js 20+, a webcam, and macOS (Apple Silicon), Windows x64 or Linux x64/arm64 (glibc 2.35+).

```bash
git clone <your repo url> rydra
cd rydra
npm install
cp .env.example .env          # then paste your key from https://physiology.presagetech.com/
npm start
```

Allow camera access, accept the consent screen, choose your kind of driving, then tap **Start a trip** (or **Start a shift**).

### Other ways to run it

| Command | What it does |
| --- | --- |
| `npm run seed` | Starts the app with six past departure checks added (labelled "Seeded demo data"), so the baseline comparison works straight away. Use this for judging and the demo video. |
| `npm run demo` | Runs with a **simulated sensor** and no camera or API key. Every reading is labelled "Demo sensor." For UI development only. |
| `npm test` | Runs the logic tests (baseline, advice rules, rest plans, badge, retention). |
| `npm run dist:mac` / `dist:win` / `dist:linux` | Builds an installer with electron-builder. |

No login is needed.

## How it's built

- **Electron** app, based on Presage's `electron-quickstart`.
- **Map:** Leaflet with OpenStreetMap tiles; place search and town names from Nominatim; driving routes from the public OSRM server. Stops are placed by driving time along the route geometry.
- **SmartSpectra renderer SDK** (`@smartspectra/node-sdk/renderer`) requesting breathing and cardio metrics. Only samples the SDK marks `stable` (Presage's accuracy threshold) are used; a reading needs at least 3 stable pulse samples and 1 stable breathing sample to count as "good."
- **Personal baseline:** median of the last 14 good departure readings, needs 3 to start. "Well above usual" means +12 bpm (or +15%) pulse, or +4 breaths/min.
- **Local storage:** one JSON file in the app's user-data folder, written atomically.
- Core logic is plain JavaScript in `src/core/` with tests in `test/`.

```
main.js            Electron main: window, permissions, local storage
preload.js         SmartSpectra bridge + a small storage API
src/core/          baseline, advice rules, rest plan, route geometry, driver types, badge, retention
src/sensor/        SmartSpectra sensor, demo sensor, sample summarising
src/ui/            screens and flow, map, OpenStreetMap services, translations, icons
```

## Consent and Data Handling

- **Camera consent:** first launch shows a plain-language consent screen. The camera turns on only when the driver starts a check and is released when it ends. Electron is set to grant camera only (no microphone) and only to Rydra's own local page.
- **What is stored:** numbers only: pulse, breathing rate, HRV when available, a quality flag, the driver's answers, rest plans and times. **No video or images are saved.**
- **Where:** on the driver's device only. Rydra has no server.
- **Map (optional):** if the driver uses the map, the place names they search and the route's start, end and stop coordinates are sent to OpenStreetMap services (Nominatim for search and town names, OSRM for routing, OSM for map tiles). **Readings are never sent.** The map can be switched off in Settings; the driver then just enters driving time.
- **Sharing:** none by default. The optional passenger badge contains only "check-in completed," route name, time and number of planned stops.
- **Retention:** 90 days by default (30 or 180 selectable). Older data is deleted on launch. An unfinished trip is kept.
- **Deletion:** Settings → *Delete all my data* erases everything on the device.
- **SDK telemetry:** the SmartSpectra SDK can send aggregate session summaries and readiness reports to Presage. Presage's SDK documentation states these contain **no raw frames or measured vitals**. Rydra turns this **off by default**; the driver can opt in on the consent screen or in Settings.
- **Network:** the SDK validates the API key with Presage's servers. If a camera check can't start (no connection, authentication or credit errors), Rydra falls back to a clearly labelled questions-only check. The saved plan, history and nap timer work without a connection.
- **AI services:** none used.

## Limits

- Camera readings need the driver to be parked, sitting still, facing the camera in reasonable light.
- Pulse and breathing change for many reasons (heat, caffeine, stress, rushing). Rydra says so beside every comparison and never treats them as a measure of tiredness.
- Route times come from OSRM and are planning estimates, not navigation.
- The public OSRM and OpenStreetMap servers are for light use. A production release should use its own routing and tile servers, or a commercial provider.
- Rydra runs on laptops and desktops (Windows, macOS, Linux). A phone version needs Presage's Android or iOS SDK and is the next step.

## Licence

Rydra code: MIT. The SmartSpectra SDK is licensed separately by Presage Technologies.
