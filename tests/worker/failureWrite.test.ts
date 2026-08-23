import { describe, it, expect } from 'vitest';
import locationData from '../../src/config/locations.json';
import {
  CRON_HEARTBEAT_THROTTLE_TICKS,
  assertHeartbeatThrottleCoprime,
  healthChanged,
  isCronHeartbeat,
  isHeartbeatMemoFresh,
  shouldPersistFailureState,
  withCronAttempt,
} from '../../worker/index';

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

  // Direction, not mere difference. A provider that alternates 429/200 tick to
  // tick - DMI's documented behaviour under load - used to write on every
  // single transition: 360/day/city and 1,440/day across four cities against a
  // 1,000/day allowance. The first thing that breaks when the cap is reached is that the REBUILD write
  // is swallowed, so the app freezes on an old forecast still labelled current.
  it('writes immediately when conditions get worse', () => {
    const healthy = failure({ status: 'current', degradedSources: [], providerBusy: false, message: undefined });
    expect(shouldPersistFailureState(healthy, failure(), NOW)).toBe(true);
    expect(shouldPersistFailureState(failure(), failure({ needsRebuild: true }), NOW)).toBe(true);
    expect(shouldPersistFailureState(
      failure({ degradedSources: ['water'] }),
      failure({ degradedSources: ['water', 'waves'] }),
      NOW,
    )).toBe(true);
  });

  it('orders status before secondary flags without scalar collisions', () => {
    const flaggedCurrent = failure({
      status: 'current',
      degradedSources: ['weather', 'water', 'waves'],
      providerBusy: true,
      message: undefined,
    });
    const plainStale = failure({
      status: 'stale',
      degradedSources: [],
      providerBusy: false,
      message: undefined,
    });

    // The old additive score ranked current+four flags above plain stale and
    // throttled this real status degradation.
    expect(shouldPersistFailureState(flaggedCurrent, plainStale, NOW)).toBe(true);
  });

  it('orders needsRebuild before lower-priority flag counts at one status', () => {
    const manyDegraded = failure({
      needsRebuild: false,
      degradedSources: ['weather', 'water', 'waves'],
    });
    const rebuildRequired = failure({
      needsRebuild: true,
      degradedSources: [],
    });

    expect(shouldPersistFailureState(manyDegraded, rebuildRequired, NOW)).toBe(true);
  });

  // A premature all-clear is the dangerous direction; a late one is not. So
  // recovery waits for the same window an idle repeat does, which is what caps
  // a flapping provider at one write per window instead of one per tick.
  it('throttles recovery instead of paying for every flap', () => {
    expect(shouldPersistFailureState(failure(), failure({ status: 'current' }), NOW)).toBe(false);
    expect(shouldPersistFailureState(failure(), failure({ providerBusy: false }), NOW)).toBe(false);

    const stale = failure({ lastAttemptAt: stampedAgo(THROTTLE_WINDOW_MS + 1000) });
    expect(shouldPersistFailureState(stale, failure({ status: 'current' }), NOW)).toBe(true);
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

describe('heartbeat memo freshness', () => {
  it('rejects a memo entry whose insertion time is ahead of the current clock', () => {
    expect(isHeartbeatMemoFresh(NOW + 1, NOW)).toBe(false);
    expect(isHeartbeatMemoFresh(NOW, NOW)).toBe(true);
  });
});

describe('heartbeat schema and cadence guard', () => {
  it('rejects an unrecognised heartbeat schema instead of partially reading it', () => {
    expect(isCronHeartbeat({
      schemaVersion: 3,
      lastTickAt: new Date(NOW).toISOString(),
      locations: { horsens: stampedAgo(60_000) },
      unreachable: {},
    })).toBe(false);
  });

  it('keeps the heartbeat throttle coprime with the location rotation', () => {
    expect(() => assertHeartbeatThrottleCoprime(
      CRON_HEARTBEAT_THROTTLE_TICKS,
      locationData.length,
    )).not.toThrow();
    expect(() => assertHeartbeatThrottleCoprime(
      CRON_HEARTBEAT_THROTTLE_TICKS,
      5,
    )).toThrow(/must be coprime/);
  });
});

// The other half of the same budget problem. Because the stamp above is
// deliberately throttled, the payload's "we checked" time can trail reality by
// the whole throttle window, which is why the app used to have no honest way to
// tell a user it checked recently. The cron heartbeat carries that fact in one
// shared object, with its own roughly-five-minute write throttle instead of one
// payload write per city per tick.
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
  const beat = (
    locations: Record<string, string>,
    unreachable: Record<string, string> = {},
    lastTickAt = at(0),
  ) => ({
    schemaVersion: 2 as const,
    lastTickAt,
    locations,
    unreachable,
  });

  const attemptOf = (data: unknown) =>
    (data as { sources: { cacheHealth: { lastAttemptAt: string } } })
      .sources.cacheHealth.lastAttemptAt;

  it('uses the fresh app-wide tick when this city has a recorded healthy success', () => {
    const result = withCronAttempt(
      payload(at(THROTTLE_WINDOW_MS)),
      'horsens',
      beat({ horsens: at(15 * 60 * 1000) }, {}, at(60 * 1000)),
    );
    expect(attemptOf(result)).toBe(at(60 * 1000));
    expect(result.sources.cronHeartbeat?.lastTickAt).toBe(at(60 * 1000));
  });

  it('keeps the older city success visible after a more recent unsuccessful tick', () => {
    const result = withCronAttempt(
      payload(at(THROTTLE_WINDOW_MS)),
      'horsens',
      beat(
        { horsens: at(15 * 60 * 1000) },
        { horsens: at(4 * 60 * 1000) },
        at(60 * 1000),
      ),
    );
    expect(attemptOf(result)).toBe(at(15 * 60 * 1000));
    expect(result.sources.cronHeartbeat).toBeUndefined();
  });

  it('pins an anomalous city to its last success even if failure state was stamped later', () => {
    const result = withCronAttempt(
      payload(at(2 * 60 * 1000)),
      'horsens',
      beat(
        { horsens: at(15 * 60 * 1000) },
        { horsens: at(4 * 60 * 1000) },
        at(60 * 1000),
      ),
    );
    expect(attemptOf(result)).toBe(at(15 * 60 * 1000));
    expect(result.sources.cronHeartbeat).toBeUndefined();
  });

  it('fails closed when success and failure have the same timestamp', () => {
    const sameTick = at(4 * 60 * 1000);
    const result = withCronAttempt(
      payload(at(THROTTLE_WINDOW_MS)),
      'horsens',
      beat({ horsens: sameTick }, { horsens: sameTick }, at(60 * 1000)),
    );
    expect(attemptOf(result)).toBe(sameTick);
    expect(result.sources.cronHeartbeat).toBeUndefined();
  });

  it('allows a later successful city tick to supersede an older failure', () => {
    const result = withCronAttempt(
      payload(at(THROTTLE_WINDOW_MS)),
      'horsens',
      beat(
        { horsens: at(3 * 60 * 1000) },
        { horsens: at(8 * 60 * 1000) },
        at(60 * 1000),
      ),
    );
    expect(attemptOf(result)).toBe(at(60 * 1000));
    expect(result.sources.cronHeartbeat?.lastTickAt).toBe(at(60 * 1000));
  });

  it('never moves a stamp backwards', () => {
    const fresh = at(60 * 1000);
    const older = at(9 * 60 * 1000);
    const result = withCronAttempt(payload(fresh), 'horsens', beat({ horsens: older }, {}, older));
    expect(attemptOf(result)).toBe(fresh);
  });

  // A tick that runs out of budget breaks before the tail of the rotation, so
  // those cities are absent from the heartbeat and must not inherit its time.
  it('leaves a city the tick never reached alone', () => {
    const stale = at(THROTTLE_WINDOW_MS);
    const result = withCronAttempt(payload(stale), 'aarhus', beat({ horsens: at(0) }));
    expect(attemptOf(result)).toBe(stale);
    expect(result.sources.cronHeartbeat).toBeUndefined();
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
