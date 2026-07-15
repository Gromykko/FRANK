import { describe, it, expect } from 'vitest';
import { analyzeSafetyConditions, resolveSectors } from '../../../src/features/safety/analyzeSafetyConditions';
import { CURRENT_LOCATION } from '../../../src/config/locations';
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

  it('rates the weather condition from the MET symbol_code', () => {
    const withSymbol = (symbolCode: string) => ({ ...baseData, symbolCode });
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
    expect(analyzeSafetyConditions({ ...baseData, windGust: 4.99 }, baseSettings).rating).toBe('safe');
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

  it('longer-range blocks are exempt even when isDay is false', () => {
    const result = analyzeSafetyConditions({ ...baseData, isDay: false, blockSpanHours: 6 }, baseSettings);
    expect(result.rating).toBe('safe');
    expect(result.reasons.some(r => r.text.includes('Nighttime'))).toBe(false);
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
    expect(at(44.9).rating).toBe('safe');    // just outside
    expect(at(135.1).rating).toBe('safe');   // just outside
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
    expect(analyzeSafetyConditions(withSymbol('rainandthunder_polartwilight'), baseSettings).rating).toBe('danger');
    expect(analyzeSafetyConditions(withSymbol('fog_night'), baseSettings).rating).toBe('caution');
  });

  it('unknown symbol and unknown WMO fallback code default to safe', () => {
    expect(analyzeSafetyConditions(withSymbol('sunshowersoffrogs'), baseSettings).rating).toBe('safe');
    expect(analyzeSafetyConditions({ ...baseData, symbolCode: '', weatherCode: 42 }, baseSettings).rating).toBe('safe');
  });

  it('legacy WMO fallback rates snow showers (85) as danger', () => {
    expect(analyzeSafetyConditions({ ...baseData, symbolCode: '', weatherCode: 85 }, baseSettings).rating).toBe('danger');
  });

  // A sector may wrap through north (min > max, e.g. 315°–45°); membership
  // must treat the range as crossing 0°, not as an empty range.
  it('handles wind sectors that wrap through north', () => {
    // Override the onshore sector's angles to wrap through north (315–45) via a
    // legacy-style sectorAngles override, and set its cap to 4 m/s.
    const settings = {
      ...baseSettings,
      enableCustomWindDirs: true,
      sectorAngles: { onshore: { min: 315, max: 45 } },
      sectorLimits: { onshore: { safe: 4, caution: 7 } },
    } as SafetySettings;

    // 4.5 m/s stays under the plain wind limit (5) but over the sector cap (4),
    // so any rating change comes from sector membership alone.
    // 0° (due north) lies inside the wrapped 315–45 sector.
    const northerly = { ...baseData, windDirection: 0, windSpeed: 4.5 };
    expect(analyzeSafetyConditions(northerly, settings).rating).toBe('caution');

    // 180° (due south) lies outside it.
    const southerly = { ...baseData, windDirection: 180, windSpeed: 4.5 };
    expect(analyzeSafetyConditions(southerly, settings).rating).toBe('safe');
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
