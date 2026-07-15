import { describe, it, expect } from 'vitest';
import { migrateLegacySectors, healSectorCautions, parseStoredSettings } from '../../src/hooks/useSettings';
import { analyzeSafetyConditions } from '../../src/features/safety/analyzeSafetyConditions';
import { DEFAULT_SETTINGS } from '../../src/features/safety/presets';
import type { SafetySettings } from '../../src/features/safety/presets';
import { CURRENT_LOCATION } from '../../src/config/locations';
import type { HourlyData } from '../../src/features/forecast/types';

const onshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'onshore')!; // Horsens 45–135, 4.5/7.0
const offshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'offshore')!; // Horsens 225–315, 5.5/8.0

// A legacy profile as stored before the sector-list refactor.
function legacyBlob(overrides: Record<string, unknown> = {}) {
  return {
    tripMode: 'custom',
    enableCustomWindDirs: true,
    easterlyMin: onshore.min, easterlyMax: onshore.max, easterlyLimit: 4.5, easterlyCautionLimit: 7.0,
    westerlyMin: offshore.min, westerlyMax: offshore.max, westerlyLimit: 5.5, westerlyCautionLimit: 8.0,
    ...overrides,
  };
}

const baseData: HourlyData = {
  time: '2026-07-08T12:00:00Z', tempAir: 20, tempWater: 18, windSpeed: 3, windGust: 4,
  windDirection: 180, waveHeight: 0.1, wavePeriod: 3, waveDirection: 180, tideLevel: 0,
  precipitation: 0, symbolCode: 'clearsky_day', weatherCode: 0, currentSpeed: 0, currentDirection: 0, isDay: true,
};

describe('migrateLegacySectors', () => {
  it('maps easterly*/westerly* onto sector ids with exact caps and strips the old keys', () => {
    const out = migrateLegacySectors(legacyBlob(), CURRENT_LOCATION) as Record<string, unknown>;
    const limits = out.sectorLimits as Record<string, { safe: number; caution: number }>;
    expect(limits.onshore).toEqual({ safe: 4.5, caution: 7.0 });
    expect(limits.offshore).toEqual({ safe: 5.5, caution: 8.0 });
    for (const k of ['easterlyMin', 'easterlyLimit', 'westerlyMax', 'westerlyCautionLimit']) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it('records a sectorAngles override ONLY when the stored angle diverged from the location default', () => {
    const edited = migrateLegacySectors(legacyBlob({ easterlyMin: 30 }), CURRENT_LOCATION) as Record<string, unknown>;
    expect(edited.sectorAngles).toEqual({ onshore: { min: 30, max: onshore.max } });

    const unedited = migrateLegacySectors(legacyBlob(), CURRENT_LOCATION) as Record<string, unknown>;
    expect(unedited).not.toHaveProperty('sectorAngles'); // pure location geometry
  });

  it('passes a new-shape blob (already has sectorLimits) through untouched', () => {
    const already = { tripMode: 'custom', sectorLimits: { onshore: { safe: 3, caution: 4 } } };
    expect(migrateLegacySectors(already, CURRENT_LOCATION)).toBe(already);
  });
});

describe('healSectorCautions', () => {
  it('lifts an inverted caution cap to safe + 0.5', () => {
    const s = { ...DEFAULT_SETTINGS, sectorLimits: { onshore: { safe: 6, caution: 5 } } } as SafetySettings;
    expect(healSectorCautions(s).sectorLimits.onshore).toEqual({ safe: 6, caution: 6.5 });
  });
});

describe('parseStoredSettings', () => {
  it('the migrated profile produces the SAME verdict the legacy caps would have (zero-verdict-change)', () => {
    const migrated = parseStoredSettings(JSON.stringify(legacyBlob({ maxWindSpeedSafe: 20, maxWindSpeedCaution: 25 })));
    // Direction 90 (easterly/onshore), 5.0 m/s: over the 4.5 safe cap, under 7.0 → caution.
    const atOnshore = analyzeSafetyConditions({ ...baseData, windDirection: 90, windSpeed: 5.0 }, migrated);
    expect(atOnshore.rating).toBe('caution');
    // 7.0 m/s hits the onshore danger cap.
    expect(analyzeSafetyConditions({ ...baseData, windDirection: 90, windSpeed: 7.0 }, migrated).rating).toBe('danger');
  });

  it('heals an inverted general-wind band on load', () => {
    const parsed = parseStoredSettings(JSON.stringify(legacyBlob({ maxWindSpeedSafe: 8, maxWindSpeedCaution: 6 })));
    expect(parsed.maxWindSpeedCaution).toBeGreaterThanOrEqual(parsed.maxWindSpeedSafe + 0.5);
  });
});
