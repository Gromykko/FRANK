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
});
