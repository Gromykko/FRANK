import { describe, expect, it } from 'vitest';
import { analyzeSafetyConditions } from '../../../src/features/safety/analyzeSafetyConditions';
import {
  GUST_FACTOR,
  getNearLimitThreshold,
  getPresetSettings,
} from '../../../src/features/safety/presets';
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
  {
    mode: 'beginner',
    windMaximum: 5.0,
    windCautionAt: 4.0,
    gustMaximum: 8.0,
    gustCautionAt: 6.4,
    waveMaximum: 0.50,
    waveCautionAt: 0.40,
    onshoreMaximum: 7.5,
    onshoreCautionAt: 6.0,
  },
  {
    mode: 'default',
    windMaximum: 8.0,
    windCautionAt: 6.4,
    gustMaximum: 12.8,
    gustCautionAt: 10.2,
    waveMaximum: 1.00,
    waveCautionAt: 0.80,
    onshoreMaximum: 8.0,
    onshoreCautionAt: 6.4,
  },
  {
    mode: 'pro',
    windMaximum: 10.0,
    windCautionAt: 8.0,
    gustMaximum: 16.0,
    gustCautionAt: 12.8,
    waveMaximum: 2.00,
    waveCautionAt: 1.60,
    onshoreMaximum: 9.0,
    onshoreCautionAt: 7.2,
  },
] as const;

type JudgedMode = (typeof profiles)[number]['mode'];

function generalWindOnly(mode: JudgedMode): SafetySettings {
  return {
    ...getPresetSettings(mode),
    enableCustomWindDirs: false,
    enableWindGust: false,
    enableWaveHeight: false,
    enableWaterTemp: false,
    daylightOnly: false,
  };
}

function gustOnly(mode: JudgedMode): SafetySettings {
  return {
    ...generalWindOnly(mode),
    enableWindGust: true,
  };
}

function wavesOnly(mode: JudgedMode): SafetySettings {
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

function onshoreSectorOnly(mode: JudgedMode): SafetySettings {
  return {
    ...generalWindOnly(mode),
    // Keep the general wind rule out of the way so this exercises only the
    // enabled local-sector maximum for the easterly 45-135 degree sector.
    windLimit: 100,
    enableCustomWindDirs: true,
  };
}

function expectNearLimit(result: ReturnType<typeof analyzeSafetyConditions>) {
  expect(result.rating).toBe('caution');
  expect(result.reasons).toHaveLength(1);
  expect(result.reasons[0]).toMatchObject({
    severity: 'caution',
    kind: 'near-limit',
  });
}

function expectAboveMaximum(result: ReturnType<typeof analyzeSafetyConditions>) {
  expect(result.rating).toBe('danger');
  expect(result.reasons).toHaveLength(1);
  expect(result.reasons[0]).toMatchObject({ severity: 'danger' });
  expect(result.reasons[0].kind).toBeUndefined();
}

describe('judged profile maximum boundaries', () => {
  it.each(profiles)(
    '$mode general wind is green below $windCautionAt, amber through $windMaximum, then red',
    ({ mode, windMaximum, windCautionAt }) => {
      const settings = generalWindOnly(mode);

      const below = analyzeSafetyConditions(
        { ...benignHour, windSpeed: windCautionAt - 0.1 },
        settings,
      );
      expect(below.rating).toBe('safe');
      expect(below.reasons.some((reason) => reason.kind === 'near-limit')).toBe(false);

      const atCaution = analyzeSafetyConditions(
        { ...benignHour, windSpeed: windCautionAt },
        settings,
      );
      expectNearLimit(atCaution);
      expect(atCaution.reasons[0].text).toContain(
        `${(windMaximum - windCautionAt).toFixed(1)} m/s below your maximum of ${windMaximum.toFixed(1)} m/s`,
      );

      const atMaximum = analyzeSafetyConditions(
        { ...benignHour, windSpeed: windMaximum },
        settings,
      );
      expectNearLimit(atMaximum);
      expect(atMaximum.reasons[0].text).toContain(`At your maximum of ${windMaximum.toFixed(1)} m/s`);

      const above = analyzeSafetyConditions(
        { ...benignHour, windSpeed: windMaximum + 0.1 },
        settings,
      );
      expectAboveMaximum(above);
      expect(above.reasons[0].text).toContain(`Above your maximum of ${windMaximum.toFixed(1)} m/s`);
    },
  );

  // Gusts keep one derived maximum rather than adding a second setting. They
  // use the same green / automatic caution / danger contract as mean wind.
  it.each(profiles)(
    '$mode gusts are green below $gustCautionAt, amber through $gustMaximum, then red',
    ({ mode, windMaximum, gustMaximum, gustCautionAt }) => {
      const settings = gustOnly(mode);
      expect(roundToDecimals(windMaximum * GUST_FACTOR, 1)).toBe(gustMaximum);
      expect(getNearLimitThreshold(gustMaximum, 1)).toBe(gustCautionAt);

      const below = analyzeSafetyConditions(
        { ...benignHour, windGust: gustCautionAt - 0.1 },
        settings,
      );
      expect(below.rating).toBe('safe');
      expect(below.reasons.some((reason) => reason.kind === 'near-limit')).toBe(false);

      const atCaution = analyzeSafetyConditions(
        { ...benignHour, windGust: gustCautionAt },
        settings,
      );
      expectNearLimit(atCaution);
      expect(atCaution.reasons[0].text).toContain(
        `${(gustMaximum - gustCautionAt).toFixed(1)} m/s below the ${gustMaximum.toFixed(1)} m/s maximum`,
      );

      const atMaximum = analyzeSafetyConditions(
        { ...benignHour, windGust: gustMaximum },
        settings,
      );
      expectNearLimit(atMaximum);
      expect(atMaximum.reasons[0].text).toContain(
        `At the ${gustMaximum.toFixed(1)} m/s maximum derived from your wind limit`,
      );

      const above = analyzeSafetyConditions(
        { ...benignHour, windGust: gustMaximum + 0.1 },
        settings,
      );
      expectAboveMaximum(above);
      expect(above.reasons[0].text).toContain(
        `Above the ${gustMaximum.toFixed(1)} m/s maximum derived from your wind limit`,
      );
      expect(above.reasons[0].text).not.toContain('(');
    },
  );

  it.each(profiles)(
    '$mode waves are green below $waveCautionAt, amber through $waveMaximum, then red',
    ({ mode, waveMaximum, waveCautionAt }) => {
      const settings = wavesOnly(mode);

      const below = analyzeSafetyConditions(
        { ...benignHour, waveHeight: waveCautionAt - 0.01 },
        settings,
      );
      expect(below.rating).toBe('safe');
      expect(below.reasons.some((reason) => reason.kind === 'near-limit')).toBe(false);

      const atCaution = analyzeSafetyConditions(
        { ...benignHour, waveHeight: waveCautionAt },
        settings,
      );
      expectNearLimit(atCaution);
      expect(atCaution.reasons[0].text).toContain(
        `${(waveMaximum - waveCautionAt).toFixed(2)} m below your maximum of ${waveMaximum.toFixed(2)} m`,
      );

      const atMaximum = analyzeSafetyConditions(
        { ...benignHour, waveHeight: waveMaximum },
        settings,
      );
      expectNearLimit(atMaximum);
      expect(atMaximum.reasons[0].text).toContain(`At your maximum of ${waveMaximum.toFixed(2)} m`);

      const above = analyzeSafetyConditions(
        { ...benignHour, waveHeight: waveMaximum + 0.01 },
        settings,
      );
      expectAboveMaximum(above);
      expect(above.reasons[0].text).toContain(`Above your maximum of ${waveMaximum.toFixed(2)} m`);
    },
  );

  it.each(profiles)(
    '$mode enabled local-sector wind is green below $onshoreCautionAt, amber through $onshoreMaximum, then red',
    ({ mode, onshoreMaximum, onshoreCautionAt }) => {
      const settings = onshoreSectorOnly(mode);

      const below = analyzeSafetyConditions(
        { ...benignHour, windDirection: 90, windSpeed: onshoreCautionAt - 0.1 },
        settings,
      );
      expect(below.rating).toBe('safe');
      expect(below.reasons.some((reason) => reason.kind === 'near-limit')).toBe(false);

      const atCaution = analyzeSafetyConditions(
        { ...benignHour, windDirection: 90, windSpeed: onshoreCautionAt },
        settings,
      );
      expectNearLimit(atCaution);
      expect(atCaution.reasons[0].text).toContain(
        `${(onshoreMaximum - onshoreCautionAt).toFixed(1)} m/s below your ${onshoreMaximum.toFixed(1)} m/s maximum for this direction`,
      );

      const atMaximum = analyzeSafetyConditions(
        { ...benignHour, windDirection: 90, windSpeed: onshoreMaximum },
        settings,
      );
      expectNearLimit(atMaximum);
      expect(atMaximum.reasons[0].text).toContain(
        `at your ${onshoreMaximum.toFixed(1)} m/s maximum for this direction`,
      );

      const above = analyzeSafetyConditions(
        { ...benignHour, windDirection: 90, windSpeed: onshoreMaximum + 0.1 },
        settings,
      );
      expectAboveMaximum(above);
      expect(above.reasons[0].text).toContain(
        `above your ${onshoreMaximum.toFixed(1)} m/s maximum for this direction`,
      );
    },
  );
});
