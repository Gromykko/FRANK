import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusBar from '../../src/components/StatusBar';
import { LanguageProvider } from '../../src/i18n';

describe('StatusBar status presentation', () => {
  it('renders the changing cache sentence as an atomic polite status', () => {
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <StatusBar
          rating="safe"
          phrase="Fjorden ser rolig ud"
          srTitle="Godkendt"
          srSubtitle="Hav en god tur"
          location="Horsens"
          sourceLabel="Opdaterer…"
          cacheDetail=""
          cacheClass="neutral"
          cacheAriaLabel="Opdaterer prognosen."
          refreshing
          onRefresh={vi.fn()}
          themeMode="light"
          themeTitle="Skift til mørkt tema"
          onToggleTheme={vi.fn()}
        />
      </LanguageProvider>,
    );

    const document = new DOMParser().parseFromString(html, 'text/html');
    const announcement = document.querySelector('[role="status"][aria-atomic="true"]');
    expect(announcement?.textContent).toBe('Opdaterer prognosen.');
  });

  it('shows the explicit verdict without a marquee or screen-reader-only fallback', () => {
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <StatusBar
          rating="caution"
          phrase="Hold øje med vinden"
          srTitle="Pas på"
          srSubtitle="Hold ekstra øje"
          location="Horsens"
          sourceLabel="Opdateret"
          cacheDetail=""
          cacheClass="fresh"
          cacheAriaLabel="Frisk prognose."
          refreshing={false}
          onRefresh={vi.fn()}
          themeMode="light"
          themeTitle="Skift til mørkt tema"
          onToggleTheme={vi.fn()}
        />
      </LanguageProvider>,
    );

    const document = new DOMParser().parseFromString(html, 'text/html');
    const display = document.querySelector('.frank-display');
    expect(display?.querySelector('.frank-display-verdict')?.textContent).toBe('Pas på');
    expect(display?.querySelector('.frank-display-subtitle')?.textContent).toBe('Hold ekstra øje');
    expect(display?.querySelector('.sr-only')).toBeNull();
    expect(display?.classList.contains('is-marquee')).toBe(false);
    expect(display?.querySelector('.frank-display-measure')).toBeNull();
  });

  it('keeps degraded-source detail visible in the status bar', () => {
    const detail = "Wind updated 5 min ago · marine data couldn't be refreshed";
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <StatusBar
          rating="caution"
          phrase="Hold øje med vinden"
          srTitle="Pas på"
          srSubtitle="Hold ekstra øje"
          location="Horsens"
          sourceLabel="Degraded"
          cacheDetail={detail}
          cacheClass="watch"
          cacheAriaLabel={`Degraded. ${detail}.`}
          refreshing={false}
          onRefresh={vi.fn()}
          themeMode="light"
          themeTitle="Skift til mørkt tema"
          onToggleTheme={vi.fn()}
        />
      </LanguageProvider>,
    );

    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('.frank-cache-detail')?.textContent).toBe(detail);
  });
});
