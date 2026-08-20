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

`.github/workflows/deploy.yml` is validation only. Pushes and pull requests audit, lint, test, type-check, bundle, build and run the browser suite, but have no Pages or Cloudflare write permission. `.github/workflows/deploy-worker.yml` is the only production controller. A manual dispatch always remains available. Automatic delivery starts only after a successful `Validate FRANK` push run on the current `main`, and ten-minute schedule events only resume unfinished release work. Both automatic paths are disabled unless the repository variable `FRANK_AUTO_RELEASE_ENABLED` is exactly `true`. One non-cancelling `frank-production` concurrency group serializes every trigger.

Protect the `worker-production` and `github-pages` environments and keep `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `FRANK_WARM_TOKEN` on `worker-production`. Shadow inspection, warming and final journal writes use `environment.deployment: false`: they can read the environment secrets without creating a production deployment record. The warm token is available only to credential checks and provider-building warm commands, never on a command line and never to read-only checks. Only the job that promotes a Worker to production traffic creates a `worker-production` deployment. GitHub still applies wait timers and required reviewers to `deployment: false` jobs, so an environment that requires manual approval makes automatic releases wait for that approval; GitHub App custom deployment-protection rules are not compatible with `deployment: false`.

The workflow never trusts changed paths or a human “UI only” checkbox. It builds immutable snapshots from exact Git blobs and compares the candidate with a fail-closed coordinated-production journal. That journal identifies the source commit, exact Worker version, stable Pages-content fingerprint and deployed Pages artifact build. Immediately before writing it, the controller re-verifies the exact live Worker deployment and exact live Pages artifact. Worker-changing releases also repeat exact-all read-only forecast readiness; `none` and `pages-only` releases instead re-attest the active Worker API identity without coupling a UI publication to temporary city/provider freshness. A retry can therefore distinguish steady production from the recoverable split where the Worker already reached candidate A but Pages did not—even if `main` has since advanced to B. It repairs A forward first, then the queued or next scheduled run can release B.

Cloudflare KV does not provide a transactional compare-and-swap for this journal. Safety instead comes from one non-cancelling GitHub concurrency group, expected-previous-source checks, deterministic Worker tags, live identity verification, and treating this CI controller as the sole post-baseline writer. The raw deploy and rollback package shortcuts are intentionally absent; incident recovery must preserve the same journal and split-recovery invariants.

The classifier has six exhaustive outcomes:

- `none` — shipped Pages and Worker identities are unchanged; do nothing.
- `pages-only` — publish the tested Pages artifact without uploading, staging or warming a Worker.
- `worker-nonsemantic` — stage the immutable Worker at 0% and prove it read-only against the existing forecast generation.
- `location-change` — stage at 0%; unchanged location caches remain reusable while the changed/new location is prepared, followed by the exact-all gate.
- `forecast-semantic` — stage at 0%, prepare the new generation and require exact readiness for every public location.
- `breaking-api` — fail closed until a continuously maintained expand-contract representation exists; a deployment-time probe is not HATEOAS or compatibility.

Worker-bearing releases remain blue-green and Worker-first. The controller captures and attests the exact 100% version, tags a candidate deterministically as `frank-sha-<full SHA>`, stages `old@100% + candidate@0%`, and routes release checks to that exact candidate with Cloudflare's version override. It verifies API schema, model revision, data-generation id, cache schemas, payload stamp, completed generation, future horizon, provider-check clock and health-age budget for every location. Promotion changes the exact-ready candidate to 100%, verifies the control plane, and repeats the same exact-current gate through ordinary read-only traffic before Pages may publish. Hard failures after staging restore and verify the captured version. A failure after Pages has published is repaired forward; the controller never rolls the Worker back underneath a potentially newer installed shell.

Provider initialization is a first-class waiting state, not a deployment failure and not production. `warm-worker.mjs --allow-waiting --github-output` returns `ready_for_promotion=false`, ordered `waiting_location_ids`, and a bounded `retry_after_seconds` only for typed initialization or an internally consistent health-propagation lag. The candidate stays at 0%, the `worker-production` promotion job is skipped, users remain on the coordinated release, and a later schedule tick first retries only that immutable candidate. Progressive retries rotate their first city in ten-minute buckets, so one persistently busy location cannot starve independent city caches; each batch still stops at the first typed busy result to protect the shared provider. Full CI and a new Pages artifact are rebuilt only after this lightweight precheck becomes ready. If `main` advances while a candidate is still at 0%, the controller removes it safely; malformed payloads, contradictory health, unsupported responses, code errors, deadlines and storage failures still fail and restore. A provider being busy is harmless when every exact target cache is already complete and within the normal health budget.

The first journal-less release is deliberately conservative: it skips impact inference, takes the full `forecast-semantic` exact-all path, publishes Pages, writes the existing one-time baseline marker, and only then commits the coordinated journal. If the marker or journal step is interrupted, the absent journal keeps the release resumable. This first release always skips KV garbage collection, including a repair run where the first Worker was already promoted before Pages or the journal completed. Later Worker-bearing releases may run cleanup as best-effort maintenance only after coordination is recorded; cleanup retains current plus the sole audited same-API N−1 generation and uses the captured production attestation. A cleanup failure cannot invalidate an otherwise coordinated release, and cleanup never guesses across API generations or ambiguous keys.

The workflow-facing helper contracts are explicit:

```bash
node scripts/release-impact-snapshot.mjs --source-sha <sha> --provenance <candidate|attested-production> --output <file>
node scripts/release-impact.mjs --trusted-base <file> --trusted-base-sha <sha> --candidate <file> --candidate-sha <sha> --github-output <file>
node scripts/resolve-worker-release.mjs --source-sha <sha> --github-output <file>
npm run release:coordinated -- read --github-output <file>
npm run release:coordinated -- record --source-sha <sha> --worker-version-id <uuid> --pages-content-id <sha256> --pages-artifact-build-id <build> --expected-previous-source-sha <sha|none>
npm run worker:warm -- --require-target-ready-all --allow-waiting --github-output <file> [...pinned candidate options]
```

The resolver is read-only and returns `action=replace-staged|upload|stage|warm|complete`, the deterministic tag, exact production/candidate/staged version ids and their source SHAs. `replace-staged` removes an older deterministic 0% candidate before the desired immutable version is reused or uploaded. The impact command returns the six-way `impact`, automatic-promotion decision, blocking reasons and ordered warm-location ids. The coordinated journal read returns its established flag and both Pages identities. The warm command returns `ready_for_promotion`, `waiting_location_ids` and `retry_after_seconds`. These outputs are control-plane contracts; missing, ambiguous or contradictory values fail closed.

For installed/open apps, Pages is staged rather than mixed into the running document. The current service worker keeps serving its complete old shell; the candidate validates one build-bound descriptor, HTML, manifest and every asset into a separate cache, then waits while FRANK windows are open. A later clean navigation activates the complete new shell atomically, with one old shell cache retained for handover. Forecast data remains generation-keyed, so neither a half-cached UI nor an unsupported new Worker beneath an old client is a normal release state.

Don't regenerate `package-lock.json` on Windows — CI needs it built on Linux so platform-specific optional subtrees resolve.

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
