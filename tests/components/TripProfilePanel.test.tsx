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
      .toEqual(['Begynder', 'Øvet', 'Avanceret', 'Egen']);
  });

  it('opens a sourced About panel with the live IPP-aligned preset values', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('frank_lang', 'en');
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
      expect(about.textContent).toContain('Beginner · IPP 2: maximum mean wind 5.0 m/s; maximum significant waves 0.50 m.');
      expect(about.textContent).toContain('Intermediate · IPP 3: maximum mean wind 8.0 m/s; maximum significant waves 1.00 m.');
      expect(about.textContent).toContain('Advanced · IPP 4: maximum mean wind 10.0 m/s; maximum significant waves 2.00 m.');
      expect(about.textContent).toContain('not DKF safety guarantees or proof of skill');
      expect(about.textContent).toContain('Optional local wind sectors');
      expect(about.textContent).toContain('training and assessment conditions, not guaranteed safe conditions');
      expect(about.textContent).not.toContain('Take care from');
      expect(about.textContent).not.toContain('Rough from');
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
