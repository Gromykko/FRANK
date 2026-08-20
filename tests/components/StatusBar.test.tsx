import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusBar from '../../src/components/StatusBar';
import { LanguageProvider } from '../../src/i18n';

describe('StatusBar refresh announcements', () => {
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
});
