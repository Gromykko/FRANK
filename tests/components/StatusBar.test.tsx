import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusBar from '../../src/components/StatusBar';
import { LanguageProvider } from '../../src/i18n';

describe('StatusBar status presentation', () => {
  it('keeps exact visible detail in the label and a stable sentence in the live region', () => {
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
          cacheAriaLabel="Opdaterer prognosen. Gemt prognose · 8 t gammel."
          cacheAnnouncement="Opdatering i gang. Viser gemt prognose fra 14:50."
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
    expect(announcement?.textContent).toBe('Opdatering i gang. Viser gemt prognose fra 14:50.');
    expect(document.querySelector('.frank-cache')?.getAttribute('aria-label'))
      .toBe('Opdaterer prognosen. Gemt prognose · 8 t gammel.');
  });

  // This asserted the opposite for good reason: the verdict must never hide
  // behind an animation, and a screen-reader-only verdict is not a verdict. The
  // rule still holds - what changed is WHERE it is stated. The glass now carries
  // FRANK's one-liner alone, and the verdict reads in words above the conditions
  // that produced it (ConditionsSnapshot, .snapshot-verdict), which is nearer
  // the reasoning anyway. Both remain announced here for screen readers.
  it('leaves the glass to the phrase and keeps the verdict announced', () => {
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
          cacheAnnouncement="Frisk prognose fra 14:50."
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
    // Nothing but the phrase is painted on the glass.
    expect(display?.querySelector('.frank-display-verdict')).toBeNull();
    expect(display?.querySelector('.frank-display-subtitle')).toBeNull();
    // ...but neither line is lost: both stay in the live region.
    const announced = [...(display?.querySelectorAll('.sr-only') ?? [])]
      .map((el) => el.textContent);
    expect(announced).toContain('Pas på');
    expect(announced).toContain('Hold ekstra øje');
    // The verdict still must not depend on an animation finishing.
    expect(display?.classList.contains('is-marquee')).toBe(false);
    expect(display?.querySelector('.frank-display-measure')).toBeNull();
  });

  it('keeps degraded-source detail visible in the status bar', () => {
    const detail = 'Delayed update: marine data';
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
          cacheAnnouncement={`Forecast from 14:50. ${detail}.`}
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
