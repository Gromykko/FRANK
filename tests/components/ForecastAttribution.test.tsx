import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ForecastAttribution from '../../src/components/ForecastAttribution';
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
  localStorage.setItem('ffkajak_lang', 'en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
});

async function renderAttribution(hasWarnings: boolean): Promise<void> {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <ForecastAttribution
          dmiModels="WAM, DKSS"
          areaName="Horsens Fjord"
          hasWarnings={hasWarnings}
        />
      </LanguageProvider>,
    );
  });
}

describe('ForecastAttribution', () => {
  it('shows the mandated MeteoAlarm delay disclaimer when warnings are present', async () => {
    await renderAttribution(true);

    expect(host.querySelector('.meteoalarm-delay-disclaimer')?.textContent).toBe(
      'Time delays between this website and the www.meteoalarm.org website are possible. For the most up-to-date awareness information as published by the participating National Meteorological and Hydrological Services, please refer to www.meteoalarm.org.',
    );
  });

  it('omits the MeteoAlarm delay disclaimer without warnings', async () => {
    await renderAttribution(false);

    expect(host.querySelector('.meteoalarm-delay-disclaimer')).toBeNull();
  });

  it('keeps all provider credits together in one attribution paragraph', async () => {
    await renderAttribution(true);

    const attributionParagraphs = host.querySelectorAll<HTMLParagraphElement>(
      'p.footer-text:not(.meteoalarm-delay-disclaimer)',
    );
    expect(attributionParagraphs).toHaveLength(1);

    const attribution = attributionParagraphs[0];
    expect(attribution.textContent).toContain('Weather data by MET Norway');
    expect(attribution.textContent).toContain('waves & water by DMI (WAM, DKSS) for Horsens Fjord');
    expect(attribution.textContent).toContain('Warnings by MeteoAlarm/DMI');
    expect(attribution.querySelectorAll('a[href="https://meteoalarm.org"]')).toHaveLength(1);
  });
});
