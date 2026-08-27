import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TripProfilePanel from '../../src/components/TripProfilePanel';
import { LanguageProvider } from '../../src/i18n';

describe('TripProfilePanel localisation', () => {
  it('translates every visible profile label in Danish', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <LanguageProvider>
        <TripProfilePanel tripMode="default" onTripModeChange={vi.fn()} />
      </LanguageProvider>,
    );

    expect([...container.querySelectorAll('.frank-mode-label')].map((node) => node.textContent))
      .toEqual(['Rolig', 'Normal', 'Pro', 'Egen']);
  });

  it('opens a sourced About panel with the live IPP-aligned preset values', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('ffkajak_lang', 'en');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <LanguageProvider>
            <TripProfilePanel tripMode="default" onTripModeChange={vi.fn()} />
          </LanguageProvider>,
        );
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>('[aria-label="About the modes"]')!.click();
      });

      const about = host.querySelector('#trip-profile-info-pop')!;
      expect(about.textContent).toContain('Chill · IPP 2: wind Take care from 4.0 m/s and Rough from 5.0 m/s; waves Take care from 0.20 m and Rough from 0.50 m.');
      expect(about.textContent).toContain('Normal · IPP 3: wind Take care from 6.0 m/s and Rough from 8.0 m/s; waves Take care from 0.30 m and Rough from 1.00 m.');
      expect(about.textContent).toContain('Pro · IPP 4: wind Take care from 8.0 m/s and Rough from 10.0 m/s; waves Take care from 0.50 m and Rough from 2.00 m.');
      expect(about.textContent).toContain('not DKF safety limits or proof of skill');
      expect(about.textContent).toContain('Local wind sectors');
      expect(about.textContent).toContain("Chill's 4 m/s and the lower wave Take care boundaries are FRANK's conservative choices");
      expect(about.querySelector('a[href*="ipp-roeruddannelse/touring-tur"]')).not.toBeNull();
      expect(about.querySelector('a[href*="14lUb_7t5ZV1vp49sOBmCmlXuOnSWmQMX"]')).not.toBeNull();
      expect(about.querySelector('a[href*="1iagdhW-B3ZXvHUmEBSfxVESyne5qevb2"]')).not.toBeNull();
      expect(about.querySelector('a[href*="1YoO6StJ_nfwx2kb9X7lyH5y4gFQqp1O5"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
