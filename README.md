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
Browser / Installed PWA
        │
        ├── App shell assets ────────── GitHub Pages (Offline PWA)
        │
        └── Versioned forecast GET ──── Cloudflare Worker ─── Cloudflare KV
                                                │
                                       5-minute cron / warm-up
                                                │
                                 MET Norway · DMI · MeteoAlarm
```

* **Zero-Upstream Public Traffic**: Visitors only read pre-built snapshots from the Worker and KV. Browser requests never trigger MET, DMI, or MeteoAlarm calls.
* **Rotating Ingestion Cron**: A Cloudflare cron wakes every 5 minutes (`*/5 * * * *`) and refreshes one rotating location. Every location is reached once per 20 minutes, inside the forecast freshness and health thresholds while keeping one Free-plan invocation small.
* **Write-on-Change Storage Optimization**: Forecast data is only re-written to Cloudflare KV when upstream weather models actually change, preserving daily KV write quotas while keeping status timestamps fresh.
* **Resilient Multi-Tier Fallbacks**: If DMI or MET experiences a temporary rate limit or outage, FRANK automatically falls back to held previous simulations and retained raw ingredients, keeping forecasts live with clear degradation indicators.
* **Client-Side Safety Engine**: Risk assessment calculations (wind, gusts, water level, waves, daylight, water temperature) run 100% locally in the paddler's browser against their own chosen safety profile.

## Production Deployment & CI/CD

Production is continuously validated and deployed via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):

- **Automated Validation**: Every commit runs full typechecking, linting (`oxlint`), 500+ Vitest unit/integration tests, Miniflare Cloudflare Worker runtime tests, model contract verification, and 28 Playwright cross-browser/PWA end-to-end tests.
- **Ordered Compatible Deployment**: When merged to `main`, the backward-compatible Worker deploys first; Pages is published only after that succeeds. The two hosts do not provide a single atomic transaction, so release-contract validation and this ordering are the current safety boundary.
- **5-Minute Cron Maintenance**: Scheduled edge crons maintain shared raw provider ingredients (`frank:raw:...`) and immutable generation forecasts (`frank:forecast-release:...`).

## Cloudflare Free Tier Quotas & Guardrails

FRANK is designed for the Cloudflare Free plan, but quota safety is an observed
operational property rather than a permanent claim. Current limits and the code
guardrails are:

| Metric | Free allowance | FRANK guardrail / baseline |
|---|---:|---|
| **Worker requests** | 100,000 / day | 288 cron ticks/day plus public API and health/status requests |
| **CPU** | 10 ms / Free invocation | One rotating location per cron tick; verify real deployed CPU analytics before adding locations or heavier parsing |
| **KV reads** | 100,000 / day | Variable with visitors and ingestion. Public JSON is `no-store`, so there is no claimed zero-cost CDN-read layer |
| **KV writes** | 1,000 / day | 288 heartbeat writes plus changed assembled/raw data; unchanged recovery state is throttled |
| **External subrequests** | 50 / invocation | One event-wide counter stops before 46; a DMI 429 opens a same-event circuit |

The heartbeat is deliberately unconditional: it is the evidence that the
schedule itself still runs. Every other write is variable, so production should
alert on actual Cloudflare usage rather than rely on a fixed estimate in this
README. See Cloudflare's current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/), and [pricing](https://developers.cloudflare.com/workers/platform/pricing/).

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
3. The `validate` job runs the complete checks and uploads the exact tested Pages artifact.
4. The same workflow deploys the Worker, runs best-effort KV generation cleanup, then authenticates and warms all four forecast locations before publishing that artifact to Pages. If even one location cannot become ready within the bounded warm window, the warm job fails and Pages keeps the previous release.
5. Watch the Actions summary, then verify the live app, `/health`, and `/status`.

The `worker-production` GitHub environment needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The warm gate needs repository secret
`FRANK_WARM_TOKEN`, matching the Worker secret of the same name, and repository
variable `FRANK_WORKER_BASE_URL`. There is no `deploy-worker.yml`, hidden
0%-traffic candidate controller, or `FRANK_AUTO_RELEASE_ENABLED` gate in this
checkout.

A visual dislike should normally be reverted with a new commit through `main`.
Cloudflare rollback changes only the Worker version; it does not restore Pages,
KV, or browser storage, so cross-host incident recovery remains manual.

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
| `.github/workflows/` | Validation plus ordered Worker-then-Pages deployment |

## Licence and attribution

FRANK is released under the [MIT License](LICENSE).

Weather data © MET Norway, marine data © DMI, and warning data via MeteoAlarm, each used under CC BY 4.0. Their data licences do not turn FRANK into an official forecast or safety authority.
