import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  CRON_PERIOD_MS,
  CRON_TICK_BUDGET_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
} from '../../worker/execution';
import {
  cronExecutionPolicy,
  fetchLatestInstanceForCollections,
  fetchLatestMarineInstances,
  tickOrder,
} from '../../worker/index';

// The event-local memo remains useful for duplicate same-list callers inside a
// single invocation. Cross-city evidence now lives in the shared KV manifest,
// because the cron rotates one city per invocation.

const WATER = ['dkss_idw', 'dkss_nsbs'];
const WAVES = ['wam_nsb', 'wam_dw'];
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
  it('asks DMI once for four concurrent callers sharing a collection list', async () => {
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
    // Every same-invocation caller also observes the exact same resolved run.
    expect(results.every((r) => r.id === '2026-08-08T120000Z')).toBe(true);
    expect(results[0].collection).toBe('dkss_idw');
  });

  it('picks the newest instance, not the last one listed', async () => {
    stubOk(['2026-08-08T120000Z', '2026-08-08T060000Z']);
    const latest = await fetchLatestInstanceForCollections(WATER, undefined, eventMemo);
    expect(latest.id).toBe('2026-08-08T120000Z');
  });

  it('memoises a refusal too, so duplicate callers do not re-earn a 429', async () => {
    // No Retry-After still opens the event-local provider circuit. DMI's limit
    // is host-wide, so retrying the same refusal until the provider-stage attempt
    // budget is gone can exhaust Cloudflare's whole invocation allowance.
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return {
        ok: false,
        status: 429,
        headers: new Headers(),
        text: async () => 'Server is busy',
      };
    }) as unknown as typeof fetch;

    // A single 429 is evidence of nothing. The same DMI position request has
    // been observed returning seven 429s and succeeding on the eighth, so this
    // stage spends its caller-supplied three-attempt budget first. The cron's
    // raised catalogue ceiling and whole-event arithmetic are pinned in the
    // provider budget tests; this test isolates refusal memoization.
    await expect(fetchLatestInstanceForCollections(WATER, { maxAttempts: 3 }, eventMemo)).rejects.toThrow();
    expect(calls).toHaveLength(3);

    // Once a stage has genuinely exhausted itself against a 429, the refusal is
    // treated as provider-wide and the sibling collection does not re-earn it.
    await expect(fetchLatestInstanceForCollections(WAVES, { maxAttempts: 3 }, eventMemo)).rejects.toThrow();
    expect(calls).toHaveLength(3);
  });

  // We parse Retry-After, attach it to the error and forward it to the browser.
  // Retrying anyway told the client to wait twenty minutes while we spent the
  // location's whole budget hammering the provider that had just asked to be
  // left alone - the direct route past Cloudflare's 50-subrequest ceiling,
  // which is not classified as transient and so killed the entire tick.
  it('stops retrying when the provider asks for longer than the tick is worth', async () => {
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '1200' }),
        text: async () => 'Server is busy',
      };
    }) as unknown as typeof fetch;

    await expect(fetchLatestInstanceForCollections(WATER, { maxAttempts: 3 }, eventMemo)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  // The cached promise carries the FIRST caller's ExecutionPolicy. Sharing a
  // provider refusal is the point; sharing "this caller ran out of its own
  // window" is not, because a later caller may still have time to reach DMI.
  it('shares a provider refusal but not one caller running out of budget', async () => {
    let attempts = 0;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      attempts += 1;
      if (attempts === 1) throw new Error('deadline reached for aarhus');
      return { ok: true, status: 200, json: async () => instancesBody(['2026-08-08T120000Z']) };
    }) as unknown as typeof fetch;

    await expect(
      fetchLatestInstanceForCollections(WATER, { maxAttempts: 1 }, eventMemo),
    ).rejects.toThrow();
    // The next caller gets its own attempt rather than inheriting the first's.
    await expect(
      fetchLatestInstanceForCollections(WATER, { maxAttempts: 1 }, eventMemo),
    ).resolves.toEqual({ collection: 'dkss_idw', id: '2026-08-08T120000Z' });
  });

  it('memoises in-flight probe across multiple calls in the same event', async () => {
    stubOk(['2026-08-08T120000Z']);
    const first = fetchLatestInstanceForCollections(WATER, undefined, eventMemo);
    const second = fetchLatestInstanceForCollections(WATER, undefined, eventMemo);
    expect(second).toBe(first);
    const [res1, res2] = await Promise.all([first, second]);
    expect(res1).toEqual(res2);
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

  it('uses the full candidate provider window without consuming its completion reserve', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-21T08:00:00Z');
    stubOk(['2026-08-21T000000Z']);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await fetchLatestInstanceForCollections(WATER, {
      deadlineAt: Date.now() + 24_000,
      fetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
      maxAttempts: 1,
      completionReserveMs: 4_000,
    }, new Map());

    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(20_000);
    expect(timeoutSpy).toHaveBeenCalledWith(20_000);
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
      retryDelayMs: 1_500,
    }, new Map());
    const assertion = expect(pending).rejects.toThrow(/(deadline|temporarily unavailable)/i);

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(calls).toHaveLength(1);
  });
});

describe('fetchLatestMarineInstances (split resolution)', () => {
  const location = {
    id: 'horsens',
    forecastConfigRevision: 1,
    name: 'Horsens',
    areaName: 'Horsens Fjord',
    coordinate: { longitude: 9.85, latitude: 55.86 },
    dmiCollections: {
      water: ['dkss_idw'],
      waves: ['wam_nsb'],
    },
  };

  const fallback = {
    water: { collection: 'dkss_idw', id: '2026-08-08T060000Z' },
    waves: { collection: 'wam_nsb', id: '2026-08-08T060000Z' },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-08T13:00:00Z');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves both water and waves when both endpoints succeed', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('dkss_idw')) {
        return { ok: true, status: 200, json: async () => instancesBody(['2026-08-08T120000Z']) };
      }
      return { ok: true, status: 200, json: async () => instancesBody(['2026-08-08T120000Z']) };
    }) as unknown as typeof fetch;

    const result = await fetchLatestMarineInstances(location, undefined, eventMemo, fallback);
    expect(result.instances).toEqual({
      water: { collection: 'dkss_idw', id: '2026-08-08T120000Z' },
      waves: { collection: 'wam_nsb', id: '2026-08-08T120000Z' },
    });
    // Both verified, so nothing is degraded - an unchanged id is normal, DMI
    // publishes about every six hours.
    expect(result.substituted).toEqual([]);
    expect(result.catalogueContacted).toBe(true);
  });

  it('adopts fresh water and falls back to cached waves when waves probe is busy', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('dkss_idw')) {
        return { ok: true, status: 200, json: async () => instancesBody(['2026-08-08T120000Z']) };
      }
      return { ok: false, status: 429, text: async () => 'Server is busy' };
    }) as unknown as typeof fetch;

    const result = await fetchLatestMarineInstances(location, undefined, eventMemo, fallback);
    expect(result.instances).toEqual({
      water: { collection: 'dkss_idw', id: '2026-08-08T120000Z' },
      waves: fallback.waves,
    });
    // The carried-over id must be NAMED. Returning it silently is what let a
    // DMI catalogue outage read as a fully current forecast.
    expect(result.substituted).toEqual(['waves']);
    expect(result.substitutionCauses).toEqual({ waves: 'busy' });
    expect(result.catalogueContacted).toBe(true);
  });

  it('adopts fresh waves and falls back to cached water when water probe is busy', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('dkss_idw')) {
        return { ok: false, status: 429, text: async () => 'Server is busy' };
      }
      return { ok: true, status: 200, json: async () => instancesBody(['2026-08-08T120000Z']) };
    }) as unknown as typeof fetch;

    const result = await fetchLatestMarineInstances(location, undefined, eventMemo, fallback);
    expect(result.instances).toEqual({
      water: fallback.water,
      waves: { collection: 'wam_nsb', id: '2026-08-08T120000Z' },
    });
    expect(result.substituted).toEqual(['water']);
    expect(result.substitutionCauses).toEqual({ water: 'busy' });
    expect(result.catalogueContacted).toBe(true);
  });

  it('distinguishes a valid empty catalogue from an upstream failure', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('dkss_idw')) {
        return { ok: true, status: 200, json: async () => instancesBody([]) };
      }
      return { ok: true, status: 200, json: async () => instancesBody(['2026-08-08T120000Z']) };
    }) as unknown as typeof fetch;

    const result = await fetchLatestMarineInstances(location, undefined, eventMemo, fallback);

    expect(result.substituted).toEqual(['water']);
    expect(result.substitutionCauses).toEqual({ water: 'not-ready' });
    expect(result.catalogueContacted).toBe(true);
  });

  it('keeps a generic mixed catalogue failure distinct from a verified 429', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('dkss_idw')) {
        return { ok: false, status: 503, text: async () => 'Unavailable' };
      }
      return { ok: true, status: 200, json: async () => instancesBody(['2026-08-08T120000Z']) };
    }) as unknown as typeof fetch;

    const result = await fetchLatestMarineInstances(
      location,
      { maxAttempts: 1 },
      eventMemo,
      fallback,
    );

    expect(result.substituted).toEqual(['water']);
    expect(result.substitutionCauses).toEqual({ water: 'unavailable' });
    expect(result.catalogueContacted).toBe(true);
  });

  it('does not count failed catalogue attempts as successful provider contact', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => 'Server is busy',
    })) as unknown as typeof fetch;

    const result = await fetchLatestMarineInstances(location, undefined, eventMemo, fallback);

    expect(result.substituted).toEqual(['water', 'waves']);
    expect(result.substitutionCauses).toEqual({ water: 'busy', waves: 'busy' });
    expect(result.catalogueContacted).toBe(false);
  });

  it('throws provider unavailable when both endpoints fail and no fallback is available', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => 'Server is busy',
    })) as unknown as typeof fetch;

    await expect(fetchLatestMarineInstances(location, undefined, eventMemo, undefined))
      .rejects
      .toThrow(/temporarily unavailable/i);
  });
});

// ---------------------------------------------------------------------------
// A slow upstream can consume one city's tick. Rotating the selected city keeps
// that failure from delaying the same fjord on every subsequent tick.
// ---------------------------------------------------------------------------
describe('tickOrder', () => {
  const fjords = ['horsens', 'vejle', 'kolding', 'aarhus'];
  const at = (iso: string) => Date.parse(iso);
  const tick = (iso: string, ticks: number) => at(iso) + ticks * CRON_PERIOD_MS;

  // The rotation counts ticks, so it is only fair if it counts the ticks that
  // actually happen. Moving the cron in wrangler.jsonc without moving
  // CRON_PERIOD_MS silently halves the rotation rate instead of failing.
  it('derives its tick counter from the deployed cron schedule', async () => {
    const config = await readFile('wrangler.jsonc', 'utf8');
    const cron = config.match(/"crons"\s*:\s*\[\s*"([^"]+)"/)?.[1];
    const minuteField = cron?.match(/^(\*|\*\/[1-9]\d*) \* \* \* \*$/)?.[1];
    const everyMinutes = minuteField === '*'
      ? 1
      : Number(minuteField?.slice(2));

    expect(Number.isFinite(everyMinutes)).toBe(true);
    expect(CRON_PERIOD_MS).toBe(everyMinutes * 60_000);
  });

  it('reaches every fjord within four one-minute ticks from any starting tick', () => {
    const cycleStart = '2026-08-08T15:40:00Z';
    expect(CRON_PERIOD_MS).toBe(60_000);
    expect(fjords.length * CRON_PERIOD_MS).toBe(4 * 60_000);

    for (let startingTick = 0; startingTick < fjords.length; startingTick++) {
      const reached = Array.from({ length: fjords.length }, (_, offset) =>
        tickOrder(tick(cycleStart, startingTick + offset), fjords)[0]);
      expect(new Set(reached)).toEqual(new Set(fjords));
    }
  });

  it('advances the starting fjord by one every tick', () => {
    const start = '2026-08-08T15:40:00Z';
    expect(tickOrder(tick(start, 0), fjords)[0]).toBe('horsens');
    expect(tickOrder(tick(start, 1), fjords)[0]).toBe('vejle');
    expect(tickOrder(tick(start, 2), fjords)[0]).toBe('kolding');
    expect(tickOrder(tick(start, 3), fjords)[0]).toBe('aarhus');
  });

  it('keeps every fjord in the tick, just rotated', () => {
    const order = tickOrder(tick('2026-08-08T15:40:00Z', 3), fjords);
    expect(order).toEqual(['aarhus', 'horsens', 'vejle', 'kolding']);
    expect([...order].sort()).toEqual([...fjords].sort());
  });

  it('gives each fjord the first slot equally often over a day', () => {
    const ticksPerDay = Math.round(24 * 60 * 60_000 / CRON_PERIOD_MS);
    const firsts = new Map<string, number>();
    for (let t = 0; t < ticksPerDay; t++) {
      const first = tickOrder(tick('2026-08-08T00:00:00Z', t), fjords)[0];
      firsts.set(first, (firsts.get(first) ?? 0) + 1);
    }
    expect([...firsts.values()]).toEqual(Array(fjords.length).fill(ticksPerDay / fjords.length));
  });

  it('falls back to the plain order when the tick clock is unusable', () => {
    expect(tickOrder(undefined, fjords)).toEqual(fjords);
    expect(tickOrder(Number.NaN, fjords)).toEqual(fjords);
    expect(tickOrder(at('2026-08-08T15:40:00Z'), [])).toEqual([]);
  });
});

describe('cronExecutionPolicy', () => {
  it('gives the selected city a longer cron fetch window with bounded retry depth', () => {
    const now = Date.parse('2026-08-20T12:00:00Z');
    const tickDeadline = now + CRON_TICK_BUDGET_MS;
    const policy = cronExecutionPolicy(now, tickDeadline, 1);

    expect(policy).toEqual({
      deadlineAt: tickDeadline,
      hardDeadlineAt: tickDeadline,
      fetchTimeoutMs: 50_000,
      maxAttempts: 3,
      // 50s of location budget less the 8s completion reserve leaves 42s for
      // attempts, at ~6s each = 7 that can actually finish. That binds the
      // 18-attempt position ceiling rather than the ceiling binding time.
      marineCatalogueMaxAttempts: 7,
      marinePositionMaxAttempts: 7,
      completionReserveMs: 8_000,
      retryDelayMs: undefined,
      retryBusyDelayMs: undefined,
    });
    expect(CRON_TICK_BUDGET_MS).toBe(50_000);
    // Unclamped case: the policy returns CRON_FETCH_TIMEOUT_MS verbatim, so
    // this pins the constant itself. The next test deliberately clamps lower;
    // the location's remaining share must always win. At runtime the 8-second
    // completion reserve makes every attempt share at most 42 seconds; their
    // individual 50-second caps are not additive.
    expect(policy!.fetchTimeoutMs).toBeGreaterThanOrEqual(DEFAULT_FETCH_TIMEOUT_MS);
  });

  it('shrinks both the location and fetch budgets to the remaining fair share', () => {
    const now = Date.parse('2026-08-20T12:00:00Z');
    const policy = cronExecutionPolicy(now, now + 80_000, 4);

    expect(policy).toMatchObject({
      deadlineAt: now + 20_000,
      fetchTimeoutMs: 20_000,
      // A 20s share less its 4s reserve buys 2 completable attempts, so every
      // ladder collapses to it - the fair share, not the per-stage ceiling, is
      // the binding limit.
      maxAttempts: 2,
      marineCatalogueMaxAttempts: 2,
      marinePositionMaxAttempts: 2,
      completionReserveMs: 4_000,
      retryDelayMs: undefined,
      retryBusyDelayMs: undefined,
    });
  });

  it('lets the location time budget bind the marine position cap', () => {
    const now = Date.parse('2026-08-20T12:00:00Z');
    const policy = cronExecutionPolicy(now, now + 15_000, 1);

    expect(policy).toMatchObject({
      deadlineAt: now + 15_000,
      fetchTimeoutMs: 15_000,
      // 15s buys 2 completable attempts - the point of the test is that time
      // binds the position cap, which it still does, lower down.
      maxAttempts: 2,
      marineCatalogueMaxAttempts: 2,
      marinePositionMaxAttempts: 2,
      completionReserveMs: 3_000,
    });
  });

  it('refuses to start a location after the tick deadline', () => {
    const now = Date.parse('2026-08-20T12:00:00Z');
    expect(cronExecutionPolicy(now, now, 4)).toBeNull();
    expect(cronExecutionPolicy(now, now + 60_000, 0)).toBeNull();
  });
});
