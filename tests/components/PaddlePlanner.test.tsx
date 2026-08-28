import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import PaddlePlanner from '../../src/components/PaddlePlanner';
import type { HourlyData } from '../../src/features/forecast/types';
import type { LaunchWindow } from '../../src/features/planner/findLaunchWindows';
import { LanguageProvider } from '../../src/i18n';

let host: HTMLDivElement;
let root: Root;
const originalShare = Object.getOwnPropertyDescriptor(Navigator.prototype, 'share');

const block = (time: string, windSpeed: number, waveHeight: number): HourlyData => ({
  time,
  tempAir: 18,
  tempWater: 16,
  windSpeed,
  windGust: windSpeed,
  windDirection: 180,
  waveHeight,
  wavePeriod: 3,
  waveDirection: 180,
  tideLevel: 0,
  precipitation: 0,
  symbolCode: 'clearsky_day',
  currentSpeed: 0,
  currentDirection: 0,
  isDay: true,
  isLowConfidence: true,
  blockSpanHours: 6,
});

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
  localStorage.setItem('frank_lang', 'en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalShare) {
    Object.defineProperty(Navigator.prototype, 'share', originalShare);
  } else {
    Reflect.deleteProperty(Navigator.prototype, 'share');
  }
  vi.restoreAllMocks();
});

describe('PaddlePlanner outlook ranges', () => {
  it('includes the independently safe closing endpoint in the card and share text', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: share,
    });
    const data = [
      block('2026-08-20T06:00:00Z', 2.1, 0.1),
      block('2026-08-20T12:00:00Z', 4.9, 0.4),
    ];
    const window: LaunchWindow = {
      startIndex: 0,
      // Outlook endIndex names the last block start; row 1 is its required
      // safe closing endpoint and is intentionally more severe here.
      endIndex: 0,
      duration: 6,
      lowConfidence: true,
    };

    await act(async () => {
      root.render(
        <LanguageProvider>
          <PaddlePlanner
            data={data}
            statuses={['safe', 'safe']}
            limitsOff={false}
            windows={[window]}
            warnings={[]}
            sunrises={[]}
            sunsets={[]}
            onSelectIndex={vi.fn()}
            startIndex={0}
            minDuration={2}
            nearLimitCount={0}
          />
        </LanguageProvider>,
      );
    });

    expect(host.querySelector('.tide-conditions')?.textContent)
      .toContain('2–5 m/s wind · 0.10–0.40 m waves');
    expect(host.querySelector('.tide-tag')?.textContent).toBe('outlook');
    expect(host.textContent).not.toContain('no gust forecast');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('.tide-share')!.click();
      await Promise.resolve();
    });
    expect(share).toHaveBeenCalledOnce();
    expect(share.mock.calls[0]?.[0]?.text)
      .toContain('Wind 2–5 m/s, waves 0.10–0.40 m.');

    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('.view-toggle button')]
        .find((button) => button.textContent === 'Calendar')!
        .click();
    });
    expect(host.querySelector('.gantt-bar')?.getAttribute('aria-label')).not.toContain('no gust forecast');
  });
});

// The empty state used to say "your minimum duration" without ever naming it.
describe('PaddlePlanner empty state', () => {
  const renderEmpty = async ({
    statuses = ['safe'],
    limitsOff = false,
    minDuration = 3,
    nearLimitCount = 0,
  }: {
    statuses?: Array<'safe' | 'caution' | 'danger' | 'none'>;
    limitsOff?: boolean;
    minDuration?: number;
    nearLimitCount?: number;
  } = {}) => {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <PaddlePlanner
            data={[block('2026-08-25T06:00:00Z', 3, 0.2)]}
            statuses={statuses}
            limitsOff={limitsOff}
            windows={[]}
            warnings={[]}
            sunrises={[]}
            sunsets={[]}
            onSelectIndex={vi.fn()}
            startIndex={0}
            minDuration={minDuration}
            nearLimitCount={nearLimitCount}
          />
        </LanguageProvider>,
      );
    });
    return host.querySelector('.launch-empty')?.textContent ?? '';
  };

  it('names the actual minimum duration', async () => {
    const text = await renderEmpty({ nearLimitCount: 3 });
    expect(text).toContain('never 3 hrs in a row');
    expect(text).not.toContain('water level');
    expect(text).not.toContain('continuous stretches');
  });

  it('keeps the outlook label concise when the block has no gust forecast', async () => {
    const data = [
      { ...block('2026-08-20T06:00:00Z', 2.1, 0.1), windGust: Number.NaN },
      { ...block('2026-08-20T12:00:00Z', 4.9, 0.4), windGust: Number.NaN },
    ];
    const window: LaunchWindow = {
      startIndex: 0,
      endIndex: 0,
      duration: 6,
      lowConfidence: true,
    };

    await act(async () => {
      root.render(
        <LanguageProvider>
          <PaddlePlanner
            data={data}
            statuses={['safe', 'safe']}
            limitsOff={false}
            windows={[window]}
            warnings={[]}
            sunrises={[]}
            sunsets={[]}
            onSelectIndex={vi.fn()}
            startIndex={0}
            minDuration={2}
            nearLimitCount={0}
          />
        </LanguageProvider>,
      );
    });

    expect(host.querySelector('.tide-tag')?.textContent).toBe('outlook');
    expect(host.textContent).not.toContain('gust forecast');

    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('.view-toggle button')]
        .find((button) => button.textContent === 'Calendar')!
        .click();
    });
    const bar = host.querySelector<HTMLButtonElement>('.gantt-bar');
    expect(bar?.getAttribute('aria-label')).toContain('Outlook window');
    expect(bar?.getAttribute('aria-label')).not.toContain('gust forecast');

    await act(async () => {
      bar!.click();
    });
    expect(host.querySelector('.gantt-selection-confidence')?.textContent)
      .toBe('outlook');
  });

  it('does not turn amber forecast periods into a second launch-window section', async () => {
    const text = await renderEmpty({
      statuses: ['caution'],
      minDuration: 1,
      nearLimitCount: 3,
    });

    expect(host.querySelector('.launch-panel-title')?.textContent)
      .toContain('Available Launch Windows (0)');
    expect(text).toContain('3 continuous stretches');
    expect(text).toContain('Review them in the timeline above');
    expect(host.querySelector('.near-limit-windows')).toBeNull();
    expect(host.textContent).not.toContain('Near-limit alternatives');
  });

  it('uses singular copy for one near-limit stretch', async () => {
    const text = await renderEmpty({
      statuses: ['caution'],
      minDuration: 1,
      nearLimitCount: 1,
    });

    expect(text).toContain('One continuous stretch is long enough');
    expect(text).toContain('Review it in the timeline above');
  });

  it('keeps the original generic message when no stretch comes close', async () => {
    const text = await renderEmpty({
      statuses: ['caution'],
      minDuration: 1,
      nearLimitCount: 0,
    });

    expect(text).toContain('No launch windows fit all your selected checks yet');
    expect(text).not.toContain('continuous stretch');
  });

  it('keeps the limits-off explanation ahead of a near-limit count', async () => {
    const text = await renderEmpty({
      statuses: ['caution'],
      limitsOff: true,
      minDuration: 1,
      nearLimitCount: 3,
    });

    expect(text).toContain('Your personal limits are switched off');
    expect(text).not.toContain('continuous stretches');
  });
});
