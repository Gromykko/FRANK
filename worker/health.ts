import { CRON_PERIOD_MS } from './execution';
import type {
  CronHeartbeat,
  HealthLocationEntry,
  HealthPayload,
  WorkerCacheHealth,
} from './domain';
import { CURRENT_RELEASE } from '../src/features/forecast/releaseContract';
import { FORECAST_SOURCE_POLICY } from './forecastModel';
import { htmlResponse, jsonResponse } from './http';

// /health judges two clocks because "the Worker is dead" and "the data is
// old" are different failures. The persisted check stamp is deliberately
// coarse. MET may legitimately defer the next provider contact for its full
// 90-minute maximum TTL; two hours leaves another 30 minutes, comfortably
// covering the current four-minute city rotation.
export const HEALTH_MAX_CHECK_AGE_MS = 2 * 60 * 60 * 1000;

export function assertHealthCheckAgeExceedsMetTtl(
  maxCheckAgeMs: number,
  metMaxTtlMs: number,
): void {
  if (!Number.isFinite(maxCheckAgeMs)
    || maxCheckAgeMs <= 0
    || !Number.isFinite(metMaxTtlMs)
    || metMaxTtlMs <= 0
    || maxCheckAgeMs <= metMaxTtlMs) {
    throw new Error(
      `Health check-age threshold (${maxCheckAgeMs} ms) must exceed MET max TTL (${metMaxTtlMs} ms).`,
    );
  }
}

assertHealthCheckAgeExceedsMetTtl(
  HEALTH_MAX_CHECK_AGE_MS,
  FORECAST_SOURCE_POLICY.metMaxTtlMs,
);

export const HEALTH_MAX_DATA_AGE_MS = 3 * 60 * 60 * 1000;
// Beyond this the scheduler is not beating. It was previously an inline 10 in
// two places and named nowhere, while the page asserted "Active" purely because
// an age existed - so a cron dead for 47 minutes rendered "Active · 47m ago".
export const HEARTBEAT_STALE_AFTER_MIN = 10;

export function buildHealthPayload(
  entries: HealthLocationEntry[],
  storageUnavailable: boolean,
  now = Date.now(),
  cronHeartbeat?: CronHeartbeat | null,
): HealthPayload {
  const missing = entries
    .filter((entry) => !entry.hasCache)
    .map((entry) => entry.id);
  const age = (iso: string | undefined): number => {
    const ms = Date.parse(iso ?? '');
    return Number.isFinite(ms) ? now - ms : Number.POSITIVE_INFINITY;
  };
  const heartbeatMs = Date.parse(cronHeartbeat?.lastTickAt ?? '');
  const heartbeatValid = Number.isFinite(heartbeatMs) && heartbeatMs <= now;

  const ages = entries.map((entry) => ({
    id: entry.id,
    // Data age: when this location's forecast was last built.
    ageMs: age(entry.fetchedAt),
    // Liveness: when the Worker last checked upstream for this location. The
    // caller has already folded the cron heartbeat into cacheHealth, so this
    // stays a per-location fact; the heartbeat must never lower a city's check
    // age on its own, because a tick that ran out of budget skipped some.
    checkAgeMs: age(
      entry.cacheHealth?.lastAttemptAt
      ?? entry.initialization?.lastAttemptAt
      ?? entry.fetchedAt,
    ),
  }));

  const notChecking = ages
    .filter((item) => item.checkAgeMs > HEALTH_MAX_CHECK_AGE_MS)
    .map((item) => item.id);
  const notRebuilding = ages
    .filter((item) => {
      const entry = entries.find((e) => e.id === item.id);
      return Boolean(entry?.hasCache) && item.ageMs > HEALTH_MAX_DATA_AGE_MS;
    })
    .map((item) => item.id);
  const stalled = [...new Set([...notChecking, ...notRebuilding])];
  const worst = (key: 'ageMs' | 'checkAgeMs'): number =>
    ages.reduce((acc, item) => Math.max(acc, item[key]), 0);
  const oldestAgeMs = worst('ageMs');
  const oldestCheckAgeMs = worst('checkAgeMs');
  const ok = !storageUnavailable && stalled.length === 0;
  const asMin = (ms: number): number | null =>
    (Number.isFinite(ms) ? Math.round(ms / 60_000) : null);

  const ready = entries
    .filter((entry) => entry.exactGenerationReady)
    .map((entry) => entry.id);
  const available = entries
    .filter((entry) => entry.hasCache)
    .map((entry) => entry.id);
  const fallback = entries
    .filter((entry) => entry.hasCache && !entry.exactGenerationReady)
    .map((entry) => entry.id);

  // Reported on its own rather than mixed into any location's age: a stalled
  // cron is otherwise invisible, because every location keeps serving its last
  // good forecast and nothing in the payload says the ticks stopped.
  const cronHeartbeatView = heartbeatValid
    ? {
        lastTickAt: new Date(heartbeatMs).toISOString(),
        ageMin: Math.round((now - heartbeatMs) / 60_000),
      }
    : null;

  return {
    ok,
    service: 'frank-forecast',
    checkedAt: new Date(now).toISOString(),
    cronHeartbeat: cronHeartbeatView,
    oldestCheckAgeMin: asMin(oldestCheckAgeMs),
    checkStaleAfterMin: Math.round(HEALTH_MAX_CHECK_AGE_MS / 60_000),
    oldestAgeMin: asMin(oldestAgeMs),
    dataStaleAfterMin: Math.round(HEALTH_MAX_DATA_AGE_MS / 60_000),
    reason: ok
      ? null
      : storageUnavailable
        ? 'forecast storage unavailable'
        : [
            ...(notChecking.length ? [`not checking: ${notChecking.join(', ')}`] : []),
            ...(notRebuilding.length ? [`not rebuilding: ${notRebuilding.join(', ')}`] : []),
          ].join(' | '),
    stalled,
    missing,
    storageAvailable: !storageUnavailable,
    release: {
      target: { ...CURRENT_RELEASE },
      allLocationsReady: !storageUnavailable && ready.length === entries.length,
      ready,
      available,
      fallback,
      missing: [...missing],
    },
    locations: entries,
    ages,
    // Internal presentation flag. /health strips it; /status needs it to avoid
    // presenting one storage incident as four unrelated missing-cache faults.
    storageUnavailable,
  };
}

export function healthResponse(health: HealthPayload): Response {
  const { ages, storageUnavailable, ...body } = health;
  void ages;
  void storageUnavailable;
  return jsonResponse(body, body.ok ? 200 : 503);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);

function formatAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return 'no data';
  const min = Math.round(ageMs / 60_000);
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  return `${hours}h ${String(min % 60).padStart(2, '0')}m`;
}

function formatUtcTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown time';
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function providerTimestampMs(value: string | undefined): number {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;

  // DMI run ids use an ISO-like compact time (`2026-08-20T120000Z`) that
  // Date.parse does not accept consistently across runtimes.
  const compact = value.match(/^(\d{4})-?(\d{2})-?(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return compact
    ? Date.parse(`${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`)
    : Number.NaN;
}

// A DMI run id ('2026-08-24T060000Z') as the cycle hour operators actually
// speak in. Returns null rather than guessing when the id is unparseable.
function formatRunHour(id: string | undefined): string | null {
  const ms = providerTimestampMs(id);
  if (!Number.isFinite(ms)) return null;
  return `${String(new Date(ms).getUTCHours()).padStart(2, '0')}:00Z`;
}

function providerAgeMs(value: string | undefined, nowMs: number): number | null {
  const timestampMs = providerTimestampMs(value);
  const ageMs = nowMs - timestampMs;
  return Number.isFinite(timestampMs) && ageMs >= 0 ? ageMs : null;
}

function formatProviderTimestamp(value: string | undefined): string {
  const timestampMs = providerTimestampMs(value);
  return Number.isFinite(timestampMs)
    ? new Date(timestampMs).toISOString().replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, ' UTC')
    : 'run time not recorded';
}

type FrankStatusRating = 'safe' | 'caution' | 'danger';
type SourceTone = 'good' | 'warn' | 'bad' | 'neutral';

interface SourceStatusView {
  key: 'weather' | 'water' | 'waves' | 'warnings';
  label: string;
  provider: string;
  tone: SourceTone;
  state: string;
  value: string;
  detail: string;
}

// The status page cannot import React or the app stylesheet, so this is a
// deliberately exact HTML rendering of src/components/GertyFace.tsx. Keep the
// 16x16 pixel coordinates and cropped viewBox in lock-step with that component.
function gertyStatusFace(rating: FrankStatusRating): string {
  const eyes = [
    [4, 5], [5, 5], [10, 5], [11, 5],
    [4, 6], [5, 6], [10, 6], [11, 6],
  ];
  const mouths: Record<FrankStatusRating, number[][]> = {
    safe: [[4, 9], [11, 9], [5, 10], [6, 10], [7, 10], [8, 10], [9, 10], [10, 10]],
    caution: [[5, 10], [6, 10], [7, 10], [8, 10], [9, 10], [10, 10]],
    danger: [[5, 9], [6, 9], [7, 9], [8, 9], [9, 9], [10, 9], [4, 10], [11, 10]],
  };
  const rects = (pixels: number[][]): string => pixels
    .map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1"/>`)
    .join('');

  return `<svg class="gerty-face" viewBox="3 3.5 10 9" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><g class="gerty-eyes">${rects(eyes)}</g>${rects(mouths[rating])}</svg>`;
}

// Human diagnostic panel. It intentionally shares buildHealthPayload with the
// machine alarm, always returns 200, and is self-contained under a strict CSP.
export function statusResponse(health: HealthPayload): Response {
  const byId = new Map(health.ages.map((age) => [age.id, age]));
  const level = (ms: number, budget: number): 'bad' | 'warn' | 'good' =>
    (ms > budget ? 'bad' : ms > budget * 0.75 ? 'warn' : 'good');
  // 'good' deliberately yields no class. A healthy panel should be monochrome
  // so that the one amber cell is findable at a glance.
  const toneClass = (tone: 'bad' | 'warn' | 'good'): string =>
    (tone === 'good' ? '' : `tone-${tone}`);
  const checkedAtMs = Date.parse(health.checkedAt);
  const nowMs = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();

  const locationCards = health.locations.map((location) => {
    const age = byId.get(location.id) ?? {
      ageMs: Number.POSITIVE_INFINITY,
      checkAgeMs: Number.POSITIVE_INFINITY,
    };
    const cacheHealth: Partial<WorkerCacheHealth> = location.cacheHealth ?? {};
    const degradedSources = new Set(cacheHealth.degradedSources ?? []);
    const missing = !location.hasCache;
    const initialization = missing ? location.initialization : undefined;
    const generationState = location.exactGenerationReady
      ? 'EXACT GENERATION READY'
      : missing
        ? 'GENERATION MISSING'
        : `FALLBACK · ${location.availabilitySource}`;
    const providerState = initialization
      ? initialization.busy
        ? `provider busy · ${initialization.provider}`
        : `provider unavailable · ${initialization.provider}`
      : cacheHealth.providerBusy
        ? `provider busy${cacheHealth.busyProvider ? ` · ${cacheHealth.busyProvider}` : ''}`
        : missing
          ? 'awaiting provider data'
          : '';
    const checkDetail = initialization
      ? `initialization attempt · ${formatUtcTimestamp(initialization.lastAttemptAt)}`
      : cacheHealth.checkedBy ?? '—';
    const status = health.storageUnavailable
      ? 'storage unavailable'
      : initialization
        ? 'initializing'
        : missing
          ? 'awaiting data'
          : cacheHealth.status ?? 'unknown';

    const providerAppliesTo = (source: 'weather' | 'water' | 'waves'): boolean => {
      if (!cacheHealth.providerBusy) return false;
      if (degradedSources.size > 0 && !degradedSources.has(source)) return false;
      if (!cacheHealth.busyProvider || cacheHealth.busyProvider === 'services') return true;
      return source === 'weather'
        ? cacheHealth.busyProvider === 'weather'
        : cacheHealth.busyProvider === 'marine';
    };
    const initializationAppliesTo = (source: 'weather' | 'water' | 'waves'): boolean => {
      if (!initialization || initialization.provider === 'services') return Boolean(initialization);
      return source === 'weather'
        ? initialization.provider === 'weather'
        : initialization.provider === 'marine';
    };
    const requiredSource = (
      key: 'weather' | 'water' | 'waves',
      label: string,
      provider: string,
      provenance: string | undefined,
      provenanceLabel: string,
    ): SourceStatusView => {
      if (health.storageUnavailable) {
        return {
          key, label, provider, tone: 'bad', state: 'Unavailable',
          value: 'Storage unavailable',
          detail: 'FRANK could not read the prepared cache.',
        };
      }
      if (missing) {
        const blocked = initializationAppliesTo(key);
        const busy = blocked && Boolean(initialization?.busy);
        return {
          key, label, provider,
          tone: busy ? 'warn' : blocked ? 'bad' : 'neutral',
          state: busy ? 'Provider busy' : blocked ? 'Unavailable' : 'Waiting',
          value: 'No source data yet',
          detail: busy
            ? 'The prepared cache will retry on an operational cycle.'
            : 'Waiting for the first complete forecast snapshot.',
        };
      }

      const degraded = degradedSources.has(key);
      const busy = providerAppliesTo(key);
      const provenanceAgeMs = providerAgeMs(provenance, nowMs);
      const provenanceDetail = provenance
        ? `${provenanceLabel} ${formatProviderTimestamp(provenance)}`
        : `${provenanceLabel} not recorded`;
      return {
        key, label, provider,
        tone: degraded || busy ? 'warn' : provenanceAgeMs === null ? 'neutral' : 'good',
        // 'Current' not 'Current snapshot': when healthy the operator already
        // has six other green signals, and "snapshot" had become a filler noun
        // repeated across every source string. The badge stays rather than
        // disappearing - it is the only thing separating "evaluated and good"
        // from "this slot rendered blank", and keeping it prevents a layout
        // shift the moment a source turns amber.
        state: busy ? 'Provider busy' : degraded ? 'Last-good fallback' : provenanceAgeMs === null ? 'Age not recorded' : 'Current',
        value: provenanceAgeMs === null
          ? 'not recorded'
          : formatAge(provenanceAgeMs),
        detail: provenanceDetail,
      };
    };

    const sources: SourceStatusView[] = [
      requiredSource(
        'weather',
        'Weather',
        'MET Norway',
        cacheHealth.weatherLastModified,
        'Forecast issued',
      ),
      requiredSource(
        'water',
        'Water level',
        'DMI DKSS',
        cacheHealth.marineInstances?.water?.id,
        'Model run',
      ),
      requiredSource(
        'waves',
        'Waves',
        'DMI WAM',
        cacheHealth.marineInstances?.waves?.id,
        'Model run',
      ),
      health.storageUnavailable
        ? {
            key: 'warnings', label: 'Warnings', provider: 'MeteoAlarm', tone: 'bad',
            state: 'Unavailable', value: 'Storage unavailable',
            detail: 'FRANK could not read the prepared cache.',
          }
        : missing
          ? {
              key: 'warnings', label: 'Warnings', provider: 'MeteoAlarm', tone: 'neutral',
              state: 'Waiting', value: 'No snapshot yet',
              detail: 'Warnings arrive with the first forecast snapshot.',
            }
          : {
              key: 'warnings',
              label: 'Warnings',
              provider: 'MeteoAlarm',
              tone: location.warningCount && location.warningCount > 0 ? 'warn' : 'neutral',
              state: location.warningCount && location.warningCount > 0 ? 'Alert active' : 'Advisory',
              // Was `${formatAge(age.ageMs)} snapshot` - the same value already
              // shown in the Forecast age vital above, relabelled as a warnings
              // fact. Warnings have no clock of their own; they ride the
              // forecast poll, so state that instead of inventing an age.
              value: location.warningCount && location.warningCount > 0
                ? `${location.warningCount} active ${location.warningCount === 1 ? 'warning' : 'warnings'}`
                : '—',
              // Not escaped here: the shared card template escapes every detail,
              // so escaping twice rendered an ampersand in a MeteoAlarm headline
              // as &amp;amp;.
              detail: location.warningsSummary ?? 'Polled with the forecast',
            },
    ];
    const overallTone = health.storageUnavailable || missing
      ? 'bad'
      : location.exactGenerationReady
        ? 'good'
        : 'warn';

    // One aligned row per location instead of a card containing three vitals
    // and four sub-cards. The old shape repeated the same static text once per
    // location - provider names, "last complete rebuild", "cron", "prepared
    // snapshot", and an identical model-run stamp eight times - so a healthy
    // page was ~1400px of mostly chrome. A row lets every number for every
    // location be read at once, which is the entire point of a panel.
    //
    // Tone is applied ONLY when a cell is not good. Twelve green badges on a
    // healthy page carry no signal; the app's own rule is that colour means
    // something. Here the page is quiet when nothing is wrong.
    const cell = (source: typeof sources[number]): string =>
      // The exact provenance stamp ("Model run 2026-08-20 12:00 UTC") is what
      // an operator checks against DMI's run table, so it must not be lost -
      // but printed on all four rows it was eight identical lines of noise.
      // It rides the cell as a title instead: available on demand, silent when
      // not wanted.
      `<td class="num ${source.tone === 'warn' || source.tone === 'bad' ? `tone-${source.tone}` : ''}" data-source="${source.key}" title="${escapeHtml(source.detail)}">`
      + `<span class="cell-value">${escapeHtml(source.value)}</span>`
      + (source.tone === 'warn' || source.tone === 'bad'
        ? `<span class="cell-note">${escapeHtml(source.state)}</span>`
        : '')
      + '</td>';

    // Only a location with something to say gets a second line.
    const note = [
      status === 'current' ? '' : status,
      providerState,
      location.warningsSummary,
    ].filter(Boolean).join(' · ');

    return `<tbody class="board-group ${overallTone}" data-location="${escapeHtml(location.id)}">
      <tr class="board-row">
        <th scope="row" class="cell-name">
          ${escapeHtml(location.areaName)}
          ${location.exactGenerationReady ? '' : `<span class="generation-state ${overallTone}">${escapeHtml(generationState)}</span>`}
        </th>
        <td class="num ${missing ? 'tone-bad' : toneClass(level(age.ageMs, HEALTH_MAX_DATA_AGE_MS))}">
          <span class="cell-value">${escapeHtml(missing ? 'none' : formatAge(age.ageMs))}</span>
        </td>
        <td class="num ${initialization ? 'tone-warn' : missing ? 'tone-bad' : toneClass(level(age.checkAgeMs, HEALTH_MAX_CHECK_AGE_MS))}">
          <span class="cell-value">${escapeHtml(formatAge(age.checkAgeMs))}</span>
          ${checkDetail === 'cron' ? '' : `<span class="cell-note">${escapeHtml(checkDetail)}</span>`}
        </td>
        ${sources.map(cell).join('')}
      </tr>
      ${note ? `<tr class="board-note ${overallTone}"><td colspan="7">${escapeHtml(note)}</td></tr>` : ''}
    </tbody>`;
  }).join('');

  const rating: FrankStatusRating = health.ok && health.release.allLocationsReady
    ? 'safe'
    : health.ok
      ? 'caution'
      : 'danger';
  // The heartbeat must never assert liveness it cannot support: printing
  // "Active" whenever an age exists made a dead scheduler articulate rather
  // than silent. The absolute tick time is dropped - no decision turns on it,
  // and two ISO timestamps in one 12px line is the density problem.
  // DMI publishes on a six-hour cycle, so which run a city holds is the single
  // most diagnostic fact here. Listed once when every city agrees; when they
  // diverge each run is listed, because that divergence is precisely the
  // failure worth seeing.
  const marineRuns = (kind: 'water' | 'waves'): string => {
    const hours = new Set(
      health.locations
        .map((entry) => formatRunHour(entry.cacheHealth?.marineInstances?.[kind]?.id))
        .filter((hour): hour is string => hour !== null),
    );
    return hours.size === 0 ? 'run unknown' : [...hours].sort().join(' + ');
  };

  const beatAgeMin = typeof health.cronHeartbeat?.ageMin === 'number'
    ? health.cronHeartbeat.ageMin
    : null;
  const beatLive = beatAgeMin !== null && beatAgeMin <= HEARTBEAT_STALE_AFTER_MIN;
  const beatText = beatAgeMin === null
    ? 'Cron heartbeat: awaiting first tick'
    : `Cron heartbeat: ${beatLive ? 'live' : 'STALLED'} · ${beatAgeMin}m ago`;

  // "check required" named neither the problem nor the scale of it. The display
  // is narrow, so this stays terse while saying what is actually wrong; the
  // reason line underneath still carries the location names.
  const displayMessage = rating === 'safe'
    ? 'all locations current'
    : rating === 'caution'
      ? `${health.release.ready.length}/${health.locations.length} locations ready`
      : health.missing.length > 0
        ? `${health.missing.length}/${health.locations.length} without forecast`
        : health.stalled.length > 0
          ? `${health.stalled.length}/${health.locations.length} not reporting`
          : 'check required';
  // "Release preparing" asserted the optimistic reading. The caution branch
  // fires when a location serves a non-target generation, and the payload
  // cannot distinguish a shadow warm in progress from one that fell back and
  // stayed there. Naming the observable state points the operator at the
  // FALLBACK badge they should go and look at.
  const statusLabel = rating === 'safe'
    ? 'All systems ready'
    : rating === 'caution'
      ? 'Fallback in use'
      : 'Operator attention';
  // "independent provider cycles" read as an explanation but explained nothing.
  // These two numbers are already computed and otherwise only appear buried in
  // the collapsed notes.
  const statusDetail = rating === 'danger'
    ? `${statusLabel} · ${health.reason ?? health.stalled.join(', ')}`
    : `${statusLabel} · oldest forecast ${health.oldestAgeMin ?? '?'}m · oldest check ${health.oldestCheckAgeMin ?? '?'}m`;

  return htmlResponse(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>FRANK worker status</title>
<style>
  :root {
    color-scheme:light;
    --font-heading:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    --font-body:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    /* No 'Inter' here: if the operator has it installed, every monospaced value -
       including all the run timestamps - silently renders proportional and the column
       stops aligning. Inter stays on --font-heading/--font-body. */
    --font-mono:ui-monospace,'SFMono-Regular',Consolas,monospace;
    --font-crt:'VT323','Courier New',ui-monospace,monospace;
    --text-instrument:.6875rem;
    --text-caption:.75rem;
    --text-ui:.8125rem;
    --text-body:.875rem;
    /* Light instrument face. The app itself is dark-first, but this page is
       read in daylight at a desk rather than on the water, and the operator
       prefers it light. The palette still follows the app's rule: colour
       carries MEANING only, so green is a hairline rather than a word and the
       page is near-monochrome until something is actually wrong. */
    --bg-app:#f5f7fa;
    --bg-gradient:linear-gradient(180deg,#e5f2fc 0%,#eef7fd 38rem,#f5f7fa 78rem);
    --pixel-cloud:rgba(255,255,255,.78);
    --pixel-cloud-shade:rgba(104,151,188,.13);
    --panel-bg:#f9fcff;
    --panel-border:rgba(51,91,124,.13);
    --module-bg:#f3f8fc;
    --module-edge:rgba(51,91,124,.14);
    --text-main:#1a2332;
    --text-muted:#566577;
    --primary:#1d6fd1;
    --color-safe:#059669;
    --color-caution:#d97706;
    --color-danger:#dc2626;
    /* On a light ground the fills are too pale to read as text, so text uses
       darker shades. Measured against --panel-bg: 4.8:1, 4.6:1 and 6.4:1. */
    --color-safe-text:#047857;
    --color-caution-text:#b45309;
    --color-danger-text:#b91c1c;
    --shadow-lg:0 1px 2px rgba(46,78,107,.07);
    --radius-md:8px;
    --radius-sm:6px;
    --frank-housing:var(--panel-bg);
    --frank-housing-edge:rgba(26,35,50,.16);
    --frank-housing-text:var(--text-main);
    --crt-screen:#0a0e14;
  }
  * { box-sizing:border-box }
  html { min-height:100%; background:var(--bg-app) }
  body {
    position:relative;
    min-height:100vh;
    margin:0;
    overflow-x:hidden;
    color:var(--text-main);
    background:var(--bg-gradient);
    font:var(--text-body)/1.55 var(--font-body);
  }
  .pixel-sky {
    position:absolute;
    inset:0 0 auto;
    z-index:0;
    height:100vh;
    height:100svh;
    overflow:hidden;
    pointer-events:none;
    user-select:none;
  }
  .pixel-cloud {
    position:absolute;
    left:0;
    color:var(--pixel-cloud);
    opacity:.78;
    will-change:transform;
    animation:pixel-cloud-drift linear infinite;
  }
  .pixel-cloud svg { display:block; width:100%; height:auto; overflow:visible }
  .pixel-cloud-body { fill:var(--pixel-cloud) }
  .pixel-cloud-shade { fill:var(--pixel-cloud-shade) }
  .pixel-cloud-one { top:9vh; width:138px; animation-duration:96s; animation-delay:-12s }
  .pixel-cloud-two { top:44vh; width:102px; opacity:.56; animation-duration:124s; animation-delay:-97s }
  .pixel-cloud-three { top:76vh; width:166px; opacity:.48; animation-duration:142s; animation-delay:-16s }
  @keyframes pixel-cloud-drift {
    from { transform:translate3d(-190px,0,0) }
    to { transform:translate3d(calc(100vw + 190px),0,0) }
  }
  .status-shell {
    position:relative;
    z-index:1;
    width:min(100%,820px);
    margin:0 auto;
    padding:clamp(14px,2.5vw,28px) clamp(12px,2.5vw,24px) 32px;
  }
  .sr-only {
    position:absolute;
    width:1px;
    height:1px;
    padding:0;
    margin:-1px;
    overflow:hidden;
    clip:rect(0,0,0,0);
    white-space:nowrap;
    border:0;
  }

  /* Exact FRANK app housing: face CRT, seam-divided message screen and a
     compact rectangular operations stamp. Status color stays inside the
     screens instead of tinting the whole page. */
  .frank-device-shell {
    --frank-phosphor:var(--color-caution);
    display:flex;
    flex-direction:column;
    gap:10px;
    padding:10px 16px 14px;
    border:1px solid var(--frank-housing-edge);
    border-radius:var(--radius-md);
    background:var(--frank-housing);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.06),var(--shadow-lg);
  }
  .frank-device-shell.rating-safe { --frank-phosphor:var(--color-safe) }
  .frank-device-shell.rating-caution { --frank-phosphor:var(--color-caution) }
  .frank-device-shell.rating-danger { --frank-phosphor:var(--color-danger) }
  .frank-device-columns {
    display:grid;
    grid-template-columns:auto minmax(0,1fr);
    grid-template-areas:
      'crt display'
      'name display';
    column-gap:16px;
    row-gap:6px;
    align-items:start;
    min-width:0;
  }
  .frank-crt {
    grid-area:crt;
    position:relative;
    place-self:center;
    display:flex;
    width:82px;
    height:82px;
    align-items:center;
    justify-content:center;
    overflow:hidden;
    border:1px solid #05080d;
    border-radius:50%;
    color:var(--frank-phosphor);
    background:var(--crt-screen);
    box-shadow:inset 0 3px 8px rgba(0,0,0,.65),0 1px 0 rgba(255,255,255,.4);
  }
  .gerty-face {
    z-index:1;
    width:56px;
    height:56px;
    flex:0 0 auto;
    image-rendering:pixelated;
    filter:drop-shadow(0 0 4px color-mix(in srgb,currentColor 55%,transparent));
  }
  .gerty-face rect { fill:currentColor }
  .gerty-eyes {
    transform-box:fill-box;
    transform-origin:center;
    animation:gerty-blink 6s infinite;
  }
  @keyframes gerty-blink {
    0%,90%,100% { transform:scaleY(1) }
    93%,95% { transform:scaleY(.12) }
    98% { transform:scaleY(1) }
  }
  .device-meta {
    display:flex;
    flex-wrap:wrap;
    gap:6px;
    margin:6px 0 0;
    color:var(--text-muted);
    font:var(--text-instrument)/1.4 var(--font-mono);
  }
  .device-meta .warn { color:var(--color-caution-text); font-weight:700 }
  .board-legend {
    display:flex;
    flex-wrap:wrap;
    gap:4px 16px;
    margin:0;
    padding:0 12px 12px;
    color:var(--text-muted);
    font:var(--text-instrument)/1.5 var(--font-mono);
  }
  .board-legend b { color:var(--text-main); font-weight:700 }
  .page-stamp {
    margin:10px 2px 0;
    color:var(--text-muted);
    font:var(--text-instrument)/1.4 var(--font-mono);
    text-align:right;
  }
  .frank-nameplate {
    grid-area:name;
    place-self:center;
    color:var(--frank-housing-text);
    font-family:var(--font-heading);
    font-size:var(--text-instrument);
    font-weight:700;
    line-height:1;
    letter-spacing:.6em;
    text-indent:.6em;
    text-transform:uppercase;
    opacity:.9;
  }
  /* Column, not row: the meta line belongs UNDER the readout, the way a label
     sits under a gauge. The right-hand border is gone with the panel that used
     to follow it - a divider with nothing on the far side is just a stray line. */
  .frank-cell-display {
    grid-area:display;
    display:flex;
    flex-direction:column;
    justify-content:center;
    min-width:0;
    padding:0 0 0 16px;
    border-left:1px solid var(--frank-housing-edge);
  }
  .frank-display {
    position:relative;
    display:flex;
    flex:1 1 auto;
    min-width:0;
    min-height:58px;
    align-items:center;
    justify-content:center;
    overflow:hidden;
    padding:8px 12px;
    border:1px solid #05080d;
    border-radius:10px;
    color:var(--frank-phosphor);
    background:var(--crt-screen);
    box-shadow:inset 0 3px 8px rgba(0,0,0,.6);
    font:400 clamp(1.25rem,2.2vw,1.5625rem)/1.05 var(--font-crt);
    letter-spacing:.05em;
    text-align:center;
  }
  .frank-display-text {
    position:relative;
    z-index:1;
    overflow-wrap:normal;
    word-break:normal;
    text-shadow:0 0 8px color-mix(in srgb,currentColor 60%,transparent);
  }

  .instrument-panel {
    margin-top:12px;
    overflow:hidden;
    border:1px solid var(--panel-border);
    border-radius:var(--radius-md);
    background:var(--panel-bg);
    box-shadow:var(--shadow-lg);
  }
  .panel-bezel {
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:12px;
    min-height:42px;
    padding:10px 16px;
    border-bottom:1px solid var(--panel-border);
    background:color-mix(in srgb,var(--primary) 3%,var(--panel-bg));
  }
  .panel-bezel h2 {
    margin:0;
    font-size:var(--text-caption);
    letter-spacing:.16em;
    text-transform:uppercase;
  }
  .panel-bezel p {
    margin:0;
    color:var(--text-muted);
    font-size:var(--text-instrument);
  }
  /* Instrument grid. Values are tabular-nums so the columns line up the way a
     plotter's readouts do - the eye scans a column, not a card. Sizes follow
     the app's scale: 14px for values you read, 11px reserved for dense marks.
     Contrast on the dark panel is 4.9:1 for muted text and 6.1-10.2:1 for the
     safety colours, all above the 4.5:1 AA floor for normal text. */
  .board-scroll { overflow-x:auto; padding:2px 10px 10px }
  .board {
    width:100%;
    min-width:560px;
    border-collapse:collapse;
    font-variant-numeric:tabular-nums;
  }
  .board thead th {
    padding:8px 10px;
    text-align:left;
    white-space:nowrap;
    color:var(--text-muted);
    font:700 var(--text-instrument)/1.3 var(--font-heading);
    letter-spacing:.08em;
    text-transform:uppercase;
    border-bottom:1px solid var(--module-edge);
  }
  .board th.num, .board td.num { text-align:right }
  .board-group { border-bottom:1px solid var(--panel-border) }
  .board-group:last-child { border-bottom:0 }
  .board-row th, .board-row td { padding:9px 10px; vertical-align:baseline }
  .cell-name {
    display:flex;
    align-items:baseline;
    gap:8px;
    text-align:left;
    white-space:nowrap;
    color:var(--text-main);
    font:600 var(--text-ui)/1.35 var(--font-heading);
  }
  .cell-value {
    display:block;
    color:var(--text-main);
    font:600 var(--text-body)/1.25 var(--font-mono);
  }
  .cell-note {
    display:block;
    margin-top:3px;
    white-space:nowrap;
    color:var(--text-muted);
    font:var(--text-instrument)/1.3 var(--font-mono);
  }
  .board td.tone-warn .cell-value,
  .board td.tone-warn .cell-note { color:var(--color-caution-text) }
  .board td.tone-bad .cell-value,
  .board td.tone-bad .cell-note { color:var(--color-danger-text) }
  .board-note td {
    padding:0 10px 10px;
    color:var(--color-caution-text);
    font:var(--text-caption)/1.4 var(--font-body);
  }
  .board-note.bad td { color:var(--color-danger-text) }
  /* Only rendered when a location is NOT on the target generation, so it is
     always an exception and always earns its colour. */
  .generation-state {
    font:700 var(--text-instrument)/1.3 var(--font-mono);
    letter-spacing:.06em;
    text-transform:uppercase;
  }
  .generation-state.warn { color:var(--color-caution-text) }
  .generation-state.bad { color:var(--color-danger-text) }
  .good { color:var(--color-safe-text) }
  .warn { color:var(--color-caution-text) }
  .bad { color:var(--color-danger-text) }

  .notes {
    margin-top:12px;
    border:1px solid var(--panel-border);
    border-radius:var(--radius-md);
    color:var(--text-muted);
    background:var(--panel-bg);
    box-shadow:var(--shadow-lg);
    font-size:var(--text-caption);
  }
  .notes summary {
    min-height:44px;
    padding:12px 16px;
    color:var(--text-main);
    cursor:pointer;
    font-weight:700;
    letter-spacing:.12em;
    text-transform:uppercase;
  }
  .notes-content {
    padding:0 16px 16px;
    border-top:1px solid var(--panel-border);
  }
  .notes p { max-width:90ch; margin:12px 0 0 }
  code {
    padding:2px 5px;
    border:1px solid var(--module-edge);
    border-radius:4px;
    color:var(--text-main);
    background:var(--module-bg);
    font:var(--text-caption) var(--font-mono);
  }
  a { color:var(--primary); font-weight:700; text-underline-offset:2px }

  @media (min-width:1100px) {
    .status-shell { width:min(100%,980px) }
  }
  @media (max-width:899px) {
    .pixel-cloud-two,.pixel-cloud-three { display:none }
  }
  @media (max-width:720px) {
    .status-shell { padding:12px 10px 24px }
    .panel-bezel { align-items:flex-start; flex-direction:column; gap:2px; padding:10px 12px }
    .locations-board { padding:8px }
    .source-board { grid-template-columns:repeat(2,minmax(0,1fr)) }
    .notes summary { padding:12px }
    .notes-content { padding:0 12px 14px }
  }
  @media (max-width:640px) {
    .pixel-cloud-one { top:12vh; width:84px; opacity:.46; animation-delay:-24s }
  }
  @media (max-width:480px) {
    .frank-device-shell { padding:10px 12px 12px }
    .frank-cache { padding-right:0 }
    .frank-device-columns {
      grid-template-columns:64px minmax(0,1fr) 92px;
      column-gap:12px;
    }
    .frank-crt { width:64px; height:64px }
    .frank-crt .gerty-face { width:42px; height:42px }
    .frank-cell-display { padding:0 12px }
    .frank-display { min-height:56px; padding:6px 8px; font-size:1.125rem }
    .frank-nameplate { letter-spacing:.45em; text-indent:.45em }
    .operation-stamp { padding:7px 8px; font-size:.625rem }
    .operation-stamp strong { font-size:.6875rem }
    .frank-location { font-size:.6875rem; letter-spacing:.08em }
    .location-vitals { grid-template-columns:1fr 1fr }
    .location-vitals > div:nth-child(3) {
      grid-column:1/-1;
      border-top:1px solid var(--module-edge);
      border-left:0;
    }
    .source-board { grid-template-columns:1fr }
    .source-card { min-height:104px }
  }
  @media (max-width:360px) {
    .status-shell { padding-right:8px; padding-left:8px }
    /* The status message is the one thing that must survive the narrowest
       screen. The old rule hid the display and kept the refresh-interval panel,
       so the smallest phone showed a face and a constant, but not the state. */
    .frank-device-columns {
      grid-template-columns:64px minmax(0,1fr);
      grid-template-areas:
        'crt display'
        'name display';
      column-gap:12px;
    }
    .frank-nameplate { font-size:.625rem; letter-spacing:.35em; text-indent:.35em }
    .frank-cell-display { padding-left:12px }
  }
  @media (prefers-reduced-motion:reduce) {
    .pixel-cloud,.gerty-eyes { animation:none; will-change:auto }
    .pixel-cloud-one { transform:translate3d(4vw,0,0) }
    .pixel-cloud-two { transform:translate3d(86vw,0,0) }
    .pixel-cloud-three { transform:translate3d(8vw,0,0) }
  }
</style></head><body>
<div class="pixel-sky" aria-hidden="true">
  <div class="pixel-cloud pixel-cloud-one"><svg viewBox="0 0 34 14" focusable="false" shape-rendering="crispEdges"><path class="pixel-cloud-shade" d="M2 11h5V9h4V6h3V4h5v2h4v2h6v3h3v2H2z"/><path class="pixel-cloud-body" d="M2 9h5V7h4V4h3V2h5v2h4v2h6v3h3v2H2z"/></svg></div>
  <div class="pixel-cloud pixel-cloud-two"><svg viewBox="0 0 29 13" focusable="false" shape-rendering="crispEdges"><path class="pixel-cloud-shade" d="M1 10h4V8h3V5h4V3h4v2h3v2h5v3h3v2H1z"/><path class="pixel-cloud-body" d="M1 8h4V6h3V3h4V1h4v2h3v2h5v3h3v2H1z"/></svg></div>
  <div class="pixel-cloud pixel-cloud-three"><svg viewBox="0 0 39 15" focusable="false" shape-rendering="crispEdges"><path class="pixel-cloud-shade" d="M2 12h6V9h5V7h3V4h5V2h5v3h3v2h5v2h3v3z"/><path class="pixel-cloud-body" d="M2 10h6V7h5V5h3V2h5V0h5v3h3v2h5v2h3v3z"/></svg></div>
</div>
<main class="status-shell">
  <h1 class="sr-only">FRANK forecast worker status</h1>
  <!-- One band instead of three. The render timestamp used to head the page in
       a cramped strip: it is the least important fact here (it is always "now"
       by construction) and now sits in the footer, where a stamp that stops
       advancing still proves the auto-refresh died. Heartbeat and generation
       move under the display as one quiet meta line rather than a boxed panel
       carrying the same visual weight as system status. -->
  <header class="frank-device-shell rating-${rating}">
    <div class="frank-device-columns">
      <span class="frank-crt">${gertyStatusFace(rating)}</span>
      <div class="frank-cell-display">
        <!-- No aria-label: on role="status" it becomes the accessible name and
             replaces the content, so a screen reader got statusDetail and never
             the status message itself. statusDetail is rendered visibly below. -->
        <div class="frank-display" role="status">
          <span class="frank-display-text">${escapeHtml(displayMessage)}</span>
        </div>
        <p class="device-meta">
          <span class="${beatLive ? '' : 'warn'}">${escapeHtml(beatText)}</span>
          <span aria-hidden="true">·</span>
          <span>${escapeHtml(health.release.target.dataGenerationId)}</span>
        </p>
      </div>
      <span class="frank-nameplate">FRANK</span>
    </div>
  </header>

  <section class="instrument-panel" aria-labelledby="locations-title">
    <div class="panel-bezel">
      <div>
        <h2 id="locations-title">Forecast locations</h2>
        <p>${escapeHtml(statusDetail)}</p>
      </div>
    </div>
    <div class="board-scroll">
      <table class="board">
        <thead>
          <tr>
            <th scope="col">Location</th>
            <th scope="col" class="num">Forecast</th>
            <th scope="col" class="num">Check</th>
            <th scope="col" class="num">Weather</th>
            <th scope="col" class="num">Water</th>
            <th scope="col" class="num">Waves</th>
            <th scope="col" class="num">Warnings</th>
          </tr>
        </thead>
        ${locationCards}
      </table>
    </div>
    <!-- Which provider stands behind each column. The old card layout repeated
         these four names once per location; stated once they are a legend, not
         noise. Hover a cell for that source's exact provenance stamp. -->
    <p class="board-legend">
      <span><b>Weather</b> MET Norway</span>
      <span><b>Water</b> DMI DKSS ${escapeHtml(marineRuns('water'))}</span>
      <span><b>Waves</b> DMI WAM ${escapeHtml(marineRuns('waves'))}</span>
      <span><b>Warnings</b> MeteoAlarm</span>
    </p>
  </section>

  <details class="notes">
    <summary>How to read this instrument</summary>
    <div class="notes-content">
      <p>Last check is the most recent persisted scheduled or authenticated release attempt
      for the required forecast sources. The scheduler attempts one rotated city every
      ${escapeHtml(Math.round(CRON_PERIOD_MS / 60_000))} minute, while the shared heartbeat
      normally samples one successful tick every five minutes to protect the KV allowance.
      Once a city has a recorded success, a healthy city can use that app-wide sample, so
      its displayed check remains accurate to roughly the five-minute throttle.</p>

      <p>A city reads older than the others when its selected tick runs out of budget or a
      provider refresh attempt fails. Those outcomes are recorded immediately and block
      that city from inheriting the healthy app-wide tick; the first later success is also
      recorded immediately. A retry-backoff that starts no provider request leaves the
      city's contact history unchanged. Ordinary
      visits, page reloads and the in-app refresh button only read prepared storage snapshots;
      they do not contact providers or alter this clock.
      The alarm sits at ${escapeHtml(health.checkStaleAfterMin)} minutes.
      Worst right now: ${escapeHtml(health.oldestCheckAgeMin ?? '?')} minutes.</p>

      <p>Cron heartbeat is the separate question of whether the schedule is running at all.
      Without it a stalled scheduler is invisible, because every city keeps serving its last
      good forecast and nothing looks wrong. Last tick:
      ${escapeHtml(health.cronHeartbeat?.ageMin ?? '?')} minutes ago.</p>

      <p>Data age counts from the last successful rebuild, and a figure that sits still is
      normal here. MET declares each forecast valid for about 30 minutes through its
      Expires header, so between reissues there is nothing new to build and the worker
      skips the work on purpose. It alarms only past
      ${escapeHtml(health.dataStaleAfterMin / 60)} hours, which would mean the checks are
      succeeding while every rebuild fails. Worst right now:
      ${escapeHtml(health.oldestAgeMin ?? '?')} minutes.</p>

      <p>The word under Last check names what triggered it. <code>cron</code> is the
      ${escapeHtml(Math.round(CRON_PERIOD_MS / 60_000))}-minute schedule. <code>release-candidate</code> is an authenticated shadow warm-up
      for this immutable data generation. Only those operational paths may start provider
      work.</p>

      <p>MET shows the age of its forecast issue; DKSS and WAM show the age of their model
      runs. Amber means FRANK is serving last-good data or the relevant provider was busy.
      MeteoAlarm is advisory and currently has no separately persisted provider clock, so
      its card deliberately reports the prepared snapshot age instead of inventing a green
      upstream status.</p>

      <p>This page reloads every 60 seconds and is meant for reading. The machine-readable
      alarm lives at <a href="/health">/health</a>, which returns 503 and a
      <code>reason</code> when either clock trips.</p>
    </div>
  </details>

  <!-- Least important fact on the page, so it sits last. It still earns a
       place: this page reloads every 60 seconds, so a stamp that stops
       advancing is the proof the refresh itself has died. -->
  <p class="page-stamp">Page rendered ${escapeHtml(formatUtcTimestamp(health.checkedAt))} · reloads every 60s</p>
</main>
</body></html>
`);
}
