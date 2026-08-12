import { describe, expect, it } from 'vitest';
import { analyzeSafetyConditions } from '../../../src/features/safety/analyzeSafetyConditions';
import { getSafetyDisplay, hasActiveSafetyChecks } from '../../../src/features/safety/safetyDisplay';
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

  it.each(['heavyrainandthunder', 'heavyrain'])(
    'does not downgrade the analyzer danger for %s',
    (symbolCode) => {
      const analysis = analyzeSafetyConditions(withWeather(symbolCode), rawSettings);
      const display = getSafetyDisplay(analysis, false, LIMITS_OFF);

      expect(analysis.rating).toBe('danger');
      expect(display.rating).toBe('danger');
      expect(display.usesLimitsOffFallback).toBe(false);
      expect(display.reasons.slice(0, analysis.reasons.length)).toEqual(analysis.reasons);
      expect(display.reasons.at(-1)).toEqual({ text: LIMITS_OFF, severity: 'caution' });
    },
  );

  it('preserves a weather caution and its analyzer reason', () => {
    const analysis = analyzeSafetyConditions(withWeather('fog'), rawSettings);
    const display = getSafetyDisplay(analysis, false, LIMITS_OFF);

    expect(analysis.rating).toBe('caution');
    expect(display.rating).toBe('caution');
    expect(display.usesLimitsOffFallback).toBe(false);
    expect(display.reasons.slice(0, analysis.reasons.length)).toEqual(analysis.reasons);
  });

  it('keeps the generic caution when raw weather is otherwise safe', () => {
    const analysis = analyzeSafetyConditions(baseData, rawSettings);
    const display = getSafetyDisplay(analysis, false, LIMITS_OFF);

    expect(analysis.rating).toBe('safe');
    expect(display).toEqual({
      rating: 'caution',
      reasons: [{ text: LIMITS_OFF, severity: 'caution' }],
      usesLimitsOffFallback: true,
    });
  });
});
