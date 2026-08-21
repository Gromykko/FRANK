import { describe, it, expect } from 'vitest';
import { healthChanged, shouldPersistFailureState, withCronAttempt } from '../../worker/index';

// The KV write budget is 1,000/day for the whole app. This predicate is what
// stands between a provider outage and an emptied allowance: a stale cache
// shortens the refresh gate, public reads need no auth, and
// the refresh button has no client-side throttle, so ~100 kayakers tapping
// refresh during an outage used to cost 3 writes/min/location.
//
// It has to stay honest in the other direction too: a failure that has CHANGED
// is the only signal /status and the client get, so throttling that would hide
// an outage instead of an idle repeat.

const THROTTLE_WINDOW_MS = 25 * 60 * 1000;
const NOW = Date.parse('2026-08-08T12:00:00Z');
const stampedAgo = (ms: number) => new Date(NOW - ms).toISOString();

const failure = (over: Record<string, unknown> = {}) => ({
  status: 'stale',
  message: 'Provider partly unavailable',
  needsRebuild: false,
  providerBusy: true,
  // The real shape: each side is {collection, id}, and marineInstancesEqual
  // compares both fields. A bare string here compares undefined to undefined
  // and passes as "equal" no matter what run it names.
  marineInstances: {
    water: { collection: 'dkss_idw', id: '2026-08-08T06:00:00Z' },
    waves: { collection: 'wam_dw', id: '2026-08-08T06:00:00Z' },
  },
  lastAttemptAt: stampedAgo(20 * 1000),
  ...over,
});

describe('shouldPersistFailureState', () => {
  it('writes the first failure, when there is no stamp to compare', () => {
    expect(shouldPersistFailureState(undefined, failure(), NOW)).toBe(true);
    expect(shouldPersistFailureState(failure({ lastAttemptAt: undefined }), failure(), NOW)).toBe(true);
  });

  it('skips an identical repeat inside the throttle window', () => {
    // The hammering case: same verdict, stamped 20 seconds ago.
    expect(shouldPersistFailureState(failure(), failure(), NOW)).toBe(false);
  });

  it('writes an identical repeat once the window has passed', () => {
    const prev = failure({ lastAttemptAt: stampedAgo(THROTTLE_WINDOW_MS + 1000) });
    expect(shouldPersistFailureState(prev, failure(), NOW)).toBe(true);
  });

  it('writes immediately when the failure itself has changed', () => {
    // Each of these is something a reader would act on differently.
    expect(shouldPersistFailureState(failure(), failure({ status: 'current' }), NOW)).toBe(true);
    expect(shouldPersistFailureState(failure(), failure({ message: 'something else' }), NOW)).toBe(true);
    expect(shouldPersistFailureState(failure(), failure({ needsRebuild: true }), NOW)).toBe(true);
    expect(shouldPersistFailureState(failure(), failure({ providerBusy: false }), NOW)).toBe(true);
  });

  it('writes when a new marine run appeared, even mid-failure', () => {
    // The new instance id is what a later tick uses to know a rebuild is owed;
    // losing it to the throttle would strand the cache on the old run.
    const next = failure({
      marineInstances: {
        water: { collection: 'dkss_idw', id: '2026-08-08T12:00:00Z' },
        waves: { collection: 'wam_dw', id: '2026-08-08T06:00:00Z' },
      },
    });
    expect(shouldPersistFailureState(failure(), next, NOW)).toBe(true);
  });

  it('treats absent and false as the same flag, not as a change', () => {
    const prev = failure({ needsRebuild: false, providerBusy: undefined });
    const next = failure({ needsRebuild: undefined, providerBusy: undefined });
    expect(shouldPersistFailureState(prev, next, NOW)).toBe(false);
  });

  it('does not treat an unparseable stored stamp as fresh', () => {
    const prev = failure({ lastAttemptAt: 'not a date' });
    expect(shouldPersistFailureState(prev, failure(), NOW)).toBe(true);
  });
});

// The other half of the same budget problem. Because the stamp above is
// deliberately throttled, the payload's "we checked" time can trail reality by
// the whole throttle window, which is why the app used to have no honest way to
// tell a user it checked five minutes ago. The cron heartbeat carries that fact
// for every city in one shared object, so it costs one write per tick instead
// of one per city per tick.
//
// The trap this guards: it is tempting to just stamp Date.now() onto the
// response. That reads as "checked just now" forever on a Worker whose cron has
// silently stopped firing, which is the exact failure the heartbeat exists to
// expose.
describe('withCronAttempt', () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const payload = (lastAttemptAt: string) => ({
    sources: { cacheHealth: { status: 'current', lastAttemptAt } },
  } as unknown as Parameters<typeof withCronAttempt>[0]);
  const beat = (locations: Record<string, string>) => ({
    schemaVersion: 1,
    lastTickAt: at(0),
    locations,
  });

  const attemptOf = (data: unknown) =>
    (data as { sources: { cacheHealth: { lastAttemptAt: string } } })
      .sources.cacheHealth.lastAttemptAt;

  it('serves the heartbeat time when the throttled payload stamp is older', () => {
    const result = withCronAttempt(
      payload(at(THROTTLE_WINDOW_MS)),
      'horsens',
      beat({ horsens: at(3 * 60 * 1000) }),
    );
    expect(attemptOf(result)).toBe(at(3 * 60 * 1000));
  });

  it('never moves a stamp backwards', () => {
    const fresh = at(60 * 1000);
    const result = withCronAttempt(payload(fresh), 'horsens', beat({ horsens: at(9 * 60 * 1000) }));
    expect(attemptOf(result)).toBe(fresh);
  });

  // A tick that runs out of budget breaks before the tail of the rotation, so
  // those cities are absent from the heartbeat and must not inherit its time.
  it('leaves a city the tick never reached alone', () => {
    const stale = at(THROTTLE_WINDOW_MS);
    const result = withCronAttempt(payload(stale), 'aarhus', beat({ horsens: at(0) }));
    expect(attemptOf(result)).toBe(stale);
  });

  // A clock fault must not blank the label this whole mechanism exists to fill:
  // a negative age renders as an empty string in the header.
  it('refuses a stamp from the future', () => {
    const stale = at(THROTTLE_WINDOW_MS);
    const result = withCronAttempt(
      payload(stale),
      'horsens',
      beat({ horsens: new Date(NOW + 60 * 60 * 1000).toISOString() }),
      NOW,
    );
    expect(attemptOf(result)).toBe(stale);
  });

  it('leaves the payload alone when there is no heartbeat at all', () => {
    const stale = at(THROTTLE_WINDOW_MS);
    expect(attemptOf(withCronAttempt(payload(stale), 'horsens', null))).toBe(stale);
  });
});

// This predicate replaced an age-based write ("restamp every 25 minutes"), so
// it is now the only thing standing between the cron and ~57 wasted writes per
// city per day. Too eager and the heartbeat's own 288/day stops paying for
// itself; too lax and a real change to what the health says never reaches
// storage at all.
describe('healthChanged', () => {
  const base = {
    status: 'current' as const,
    lastAttemptAt: '2026-08-08T12:00:00.000Z',
    degradedSources: ['weather', 'water'],
  };

  it('ignores the timestamp, which the heartbeat carries instead', () => {
    expect(healthChanged(base, { ...base, lastAttemptAt: '2026-08-08T12:25:00.000Z' }))
      .toBe(false);
  });

  it('still spends a write when the health actually says something new', () => {
    expect(healthChanged(base, { ...base, status: 'stale' })).toBe(true);
    expect(healthChanged(base, { ...base, message: 'DMI is busy' })).toBe(true);
    expect(healthChanged(base, { ...base, degradedSources: ['weather'] })).toBe(true);
  });

  // degradedSources is assembled per provider, so its order carries no meaning.
  it('does not pay for a reshuffle that says nothing', () => {
    expect(healthChanged(base, { ...base, degradedSources: ['water', 'weather'] }))
      .toBe(false);
  });

  it('treats appearing and disappearing as a change', () => {
    expect(healthChanged(null, base)).toBe(true);
    expect(healthChanged(base, null)).toBe(true);
    expect(healthChanged(null, null)).toBe(false);
  });
});
