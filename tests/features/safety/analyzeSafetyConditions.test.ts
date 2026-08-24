import { describe, it, expect } from 'vitest';
import { formatReading } from '../../../src/utils/number';
import {
  analyzeSafetyConditions,
  getWaveHeightLabel,
  getWindSpeedLabel,
  resolveSectors,
} from '../../../src/features/safety/analyzeSafetyConditions';
import { metSymbolToWmoCode } from '../../../src/features/forecast/weatherCodes';
import { CURRENT_LOCATION } from '../../../src/config/locations';
import { da } from '../../../src/i18n/da';
import { interpolate } from '../../../src/i18n/interpolate';
import type { HourlyData } from '../../../src/features/forecast/types';
import type { SafetySettings } from '../../../src/features/safety/presets';

const baseSettings = {
  maxWindSpeedSafe: 5,
  maxWindSpeedCaution: 8,
  minWaterTempSafe: 15,
  minWaterTempCaution: 10,
  maxWaveHeightSafe: 0.5,
  maxWaveHeightCaution: 1.0,
  gustMargin: 3,
  waveCautionMargin: 0.5,
  enableWindSpeed: true,
  enableWindGust: true,
  enableWaveHeight: true,
  enableWaveCaution: true,
  enableWaterTemp: true,
  daylightOnly: true,
} as SafetySettings;

const baseData: HourlyData = {
  time: '2026-07-08T12:00:00Z',
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

describe('analyzeSafetyConditions', () => {
  it('returns safe for ideal conditions', () => {
    const result = analyzeSafetyConditions(baseData, baseSettings);
    expect(result.rating).toBe('safe');
  });

  it('flags caution when wind speed exceeds safe limit', () => {
    const data = { ...baseData, windSpeed: 6 };
    const result = analyzeSafetyConditions(data, baseSettings);
    expect(result.rating).toBe('caution');
  });

  it('flags danger when wind speed exceeds caution limit', () => {
    const data = { ...baseData, windSpeed: 9 };
    const result = analyzeSafetyConditions(data, baseSettings);
    expect(result.rating).toBe('danger');
  });

  it('does not apply the outlook percentile contract to an exact-hour row', () => {
    const exact = analyzeSafetyConditions(
      { ...baseData, windSpeed: 4.3, windSpeedP90: 20 },
      baseSettings,
    );
    expect(exact.rating).toBe('safe');
    expect(exact.reasons.some((item) => item.text.includes('90th-percentile'))).toBe(false);
  });

  it('rates the weather condition from the MET symbol_code', () => {
    // Mirror normalize.ts: weatherCode is ALWAYS derived from the symbol
    // (NaN when the symbol is unrecognised). A fixture that pairs a symbol
    // with an unrelated code tests a row the pipeline can never produce.
    const withSymbol = (symbolCode: string) => ({ ...baseData, symbolCode, weatherCode: metSymbolToWmoCode(symbolCode) });
    // Thunder -> danger
    expect(analyzeSafetyConditions(withSymbol('heavyrainandthunder'), baseSettings).rating).toBe('danger');
    // Heavy rain -> danger
    expect(analyzeSafetyConditions(withSymbol('heavyrain'), baseSettings).rating).toBe('danger');
    // Moderate rain -> caution
    expect(analyzeSafetyConditions(withSymbol('rain'), baseSettings).rating).toBe('caution');
    // Light rain -> safe (minor for kayaking)
    expect(analyzeSafetyConditions(withSymbol('lightrain_day'), baseSettings).rating).toBe('safe');
    // Fog -> caution
    expect(analyzeSafetyConditions(withSymbol('fog'), baseSettings).rating).toBe('caution');
    // Snow -> caution
    expect(analyzeSafetyConditions(withSymbol('snow'), baseSettings).rating).toBe('caution');
    // Clear -> safe
    expect(analyzeSafetyConditions(withSymbol('clearsky_night'), baseSettings).rating).toBe('safe');
  });

  it('falls back to the WMO weather_code when no symbol_code is present', () => {
    const noSymbol = { ...baseData, symbolCode: '' };
    // 95 = thunderstorm -> danger
    expect(analyzeSafetyConditions({ ...noSymbol, weatherCode: 95 }, baseSettings).rating).toBe('danger');
    // 65 = heavy rain -> danger
    expect(analyzeSafetyConditions({ ...noSymbol, weatherCode: 65 }, baseSettings).rating).toBe('danger');
    // 2 = partly cloudy -> safe
    expect(analyzeSafetyConditions({ ...noSymbol, weatherCode: 2 }, baseSettings).rating).toBe('safe');
  });

  it('evaluates water temp correctly', () => {
    const dataCaution = { ...baseData, tempWater: 12 };
    expect(analyzeSafetyConditions(dataCaution, baseSettings).rating).toBe('caution');

    const dataDanger = { ...baseData, tempWater: 8 };
    expect(analyzeSafetyConditions(dataDanger, baseSettings).rating).toBe('danger');
  });

  it('fails closed on negative magnitude sentinels instead of calling them calm or flat', () => {
    for (const invalid of [
      { windSpeed: -999 },
      { windGust: -999 },
      { waveHeight: -999 },
    ]) {
      const result = analyzeSafetyConditions({ ...baseData, ...invalid }, baseSettings);
      expect(result.rating).toBe('caution');
      expect(result.reasons.some((reason) => reason.text.includes('cannot clear'))).toBe(true);
    }
    expect(getWindSpeedLabel(-1)).toBe('Unknown');
    expect(getWaveHeightLabel(-1)).toBe('Unknown');
  });

  it('rejects out-of-range bearings when directional rules need them', () => {
    const settings = { ...baseSettings, enableCustomWindDirs: true } as SafetySettings;
    for (const windDirection of [-1, 360, 999]) {
      const result = analyzeSafetyConditions({ ...baseData, windDirection }, settings);
      expect(result.rating).toBe('caution');
      expect(result.reasons.some((reason) => reason.text.includes('wind direction'))).toBe(true);
    }
  });

  it('keeps signed tide levels and temperatures as legitimate physical readings', () => {
    const tide = analyzeSafetyConditions({ ...baseData, tideLevel: -1 }, baseSettings, -0.5);
    expect(tide.rating).toBe('safe');
    expect(tide.reasons.some((reason) => reason.text.includes('No reading'))).toBe(false);

    const cold = analyzeSafetyConditions({ ...baseData, tempWater: -1 }, baseSettings);
    expect(cold.rating).toBe('danger');
    expect(cold.reasons.some((reason) => reason.text.startsWith('Water temperature:'))).toBe(true);
  });

  it('keeps high outlook p90 informational and gives the same rating as no p90', () => {
    const block = {
      ...baseData,
      windSpeed: 4.3,
      windGust: Number.NaN,
      blockSpanHours: 6,
    };
    const settings = { ...baseSettings, daylightOnly: false } as SafetySettings;
    const withoutP90 = analyzeSafetyConditions(block, settings);
    const withHighP90 = analyzeSafetyConditions({ ...block, windSpeedP90: 20 }, settings);

    expect(withoutP90.rating).toBe('safe');
    expect(withHighP90.rating).toBe(withoutP90.rating);
    expect(withHighP90.reasons).toEqual(withoutP90.reasons);
  });

  // (The wind-against-water-level rule is exercised thoroughly in the
  // "custom wind direction sectors" block below, across all four combinations.)
});

describe('resolveSectors', () => {
  const offshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'offshore')!;

  it('applies a user cap override and floors caution at safe + 0.5', () => {
    const settings = {
      ...baseSettings,
      enableCustomWindDirs: true,
      sectorLimits: { onshore: { safe: 5, caution: 5 } },
    } as SafetySettings;
    const resolved = resolveSectors(CURRENT_LOCATION, settings);
    const on = resolved.find((s) => s.id === 'onshore')!;
    const configuredOnshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'onshore')!;
    expect(on.min).toBe(configuredOnshore.min);
    expect(on.max).toBe(configuredOnshore.max);
    expect(on.safeLimit).toBe(5);
    expect(on.cautionLimit).toBe(5.5); // caution floored to safe + 0.5
    // A sector without an override falls back to its configured caps.
    const off = resolved.find((s) => s.id === 'offshore')!;
    expect(off.safeLimit).toBe(offshore.safeLimit);
    expect(off.cautionLimit).toBe(offshore.cautionLimit);
  });
});

// ---------------------------------------------------------------------------
// Enable toggles: each toggle must silence exactly its own rule.
// ---------------------------------------------------------------------------
describe('safety rule enable toggles', () => {
  // Silence from a switched-off rule is not evidence of safety. With Max Wind
  // off, the all-clear used to read "Everything's within your limits — gale,
  // small ripples, clear sky": a green badge asserting that a 20 m/s gale sat
  // inside limits the user had explicitly turned off. hasActiveSafetyChecks
  // does not catch this, because it only fires when EVERY personal limit is off
  // — here five others are still on.
  it('does not claim a gale is within limits the user switched off', () => {
    const settings = { ...baseSettings, enableWindSpeed: false } as SafetySettings;
    const result = analyzeSafetyConditions({ ...baseData, windSpeed: 20 }, settings);
    const text = result.reasons.map((r) => r.text).join(' ');

    expect(result.reasons).toHaveLength(1);
    expect(text).not.toContain('within your limits');
    // Still describes the conditions - that part is useful and true - and says
    // plainly which reading nothing was measured against.
    expect(text).toContain('gale');
    expect(text).toContain('Not checked');
    expect(text).toContain('wind');
  });

  it('keeps the plain all-clear when every rule is actually doing its job', () => {
    const result = analyzeSafetyConditions(baseData, baseSettings);
    const text = result.reasons.map((r) => r.text).join(' ');
    expect(text).toContain('within your limits');
    expect(text).not.toContain('Not checked');
  });

  it('enableWindSpeed off silences wind reasons even at storm speeds', () => {
    const settings = { ...baseSettings, enableWindSpeed: false } as SafetySettings;
    const data = { ...baseData, windSpeed: 30 }; // Storm on the Beaufort scale
    const result = analyzeSafetyConditions(data, settings);
    expect(result.rating).toBe('safe');
    expect(result.reasons.some(r => r.text.includes('Wind speed'))).toBe(false);
  });

  it('enableWindSpeed off also silences the gust check (documented sub-limit behavior)', () => {
    const settings = { ...baseSettings, enableWindSpeed: false, enableWindGust: true } as SafetySettings;
    const data = { ...baseData, windSpeed: 30, windGust: 35 };
    const result = analyzeSafetyConditions(data, settings);
    expect(result.rating).toBe('safe');
    expect(result.reasons.some(r => r.text.includes('gust'))).toBe(false);
  });

  it('enableWindGust off ignores gusts while average wind is still rated', () => {
    const settings = { ...baseSettings, enableWindGust: false } as SafetySettings;
    // Gust alone: over every limit, but ignored.
    const gustOnly = analyzeSafetyConditions({ ...baseData, windGust: 30 }, settings);
    expect(gustOnly.rating).toBe('safe');
    // Average wind still rated with gusts off.
    const windToo = analyzeSafetyConditions({ ...baseData, windSpeed: 6, windGust: 30 }, settings);
    expect(windToo.rating).toBe('caution');
    expect(windToo.reasons.some(r => r.text.includes('Wind speed'))).toBe(true);
    expect(windToo.reasons.some(r => r.text.includes('gusts'))).toBe(false);
  });

  it('enableWaveHeight off silences all wave reasons', () => {
    const settings = { ...baseSettings, enableWaveHeight: false } as SafetySettings;
    const result = analyzeSafetyConditions({ ...baseData, waveHeight: 5 }, settings);
    expect(result.rating).toBe('safe');
    expect(result.reasons.some(r => r.text.includes('Wave height'))).toBe(false);
  });

  it('enableWaveCaution off removes the caution band but keeps the danger ceiling', () => {
    const settings = { ...baseSettings, enableWaveCaution: false } as SafetySettings;
    // Between safe (0.5) and caution (1.0): no caution band -> safe.
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 0.7 }, settings).rating).toBe('safe');
    // At the danger ceiling (maxWaveHeightCaution): still danger.
    const atCeiling = analyzeSafetyConditions({ ...baseData, waveHeight: 1.0 }, settings);
    expect(atCeiling.rating).toBe('danger');
    expect(atCeiling.reasons.some(r => r.severity === 'danger' && r.text.includes('Wave height'))).toBe(true);
  });

  it('enableWaterTemp off silences temperature reasons in freezing water', () => {
    const settings = { ...baseSettings, enableWaterTemp: false } as SafetySettings;
    const result = analyzeSafetyConditions({ ...baseData, tempWater: 2 }, settings);
    expect(result.rating).toBe('safe');
    expect(result.reasons.some(r => r.text.includes('Water temperature'))).toBe(false);
  });

  it('enableCustomWindDirs off silences the sector caps', () => {
    // Direction 90 at 6 m/s exceeds the default easterly safe cap of 4.5 m/s,
    // but the sector rule is disabled; the general limits are raised out of the way.
    const settings = {
      ...baseSettings,
      enableCustomWindDirs: false,
      maxWindSpeedSafe: 20,
      maxWindSpeedCaution: 25,
    } as SafetySettings;
    const result = analyzeSafetyConditions({ ...baseData, windDirection: 90, windSpeed: 6 }, settings);
    expect(result.rating).toBe('safe');
  });
});

// ---------------------------------------------------------------------------
// Gust math: caution at >= maxWindSpeedSafe, danger at >= safe + gustMargin
// (NOT at the average-wind caution limit).
// ---------------------------------------------------------------------------
describe('gust margin math', () => {
  // baseSettings: safe 5, caution 8, gustMargin 3 -> gust ceiling 8.
  it('matches the Safety Manual example (safe 5 + margin 3 => ceiling 8)', () => {
    const at72 = analyzeSafetyConditions({ ...baseData, windGust: 7.2 }, baseSettings);
    expect(at72.rating).toBe('caution');
    const at84 = analyzeSafetyConditions({ ...baseData, windGust: 8.4 }, baseSettings);
    expect(at84.rating).toBe('danger');
  });

  it('uses >= semantics at both gust boundaries', () => {
    // Judged at the precision it is shown at, so 4.94 reads "4.9" and clears
    // while 4.99 reads "5.0" and does not. Previously 4.99 printed "5.0" beside
    // a limit of 5 and still rated safe, so the screen contradicted the verdict.
    expect(analyzeSafetyConditions({ ...baseData, windGust: 4.94 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 4.99 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 5.0 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 8.0 }, baseSettings).rating).toBe('danger');
  });

  it('gust danger ceiling below the wind caution limit (margin 1.5 => ceiling 6.5, not 8)', () => {
    const settings = { ...baseSettings, gustMargin: 1.5 } as SafetySettings;
    // 6.5 = 5 + 1.5 is well below maxWindSpeedCaution (8) and must already be danger.
    expect(analyzeSafetyConditions({ ...baseData, windGust: 6.5 }, settings).rating).toBe('danger');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 6.4 }, settings).rating).toBe('caution');
  });

  it('gust danger ceiling above the wind caution limit (margin 5 => ceiling 10, not 8)', () => {
    const settings = { ...baseSettings, gustMargin: 5 } as SafetySettings;
    // A 9 m/s gust exceeds the wind caution limit (8) but not safe+margin (10):
    // it must stay caution, proving the ceiling is safe+margin, not the caution limit.
    expect(analyzeSafetyConditions({ ...baseData, windGust: 9 }, settings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 10 }, settings).rating).toBe('danger');
  });
});

// ---------------------------------------------------------------------------
// Threshold boundary semantics (manual: "at or above" limits trigger; water
// temperature is safe AT the safe limit and danger strictly BELOW caution).
// ---------------------------------------------------------------------------
describe('threshold boundaries', () => {
  it('wind speed: at-or-above semantics at both limits', () => {
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 4.9 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 5.0 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 7.9 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 8.0 }, baseSettings).rating).toBe('danger');
  });

  it('wave height: at-or-above semantics at both limits', () => {
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 0.49 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 0.5 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 0.99 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 1.0 }, baseSettings).rating).toBe('danger');
  });

  it('water temperature: safe AT the safe limit, danger only strictly below the caution limit', () => {
    // Manual section 8: ">= 15°C safe", "10-15°C caution", "< 10°C danger".
    expect(analyzeSafetyConditions({ ...baseData, tempWater: 15.0 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, tempWater: 14.9 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, tempWater: 10.0 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, tempWater: 9.9 }, baseSettings).rating).toBe('danger');
  });
});

// ---------------------------------------------------------------------------
// Daylight rule.
// ---------------------------------------------------------------------------
describe('daylightOnly rule', () => {
  it('night hour rates caution with the nighttime reason', () => {
    const result = analyzeSafetyConditions({ ...baseData, isDay: false }, baseSettings);
    expect(result.rating).toBe('caution');
    expect(result.reasons.some(r => r.severity === 'caution' && r.text.includes('Nighttime'))).toBe(true);
  });

  it('day hour adds nothing', () => {
    const result = analyzeSafetyConditions({ ...baseData, isDay: true }, baseSettings);
    expect(result.reasons.some(r => r.text.includes('Nighttime'))).toBe(false);
  });

  it('daylightOnly off ignores night', () => {
    const settings = { ...baseSettings, daylightOnly: false } as SafetySettings;
    expect(analyzeSafetyConditions({ ...baseData, isDay: false }, settings).rating).toBe('safe');
  });

  it('leaves a fully-daylit outlook block unchanged', () => {
    const block = { ...baseData, time: '2026-07-08T08:00:00Z', isDay: false, blockSpanHours: 6 };
    const result = analyzeSafetyConditions(block, baseSettings, undefined, undefined, {
      blockDaylight: {
        sun: { sunrise: ['2026-07-08T07:00:00Z'], sunset: ['2026-07-08T20:00:00Z'] },
      },
    });
    expect(result.rating).toBe('safe');
    expect(result.reasons.some((reason) => reason.text.startsWith('Daylight:'))).toBe(false);
  });

  it('rates partial, absent, and unknown block daylight at least caution with an explicit reason', () => {
    const block = { ...baseData, time: '2026-07-08T06:00:00Z', isDay: true, blockSpanHours: 6 };
    const assess = (sun?: { sunrise: string[]; sunset: string[] }) =>
      analyzeSafetyConditions(block, baseSettings, undefined, undefined, {
        blockDaylight: { sun },
      });

    const partial = assess({ sunrise: ['2026-07-08T08:00:00Z'], sunset: ['2026-07-08T20:00:00Z'] });
    expect(partial.rating).toBe('caution');
    expect(partial.reasons.some((reason) => reason.text.includes('part of this outlook period is outside'))).toBe(true);

    const translateDa = (key: string, ...args: Array<string | number>) =>
      interpolate(da[key] ?? key, ...args);
    const partialDa = analyzeSafetyConditions(block, baseSettings, undefined, translateDa, {
      blockDaylight: {
        sun: { sunrise: ['2026-07-08T08:00:00Z'], sunset: ['2026-07-08T20:00:00Z'] },
      },
    });
    expect(partialDa.reasons.some((reason) => reason.text.startsWith('Dagslys:'))).toBe(true);

    const none = assess({ sunrise: ['2026-07-08T14:00:00Z'], sunset: ['2026-07-08T20:00:00Z'] });
    expect(none.rating).toBe('caution');
    expect(none.reasons.some((reason) => reason.text.includes('no complete hour'))).toBe(true);

    const unknown = assess();
    expect(unknown.rating).toBe('caution');
    expect(unknown.reasons.some((reason) => reason.text.includes('unavailable'))).toBe(true);
  });

  it('can deliberately defer block daylight to launch-window clipping', () => {
    const block = { ...baseData, time: '2026-07-08T06:00:00Z', isDay: false, blockSpanHours: 6 };
    const result = analyzeSafetyConditions(block, baseSettings, undefined, undefined, {
      blockDaylight: { mode: 'defer-to-window' },
    });
    expect(result.rating).toBe('safe');
    expect(result.reasons.some((reason) => reason.text.startsWith('Daylight:'))).toBe(false);
  });

  it('nighttime never escalates a danger hour downward and is still listed', () => {
    const result = analyzeSafetyConditions({ ...baseData, isDay: false, windSpeed: 9 }, baseSettings);
    expect(result.rating).toBe('danger');
    expect(result.reasons.some(r => r.text.includes('Nighttime'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Custom wind direction sectors.
// ---------------------------------------------------------------------------
describe('custom wind direction sectors', () => {
  // General wind limits are raised out of the way so only sector rules speak.
  // Angles come from the Horsens config (onshore Easterly 45–135, offshore
  // Westerly 225–315); only the caps are set here. Offshore caution is 8.5 (vs
  // the config's 8.0) to exercise a user override.
  const sectorSettings = {
    ...baseSettings,
    enableCustomWindDirs: true,
    maxWindSpeedSafe: 20,
    maxWindSpeedCaution: 25,
    sectorLimits: {
      onshore: { safe: 4.5, caution: 7.0 },
      offshore: { safe: 5.5, caution: 8.5 },
    },
  } as SafetySettings;

  it('sector boundaries are inclusive at min and max degrees', () => {
    const at = (dir: number) => analyzeSafetyConditions({ ...baseData, windDirection: dir, windSpeed: 5 }, sectorSettings);
    expect(at(45).rating).toBe('caution');   // easterly min inclusive
    expect(at(135).rating).toBe('caution');  // easterly max inclusive
    // "Outside" now means outside the bearing the app DISPLAYS. 44.9 renders as
    // "45 deg NE" - the manual's Easterly zone - so treating it as outside made
    // the app disagree with its own compass reading. Rounding pulls a borderline
    // bearing into the sector, and a sector cap is never looser than the flat
    // cap, so this can only tighten a verdict.
    expect(at(44.9).rating).toBe('caution');  // displays as 45, so judged as 45
    expect(at(135.1).rating).toBe('caution'); // displays as 135
    expect(at(44.4).rating).toBe('safe');     // displays as 44, genuinely outside
    expect(at(135.6).rating).toBe('safe');    // displays as 136
  });

  it('keeps an unmatched 2° bearing on the flat-cap verdict without adding disclosure or tide interaction', () => {
    const settings = {
      ...baseSettings,
      enableCustomWindDirs: true,
      enableWindGust: false,
    } as SafetySettings;
    const data = {
      ...baseData,
      windDirection: 2,
      windSpeed: 7.8,
      tideLevel: 0,
    };
    const crossShore = analyzeSafetyConditions(data, settings, 0.5);
    const flatCapOnly = analyzeSafetyConditions(
      data,
      { ...settings, enableCustomWindDirs: false },
      0.5,
    );

    expect(flatCapOnly.rating).toBe('caution');
    expect(crossShore).toEqual(flatCapOnly);
    expect(crossShore.reasons.some((reason) => /cross-shore|direction-specific cap/i.test(reason.text)))
      .toBe(false);
    expect(crossShore.reasons.some((reason) => reason.text.includes('conflict'))).toBe(false);
  });

  it('leaves a bearing inside a configured sector unchanged', () => {
    const settings = {
      ...baseSettings,
      enableCustomWindDirs: true,
      enableWindGust: false,
    } as SafetySettings;
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 315, windSpeed: 7.8, tideLevel: 0 },
      settings,
      0.5,
    );

    expect(result).toEqual({
      rating: 'danger',
      reasons: [
        {
          severity: 'caution',
          text: 'Wind speed: 7.8 m/s (Moderate Breeze). Exceeds your safe limit of 5.0 m/s.',
        },
        {
          severity: 'danger',
          text: 'Westerly wind (315°) is over your 7.0 m/s danger cap for this direction.',
        },
        {
          severity: 'caution',
          text: 'Wind-against-water-level conflict: wind opposes rising water level. Expect steeper chop.',
        },
      ],
    });
  });

  it('easterly caps: caution at safe cap, danger at caution cap (>= semantics)', () => {
    const at = (speed: number) => analyzeSafetyConditions({ ...baseData, windDirection: 90, windSpeed: speed }, sectorSettings);
    expect(at(4.4).rating).toBe('safe');
    expect(at(4.5).rating).toBe('caution');
    expect(at(6.9).rating).toBe('caution');
    expect(at(7.0).rating).toBe('danger');
    expect(at(7.0).reasons.some(r => r.severity === 'danger' && r.text.includes('Easterly'))).toBe(true);
  });

  it('westerly caps: caution at safe cap, danger at caution cap', () => {
    const at = (speed: number) => analyzeSafetyConditions({ ...baseData, windDirection: 270, windSpeed: speed }, sectorSettings);
    expect(at(5.4).rating).toBe('safe');
    expect(at(5.5).rating).toBe('caution');
    expect(at(8.5).rating).toBe('danger');
    expect(at(8.5).reasons.some(r => r.severity === 'danger' && r.text.includes('Westerly') && r.text.includes('danger cap'))).toBe(true);
  });

  it('sector caps use AVERAGE wind, not gusts', () => {
    // 15 m/s gust in the easterly sector: gusts must not trip the 4.5 m/s sector cap.
    // (General gust ceiling is 20 + 3 = 23, so the gust rule stays quiet too.)
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 3, windGust: 15 },
      sectorSettings
    );
    expect(result.rating).toBe('safe');
    expect(result.reasons.some(r => r.text.includes('Easterly'))).toBe(false);
  });

  describe('wind-against-water-level rule (all four direction/trend combinations)', () => {
    // Speed 4.2: above the 4.0 conflict gate, below both sector safe caps.
    it('westerly + rising water -> conflict', () => {
      const result = analyzeSafetyConditions({ ...baseData, windDirection: 270, windSpeed: 4.2, tideLevel: 0 }, sectorSettings, 0.5);
      expect(result.rating).toBe('caution');
      expect(result.reasons.some(r => r.text.includes('wind opposes rising water'))).toBe(true);
    });

    it('westerly + falling water -> no conflict', () => {
      const result = analyzeSafetyConditions({ ...baseData, windDirection: 270, windSpeed: 4.2, tideLevel: 0 }, sectorSettings, -0.5);
      expect(result.rating).toBe('safe');
    });

    it('easterly + falling water -> conflict', () => {
      const result = analyzeSafetyConditions({ ...baseData, windDirection: 90, windSpeed: 4.2, tideLevel: 0 }, sectorSettings, -0.5);
      expect(result.rating).toBe('caution');
      expect(result.reasons.some(r => r.text.includes('wind opposes falling water'))).toBe(true);
    });

    it('easterly + rising water -> no conflict', () => {
      const result = analyzeSafetyConditions({ ...baseData, windDirection: 90, windSpeed: 4.2, tideLevel: 0 }, sectorSettings, 0.5);
      expect(result.rating).toBe('safe');
    });

    it('treats equal and sub-centimetre model noise as steady water', () => {
      // The UI shows whole centimetres. These deltas are at or below half a
      // displayed centimetre, so neither onshore nor offshore wind may invent
      // an opposing falling/rising trend from rounding noise.
      for (const nextLevel of [0, 0.005, -0.005, 0.004, -0.004]) {
        const onshoreResult = analyzeSafetyConditions(
          { ...baseData, windDirection: 90, windSpeed: 4.2, tideLevel: 0 },
          sectorSettings,
          nextLevel,
        );
        const offshoreResult = analyzeSafetyConditions(
          { ...baseData, windDirection: 270, windSpeed: 4.2, tideLevel: 0 },
          sectorSettings,
          nextLevel,
        );
        expect(onshoreResult.reasons.some((reason) => reason.text.includes('conflict'))).toBe(false);
        expect(offshoreResult.reasons.some((reason) => reason.text.includes('conflict'))).toBe(false);
      }
    });

    it('requires wind strictly above 4.0 m/s', () => {
      const atGate = analyzeSafetyConditions({ ...baseData, windDirection: 270, windSpeed: 4.0, tideLevel: 0 }, sectorSettings, 0.5);
      expect(atGate.rating).toBe('safe');
      const overGate = analyzeSafetyConditions({ ...baseData, windDirection: 270, windSpeed: 4.1, tideLevel: 0 }, sectorSettings, 0.5);
      expect(overGate.rating).toBe('caution');
    });

    it('requires the sector rule to be enabled', () => {
      const off = { ...sectorSettings, enableCustomWindDirs: false } as SafetySettings;
      const result = analyzeSafetyConditions({ ...baseData, windDirection: 270, windSpeed: 4.5, tideLevel: 0 }, off, 0.5);
      expect(result.reasons.some(r => r.text.includes('conflict'))).toBe(false);
    });

    it('is silent without a next-hour tide sample', () => {
      const result = analyzeSafetyConditions({ ...baseData, windDirection: 270, windSpeed: 4.5, tideLevel: 0 }, sectorSettings);
      expect(result.rating).toBe('safe');
    });

    it('wind outside every sector triggers no conflict (neither onshore nor offshore)', () => {
      // 180° (south) falls in neither Horsens sector, so both exposure flags stay
      // false and the tide rule cannot fire even with opposing water movement.
      const result = analyzeSafetyConditions({ ...baseData, windDirection: 180, windSpeed: 6, tideLevel: 0 }, sectorSettings, 0.5);
      expect(result.reasons.some(r => r.text.includes('conflict'))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Monotonic escalation and the all-clear reason.
// ---------------------------------------------------------------------------
describe('rating combination rules', () => {
  it('a danger rule is never lowered by later caution/safe rules; all reasons kept', () => {
    // Wind danger (9 >= 8), water temp caution (12 < 15), weather caution (rain).
    const data = { ...baseData, windSpeed: 9, tempWater: 12, symbolCode: 'rain', weatherCode: 63 };
    const result = analyzeSafetyConditions(data, baseSettings);
    expect(result.rating).toBe('danger');
    expect(result.reasons).toHaveLength(3);
    expect(result.reasons.filter(r => r.severity === 'danger')).toHaveLength(1);
    expect(result.reasons.filter(r => r.severity === 'caution')).toHaveLength(2);
  });

  it('a later danger rule escalates over an earlier caution', () => {
    // Wind caution (6 >= 5) then wave danger (1.5 >= 1.0).
    const result = analyzeSafetyConditions({ ...baseData, windSpeed: 6, waveHeight: 1.5 }, baseSettings);
    expect(result.rating).toBe('danger');
    expect(result.reasons).toHaveLength(2);
  });

  it('the all-clear reason appears only when zero rules triggered', () => {
    const clear = analyzeSafetyConditions(baseData, baseSettings);
    expect(clear.reasons).toHaveLength(1);
    expect(clear.reasons[0].severity).toBe('safe');
    expect(clear.reasons[0].text.startsWith("Everything's within your limits")).toBe(true);

    const triggered = analyzeSafetyConditions({ ...baseData, windSpeed: 6 }, baseSettings);
    expect(triggered.reasons.some(r => r.severity === 'safe')).toBe(false);
    expect(triggered.reasons.some(r => r.text.includes('within your limits'))).toBe(false);
  });

  it('qualifies an all-clear when the reading is a longer-range block', () => {
    const result = analyzeSafetyConditions(
      { ...baseData, blockSpanHours: 6 },
      baseSettings,
      undefined,
      undefined,
      {
        blockDaylight: {
          sun: { sunrise: ['2026-07-08T06:00:00Z'], sunset: ['2026-07-08T20:00:00Z'] },
        },
      },
    );
    expect(result.rating).toBe('safe');
    expect(result.reasons[0].text.startsWith('The outlook is within your limits')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Weather severity gaps (beyond the cases already tested above).
// ---------------------------------------------------------------------------
describe('weather severity (additional symbol_code cases)', () => {
  // Mirror normalize.ts — see the note on the other withSymbol above.
  const withSymbol = (symbolCode: string) => ({ ...baseData, symbolCode, weatherCode: metSymbolToWmoCode(symbolCode) });

  it('sleet family: caution unless heavy', () => {
    expect(analyzeSafetyConditions(withSymbol('sleet'), baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions(withSymbol('lightsleet'), baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions(withSymbol('heavysleet'), baseSettings).rating).toBe('danger');
  });

  it('snow family: caution unless heavy', () => {
    expect(analyzeSafetyConditions(withSymbol('lightsnow'), baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions(withSymbol('heavysnow'), baseSettings).rating).toBe('danger');
  });

  it('strips day/night/polartwilight suffixes before matching', () => {
    expect(analyzeSafetyConditions(withSymbol('rainandthunder_polartwilight'), baseSettings).rating).toBe('danger');
    expect(analyzeSafetyConditions(withSymbol('fog_night'), baseSettings).rating).toBe('caution');
  });

  // Weather FRANK cannot identify must never produce an all-clear. This used
  // to assert 'safe' — the engine's own header says unknown is the one verdict
  // the app must never invent, and MET can ship a symbol we don't know at any
  // time (a new code, a renamed variant).
  it('unknown symbol and unknown WMO fallback code are reported as unassessable, not safe', () => {
    const unknownSymbol = analyzeSafetyConditions(withSymbol('sunshowersoffrogs'), baseSettings);
    expect(unknownSymbol.rating).toBe('caution');
    expect(unknownSymbol.reasons.some((r) => /cannot clear/i.test(r.text))).toBe(true);

    const unknownCode = analyzeSafetyConditions({ ...baseData, symbolCode: '', weatherCode: 42 }, baseSettings);
    expect(unknownCode.rating).toBe('caution');
    expect(unknownCode.reasons.some((r) => /cannot clear/i.test(r.text))).toBe(true);
  });

  it('a recognised symbol in otherwise-clear conditions still rates safe', () => {
    expect(analyzeSafetyConditions(withSymbol('clearsky_day'), baseSettings).rating).toBe('safe');
  });

  it('legacy WMO fallback rates snow showers (85) as danger', () => {
    expect(analyzeSafetyConditions({ ...baseData, symbolCode: '', weatherCode: 85 }, baseSettings).rating).toBe('danger');
  });

  // Snow showers must match the WMO 85 fallback and the Safety Manual, which
  // both rate them Danger (squally, low-visibility bursts).
  it('rates snowshowers as danger, matching the WMO 85 fallback and the manual', () => {
    expect(analyzeSafetyConditions({ ...baseData, symbolCode: 'snowshowers' }, baseSettings).rating).toBe('danger');
    expect(analyzeSafetyConditions({ ...baseData, symbolCode: 'lightsnowshowers' }, baseSettings).rating).toBe('danger');
  });

  // Rain showers are gusty even when light — at least Caution, matching the
  // WMO 80 fallback and the manual (only steady light rain is no-warning).
  it('rates lightrainshowers consistently with its WMO 80 fallback (caution)', () => {
    expect(analyzeSafetyConditions({ ...baseData, symbolCode: 'lightrainshowers' }, baseSettings).rating).toBe('caution');
  });
});

// The screen and the verdict must never describe the same weather differently.
// They used to: display rounded, rules compared the raw float, so any reading
// within half a step of a limit disagreed with itself — always permissively.
describe('what is shown is what is judged', () => {
  const shown = (v: number, decimals: number) => formatReading(v, decimals);

  it('does not clear a wind speed that prints as the limit', () => {
    const settings = { ...baseSettings, maxWindSpeedSafe: 5.5 } as SafetySettings;
    expect(shown(5.46, 1)).toBe('5.5');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 5.46 }, settings).rating)
      .not.toBe('safe');
    // And still clears when the shown value is genuinely under.
    expect(shown(5.44, 1)).toBe('5.4');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 5.44 }, settings).rating)
      .toBe('safe');
  });

  it('does not clear a wave height that prints as the limit', () => {
    const settings = { ...baseSettings, maxWaveHeightSafe: 0.3, enableWaveCaution: true } as SafetySettings;
    expect(shown(0.2996, 2)).toBe('0.30');
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 0.2996 }, settings).rating)
      .not.toBe('safe');
  });

  // The guard that nearly went missing: null coerces to 0 in JS arithmetic, so
  // rounding a missing reading would have produced a valid calm measurement.
  it('never turns a missing reading into a calm one', () => {
    for (const absent of [NaN, undefined, null]) {
      const result = analyzeSafetyConditions(
        { ...baseData, waveHeight: absent as unknown as number },
        baseSettings,
      );
      expect(result.rating, `waveHeight=${String(absent)}`).not.toBe('safe');
    }
  });
});
