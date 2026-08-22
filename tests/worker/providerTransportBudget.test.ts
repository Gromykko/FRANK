import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_EXTERNAL_SUBREQUEST_BUDGET,
  executionPolicy,
  ExternalSubrequestBudgetError,
} from '../../worker/execution';
import { fetchJsonWithRetries } from '../../worker/providerTransport';
import type { EventMemo } from '../../worker/domain';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('event external-subrequest budget', () => {
  it('treats malformed JSON from a reached 2xx as terminal', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"incomplete":', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const eventMemo: EventMemo = new Map();
    await expect(fetchJsonWithRetries(
      'https://api.met.no/malformed',
      'malformed MET stage',
      executionPolicy({ maxAttempts: 3, retryDelayMs: 0 }),
      'weather',
      eventMemo,
    )).rejects.toBeInstanceOf(SyntaxError);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(eventMemo.externalSubrequestsStarted).toBe(1);
  });

  it('is shared by retry loops and stops fetches before the Free-plan ceiling', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('temporary provider failure', { status: 503 }));
    globalThis.fetch = fetchMock as typeof fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const eventMemo: EventMemo = new Map();
    const thirtyAttempts = executionPolicy({
      maxAttempts: 30,
      retryDelayMs: 0,
    });

    await expect(fetchJsonWithRetries(
      'https://opendataapi.dmi.dk/first',
      'first DMI stage',
      thirtyAttempts,
      'marine',
      eventMemo,
    )).rejects.toThrow(/temporarily unavailable/i);
    expect(fetchMock).toHaveBeenCalledTimes(30);

    await expect(fetchJsonWithRetries(
      'https://opendataapi.dmi.dk/second',
      'second DMI stage',
      thirtyAttempts,
      'marine',
      eventMemo,
    )).rejects.toBeInstanceOf(ExternalSubrequestBudgetError);
    expect(fetchMock).toHaveBeenCalledTimes(EVENT_EXTERNAL_SUBREQUEST_BUDGET);

    // An already-exhausted event fails synchronously at the boundary; it never
    // starts a 46th fetch while later locations unwind to their held caches.
    await expect(fetchJsonWithRetries(
      'https://opendataapi.dmi.dk/third',
      'third DMI stage',
      thirtyAttempts,
      'marine',
      eventMemo,
    )).rejects.toBeInstanceOf(ExternalSubrequestBudgetError);
    expect(fetchMock).toHaveBeenCalledTimes(EVENT_EXTERNAL_SUBREQUEST_BUDGET);
  });
});
