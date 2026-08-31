import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TimelineBar from '../../src/components/TimelineBar';
import type { HourlyData } from '../../src/features/forecast/types';

const outlookBlock: HourlyData = {
  time: '2026-10-04T00:00:00Z',
  tempAir: 12,
  tempWater: 11,
  windSpeed: 3,
  windGust: Number.NaN,
  windDirection: 180,
  waveHeight: 0.1,
  wavePeriod: 3,
  waveDirection: 180,
  tideLevel: 0,
  tideLevelMin: -0.05,
  tideLevelMax: 0.05,
  precipitation: 0,
  symbolCode: 'clearsky_night',
  currentSpeed: 0,
  currentDirection: 0,
  // This is only the block's start mark, not a statement about all six hours.
  isDay: false,
  isLowConfidence: true,
  blockSpanHours: 6,
};

describe('outlook period semantics', () => {
  it('announces uncertainty but never labels the whole block Night', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <TimelineBar
        data={[outlookBlock]}
        statuses={['safe']}
        selectedIndex={0}
        onSelectIndex={vi.fn()}
        startIndex={0}
      />,
    );

    const overlay = container.querySelector('.timeline-overlay-cell');
    expect(overlay?.getAttribute('aria-label')).toContain('(Longer range, more uncertain forecast)');
    expect(overlay?.getAttribute('aria-label')).not.toContain('(Night)');
    expect(container.querySelector('.timeline-block')?.classList.contains('is-night')).toBe(false);
  });

  it('exposes one semantic timeline instead of repeating the visual matrix', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <TimelineBar
        data={[outlookBlock]}
        statuses={['safe']}
        selectedIndex={0}
        onSelectIndex={vi.fn()}
        startIndex={0}
      />,
    );

    expect(container.querySelector('.timeline-legend-col')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.timeline-track')?.getAttribute('aria-hidden')).toBe('true');
    const visualRows = [...container.querySelectorAll('.meteogram-row')];
    expect(visualRows).toHaveLength(6);
    expect(visualRows.every((row) => row.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(container.querySelector('.timeline-overlay-grid')?.getAttribute('role')).toBe('listbox');
    expect(container.querySelector('.timeline-overlay-grid')?.hasAttribute('aria-hidden')).toBe(false);
    expect(container.querySelector('.timeline-overlay-cell')?.getAttribute('aria-label'))
      .toContain('Level -5 to +5 cm');
    expect(container.querySelector('.meteogram-row[title="Water level (cm)"]')).not.toBeNull();
  });

  // The note lives behind a "?" now: it held 19% of a phone screen permanently
  // for something a user reads once. Collapsed by default, same content when opened.
  it('explains block timing without provider jargon, behind the "?"', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <TimelineBar
            data={[outlookBlock]}
            statuses={['safe']}
            selectedIndex={0}
            onSelectIndex={vi.fn()}
            startIndex={0}
          />,
        );
      });

      const toggle = host.querySelector('.outlook-note-toggle')!;
      // Short enough to survive uppercase section-label tracking at 320px;
      // the accessible name still carries the full intent.
      expect(toggle.textContent).toContain('6-hour blocks');
      expect(toggle.getAttribute('aria-label')).toBe('How to read the 6-hour blocks');
      expect(host.querySelector('#timeline-outlook-info')).toBeNull();

      await act(async () => {
        host.querySelector<HTMLButtonElement>('.outlook-note-toggle')!.click();
      });

      const note = host.querySelector('#timeline-outlook-info')?.textContent ?? '';
      expect(note).toContain('Wind and air temperature show the forecast at the start of the block.');
      expect(note).toContain('Water level: above mean');
      expect(note).toContain('green within limits');
      expect(note).toContain('red not recommended');
      expect(note).not.toContain('high water');
      expect(note).not.toMatch(/\bMET\b/);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
