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

Every enabled rule runs on every hour and may only raise the rating, never lower it; all triggered reasons are shown. A **launch window** is an unbroken run of Good-to-go hours (endpoints included — a 1-hour window needs 2 consecutive good samples), split at midnight and at any gap in the forecast series. Past the ~2-day hourly range, MET's coarser multi-hour periods become outlook blocks, marked lower confidence throughout.

**Unknown is never treated as safe.** DMI's marine models leave nodes masked inside some fjords, so a reading can simply be absent. A missing value is carried as "no reading" rather than being filled in with a zero — it shows as `—` in the UI, and any hour where an enabled rule had nothing to judge is held at *Take care* with the missing field named, never cleared and never offered as a launch window. The same applies to a stored profile whose thresholds have been corrupted: they fall back to the defaults rather than silently disabling a check.

## The UI

Top to bottom: a device-style header (a CRT with a GERTY face — smile, straight, frown — a dot-matrix display with the verdict phrase, and a flag button that switches the whole interface between Danish and English), the DMI warning stripe when one's active, the trip profile selector, a conditions snapshot for the selected hour, an hour-by-hour meteogram with day tabs, launch windows as both a card list and a day-row Gantt calendar (one row per day on a 00–24 axis, real sunrise/sunset shading), the collapsed safety-limits panel (with a manual explaining the exact formulas), and detailed graphs for wind, waves, water level, and temperature — with a sticky axis and an optional overlay of your own caps as labeled lines. The graphs cover the hourly range; the coarser outlook blocks show their ranges in the snapshot and launch-window views instead. It's a PWA: installable, and the shell works offline with an honest offline state — cached forecasts are never passed off as fresh.

## Architecture

The client is Vite + React 19 + TypeScript, deployed to GitHub Pages. In production it reads a prebuilt forecast JSON from a Cloudflare Worker (`frank-forecast`, `worker/index.js`), which runs a 10-minute cron: it checks MET's `Expires` header and DMI's model-run ids, rebuilds only when something actually changed, and stores one payload per location in KV. Each provider's last-good data is retained independently, so one provider being down degrades the payload (and says so) instead of freezing it. Marine retention has a hard safety limit: a normalized DMI run may bridge at most two missed six-hour model cycles (12 hours, inclusive), based on the run id supplied by DMI. Older, future-dated, or unparseable marine provenance is never assembled into a newly timestamped forecast; the last complete payload keeps its original `fetchedAt`, becomes visibly stale, and eventually fails `/health`. Browser-triggered background refreshes have a 24-second absolute deadline, while each scheduled location receives a fair share of a five-minute tick, so a slow provider cannot leave request work running indefinitely or starve the last fjords. Payloads carry a version stamp: the Worker refuses to re-bless a cache built by older logic and rebuilds it, while the client accepts an older stamp and shows an "out of date" banner rather than leaving users with a dead screen during the window between the two deploys.

The Worker imports the client's own `normalize.ts`, `sun.ts`, and `weatherCodes.ts` (the shared forecast-core), so the two can't drift on the numbers the verdict runs on — which is why `normalize.ts` must stay pure (no client-only imports). In dev, the client skips the Worker and fetches MET/DMI directly through Vite proxies.

## Running it

```bash
npm install          # Node >= 22, npm >= 10
npm run dev          # Vite dev server, direct provider fetching via proxies
npm run test         # Vitest
npm run lint         # oxlint
npm run build        # tsc -b && vite build
npm run worker:deploy
npm run worker:warm -- --base-url https://frank-forecast.example.workers.dev
```

`.github/workflows/deploy.yml` lints, tests, builds, and deploys to GitHub Pages on every push to `main`. Don't regenerate `package-lock.json` on Windows — CI needs it built on Linux so platform-specific optional subtrees resolve.

The normal Pages workflow deliberately does **not** receive Cloudflare credentials. Worker releases use the separate **Deploy forecast Worker** workflow, which is manual, runs only from `main`, and is attached to the protected `worker-production` GitHub environment. Configure that environment with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; required reviewers are recommended. The workflow uses the repository's pinned Wrangler, deploys, then runs `worker:warm`: every configured location is requested sequentially, its location id and payload version are checked, and `/health` must finish successfully. A failure exits nonzero and fails the deployment gate without printing response bodies.

Release order matters because Pages and the Worker are separate deployments:

- **Existing installation / compatibility upgrade:** first ship a frontend that can read the old and new payload contract and wait for Pages to finish. Then dispatch **Deploy forecast Worker** from `main`; its final warm/health step is the release gate.
- **Brand-new environment:** deploy the Worker first, run the sequential warm/health gate against its public URL, and only then publish Pages configured for that URL.

For a local/manual equivalent, run `npm run worker:deploy` followed by `npm run worker:warm -- --base-url <public-worker-url>`. Never reverse the compatibility-upgrade order merely to make both deployments appear simultaneous: an older Worker can continue serving the compatible frontend while a newer incompatible Worker can strand the old frontend.

Whenever a change touches `worker/index.js` or the shared forecast-core it imports (`normalize.ts`, `sun.ts`, `weatherCodes.ts`), deploy the Worker too, and bump `PAYLOAD_VERSION` (`worker/index.js`) alongside `FORECAST_PAYLOAD_VERSION` (`src/features/forecast/types.ts`). They must stay equal: the stamp is what forces the Worker to rebuild instead of re-blessing a cache its own new code did not produce, and leaving it unchanged across a logic change is exactly how a stale Worker goes unnoticed.

Watch the KV **write** budget when changing the refresh paths. The free tier allows 1000 writes/day, and the cron is 144 runs × 4 locations — so anything that writes on every tick spends the whole allowance before a single user arrives. Running out is a silent failure: the write throws inside `ctx.waitUntil`, and the forecast quietly stops updating while still being served as current.

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
