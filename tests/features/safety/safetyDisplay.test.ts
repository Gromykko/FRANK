import { describe, expect, it } from 'vitest';
import { analyzeSafetyConditions } from '../../../src/features/safety/analyzeSafetyConditions';
import {
  getSafetyDisplay,
  hasActiveSafetyChecks,
} from '../../../src/features/safety/safetyDisplay';
import { metSymbolToWmoCode } from '../../../src/features/forecast/weatherCodes';
import { DEFAULT_SETTINGS } from '../../../src/features/safety/presets';
import type { HourlyData } from '../../../src/features/forecast/types';
import type { SafetySettings } from '../../../src/features/safety/presets';

const LIMITS_OFF = 'Personal limits are off.';

const rawSettings: SafetySettings = {
  ...DEFAULT_SETTINGS,
  enableWindSpeed: false,
  enableWindGust: false,
  enableWaveHeight: false,
  enableWaveCaution: false,
  enableWaterTemp: false,
  enableCustomWindDirs: false,
  daylightOnly: false,
};

const baseData: HourlyData = {
  time: '2026-08-12T12:00:00Z',
  tempAir: 20,
  tempWater: 18,
  windSpeed: 3,
  windGust: 4,
  windDirection: 180,
  waveHeight: 0.2,
  wavePeriod: 3,
  waveDirection: 180,
  tideLevel: 0,
  precipitation: 0,
  symbolCode: 'clearsky_day',
  weatherCode: 0,
  currentSpeed: 0,
  currentDirection: 0,
  isDay: true,
};

const withWeather = (symbolCode: string): HourlyData => ({
  ...baseData,
  symbolCode,
  weatherCode: metSymbolToWmoCode(symbolCode),
});

describe('raw-mode safety display', () => {
  it('recognises that every configurable safety check is off', () => {
    expect(hasActiveSafetyChecks(rawSettings)).toBe(false);
  });

  // These previously asserted the opposite: that weather hazards stayed
  // authoritative with every limit off. That was right while limits-off was an
  // obscure state someone unticked their way into - warn them the app had gone
  // quiet. As a mode the user deliberately chooses, it was wrong twice over: it
  // rated a calm hour 'caution', so the whole matrix went amber while nothing
  // was being judged, and it kept giving advice the user had switched off.
  //
  // The rule now: report the weather, judge nothing. The hazard survives as a
  // FACT ("Heavy rain") because that belongs on a weather display; the advice
  // clause ("probably one to skip") does not.
  it.each(['heavyrainandthunder', 'heavyrain'])(
    'reports the %s hazard as a fact and gives no verdict',
    (symbolCode) => {
      const analysis = analyzeSafetyConditions(withWeather(symbolCode), rawSettings);
      const display = getSafetyDisplay(analysis, false, LIMITS_OFF);

      expect(analysis.rating).toBe('danger');
      expect(display.rating).toBe('none');
      expect(display.reasons).toEqual([
        { text: analysis.weatherFact, severity: 'none' },
        { text: LIMITS_OFF, severity: 'none' },
      ]);
      // The advice clause must not survive into a mode that judges nothing.
      expect(display.reasons.some((r) => /skip|keeping an eye/.test(r.text))).toBe(false);
      expect(analysis.weatherFact).toBeTruthy();
    },
  );

  it('reports a weather caution as a fact and gives no verdict', () => {
    const analysis = analyzeSafetyConditions(withWeather('fog'), rawSettings);
    const display = getSafetyDisplay(analysis, false, LIMITS_OFF);

    expect(analysis.rating).toBe('caution');
    expect(display.rating).toBe('none');
    expect(display.reasons[0]).toEqual({ text: analysis.weatherFact, severity: 'none' });
  });

  it('gives no verdict at all when the raw weather is otherwise unremarkable', () => {
    const analysis = analyzeSafetyConditions(baseData, rawSettings);
    const display = getSafetyDisplay(analysis, false, LIMITS_OFF);

    expect(analysis.rating).toBe('safe');
    // Notably NOT 'caution': a calm hour used to render amber here, which is a
    // judgement about an hour nobody assessed.
    expect(display).toEqual({
      rating: 'none',
      reasons: [{ text: LIMITS_OFF, severity: 'none' }],
    });
  });

  it('keeps degraded-source status text out of the verdict reasons', () => {
    const analysis = analyzeSafetyConditions(baseData, DEFAULT_SETTINGS);
    const display = getSafetyDisplay(analysis, true, LIMITS_OFF);
    const disclosure = "Wind updated 5 min ago · water level couldn't be refreshed";

    expect(display.rating).toBe(analysis.rating);
    expect(display.reasons).toEqual(analysis.reasons);
    expect(display.reasons.some((reason) => reason.text === disclosure)).toBe(false);
  });
});
