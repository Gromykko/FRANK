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

The client is Vite + React 19 + TypeScript, deployed to GitHub Pages. In production it reads a prepared forecast JSON from a Cloudflare Worker (`frank-forecast`, `worker/index.ts`), which runs a 10-minute cron: it checks MET's `Expires` header and DMI's model-run ids, rebuilds only when something actually changed, and stores one payload per location in generation-isolated KV keys. Each provider's last-good data is retained independently, so one provider being down degrades the payload (and says so) instead of freezing it. Marine retention has a hard safety limit: a normalized DMI run may bridge at most two missed six-hour model cycles (12 hours, inclusive), based on the run id supplied by DMI. Older, future-dated, or unparseable marine provenance is never assembled into a newly timestamped forecast; the last complete payload keeps its original `fetchedAt`, becomes visibly stale, and eventually fails `/health`. Ordinary and manual browser requests only read completed snapshots; they never contact weather providers or start background builds. Each scheduled location receives a fair share of a five-minute tick, so a slow provider cannot starve the last fjords.

The Worker imports the client's own `normalize.ts`, `sun.ts`, and `weatherCodes.ts` (the shared forecast-core), so the numbers the verdict runs on have one implementation — which is why `normalize.ts` must stay pure (no client-only imports). Development and production clients both use the Worker's versioned forecast contract; set `VITE_FORECAST_WORKER_BASE` when the UI should target a local Worker instead of the production default.

Location availability is independent while a candidate is prepared, but production promotion is all-or-nothing. If a known location has no completed target-generation forecast, browser reads return a versioned `FORECAST_INITIALIZING` 503 with `Retry-After` and no provider detail. Only cron and the zero-traffic release warm-up may build; a ten-minute, generation-scoped cooldown prevents repeated candidate attempts from hammering a busy provider. The release stays at zero traffic until every public location is exact-ready, so first visitors never become builders and a partly ready generation never replaces production. Invalid provider shapes, unsupported 4xx responses, code errors, deadlines, and storage failures stay hard failures and can never be relabeled as initialization. `/health` remains red while any location is missing or stale, so monitoring stays honest.

## Privacy

FRANK has no accounts, forms, device-location request, advertising, cookies, or third-party product-analytics service. The selected area, language, theme, per-location safety limits, and last usable forecast are stored in the browser only; a scoped control in the footer deletes those FRANK-owned values without clearing other projects on the shared `github.io` origin. Browser forecast copies and Worker KV entries are isolated by API and data generation. A small browser-only authority journal records which fully validated Worker generation answered most recently, so a promotion or intentional rollback remains correct offline without old and new tabs overwriting each other's forecast.

Safety settings use stable, location-scoped browser keys and their own inline storage schema; app builds, service-worker releases, forecast APIs, and forecast data generations never participate in those keys. The inline metadata leaves every setting at its original top-level path so an overlapping older shell remains able to read it. Existing raw profiles migrate only after a successful parse, individual corrupt fields heal conservatively, and an unreadable or future record is preserved byte-for-byte until the user deliberately replaces it. Remembered Custom profiles stay separate for every location.

The browser sends only the requested location id and ordinary HTTP metadata to the forecast Worker—there is no settings/profile request body and no timestamp cache-buster. GitHub Pages and Cloudflare still process ordinary connection data such as IP address for hosting and security. Cloudflare automatic request/response invocation logs are disabled; deliberately emitted operational events and failures remain available briefly for diagnosis. MET Norway, DMI, and MeteoAlarm are contacted only by scheduled refreshes and zero-traffic release preparation, not in a visitor's request context; they receive FRANK's fixed forecast coordinate, never device GPS or saved settings. The in-app bilingual technical note explains this boundary and links directly to the providers' published data sources. It is deliberately not presented as a complete legal privacy notice until the operator publishes a verified identity and private contact channel. If analytics, advertising, embedded social widgets, or unrelated client-side storage are added later, reassess both the notice and Danish cookie-consent requirements before release.

## Running it

```bash
npm install          # Node >= 22, npm >= 10
npm run dev          # Vite UI using the configured forecast Worker
npm run test         # Vitest
npm run test:e2e:install # One-time local Chromium installation
npm run test:e2e     # Production-build browser checks at desktop and phone widths
npm run lint         # oxlint
npm run build        # tsc -b && vite build
npm run worker:types:check
npm run worker:typecheck
npm run test:worker-runtime
npm run worker:dry-run
npm run worker:warm -- --help # inspect the read-only release gate
npm run release:check-contract # fail closed on unsupported breaking API changes
npm run release:build-id      # validate dist's atomic PWA release files after build
```

`.github/workflows/deploy.yml` is validation only. Pushes and pull requests audit, lint, test, type-check, bundle, build and run the browser suite, but they have no Pages or Cloudflare write permission. Production never changes merely because `main` changed. Don't regenerate `package-lock.json` on Windows — CI needs it built on Linux so platform-specific optional subtrees resolve.

Production uses one manual **Release FRANK production** workflow from `main`. Protect both its `worker-production` and `github-pages` environments; configure `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` only on `worker-production`, and require a reviewer. The workflow checks out the dispatch-time SHA explicitly, repeats the complete CI suite, builds one Pages artifact, records its build id, and never rebuilds that artifact later in the release.

The release is blue-green and Worker-first:

1. Record the immutable Worker version currently serving 100% of traffic.
2. Upload the exact commit as a candidate with no traffic, resolve its immutable version id, and create an explicit `old@100% + candidate@0%` deployment.
3. Route sequential warm and health requests to that exact 0% candidate with Cloudflare's version-override header. Every response must expose that candidate id in `X-FRANK-Worker-Version`.
4. Require an exact match on API schema, model revision, data-generation id, assembled-cache schema, marine-cache schema and payload stamp, plus a completed generation, a usable future horizon, recent upstream-check clock, and data inside the existing health-age budget for **every** public location. The gate warms only the current canonical `/api/vN` route. An explicitly audited N−1 generation may remain available during preparation, but it never counts as target readiness.
5. Validate the checked-in compatibility policy before any candidate upload. Same-API previous generations are permitted rollback/fallback descriptors. If any audited previous generation names a different API schema, the release fails closed: a one-time deployment probe cannot keep that old representation fresh while Pages approval is pending or while an installed old shell remains in use. A breaking API stays blocked until an explicit continuous representation-adapter registry, version-specific serializer/validator, and dual materialization have been implemented and audited.
6. Only then promote the candidate to 100%, verify the exact control-plane distribution, and repeat the exact-current gate through ordinary traffic with explicit read-only mode. The post-promotion check omits `warm=1`, cannot call providers, and cannot heal an empty cache. Health may take its bounded propagation window to change from a consistent missing/fallback state to exact-ready; malformed or contradictory health fails immediately, and readiness that never converges fails the release.
7. Only after the Worker succeeds does GitHub Pages publish the already-tested artifact. The live smoke waits for the exact build id and verifies its HTML identity, release descriptor, precache manifest, every hashed asset and the static shell.

Both Worker readiness gates append a private GitHub Actions summary with exact-ready counts and an explicit line for Horsens Fjord, Vejle Fjord, Kolding Fjord, and Aarhus Bugt. A failed gate retains its last completed city and identifies the city being checked when it stopped. Candidate routing remains an internal Cloudflare version-override request header; no version identifier or override is exposed through a public warm-up URL.

A busy or degraded provider is not automatically a failed release. If every location already has the exact complete target-generation payload, `needsRebuild` is false, the future horizon remains usable, the check clock is current, and the data is younger than the health limit, the cached forecast safely carries the release. Busy initialization with no exact cache, missing or expired data, a stale check clock, or an unfinished target generation still fails.

Any Worker-stage failure after the candidate upload restores the captured version explicitly at 100% and verifies that exact restoration—even if the staging command may have changed traffic before reporting an error. Because the Pages job depends on the complete Worker job, a DMI 429/busy response that leaves no exact usable cache, or any persistently missing location, leaves Pages unchanged and users remain on the old release. A Pages publish failure happens only after the new Worker has proved the exact current contract and the compatibility policy has passed, so the old Pages artifact remains usable; the workflow never performs a dangerous Worker rollback underneath a possibly published new client.

Before any candidate upload or traffic mutation, the workflow probes the captured immutable production version through Cloudflare's version override and requires its root body, full release headers, and Worker-version header to agree exactly. A described release must equal `CURRENT_RELEASE` or the sole audited same-API N−1; a skipped release generation therefore fails before it can endanger the actual rollback Worker. The only exception is a clean absence of all release metadata from the one pre-architecture Worker. That bootstrap may proceed with KV cleanup explicitly disabled. After the promoted Worker is exact-ready through ordinary traffic, a persistent `frank:release-control:` KV marker records that the coordinated baseline exists; every later metadata-free capture fails closed instead of repeatedly taking the exception.

After promoted ordinary traffic is exact-ready and the automatic rollback steps have already been evaluated, the release garbage-collects superseded generation-scoped KV keys. It retains `CURRENT_RELEASE` and at most one explicitly audited same-API N−1 generation. The destructive command requires the canonical captured-release attestation produced before upload, is a dry run unless `--apply` is explicit, lists only the `frank:forecast-release:` namespace, ignores legacy or malformed keys, and refuses ambiguous, same/newer, cross-API, or multiply-audited generations instead of guessing. It re-lists immediately before deletion and retries post-delete verification with bounded exponential backoff because Cloudflare KV listings are eventually consistent. A cleanup failure stops Pages publication but cannot trigger a Worker rollback after deletion.

The first coordinated release is a one-time bootstrap: the pre-baseline production Worker does not expose `/api/v1`, while the new Pages shell uses only `/api/v1`. Automatic restoration is therefore confined to `worker_release`, before `pages_release` can start. Once the first Pages publication has begun, never manually restore that pre-baseline Worker; recover by rolling Pages forward or repairing the new Worker. Every Worker captured after this baseline exposes `/api/v1`, so later releases return to symmetric exact-version rollback.

For installed/open apps, a Pages publish is also staged rather than mixed into the running document. The current service worker keeps serving its complete old shell; the candidate downloads and validates one build-bound descriptor, HTML file, manifest and all assets into a separate cache, then waits while FRANK windows are open. A later clean navigation activates the complete new shell atomically. Old and new shell caches overlap for one handover, so an existing tab can still load an old lazy chunk. Forecast data is independently generation-keyed, and a breaking API remains blocked until expand-contract routing can continuously serve every supported representation. Therefore neither a half-cached UI nor a new Worker underneath an unsupported old client is part of a normal release.

There is deliberately no “UI-only” or “allow partial” production checkbox. Such a bypass is impossible to prove safe from a manual label when frontend and Worker share forecast code. An ordinary UI release normally passes immediately against the already-ready current generation. A serious normalization/provenance change advances `FORECAST_MODEL_REVISION` and `FORECAST_DATA_GENERATION_ID` in `releaseContract.ts`, which creates a shadow KV namespace and forces the exact-all warm before promotion. This conservative single path is slower than three release modes and much harder to misuse.

For a read-only local release check, run the normal test commands plus `npm run worker:dry-run`. Do not reproduce the production mutations by hand unless recovering an incident: the workflow's captured-version, zero-traffic, override, exact-readiness and Pages-ordering guarantees are the release contract, not optional ceremony.

Whenever a change touches `worker/*.ts` or the shared forecast-core it imports (`normalize.ts`, `sun.ts`, `weatherCodes.ts`), use the coordinated release. Release identities live in `src/features/forecast/releaseContract.ts`: advance the model revision and data-generation id when calculation/provenance meaning changes; add the previous full descriptor to the audited N−1 list; advance an internal cache schema only when that stored envelope changes; advance the API schema only for a genuinely breaking browser contract. The first breaking API release is blocked until an explicit current→N−1 serializer and version-specific validator exist **and** the Worker continuously dual-materializes the old representation while that client is supported. Numeric adjacency is never compatibility, and proving an old route once during deployment does not keep its data fresh indefinitely. `payloadVersion` is only the baseline payload stamp and must not be reused as the model or KV generation counter.

`npm run release:check-contract` also fingerprints every forecast-producing source file and each location's provider-facing inputs. A semantic code change cannot pass until both the model revision and data-generation id advance. Each location has its own `forecastConfigRevision`; changing its coordinate, timezone, DMI collections or warning-area identifiers requires that revision to advance, while adding a genuinely new id starts at revision 1 and leaves existing location caches warm. After reviewing an intentional change, `npm run release:record-model` records the new audited baseline; it refuses to bless an unversioned semantic change or an in-place location mutation without the corresponding revision.

Watch the KV **write** budget when changing the refresh paths. The free tier allows 1000 writes/day, and the cron is 144 runs × 4 locations — so anything that writes on every tick spends the whole allowance before a single user arrives. Running out is a silent failure: the write throws inside `ctx.waitUntil`, and the forecast quietly stops updating while still being served as current.

## Where things live

- `src/App.tsx` — composition, top to bottom as described above
- `src/features/forecast/` — fetching, normalization, sun times, warning parsing, caching, status wording
- `src/features/safety/` — the rating engine (`analyzeSafetyConditions.ts`), presets, FRANK's phrases
- `src/features/planner/findLaunchWindows.ts` — window search
- `src/config/locations.json` — coordinates, DMI collections, warning regions, wind sectors
- `src/components/` — the UI pieces; `src/index.css` + `components.css` — tokens and styles
- `worker/*.ts`, `wrangler.jsonc` — typed Worker routing/cache orchestration, provider adapters, health/status, deadlines, and cron/KV config

## Licences & attribution

Weather data © MET Norway (CC BY 4.0). Marine data © DMI (CC BY 4.0). Warnings via MeteoAlarm (CC BY 4.0). Provider attributions are shown in the app footer, as their terms require.
