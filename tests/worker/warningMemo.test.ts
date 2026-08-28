import { describe, expect, it, vi } from 'vitest';
import locationData from '../../src/config/locations.json';
import { memoizedText, warningResponseText } from '../../worker/providers';
import type { EventMemo } from '../../worker/domain';

// The MeteoAlarm feed is country-wide and its URL carries no location. When
// several location builds share an invocation, fetching it once per location
// spends the subrequest budget on identical bytes exactly when warnings are
// active. The event memo must collapse all of those callers to one fetch.
describe('memoizedText', () => {
  it('fetches one body for every configured location caller', async () => {
    const memo: EventMemo = new Map();
    const fetchText = vi.fn(async () => 'feed');

    const bodies = await Promise.all(
      locationData.map(() => memoizedText('warning-feed', memo, fetchText)),
    );

    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(bodies).toEqual(Array(locationData.length).fill('feed'));
  });

  // Deliberately unlike the instance-probe memo, which retains a refusal so a
  // 429 is not re-earned per city. Warnings are advisory and fail open, so
  // retrying is cheap and hiding an active warning from three cities because
  // the first one's leg happened to fail is not a trade worth making.
  it('does not let one failure poison the rest of the tick', async () => {
    const memo: EventMemo = new Map();
    const fetchText = vi.fn()
      .mockRejectedValueOnce(new Error('feed down'))
      .mockResolvedValue('feed');

    await expect(memoizedText('warning-feed', memo, fetchText)).rejects.toThrow('feed down');
    await expect(memoizedText('warning-feed', memo, fetchText)).resolves.toBe('feed');
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct urls apart', async () => {
    const memo: EventMemo = new Map();
    const fetchText = vi.fn(async () => 'x');
    await memoizedText('cap-detail:a', memo, fetchText);
    await memoizedText('cap-detail:b', memo, fetchText);
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
});

describe('warning response cleanup', () => {
  it('awaits non-OK body cancellation before releasing the warning leg', async () => {
    let releaseCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const cancel = vi.fn(() => cancellation);
    const response = {
      ok: false,
      status: 503,
      body: { cancel },
      text: vi.fn(),
    } as unknown as Response;

    let settled = false;
    const reading = warningResponseText(response, 'MeteoAlarm feed');
    void reading.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    releaseCancellation();
    await expect(reading).rejects.toThrow('MeteoAlarm feed failed: 503');
    expect(settled).toBe(true);
  });

  it('preserves the reached HTTP error when cancellation itself rejects', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('stream already disturbed');
    });
    const response = {
      ok: false,
      status: 502,
      body: { cancel },
      text: vi.fn(),
    } as unknown as Response;

    await expect(warningResponseText(response, 'CAP detail'))
      .rejects.toThrow('CAP detail failed: 502');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
