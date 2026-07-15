import { describe, it, expect } from 'vitest';
import { getCacheStatusView } from '../../../src/features/forecast/cacheStatusView';

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
