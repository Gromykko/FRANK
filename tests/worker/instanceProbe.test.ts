import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cronExecutionPolicy,
  fetchLatestInstanceForCollections,
  tickOrder,
} from '../../worker/index';

// Which DMI model run is newest is a fact about DMI, not about a fjord, and all
// four configured fjords probe the identical collection lists. Unmemoised, one
// cron tick asked DMI the same two questions eight times (~2.1s of the tick)
// against the one upstream that actively rate-limits this app.

const WATER = ['dkss_idw', 'dkss_nsbs'];
const instancesBody = (ids: string[]) => ({ instances: ids.map((id) => ({ id })) });

const originalFetch = globalThis.fetch;
let calls: string[];
let eventMemo: Map<string, Promise<unknown>>;

beforeEach(() => {
  calls = [];
  eventMemo = new Map();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const stubOk = (ids: string[]) => {
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => instancesBody(ids) };
  }) as unknown as typeof fetch;
};

describe('fetchLatestInstanceForCollections memo', () => {
  it('asks DMI once for four locations sharing a collection list', async () => {
    stubOk(['2026-08-08T060000Z', '2026-08-08T120000Z']);

    const first = fetchLatestInstanceForCollections(WATER, undefined, eventMemo);
    const second = fetchLatestInstanceForCollections(WATER, undefined, eventMemo);
    expect(second).toBe(first);

    const results = await Promise.all([
      first,
      second,
      fetchLatestInstanceForCollections(WATER, undefined, eventMemo),
      fetchLatestInstanceForCollections(WATER, undefined, eventMemo),
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
    const latest = await fetchLatestInstanceForCollections(WATER, undefined, eventMemo);
    expect(latest.id).toBe('2026-08-08T120000Z');
  });

  it('memoises a refusal too, so a 429 is not re-earned per location', async () => {
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: false, status: 429, text: async () => 'Server is busy' };
    }) as unknown as typeof fetch;

    await expect(fetchLatestInstanceForCollections(WATER, undefined, eventMemo)).rejects.toThrow();
    await expect(fetchLatestInstanceForCollections(WATER, undefined, eventMemo)).rejects.toThrow();

    // Once, not twice. A 429 means stop asking, and re-probing per location is
    // exactly the hammering that earns it. Note also that only the FIRST
    // collection was tried: rate limiting is host-wide, so cascading to the
    // fallback would just multiply load on the same busy server.
    expect(calls).toHaveLength(1);
  });

  it('never shares an I/O promise across two event memos', async () => {
    stubOk(['2026-08-08T060000Z']);
    const first = fetchLatestInstanceForCollections(WATER, undefined, new Map());
    const second = fetchLatestInstanceForCollections(WATER, undefined, new Map());
    expect(second).not.toBe(first);
    await Promise.all([first, second]);
    expect(calls).toHaveLength(2);
  });

  it('deduplicates only inside one event and keeps each event\'s timeout policy', async () => {
    stubOk(['2026-08-08T120000Z']);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const userMemo = new Map();

    await Promise.all([
      fetchLatestInstanceForCollections(WATER, { fetchTimeoutMs: 15_000 }, userMemo),
      fetchLatestInstanceForCollections(WATER, { fetchTimeoutMs: 15_000 }, userMemo),
    ]);
    await fetchLatestInstanceForCollections(WATER, { fetchTimeoutMs: 50_000 }, new Map());

    expect(calls).toHaveLength(2);
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    expect(timeoutSpy).toHaveBeenCalledWith(50_000);
  });

  it('starts no upstream stage when the event deadline is already exhausted', async () => {
    stubOk(['2026-08-08T120000Z']);

    expect(() => fetchLatestInstanceForCollections(WATER, {
      deadlineAt: Date.now(),
      fetchTimeoutMs: 15_000,
    }, new Map())).toThrow(/deadline/i);

    expect(calls).toHaveLength(0);
  });

  it('does not begin another retry after the absolute deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-20T12:00:00Z');
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: false, status: 503, text: async () => 'temporarily unavailable' };
    }) as unknown as typeof fetch;

    const pending = fetchLatestInstanceForCollections(WATER, {
      deadlineAt: Date.now() + 1_000,
      fetchTimeoutMs: 15_000,
      maxAttempts: 3,
    }, new Map());
    const assertion = expect(pending).rejects.toThrow(/deadline/i);

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A slow upstream can spend the 5-minute tick budget before the loop reaches
// the last locations. With a fixed order that starved the same fjords every
// tick for as long as the provider stayed slow.
// ---------------------------------------------------------------------------
describe('tickOrder', () => {
  const fjords = ['horsens', 'vejle', 'kolding', 'aarhus'];
  const at = (iso: string) => Date.parse(iso);

  it('advances the starting fjord by one every tick', () => {
    expect(tickOrder(at('2026-08-08T15:40:00Z'), fjords)[0]).toBe('kolding');
    expect(tickOrder(at('2026-08-08T15:50:00Z'), fjords)[0]).toBe('aarhus');
    expect(tickOrder(at('2026-08-08T16:00:00Z'), fjords)[0]).toBe('horsens');
  });

  it('keeps every fjord in the tick, just rotated', () => {
    const order = tickOrder(at('2026-08-08T15:50:00Z'), fjords);
    expect(order).toEqual(['aarhus', 'horsens', 'vejle', 'kolding']);
    expect([...order].sort()).toEqual([...fjords].sort());
  });

  it('gives each fjord the first slot equally often over a day', () => {
    const firsts = new Map<string, number>();
    for (let t = 0; t < 144; t++) {
      const first = tickOrder(at('2026-08-08T00:00:00Z') + t * 10 * 60 * 1000, fjords)[0];
      firsts.set(first, (firsts.get(first) ?? 0) + 1);
    }
    expect([...firsts.values()]).toEqual([36, 36, 36, 36]);
  });

  it('falls back to the plain order when the tick clock is unusable', () => {
    expect(tickOrder(undefined, fjords)).toEqual(fjords);
    expect(tickOrder(Number.NaN, fjords)).toEqual(fjords);
    expect(tickOrder(at('2026-08-08T15:40:00Z'), [])).toEqual([]);
  });
});

describe('cronExecutionPolicy', () => {
  it('caps an early location and preserves time for all four locations', () => {
    const now = Date.parse('2026-08-20T12:00:00Z');
    const tickDeadline = now + 5 * 60_000;

    expect(cronExecutionPolicy(now, tickDeadline, 4)).toEqual({
      deadlineAt: now + 70_000,
      hardDeadlineAt: now + 70_000,
      fetchTimeoutMs: 50_000,
      maxAttempts: 1,
      completionReserveMs: 10_000,
    });
  });

  it('shrinks both the location and fetch budgets to the remaining fair share', () => {
    const now = Date.parse('2026-08-20T12:00:00Z');
    const policy = cronExecutionPolicy(now, now + 80_000, 4);

    expect(policy).toMatchObject({
      deadlineAt: now + 20_000,
      fetchTimeoutMs: 20_000,
      maxAttempts: 1,
      completionReserveMs: 5_000,
    });
  });

  it('refuses to start a location after the tick deadline', () => {
    const now = Date.parse('2026-08-20T12:00:00Z');
    expect(cronExecutionPolicy(now, now, 4)).toBeNull();
    expect(cronExecutionPolicy(now, now + 60_000, 0)).toBeNull();
  });
});
