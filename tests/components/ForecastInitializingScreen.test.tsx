import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ForecastInitializingScreen from '../../src/components/ForecastInitializingScreen';
import { AVAILABLE_LOCATIONS, CURRENT_LOCATION } from '../../src/config/locations';
import type { ForecastInitializationState } from '../../src/features/forecast/useForecast';
import { LanguageProvider } from '../../src/i18n';

let host: HTMLDivElement;
let root: Root;

function initialization(): ForecastInitializationState {
  return {
    schemaVersion: 1,
    status: 'initializing',
    code: 'FORECAST_INITIALIZING',
    location: {
      id: CURRENT_LOCATION.id,
      name: CURRENT_LOCATION.name,
      areaName: CURRENT_LOCATION.areaName,
    },
    retryAfterSeconds: 600,
    nextRetryAtMs: Date.now() + 600_000,
  };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
  localStorage.setItem('ffkajak_lang', 'en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('ForecastInitializingScreen', () => {
  it('is an accessible neutral preparation state with no forecast or safety verdict', async () => {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <ForecastInitializingScreen
            initialization={initialization()}
            refreshing={false}
            online={true}
            onRetry={vi.fn()}
          />
        </LanguageProvider>,
      );
    });

    const main = host.querySelector('main');
    const heading = host.querySelector('h1');
    expect(main?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(heading?.textContent).toContain(CURRENT_LOCATION.areaName);
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('.timeline-slider-panel')).toBeNull();
    expect(host.textContent).not.toContain('Good to go');
    expect(host.textContent).not.toContain('Take care');
    expect(host.textContent).not.toContain('Rough');
  });

  it('keeps retry and every configured location operable', async () => {
    const retry = vi.fn();
    await act(async () => {
      root.render(
        <LanguageProvider>
          <ForecastInitializingScreen
            initialization={initialization()}
            refreshing={false}
            online={true}
            onRetry={retry}
          />
        </LanguageProvider>,
      );
    });

    const retryButton = host.querySelector<HTMLButtonElement>('.initialization-retry')!;
    expect(retryButton.disabled).toBe(false);
    await act(async () => retryButton.click());
    expect(retry).toHaveBeenCalledOnce();

    const locationTrigger = host.querySelector<HTMLButtonElement>('.location-switcher-btn')!;
    expect(locationTrigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(locationTrigger.textContent).toContain('preparing');
    await act(async () => locationTrigger.click());

    const options = [...host.querySelectorAll<HTMLButtonElement>('.location-switcher-option')];
    expect(options).toHaveLength(AVAILABLE_LOCATIONS.length);
    expect(options.every((option) => !option.disabled)).toBe(true);
    for (const location of AVAILABLE_LOCATIONS) {
      expect(options.some((option) => option.textContent?.includes(location.areaName))).toBe(true);
    }
    expect(host.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    expect(host.querySelector('[aria-current="true"]')?.textContent).toContain('preparing');
  });

  it('announces offline recovery and disables duplicate retry while a check is running', async () => {
    await act(async () => {
      root.render(
        <LanguageProvider>
          <ForecastInitializingScreen
            initialization={initialization()}
            refreshing
            online={false}
            onRetry={vi.fn()}
          />
        </LanguageProvider>,
      );
    });

    expect(host.textContent).toContain("You're offline");
    expect(host.querySelector('.initialization-card')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector<HTMLButtonElement>('.initialization-retry')?.disabled).toBe(true);
  });
});
