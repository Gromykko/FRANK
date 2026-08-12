import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ForecastErrorScreen from '../../src/components/ForecastErrorScreen';

describe('ForecastErrorScreen', () => {
  it.each([
    'Could not refresh forecast data. Showing the latest cached forecast if available.',
    'The forecast came back with no hours in it.',
  ])('keeps the location escape available for: %s', (message) => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <ForecastErrorScreen message={message} onRetry={vi.fn()} />
    );

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('.error-screen-retry')?.textContent).toContain('Try Again');
    expect(container.querySelector('.error-screen-location-copy')?.textContent)
      .toBe('Or choose another location:');

    const switcher = container.querySelector<HTMLButtonElement>('.location-switcher-btn');
    expect(switcher).not.toBeNull();
    expect(switcher?.textContent).toContain('Horsens Fjord');
    expect(switcher?.getAttribute('aria-haspopup')).toBe('menu');
    expect(switcher?.getAttribute('aria-expanded')).toBe('false');
  });
});
