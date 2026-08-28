import { describe, expect, it } from 'vitest';
import { analyzeSafetyConditions } from '../../../src/features/safety/analyzeSafetyConditions';
import {
  getSafetyDisplay,
  hasActiveSafetyChecks,
} from '../../../src/features/safety/safetyDisplay';
import { DEFAULT_SETTINGS } from '../../../src/features/safety/presets';
import type { HourlyData } from '../../../src/features/forecast/types';
import type { SafetySettings } from '../../../src/features/safety/presets';

const LIMITS_OFF = 'Personal limits are off.';

const rawSettings: SafetySettings = {
  ...DEFAULT_SETTINGS,
  enableWindSpeed: false,
  enableWindGust: false,
  enableWaveHeight: false,
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
  currentSpeed: 0,
  currentDirection: 0,
  isDay: true,
};

const withWeather = (symbolCode: string): HourlyData => ({
  ...baseData,
  symbolCode,
});

describe('raw-mode safety display', () => {
  it('recognises that every configurable safety check is off', () => {
    expect(hasActiveSafetyChecks(rawSettings)).toBe(false);
  });

  it('does not treat a stored sector preference as active when wind checking is off', () => {
    expect(hasActiveSafetyChecks({ ...rawSettings, enableCustomWindDirs: true })).toBe(false);
  });

  // This has moved twice, and the second move undid half the first. Limits-off
  // once kept weather hazards authoritative - right while it was an obscure
  // state someone unticked their way into, wrong as a mode people choose: it
  // rated a calm hour 'caution' and kept giving advice that had been switched
  // off. The fix kept the hazard as a bare FACT ("Heavy rain") and dropped only
  // the advice clause.
  //
  // Seeing it running showed the fact was redundant too. The snapshot directly
  // above already prints the same native condition beside the weather icon, so
  // the quiet mode was repeating itself and ended up noisier than the judging
  // one. Now: no verdict, no restatement - only the line explaining that limits
  // are off.
  it.each(['heavyrainandthunder', 'heavyrain'])(
    'gives no verdict and does not restate the hazard for %s',
    (symbolCode) => {
      const analysis = analyzeSafetyConditions(withWeather(symbolCode), rawSettings);
      const display = getSafetyDisplay(analysis, false, LIMITS_OFF);

      expect(analysis.rating).toBe('danger');
      expect(display.rating).toBe('none');
      expect(display.reasons).toEqual([{ text: LIMITS_OFF, severity: 'none' }]);
      // Neither the advice clause nor the bare hazard may survive here.
      expect(display.reasons.some((r) => /skip|keeping an eye|rain/i.test(r.text))).toBe(false);
    },
  );

  it('gives no verdict and no restatement for a weather caution', () => {
    const analysis = analyzeSafetyConditions(withWeather('fog'), rawSettings);
    const display = getSafetyDisplay(analysis, false, LIMITS_OFF);

    expect(analysis.rating).toBe('caution');
    expect(display.rating).toBe('none');
    expect(display.reasons).toEqual([{ text: LIMITS_OFF, severity: 'none' }]);
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
