import { describe, expect, it } from 'vitest';
import { analyzeSafetyConditions } from '../../../src/features/safety/analyzeSafetyConditions';
import { GUST_FACTOR, getPresetSettings } from '../../../src/features/safety/presets';
import { roundToDecimals } from '../../../src/utils/number';
import type { HourlyData } from '../../../src/features/forecast/types';
import type { SafetySettings } from '../../../src/features/safety/presets';

const benignHour: HourlyData = {
  time: '2026-07-08T12:00:00Z',
  tempAir: 20,
  tempWater: 18,
  windSpeed: 0,
  windGust: 0,
  windDirection: 180,
  waveHeight: 0,
  wavePeriod: 3,
  waveDirection: 180,
  tideLevel: 0,
  precipitation: 0,
  symbolCode: 'clearsky_day',
  currentSpeed: 0,
  currentDirection: 0,
  isDay: true,
};

const profiles = [
  ['beginner', 5.0, 0.50],
  ['default', 8.0, 1.00],
  ['pro', 10.0, 2.00],
] as const;

function generalWindOnly(mode: (typeof profiles)[number][0]): SafetySettings {
  return {
    ...getPresetSettings(mode),
    enableCustomWindDirs: false,
    enableWindGust: false,
    enableWaveHeight: false,
    enableWaterTemp: false,
    daylightOnly: false,
  };
}

function gustOnly(mode: (typeof profiles)[number][0]): SafetySettings {
  return {
    ...generalWindOnly(mode),
    enableWindGust: true,
  };
}

function wavesOnly(mode: (typeof profiles)[number][0]): SafetySettings {
  return {
    ...getPresetSettings(mode),
    enableWindSpeed: false,
    enableWindGust: false,
    enableCustomWindDirs: false,
    enableWaveHeight: true,
    enableWaterTemp: false,
    daylightOnly: false,
  };
}

describe('IPP-aligned profile boundaries', () => {
  it.each(profiles)(
    '%s general wind stays within limits up to and including %s, then fails',
    (mode, windLimit) => {
      const settings = generalWindOnly(mode);
      expect(analyzeSafetyConditions({ ...benignHour, windSpeed: windLimit - 0.1 }, settings).rating).toBe('safe');
      expect(analyzeSafetyConditions({ ...benignHour, windSpeed: windLimit }, settings).rating).toBe('safe');
      expect(analyzeSafetyConditions({ ...benignHour, windSpeed: windLimit + 0.1 }, settings).rating).toBe('danger');
    },
  );

  // The single gust maximum is the wind maximum scaled by GUST_FACTOR. Equality
  // remains within the documented "up to" profile envelope.
  it.each(profiles)(
    '%s gusts use the one wind maximum scaled by the gust factor, without an amber band',
    (mode, windLimit) => {
      const settings = gustOnly(mode);
      const gustMaximum = roundToDecimals(windLimit * GUST_FACTOR, 1);

      expect(analyzeSafetyConditions({ ...benignHour, windGust: gustMaximum - 0.1 }, settings).rating).toBe('safe');
      expect(analyzeSafetyConditions({ ...benignHour, windGust: gustMaximum }, settings).rating).toBe('safe');
      const failed = analyzeSafetyConditions({ ...benignHour, windGust: gustMaximum + 0.1 }, settings);
      expect(failed.rating).toBe('danger');
      expect(failed.reasons.find((reason) => reason.text.startsWith('Wind gusts:'))?.text).not.toContain('(');
      expect(failed.reasons.some((reason) => reason.severity === 'caution')).toBe(false);
    },
  );

  it.each(profiles)(
    '%s significant waves stay within limits up to and including %s, then fail',
    (mode, _windLimit, waveLimit) => {
      const settings = wavesOnly(mode);
      expect(analyzeSafetyConditions({ ...benignHour, waveHeight: waveLimit - 0.01 }, settings).rating).toBe('safe');
      expect(analyzeSafetyConditions({ ...benignHour, waveHeight: waveLimit }, settings).rating).toBe('safe');
      expect(analyzeSafetyConditions({ ...benignHour, waveHeight: waveLimit + 0.01 }, settings).rating).toBe('danger');
    },
  );
});
