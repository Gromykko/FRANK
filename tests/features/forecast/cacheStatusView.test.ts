import { describe, it, expect } from 'vitest';
import { getCacheStatusView, deriveCacheStatus } from '../../../src/features/forecast/cacheStatusView';

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
});

// ---------------------------------------------------------------------------
// deriveCacheStatus owns the wall-clock check. getCacheStatusView above is
// pure presentation and trusts whatever status it is handed; the question
// "did we actually reach the worker?" can only be answered against the clock.
// ---------------------------------------------------------------------------
describe('deriveCacheStatus freshness', () => {
  const NOW = Date.parse('2026-08-07T14:50:00Z');
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const derive = (checkedMsAgo: number, fetchedMsAgo = checkedMsAgo, status = 'current' as const) =>
    deriveCacheStatus({
      sources: {
        fetchedAt: at(fetchedMsAgo),
        cacheHealth: { status, lastAttemptAt: at(checkedMsAgo) },
      } as never,
      refreshing: false,
      online: true,
      nowMs: NOW,
    });

  it('a recent check stays green', () => {
    expect(derive(5 * 60_000).view.tone).toBe('fresh');
  });

  it('a check far older than the worker cadence is NOT green, whatever the payload claims', () => {
    // The worker re-checks every 10 minutes. A stamp hours old means the
    // CLIENT never reached it — the browser fell back to its saved copy, which
    // still carries the last good payload's status:'current'. navigator.onLine
    // stays true behind a captive portal or a dead worker, so age is the only
    // honest test. This rendered a green "Checked · 09:14" at 14:50.
    const v = derive(5.5 * 60 * 60_000);
    expect(v.view.tone).not.toBe('fresh');
    expect(v.forecastAgeLabel).toBe('6 h');
  });

  it('past the 6-hour mark it also raises the page-level banner', () => {
    // The tone demotes as soon as the check looks unreached; the louder amber
    // banner still waits for the forecast itself to be genuinely old.
    expect(derive(5.5 * 60 * 60_000).showRefreshWarning).toBe(false);
    expect(derive(7 * 60 * 60_000).showRefreshWarning).toBe(true);
  });

  it('the boundary leaves room for the worker stamp throttle plus a skipped cron tick', () => {
    // The worker only PERSISTS its "checked" stamp every 15 min
    // (CHECKED_STAMP_MIN_WRITE_INTERVAL_MS), and writes land on a 10-min cron
    // grid — so a healthy forecast can legitimately serve a stamp ~20 min old,
    // and ~30 min old if a tick is skipped. Demoting the tone at 25 min (the
    // first version of this threshold) reported a perfectly healthy forecast as
    // "Couldn't refresh · showing older data".
    expect(derive(20 * 60_000).view.tone).toBe('fresh');
    expect(derive(35 * 60_000).view.tone).toBe('fresh');
    expect(derive(50 * 60_000).view.tone).not.toBe('fresh');
  });

  it('a genuinely fresh check on an older forecast build stays green', () => {
    // The worker checked 2 min ago and found nothing new to build. That is
    // healthy, not stale — only the CHECK age may demote the tone.
    expect(derive(2 * 60_000, 40 * 60_000).view.tone).toBe('fresh');
  });
});
