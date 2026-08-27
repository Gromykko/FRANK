import { describe, it, expect } from 'vitest';
import { formatReading } from '../../../src/utils/number';
import {
  analyzeSafetyConditions,
  getWaveHeightLabel,
  getWindSpeedLabel,
  resolveSectors,
} from '../../../src/features/safety/analyzeSafetyConditions';
import { CURRENT_LOCATION } from '../../../src/config/locations';
import { da } from '../../../src/i18n/da';
import { interpolate } from '../../../src/i18n/interpolate';
import type { HourlyData } from '../../../src/features/forecast/types';
import type { SafetySettings } from '../../../src/features/safety/presets';
import { getPresetSettings } from '../../../src/features/safety/presets';

const baseSettings = {
  windTakeCareAt: 5,
  waterTempTakeCareBelow: 15,
  waterTempDangerBelow: 10,
  waveTakeCareAt: 0.5,
  windDangerGap: 3,
  waveDangerGap: 0.5,
  enableWindSpeed: true,
  enableWindGust: true,
  enableWaveHeight: true,
  enableWaveTakeCare: true,
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
    const withSymbol = (symbolCode: string) => ({ ...baseData, symbolCode });
    // Thunder -> danger
    expect(analyzeSafetyConditions(withSymbol('heavyrainandthunder'), baseSettings).rating).toBe('danger');
    // Heavy rain -> danger
    expect(analyzeSafetyConditions(withSymbol('heavyrain'), baseSettings).rating).toBe('danger');
    // Rain -> caution
    expect(analyzeSafetyConditions(withSymbol('rain'), baseSettings).rating).toBe('caution');
    // Light rain -> safe (minor for kayaking)
    expect(analyzeSafetyConditions(withSymbol('lightrain'), baseSettings).rating).toBe('safe');
    // Fog -> caution
    expect(analyzeSafetyConditions(withSymbol('fog'), baseSettings).rating).toBe('caution');
    // Snow -> caution
    expect(analyzeSafetyConditions(withSymbol('snow'), baseSettings).rating).toBe('caution');
    // Clear -> safe
    expect(analyzeSafetyConditions(withSymbol('clearsky_night'), baseSettings).rating).toBe('safe');
  });

  it('treats a missing native symbol as unassessable', () => {
    const result = analyzeSafetyConditions({ ...baseData, symbolCode: '' }, baseSettings);
    expect(result.rating).toBe('caution');
    expect(result.reasons.some((reason) => /cannot clear/i.test(reason.text))).toBe(true);
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

  it('uses every official DMI Beaufort band with exact upper-bound semantics', () => {
    const boundaries: [number, string, string][] = [
      [0.2, 'Calm', 'Light Air'],
      [1.5, 'Light Air', 'Light Breeze'],
      [3.3, 'Light Breeze', 'Gentle Breeze'],
      [5.4, 'Gentle Breeze', 'Moderate Breeze'],
      [7.9, 'Moderate Breeze', 'Fresh Breeze'],
      [10.7, 'Fresh Breeze', 'Strong Breeze'],
      [13.8, 'Strong Breeze', 'Near Gale'],
      [17.1, 'Near Gale', 'Gale'],
      [20.7, 'Gale', 'Strong Gale'],
      [24.4, 'Strong Gale', 'Storm'],
      [28.4, 'Storm', 'Violent Storm'],
      [32.6, 'Violent Storm', 'Hurricane'],
    ];

    for (const [maximum, label, nextLabel] of boundaries) {
      expect(getWindSpeedLabel(maximum), `${maximum} m/s exact boundary`).toBe(label);
      expect(getWindSpeedLabel(maximum + 0.01), `above ${maximum} m/s`).toBe(nextLabel);
      expect(da, `missing Danish translation for ${label}`).toHaveProperty(label);
      expect(da, `missing Danish translation for ${nextLabel}`).toHaveProperty(nextLabel);
    }
  });

  it('uses WMO sea-wave terms with WMO exact-boundary semantics', () => {
    const boundaries: [number, string, string][] = [
      [0.1, 'Calm sea', 'Smooth sea'],
      [0.5, 'Smooth sea', 'Slight sea'],
      [1.25, 'Slight sea', 'Moderate sea'],
      [2.5, 'Moderate sea', 'Rough sea'],
      [4, 'Rough sea', 'Very rough sea'],
      [6, 'Very rough sea', 'High sea'],
      [9, 'High sea', 'Very high sea'],
      [14, 'Very high sea', 'Phenomenal sea'],
    ];

    for (const [maximum, label, nextLabel] of boundaries) {
      expect(getWaveHeightLabel(maximum), `${maximum} m exact boundary`).toBe(label);
      expect(getWaveHeightLabel(maximum + 0.01), `above ${maximum} m`).toBe(nextLabel);
      expect(da, `missing Danish translation for ${label}`).toHaveProperty(label);
      expect(da, `missing Danish translation for ${nextLabel}`).toHaveProperty(nextLabel);
    }
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
    const tide = analyzeSafetyConditions({ ...baseData, tideLevel: -1 }, baseSettings);
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
});

describe('resolveSectors', () => {
  const offshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'offshore')!;

  it('applies a user cap override and floors Danger at Take care + 0.5', () => {
    const settings = {
      ...baseSettings,
      enableCustomWindDirs: true,
      sectorLimits: { onshore: { takeCareAt: 5, dangerAt: 5 } },
    } as SafetySettings;
    const resolved = resolveSectors(CURRENT_LOCATION, settings);
    const on = resolved.find((s) => s.id === 'onshore')!;
    const configuredOnshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'onshore')!;
    expect(on.min).toBe(configuredOnshore.min);
    expect(on.max).toBe(configuredOnshore.max);
    expect(on.takeCareAt).toBe(5);
    expect(on.dangerAt).toBe(5.5); // Danger floored to Take care + 0.5
    // A sector without an override falls back to its configured caps.
    const off = resolved.find((s) => s.id === 'offshore')!;
    expect(off.takeCareAt).toBe(offshore.takeCareAt);
    expect(off.dangerAt).toBe(offshore.dangerAt);
  });
});

// ---------------------------------------------------------------------------
// Enable toggles: each toggle must silence exactly its own rule.
// ---------------------------------------------------------------------------
describe('safety rule enable toggles', () => {
  // Silence from a switched-off rule is not evidence of safety. With the wind rule
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

  it('enableWaveTakeCare off removes the caution band but keeps the danger ceiling', () => {
    const settings = { ...baseSettings, enableWaveTakeCare: false } as SafetySettings;
    // Between Take care (0.5) and Danger (1.0): no amber band -> safe.
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 0.7 }, settings).rating).toBe('safe');
    // At the derived Danger ceiling: still danger.
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
      windTakeCareAt: 20,
      windDangerGap: 5,
    } as SafetySettings;
    const result = analyzeSafetyConditions({ ...baseData, windDirection: 90, windSpeed: 6 }, settings);
    expect(result.rating).toBe('safe');
  });
});

// ---------------------------------------------------------------------------
// Gust math: Take care at >= windTakeCareAt, Danger at >= Take care + windDangerGap.
// ---------------------------------------------------------------------------
describe('gust margin math', () => {
  // The configured Take care threshold plus the danger margin sets the gust ceiling.
  // baseSettings: wind 5.0 / 8.0, so the gust band is 8.0 / 12.8 (x1.6). A
  // mean-wind limit is written for wind that already gusts - in these fjords the
  // gust runs about 1.66x the mean - so judging a gust against the mean number
  // counts the same gustiness twice. Measured against the old thresholds, gusts
  // alone made 51% of Intermediate's hours red while sustained wind sat at 59% of its
  // own cap; the supplement was outvoting the rule it supplements.
  it('derives both gust ceilings from the wind band, scaled by the gust factor', () => {
    // 7.2 used to be caution and 8.4 used to be danger, on the mean numbers.
    expect(analyzeSafetyConditions({ ...baseData, windGust: 7.2 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 8.4 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 12.8 }, baseSettings).rating).toBe('danger');
  });

  it('keeps gusts numeric instead of assigning a Beaufort mean-wind label', () => {
    const result = analyzeSafetyConditions({ ...baseData, windSpeed: 3, windGust: 13.4 }, baseSettings);
    const gustReason = result.reasons.find((reason) => reason.text.startsWith('Wind gusts:'));

    expect(gustReason?.text).toBe('Wind gusts: 13.4 m/s. Above your gust danger threshold of 12.8 m/s.');
    expect(gustReason?.text).not.toMatch(/\([^)]*(?:Breeze|Gale|Storm|Hurricane)[^)]*\)/);
  });

  it('uses >= semantics at both gust boundaries', () => {
    // Judged at the precision it is shown at, so 7.94 reads "7.9" and clears
    // while 7.99 reads "8.0" and does not.
    expect(analyzeSafetyConditions({ ...baseData, windGust: 7.94 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 7.99 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 8.0 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 12.7 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 12.8 }, baseSettings).rating).toBe('danger');
  });

  it('tracks the Danger boundary derived from the Take care threshold and gap', () => {
    const settings = { ...baseSettings, windDangerGap: 1.5 } as SafetySettings;
    expect(analyzeSafetyConditions({ ...baseData, windGust: 10.3 }, settings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 10.4 }, settings).rating).toBe('danger');
  });

  it('never lets a malformed negative gap put the gust Danger ceiling under its floor', () => {
    // floorDanger keeps the Danger edge at least MIN_DANGER_GAP above Take care.
    const settings = { ...baseSettings, windDangerGap: -2 } as SafetySettings;
    const calm = { ...baseData, windSpeed: 1 };
    expect(analyzeSafetyConditions({ ...calm, windGust: 8.7 }, settings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...calm, windGust: 8.8 }, settings).rating).toBe('danger');
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
    // Manual section 7: ">= 15°C Good to go", "10-15°C Take care",
    // "< 10°C Rough".
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
    const result = analyzeSafetyConditions(block, baseSettings, undefined, {
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
      analyzeSafetyConditions(block, baseSettings, undefined, {
        blockDaylight: { sun },
      });

    const partial = assess({ sunrise: ['2026-07-08T08:00:00Z'], sunset: ['2026-07-08T20:00:00Z'] });
    expect(partial.rating).toBe('caution');
    expect(partial.reasons.some((reason) => reason.text.includes('part of this outlook period is outside'))).toBe(true);

    const translateDa = (key: string, ...args: Array<string | number>) =>
      interpolate(da[key] ?? key, ...args);
    const partialDa = analyzeSafetyConditions(block, baseSettings, translateDa, {
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
    const result = analyzeSafetyConditions(block, baseSettings, undefined, {
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
    windTakeCareAt: 20,
    windDangerGap: 5,
    sectorLimits: {
      onshore: { takeCareAt: 4.5, dangerAt: 7.0 },
      offshore: { takeCareAt: 5.5, dangerAt: 8.5 },
    },
  } as SafetySettings;

  it('sector boundaries are inclusive at min and max degrees', () => {
    const at = (dir: number) => analyzeSafetyConditions({ ...baseData, windDirection: dir, windSpeed: 5 }, sectorSettings);
    expect(at(45).rating).toBe('caution');   // easterly min inclusive
    expect(at(135).rating).toBe('caution');  // easterly max inclusive
    // "Outside" now means outside the bearing the app DISPLAYS. 44.9 renders as
    // "45 deg NE" - the manual's Easterly zone - so treating it as outside made
    // the app disagree with its own compass reading. The rule therefore evaluates
    // the same whole-degree bearing that it shows, regardless of which of the
    // general or sector thresholds controls the selected profile.
    expect(at(44.9).rating).toBe('caution');  // displays as 45, so judged as 45
    expect(at(135.1).rating).toBe('caution'); // displays as 135
    expect(at(44.4).rating).toBe('safe');     // displays as 44, genuinely outside
    expect(at(135.6).rating).toBe('safe');    // displays as 136
  });

  it('keeps an unmatched 2° bearing on the flat-cap verdict without adding sector disclosure', () => {
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
    const crossShore = analyzeSafetyConditions(data, settings);
    const flatCapOnly = analyzeSafetyConditions(
      data,
      { ...settings, enableCustomWindDirs: false },
    );

    expect(flatCapOnly.rating).toBe('caution');
    expect(crossShore).toEqual(flatCapOnly);
    expect(crossShore.reasons.some((reason) => /cross-shore|direction-specific cap/i.test(reason.text)))
      .toBe(false);
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
    );

    expect(result).toEqual({
      rating: 'danger',
      reasons: [
        {
          severity: 'danger',
          text: 'Wind speed: 7.8 m/s (Moderate Breeze). Westerly wind (315°) is over your 7.0 m/s danger threshold for this direction.',
        },
      ],
    });
  });

  it('shows the general reason when it is stricter than a looser active sector', () => {
    const settings = {
      ...getPresetSettings('beginner'),
      enableWindGust: false,
      enableCustomWindDirs: true,
    } as SafetySettings;
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 5, tideLevel: 0 },
      settings,
    );

    expect(result.rating).toBe('danger');
    expect(result.reasons[0]).toEqual({
      severity: 'danger',
      text: 'Wind speed: 5.0 m/s (Gentle Breeze). At your danger limit of 5.0 m/s.',
    });
    expect(result.reasons.some((reason) => reason.text.includes('Easterly wind'))).toBe(false);
  });

  it('prefers the local-sector explanation when both danger limits are identical', () => {
    const settings = {
      ...getPresetSettings('default'),
      enableWindGust: false,
      enableCustomWindDirs: true,
    } as SafetySettings;
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 8 },
      settings,
    );

    expect(result.rating).toBe('danger');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0].text).toContain('Easterly wind (90°)');
    expect(result.reasons[0].text).toContain('8.0 m/s danger threshold for this direction');
  });

  it('keeps the lower controlling threshold when general and sector severity match', () => {
    const settings = {
      ...getPresetSettings('default'),
      enableWindGust: false,
      enableCustomWindDirs: true,
    } as SafetySettings;
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 6 },
      settings,
    );

    expect(result.rating).toBe('caution');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0].text).toContain('Easterly wind (90°)');
    expect(result.reasons[0].text).toContain('5.0 m/s Take care threshold for this direction');
  });

  it('keeps sustained wind and gusts as distinct hazards in that order', () => {
    const settings = {
      ...baseSettings,
      enableCustomWindDirs: true,
    } as SafetySettings;
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 270, windSpeed: 7.8, windGust: 13, tideLevel: 0 },
      settings,
    );

    expect(result.rating).toBe('danger');
    expect(result.reasons.map((reason) => reason.text)).toEqual([
      'Wind speed: 7.8 m/s (Moderate Breeze). Westerly wind (270°) is over your 7.0 m/s danger threshold for this direction.',
      'Wind gusts: 13.0 m/s. Above your gust danger threshold of 12.8 m/s.',
    ]);
  });

  it('easterly caps: caution at Take care cap, danger at Danger cap (>= semantics)', () => {
    const at = (speed: number) => analyzeSafetyConditions({ ...baseData, windDirection: 90, windSpeed: speed }, sectorSettings);
    expect(at(4.4).rating).toBe('safe');
    expect(at(4.5).rating).toBe('caution');
    expect(at(6.9).rating).toBe('caution');
    expect(at(7.0).rating).toBe('danger');
    expect(at(7.0).reasons.some(r => r.severity === 'danger' && r.text.includes('Easterly'))).toBe(true);
  });

  it('westerly caps: caution at Take care cap, danger at Danger cap', () => {
    const at = (speed: number) => analyzeSafetyConditions({ ...baseData, windDirection: 270, windSpeed: speed }, sectorSettings);
    expect(at(5.4).rating).toBe('safe');
    expect(at(5.5).rating).toBe('caution');
    expect(at(8.5).rating).toBe('danger');
    expect(at(8.5).reasons.some(r => r.severity === 'danger' && r.text.includes('Westerly') && r.text.includes('danger threshold'))).toBe(true);
  });

  it('sector caps use AVERAGE wind, not gusts', () => {
    // 15 m/s gust in the easterly sector: gusts must not trip the 4.5 m/s sector cap.
    // The general gust Take care threshold is 20 × 1.6 = 32, so 15 stays quiet.
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 3, windGust: 15 },
      sectorSettings
    );
    expect(result.rating).toBe('safe');
    expect(result.reasons.some(r => r.text.includes('Easterly'))).toBe(false);
  });

  describe('water level is verdict-neutral', () => {
    it('cannot alter the rating or reasons for any configured wind sector', () => {
      for (const windDirection of [90, 270]) {
        const data = { ...baseData, windDirection, windSpeed: 4.2, tideLevel: 0 };
        const baseline = analyzeSafetyConditions(data, sectorSettings);

        expect(baseline.rating).toBe('safe');
        for (const tideLevel of [-0.5, 0.5]) {
          expect(analyzeSafetyConditions({ ...data, tideLevel }, sectorSettings)).toEqual(baseline);
        }
      }
    });

    it('does not change an active sector cap or its reason', () => {
      const data = { ...baseData, windDirection: 90, windSpeed: 5, tideLevel: 0 };
      const baseline = analyzeSafetyConditions(data, sectorSettings);

      expect(baseline.rating).toBe('caution');
      expect(baseline.reasons).toHaveLength(1);
      expect(baseline.reasons[0].text).toContain('Easterly wind (90°)');
      for (const tideLevel of [-0.5, 0.5]) {
        expect(analyzeSafetyConditions({ ...data, tideLevel }, sectorSettings)).toEqual(baseline);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Monotonic escalation and the all-clear reason.
// ---------------------------------------------------------------------------
describe('rating combination rules', () => {
  it('a danger rule is never lowered by later caution/safe rules; all reasons kept', () => {
    // Wind danger (9 >= 8), water temp caution (12 < 15), weather caution (rain).
    const data = { ...baseData, windSpeed: 9, tempWater: 12, symbolCode: 'rain' };
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
  const withSymbol = (symbolCode: string) => ({ ...baseData, symbolCode });

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
    expect(analyzeSafetyConditions(withSymbol('rainshowersandthunder_polartwilight'), baseSettings).rating).toBe('danger');
    expect(analyzeSafetyConditions(withSymbol('fair_night'), baseSettings).rating).toBe('safe');
  });

  // Weather FRANK cannot identify must never produce an all-clear. This used
  // to assert 'safe' — the engine's own header says unknown is the one verdict
  // the app must never invent, and MET can ship a symbol we don't know at any
  // time (a new code, a renamed variant).
  it('an unknown native symbol is reported as unassessable, not safe', () => {
    const unknownSymbol = analyzeSafetyConditions(withSymbol('sunshowersoffrogs'), baseSettings);
    expect(unknownSymbol.rating).toBe('caution');
    expect(unknownSymbol.reasons.some((r) => /cannot clear/i.test(r.text))).toBe(true);
  });

  it('a recognised symbol in otherwise-clear conditions still rates safe', () => {
    expect(analyzeSafetyConditions(withSymbol('clearsky_day'), baseSettings).rating).toBe('safe');
  });

  it('rates snow showers as danger, matching the manual', () => {
    expect(analyzeSafetyConditions({ ...baseData, symbolCode: 'snowshowers_day' }, baseSettings).rating).toBe('danger');
    expect(analyzeSafetyConditions({ ...baseData, symbolCode: 'lightsnowshowers_night' }, baseSettings).rating).toBe('danger');
  });

  // Rain showers are gusty even when light — at least Caution; only steady
  // light rain is no-warning.
  it('rates light rain showers as caution', () => {
    expect(analyzeSafetyConditions({ ...baseData, symbolCode: 'lightrainshowers_day' }, baseSettings).rating).toBe('caution');
  });
});

// The screen and the verdict must never describe the same weather differently.
// They used to: display rounded, rules compared the raw float, so any reading
// within half a step of a limit disagreed with itself — always permissively.
describe('what is shown is what is judged', () => {
  const shown = (v: number, decimals: number) => formatReading(v, decimals);

  it('does not clear a wind speed that prints as the limit', () => {
    const settings = { ...baseSettings, windTakeCareAt: 5.5 } as SafetySettings;
    expect(shown(5.46, 1)).toBe('5.5');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 5.46 }, settings).rating)
      .not.toBe('safe');
    // And still clears when the shown value is genuinely under.
    expect(shown(5.44, 1)).toBe('5.4');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 5.44 }, settings).rating)
      .toBe('safe');
  });

  it('does not clear a wave height that prints as the limit', () => {
    const settings = { ...baseSettings, waveTakeCareAt: 0.3, enableWaveTakeCare: true } as SafetySettings;
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
