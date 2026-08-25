import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ConditionsSnapshot from '../../src/components/ConditionsSnapshot';
import { LanguageProvider } from '../../src/i18n';
import type { HourlyData } from '../../src/features/forecast/types';

const baseData: HourlyData = {
  time: '2026-08-12T13:00:00Z',
  tempAir: 23.4,
  precipitation: 0,
  symbolCode: 'heavyrainandthunder_day',
  weatherCode: 99,
  windSpeed: 25.5,
  windDirection: 272,
  windGust: 35,
  waveHeight: 0.13,
  waveDirection: 270,
  wavePeriod: 3,
  tempWater: 17.5,
  tideLevel: 0.22,
  currentSpeed: 0,
  currentDirection: 0,
  isDay: true,
};

const props = {
  data: baseData,
  weatherDesc: 'Thunderstorm with heavy hail',
  windDirectionLabel: '272° W',
  windRotation: 272,
  sunrise: '05.45',
  sunset: '21.04',
  reasons: [{ severity: 'danger' as const, text: 'Thunderstorm with heavy hail.' }],
  rating: 'danger' as const,
};

function renderSnapshot(danish = false) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    danish
      ? <LanguageProvider><ConditionsSnapshot {...props} /></LanguageProvider>
      : <ConditionsSnapshot {...props} />
  );
  return container;
}

describe('ConditionsSnapshot', () => {
  it('keeps the four measurement pairs in four semantic ledger rows', () => {
    const container = renderSnapshot();
    const rows = [...container.querySelectorAll('.snapshot-row')];

    expect(container.querySelector('.snapshot')?.classList.contains('is-outlook')).toBe(false);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.querySelectorAll(':scope > .snapshot-cell')).toHaveLength(2);
    }
    expect(rows[3].querySelector('.snapshot-sun')).not.toBeNull();
    expect(rows[3].textContent).toContain('+22 cm');
    expect(rows[3].textContent).toContain('05.45');
    expect(rows[3].textContent).toContain('21.04');
  });

  it('shows compact phone copy while retaining complete accessible wording', () => {
    const container = renderSnapshot();

    expect(container.querySelector('.snapshot-weather-compact')?.textContent)
      .toBe('Thunder/hail');
    expect(container.querySelector('.snapshot-weather-full')?.textContent)
      .toBe('Thunderstorm with heavy hail');
    expect(container.querySelector('.snapshot-desc .sr-only')?.textContent)
      .toBe('Thunderstorm with heavy hail');
    expect(container.querySelector('.snapshot-gust-full')?.textContent).toBe('gusts 35.0');
    expect(container.querySelector('.snapshot-gust-compact')?.textContent).toBe('gust 35.0');
    expect(container.querySelector('.snapshot-wind > .sr-only')?.textContent)
      .toBe('25.5 m/s, gusts 35.0');
  });

  it('localises the compact labels rather than falling back to clipped English', () => {
    const container = renderSnapshot(true);

    expect(container.querySelector('.snapshot-weather-compact')?.textContent)
      .toBe('Torden/hagl');
    expect([...container.querySelectorAll('.snapshot-label')].map((el) => el.textContent))
      .toContain('Niveau');
    expect(container.querySelector('.snapshot-gust-full')?.textContent).toBe('vindstød 35.0');
    expect(container.querySelector('.snapshot-gust-compact')?.textContent).toBe('stød 35.0');
    expect([...container.querySelectorAll('.snapshot-context-label')].map((el) => el.textContent))
      .toEqual(['Retning', 'Dagslys']);
  });

  it('keeps outlook ranges and daylight in the same four-row structure', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <ConditionsSnapshot
        {...props}
        data={{
          ...baseData,
          blockSpanHours: 6,
          windSpeed: 4.3,
          windSpeedP90: 5.0,
          windGust: Number.NaN,
          waveHeightMin: 0.12,
          waveHeightMax: 0.25,
          tempWaterMin: 17.4,
          tempWaterMax: 18.1,
          tideLevelMin: -0.31,
          tideLevelMax: 0.39,
          windGustMax: Number.NaN,
        }}
      />
    );

    expect(container.querySelectorAll('.snapshot-row')).toHaveLength(4);
    expect(container.querySelector('.snapshot')?.classList.contains('is-outlook')).toBe(true);
    expect([...container.querySelectorAll('.snapshot-context-label')].map((el) => el.textContent))
      .toEqual(['Direction', 'Daylight']);
    expect(container.querySelector('.snapshot-grid')?.textContent).toContain('0.12–0.25 m');
    expect(container.querySelector('.snapshot-grid')?.textContent).toContain('17.4–18.1°C');
    expect(container.querySelector('.snapshot-grid')?.textContent).toContain('-31 to +39 cm');
    expect(container.querySelector('.snapshot-sun')?.textContent).toContain('05.45');
    expect(container.querySelector('.snapshot-wind > .sr-only')?.textContent)
      .toBe('4.3 m/s, gusts –');
    // The note says the outlook is less certain and stops there. It used to
    // append MET's 90th-percentile wind, which is an uncertainty estimate at the
    // block START rather than a period maximum - a distinction that needs a
    // paragraph to explain and that the wind column beside it already answers
    // honestly. The p90 stays on the model; it is simply not shown.
    const note = container.querySelector('.snapshot-lowconf-note')?.textContent ?? '';
    expect(note).toContain('Long range outlook');
    expect(note).not.toContain('percentile');
    expect(note).not.toContain('maximum');
    expect(note).not.toMatch(/\d/);
  });

  it('does not turn a whole outlook period into night styling from its start mark', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <ConditionsSnapshot
        {...props}
        weatherDesc="Clear"
        data={{
          ...baseData,
          weatherCode: 0,
          symbolCode: 'clearsky_night',
          isDay: false,
          isLowConfidence: true,
          blockSpanHours: 6,
        }}
      />,
    );

    const icon = container.querySelector('.weather-widget-icon');
    expect(icon?.classList.contains('sun-spin')).toBe(true);
    expect(icon?.classList.contains('moon-pulse')).toBe(false);
  });

  it('renders an unknown finite WMO code as unavailable rather than sunny', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
      <ConditionsSnapshot
        {...props}
        weatherDesc="Unknown"
        data={{ ...baseData, weatherCode: 4 }}
      />,
    );

    const icon = container.querySelector('.weather-widget-icon');
    expect(icon?.classList.contains('sun-spin')).toBe(false);
    expect(icon?.querySelector('.lucide-cloud-off')).not.toBeNull();
  });
});
