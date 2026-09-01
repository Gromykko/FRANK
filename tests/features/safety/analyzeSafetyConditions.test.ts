import { describe, it, expect } from 'vitest';
import { formatReading } from '../../../src/utils/number';
import {
  analyzeSafetyConditions,
  getWaveHeightLabel,
  getWindSpeedLabel,
  isNearLimitOnlyAnalysis,
  resolveSectors,
} from '../../../src/features/safety/analyzeSafetyConditions';
import { CURRENT_LOCATION } from '../../../src/config/locations';
import { da } from '../../../src/i18n/da';
import { interpolate } from '../../../src/i18n/interpolate';
import type { HourlyData } from '../../../src/features/forecast/types';
import type { SafetySettings } from '../../../src/features/safety/presets';
import { getPresetSettings } from '../../../src/features/safety/presets';

const baseSettings = {
  windLimit: 8,
  waterTempTakeCareBelow: 15,
  waterTempDangerBelow: 10,
  waveLimit: 1,
  enableWindSpeed: true,
  enableWindGust: true,
  enableWaveHeight: true,
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

  it('marks wind at the selected maximum as near-limit caution', () => {
    const data = { ...baseData, windSpeed: 8 };
    const result = analyzeSafetyConditions(data, baseSettings);
    expect(result).toEqual({
      rating: 'caution',
      reasons: [{
        severity: 'caution',
        kind: 'near-limit',
        text: 'Wind speed: 8.0 m/s (Fresh Breeze). At your maximum of 8.0 m/s.',
      }],
    });
  });

  it('flags danger when wind speed exceeds the maximum', () => {
    const data = { ...baseData, windSpeed: 8.1 };
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
    expect(result.reasons.some((reason) => /cannot assess/i.test(reason.text))).toBe(true);
    expect(result.reasons.some((reason) => /check another source/i.test(reason.text))).toBe(true);
  });

  it('evaluates water temp correctly', () => {
    const dataCaution = { ...baseData, tempWater: 12 };
    expect(analyzeSafetyConditions(dataCaution, baseSettings).rating).toBe('caution');

    const dataDanger = { ...baseData, tempWater: 8 };
    expect(analyzeSafetyConditions(dataDanger, baseSettings).rating).toBe('danger');
    expect(analyzeSafetyConditions({ ...baseData, tempWater: 10 }, baseSettings).rating).toBe('danger');
  });

  it('fails closed on negative magnitude sentinels instead of calling them calm or flat', () => {
    for (const invalid of [
      { windSpeed: -999 },
      { windGust: -999 },
      { waveHeight: -999 },
    ]) {
      const result = analyzeSafetyConditions({ ...baseData, ...invalid }, baseSettings);
      expect(result.rating).toBe('caution');
      expect(result.reasons.some((reason) => reason.text.includes('cannot assess'))).toBe(true);
      expect(result.reasons.some((reason) => reason.text.includes('check another source'))).toBe(true);
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

  it('applies a user maximum override and preserves configured geometry', () => {
    const settings = {
      ...baseSettings,
      enableCustomWindDirs: true,
      sectorLimits: { onshore: { maximumAt: 5 } },
    } as SafetySettings;
    const resolved = resolveSectors(CURRENT_LOCATION, settings);
    const on = resolved.find((s) => s.id === 'onshore')!;
    const configuredOnshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'onshore')!;
    expect(on.min).toBe(configuredOnshore.min);
    expect(on.max).toBe(configuredOnshore.max);
    expect(on.maximumAt).toBe(5);
    // A sector without an override falls back to its configured maximum.
    const off = resolved.find((s) => s.id === 'offshore')!;
    expect(off.maximumAt).toBe(offshore.maximumAt);
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
    expect(text).toContain('No check was triggered');
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

  it('enableWindSpeed off also silences the subordinate sector caps', () => {
    const settings = {
      ...baseSettings,
      enableWindSpeed: false,
      enableCustomWindDirs: true,
      sectorLimits: { onshore: { maximumAt: 1 } },
    } as SafetySettings;
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 20 },
      settings,
    );
    const text = result.reasons.map((reason) => reason.text).join(' ');

    expect(result.rating).toBe('safe');
    expect(text).not.toContain('Easterly wind');
    expect(text).toContain('Not checked');
    expect(text).toContain('wind');
  });

  it('enableWindGust off ignores gusts while average wind is still rated', () => {
    const settings = { ...baseSettings, enableWindGust: false } as SafetySettings;
    // Gust alone: over every limit, but ignored.
    const gustOnly = analyzeSafetyConditions({ ...baseData, windGust: 30 }, settings);
    expect(gustOnly.rating).toBe('safe');
    // Average wind still rated with gusts off.
    const windToo = analyzeSafetyConditions({ ...baseData, windSpeed: 8.1, windGust: 30 }, settings);
    expect(windToo.rating).toBe('danger');
    expect(windToo.reasons.some(r => r.text.includes('Wind speed'))).toBe(true);
    expect(windToo.reasons.some(r => r.text.includes('gusts'))).toBe(false);
  });

  it('enableWaveHeight off silences all wave reasons', () => {
    const settings = { ...baseSettings, enableWaveHeight: false } as SafetySettings;
    const result = analyzeSafetyConditions({ ...baseData, waveHeight: 5 }, settings);
    expect(result.rating).toBe('safe');
    expect(result.reasons.some(r => r.text.includes('Wave height'))).toBe(false);
  });

  it('enableWaterTemp off silences temperature reasons in freezing water', () => {
    const settings = { ...baseSettings, enableWaterTemp: false } as SafetySettings;
    const result = analyzeSafetyConditions({ ...baseData, tempWater: 2 }, settings);
    expect(result.rating).toBe('safe');
    expect(result.reasons.some(r => r.text.includes('Water temperature'))).toBe(false);
  });

  it('enableCustomWindDirs off silences the sector caps', () => {
    // Direction 90 at 8 m/s exceeds the configured easterly maximum of 7 m/s,
    // but the sector rule is disabled; the general limits are raised out of the way.
    const settings = {
      ...baseSettings,
      enableCustomWindDirs: false,
      windLimit: 20,
    } as SafetySettings;
    const result = analyzeSafetyConditions({ ...baseData, windDirection: 90, windSpeed: 8 }, settings);
    expect(result.rating).toBe('safe');
  });
});

// ---------------------------------------------------------------------------
// Gust math: one maximum, derived from the selected sustained-wind maximum.
// ---------------------------------------------------------------------------
describe('gust maximum math', () => {
  // baseSettings: wind maximum 8.0, so the gust maximum is 12.8 (x1.6). A
  // mean-wind limit is written for wind that already gusts - in these fjords the
  // gust runs about 1.66x the mean - so judging a gust against the mean number
  // counts the same gustiness twice. Measured against the old thresholds, gusts
  // alone made 51% of Intermediate's hours red while sustained wind sat at 59% of its
  // own cap; the supplement was outvoting the rule it supplements.
  it('derives the gust maximum and its automatic 80% caution point from the wind maximum', () => {
    expect(analyzeSafetyConditions({ ...baseData, windGust: 7.2 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 10.1 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 10.2 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 12.8 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 12.9 }, baseSettings).rating).toBe('danger');
  });

  it('keeps gusts numeric instead of assigning a Beaufort mean-wind label', () => {
    const result = analyzeSafetyConditions({ ...baseData, windSpeed: 3, windGust: 13.4 }, baseSettings);
    const gustReason = result.reasons.find((reason) => reason.text.startsWith('Wind gusts:'));

    expect(gustReason?.text).toBe('Wind gusts: 13.4 m/s. Above your maximum of 12.8 m/s.');
    expect(gustReason?.text).not.toMatch(/\([^)]*(?:Breeze|Gale|Storm|Hurricane)[^)]*\)/);
  });

  it('reports exact gust headroom and distinguishes equality from an excess', () => {
    const below = analyzeSafetyConditions({ ...baseData, windGust: 11.7 }, baseSettings);
    expect(below).toEqual({
      rating: 'caution',
      reasons: [{
        severity: 'caution',
        kind: 'near-limit',
        text: 'Wind gusts: 11.7 m/s. 1.1 m/s below your maximum of 12.8 m/s.',
      }],
    });

    const exact = analyzeSafetyConditions({ ...baseData, windGust: 12.8 }, baseSettings);
    expect(exact).toEqual({
      rating: 'caution',
      reasons: [{
        severity: 'caution',
        kind: 'near-limit',
        text: 'Wind gusts: 12.8 m/s. At your maximum of 12.8 m/s.',
      }],
    });
    expect(analyzeSafetyConditions({ ...baseData, windGust: 12.9 }, baseSettings).rating).toBe('danger');
  });

  it('tracks a custom wind maximum without another gust setting', () => {
    const settings = { ...baseSettings, windLimit: 6.5 } as SafetySettings;
    expect(analyzeSafetyConditions({ ...baseData, windGust: 8.2 }, settings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 8.3 }, settings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 10.4 }, settings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windGust: 10.5 }, settings).rating).toBe('danger');
  });

  it('marks every gust-only caution as a structured near-limit reason', () => {
    for (const windGust of [10.2, 11, 12.8]) {
      const result = analyzeSafetyConditions({ ...baseData, windGust }, baseSettings);
      expect(result.rating).toBe('caution');
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toMatchObject({ severity: 'caution', kind: 'near-limit' });
    }
  });
});

describe('wind and gust explanation de-duplication', () => {
  it('keeps a gust-only caution when mean wind is within limits', () => {
    const result = analyzeSafetyConditions(
      { ...baseData, windSpeed: 6.0, windGust: 12.7 },
      baseSettings,
    );

    expect(result).toEqual({
      rating: 'caution',
      reasons: [{
        severity: 'caution',
        kind: 'near-limit',
        text: 'Wind gusts: 12.7 m/s. 0.1 m/s below your maximum of 12.8 m/s.',
      }],
    });
  });

  it('keeps gust danger when mean wind is within limits', () => {
    const result = analyzeSafetyConditions(
      { ...baseData, windSpeed: 6.0, windGust: 13.5 },
      baseSettings,
    );

    expect(result).toEqual({
      rating: 'danger',
      reasons: [{
        severity: 'danger',
        text: 'Wind gusts: 13.5 m/s. Above your maximum of 12.8 m/s.',
      }],
    });
  });

  it('shows only mean wind when mean wind and gusts are both caution', () => {
    const result = analyzeSafetyConditions(
      { ...baseData, windSpeed: 7.0, windGust: 11.0 },
      baseSettings,
    );

    expect(result).toEqual({
      rating: 'caution',
      reasons: [{
        severity: 'caution',
        kind: 'near-limit',
        text: 'Wind speed: 7.0 m/s (Moderate Breeze). 1.0 m/s below your maximum of 8.0 m/s.',
      }],
    });
  });

  it('keeps gust danger beside a weaker mean-wind caution', () => {
    const result = analyzeSafetyConditions(
      { ...baseData, windSpeed: 7.0, windGust: 13.5 },
      baseSettings,
    );

    expect(result).toEqual({
      rating: 'danger',
      reasons: [
        {
          severity: 'caution',
          kind: 'near-limit',
          text: 'Wind speed: 7.0 m/s (Moderate Breeze). 1.0 m/s below your maximum of 8.0 m/s.',
        },
        {
          severity: 'danger',
          text: 'Wind gusts: 13.5 m/s. Above your maximum of 12.8 m/s.',
        },
      ],
    });
  });

  it('shows only mean-wind danger when gusts are caution', () => {
    const result = analyzeSafetyConditions(
      { ...baseData, windSpeed: 9.0, windGust: 11.0 },
      baseSettings,
    );

    expect(result).toEqual({
      rating: 'danger',
      reasons: [{
        severity: 'danger',
        text: 'Wind speed: 9.0 m/s (Fresh Breeze). Above your maximum of 8.0 m/s.',
      }],
    });
  });

  it('shows only mean-wind danger when both mean wind and gusts are danger', () => {
    const result = analyzeSafetyConditions(
      { ...baseData, windSpeed: 9.0, windGust: 13.5 },
      baseSettings,
    );

    expect(result).toEqual({
      rating: 'danger',
      reasons: [{
        severity: 'danger',
        text: 'Wind speed: 9.0 m/s (Fresh Breeze). Above your maximum of 8.0 m/s.',
      }],
    });
  });
});

// ---------------------------------------------------------------------------
// Wind and waves warn from 80% through equality with the selected maximum.
// Only a displayed reading above the maximum is danger. The lower
// water-temperature boundary still belongs to the stronger result.
// ---------------------------------------------------------------------------
describe('threshold boundaries', () => {
  it('wind speed: below 80% is safe, 80% through the maximum is caution, and an excess is danger', () => {
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 6.3 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 6.4 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 8.0 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 8.1 }, baseSettings).rating).toBe('danger');
  });

  it('wave height: below 80% is safe, 80% through the maximum is caution, and an excess is danger', () => {
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 0.79 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 0.80 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 1.0 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 1.01 }, baseSettings).rating).toBe('danger');
  });

  it('reports exact wind and wave headroom as structured near-limit reasons', () => {
    const wind = analyzeSafetyConditions({ ...baseData, windSpeed: 7.4 }, baseSettings);
    expect(wind).toEqual({
      rating: 'caution',
      reasons: [{
        severity: 'caution',
        kind: 'near-limit',
        text: 'Wind speed: 7.4 m/s (Moderate Breeze). 0.6 m/s below your maximum of 8.0 m/s.',
      }],
    });

    const waves = analyzeSafetyConditions({ ...baseData, waveHeight: 0.88 }, baseSettings);
    expect(waves).toEqual({
      rating: 'caution',
      reasons: [{
        severity: 'caution',
        kind: 'near-limit',
        text: 'Wave height: 0.88 m (Slight sea). 0.12 m below your maximum of 1.00 m.',
      }],
    });
  });

  it('water temperature: within limits at the check boundary, not recommended at or below the lower limit', () => {
    expect(analyzeSafetyConditions({ ...baseData, tempWater: 15.0 }, baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, tempWater: 14.9 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, tempWater: 10.1 }, baseSettings).rating).toBe('caution');
    expect(analyzeSafetyConditions({ ...baseData, tempWater: 10.0 }, baseSettings).rating).toBe('danger');
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
    expect(partial.reasons.some((reason) => reason.text.includes('part of this period is outside'))).toBe(true);

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
    expect(unknown.reasons.some((reason) => reason.text.includes('sunrise or sunset is missing'))).toBe(true);
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
  // Westerly 225–315); only the maximums are set here. Offshore is 8.5 (vs
  // the config's 7.0) to exercise a user override.
  const sectorSettings = {
    ...baseSettings,
    enableCustomWindDirs: true,
    windLimit: 20,
    sectorLimits: {
      onshore: { maximumAt: 7.0 },
      offshore: { maximumAt: 8.5 },
    },
  } as SafetySettings;

  it('sector boundaries are inclusive at min and max degrees', () => {
    const at = (dir: number) => analyzeSafetyConditions({ ...baseData, windDirection: dir, windSpeed: 7.1 }, sectorSettings);
    expect(at(45).rating).toBe('danger');   // easterly min inclusive
    expect(at(135).rating).toBe('danger');  // easterly max inclusive
    // "Outside" now means outside the bearing the app DISPLAYS. 44.9 renders as
    // "45 deg NE" - the manual's Easterly zone - so treating it as outside made
    // the app disagree with its own compass reading. The rule therefore evaluates
    // the same whole-degree bearing that it shows, regardless of which of the
    // general or sector thresholds controls the selected profile.
    expect(at(44.9).rating).toBe('danger');  // displays as 45, so judged as 45
    expect(at(135.1).rating).toBe('danger'); // displays as 135
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
    expect(flatCapOnly.reasons[0]).toMatchObject({
      severity: 'caution',
      kind: 'near-limit',
    });
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
          text: 'Wind speed: 7.8 m/s (Moderate Breeze). Westerly wind (315°) is above your 7.0 m/s maximum.',
        },
      ],
    });
  });

  it('keeps a general danger reason over a looser sector caution reason', () => {
    const settings = {
      ...getPresetSettings('beginner'),
      enableWindGust: false,
      enableCustomWindDirs: true,
      sectorLimits: {
        ...getPresetSettings('beginner').sectorLimits,
        onshore: { maximumAt: 7 },
      },
    } as SafetySettings;
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 5.7, tideLevel: 0 },
      settings,
    );

    expect(result.rating).toBe('danger');
    expect(result.reasons[0]).toEqual({
      severity: 'danger',
      text: 'Wind speed: 5.7 m/s (Moderate Breeze). Above your maximum of 5.0 m/s.',
    });
    expect(result.reasons.some((reason) => reason.text.includes('Easterly wind'))).toBe(false);
  });

  it('prefers the local-sector explanation when both wind maxima are identical', () => {
    const settings = {
      ...getPresetSettings('default'),
      enableWindGust: false,
      enableCustomWindDirs: true,
    } as SafetySettings;
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 8.1 },
      settings,
    );

    expect(result.rating).toBe('danger');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0].text).toContain('Easterly wind (90°)');
    expect(result.reasons[0].text).toContain('8.0 m/s maximum');
  });

  it('keeps a sector danger reason over a general near-limit reason', () => {
    const settings = {
      ...getPresetSettings('default'),
      enableWindGust: false,
      enableCustomWindDirs: true,
      sectorLimits: {
        ...getPresetSettings('default').sectorLimits,
        onshore: { maximumAt: 7 },
      },
    } as SafetySettings;
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 7.1 },
      settings,
    );

    expect(result.rating).toBe('danger');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0].text).toContain('Easterly wind (90°)');
    expect(result.reasons[0].text).toContain('7.0 m/s maximum');
  });

  it('keeps the lower controlling threshold when both general and sector rules are near-limit', () => {
    const settings = {
      ...getPresetSettings('default'),
      enableWindGust: false,
      enableCustomWindDirs: true,
      sectorLimits: {
        ...getPresetSettings('default').sectorLimits,
        onshore: { maximumAt: 7 },
      },
    } as SafetySettings;
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 6.5 },
      settings,
    );

    expect(result).toEqual({
      rating: 'caution',
      reasons: [{
        severity: 'caution',
        kind: 'near-limit',
        text: 'Wind speed: 6.5 m/s (Moderate Breeze). Easterly wind (90°) is 0.5 m/s below your 7.0 m/s maximum.',
      }],
    });
  });

  it('keeps only the controlling sector danger when gust danger does not outrank it', () => {
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
      'Wind speed: 7.8 m/s (Moderate Breeze). Westerly wind (270°) is above your 7.0 m/s maximum.',
    ]);
  });

  it('easterly maximum: 80% begins caution, equality stays caution, and the next step is danger', () => {
    const at = (speed: number) => analyzeSafetyConditions({ ...baseData, windDirection: 90, windSpeed: speed }, sectorSettings);
    expect(at(5.5).rating).toBe('safe');
    expect(at(5.6).rating).toBe('caution');
    expect(at(7.0).rating).toBe('caution');
    expect(at(7.1).rating).toBe('danger');
    expect(at(7.1).reasons.some(r => r.severity === 'danger' && r.text.includes('Easterly'))).toBe(true);
  });

  it('westerly maximum: 80% begins caution, equality stays caution, and the next step is danger', () => {
    const at = (speed: number) => analyzeSafetyConditions({ ...baseData, windDirection: 270, windSpeed: speed }, sectorSettings);
    expect(at(6.7).rating).toBe('safe');
    expect(at(6.8).rating).toBe('caution');
    expect(at(8.5).rating).toBe('caution');
    expect(at(8.6).rating).toBe('danger');
    expect(at(8.6).reasons.some(r => r.severity === 'danger' && r.text.includes('Westerly') && r.text.includes('maximum'))).toBe(true);
  });

  it('reports a sector near-limit reason with exact headroom', () => {
    const result = analyzeSafetyConditions(
      { ...baseData, windDirection: 90, windSpeed: 6.4 },
      sectorSettings,
    );

    expect(result).toEqual({
      rating: 'caution',
      reasons: [{
        severity: 'caution',
        kind: 'near-limit',
        text: 'Wind speed: 6.4 m/s (Moderate Breeze). Easterly wind (90°) is 0.6 m/s below your 7.0 m/s maximum.',
      }],
    });
  });

  it('sector caps use AVERAGE wind, not gusts', () => {
    // 15 m/s gust in the easterly sector: gusts must not trip the 7 m/s sector cap.
    // The general gust maximum is 20 × 1.6 = 32, so 15 stays quiet.
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
      const data = { ...baseData, windDirection: 90, windSpeed: 7.1, tideLevel: 0 };
      const baseline = analyzeSafetyConditions(data, sectorSettings);

      expect(baseline.rating).toBe('danger');
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
    // Cold water first raises caution, then an excessive wave raises danger.
    const result = analyzeSafetyConditions({ ...baseData, tempWater: 12, waveHeight: 1.01 }, baseSettings);
    expect(result.rating).toBe('danger');
    expect(result.reasons).toHaveLength(2);
  });

  it('the all-clear reason appears only when zero rules triggered', () => {
    const clear = analyzeSafetyConditions(baseData, baseSettings);
    expect(clear.reasons).toHaveLength(1);
    expect(clear.reasons[0].severity).toBe('safe');
    expect(clear.reasons[0].text.startsWith('No check was triggered')).toBe(true);

    const triggered = analyzeSafetyConditions({ ...baseData, windSpeed: 8.1 }, baseSettings);
    expect(triggered.reasons.some(r => r.severity === 'safe')).toBe(false);
    expect(triggered.reasons.some(r => r.text.includes('within your limits'))).toBe(false);
  });

  it('qualifies an all-clear when the reading is a longer-range block', () => {
    const result = analyzeSafetyConditions(
      { ...baseData, blockSpanHours: 6, windGust: Number.NaN },
      baseSettings,
      undefined,
      {
        blockDaylight: {
          sun: { sunrise: ['2026-07-08T06:00:00Z'], sunset: ['2026-07-08T20:00:00Z'] },
        },
      },
    );
    expect(result.rating).toBe('safe');
    expect(result.reasons[0].text).toContain('No outlook check was triggered');
    expect(result.reasons[0].text).not.toContain('Gusts are not forecast');
  });

  it('keeps a longer-range proximity warning structured as near-limit only', () => {
    const result = analyzeSafetyConditions(
      {
        ...baseData,
        blockSpanHours: 6,
        windSpeed: 6.4,
        windGust: Number.NaN,
      },
      baseSettings,
      undefined,
      {
        blockDaylight: {
          sun: { sunrise: ['2026-07-08T06:00:00Z'], sunset: ['2026-07-08T20:00:00Z'] },
        },
      },
    );

    expect(result).toEqual({
      rating: 'caution',
      reasons: [{
        severity: 'caution',
        kind: 'near-limit',
        text: 'Wind speed: 6.4 m/s (Moderate Breeze). 1.6 m/s below your maximum of 8.0 m/s.',
      }],
    });
    expect(isNearLimitOnlyAnalysis(result)).toBe(true);

    const withFog = analyzeSafetyConditions(
      {
        ...baseData,
        blockSpanHours: 6,
        windSpeed: 6.4,
        windGust: Number.NaN,
        symbolCode: 'fog',
      },
      { ...baseSettings, daylightOnly: false },
    );
    expect(isNearLimitOnlyAnalysis(withFog)).toBe(false);
  });

  it('does not add the outlook gust caveat when a gust is actually present', () => {
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
    expect(result.reasons[0].text.startsWith('No outlook check was triggered')).toBe(true);
    expect(result.reasons[0].text).not.toContain('Gusts are not forecast');
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
    expect(unknownSymbol.reasons.some((r) => /cannot assess/i.test(r.text))).toBe(true);
    expect(unknownSymbol.reasons.some((r) => /check another source/i.test(r.text))).toBe(true);
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
// within half a step of a limit disagreed with itself.
describe('what is shown is what is judged', () => {
  const shown = (v: number, decimals: number) => formatReading(v, decimals);

  it('judges wind from the same rounded value shown at the caution and danger boundaries', () => {
    const settings = { ...baseSettings, windLimit: 5.5 } as SafetySettings;

    expect(shown(4.34, 1)).toBe('4.3');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 4.34 }, settings).rating)
      .toBe('safe');
    expect(shown(4.36, 1)).toBe('4.4');
    const roundedToCaution = analyzeSafetyConditions({ ...baseData, windSpeed: 4.36 }, settings);
    expect(roundedToCaution.rating).toBe('caution');
    expect(roundedToCaution.reasons[0]).toMatchObject({ kind: 'near-limit' });

    expect(shown(5.46, 1)).toBe('5.5');
    const roundedToMaximum = analyzeSafetyConditions({ ...baseData, windSpeed: 5.46 }, settings);
    expect(roundedToMaximum.rating).toBe('caution');
    expect(roundedToMaximum.reasons[0].text).toContain('At your maximum of 5.5 m/s');
    expect(shown(5.44, 1)).toBe('5.4');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 5.44 }, settings).rating)
      .toBe('caution');
    expect(shown(5.55, 1)).toBe('5.6');
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 5.55 }, settings).rating)
      .toBe('danger');
  });

  it('judges waves from the same rounded value shown at the caution and danger boundaries', () => {
    const settings = { ...baseSettings, waveLimit: 0.3 } as SafetySettings;

    expect(shown(0.234, 2)).toBe('0.23');
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 0.234 }, settings).rating)
      .toBe('safe');
    expect(shown(0.236, 2)).toBe('0.24');
    const roundedToCaution = analyzeSafetyConditions({ ...baseData, waveHeight: 0.236 }, settings);
    expect(roundedToCaution.rating).toBe('caution');
    expect(roundedToCaution.reasons[0]).toMatchObject({ kind: 'near-limit' });

    expect(shown(0.2996, 2)).toBe('0.30');
    const roundedToMaximum = analyzeSafetyConditions({ ...baseData, waveHeight: 0.2996 }, settings);
    expect(roundedToMaximum.rating).toBe('caution');
    expect(roundedToMaximum.reasons[0].text).toContain('At your maximum of 0.30 m');
    expect(shown(0.306, 2)).toBe('0.31');
    expect(analyzeSafetyConditions({ ...baseData, waveHeight: 0.306 }, settings).rating)
      .toBe('danger');
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
