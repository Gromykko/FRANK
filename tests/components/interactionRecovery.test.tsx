import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomSelect from '../../src/components/CustomSelect';
import LocationSwitcher from '../../src/components/LocationSwitcher';
import TimelineBar from '../../src/components/TimelineBar';
import type { HourlyData } from '../../src/features/forecast/types';
import { LanguageProvider } from '../../src/i18n';

let host: HTMLDivElement;
let root: Root;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
  if (originalScrollTo) {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  }
  vi.restoreAllMocks();
});

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  });
}

describe('popup focus recovery', () => {
  it('returns focus to the location trigger after selecting the current city', async () => {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <LocationSwitcher label="Horsens" />
        </LanguageProvider>,
      );
    });

    const trigger = host.querySelector<HTMLButtonElement>('.location-switcher-btn')!;
    await click(trigger);
    const current = host.querySelector<HTMLButtonElement>('.location-switcher-option[aria-current="true"]')!;
    expect(document.activeElement).toBe(current);

    await click(current);
    expect(host.querySelector('.location-switcher-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the custom-select trigger after a pointer selection', async () => {
    function Example() {
      const [value, setValue] = useState('one');
      return (
        <CustomSelect
          value={value}
          onChange={setValue}
          options={[
            { value: 'one', label: 'One' },
            { value: 'two', label: 'Two' },
          ]}
          ariaLabel="Example"
        />
      );
    }

    await act(async () => root.render(<Example />));
    const trigger = host.querySelector<HTMLButtonElement>('.custom-select-trigger')!;
    trigger.focus();
    await click(trigger);
    const option = host.querySelectorAll<HTMLButtonElement>('.custom-select-option')[1];
    option.focus(); // Model a browser moving focus on pointer-down.

    await click(option);
    expect(host.querySelector('.custom-select-dropdown')).toBeNull();
    expect(trigger.textContent).toContain('Two');
    expect(document.activeElement).toBe(trigger);
  });

  it('uses only primary-button timeline drags and restores text selection on release', async () => {
    const hour: HourlyData = {
      time: '2026-08-20T12:00:00Z',
      tempAir: 18,
      tempWater: 16,
      windSpeed: 3,
      windGust: 4,
      windDirection: 180,
      waveHeight: 0.1,
      wavePeriod: 3,
      waveDirection: 180,
      tideLevel: 0,
      precipitation: 0,
      symbolCode: 'clearsky_day',
      weatherCode: 0,
      currentSpeed: 0,
      currentDirection: 0,
      isDay: true,
    };
    await act(async () => {
      root.render(
        <LanguageProvider>
          <TimelineBar data={[hour]} statuses={['safe']} selectedIndex={0} onSelectIndex={vi.fn()} startIndex={0} />
        </LanguageProvider>,
      );
    });

    const timeline = host.querySelector<HTMLElement>('.scrollable-timeline')!;
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 100 });

    await act(async () => {
      timeline.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, clientX: 10, clientY: 10 }));
    });
    expect(timeline.style.userSelect).toBe('');

    await act(async () => {
      timeline.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    });
    expect(timeline.style.userSelect).toBe('none');

    await act(async () => {
      timeline.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    });
    expect(timeline.style.userSelect).toBe('');
    expect(timeline.style.cursor).toBe('grab');

    const tabs = host.querySelector<HTMLElement>('.timeline-day-tabs')!;
    await act(async () => {
      tabs.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10 }));
    });
    expect(tabs.style.userSelect).toBe('none');
    await act(async () => {
      tabs.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 10 }));
    });
    expect(tabs.style.userSelect).toBe('');
    expect(tabs.style.scrollSnapType).toBe('x mandatory');
  });
});
