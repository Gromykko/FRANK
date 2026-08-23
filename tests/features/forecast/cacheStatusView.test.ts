import { describe, it, expect } from 'vitest';
import { getCacheStatusView, deriveCacheStatus } from '../../../src/features/forecast/cacheStatusView';
import { FORECAST_PAYLOAD_VERSION } from '../../../src/features/forecast/types';
import { da } from '../../../src/i18n/da';
import { interpolate } from '../../../src/i18n/interpolate';

type Health = NonNullable<Parameters<typeof getCacheStatusView>[0]['cacheHealth']>;
const view = (cacheHealth: Partial<Health> | undefined, refreshing = false) =>
  getCacheStatusView({ refreshing, cacheHealth: cacheHealth as Health, forecastAtLabel: '20:07' });

describe('getCacheStatusView', () => {
  it('offline reads a neutral "Offline" with the saved forecast time', () => {
    const v = getCacheStatusView({
      refreshing: false,
      cacheHealth: { status: 'current', lastAttemptAt: '' } as Health,
      forecastAtLabel: '18:40',
      offline: true,
    });
    expect(v.label).toBe('Offline');
    expect(v.detail).toBe('Showing your saved forecast from 18:40');
    expect(v.tone).toBe('neutral');
  });

  it('offline stays amber when the saved cache is already stale', () => {
    const v = getCacheStatusView({
      refreshing: false,
      cacheHealth: { status: 'stale', lastAttemptAt: '' } as Health,
      forecastAtLabel: '12:10',
      offline: true,
    });
    expect(v).toMatchObject({
      label: 'Offline',
      detail: 'Showing your older saved forecast from 12:10',
      tone: 'watch',
    });
  });

  it('says explicitly in Danish when an offline saved forecast is older', () => {
    const translateDa = (key: string, ...args: Array<string | number>) =>
      interpolate(da[key] ?? key, ...args);
    const v = getCacheStatusView({
      refreshing: false,
      cacheHealth: { status: 'fallback', lastAttemptAt: '' } as Health,
      forecastAtLabel: '12:10',
      offline: true,
    }, translateDa);
    expect(v.detail).toBe('Viser din ældre gemte prognose fra 12:10');
    expect(v.tone).toBe('watch');
  });

  it('a busy MARINE provider (no cache) is calm amber and names the service, no "hours old"', () => {
    const v = view({ status: 'stale', providerBusy: true, busyProvider: 'marine', lastAttemptAt: '' });
    expect(v.label).toBe('Waves & water service busy');
    expect(v.detail).toBe('Retrying automatically');
    expect(v.tone).toBe('watch');
    expect(v.detail).not.toMatch(/old/);
  });

  it('a busy WEATHER provider names the weather service', () => {
    const v = view({ status: 'stale', providerBusy: true, busyProvider: 'weather', lastAttemptAt: '' });
    expect(v.label).toBe('Weather service busy');
  });

  it('a genuine (non-busy) failure with data present is amber "Couldn’t refresh", never red', () => {
    const v = view({ status: 'stale', providerBusy: false, lastAttemptAt: '' });
    expect(v.label).toBe('Couldn’t refresh');
    expect(v.detail).toBe('Retrying automatically');
    expect(v.tone).toBe('watch');
  });

  it('a partial build from a non-busy error says "couldn’t refresh just now", not "busy"', () => {
    const v = view({ status: 'current', degradedSources: ['water', 'waves'], providerBusy: false, lastAttemptAt: '' });
    expect(v.detail).toBe('waves & water from an earlier update · couldn’t refresh just now');

    const wavesOnly = view({ status: 'current', degradedSources: ['waves'], providerBusy: false, lastAttemptAt: '' });
    expect(wavesOnly.detail).toBe('waves from an earlier update · couldn’t refresh just now');

    const waterOnly = view({ status: 'current', degradedSources: ['water'], providerBusy: false, lastAttemptAt: '' });
    expect(waterOnly.detail).toBe('water from an earlier update · couldn’t refresh just now');
  });

  it('a routine refresh is a neutral one-liner - "Refreshing…", no second line, no amber', () => {
    const v = view({ status: 'current', degradedSources: ['water', 'waves'], providerBusy: true, lastAttemptAt: '' }, true);
    expect(v).toMatchObject({ label: 'Refreshing…', detail: '', tone: 'neutral' });
  });

  it('keeps an old saved forecast honestly amber while it is being checked', () => {
    const v = getCacheStatusView({
      refreshing: true,
      cacheHealth: { status: 'stale', lastAttemptAt: '' } as Health,
      forecastAtLabel: '12:10',
      forecastAgeLabel: '8 h',
    });
    expect(v).toMatchObject({
      label: 'Refreshing…',
      detail: 'Showing saved forecast · 8 h old',
      tone: 'watch',
    });
    expect(v.label).not.toMatch(/Couldn’t/);
  });
});

// ---------------------------------------------------------------------------
// Whether the header may claim freshness is decided by OUR OWN record of
// reaching the worker, not by the worker's `lastAttemptAt` stamp. That stamp is
// operational and can now include a safe, anomaly-aware heartbeat overlay, but
// it still does not prove this browser's request succeeded. Deriving browser
// contact from it produced three separate bugs: a
// healthy forecast reported as "Couldn't refresh", a false "Could not reach the
// forecast service" banner on cold boot, and a misleading /status column.
// ---------------------------------------------------------------------------
describe('deriveCacheStatus freshness', () => {
  const NOW = Date.parse('2026-08-08T14:50:00Z');
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const derive = (
    contact: number | null | undefined,
    { fetchedMsAgo = 5 * 60_000, status = 'current' as const } = {}
  ) =>
    deriveCacheStatus({
      sources: {
        fetchedAt: at(fetchedMsAgo),
        cacheHealth: { status, lastAttemptAt: at(fetchedMsAgo) },
      } as never,
      refreshing: false,
      online: true,
      nowMs: NOW,
      workerContactedAtMs: contact,
    });

  it('reached the worker just now: green', () => {
    expect(derive(NOW - 60_000).view.tone).toBe('fresh');
  });

  it('reached it long ago: NOT green, whatever the payload claims about itself', () => {
    // The saved copy still carries the last good payload's status:'current'.
    const result = derive(NOW - 3 * 60 * 60_000);
    expect(result.view.tone).not.toBe('fresh');
    expect(result.view.label).not.toMatch(/Couldn’t refresh/);
  });

  it('attempted and never reached it: NOT green', () => {
    // The case that must not collapse into "unknown". Boot with a live
    // connection and a dead worker, fall back to the saved copy — its stale
    // status:'current' previously rendered as fresh at 14:50.
    const v = derive(null);
    expect(v.view.tone).not.toBe('fresh');
    expect(v.view.label).toBe('Couldn’t refresh');
  });

  it('no attempt finished yet: judge nothing', () => {
    // Boot renders the saved copy before the first fetch resolves. Demoting the
    // tone here would flash a warning that is not (yet) true.
    expect(derive(undefined).view.tone).toBe('fresh');
  });

  it('the worker stamp no longer influences the tone at all', () => {
    // The whole point of the refactor: an ancient stamp with fresh contact is
    // a healthy worker that simply had nothing new to build.
    const v = derive(NOW - 60_000, { fetchedMsAgo: 90 * 60_000 });
    expect(v.view.tone).toBe('fresh');
  });

  it('still raises the page banner once the forecast itself is genuinely old', () => {
    expect(derive(null, { fetchedMsAgo: 5 * 60 * 60_000 }).showRefreshWarning).toBe(false);
    const old = derive(null, { fetchedMsAgo: 7 * 60 * 60_000 });
    expect(old.showRefreshWarning).toBe(true);
    expect(old.forecastAgeLabel).toBe('7 h');
  });

  it('an alive but non-updating Worker is still caught', () => {
    // The gap the contact test cannot see. If the Worker exhausts its KV write
    // budget it stays perfectly reachable and keeps serving a payload stamped
    // status:'current' — contact is fresh, nothing errors, and the forecast
    // underneath silently stops advancing. Data age is an independent detector
    // precisely so this cannot render as fresh.
    const v = derive(NOW - 60_000, { fetchedMsAgo: 8 * 60 * 60_000 });
    expect(v.view.tone).not.toBe('fresh');
    expect(v.showRefreshWarning).toBe(true);
    expect(v.forecastAgeLabel).toBe('8 h');
  });

  it('old local data being checked stays compact and does not raise the settled-failure banner', () => {
    const result = deriveCacheStatus({
      sources: {
        fetchedAt: at(8 * 60 * 60_000),
        cacheHealth: { status: 'current', lastAttemptAt: at(8 * 60 * 60_000) },
      } as never,
      refreshing: true,
      online: true,
      nowMs: NOW,
      workerContactedAtMs: undefined,
      checkState: 'checking',
    });

    expect(result.view).toMatchObject({
      label: 'Refreshing…',
      detail: 'Showing saved forecast · 8 h old',
      tone: 'watch',
    });
    expect(result.showRefreshWarning).toBe(false);
    expect(result.expandedDetail).toContain('updating now');
    expect(result.expandedDetail).not.toContain('could not be refreshed');
  });

  it('a reached Worker preparing an update is one calm saved-data state', () => {
    const result = deriveCacheStatus({
      sources: {
        payloadVersion: FORECAST_PAYLOAD_VERSION - 1,
        fetchedAt: at(20 * 60 * 60_000),
        cacheHealth: {
          status: 'stale',
          lastAttemptAt: at(20 * 60 * 60_000),
          needsRebuild: true,
        },
      } as never,
      refreshing: false,
      online: true,
      nowMs: NOW,
      workerContactedAtMs: NOW - 1_000,
      checkState: 'initializing',
    });

    expect(result.view).toMatchObject({
      label: 'Preparing update…',
      detail: 'Showing saved forecast · 20 h old',
      tone: 'watch',
    });
    expect(result.expandedDetail).toContain('reached the forecast service');
    expect(result.expandedDetail).toContain('retry automatically');
    expect(result.expandedDetail).not.toMatch(/could not|fail/i);
    expect(result.showRefreshWarning).toBe(false);
    expect(result.workerOutdated).toBe(false);
  });

  it('raises the warning only after the check completes as a failure', () => {
    const result = deriveCacheStatus({
      sources: {
        fetchedAt: at(8 * 60 * 60_000),
        cacheHealth: { status: 'current', lastAttemptAt: at(8 * 60 * 60_000) },
      } as never,
      refreshing: false,
      online: true,
      nowMs: NOW,
      workerContactedAtMs: null,
      checkState: 'failed',
    });

    expect(result.view.label).toBe('Couldn’t refresh');
    expect(result.showRefreshWarning).toBe(true);
  });

  it('aged contact means needs verification, not a completed failure', () => {
    const result = deriveCacheStatus({
      sources: {
        fetchedAt: at(5 * 60_000),
        cacheHealth: { status: 'current', lastAttemptAt: at(5 * 60_000) },
      } as never,
      refreshing: false,
      online: true,
      nowMs: NOW,
      workerContactedAtMs: NOW - 3 * 60 * 60_000,
      checkState: 'succeeded',
    });

    expect(result.view).toMatchObject({
      label: 'Saved forecast · 16:45',
      detail: 'Needs a new check',
      tone: 'neutral',
    });
    expect(result.view.label).not.toMatch(/Couldn’t/);
    expect(result.showRefreshWarning).toBe(false);
  });

  it('keeps an old offline forecast warning immediate even if a check was starting', () => {
    const result = deriveCacheStatus({
      sources: {
        fetchedAt: at(8 * 60 * 60_000),
        cacheHealth: { status: 'current', lastAttemptAt: at(8 * 60 * 60_000) },
      } as never,
      refreshing: true,
      online: false,
      nowMs: NOW,
      workerContactedAtMs: null,
      checkState: 'checking',
    });

    expect(result.view).toMatchObject({ label: 'Offline', tone: 'watch' });
    expect(result.showRefreshWarning).toBe(true);
  });
});

// Two ways the header could look healthier than the data underneath it.
describe('honesty under adverse conditions', () => {
  type Health = NonNullable<Parameters<typeof getCacheStatusView>[0]['cacheHealth']>;

  // Losing signal must not visually improve the forecast in your pocket. Water
  // and waves are the two readings that feed the safety verdict, so hiding that
  // they are recycled is the worst place to do it — and it happens at the fjord,
  // which is exactly where the saved copy gets used.
  it('still names recycled sources when the connection drops', () => {
    const health = {
      status: 'current',
      lastAttemptAt: '2026-08-22T09:00:00.000Z',
      degradedSources: ['water', 'waves'],
      providerBusy: true,
      busyProvider: 'marine',
    } as unknown as Health;

    const online = getCacheStatusView({ refreshing: false, cacheHealth: health, forecastAtLabel: '09:00' });
    const offline = getCacheStatusView({
      refreshing: false, cacheHealth: health, forecastAtLabel: '09:00',
      offline: true,
    });

    expect(online.partiallyDegraded).toBe(true);
    expect(offline.partiallyDegraded).toBe(true);
    expect(offline.degradedLabel).toBe(online.degradedLabel);
    expect(offline.tone).not.toBe('neutral');
    // Whether a provider is busy is a claim about now, and offline we cannot
    // know. What the recycled sources ARE is a fact about the bytes in hand.
    expect(offline.providerBusy).toBe(false);
  });

  it('reads calm when offline with nothing degraded', () => {
    const offline = getCacheStatusView({
      refreshing: false,
      cacheHealth: { status: 'current', lastAttemptAt: '2026-08-22T09:00:00.000Z' } as unknown as Health,
      forecastAtLabel: '09:00', offline: true,
    });
    expect(offline.tone).toBe('neutral');
    expect(offline.partiallyDegraded).toBe(false);
  });
});

describe('main-page forecast freshness presentation', () => {
  const NOW = Date.parse('2026-08-08T16:50:00Z');
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it('uses fetchedAt in the header and never displays provider-check time', () => {
    const result = deriveCacheStatus({
      sources: {
        fetchedAt: at(5 * 60_000),
        cacheHealth: { status: 'current', lastAttemptAt: at(60_000) },
        cronHeartbeat: { lastTickAt: at(30_000), ageMin: 1 },
      } as never,
      refreshing: false,
      online: true,
      nowMs: NOW,
      workerContactedAtMs: NOW - 1_000,
      checkState: 'succeeded',
    });

    expect(result.view).toMatchObject({ label: 'Forecast from 18:45', tone: 'fresh' });
    expect(result.view.label).not.toContain('18:49');
    expect(result.expandedDetail).not.toMatch(/check/i);
    expect(result).not.toHaveProperty('checkedAt');
    expect(result.showRefreshWarning).toBe(false);
  });

  it('keeps degraded sources named and amber without a check-age label', () => {
    const busy = view({
      status: 'current',
      degradedSources: ['water', 'waves'],
      providerBusy: true,
      lastAttemptAt: '',
    });
    expect(busy).toMatchObject({
      label: 'Forecast from 20:07',
      tone: 'watch',
      partiallyDegraded: true,
    });
    expect(busy.detail).toBe('waves & water from an earlier update · marine service busy');

    const wavesOnlyBusy = view({
      status: 'current',
      degradedSources: ['waves'],
      providerBusy: true,
      lastAttemptAt: '',
    });
    expect(wavesOnlyBusy.detail).toBe('waves from an earlier update · wave service busy');

    const waterOnlyBusy = view({
      status: 'current',
      degradedSources: ['water'],
      providerBusy: true,
      lastAttemptAt: '',
    });
    expect(waterOnlyBusy.detail).toBe('water from an earlier update · water level service busy');

    const weatherBusy = view({
      status: 'current',
      degradedSources: ['weather'],
      providerBusy: true,
      lastAttemptAt: '',
    });
    expect(weatherBusy.detail).toBe('weather from an earlier update · weather service busy');

    const bothBusy = view({
      status: 'current',
      degradedSources: ['weather', 'water', 'waves'],
      providerBusy: true,
      lastAttemptAt: '',
    });
    expect(bothBusy.detail).toBe('weather, waves & water from an earlier update · services busy');
  });
});

// A timestamp at or ahead of the browser's clock is not evidence of freshness.
// Unfloored it made dataStale false forever, so a phone with a slow clock — or
// a hand-written localStorage payload dated year 3000 on a shared github.io
// origin — could never be judged stale.
describe('deriveCacheStatus clock skew', () => {
  const NOW = Date.parse('2026-08-22T21:00:00.000Z');
  const sourcesAt = (fetchedAt: string) => ({
    fetchedAt,
    payloadVersion: FORECAST_PAYLOAD_VERSION,
    cacheHealth: { status: 'current', lastAttemptAt: fetchedAt },
  }) as unknown as Parameters<typeof deriveCacheStatus>[0]['sources'];

  const status = (fetchedAt: string) => deriveCacheStatus({
    sources: sourcesAt(fetchedAt),
    refreshing: false,
    online: true,
    nowMs: NOW,
    lastWorkerContactMs: NOW,
  });

  it('refuses a timestamp implausibly far ahead of this clock', () => {
    expect(status(new Date(NOW + 9 * 60 * 60 * 1000).toISOString()).showRefreshWarning).toBe(true);
    expect(status('3000-01-01T00:00:00.000Z').showRefreshWarning).toBe(true);
  });

  it('tolerates ordinary skew without crying stale', () => {
    expect(status(new Date(NOW + 30_000).toISOString()).showRefreshWarning).toBe(false);
    expect(status(new Date(NOW - 60_000).toISOString()).showRefreshWarning).toBe(false);
  });
});
