# FRANK — Fjord Risk Assessment & Navigation Kit

FRANK is a small, installable web app that helps sea-kayakers judge when conditions on selected Danish fjords fit their own limits. It combines weather, waves, water level, water temperature, daylight, and official warnings into an hourly overview, then identifies possible launch windows.

[Open FRANK](https://gromykko.github.io/FRANK/) · [Service status](https://frank-forecast.alswatchs.workers.dev/status) · [Machine health](https://frank-forecast.alswatchs.workers.dev/health)

> FRANK is a planning aid, not a professional safety service. Forecast models can be wrong or incomplete. Club rules, official warnings, local knowledge, and what you see at the water always take priority.

## What it does

- Rates every forecast period as **Good to go**, **Take care**, or **Rough** against the selected safety profile.
- Shows the exact reasons behind a rating; colour is never the only explanation.
- Finds uninterrupted launch windows that satisfy duration, daylight, and water-level preferences.
- Keeps missing readings unknown. A missing value is never converted to zero or treated as safe.
- Names stale or degraded sources instead of pretending every value is equally fresh.
- Stores personal limits, selected location, language, and theme only in the browser.
- Works as a PWA: the app shell opens offline and a previously validated forecast can remain available with clear age and connection warnings.

FRANK currently covers **Horsens Fjord**, **Vejle Fjord**, **Kolding Fjord**, and **Aarhus Bugt**.

## Data sources

| Information | Source | How FRANK uses it |
|---|---|---|
| Wind, gusts, precipitation, temperature, weather symbols | [MET Norway Locationforecast](https://api.met.no/weatherapi/locationforecast/2.0/documentation) | Hourly weather and longer-range outlook |
| Water level, water temperature, currents | [DMI Forecast EDR — DKSS](https://www.dmi.dk/friedata/dokumentation/forecast-data-edr-api) | Marine conditions |
| Wave height, direction, period | [DMI Forecast EDR — WAM](https://www.dmi.dk/friedata/dokumentation/forecast-data-edr-api) | Marine conditions |
| Official regional warnings | [MeteoAlarm / DMI](https://www.dmi.dk/varsler) | Advisory warning stripe; never silently changes the local rating |

Provider attribution is also shown in the app. Forecast values are model-grid estimates at configured coordinates, not local measurements.

## How it works

```text
Browser / installed PWA
        │
        ├── app files ─────────────── GitHub Pages
        │
        └── versioned forecast GET ─ Cloudflare Worker ── Cloudflare KV
                                            │
                                  cron or release warm-up
                                            │
                              MET Norway · DMI · MeteoAlarm
```

Visitors only read completed snapshots from the Worker. They do not trigger calls to weather providers. Cloudflare cron considers production locations every ten minutes, but contacts a provider only when its own source policy says work is due: MET follows its expiry window, while DMI probing follows six-hour model publication/completion windows and backoff. A separate ten-minute GitHub schedule resumes or repairs unfinished coordinated releases; it is not a forecast cron.

Cloudflare KV holds prepared forecasts and last-good provider ingredients. Browser storage holds the selected location, display preferences, safety limits, and validated offline forecast copies. Those are separate layers: clearing browser data does not clear Worker KV, and rolling back Worker code does not roll back KV.

The safety engine runs entirely in the browser. It applies every enabled rule independently and only raises a rating; one passing rule cannot cancel a failing one. A missing enabled safety input produces at least an amber result. Missing optional planner data blocks only the preference that requires it; it is never converted to a safe-looking zero.

## Releases without half-built updates

Production is controlled by [`.github/workflows/deploy-worker.yml`](.github/workflows/deploy-worker.yml). Validation and production writes are deliberately separate.

- A UI-only change can publish the tested Pages build without rebuilding forecast data.
- A Worker-only operational change is staged at 0% traffic and checked against the existing generation.
- A new location prepares only its own cold cache; existing locations remain reusable.
- A forecast-model change prepares an isolated generation for every public location.
- A breaking API change is refused until an explicit compatibility implementation exists.

Worker-bearing releases are blue-green: the old Worker remains at 100% while the candidate is prepared at 0%. Promotion happens only after the required target caches and health contract pass. Pages publishes last. If a provider is busy, the candidate stays at 0%, completed cache work is retained, and a later scheduled GitHub run resumes it.

There is one deliberate bootstrap exception: until the first coordinated baseline marker and journal exist, even an otherwise UI-only change follows the full all-location shadow path. That one-time release establishes the trusted Worker/Pages identity from which impact-aware releases can safely become selective.

Installed/open tabs keep a complete old shell until a clean handover. The service worker validates the full replacement build before activation and retains one previous shell. Worker KV retains the current forecast generation plus the single explicitly audited compatible N−1 descriptor when one is declared (the first baseline declares none). Proven N−2 data becomes eligible for garbage collection only after an established coordinated journal and a later successful Worker-bearing release; the first coordinated release skips destructive cleanup.

## Privacy

FRANK has no accounts, advertising, cookies, device-location request, forms, or third-party product analytics. It does not upload personal safety settings.

The hosts still receive ordinary connection metadata such as IP address and user agent. Cloudflare receives the requested location id. Scheduled Worker jobs send only FRANK's fixed forecast coordinates and provider-required request metadata to MET Norway, DMI, and MeteoAlarm. The in-app technical data note describes this boundary and provides a scoped **Delete local FRANK data** control.

If analytics, advertising, embedded social content, accounts, or new client-side storage are added, reassess the privacy note and Danish cookie-consent requirements before release.

## Local development

Requirements: Node.js 22.12 or newer and npm 10 or newer.

```bash
npm ci
npm run dev
```

The UI uses the production Worker by default. To test against a local Worker, copy `.env.example` to `.env.local`, then start both processes:

```bash
npm run worker:dev
# In another terminal:
npm run dev
```

Common checks:

```bash
npm test                    # unit and contract tests
npm run lint                # oxlint
npm run build               # TypeScript plus production Pages build
npm run test:e2e:install    # one-time Chromium install
npm run test:e2e            # real-browser desktop/mobile/PWA checks
npm run worker:typecheck    # Worker and Workerd TypeScript
npm run test:worker-runtime # real Workerd/KV tests
npm run worker:types:check  # generated binding types are current
npm run worker:dry-run      # bundle Worker without deploying
npm run release:check-contract
```

Do not regenerate `package-lock.json` casually across operating systems. CI depends on its platform-specific optional dependency tree remaining reproducible.

## Deployment

1. Make a focused change and run the relevant local checks.
2. Push or merge it to `main`.
3. `Validate FRANK` performs read-only CI.
4. After successful validation, `Release FRANK production` classifies the impact and either publishes Pages, stages a Worker candidate, or resumes a waiting candidate.
5. Watch the Actions summary, then verify the live app and `/status`.

Production requires the `worker-production` environment secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `FRANK_WARM_TOKEN`, plus repository variable `FRANK_AUTO_RELEASE_ENABLED=true` for automatic delivery. Do not reproduce the release workflow with ad-hoc `wrangler deploy` commands: its captured-version, 0%-traffic, exact-readiness, Pages-ordering, and recovery checks are part of the safety contract.

A visual dislike should normally be reverted with a new commit through `main`. Cloudflare's standalone **Rollback** button selects a previous Worker version only; it does not restore Pages, KV, browser storage, or FRANK's journal and is therefore an incident tool, not a routine rollback.

## Forecast-contract changes

Release identities live in [`src/features/forecast/releaseContract.ts`](src/features/forecast/releaseContract.ts). They are intentionally independent:

- API schema: the browser/Worker wire contract.
- Model revision and data-generation id: the meaning of forecast calculations and provenance.
- Cache schemas: internal KV envelope formats.
- Payload stamp: the baseline payload representation.
- Location config revision: provider-facing inputs for one location.

`npm run release:check-contract` fails closed when protected forecast semantics or provider-facing location inputs changed without the required revision. Only after reviewing an intentional model change should `npm run release:record-model` update the audited baseline.

## Repository map

| Path | Responsibility |
|---|---|
| `src/components/` | React interface |
| `src/features/forecast/` | Public payload types, validation, browser cache, freshness, normalization |
| `src/features/safety/` | Presets and hourly safety-rating engine |
| `src/features/planner/` | Launch-window search |
| `src/config/locations.json` | Public locations and forecast-facing configuration |
| `src/pwa/` and `public/sw.js` | Atomic app-shell update and offline behavior |
| `worker/` | Provider transport, forecast assembly, KV, routes, cron, health/status |
| `scripts/` | Fail-closed release, verification, attestation, and KV maintenance tools |
| `tests/` | Unit, contract, Workerd, service-worker, and browser tests |
| `.github/workflows/` | Read-only validation and coordinated production controller |

## Licence and attribution

FRANK is released under the [MIT License](LICENSE).

Weather data © MET Norway, marine data © DMI, and warning data via MeteoAlarm, each used under CC BY 4.0. Their data licences do not turn FRANK into an official forecast or safety authority.
