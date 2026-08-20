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

type FrankStatusRating = 'safe' | 'caution' | 'danger';

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

  const rows = health.locations.map((location) => {
    const age = byId.get(location.id) ?? {
      ageMs: Number.POSITIVE_INFINITY,
      checkAgeMs: Number.POSITIVE_INFINITY,
    };
    const cacheHealth: Partial<WorkerCacheHealth> = location.cacheHealth ?? {};
    const degraded = (cacheHealth.degradedSources ?? []).join(', ');
    const weatherRun = cacheHealth.weatherLastModified
      ? escapeHtml(formatUtcTimestamp(cacheHealth.weatherLastModified))
      : '—';
    const waterRun = escapeHtml(cacheHealth.marineInstances?.water?.id ?? '—');
    const waveRun = escapeHtml(cacheHealth.marineInstances?.waves?.id ?? '—');
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
      <td data-label="Status" class="status-cell">${escapeHtml(status)}
        <br><span class="${location.exactGenerationReady ? 'good' : 'warn'}">${escapeHtml(generationState)}</span>
        ${providerState ? `<br><span class="warn">${escapeHtml(providerState)}</span>` : ''}</td>
      <td data-label="Weather / MET" class="source-cell source-weather dim mono">${weatherRun}</td>
      <td data-label="Water level" class="source-cell source-water dim mono">${waterRun}</td>
      <td data-label="Waves" class="source-cell source-waves dim mono">${waveRun}</td>
      <td data-label="Degraded" class="degraded-cell">${degraded ? `<span class="warn">${escapeHtml(degraded)}</span>` : '<span class="dim">none</span>'}</td>
    </tr>`;
  }).join('');

  const rating: FrankStatusRating = health.ok && health.release.allLocationsReady
    ? 'safe'
    : health.ok
      ? 'caution'
      : 'danger';
  const displayMessage = rating === 'safe'
    ? 'all locations current'
    : rating === 'caution'
      ? `${health.release.ready.length}/${health.locations.length} locations ready`
      : 'check required';
  const statusLabel = rating === 'safe'
    ? 'All systems ready'
    : rating === 'caution'
      ? 'Release preparing'
      : 'Operator attention';
  const statusDetail = rating === 'danger'
    ? `${statusLabel} · ${health.reason ?? health.stalled.join(', ')}`
    : `${statusLabel} · independent provider cycles`;

  return htmlResponse(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>FRANK worker status</title>
<style>
  :root {
    color-scheme:light;
    --font-heading:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    --font-body:'Inter',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    --font-mono:'Inter',ui-monospace,'SFMono-Regular',Consolas,monospace;
    --font-crt:'VT323','Courier New',ui-monospace,monospace;
    --text-instrument:.6875rem;
    --text-caption:.75rem;
    --text-ui:.8125rem;
    --text-body:.875rem;
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
  .frank-cache {
    align-self:center;
    display:inline-flex;
    max-width:100%;
    align-items:center;
    gap:6px;
    padding-right:18px;
    color:var(--text-muted);
    font-size:var(--text-caption);
    font-variant-numeric:tabular-nums;
    text-align:center;
  }
  .frank-cache::before {
    content:'';
    flex:0 0 auto;
    width:7px;
    height:7px;
    border-radius:50%;
    background:var(--frank-phosphor);
    box-shadow:0 0 4px var(--frank-phosphor);
  }
  .frank-device-columns {
    display:grid;
    grid-template-columns:auto minmax(0,1fr) 142px;
    grid-template-areas:
      'crt display actions'
      'name . location';
    column-gap:16px;
    row-gap:10px;
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
  .frank-cell-display {
    grid-area:display;
    display:flex;
    align-items:center;
    min-width:0;
    padding:0 16px;
    border-right:1px solid var(--frank-housing-edge);
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
    overflow-wrap:anywhere;
    text-shadow:0 0 8px color-mix(in srgb,currentColor 60%,transparent);
  }
  .operation-stamp {
    grid-area:actions;
    align-self:stretch;
    display:grid;
    grid-template-columns:1fr;
    align-content:center;
    gap:2px;
    min-width:0;
    padding:10px 11px;
    border:1px solid var(--module-edge);
    border-radius:var(--radius-sm);
    color:var(--text-muted);
    background:var(--module-bg);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.65);
    font-size:var(--text-instrument);
    line-height:1.25;
    letter-spacing:.1em;
    text-transform:uppercase;
  }
  .operation-stamp strong {
    min-width:0;
    margin-bottom:0;
    overflow-wrap:anywhere;
    color:var(--text-main);
    font-size:var(--text-caption);
    letter-spacing:.02em;
    text-transform:none;
  }
  .frank-location {
    grid-area:location;
    place-self:center;
    color:var(--frank-housing-text);
    font-size:var(--text-caption);
    font-weight:700;
    letter-spacing:.18em;
    line-height:1;
    text-transform:uppercase;
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
  .table-wrap { width:100%; padding:6px 10px 10px; overflow-x:auto }
  table { width:100%; border-collapse:separate; border-spacing:0 6px; table-layout:fixed }
  th {
    padding:3px 9px 5px;
    color:var(--text-muted);
    text-align:left;
    vertical-align:bottom;
    font-size:.625rem;
    font-weight:750;
    letter-spacing:.1em;
    text-transform:uppercase;
  }
  th:first-child,td:first-child { width:14% }
  th:nth-child(2) { width:17% }
  th:nth-child(3) { width:8% }
  th:nth-child(4) { width:20% }
  th:nth-child(5) { width:13% }
  th:nth-child(6) { width:10% }
  th:nth-child(7) { width:10% }
  th:nth-child(8) { width:8% }
  td {
    padding:10px 9px;
    border-top:1px solid var(--module-edge);
    border-bottom:1px solid var(--module-edge);
    color:var(--text-main);
    background:var(--module-bg);
    vertical-align:top;
    overflow-wrap:anywhere;
  }
  td:first-child {
    padding-left:12px;
    border-left:1px solid var(--module-edge);
    border-radius:var(--radius-sm) 0 0 var(--radius-sm);
  }
  td:last-child {
    padding-right:12px;
    border-right:1px solid var(--module-edge);
    border-radius:0 var(--radius-sm) var(--radius-sm) 0;
  }
  .location-cell strong { font-size:var(--text-body) }
  .good { color:var(--color-safe-text) }
  .warn { color:var(--color-caution-text) }
  .bad { color:var(--color-danger-text) }
  .dim { color:var(--text-muted) }
  .mono { font:var(--text-caption)/1.45 var(--font-mono); letter-spacing:.01em }
  .hdr-sub { font-weight:500; text-transform:none; letter-spacing:0; opacity:.82 }

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
    .table-wrap { padding:8px; overflow:visible }
    table,tbody,tr,td { display:block; width:100% }
    table { table-layout:auto; border-spacing:0 }
    thead {
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
    tbody { display:grid; gap:8px }
    tbody tr {
      display:grid;
      grid-template-columns:1fr 1fr;
      overflow:hidden;
      border:1px solid var(--module-edge);
      border-radius:var(--radius-sm);
      background:var(--module-bg);
    }
    td,th:first-child,td:first-child {
      width:auto;
      min-width:0;
      padding:9px 10px;
      border:0;
      border-top:1px solid var(--module-edge);
      border-radius:0;
      background:transparent;
    }
    td:nth-child(even) { border-left:1px solid var(--module-edge) }
    td::before {
      content:attr(data-label);
      display:block;
      margin-bottom:3px;
      color:var(--text-muted);
      font-size:.625rem;
      font-weight:800;
      letter-spacing:.1em;
      text-transform:uppercase;
    }
    td.location-cell {
      grid-column:1/-1;
      padding:10px;
      border-top:0;
      border-left:0;
      background:color-mix(in srgb,var(--primary) 4%,var(--module-bg));
    }
    .location-cell::before { display:none }
    .location-cell strong { font-size:.9375rem }
    td.status-cell {
      grid-column:1/-1;
      border-left:0;
    }
    td.source-weather { grid-column:1/-1; border-left:0 }
    td.source-water { border-left:0 }
    td.degraded-cell { grid-column:1/-1; border-left:0 }
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
    .frank-display { min-height:56px; padding:6px 8px; font-size:1.3125rem }
    .frank-nameplate { letter-spacing:.45em; text-indent:.45em }
    .operation-stamp { padding:7px 8px; font-size:.625rem }
    .operation-stamp strong { font-size:.6875rem }
    .frank-location { font-size:.6875rem; letter-spacing:.08em }
  }
  @media (max-width:360px) {
    .status-shell { padding-right:8px; padding-left:8px }
    .frank-device-columns {
      grid-template-columns:64px minmax(0,1fr);
      grid-template-areas:
        'crt actions'
        'name location';
      column-gap:16px;
    }
    .frank-cell-display { display:none }
    .frank-nameplate { font-size:.625rem; letter-spacing:.35em; text-indent:.35em }
    .operation-stamp {
      grid-template-columns:minmax(0,1fr) auto;
      align-items:center;
      gap:3px 8px;
      padding:7px 9px;
    }
    .operation-stamp strong { margin:0; text-align:right }
    .frank-location { justify-self:end }
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
  <header class="frank-device-shell rating-${rating}">
    <div class="frank-cache"><span>System checked ${escapeHtml(formatUtcTimestamp(health.checkedAt))}</span></div>
    <div class="frank-device-columns">
      <span class="frank-crt">${gertyStatusFace(rating)}</span>
      <div class="frank-cell-display">
        <div class="frank-display" role="status" aria-label="${escapeHtml(statusDetail)}">
          <span id="frank-status-label" class="frank-display-text">${escapeHtml(displayMessage)}</span>
        </div>
      </div>
      <div class="operation-stamp" aria-label="Status page operations">
        <span>Auto refresh</span><strong>30 seconds</strong>
      </div>
      <span class="frank-nameplate">FRANK</span>
      <span class="frank-location">Forecast worker</span>
    </div>
  </header>

  <section class="instrument-panel" aria-labelledby="locations-title">
    <div class="panel-bezel">
      <h2 id="locations-title">Forecast locations</h2>
      <p>${escapeHtml(statusDetail)}</p>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Location</th><th>Last check<br><span class="hdr-sub">own cycle per location</span></th><th>Data age<br><span class="hdr-sub">last rebuild</span></th><th>Status<br><span class="hdr-sub">data generation</span></th><th>Weather<br><span class="hdr-sub">MET issue</span></th><th>Water<br><span class="hdr-sub">DMI run</span></th><th>Waves<br><span class="hdr-sub">DMI run</span></th><th>Degraded</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>

  <details class="notes">
    <summary>How to read this instrument</summary>
    <div class="notes-content">
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
    </div>
  </details>
</main>
</body></html>
`);
}
