# FRANK — Fjord Risk Assessment & Navigation Kit

A go/no-go app for kayaking on Danish fjords. It merges MET Norway weather with DMI marine forecasts into one hourly picture, rates every hour against your personal limits — **Good to go / Take care / Rough** — and finds launch windows that fit them.

It's honest about uncertainty (lower-confidence hours are marked, degraded data sources are named) and it is not a professional safety service. It doesn't replace club rules, official warnings, or looking at the water. Your judgement rules.

## Locations

Configured in `src/config/locations.json`: **Horsens Fjord**, **Vejle Fjord**, **Kolding Fjord**, and **Aarhus Bugt**. Wind caps follow what Danish clubs actually publish — a flat ~5 m/s rule plus a distance-from-shore rule, not per-direction numbers (Brejning Båd Klub and Kolding Kajak Klub publish the figures used here). The per-direction sectors layered on top are the app's own refinement, with offshore capped lower than onshore (see below).

## Data sources

- **Weather** — MET Norway Locationforecast: temperature, wind, gusts, precipitation, and MET's own `symbol_code`, which decides the weather condition. FRANK never derives its own.
- **Water & waves** — DMI Forecast EDR API: DKSS for water level (a storm-surge model, not a tide table) and water temperature; WAM for wave height, direction, and period.
- **Warnings** — official DMI warnings via the MeteoAlarm Denmark feed, filtered to the location's region. Advisory only: a warning shows a stripe and badges overlapping windows, but never changes the verdict.

MET Norway, DMI, and MeteoAlarm data are all CC BY 4.0 — the app's footer carries the attributions.

## How the verdict works

You set limits (max wind, gust margin, max wave, minimum water temperature, daylight, and more), or pick a preset: **Chill / Normal / Pro**. Touching any value switches to **Custom**, persisted per location. Each fjord also has curated wind sectors with their own caps — offshore sectors are capped *lower* than onshore despite flatter water, because fralandsvind blows you away from shore (drift risk beats chop). You can adjust the caps but not the geometry.

Every enabled rule runs on every hour and may only raise the rating, never lower it; all triggered reasons are shown. A **launch window** is an unbroken run of Good-to-go hours (endpoints included — a 1-hour window needs 2 consecutive good samples), split at midnight for display. Past the ~2-day hourly range, MET's coarser multi-hour periods become outlook blocks, marked lower confidence throughout.

## The UI

Top to bottom: a device-style header (a CRT with a GERTY face — smile, straight, frown — a dot-matrix display with the verdict phrase, and a flag button that switches the whole interface between Danish and English), the DMI warning stripe when one's active, the trip profile selector, a conditions snapshot for the selected hour, an hour-by-hour meteogram with day tabs, launch windows as both a card list and a day-row Gantt calendar (one row per day on a 00–24 axis, real sunrise/sunset shading), the collapsed safety-limits panel (with a manual explaining the exact formulas), and detailed graphs for wind, waves, water level, and temperature — with a sticky axis and an optional overlay of your own caps as labeled lines. The graphs cover the hourly range; the coarser outlook blocks show their ranges in the snapshot and launch-window views instead. It's a PWA: installable, and the shell works offline with an honest offline state — cached forecasts are never passed off as fresh.

## Architecture

The client is Vite + React 19 + TypeScript, deployed to GitHub Pages. In production it reads a prebuilt forecast JSON from a Cloudflare Worker (`frank-forecast`, `worker/index.js`), which runs a 10-minute cron: it checks MET's `Expires` header and DMI's model-run ids, rebuilds only when something actually changed, and stores one payload per location in KV. Each provider's last-good data is retained independently, so one provider being down degrades the payload (and says so) instead of freezing it. Payloads carry a version stamp; the Worker refuses to re-serve payloads built by older logic.

The Worker imports the client's own `normalize.ts`, `sun.ts`, and `weatherCodes.ts` (the shared forecast-core), so the two can't drift on the numbers the verdict runs on — which is why `normalize.ts` must stay pure (no client-only imports). In dev, the client skips the Worker and fetches MET/DMI directly through Vite proxies.

## Running it

```bash
npm install          # Node >= 22, npm >= 10
npm run dev          # Vite dev server, direct provider fetching via proxies
npm run test         # Vitest
npm run lint         # oxlint
npm run build        # tsc -b && vite build
npm run worker:deploy
```

`.github/workflows/deploy.yml` lints, tests, builds, and deploys to GitHub Pages on every push to `main`. Don't regenerate `package-lock.json` on Windows — CI needs it built on Linux so platform-specific optional subtrees resolve.

## Where things live

- `src/App.tsx` — composition, top to bottom as described above
- `src/features/forecast/` — fetching, normalization, sun times, warning parsing, caching, status wording
- `src/features/safety/` — the rating engine (`analyzeSafetyConditions.ts`), presets, FRANK's phrases
- `src/features/planner/findLaunchWindows.ts` — window search
- `src/config/locations.json` — coordinates, DMI collections, warning regions, wind sectors
- `src/components/` — the UI pieces; `src/index.css` + `components.css` — tokens and styles
- `worker/index.js`, `wrangler.jsonc` — the forecast Worker and its cron/KV config

## Licences & attribution

Weather data © MET Norway (CC BY 4.0). Marine data © DMI (CC BY 4.0). Warnings via MeteoAlarm (CC BY 4.0). Provider attributions are shown in the app footer, as their terms require.
