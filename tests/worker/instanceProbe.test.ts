import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// @ts-expect-error - the Worker is plain JS with no type declarations
import { fetchLatestInstanceForCollections, resetInstanceProbeCache } from '../../worker/index.js';

// Which DMI model run is newest is a fact about DMI, not about a fjord, and all
// four configured fjords probe the identical collection lists. Unmemoised, one
// cron tick asked DMI the same two questions eight times (~2.1s of the tick)
// against the one upstream that actively rate-limits this app.

const WATER = ['dkss_idw', 'dkss_nsbs'];
const instancesBody = (ids: string[]) => ({ instances: ids.map((id) => ({ id })) });

const originalFetch = globalThis.fetch;
let calls: string[];

beforeEach(() => {
  resetInstanceProbeCache();
  calls = [];
});
afterEach(() => { globalThis.fetch = originalFetch; });

const stubOk = (ids: string[]) => {
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => instancesBody(ids) };
  }) as unknown as typeof fetch;
};

describe('fetchLatestInstanceForCollections memo', () => {
  it('asks DMI once for four locations sharing a collection list', async () => {
    stubOk(['2026-08-08T060000Z', '2026-08-08T120000Z']);

    const results = await Promise.all([
      fetchLatestInstanceForCollections(WATER),
      fetchLatestInstanceForCollections(WATER),
      fetchLatestInstanceForCollections(WATER),
      fetchLatestInstanceForCollections(WATER),
    ]);

    expect(calls).toHaveLength(1);
    // And every location lands on the same run, which is the other half of the
    // point: DMI publishing mid-loop used to leave some fjords on the new run
    // and some on the old, which reads in /health as a fault it is not.
    expect(results.every((r) => r.id === '2026-08-08T120000Z')).toBe(true);
    expect(results[0].collection).toBe('dkss_idw');
  });

  it('picks the newest instance, not the last one listed', async () => {
    stubOk(['2026-08-08T120000Z', '2026-08-08T060000Z']);
    const latest = await fetchLatestInstanceForCollections(WATER);
    expect(latest.id).toBe('2026-08-08T120000Z');
  });

  it('memoises a refusal too, so a 429 is not re-earned per location', async () => {
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: false, status: 429, text: async () => 'Server is busy' };
    }) as unknown as typeof fetch;

    await expect(fetchLatestInstanceForCollections(WATER)).rejects.toThrow();
    await expect(fetchLatestInstanceForCollections(WATER)).rejects.toThrow();

    // Once, not twice. A 429 means stop asking, and re-probing per location is
    // exactly the hammering that earns it. Note also that only the FIRST
    // collection was tried: rate limiting is host-wide, so cascading to the
    // fallback would just multiply load on the same busy server.
    expect(calls).toHaveLength(1);
  });

  it('starts asking again once the memo has expired', async () => {
    stubOk(['2026-08-08T060000Z']);
    await fetchLatestInstanceForCollections(WATER);
    resetInstanceProbeCache();                    // stands in for the 60s TTL
    await fetchLatestInstanceForCollections(WATER);
    expect(calls).toHaveLength(2);
  });
});
