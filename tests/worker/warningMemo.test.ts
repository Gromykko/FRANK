import { describe, expect, it, vi } from 'vitest';
import { memoizedText } from '../../worker/providers';
import type { EventMemo } from '../../worker/domain';

// The MeteoAlarm feed is country-wide and its URL carries no location, but it
// was fetched once per city, and DK004 covers three of the four. With the CAP
// details behind it that reached ~28 of the ~45 usable subrequests in a tick,
// spent re-fetching identical bytes - and spent hardest exactly when warnings
// are active, which is when the app matters most. Past Cloudflare's ceiling the
// error is not classified as transient, so it takes the whole tick down.
describe('memoizedText', () => {
  it('fetches one body for every city in the tick', async () => {
    const memo: EventMemo = new Map();
    const fetchText = vi.fn(async () => 'feed');

    const bodies = await Promise.all(
      ['aarhus', 'horsens', 'kolding', 'vejle'].map(
        () => memoizedText('warning-feed', memo, fetchText),
      ),
    );

    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(bodies).toEqual(['feed', 'feed', 'feed', 'feed']);
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
