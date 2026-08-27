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

Weather-condition wording comes directly from MET's native `symbol_code` and
[official Weathericons legend](https://raw.githubusercontent.com/metno/weathericons/main/weather/legend.csv).
FRANK does not translate it through a numeric WMO-style weather code. English
therefore keeps MET's exact 41 condition names; Danish uses DMI-aligned terms
from [DMI's weather-symbol guide](https://www.dmi.dk/dmis-vejrprodukter/vejrsymboler/)
and [forecast vocabulary](https://www.dmi.dk/nyheder/2019/faa-det-store-koerekort-til-vejrudsigten/).
The icon family and paddling severity remain explicit FRANK decisions, not
claims made by MET or DMI.

## How it works

```text
Browser / Installed PWA
        │
        ├── App shell assets ────────── GitHub Pages (Offline PWA)
        │
        └── Versioned forecast GET ──── Cloudflare Worker ─── Cloudflare KV
                                                │
                                       1-minute cron / warm-up
                                                │
                                 MET Norway · DMI · MeteoAlarm
```

* **Zero-Upstream Public Traffic**: Visitors only read pre-built snapshots from the Worker and KV. Browser requests never trigger MET, DMI, or MeteoAlarm calls.
* **Rotating Ingestion Cron**: A Cloudflare cron wakes every minute (`* * * * *`) and refreshes one rotating location. Every location is reached once per 4 minutes while each Free-plan invocation still processes only one city.
* **Write-Aware Storage Optimization**: Timestamp-only forecast rewrites are suppressed, provider ingredients are reused where possible, and the shared heartbeat is throttled to protect the daily KV write allowance.
* **Resilient Multi-Tier Fallbacks**: If DMI or MET experiences a temporary rate limit or outage, FRANK automatically falls back to held previous simulations and retained raw ingredients, keeping forecasts live with clear degradation indicators.
* **Client-Side Safety Engine**: Risk assessment calculations (wind, gusts, water level, waves, daylight, water temperature) run 100% locally in the paddler's browser against their own chosen safety profile.

### Safety profiles and condition language

The built-in profiles use these inclusive client-side boundaries. A value on a
boundary belongs to the stricter band: for example, Intermediate's general wind band
is **Take care** at exactly 6.0 m/s and **Rough** at exactly 8.0 m/s. Enabled
local sectors and other rules can trigger a stricter result earlier.

| Profile | General wind: Take care / Rough | Significant waves: Take care / Rough |
|---|---:|---:|
| Beginner · IPP 2–informed | 4.0 / 5.0 m/s | 0.20 / 0.50 m |
| Intermediate · IPP 3–informed | 6.0 / 8.0 m/s | 0.30 / 1.00 m |
| Advanced · IPP 4–informed | 8.0 / 10.0 m/s | 0.50 / 2.00 m |

These are FRANK presets, not limits issued by DKF, proof of competence, or a
guarantee that a trip is safe. The Intermediate and Advanced wind anchors use the numeric
conditions in [DKF Touring](https://www.kano-kajak.dk/uddannelse-og-kurser/ipp-roeruddannelse/touring-tur/):
the [IPP 3 Touring norm](https://drive.google.com/file/d/14lUb_7t5ZV1vp49sOBmCmlXuOnSWmQMX/view?usp=sharing)
documents working conditions around 6 m/s and assessment up to 8 m/s, while the
[IPP 4 Touring norm](https://drive.google.com/file/d/1iagdhW-B3ZXvHUmEBSfxVESyne5qevb2/view?usp=sharing)
uses 8–10 m/s. Touring IPP 2 has no numeric wind limit. Beginner's 5 m/s Rough
boundary and the three Rough wave boundaries use the current
[DKF sea-kayak norm, 7 May 2026](https://drive.google.com/file/d/1YoO6StJ_nfwx2kb9X7lyH5y4gFQqp1O5/view?usp=drive_link).
Beginner's 4 m/s Take-care boundary and all three lower wave Take-care boundaries
are FRANK's deliberately conservative starting points. Enabled local
wind-sector caps, gusts, water temperature, weather, daylight, route,
equipment, and club rules can all demand a stricter decision than the general
profile table.

Mean-wind names follow [DMI's Beaufort scale](https://www.dmi.dk/vejr-og-atmosfare/temaforside-vind/beaufortskalaen/).
They are not applied to gusts: MET defines `wind_speed` as a 10-minute mean at
10 m and a gust as a much shorter three-second average in its
[forecast data model](https://docs.api.met.no/doc/locationforecast/datamodel.html).
The DKF/IPP material used for these profiles publishes no separate numeric gust
band. With gust checking enabled,
FRANK conservatively applies the chosen general wind band to either the mean or
the gust; this is a FRANK rule, not a DKF limit. The US National Weather Service
uses the same sustained-wind-or-gust structure in an official
[kayak-facing marine outlook](https://www.weather.gov/mqt/Local_Marine), but its
local Great Lakes numbers are not copied here. Direction-specific sector caps
continue to use sustained wind only because their fetch/chop rationale does not
apply to a momentary gust.
Wave words reuse [WMO's recommended sea-wave terminology](https://community.wmo.int/site/knowledge-hub/programmes-and-initiatives/marine-services/frequently-asked-questions)
only as supplemental context; the numeric height remains the decision input.
DMI defines [significant wave height](https://www.dmi.dk/hav-og-is/temaforside-monsterbolger/bolger-pa-havet)
as the mean height of the highest third of waves and notes that individual
waves can be higher. FRANK separately cautions that this one number does not
describe local surf or short steep chop by itself.

## Production Deployment & CI/CD

Production is continuously validated and deployed via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml):

- **Automated Validation**: Every commit runs full typechecking, linting (`oxlint`), 500+ Vitest unit/integration tests, Miniflare Cloudflare Worker runtime tests, model contract verification, and 28 Playwright cross-browser/PWA end-to-end tests.
- **Ordered Candidate Deployment**: When merged to `main`, a zero-traffic Worker candidate is warmed through its version preview URL and promoted to 100% only after all four locations are ready. Pages is published only after promotion succeeds.
- **1-Minute Cron Maintenance**: Scheduled edge crons rotate across the four cities while maintaining shared raw provider ingredients (`frank:raw:...`) and immutable generation forecasts (`frank:forecast-release:...`).

## Cloudflare Free Tier Quotas & Guardrails

FRANK is designed for the Cloudflare Free plan, but quota safety is an observed
operational property rather than a permanent claim. Current limits and the code
guardrails are:

| Metric | Free allowance | FRANK guardrail / baseline |
|---|---:|---|
| **Worker requests** | 100,000 / day | 1,440 cron ticks/day plus public API and health/status requests |
| **CPU** | 10 ms / Free invocation | One rotating location per cron tick; verify real deployed CPU analytics before adding locations or heavier parsing |
| **KV reads** | 100,000 / day | Variable with visitors and ingestion. Public JSON is `no-store`, so there is no claimed zero-cost CDN-read layer |
| **KV writes** | 1,000 / day | Normal-day estimate: about 288 throttled heartbeat writes + 0 expected anomaly/recovery writes + about 432 forecast/raw writes = about 720/day, leaving about 280 writes of nominal headroom |
| **External subrequests** | 50 / invocation | One event-wide counter stops before 46; a DMI 429 opens a same-event circuit |

The heartbeat is read every tick and normal successful writes are sampled once
every five scheduled ticks. A city with a recorded success and no newer failure
may use the app-wide `lastTickAt`, keeping its displayed check time within about
five minutes without increasing the normal 288-write heartbeat budget. A budget
skip, retry-backoff, or failed refresh writes the first transition to a distinct
city anomaly immediately; an unchanged repeat follows the same five-tick
throttle. The first later success also writes immediately so the failure cannot
remain visible for a full sparse sampling cycle. On a normal day both extra
transition counts are expected to be zero. One anomalous tick followed by
recovery would make the planning total about 722. A schema rollout can also spend
up to four one-time writes to establish each city's first actual provider
contact.

For a stable outage affecting all four cities, the conservative heartbeat bound
is 292 writes/day: up to four immediate first-failure signals plus 288
normal-cadence writes, against the 1,000-write Free allowance. Adding the normal
estimate of
about 432 forecast/raw writes gives about 724/day and about 276 writes of nominal
headroom. Changed failure states, recovery flapping, and forecast failure-state
writes can consume more, so production must monitor actual usage rather than
treat the estimate as a hard cap. Workers KV is eventually consistent, so the
read/compare/write monotonic guard is best-effort and an edge can occasionally
read an older heartbeat and make an extra write. See Cloudflare's current
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[KV limits](https://developers.cloudflare.com/kv/platform/limits/), and
[pricing](https://developers.cloudflare.com/workers/platform/pricing/).

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
4. The workflow uploads a zero-traffic Worker candidate, authenticates and warms all four forecast locations through its version preview URL, promotes that exact version to 100%, runs best-effort KV generation cleanup, and only then publishes the tested artifact to Pages. Any failed gate leaves Pages on the previous release.
5. Watch the Actions summary for the candidate and previous version IDs plus the manual rollback command, then verify the live app, `/health`, and `/status`.

### Invocation telemetry

Stored invocation records appear in **Cloudflare dashboard → Workers & Pages →
frank-forecast → Observability → Logs**. For cron investigations, check **CPU
time**, **wall time**, and **outcome**. On the Workers Free plan, Cloudflare
retains Workers Logs for **3 days**; see the official [Workers Logs pricing and
retention table](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing).
`wrangler tail` is a real-time stream only and stores nothing, so it cannot
provide history after an unattended cron overrun.

#### KV write sampling

To measure actual KV writes, open the Worker's **Observability → Overview**
Query Builder, select **Count**, filter `event` equal to `kv_write`, and group by
`category` (optionally also by `locationId` for per-city categories). These are
console logs only; collecting them performs no KV, D1, or other storage write.
Workers Free retains the logs for about **3 days**, so this is a sampling
exercise rather than a permanent dashboard. Use an uninterrupted **24–48 hour**
window for a representative read that includes MET reissues and at least one
DMI model run. See Cloudflare's [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
and [Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)
documentation.

The `worker-production` GitHub environment needs `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The warm gate needs repository secret
`FRANK_WARM_TOKEN`, matching the Worker secret of the same name, and repository
variable `FRANK_WORKER_BASE_URL`, set to the canonical root production URL
`https://frank-forecast.<account-subdomain>.workers.dev`. The workflow derives
the exact candidate hostname from that trusted value before sending the warm
token.

Preview URLs need one Worker-level bootstrap. Manually dispatch the `CI / CD`
workflow from `main` before relying on normal push deployments, and use another
manual dispatch if previews are later disabled. A manual dispatch continues
through the complete candidate deployment after the bootstrap. Only
`workflow_dispatch` runs `wrangler triggers deploy`; normal pushes do not.
Cloudflare documents that command as applying
[routes, domains, and Cron Triggers](https://developers.cloudflare.com/workers/wrangler/commands/workers/#triggers-deploy)
when using version uploads. The manual bootstrap therefore also reapplies the
unchanged configured cron. There is no separate `deploy-worker.yml` or
`FRANK_AUTO_RELEASE_ENABLED` gate.

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
