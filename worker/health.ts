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
      <td class="location-cell" data-label="Location"><strong>${escapeHtml(location.areaName)}</strong><br><span class="dim">${escapeHtml(location.id)}</span></td>
      <td data-label="Last check" class="${initialization ? 'warn' : missing ? 'bad' : level(age.checkAgeMs, HEALTH_MAX_CHECK_AGE_MS)}"><strong>${escapeHtml(formatAge(age.checkAgeMs))}</strong><br><span class="dim">${escapeHtml(checkDetail)}</span></td>
      <td data-label="Data age" class="${missing ? 'bad' : level(age.ageMs, HEALTH_MAX_DATA_AGE_MS)}"><strong>${escapeHtml(missing ? 'no forecast' : formatAge(age.ageMs))}</strong></td>
      <td data-label="Status">${escapeHtml(status)}
        <br><span class="${location.exactGenerationReady ? 'good' : 'warn'}">${escapeHtml(generationState)}</span>
        ${providerState ? `<br><span class="warn">${escapeHtml(providerState)}</span>` : ''}</td>
      <td data-label="Degraded">${degraded ? `<span class="warn">${escapeHtml(degraded)}</span>` : '<span class="dim">none</span>'}</td>
      <td data-label="Water / wave run" class="dim mono">${runs}</td>
    </tr>`;
  }).join('');

  const banner = health.ok && health.release.allLocationsReady
    ? '<div class="banner good" role="status"><span class="signal" aria-hidden="true"></span><strong>WORKER LIVE · ALL LOCATIONS CURRENT</strong></div>'
    : health.ok
      ? `<div class="banner warn" role="status"><span class="signal" aria-hidden="true"></span><strong>WORKER LIVE · TARGET GENERATION ${escapeHtml(health.release.ready.length)}/${escapeHtml(health.locations.length)} READY</strong></div>`
    : `<div class="banner bad" role="status"><span class="signal" aria-hidden="true"></span><strong>ATTENTION — ${escapeHtml(health.reason ?? health.stalled.join(', '))}</strong></div>`;

  return htmlResponse(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>FRANK worker status</title>
<style>
  :root {
    color-scheme: light;
    --sky-top:#dceefa; --sky-mid:#edf7fd; --sky-floor:#f5f7fa;
    --panel:rgba(249,252,255,.92); --panel-edge:rgba(51,91,124,.16);
    --text:#1a2332; --muted:#566577; --primary:#1d6fd1;
    --good:#047857; --good-bg:#ecfdf5; --good-edge:#86efac;
    --warn:#a15c00; --warn-bg:#fff7e6; --warn-edge:#f5c56b;
    --bad:#b42318; --bad-bg:#fff1f0; --bad-edge:#f3aaa5;
    --font-ui:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    --font-pixel:"VT323","Courier New",ui-monospace,monospace;
  }
  * { box-sizing:border-box }
  html { min-height:100%; background:var(--sky-floor) }
  body { min-height:100vh; margin:0; padding:clamp(16px,3vw,34px); color:var(--text);
         background:linear-gradient(180deg,var(--sky-top) 0,var(--sky-mid) 44rem,var(--sky-floor) 78rem);
         font:14px/1.55 var(--font-ui); overflow-x:hidden }
  .sky { position:fixed; inset:0; z-index:0; overflow:hidden; pointer-events:none }
  .sky-cloud { position:absolute; width:132px; height:auto; opacity:.58 }
  .sky-cloud path:first-child { fill:rgba(104,151,188,.13) }
  .sky-cloud path:last-child { fill:rgba(255,255,255,.82) }
  .sky-cloud.one { top:8vh; left:3vw }
  .sky-cloud.two { top:38vh; right:3vw; width:96px; opacity:.46 }
  .sky-cloud.three { top:78vh; left:7vw; width:154px; opacity:.38 }
  .status-shell { position:relative; z-index:1; width:min(100%,1040px); margin:0 auto }
  .brand { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:14px;
           margin-bottom:16px; padding:10px 2px }
  .frank-face { width:52px; height:52px; display:grid; place-items:center; border:1px solid #273142;
                border-radius:50%; background:#080d13; box-shadow:0 2px 5px rgba(29,65,94,.16) }
  .face-grid { position:relative; width:30px; height:24px }
  .face-grid::before { content:""; position:absolute; top:3px; left:3px; width:6px; height:6px;
                       background:#11b981; box-shadow:18px 0 #11b981 }
  .face-grid::after { content:""; position:absolute; left:5px; bottom:2px; width:20px; height:7px;
                      border-bottom:3px solid #11b981; border-radius:0 0 12px 12px }
  .brand-name { margin:0 0 1px; color:var(--primary); font-size:11px; font-weight:800;
                letter-spacing:.24em; text-transform:uppercase }
  h1 { margin:0; font-size:clamp(20px,2.6vw,28px); line-height:1.15; letter-spacing:-.025em }
  .brand-subtitle { margin:3px 0 0; color:var(--muted); font-size:12px }
  .refresh-stamp { min-width:100px; padding:7px 10px; border:1px solid var(--panel-edge); border-radius:6px;
                   background:rgba(249,252,255,.65); color:var(--muted); text-align:right; font-size:10px;
                   letter-spacing:.09em; text-transform:uppercase }
  .refresh-stamp strong { display:block; color:var(--text); font-size:13px; letter-spacing:.02em }
  .banner { --tone:var(--primary); --tone-bg:#eef6ff; --tone-edge:#a8c9ee;
            min-height:60px; margin-bottom:14px; padding:12px 16px; display:flex; align-items:center; gap:11px;
            border:1px solid var(--tone-edge); border-radius:8px; background:var(--tone-bg);
            box-shadow:0 1px 3px rgba(46,78,107,.07); color:var(--tone) }
  .banner.good { --tone:var(--good); --tone-bg:var(--good-bg); --tone-edge:var(--good-edge) }
  .banner.warn { --tone:var(--warn); --tone-bg:var(--warn-bg); --tone-edge:var(--warn-edge) }
  .banner.bad { --tone:var(--bad); --tone-bg:var(--bad-bg); --tone-edge:var(--bad-edge) }
  .banner strong { font:400 clamp(20px,2.7vw,27px)/1.05 var(--font-pixel); letter-spacing:.055em }
  .signal { flex:0 0 auto; width:10px; height:10px; border-radius:2px; background:var(--tone);
            box-shadow:0 0 0 4px color-mix(in srgb,var(--tone) 13%,transparent) }
  .status-panel,.notes { border:1px solid var(--panel-edge); border-radius:8px; background:var(--panel);
                         box-shadow:0 2px 9px rgba(46,78,107,.07); backdrop-filter:blur(8px) }
  .status-panel { padding:clamp(12px,2vw,20px) }
  .panel-head { display:flex; align-items:end; justify-content:space-between; gap:12px; margin:0 0 12px }
  h2 { margin:0; font-size:12px; letter-spacing:.16em; text-transform:uppercase }
  .panel-head p { margin:0; color:var(--muted); font-size:11px }
  .table-wrap { width:100%; overflow-x:auto }
  table { width:100%; border-collapse:collapse; table-layout:fixed }
  th { padding:8px 10px; border-bottom:1px solid rgba(51,91,124,.2); color:var(--muted);
       text-align:left; vertical-align:bottom; font-size:10px; font-weight:750; letter-spacing:.1em; text-transform:uppercase }
  th:first-child,td:first-child { padding-left:4px; width:16% }
  th:nth-child(2) { width:22% } th:nth-child(3) { width:10% } th:nth-child(4) { width:25% }
  th:nth-child(5) { width:10% } th:nth-child(6) { width:17% }
  td { padding:12px 10px; border-bottom:1px solid rgba(51,91,124,.11); vertical-align:top;
       overflow-wrap:anywhere }
  tbody tr:last-child td { border-bottom:0 }
  .location-cell strong { font-size:14px }
  .good { color:var(--good) } .warn { color:var(--warn) } .bad { color:var(--bad) }
  .dim { color:var(--muted) } .mono { font:12px/1.5 var(--font-pixel); letter-spacing:.025em }
  .hdr-sub { font-weight:500; text-transform:none; letter-spacing:0; opacity:.78 }
  .notes { margin-top:14px; padding:clamp(16px,2.5vw,24px); color:var(--muted); font-size:12px }
  .notes h2 { margin-bottom:12px; color:var(--text) }
  .notes p { margin:0 0 12px; max-width:90ch }
  .notes p:last-child { margin-bottom:0 }
  code { padding:2px 5px; border:1px solid rgba(51,91,124,.14); border-radius:4px;
         background:rgba(29,111,209,.07); color:var(--text); font:12px var(--font-pixel) }
  a { color:var(--primary); font-weight:700; text-underline-offset:2px }
  @media (max-width:720px) {
    body { padding:14px 12px 24px }
    .sky-cloud.two,.sky-cloud.three { display:none }
    .brand { grid-template-columns:auto minmax(0,1fr); gap:11px }
    .refresh-stamp { grid-column:1 / -1; width:100%; display:flex; justify-content:space-between;
                     align-items:center; text-align:left }
    .refresh-stamp strong { display:inline }
    .banner { align-items:flex-start; padding:12px 14px }
    .table-wrap { overflow:visible }
    table,tbody,tr,td { display:block; width:100% }
    table { table-layout:auto }
    thead { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
            clip:rect(0,0,0,0); white-space:nowrap; border:0 }
    tbody { display:grid; gap:10px }
    tbody tr { display:grid; grid-template-columns:1fr 1fr; overflow:hidden;
               border:1px solid rgba(51,91,124,.15); border-radius:7px; background:rgba(255,255,255,.38) }
    td,th:first-child,td:first-child { width:auto }
    td { min-width:0; padding:10px 11px; border:0; border-top:1px solid rgba(51,91,124,.09) }
    td:nth-child(even) { border-left:1px solid rgba(51,91,124,.09) }
    td::before { content:attr(data-label); display:block; margin-bottom:3px; color:var(--muted);
                 font-size:9px; font-weight:800; letter-spacing:.1em; text-transform:uppercase }
    td.location-cell { grid-column:1 / -1; padding:11px; border-top:0; border-left:0;
                       background:rgba(29,111,209,.045) }
    .location-cell::before { display:none }
    .location-cell strong { font-size:15px }
    .panel-head { align-items:flex-start; flex-direction:column; gap:2px }
  }
  @media (max-width:350px) {
    .frank-face { width:46px; height:46px }
    .banner strong { font-size:19px }
    tbody tr { grid-template-columns:1fr }
    td:nth-child(even) { border-left:0 }
    .notes { padding:16px 14px }
  }
  @media (prefers-reduced-transparency:reduce) {
    .status-panel,.notes { background:#f9fcff; backdrop-filter:none }
  }
</style></head><body>
<div class="sky" aria-hidden="true">
  <svg class="sky-cloud one" viewBox="0 0 34 14"><path d="M2 11h5V9h4V6h3V4h5v2h4v2h6v3h3v2H2z"/><path d="M2 9h5V7h4V4h3V2h5v2h4v2h6v3h3v2H2z"/></svg>
  <svg class="sky-cloud two" viewBox="0 0 29 13"><path d="M1 10h4V8h3V5h4V3h4v2h3v2h5v3h3v2H1z"/><path d="M1 8h4V6h3V3h4V1h4v2h3v2h5v3h3v2H1z"/></svg>
  <svg class="sky-cloud three" viewBox="0 0 39 15"><path d="M2 12h6V9h5V7h3V4h5V2h5v3h3v2h5v2h3v3z"/><path d="M2 10h6V7h5V5h3V2h5V0h5v3h3v2h5v2h3v3z"/></svg>
</div>
<main class="status-shell">
  <header class="brand">
    <div class="frank-face" aria-hidden="true"><span class="face-grid"></span></div>
    <div><p class="brand-name">F · R · A · N · K</p><h1>Forecast worker</h1><p class="brand-subtitle">Prepared forecast system status</p></div>
    <div class="refresh-stamp"><span>Auto refresh</span><strong>30 seconds</strong></div>
  </header>
  ${banner}
  <section class="status-panel" aria-labelledby="locations-title">
    <div class="panel-head"><h2 id="locations-title">Locations</h2><p>Independent forecast cycles</p></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Location</th><th>Last check<br><span class="hdr-sub">own cycle per location</span></th><th>Data age<br><span class="hdr-sub">last rebuild</span></th><th>Status<br><span class="hdr-sub">data generation</span></th><th>Degraded</th><th>Water / wave run</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>
<footer class="notes">
  <h2>How to read this panel</h2>
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
</main>
</body></html>
`);
}
