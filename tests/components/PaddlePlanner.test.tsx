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
