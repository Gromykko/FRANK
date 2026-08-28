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

const hour = (time: string, windSpeed: number, waveHeight: number): HourlyData => ({
  ...block(time, windSpeed, waveHeight),
  isLowConfidence: false,
  blockSpanHours: undefined,
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
          />
        </LanguageProvider>,
      );
    });

    expect(host.querySelector('.tide-conditions')?.textContent)
      .toContain('2–5 m/s wind · 0.10–0.40 m waves');
    expect(host.querySelector('.tide-tag')?.textContent).toBe('outlook · more uncertain forecast');
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
  const renderEmpty = async () => {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <PaddlePlanner
            data={[block('2026-08-25T06:00:00Z', 3, 0.2)]}
            statuses={['safe']}
            limitsOff={false}
            windows={[]}
            warnings={[]}
            sunrises={[]}
            sunsets={[]}
            onSelectIndex={vi.fn()}
            startIndex={0}
            minDuration={3}
          />
        </LanguageProvider>,
      );
    });
    return host.querySelector('.launch-empty')?.textContent ?? '';
  };

  it('names the actual minimum duration', async () => {
    const text = await renderEmpty();
    expect(text).toContain('never 3 hrs in a row');
    expect(text).not.toContain('water level');
  });

  it('names missing gusts only when an outlook window actually lacks them', async () => {
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
          />
        </LanguageProvider>,
      );
    });

    expect(host.querySelector('.tide-tag')?.textContent).toBe('outlook · no gust forecast');
    expect(host.textContent).toContain('Longer-range outlook — no gust forecast and more uncertain.');

    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('.view-toggle button')]
        .find((button) => button.textContent === 'Calendar')!
        .click();
    });
    const bar = host.querySelector<HTMLButtonElement>('.gantt-bar');
    expect(bar?.getAttribute('aria-label')).toContain('no gust forecast');

    await act(async () => {
      bar!.click();
    });
    expect(host.querySelector('.gantt-selection-confidence')?.textContent)
      .toBe('No gust forecast · more uncertain forecast');
  });
});

describe('PaddlePlanner near-limit alternatives', () => {
  it('keeps the green count strict and opens the first amber sample for review', async () => {
    const onSelectIndex = vi.fn();
    const data = [
      hour('2026-08-25T06:00:00Z', 3, 0.2),
      hour('2026-08-25T07:00:00Z', 6.4, 0.2),
      hour('2026-08-25T08:00:00Z', 3, 0.2),
    ];
    const greenWindow: LaunchWindow = {
      startIndex: 0,
      endIndex: 2,
      duration: 2,
    };
    const nearLimitWindow: LaunchWindow = {
      startIndex: 0,
      endIndex: 2,
      duration: 2,
      kind: 'near-limit',
      reviewIndex: 1,
    };

    await act(async () => {
      root.render(
        <LanguageProvider>
          <PaddlePlanner
            data={data}
            analyses={[
              { rating: 'safe', reasons: [] },
              {
                rating: 'caution',
                reasons: [{
                  severity: 'caution',
                  kind: 'near-limit',
                  text: 'Wind speed: 6.4 m/s. 1.6 m/s below your maximum of 8.0 m/s.',
                }],
              },
              { rating: 'safe', reasons: [] },
            ]}
            statuses={['safe', 'caution', 'safe']}
            limitsOff={false}
            windows={[greenWindow]}
            nearLimitWindows={[nearLimitWindow]}
            warnings={[]}
            sunrises={[]}
            sunsets={[]}
            onSelectIndex={onSelectIndex}
            startIndex={0}
            minDuration={1}
          />
        </LanguageProvider>,
      );
    });

    expect(host.querySelector('.launch-panel-title')?.textContent)
      .toContain('Available Launch Windows (1)');
    expect(host.querySelectorAll('.tide-row')).toHaveLength(1);
    expect(host.querySelectorAll('.near-limit-window')).toHaveLength(1);
    expect(host.querySelector('.near-limit-windows')?.textContent)
      .toContain('Check before launch (1)');
    expect(host.querySelector('.near-limit-windows')?.textContent)
      .toContain('These periods are not green launch windows.');
    expect(host.querySelector('.near-limit-window-details')?.textContent)
      .toContain('1.6 m/s below your maximum of 8.0 m/s');
    expect(host.querySelector('.near-limit-window')?.textContent)
      .toContain('Open this period in the full forecast.');
    expect(host.querySelector('.near-limit-window')?.textContent)
      .not.toContain('Open the first near-limit period');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('.near-limit-window')!.click();
    });
    expect(onSelectIndex).toHaveBeenLastCalledWith(1);

    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('.view-toggle button')]
        .find((button) => button.textContent === 'Calendar')!
        .click();
    });
    // The amber alternative remains in its own section. It does not become a
    // second green Gantt bar when the view changes.
    expect(host.querySelectorAll('.gantt-bar')).toHaveLength(1);
    expect(host.querySelectorAll('.near-limit-window')).toHaveLength(1);
  });

  it('labels a longer-range amber alternative as an outlook and reviews its closing sample', async () => {
    const onSelectIndex = vi.fn();
    const data = [
      { ...block('2026-08-25T06:00:00Z', 3, 0.2), windGust: Number.NaN },
      { ...block('2026-08-25T12:00:00Z', 3, 0.8), windGust: Number.NaN },
    ];
    const nearLimitWindow: LaunchWindow = {
      startIndex: 0,
      endIndex: 0,
      duration: 6,
      lowConfidence: true,
      kind: 'near-limit',
      reviewIndex: 1,
    };

    await act(async () => {
      root.render(
        <LanguageProvider>
          <PaddlePlanner
            data={data}
            analyses={[
              { rating: 'safe', reasons: [] },
              {
                rating: 'caution',
                reasons: [{
                  severity: 'caution',
                  kind: 'near-limit',
                  text: 'Wave height: 0.80 m. 0.20 m below your maximum of 1.00 m.',
                }],
              },
            ]}
            statuses={['safe', 'caution']}
            limitsOff={false}
            windows={[]}
            nearLimitWindows={[nearLimitWindow]}
            warnings={[]}
            sunrises={[]}
            sunsets={[]}
            onSelectIndex={onSelectIndex}
            startIndex={0}
            minDuration={1}
          />
        </LanguageProvider>,
      );
    });

    expect(host.querySelector('.launch-panel-title')?.textContent)
      .toContain('Available Launch Windows (0)');
    expect(host.querySelector('.near-limit-window .tide-tag')?.textContent)
      .toBe('outlook · no gust forecast');
    expect(host.querySelector('.near-limit-window-details')?.textContent)
      .toContain('0.20 m below your maximum of 1.00 m');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('.near-limit-window')!.click();
    });
    expect(onSelectIndex).toHaveBeenLastCalledWith(1);
  });
});
