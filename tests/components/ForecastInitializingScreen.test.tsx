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

function healthResponse(availableIds: string[] = []): Response {
  const allIds = AVAILABLE_LOCATIONS.map(({ id }) => id);
  const available = allIds.filter((id) => availableIds.includes(id));
  const missing = allIds.filter((id) => !availableIds.includes(id));
  return new Response(JSON.stringify({
    service: 'frank-forecast',
    checkedAt: '2026-08-20T12:00:00.000Z',
    release: {
      allLocationsReady: available.length === allIds.length,
      ready: available,
      available,
      fallback: [],
      missing,
    },
  }), {
    status: available.length === allIds.length ? 200 : 503,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function renderScreen({
  availableIds = [],
  refreshing = false,
  online = true,
  onRetry = vi.fn(),
}: {
  availableIds?: string[];
  refreshing?: boolean;
  online?: boolean;
  onRetry?: () => void;
} = {}) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(healthResponse(availableIds)));
  await act(async () => {
    root.render(
      <LanguageProvider>
        <ForecastInitializingScreen
          initialization={initialization()}
          refreshing={refreshing}
          online={online}
          onRetry={onRetry}
        />
      </LanguageProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ForecastInitializingScreen', () => {
  it('presents zero availability as one app-wide state without a city picker or time promise', async () => {
    await renderScreen();

    const main = host.querySelector('main');
    const heading = host.querySelector('h1');
    expect(main?.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(heading?.textContent).toBe('Forecasts are being prepared');
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    expect(host.textContent).toContain('There is no complete forecast to show yet');
    expect(host.textContent).not.toContain('next check');
    expect(host.textContent).not.toContain('10 min');
    expect(host.querySelector('.location-switcher')).toBeNull();
    expect(host.querySelector('.initialization-ready')).toBeNull();
    expect(host.querySelector('.timeline-slider-panel')).toBeNull();
    expect(host.textContent).not.toContain('Good to go');
    expect(host.textContent).not.toContain('Take care');
    expect(host.textContent).not.toContain('Rough');
  });

  it('offers only complete locations during partial runtime recovery', async () => {
    const available = AVAILABLE_LOCATIONS.filter(({ id }) => id !== CURRENT_LOCATION.id).slice(0, 2);
    await renderScreen({ availableIds: available.map(({ id }) => id) });

    expect(host.querySelector('h1')?.textContent).toContain(CURRENT_LOCATION.areaName);
    const options = [...host.querySelectorAll<HTMLButtonElement>('.initialization-ready-option')];
    expect(options).toHaveLength(available.length);
    expect(options.every((option) => !option.disabled)).toBe(true);
    for (const location of available) {
      expect(options.some((option) => option.textContent?.includes(location.areaName))).toBe(true);
      expect(options.some((option) => option.textContent?.includes('ready'))).toBe(true);
    }
    expect(options.some((option) => option.textContent?.includes(CURRENT_LOCATION.areaName))).toBe(false);
    expect(host.textContent).toContain(`${available.length} of ${AVAILABLE_LOCATIONS.length} areas`);
  });

  it('keeps retry operable without pretending that it starts provider work', async () => {
    const retry = vi.fn();
    await renderScreen({ onRetry: retry });

    const retryButton = host.querySelector<HTMLButtonElement>('.initialization-retry')!;
    expect(retryButton.disabled).toBe(false);
    expect(retryButton.textContent).toBe('Check manually');
    await act(async () => retryButton.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it('announces offline recovery and disables duplicate retry while a check is running', async () => {
    await renderScreen({ refreshing: true, online: false });

    expect(host.textContent).toContain("You're offline");
    expect(host.querySelector('.initialization-card')?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector<HTMLButtonElement>('.initialization-retry')?.disabled).toBe(true);
  });
});
