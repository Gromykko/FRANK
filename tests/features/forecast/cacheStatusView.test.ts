import { describe, it, expect } from 'vitest';
import { getCacheStatusView, deriveCacheStatus } from '../../../src/features/forecast/cacheStatusView';
import { da } from '../../../src/i18n/da';
import { interpolate } from '../../../src/i18n/interpolate';

type Health = NonNullable<Parameters<typeof getCacheStatusView>[0]['cacheHealth']>;
const view = (cacheHealth: Partial<Health> | undefined, refreshing = false) =>
  getCacheStatusView({ refreshing, cacheHealth: cacheHealth as Health, checkedAtLabel: '20:07' });

describe('getCacheStatusView', () => {
  it('healthy cache reads a green "Checked" with the time in the label', () => {
    const v = view({ status: 'current', lastAttemptAt: '' });
    expect(v).toMatchObject({ label: 'Checked · 20:07', detail: '', tone: 'fresh' });
  });

  it('offline reads a neutral "Offline" with the saved time — never a green "Checked"', () => {
    const v = getCacheStatusView({
      refreshing: false,
      cacheHealth: { status: 'current', lastAttemptAt: '' } as Health,
      checkedAtLabel: '20:07',
      offline: true,
      savedAtLabel: '18:40',
    });
    expect(v.label).toBe('Offline');
    expect(v.detail).toBe('Showing your saved forecast from 18:40');
    expect(v.tone).toBe('neutral');
    expect(v.label).not.toMatch(/Checked/);
  });

  it('offline stays amber when the saved cache is already stale', () => {
    const v = getCacheStatusView({
      refreshing: false,
      cacheHealth: { status: 'stale', lastAttemptAt: '' } as Health,
      checkedAtLabel: '20:07',
      offline: true,
      savedAtLabel: '12:10',
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
      checkedAtLabel: '20:07',
      offline: true,
      savedAtLabel: '12:10',
    }, translateDa);
    expect(v.detail).toBe('Viser din ældre gemte prognose fra 12:10');
    expect(v.tone).toBe('watch');
  });

  it('a busy MARINE provider (no cache) is calm amber and names the service, no "hours old"', () => {
    const v = view({ status: 'stale', providerBusy: true, busyProvider: 'marine', lastAttemptAt: '' });
    expect(v.label).toBe('Waves & water service busy');
    expect(v.detail).toBe('Retrying automatically · checked 20:07');
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
    expect(v.detail).toBe('Showing earlier data · last try 20:07');
    expect(v.tone).toBe('watch');
  });

  it('a partial build stays "Checked · time" amber; the second line names data + cause', () => {
    const busy = view({ status: 'current', degradedSources: ['water', 'waves'], providerBusy: true, lastAttemptAt: '' });
    expect(busy).toMatchObject({ label: 'Checked · 20:07', tone: 'watch', partiallyDegraded: true });
    expect(busy.detail).toBe('waves & water from an earlier update · marine service busy');

    const weatherBusy = view({ status: 'current', degradedSources: ['weather'], providerBusy: true, lastAttemptAt: '' });
    expect(weatherBusy.detail).toBe('weather from an earlier update · weather service busy');

    const bothBusy = view({ status: 'current', degradedSources: ['weather', 'water', 'waves'], providerBusy: true, lastAttemptAt: '' });
    expect(bothBusy.detail).toBe('weather, waves & water from an earlier update · services busy');
  });

  it('a partial build from a non-busy error says "couldn’t refresh just now", not "busy"', () => {
    const v = view({ status: 'current', degradedSources: ['water', 'waves'], providerBusy: false, lastAttemptAt: '' });
    expect(v.detail).toBe('waves & water from an earlier update · couldn’t refresh just now');
  });

  it('a routine refresh is a neutral one-liner - "Refreshing…", no second line, no amber', () => {
    const v = view({ status: 'current', degradedSources: ['water', 'waves'], providerBusy: true, lastAttemptAt: '' }, true);
    expect(v).toMatchObject({ label: 'Refreshing…', detail: '', tone: 'neutral' });
  });

  it('keeps an old saved forecast honestly amber while it is being checked', () => {
    const v = getCacheStatusView({
      refreshing: true,
      cacheHealth: { status: 'stale', lastAttemptAt: '' } as Health,
      checkedAtLabel: '20:07',
      savedAtLabel: '12:10',
      savedAgeLabel: '8 h',
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
// deliberately coarse (persisted at most every 15 min to save KV writes, drifts
// to ~20), and deriving client honesty from it produced three separate bugs: a
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
    // status:'current' rendered as a green "Checked · 09:14" at 14:50.
    const v = derive(null);
    expect(v.view.tone).not.toBe('fresh');
    expect(v.view.label).not.toMatch(/Checked/);
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
    // precisely so this cannot render as a green "Checked".
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

  it('a fast successful check goes directly to Checked', () => {
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

    expect(result.view).toMatchObject({ label: 'Checked · 16:49', tone: 'fresh' });
    expect(result.showRefreshWarning).toBe(false);
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
