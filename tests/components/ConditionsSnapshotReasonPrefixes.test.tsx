import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ConditionsSnapshot from '../../src/components/ConditionsSnapshot';
import { LanguageProvider } from '../../src/i18n';
import type { HourlyData } from '../../src/features/forecast/types';
import type { SafetyReason } from '../../src/features/safety/analyzeSafetyConditions';

const data: HourlyData = {
  time: '2026-08-12T13:00:00Z',
  tempAir: 18,
  precipitation: 0,
  symbolCode: 'clearsky_day',
  weatherCode: 0,
  windSpeed: 3,
  windDirection: 180,
  windGust: 4,
  waveHeight: 0.1,
  waveDirection: 180,
  wavePeriod: 3,
  tempWater: 17,
  tideLevel: 0.1,
  currentSpeed: 0,
  currentDirection: 0,
  isDay: true,
};

const reasons: SafetyReason[] = [
  { severity: 'safe', text: 'Conditions are within your limits.' },
  { severity: 'caution', text: 'Conditions need extra care.' },
  { severity: 'danger', text: 'Conditions are dangerous.' },
];

function renderReasons(danish = false) {
  const snapshot = (
    <ConditionsSnapshot
      data={data}
      weatherDesc="Clear sky"
      windDirectionLabel="180° S"
      windRotation={180}
      sunrise="05.45"
      sunset="21.04"
      reasons={reasons}
      rating="safe"
    />
  );
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    danish ? <LanguageProvider>{snapshot}</LanguageProvider> : snapshot,
  );
  return container;
}

describe('ConditionsSnapshot reason prefixes', () => {
  it('announces the visible rating words while leaving a safe reason unprefixed', () => {
    const container = renderReasons();
    const safeReason = container.querySelector('.reason-safe');
    const cautionReason = container.querySelector('.reason-caution');
    const dangerReason = container.querySelector('.reason-danger');

    expect(safeReason?.querySelector('.sr-only')?.textContent).toBe('');
    expect(cautionReason?.querySelector('.sr-only')?.textContent).toBe('Take care: ');
    expect(dangerReason?.querySelector('.sr-only')?.textContent).toBe('Rough: ');
    expect(container.querySelector('.snapshot-reasons-container')?.classList.contains('rating-safe'))
      .toBe(true);
  });

  it('localises the verdict prefixes in Danish', () => {
    const container = renderReasons(true);

    expect(container.querySelector('.reason-safe .sr-only')?.textContent).toBe('');
    expect(container.querySelector('.reason-caution .sr-only')?.textContent).toBe('Pas på: ');
    expect(container.querySelector('.reason-danger .sr-only')?.textContent).toBe('Barskt: ');
  });
});
