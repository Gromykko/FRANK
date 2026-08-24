import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WarningStripe from '../../src/components/WarningStripe';
import type { WeatherWarning } from '../../src/features/forecast/types';
import { LanguageProvider } from '../../src/i18n';

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-12T10:00:00+02:00'));
  localStorage.setItem('ffkajak_lang', 'en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  vi.useRealTimers();
});

const warning: WeatherWarning = {
  event: 'Wind',
  colour: 'orange',
  areaDesc: 'Østjylland',
  sent: '2026-07-12T05:30:00+02:00',
  effective: '2026-07-12T06:45:00+02:00',
  expires: '2026-07-12T18:00:00+02:00',
  url: 'https://www.dmi.dk/varsler',
};

async function renderWarning(value: WeatherWarning): Promise<void> {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <WarningStripe warnings={[value]} />
      </LanguageProvider>,
    );
  });
}

describe('WarningStripe issue time', () => {
  it('shows CAP sent time in the visible period and accessible label', async () => {
    await renderWarning(warning);

    expect(host.querySelector('.warning-stripe-meta')?.textContent).toBe('until 18:00 · issued 05:30');
    expect(host.querySelector('.warning-stripe')?.getAttribute('aria-label')).toContain('until 18:00 · issued 05:30');
    expect(host.textContent).not.toContain('issued 06:45');
  });

  it('falls back to effective for legacy warnings without sent', async () => {
    const legacyWarning = { ...warning };
    delete legacyWarning.sent;

    await renderWarning(legacyWarning);

    expect(host.querySelector('.warning-stripe-meta')?.textContent).toBe('until 18:00 · issued 06:45');
    expect(host.querySelector('.warning-stripe')?.getAttribute('aria-label')).toContain('until 18:00 · issued 06:45');
  });
});
