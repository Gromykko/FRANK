import { describe, it, expect } from 'vitest';
import { shouldPersistFailureState } from '../../worker/index';

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
