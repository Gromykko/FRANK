import { describe, it, expect } from 'vitest';
import { getCacheStatusView, deriveCacheStatus } from '../../../src/features/forecast/cacheStatusView';
import { FORECAST_PAYLOAD_VERSION } from '../../../src/features/forecast/types';
import { da } from '../../../src/i18n/da';
import { interpolate } from '../../../src/i18n/interpolate';

type Health = NonNullable<Parameters<typeof getCacheStatusView>[0]['cacheHealth']>;
const view = (cacheHealth: Partial<Health> | undefined, refreshing = false) =>
  getCacheStatusView({ refreshing, cacheHealth: cacheHealth as Health, forecastAtLabel: '20:07' });

describe('getCacheStatusView', () => {
  it('offline reads a neutral "Offline" with the saved forecast age', () => {
    const v = getCacheStatusView({
      refreshing: false,
      cacheHealth: { status: 'current', lastAttemptAt: '' } as Health,
      forecastAtLabel: '18:40',
      forecastAgeLabel: '10 min',
      offline: true,
    });
    expect(v.label).toBe('Offline');
    expect(v.detail).toBe('Saved forecast · 10 min old');
    expect(v.tone).toBe('neutral');
  });

  it('offline stays amber and names the age when the saved cache is already stale', () => {
    const v = getCacheStatusView({
      refreshing: false,
      cacheHealth: { status: 'stale', lastAttemptAt: '' } as Health,
      forecastAtLabel: '12:10',
      forecastAgeLabel: '8 h',
      offline: true,
    });
    expect(v).toMatchObject({
      label: 'Offline',
      detail: 'Saved forecast · 8 h old',
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
      forecastAgeLabel: '8 t',
      offline: true,
    }, translateDa);
    expect(v.detail).toBe('Gemt prognose · 8 t gammel');
    expect(v.tone).toBe('watch');
  });

  it('a stale forecast stays cause-neutral even when operator state records a busy marine provider', () => {
    const v = view({ status: 'stale', providerBusy: true, busyProvider: 'marine', lastAttemptAt: '' });
    expect(v.label).toBe('Couldn’t refresh');
    expect(v.detail).toBe('Saved forecast');
    expect(v.tone).toBe('watch');
    expect(`${v.label} ${v.detail}`).not.toMatch(/service|provider|busy|429|DMI|MET/i);
  });

  it('does not expose a busy weather provider in the paddler-facing status', () => {
    const v = view({ status: 'stale', providerBusy: true, busyProvider: 'weather', lastAttemptAt: '' });
    expect(v.label).toBe('Couldn’t refresh');
    expect(`${v.label} ${v.detail}`).not.toMatch(/weather|service|provider|busy|429|DMI|MET/i);
  });

  it('a genuine (non-busy) failure with data present is amber "Couldn’t refresh", never red', () => {
    const v = view({ status: 'stale', providerBusy: false, lastAttemptAt: '' });
    expect(v.label).toBe('Couldn’t refresh');
    expect(v.detail).toBe('Saved forecast');
    expect(v.tone).toBe('watch');
  });

  it('a partial build names the delayed forecast source without exposing the provider cause', () => {
    const v = view({ status: 'current', degradedSources: ['water', 'waves'], providerBusy: false, lastAttemptAt: '' });
    expect(v.detail).toBe('Delayed update: marine data');

    const wavesOnly = view({ status: 'current', degradedSources: ['waves'], providerBusy: true, lastAttemptAt: '' });
    expect(wavesOnly.detail).toBe('Delayed update: waves');

    const waterOnly = view({ status: 'current', degradedSources: ['water'], providerBusy: false, lastAttemptAt: '' });
    expect(waterOnly.detail).toBe('Delayed update: water level');

    for (const detail of [v.detail, wavesOnly.detail, waterOnly.detail]) {
      expect(detail).not.toMatch(/service|provider|busy|429|retry|DMI|MET/i);
    }
  });

  it('a routine refresh is a neutral one-liner, with no second line or amber', () => {
    const v = view({ status: 'current', degradedSources: ['water', 'waves'], providerBusy: true, lastAttemptAt: '' }, true);
    expect(v).toMatchObject({ label: 'Update in progress…', detail: '', tone: 'neutral' });
  });

  it('uses one label for an active refresh, Worker preparation, and a pending build', () => {
    const health = { status: 'current', lastAttemptAt: '' } as Health;
    const states = [
      getCacheStatusView({ refreshing: true, cacheHealth: health, forecastAtLabel: '20:07' }),
      getCacheStatusView({ refreshing: false, preparing: true, cacheHealth: health, forecastAtLabel: '20:07' }),
      getCacheStatusView({ refreshing: false, cacheHealth: { status: 'pending', lastAttemptAt: '' } as Health, forecastAtLabel: '20:07' }),
    ];
    expect(states.map(({ label }) => label)).toEqual([
      'Update in progress…',
      'Update in progress…',
      'Update in progress…',
    ]);
    expect(states.map(({ tone }) => tone)).toEqual(['neutral', 'neutral', 'watch']);
  });

  it('keeps an old saved forecast honestly amber while it is being checked', () => {
    const v = getCacheStatusView({
      refreshing: true,
      cacheHealth: { status: 'stale', lastAttemptAt: '' } as Health,
      forecastAtLabel: '12:10',
      forecastAgeLabel: '8 h',
    });
    expect(v).toMatchObject({
      label: 'Update in progress…',
      detail: 'Saved forecast · 8 h old',
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
    expect(v.view.label).toBe('Saved forecast · 8 h old');
    expect(v.view.label).not.toMatch(/Couldn’t/);
    expect(v.showRefreshWarning).toBe(true);
    expect(v.forecastAgeLabel).toBe('8 h');
    expect(v.refreshFailureConfirmed).toBe(false);
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
      label: 'Update in progress…',
      detail: 'Saved forecast · 8 h old',
      tone: 'watch',
    });
    expect(result.showRefreshWarning).toBe(false);
    expect(result.expandedDetail).toMatch(/^Update in progress · Showing saved forecast from /);
    expect(result.expandedDetail.match(/Update in progress/g)).toHaveLength(1);
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
      label: 'Update in progress…',
      detail: 'Saved forecast · 20 h old',
      tone: 'watch',
    });
    expect(result.expandedDetail).toMatch(/^Update in progress · Showing saved forecast from /);
    expect(result.expandedDetail.match(/Update in progress/g)).toHaveLength(1);
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
    expect(result.refreshFailureConfirmed).toBe(true);
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
      label: 'Saved forecast · 5 min old',
      detail: '',
      tone: 'neutral',
    });
    expect(result.view.label).not.toMatch(/Couldn’t/);
    expect(result.showRefreshWarning).toBe(false);
    expect(result.refreshFailureConfirmed).toBe(false);
  });

  it('keeps the live-region sentence stable while the visible saved age advances', () => {
    const input = {
      sources: {
        fetchedAt: at(5 * 60_000),
        cacheHealth: { status: 'current', lastAttemptAt: at(5 * 60_000) },
      } as never,
      refreshing: false,
      online: true,
      workerContactedAtMs: NOW - 3 * 60 * 60_000,
      checkState: 'succeeded' as const,
    };
    const first = deriveCacheStatus({ ...input, nowMs: NOW });
    const nextMinute = deriveCacheStatus({ ...input, nowMs: NOW + 60_000 });

    expect(first.view.label).toBe('Saved forecast · 5 min old');
    expect(nextMinute.view.label).toBe('Saved forecast · 6 min old');
    expect(nextMinute.expandedDetail).toBe(first.expandedDetail);
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
    expect(offline.tone).not.toBe('neutral');
    expect(offline).not.toHaveProperty('providerBusy');
    expect(offline).not.toHaveProperty('busyServiceName');
    expect(offline.detail).toBe(
      'Saved forecast · Delayed update: marine data',
    );
    expect(offline.degradedSourceDisclosure).toBe('Delayed update: marine data');
    expect(offline.detail).not.toContain('busy');
  });

  it('keeps the delayed source in the complete offline announcement', () => {
    const result = deriveCacheStatus({
      sources: {
        fetchedAt: '2026-08-22T09:00:00.000Z',
        cacheHealth: {
          status: 'current',
          lastAttemptAt: '2026-08-22T09:01:00.000Z',
          degradedSources: ['waves'],
        },
      } as never,
      refreshing: false,
      online: false,
      nowMs: Date.parse('2026-08-22T09:05:00.000Z'),
      workerContactedAtMs: null,
      checkState: 'failed',
    });

    expect(result.expandedDetail).toContain('Offline');
    expect(result.expandedDetail).toContain('Showing saved forecast');
    expect(result.expandedDetail).toContain('Delayed update: waves');
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

  it('keeps delayed sources named and amber without exposing provider diagnostics', () => {
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
    expect(busy.detail).toBe('Delayed update: marine data');

    const wavesOnlyBusy = view({
      status: 'current',
      degradedSources: ['waves'],
      providerBusy: true,
      lastAttemptAt: '',
    });
    expect(wavesOnlyBusy.detail).toBe('Delayed update: waves');

    const waterOnlyBusy = view({
      status: 'current',
      degradedSources: ['water'],
      providerBusy: true,
      lastAttemptAt: '',
    });
    expect(waterOnlyBusy.detail).toBe('Delayed update: water level');

    const weatherBusy = view({
      status: 'current',
      degradedSources: ['weather'],
      providerBusy: true,
      lastAttemptAt: '',
    });
    expect(weatherBusy.detail).toBe('Delayed update: wind');

    const bothBusy = view({
      status: 'current',
      degradedSources: ['weather', 'water', 'waves'],
      providerBusy: true,
      lastAttemptAt: '',
    });
    expect(bothBusy.detail).toBe('Delayed update: wind + marine data');

    for (const detail of [
      busy.detail,
      wavesOnlyBusy.detail,
      waterOnlyBusy.detail,
      weatherBusy.detail,
      bothBusy.detail,
    ]) {
      expect(detail).not.toMatch(/service|provider|busy|429|retry|DMI|MET/i);
    }
  });
});

describe('per-source freshness disclosure', () => {
  const NOW = Date.parse('2026-08-24T09:00:00.000Z');
  const translateDa = (key: string, ...args: Array<string | number>) =>
    interpolate(da[key] ?? key, ...args);
  const sources = (
    degradedSources: string[],
    marineInstances?: NonNullable<Health['marineInstances']>,
    weatherLastModified: string | null = '2026-08-24T08:55:00.000Z',
  ) => ({
    fetchedAt: '2026-08-24T08:58:00.000Z',
    cacheHealth: {
      status: 'current' as const,
      lastAttemptAt: '2026-08-24T08:59:00.000Z',
      degradedSources,
      ...(weatherLastModified !== null ? { weatherLastModified } : {}),
      ...(marineInstances ? { marineInstances } : {}),
    },
  }) as Parameters<typeof deriveCacheStatus>[0]['sources'];
  const derive = (
    degradedSources: string[],
    marineInstances?: NonNullable<Health['marineInstances']>,
    weatherLastModified?: string | null,
    translate = interpolate,
  ) => deriveCacheStatus({
    sources: sources(degradedSources, marineInstances, weatherLastModified),
    refreshing: false,
    online: true,
    nowMs: NOW,
    workerContactedAtMs: NOW - 1_000,
    checkState: 'succeeded',
  }, translate);

  const marineInstances = {
    water: { collection: 'dkss_idw', id: '2026-08-23T220000Z' },
    waves: { collection: 'wam_nsb', id: '2026-08-24T080000Z' },
  };
  const degradedCases = [
    {
      name: 'water only',
      degradedSources: ['water'],
      english: 'Delayed update: water level',
      danish: 'Forsinket opdatering: vandstand',
    },
    {
      name: 'waves only',
      degradedSources: ['waves'],
      english: 'Delayed update: waves',
      danish: 'Forsinket opdatering: bølger',
    },
    {
      name: 'water and waves',
      degradedSources: ['water', 'waves'],
      english: 'Delayed update: marine data',
      danish: 'Forsinket opdatering: havdata',
    },
    {
      name: 'weather only',
      degradedSources: ['weather'],
      english: 'Delayed update: wind',
      danish: 'Forsinket opdatering: vind',
    },
    {
      name: 'weather and water',
      degradedSources: ['weather', 'water'],
      english: 'Delayed update: wind + water level',
      danish: 'Forsinket opdatering: vind + vandstand',
    },
    {
      name: 'weather and waves',
      degradedSources: ['weather', 'waves'],
      english: 'Delayed update: wind + waves',
      danish: 'Forsinket opdatering: vind + bølger',
    },
    {
      name: 'weather, water, and waves',
      degradedSources: ['weather', 'water', 'waves'],
      english: 'Delayed update: wind + marine data',
      danish: 'Forsinket opdatering: vind + havdata',
    },
  ];

  it.each(degradedCases)('renders qualitative freshness for $name', ({
    degradedSources,
    english,
    danish,
  }) => {
    const englishResult = derive(degradedSources, marineInstances);
    const danishResult = derive(degradedSources, marineInstances, undefined, translateDa);

    expect(englishResult.view.detail).toBe(english);
    expect(danishResult.view.detail).toBe(danish);
    expect(englishResult.view.degradedSourceDisclosure).toBe(englishResult.view.detail);
    expect(englishResult.view.tone).toBe('watch');
    expect(englishResult.expandedDetail).toContain(english);
    expect(danishResult.expandedDetail).toContain(danish);
    expect(englishResult.view.detail).not.toMatch(/service|provider|busy|429|retry|DMI|MET/i);
    expect(englishResult.expandedDetail).not.toMatch(/service|provider|busy|429|retry|DMI|MET/i);
  });

  it('never turns a delayed marine update into a duration or model-run claim', () => {
    const details = degradedCases
      .filter(({ degradedSources }) => degradedSources.includes('water') || degradedSources.includes('waves'))
      .flatMap(({ degradedSources }) => [
        derive(degradedSources, marineInstances).view.detail,
        derive(degradedSources, marineInstances, undefined, translateDa).view.detail,
      ]);

    for (const detail of details) {
      expect(detail).not.toMatch(/\b\d+(?:\s*(?:min|h|t|d)|[:.]\d{2})\b|\brun\b|kørsl/iu);
    }
  });

  it('does not make delayed-update copy depend on provider provenance', () => {
    const absent = derive(['water']);
    const invalid = derive(['water'], {
      water: { collection: 'dkss_idw', id: 'not-a-run' },
    });
    const future = derive(['water'], {
      water: { collection: 'dkss_idw', id: '2026-08-24T100000Z' },
    });

    for (const result of [absent, invalid, future]) {
      expect(result.view.detail).toBe('Delayed update: water level');
      expect(result.view.degradedSourceDisclosure).toBe(result.view.detail);
      expect(result.view.detail).not.toMatch(/NaN|service|provider|busy|429|retry|DMI|MET/i);
    }

    const missingWeather = derive(['weather'], marineInstances, null);
    const missingMarineForCurrentClaim = derive(['weather'], {
      water: marineInstances.water,
    });
    const invalidMarineForCurrentClaim = derive(['weather'], {
      water: marineInstances.water,
      waves: { collection: 'wam_nsb', id: 'not-a-run' },
    });
    const futureMarineForCurrentClaim = derive(['weather'], {
      water: marineInstances.water,
      waves: { collection: 'wam_nsb', id: '2026-08-24T100000Z' },
    });
    const invalidMarineInCombinedClaim = derive(['weather', 'water'], {
      water: { collection: 'dkss_idw', id: 'not-a-run' },
      waves: marineInstances.waves,
    });
    const futureMarineInCombinedClaim = derive(['weather', 'waves'], {
      water: marineInstances.water,
      waves: { collection: 'wam_nsb', id: '2026-08-24T100000Z' },
    });

    expect(missingWeather.view.detail).toBe('Delayed update: wind');
    for (const result of [
      missingMarineForCurrentClaim,
      invalidMarineForCurrentClaim,
      futureMarineForCurrentClaim,
    ]) {
      expect(result.view.detail).toBe('Delayed update: wind');
    }
    expect(invalidMarineInCombinedClaim.view.detail)
      .toBe('Delayed update: wind + water level');
    expect(futureMarineInCombinedClaim.view.detail)
      .toBe('Delayed update: wind + waves');
  });

  it('does not add a source disclosure to healthy or held-stale payloads', () => {
    const healthy = derive([], marineInstances);
    const stale = deriveCacheStatus({
      sources: {
        ...sources(['water'], marineInstances),
        cacheHealth: {
          ...sources(['water'], marineInstances).cacheHealth!,
          status: 'stale',
        },
      },
      refreshing: false,
      online: true,
      nowMs: NOW,
      workerContactedAtMs: NOW - 1_000,
      checkState: 'succeeded',
    });

    expect(healthy.view.degradedSourceDisclosure).toBe('');
    expect(healthy.view.detail).toBe('');
    expect(stale.view.degradedSourceDisclosure).toBe('');
    expect(stale.view.detail).toBe('Saved forecast · 2 min old');
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
    workerContactedAtMs: NOW,
  });

  it('refuses a timestamp implausibly far ahead of this clock', () => {
    for (const result of [
      status(new Date(NOW + 9 * 60 * 60 * 1000).toISOString()),
      status('3000-01-01T00:00:00.000Z'),
      status('not-a-date'),
    ]) {
      expect(result.showRefreshWarning).toBe(true);
      expect(result.view).toMatchObject({ label: 'Saved forecast', detail: '', tone: 'watch' });
      expect(result.expandedDetail).toBe('Saved forecast.');
      expect(`${result.view.label} ${result.expandedDetail}`).not.toMatch(/3000|Invalid|NaN|00:00/);
    }
  });

  it('tolerates ordinary skew without crying stale', () => {
    expect(status(new Date(NOW + 30_000).toISOString()).showRefreshWarning).toBe(false);
    expect(status(new Date(NOW - 60_000).toISOString()).showRefreshWarning).toBe(false);
  });
});
