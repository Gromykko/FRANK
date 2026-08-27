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
  ['beginner', 4.0, 5.0, 0.20, 0.50],
  ['default', 6.0, 8.0, 0.30, 1.00],
  ['pro', 8.0, 10.0, 0.50, 2.00],
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
    enableWaveCaution: true,
    enableWaterTemp: false,
    daylightOnly: false,
  };
}

describe('IPP-aligned profile boundaries', () => {
  it.each(profiles)(
    '%s general wind is green below %s, Take care at it, and Rough at %s',
    (mode, takeCareAt, roughAt) => {
      const settings = generalWindOnly(mode);
      expect(analyzeSafetyConditions({ ...benignHour, windSpeed: takeCareAt - 0.1 }, settings).rating).toBe('safe');
      expect(analyzeSafetyConditions({ ...benignHour, windSpeed: takeCareAt }, settings).rating).toBe('caution');
      expect(analyzeSafetyConditions({ ...benignHour, windSpeed: roughAt - 0.1 }, settings).rating).toBe('caution');
      expect(analyzeSafetyConditions({ ...benignHour, windSpeed: roughAt }, settings).rating).toBe('danger');
    },
  );

  // Gusts get the wind band scaled by GUST_FACTOR, not the wind band itself: a
  // mean-wind limit is written for wind that already gusts, so measuring a gust
  // against it counts the same gustiness twice. Chill 6.4/8.0, Normal 9.6/12.8,
  // Pro 12.8/16.0.
  it.each(profiles)(
    '%s gusts are judged against %s / %s scaled by the gust factor, without a Beaufort label',
    (mode, windTakeCareAt, windRoughAt) => {
      const settings = gustOnly(mode);
      const takeCareAt = roundToDecimals(windTakeCareAt * GUST_FACTOR, 1);
      const roughAt = roundToDecimals(windRoughAt * GUST_FACTOR, 1);

      // The old rule called this hour Rough; the mean wind it implies is ordinary.
      expect(analyzeSafetyConditions({ ...benignHour, windGust: windRoughAt }, settings).rating).toBe('safe');

      expect(analyzeSafetyConditions({ ...benignHour, windGust: takeCareAt - 0.1 }, settings).rating).toBe('safe');
      const caution = analyzeSafetyConditions({ ...benignHour, windGust: takeCareAt }, settings);
      expect(caution.rating).toBe('caution');
      expect(caution.reasons.find((reason) => reason.text.startsWith('Wind gusts:'))?.text).not.toContain('(');
      expect(analyzeSafetyConditions({ ...benignHour, windGust: roughAt - 0.1 }, settings).rating).toBe('caution');
      expect(analyzeSafetyConditions({ ...benignHour, windGust: roughAt }, settings).rating).toBe('danger');
    },
  );

  it.each(profiles)(
    '%s significant waves are green below %s, Take care at it, and Rough at %s',
    (mode, _windTakeCareAt, _windRoughAt, takeCareAt, roughAt) => {
      const settings = wavesOnly(mode);
      expect(analyzeSafetyConditions({ ...benignHour, waveHeight: takeCareAt - 0.01 }, settings).rating).toBe('safe');
      expect(analyzeSafetyConditions({ ...benignHour, waveHeight: takeCareAt }, settings).rating).toBe('caution');
      expect(analyzeSafetyConditions({ ...benignHour, waveHeight: roughAt - 0.01 }, settings).rating).toBe('caution');
      expect(analyzeSafetyConditions({ ...benignHour, waveHeight: roughAt }, settings).rating).toBe('danger');
    },
  );
});
