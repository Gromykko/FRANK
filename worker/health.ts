import type {
  HealthLocationEntry,
  HealthPayload,
  WorkerCacheHealth,
} from './domain';
import { CURRENT_RELEASE } from '../src/features/forecast/releaseContract';
import { htmlResponse, jsonResponse } from './http';

// /health judges two clocks because "the Worker is dead" and "the data is
// old" are different failures. The persisted check stamp is deliberately
// coarse, so the liveness threshold leaves several scheduled ticks of room.
export const HEALTH_MAX_CHECK_AGE_MS = 60 * 60 * 1000;
export const HEALTH_MAX_DATA_AGE_MS = 3 * 60 * 60 * 1000;

export function buildHealthPayload(
  entries: HealthLocationEntry[],
  storageUnavailable: boolean,
  now = Date.now(),
): HealthPayload {
  const missing = entries
    .filter((entry) => !entry.hasCache)
    .map((entry) => entry.id);
  const age = (iso: string | undefined): number => {
    const ms = Date.parse(iso ?? '');
    return Number.isFinite(ms) ? now - ms : Number.POSITIVE_INFINITY;
  };
  const ages = entries.map((entry) => ({
    id: entry.id,
    // Data age: when this location's forecast was last built.
    ageMs: age(entry.fetchedAt),
    // Liveness: when the Worker last checked upstream for this location.
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
    .filter((item) => item.ageMs > HEALTH_MAX_DATA_AGE_MS)
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

  return {
    ok,
    service: 'frank-forecast',
    checkedAt: new Date(now).toISOString(),
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

// Human diagnostic panel. It intentionally shares buildHealthPayload with the
// machine alarm, always returns 200, and is self-contained under a strict CSP.
export function statusResponse(health: HealthPayload): Response {
  const byId = new Map(health.ages.map((age) => [age.id, age]));
  const level = (ms: number, budget: number): 'bad' | 'warn' | 'good' =>
    (ms > budget ? 'bad' : ms > budget * 0.75 ? 'warn' : 'good');

  const rows = health.locations.map((location) => {
    const age = byId.get(location.id) ?? {
      ageMs: Number.POSITIVE_INFINITY,
      checkAgeMs: Number.POSITIVE_INFINITY,
    };
    const cacheHealth: Partial<WorkerCacheHealth> = location.cacheHealth ?? {};
    const degraded = (cacheHealth.degradedSources ?? []).join(', ');
    const runs = cacheHealth.marineInstances
      ? `${escapeHtml(cacheHealth.marineInstances.water?.id ?? '—')}<br><span class="dim">${escapeHtml(cacheHealth.marineInstances.waves?.id ?? '—')}</span>`
      : '—';
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
      ? 'STORAGE UNAVAILABLE'
      : initialization
        ? 'INITIALIZING'
        : missing
          ? 'AWAITING DATA'
          : cacheHealth.status ?? 'unknown';
    return `<tr>
      <td><strong>${escapeHtml(location.areaName)}</strong><br><span class="dim">${escapeHtml(location.id)}</span></td>
      <td class="${initialization ? 'warn' : missing ? 'bad' : level(age.checkAgeMs, HEALTH_MAX_CHECK_AGE_MS)}"><strong>${escapeHtml(formatAge(age.checkAgeMs))}</strong><br><span class="dim">${escapeHtml(checkDetail)}</span></td>
      <td class="${missing ? 'bad' : level(age.ageMs, HEALTH_MAX_DATA_AGE_MS)}"><strong>${escapeHtml(missing ? 'no forecast' : formatAge(age.ageMs))}</strong></td>
      <td>${escapeHtml(status)}
        <br><span class="${location.exactGenerationReady ? 'good' : 'warn'}">${escapeHtml(generationState)}</span>
        ${providerState ? `<br><span class="warn">${escapeHtml(providerState)}</span>` : ''}</td>
      <td>${degraded ? `<span class="warn">${escapeHtml(degraded)}</span>` : '<span class="dim">none</span>'}</td>
      <td class="dim mono">${runs}</td>
    </tr>`;
  }).join('');

  const banner = health.ok && health.release.allLocationsReady
    ? '<div class="banner good">WORKER LIVE · ALL LOCATIONS CURRENT</div>'
    : health.ok
      ? `<div class="banner warn">WORKER LIVE · TARGET GENERATION ${escapeHtml(health.release.ready.length)}/${escapeHtml(health.locations.length)} READY</div>`
    : `<div class="banner bad">ATTENTION — ${escapeHtml(health.reason ?? health.stalled.join(', '))}</div>`;

  return htmlResponse(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>FRANK worker status</title>
<style>
  :root { color-scheme: dark }
  body { margin:0 auto; padding:20px; max-width:940px; background:#0c1117; color:#e8ecf1;
         font:14px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace }
  h1 { font-size:13px; letter-spacing:.18em; text-transform:uppercase; color:#7a8ba0; margin:0 0 16px }
  .banner { padding:14px 16px; border-radius:8px; font-size:18px; letter-spacing:.06em;
            margin-bottom:18px; border:1px solid }
  .banner.good { background:#0f2a1f; border-color:#34d399; color:#34d399 }
  .banner.warn { background:#2a2410; border-color:#fbbf24; color:#fbbf24 }
  .banner.bad  { background:#2a1010; border-color:#f87171; color:#f87171 }
  table { border-collapse:collapse; width:100%; max-width:900px }
  th { text-align:left; font-size:10px; letter-spacing:.12em; text-transform:uppercase;
       color:#7a8ba0; border-bottom:1px solid rgba(255,255,255,.18); padding:6px 10px 6px 0; font-weight:600 }
  td { padding:10px 10px 10px 0; border-bottom:1px solid rgba(255,255,255,.06); vertical-align:top }
  .good { color:#34d399 } .warn { color:#fbbf24 } .bad { color:#f87171 }
  .dim { color:#7a8ba0 } .mono { font-size:12px }
  .hdr-sub { font-weight:400; text-transform:none; letter-spacing:0; opacity:.7 }
  footer p { margin:0 0 12px }
  code { color:#e8ecf1; background:rgba(255,255,255,.07); padding:1px 4px; border-radius:3px }
  footer { margin-top:20px; color:#7a8ba0; font-size:12px; max-width:900px }
  a { color:#4b9eff }
</style></head><body>
<h1>FRANK · forecast worker</h1>
${banner}
<table>
  <tr><th>Location</th><th>Last check<br><span class="hdr-sub">own cycle per location</span></th><th>Data age<br><span class="hdr-sub">last rebuild</span></th><th>Status<br><span class="hdr-sub">data generation</span></th><th>Degraded</th><th>Water / wave run</th></tr>
  ${rows}
</table>
<footer>
  <p>Last check counts from the most recent time the worker asked MET and DMI whether
  anything had changed. The schedule runs every 10 minutes, but the timestamp is only
  written to storage once it is 15 minutes old, because each write comes out of a daily
  quota. A figure of 15 or 20 minutes therefore does not mean a check was missed.</p>

  <p>Each location also runs that cycle independently, so the four rows are normally out
  of step with each other. One city reading 2 minutes while another reads 11 is the
  expected picture, not a fault: a location's stamp is also rewritten whenever that
  location rebuilds, which follows its own MET validity window. Visitor requests only
  read prepared snapshots and do not alter this clock. The rows only line up right after
  a deploy, when all four are built at once. The alarm sits at
  ${escapeHtml(health.checkStaleAfterMin)} minutes, well clear of the whole cycle.
  Worst right now: ${escapeHtml(health.oldestCheckAgeMin ?? '?')} minutes.</p>

  <p>Data age counts from the last successful rebuild, and a figure that sits still is
  normal here. MET declares each forecast valid for about 30 minutes through its
  Expires header, so between reissues there is nothing new to build and the worker
  skips the work on purpose. It alarms only past
  ${escapeHtml(health.dataStaleAfterMin / 60)} hours, which would mean the checks are
  succeeding while every rebuild fails. Worst right now:
  ${escapeHtml(health.oldestAgeMin ?? '?')} minutes.</p>

  <p>The word under Last check names what triggered it. <code>cron</code> is the
  10-minute schedule. <code>release-candidate</code> is a deployment warm-up for this
  immutable data generation. Ordinary visitors and the refresh
  button only read prepared snapshots; they never start provider work.</p>

  <p>This page reloads every 30 seconds and is meant for reading. The machine-readable
  alarm lives at <a href="/health">/health</a>, which returns 503 and a
  <code>reason</code> when either clock trips.</p>
</footer>
</body></html>
`);
}
